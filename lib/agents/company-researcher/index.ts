// Company Researcher Agent.
//
// Judgment problem it owns: "what is genuinely interesting about this company
// for an intern — the problems, the technology, the people — and what is the
// evidence?" Runs once per company; the fit evaluator and the cover letter
// both read the result, which is why a separate letter-researcher was
// rejected (docs/CAREER_OS.md §3).
//
// Grounding is structural: a FACT must cite a URL the loop actually retrieved
// (validateClaimsAgainstEvidence), and a why_interesting point is `grounded`
// only when at least one of the claims it cites survived as a FACT. The letter
// reads `grounded`; nothing else does.

import { runAgent } from '../runtime/loop'
import { normalizeModelText } from '../runtime/text'
import { validateClaimsAgainstEvidence, type ResearchClaim } from '@/lib/research/types'
import { clamp01 } from '@/lib/career/fit/dimensions'
import type { AgentResult, EvidenceSource, ToolContext } from '../runtime/types'
import { companyResearcherPrompt, type CompanyResearcherInput } from './prompt'

export { companyResearcherPrompt }
export type { CompanyResearcherInput }

export type ResearchedCompanyType = 'startup' | 'growth' | 'corporate' | 'industrial' | 'research' | 'consultancy' | 'other'
const COMPANY_TYPES: ResearchedCompanyType[] = ['startup', 'growth', 'corporate', 'industrial', 'research', 'consultancy', 'other']

export interface InterestPoint {
  point: string
  /** Indexes into `claims`, after validation. */
  claim_refs: number[]
  /** True only when at least one cited claim is a FACT. The letter may use only these. */
  grounded: boolean
}

export interface RecentDevelopment {
  description: string
  date_approx: string | null
  claim_ref: number | null
}

export interface Leader {
  name: string
  role: string
  claim_ref: number | null
}

export interface CompanyResearch {
  what_they_do: string
  company_type: ResearchedCompanyType
  industry_tags: string[]
  size_stage: string | null
  why_interesting_for_intern: InterestPoint[]
  technical_challenges: string[]
  recent_developments: RecentDevelopment[]
  intern_program_signals: string[]
  leadership: Leader[]
  claims: ResearchClaim[]
  uncertainties: string[]
  summary: string
  /** FACTs downgraded because the cited URL was never actually retrieved. */
  downgraded_claims: number
  /** Points that cited no surviving FACT. */
  ungrounded_points: number
}

const CLAIM_REF = { type: ['integer', 'null'], description: 'Index into claims, or null.' }

export const OUTPUT_SCHEMA = {
  properties: {
    what_they_do: { type: 'string', description: 'Plain-English description of the actual business.' },
    company_type: { type: 'string', enum: COMPANY_TYPES },
    industry_tags: { type: 'array', items: { type: 'string' }, description: 'At most 6 short tags.' },
    size_stage: { type: ['string', 'null'], description: 'Headcount, revenue, funding stage or ownership, if established.' },
    why_interesting_for_intern: {
      type: 'array',
      description: '3-6 SPECIFIC points, ONE sentence each. Each cites the claim indexes that support it.',
      items: {
        type: 'object',
        properties: {
          point: { type: 'string' },
          claim_refs: { type: 'array', items: { type: 'integer' }, description: 'Indexes into claims.' },
        },
        required: ['point', 'claim_refs'],
      },
    },
    technical_challenges: { type: 'array', items: { type: 'string' } },
    recent_developments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          date_approx: { type: ['string', 'null'], description: 'e.g. "2025-Q3", "March 2026".' },
          claim_ref: CLAIM_REF,
        },
        required: ['description', 'date_approx', 'claim_ref'],
      },
    },
    intern_program_signals: {
      type: 'array',
      items: { type: 'string' },
      description: 'Evidence about how interns are treated. "UNKNOWN — nothing published" is a valid entry.',
    },
    leadership: {
      type: 'array',
      description: 'At most 3.',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, role: { type: 'string' }, claim_ref: CLAIM_REF },
        required: ['name', 'role', 'claim_ref'],
      },
    },
    claims: {
      type: 'array',
      description: 'At most 12 typed claims, ONE sentence each. Every FACT must carry the URL of the page that supports it. Brevity matters: a long answer is cut off.',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          type: { type: 'string', enum: ['FACT', 'INFERENCE', 'UNKNOWN'] },
          source_url: { type: ['string', 'null'], description: 'Required for FACT. Null otherwise.' },
          source_title: { type: ['string', 'null'] },
          confidence: { type: 'number', description: '0 to 1.' },
          relevance: { type: ['string', 'null'], description: 'Why this claim matters for this intern.' },
        },
        required: ['claim', 'type', 'source_url', 'confidence'],
      },
    },
    uncertainties: {
      type: 'array',
      items: { type: 'string' },
      description: 'What you tried to establish and could not. Leaving this empty is usually wrong.',
    },
    summary: { type: 'string', description: 'Four sentences. See system prompt.' },
  },
  required: [
    'what_they_do', 'company_type', 'industry_tags', 'size_stage', 'why_interesting_for_intern',
    'technical_challenges', 'recent_developments', 'intern_program_signals', 'leadership',
    'claims', 'uncertainties', 'summary',
  ],
}

function strings(v: unknown, limit: number): string[] {
  if (!Array.isArray(v)) return []
  return v.map((x) => normalizeModelText(x)).filter(Boolean).slice(0, limit)
}

function claimRef(v: unknown, count: number): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < count ? v : null
}

/**
 * `validateClaims` skips entries with an empty claim text, which would shift
 * every index after it. Validate the same list the model numbered, so refs
 * stay aligned: a blank claim is kept as an UNKNOWN placeholder rather than
 * dropped.
 */
function alignedClaims(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return []
  return raw.map((c) =>
    c && typeof c === 'object' && String((c as Record<string, unknown>).claim ?? '').trim()
      ? c
      : { claim: '(empty)', type: 'UNKNOWN', source_url: null, confidence: 0 }
  )
}

export function validateCompanyResearch(raw: unknown, evidence: EvidenceSource[]): CompanyResearch | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>

  const whatTheyDo = normalizeModelText(r.what_they_do)
  const summary = normalizeModelText(r.summary)
  if (!whatTheyDo || !summary) return null

  const { claims, downgraded } = validateClaimsAgainstEvidence(alignedClaims(r.claims), evidence.map((e) => e.url))
  const isFact = (i: number) => claims[i]?.type === 'FACT'

  const points: InterestPoint[] = []
  let ungrounded = 0
  if (Array.isArray(r.why_interesting_for_intern)) {
    for (const entry of r.why_interesting_for_intern.slice(0, 6)) {
      if (!entry || typeof entry !== 'object') continue
      const p = entry as Record<string, unknown>
      const point = normalizeModelText(p.point)
      if (!point) continue
      const refs = Array.isArray(p.claim_refs)
        ? p.claim_refs.map((x) => claimRef(x, claims.length)).filter((x): x is number => x !== null)
        : []
      const grounded = refs.some(isFact)
      if (!grounded) ungrounded++
      points.push({ point, claim_refs: Array.from(new Set(refs)), grounded })
    }
  }
  if (points.length === 0) return null

  const stated = String(r.company_type ?? '').toLowerCase() as ResearchedCompanyType
  const companyType = COMPANY_TYPES.includes(stated) ? stated : 'other'

  const developments: RecentDevelopment[] = []
  if (Array.isArray(r.recent_developments)) {
    for (const entry of r.recent_developments.slice(0, 6)) {
      if (!entry || typeof entry !== 'object') continue
      const d = entry as Record<string, unknown>
      const description = normalizeModelText(d.description)
      if (!description) continue
      developments.push({
        description,
        date_approx: typeof d.date_approx === 'string' ? normalizeModelText(d.date_approx) || null : null,
        claim_ref: claimRef(d.claim_ref, claims.length),
      })
    }
  }

  const leadership: Leader[] = []
  if (Array.isArray(r.leadership)) {
    for (const entry of r.leadership.slice(0, 3)) {
      if (!entry || typeof entry !== 'object') continue
      const l = entry as Record<string, unknown>
      const name = normalizeModelText(l.name)
      if (!name) continue
      leadership.push({ name, role: normalizeModelText(l.role), claim_ref: claimRef(l.claim_ref, claims.length) })
    }
  }

  return {
    what_they_do: whatTheyDo,
    company_type: companyType,
    industry_tags: strings(r.industry_tags, 6),
    size_stage: typeof r.size_stage === 'string' ? normalizeModelText(r.size_stage) || null : null,
    why_interesting_for_intern: points,
    technical_challenges: strings(r.technical_challenges, 8),
    recent_developments: developments,
    intern_program_signals: strings(r.intern_program_signals, 6),
    leadership,
    claims: claims.map((c) => ({ ...c, confidence: clamp01(c.confidence) })),
    uncertainties: strings(r.uncertainties, 8),
    summary,
    downgraded_claims: downgraded,
    ungrounded_points: ungrounded,
  }
}

/** Research goes stale; a month is the horizon after which "recent developments" is not. */
export function researchMonthBucket(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

export async function runCompanyResearcher(
  input: CompanyResearcherInput,
  ctx: ToolContext,
  opts: { onStep?: (info: { step: number; elapsedMs: number; stopReason: string | null; toolCalls: string[] }) => void; now?: Date } = {}
): Promise<AgentResult<CompanyResearch>> {
  return runAgent<CompanyResearcherInput, CompanyResearch>({
    agentId: 'company_researcher',
    tier: 'standard',
    modelRole: 'reasoning',
    prompt: companyResearcherPrompt,
    input,
    outputSchema: OUTPUT_SCHEMA,
    validate: validateCompanyResearch,
    ctx,
    webSearch: true,
    maxWebSearches: 5,
    maxSteps: 7,
    maxTokens: 7000,
    // Per company, per month — NOT per job title or mission. The same company
    // reached from three postings is researched once.
    cacheKeyParts: {
      company: input.company.name,
      domain: input.company.domain,
      month: researchMonthBucket(opts.now),
      depth: input.depth,
    },
    onStep: opts.onStep,
  })
}
