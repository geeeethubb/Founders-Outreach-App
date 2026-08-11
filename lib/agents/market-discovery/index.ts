// Market Discovery Agent.
//
// Judgment problem it owns: "which real companies exist in this segment, and is
// this search space even productive?"
//
// Research-led discovery. Phase 3 learned that company-first keyword search
// against a contact database matches company NAMES lexically and returns
// magazines, conferences and certification bodies (ADR-013). Reading the market
// first and only then resolving names to database records inverts that.
//
// The agent runs as a BOUNDED SESSION rather than a single call: each round it
// searches, inspects, diagnoses the search space, and picks the next action.
// `runDiscoverySession` below owns the loop and its budget — the agent decides
// what to do next, the code decides how long it is allowed to keep deciding.

import { runAgent } from '../runtime/loop'
import { normalizeDomain } from '@/lib/providers/apollo/normalize'
import type { AgentResult, EvidenceSource, ToolContext } from '../runtime/types'
import {
  marketDiscoveryPrompt,
  type DiscoveryRoundHistory,
  type MarketDiscoveryInput,
} from './prompt'

export type { MarketDiscoveryInput, DiscoveryRoundHistory }

export interface DiscoveredCompany {
  name: string
  domain: string | null
  what_they_do: string
  why_this_segment: string
  source_url: string | null
  /** False when the model cited a URL it never actually retrieved. */
  source_verified: boolean
}

export const DISCOVERY_DIAGNOSES = [
  'HEALTHY',
  'DOMAIN_DRIFT',
  'SEARCH_TERM_AMBIGUITY',
  'LOW_SUPPLY',
  'WRONG_COMPANY_ARCHETYPE',
  'GEOGRAPHIC_OVERCONSTRAINT',
  'TITLE_MISMATCH',
] as const
export type DiscoveryDiagnosis = (typeof DISCOVERY_DIAGNOSES)[number]

export const DISCOVERY_ACTIONS = [
  'ACCEPT',
  'REFINE',
  'NARROW',
  'BROADEN',
  'SYNONYMS',
  'ADJACENT_CATEGORY',
  'FOLLOW_COMPANY',
  'REJECT_HYPOTHESIS',
  'REQUEST_NEW_HYPOTHESIS',
] as const
export type DiscoveryAction = (typeof DISCOVERY_ACTIONS)[number]

/** Actions that end the session rather than triggering another round. */
const TERMINAL_ACTIONS: DiscoveryAction[] = ['ACCEPT', 'REJECT_HYPOTHESIS', 'REQUEST_NEW_HYPOTHESIS']

export interface MarketDiscoveryOutput {
  companies: DiscoveredCompany[]
  diagnosis: DiscoveryDiagnosis
  diagnosis_reasoning: string
  action: DiscoveryAction
  next_query: string | null
  action_reasoning: string
}

const OUTPUT_SCHEMA = {
  properties: {
    companies: {
      type: 'array',
      description: 'Real companies found THIS round. Empty is a valid and honest answer.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: "The company's actual name." },
          domain: {
            type: ['string', 'null'],
            description: 'Primary web domain, e.g. "example.com". Null if you are not confident it belongs to THIS company.',
          },
          what_they_do: {
            type: 'string',
            description: 'One concrete sentence about the real business. No marketing language.',
          },
          why_this_segment: { type: 'string', description: 'Why this company belongs to this segment.' },
          source_url: { type: 'string', description: 'The search result URL where you found this company.' },
        },
        required: ['name', 'domain', 'what_they_do', 'why_this_segment', 'source_url'],
      },
    },
    diagnosis: {
      type: 'string',
      enum: DISCOVERY_DIAGNOSES,
      description: 'What you observed about the search space this round.',
    },
    diagnosis_reasoning: { type: 'string', description: 'The evidence behind that diagnosis.' },
    action: {
      type: 'string',
      enum: DISCOVERY_ACTIONS,
      description: 'What to do next. Killing a dead hypothesis is a good outcome.',
    },
    next_query: {
      type: ['string', 'null'],
      description: 'REQUIRED unless the action is terminal. Must be materially different, not a rephrasing.',
    },
    action_reasoning: { type: 'string', description: 'Why this action follows from the diagnosis.' },
  },
  required: ['companies', 'diagnosis', 'diagnosis_reasoning', 'action', 'next_query', 'action_reasoning'],
}

/** Organization types that are about a market rather than operating in it. */
const NON_OPERATOR =
  /\b(magazine|journal|review|times|weekly|daily|news|media|press|conference|summit|expo|forum|association|institute of|society of|council|federation|certification|accreditation|standards|staffing|recruit|headhunt|talent solutions|job board)\b/i

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

function validate(raw: unknown, evidence: EvidenceSource[]): MarketDiscoveryOutput | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.companies)) return null

  const diagnosis = String(r.diagnosis ?? '') as DiscoveryDiagnosis
  const action = String(r.action ?? '') as DiscoveryAction
  if (!DISCOVERY_DIAGNOSES.includes(diagnosis) || !DISCOVERY_ACTIONS.includes(action)) return null

  const seen = new Set<string>()
  const companies: DiscoveredCompany[] = []

  for (const entry of r.companies) {
    if (!entry || typeof entry !== 'object') continue
    const c = entry as Record<string, unknown>
    const name = String(c.name ?? '').trim()
    if (!name) continue

    // Deterministic exclusion of the failure mode this agent exists to avoid.
    // Doing it in code rather than trusting the prompt is the whole point.
    if (NON_OPERATOR.test(name)) continue

    const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '')
    if (seen.has(key)) continue
    seen.add(key)

    const url = typeof c.source_url === 'string' && /^https?:\/\//i.test(c.source_url) ? c.source_url : null

    companies.push({
      name,
      domain: normalizeDomain(typeof c.domain === 'string' ? c.domain : null),
      what_they_do: String(c.what_they_do ?? '').trim(),
      why_this_segment: String(c.why_this_segment ?? '').trim(),
      source_url: url,
      source_verified: verifiedAgainst(url, evidence),
    })
  }

  const nextQuery = typeof r.next_query === 'string' && r.next_query.trim() ? r.next_query.trim() : null

  return {
    companies,
    diagnosis,
    diagnosis_reasoning: String(r.diagnosis_reasoning ?? '').trim(),
    action,
    next_query: nextQuery,
    action_reasoning: String(r.action_reasoning ?? '').trim(),
  }
}

export async function runMarketDiscoveryRound(
  input: MarketDiscoveryInput,
  ctx: ToolContext
): Promise<AgentResult<MarketDiscoveryOutput>> {
  return runAgent<MarketDiscoveryInput, MarketDiscoveryOutput>({
    agentId: 'market_discovery',
    modelRole: 'reasoning',
    prompt: marketDiscoveryPrompt,
    input,
    outputSchema: OUTPUT_SCHEMA,
    validate,
    ctx,
    webSearch: true,
    maxWebSearches: 4,
    maxSteps: 5,
    maxTokens: 8000,
    cacheKeyParts: {
      segment: input.segment.name,
      archetype: input.segment.intended_archetype,
      goal: input.mission.goal,
      geography: input.mission.geography,
      query: input.currentQuery,
      round: input.history.length + 1,
      already: input.alreadyFound,
      target: input.targetCount,
    },
  })
}

// ─── The session ─────────────────────────────────────────────────────────────

export interface DiscoverySessionParams {
  segment: MarketDiscoveryInput['segment']
  mission: MarketDiscoveryInput['mission']
  alreadyFound: string[]
  targetCount: number
  /** Bounded autonomy: the agent picks the path, this caps how long it may walk. */
  maxRounds: number
  onRound?: (h: DiscoveryRoundHistory) => void
}

export interface DiscoverySessionResult {
  companies: DiscoveredCompany[]
  history: DiscoveryRoundHistory[]
  /** Set when the agent concluded the segment itself was wrong. */
  hypothesisRejected: boolean
  needsNewHypothesis: boolean
  finalDiagnosis: DiscoveryDiagnosis | null
  agentResults: AgentResult<MarketDiscoveryOutput>[]
  errors: string[]
}

/**
 * Run rounds until the agent stops, the target is met, or the budget runs out.
 *
 * The loop is deliberately dumb: it does not second-guess the agent's chosen
 * action. Its only jobs are to enforce the round cap, keep the claimed-name set
 * so rounds cannot re-find the same companies, and stop when a continuing action
 * arrives without a query to continue with.
 */
export async function runDiscoverySession(
  params: DiscoverySessionParams,
  ctx: ToolContext
): Promise<DiscoverySessionResult> {
  const companies: DiscoveredCompany[] = []
  const history: DiscoveryRoundHistory[] = []
  const agentResults: AgentResult<MarketDiscoveryOutput>[] = []
  const errors: string[] = []
  const claimed = new Set(params.alreadyFound.map((n) => n.toLowerCase().replace(/[^a-z0-9]+/g, '')))

  let query = params.segment.search_queries[0] ?? params.segment.name
  let hypothesisRejected = false
  let needsNewHypothesis = false
  let finalDiagnosis: DiscoveryDiagnosis | null = null

  for (let round = 1; round <= params.maxRounds; round++) {
    const remaining = params.targetCount - companies.length
    if (remaining <= 0) break

    const result = await runMarketDiscoveryRound(
      {
        segment: params.segment,
        mission: params.mission,
        alreadyFound: [...params.alreadyFound, ...companies.map((c) => c.name)],
        targetCount: remaining,
        history,
        currentQuery: query,
        roundsRemaining: params.maxRounds - round,
      },
      ctx
    )
    agentResults.push(result)

    if (!result.output) {
      errors.push(`discovery round ${round} (${params.segment.name}): ${result.error}`)
      break
    }

    const out = result.output
    finalDiagnosis = out.diagnosis

    let kept = 0
    for (const c of out.companies) {
      const key = c.name.toLowerCase().replace(/[^a-z0-9]+/g, '')
      if (claimed.has(key)) continue
      claimed.add(key)
      companies.push(c)
      kept++
    }

    const entry: DiscoveryRoundHistory = {
      round,
      query_used: query,
      companies_found: out.companies.length,
      companies_kept: kept,
      diagnosis: out.diagnosis,
      action: out.action,
      note: out.action_reasoning.slice(0, 180),
    }
    history.push(entry)
    params.onRound?.(entry)

    if (out.action === 'REJECT_HYPOTHESIS') {
      hypothesisRejected = true
      break
    }
    if (out.action === 'REQUEST_NEW_HYPOTHESIS') {
      needsNewHypothesis = true
      break
    }
    if (TERMINAL_ACTIONS.includes(out.action)) break

    if (!out.next_query) {
      // A continuing action with nothing to continue on. Stop rather than
      // re-run the identical query, which would burn budget for free.
      errors.push(`discovery (${params.segment.name}): action ${out.action} supplied no next_query`)
      break
    }
    query = out.next_query
  }

  return {
    companies,
    history,
    hypothesisRejected,
    needsNewHypothesis,
    finalDiagnosis,
    agentResults,
    errors,
  }
}
