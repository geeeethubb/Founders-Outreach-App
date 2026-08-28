// Job Mission Planner Agent.
//
// Judgment problem it owns: "what roles could this person plausibly do, where
// would they be posted, and which companies are worth watching before they
// post?" (docs/CAREER_OS.md §3). Role families are INFERRED from the Evidence
// Bank, not read from a taxonomy — the mission's role_families are a seed at
// most, and the default mission leaves them empty on purpose.
//
// It runs once per mission and its output drives both discovery paths: the
// scout sessions (one per strategy) and the deterministic company-first check
// (one per seed company). Nothing here touches the database.

import crypto from 'crypto'
import { runAgent } from '../runtime/loop'
import { normalizeModelText } from '../runtime/text'
import { normalizeDomain } from '@/lib/providers/apollo/normalize'
import type { AgentResult, EvidenceSource, ToolContext } from '../runtime/types'
import { jobMissionPlannerPrompt, type JobMissionPlannerInput } from './prompt'

export { jobMissionPlannerPrompt }
export type { JobMissionPlannerInput }

export interface RoleFamily {
  name: string
  rationale: string
  example_titles: string[]
  confidence: number
}

export type StrategyKind = 'job_first' | 'company_first'

export interface SearchStrategy {
  name: string
  kind: StrategyKind
  rationale: string
  /** Web queries that surface actual postings or careers pages. */
  queries: string[]
  target_titles: string[]
  geo_focus: string[]
  priority: number
}

export interface SeedCompany {
  name: string
  domain: string | null
  why: string
  company_type: string
  priority: number
  source_url: string | null
  /** False when the model cited a URL it never actually retrieved, or none at all. */
  source_verified: boolean
}

export interface JobMissionPlan {
  role_families: RoleFamily[]
  strategies: SearchStrategy[]
  seed_companies: SeedCompany[]
  adjacent_categories: string[]
  exclusions: string[]
  reasoning: string
  /** Seed companies dropped because they were not operators (staffing, job boards, media). */
  dropped_non_operators: number
}

const STRATEGY_KINDS: StrategyKind[] = ['job_first', 'company_first']

export const OUTPUT_SCHEMA = {
  properties: {
    role_families: {
      type: 'array',
      description: '4-8 role families INFERRED from the evidence. Each names real titles as they appear on postings.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'e.g. "Process Engineering", "Industrial AI / Applied ML", "Technical Program Management".' },
          rationale: { type: 'string', description: 'One or two sentences pointing at the evidence that supports this family.' },
          example_titles: { type: 'array', items: { type: 'string' }, description: '3-6 titles as they appear on real postings.' },
          confidence: { type: 'number', description: '0-1. How well the evidence supports this family.' },
        },
        required: ['name', 'rationale', 'example_titles', 'confidence'],
      },
    },
    strategies: {
      type: 'array',
      description: '4-8 DISTINCT search strategies. Each has 2-6 concrete queries.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          kind: { type: 'string', enum: STRATEGY_KINDS },
          rationale: { type: 'string' },
          queries: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Web search queries that surface ACTUAL postings or careers pages. Use site: scoping for ATS hosts and season phrasing such as "Summer 2027 internship".',
          },
          target_titles: { type: 'array', items: { type: 'string' } },
          geo_focus: { type: 'array', items: { type: 'string' }, description: 'Cities or regions this strategy targets. Empty means anywhere in the mission geography.' },
          priority: { type: 'number', description: '0-1.' },
        },
        required: ['name', 'kind', 'rationale', 'queries', 'target_titles', 'geo_focus', 'priority'],
      },
    },
    seed_companies: {
      type: 'array',
      description: '15-40 REAL companies worth watching. Never invent a name or a domain.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          domain: { type: ['string', 'null'], description: 'Primary web domain if you are confident. Null otherwise.' },
          why: { type: 'string', description: 'One line. Why THIS company for THIS person.' },
          company_type: { type: 'string', description: 'The mission company type or adjacent category it belongs to.' },
          priority: { type: 'number', description: '0-1.' },
          source_url: { type: ['string', 'null'], description: 'The search result URL where you saw this company. Null if from memory.' },
        },
        required: ['name', 'domain', 'why', 'company_type', 'priority', 'source_url'],
      },
    },
    adjacent_categories: {
      type: 'array',
      items: { type: 'string' },
      description: 'Categories you inferred beyond the literal company types, e.g. "grid-scale batteries", "semiconductor equipment".',
    },
    exclusions: {
      type: 'array',
      items: { type: 'string' },
      description: 'What a naive search returns that is WRONG for this mission.',
    },
    reasoning: { type: 'string', description: 'A short paragraph explaining the plan.' },
  },
  required: ['role_families', 'strategies', 'seed_companies', 'adjacent_categories', 'exclusions', 'reasoning'],
}

/**
 * Organization types that are about a job market rather than employers in it.
 * Same idea as market-discovery's NON_OPERATOR, tuned for the failure mode
 * here: a planner asked for "companies hiring interns" will happily return
 * Handshake, WayUp and three staffing firms.
 */
const NON_OPERATOR =
  /\b(magazine|journal|news|media|press|conference|summit|expo|association|institute of|society of|council|federation|certification|staffing|recruit\w*|headhunt\w*|talent solutions|job board|handshake|wayup|ripplematch|indeed|glassdoor|linkedin|ziprecruiter|levels\.fyi|builtin)\b/i

function clamp01(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0
  return Math.min(1, Math.max(0, v))
}

function strings(v: unknown, limit = 12): string[] {
  if (!Array.isArray(v)) return []
  return v.map((x) => normalizeModelText(x)).filter((s) => s.length > 0).slice(0, limit)
}

function nameKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function httpUrl(v: unknown): string | null {
  return typeof v === 'string' && /^https?:\/\//i.test(v.trim()) ? v.trim() : null
}

function verifiedAgainst(url: string | null, evidence: EvidenceSource[]): boolean {
  if (!url) return false
  const allowed = new Set<string>()
  for (const e of evidence) {
    allowed.add(e.url)
    try {
      allowed.add(new URL(e.url).origin)
    } catch {
      /* ignore */
    }
  }
  if (allowed.has(url)) return true
  try {
    return allowed.has(new URL(url).origin)
  } catch {
    return false
  }
}

/** Rejects (null) rather than repairs. Exported so the offline test can drive it. */
export function validate(raw: unknown, evidence: EvidenceSource[]): JobMissionPlan | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.role_families) || !Array.isArray(r.strategies) || !Array.isArray(r.seed_companies)) return null

  const roleFamilies: RoleFamily[] = []
  for (const entry of r.role_families) {
    if (!entry || typeof entry !== 'object') continue
    const f = entry as Record<string, unknown>
    const name = normalizeModelText(f.name)
    if (!name) continue
    roleFamilies.push({
      name,
      rationale: normalizeModelText(f.rationale),
      example_titles: strings(f.example_titles, 8),
      confidence: clamp01(f.confidence),
    })
  }
  if (roleFamilies.length < 3) return null

  const strategies: SearchStrategy[] = []
  const strategyNames = new Set<string>()
  for (const entry of r.strategies) {
    if (!entry || typeof entry !== 'object') continue
    const s = entry as Record<string, unknown>
    const name = normalizeModelText(s.name)
    const kind = String(s.kind ?? '') as StrategyKind
    const queries = strings(s.queries, 8)
    // A strategy with fewer than two queries gives the scout nothing to fall
    // back to when the first query is dead, which is most first queries.
    if (!name || !STRATEGY_KINDS.includes(kind) || queries.length < 2) continue
    const key = nameKey(name)
    if (strategyNames.has(key)) continue
    strategyNames.add(key)
    strategies.push({
      name,
      kind,
      rationale: normalizeModelText(s.rationale),
      queries,
      target_titles: strings(s.target_titles, 12),
      geo_focus: strings(s.geo_focus, 8),
      priority: clamp01(s.priority),
    })
  }
  if (strategies.length < 3) return null

  const seeds: SeedCompany[] = []
  const seen = new Set<string>()
  let droppedNonOperators = 0
  for (const entry of r.seed_companies) {
    if (!entry || typeof entry !== 'object') continue
    const c = entry as Record<string, unknown>
    const name = normalizeModelText(c.name)
    if (!name) continue
    // Deterministic exclusion of the failure mode the prompt warns about.
    // Doing it in code rather than trusting the prompt is the point.
    if (NON_OPERATOR.test(name)) {
      droppedNonOperators++
      continue
    }
    const key = nameKey(name)
    if (seen.has(key)) continue
    seen.add(key)
    const url = httpUrl(c.source_url)
    seeds.push({
      name,
      domain: normalizeDomain(typeof c.domain === 'string' ? c.domain : null),
      why: normalizeModelText(c.why),
      company_type: normalizeModelText(c.company_type),
      priority: clamp01(c.priority),
      source_url: url,
      source_verified: verifiedAgainst(url, evidence),
    })
  }

  const reasoning = normalizeModelText(r.reasoning)
  if (!reasoning) return null

  return {
    role_families: roleFamilies.slice(0, 10),
    strategies: strategies.slice(0, 10),
    seed_companies: seeds.slice(0, 60),
    adjacent_categories: strings(r.adjacent_categories, 16),
    exclusions: strings(r.exclusions, 16),
    reasoning,
    dropped_non_operators: droppedNonOperators,
  }
}

function sha(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 24)
}

export async function runJobMissionPlanner(
  input: JobMissionPlannerInput,
  ctx: ToolContext,
  opts: { onStep?: (info: { step: number; elapsedMs: number; stopReason: string | null; toolCalls: string[] }) => void } = {}
): Promise<AgentResult<JobMissionPlan>> {
  return runAgent<JobMissionPlannerInput, JobMissionPlan>({
    agentId: 'job_mission_planner',
    // Standard, not cheap: this one call shapes every downstream search, and a
    // thin role taxonomy here is a thin job list everywhere.
    tier: 'standard',
    modelRole: 'reasoning',
    prompt: jobMissionPlannerPrompt,
    input,
    outputSchema: OUTPUT_SCHEMA,
    validate,
    ctx,
    webSearch: true,
    maxWebSearches: 3,
    maxSteps: 6,
    maxTokens: 8000,
    onStep: opts.onStep,
    // Hashed rather than inlined: the evidence summary is several KB of
    // personal data, and the key only needs identity, not content.
    cacheKeyParts: {
      mission: sha(input.mission),
      evidence: sha(input.evidenceSummaries + '\n' + input.skills),
      preferences: sha(input.preferences),
      watchlist: sha([...input.watchlist].sort().join('|')),
      feedback: sha([...input.recentFeedback].sort().join('|')),
    },
  })
}
