// Company Validation Agent.
//
// Judgment problem it owns: "is this company real, correctly identified, and
// worth spending a paid credit on?"
//
// Runs BEFORE enrichment (ADR-014). Phase 6 measured 40% of discovered companies
// rejected at this gate — every one of those is credits not spent.

import { runAgent } from '../runtime/loop'
import { normalizeDomain } from '@/lib/providers/apollo/normalize'
import {
  archetypeFromSize,
  resolveTitlesForCompany,
  type CompanyArchetype,
} from '@/lib/scouting/titles'
import { validateClaimsAgainstEvidence } from '@/lib/research/types'
import type { ResearchClaim } from '@/lib/research/types'
import type { AgentResult, EvidenceSource, ToolContext } from '../runtime/types'
import { companyValidationPrompt, type CompanyValidationInput } from './prompt'

export type { CompanyValidationInput }

export type CompanyVerdict = 'KEEP' | 'MAYBE' | 'REJECT'

export interface CompanyValidation {
  verdict: CompanyVerdict
  identity_confirmed: boolean
  identity_note: string
  /** The domain research actually established. Guards against name collisions. */
  confirmed_domain: string | null
  what_they_do: string
  products_services: string[]
  industries_served: string[]
  customer_types: string[]
  size_stage_context: string | null
  employee_estimate: number | null
  archetype: CompanyArchetype
  /** Apollo-usable titles, normalized. Never descriptive prose. */
  target_titles: string[]
  target_titles_used_fallback: boolean
  mission_relevant: boolean
  relevance_reasoning: string
  claims: ResearchClaim[]
  uncertainties: string[]
  /** FACTs downgraded because the cited URL was never actually retrieved. */
  downgraded_claims: number
}

const ARCHETYPES: CompanyArchetype[] = [
  'startup', 'growth', 'midmarket', 'enterprise', 'consultancy', 'research', 'other',
]

const OUTPUT_SCHEMA = {
  properties: {
    verdict: {
      type: 'string',
      enum: ['KEEP', 'MAYBE', 'REJECT'],
      description: 'KEEP = clearly relevant. MAYBE = probably relevant, something unresolved. REJECT = wrong company or genuine mismatch.',
    },
    identity_confirmed: {
      type: 'boolean',
      description: 'True only if the company you researched is clearly the one you were given.',
    },
    identity_note: { type: 'string', description: 'What you matched on, or what mismatched.' },
    confirmed_domain: {
      type: ['string', 'null'],
      description: 'The real web domain you established, e.g. "example.com". Null if you could not confirm it.',
    },
    employee_estimate: {
      type: ['number', 'null'],
      description: 'Rough headcount if you found one. Null otherwise — do not guess wildly.',
    },
    archetype: {
      type: 'string',
      enum: ARCHETYPES,
      description: 'What kind of organization this is. Drives which seniority is appropriate.',
    },
    target_titles: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Real job titles to search for INSIDE this company. 2-5 words each. No parentheses, slashes, commas or industry qualifiers. Must plausibly exist at a company of this size and type.',
    },
    what_they_do: { type: 'string', description: 'Plain-English description of the actual business.' },
    products_services: { type: 'array', items: { type: 'string' } },
    industries_served: { type: 'array', items: { type: 'string' } },
    customer_types: { type: 'array', items: { type: 'string' } },
    size_stage_context: {
      type: ['string', 'null'],
      description: 'Rough headcount, revenue, funding stage or ownership, if established.',
    },
    mission_relevant: {
      type: 'boolean',
      description: 'Could this organization plausibly host the work the mission describes? Prefer true when uncertain.',
    },
    relevance_reasoning: { type: 'string' },
    claims: {
      type: 'array',
      description: 'Typed claims. Every FACT must carry the URL of the page that supports it.',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          type: { type: 'string', enum: ['FACT', 'INFERENCE', 'UNKNOWN'] },
          source_url: { type: ['string', 'null'], description: 'Required for FACT. Null otherwise.' },
          source_title: { type: ['string', 'null'] },
          confidence: { type: 'number', description: '0 to 1.' },
          relevance: { type: ['string', 'null'], description: 'Why this claim matters to the mission.' },
        },
        required: ['claim', 'type', 'source_url', 'confidence'],
      },
    },
    uncertainties: {
      type: 'array',
      items: { type: 'string' },
      description: 'What you tried to establish and could not. Leaving this empty is usually wrong.',
    },
  },
  required: [
    'verdict', 'identity_confirmed', 'identity_note', 'confirmed_domain', 'what_they_do',
    'products_services', 'industries_served', 'customer_types', 'size_stage_context',
    'employee_estimate', 'archetype', 'target_titles', 'mission_relevant',
    'relevance_reasoning', 'claims', 'uncertainties',
  ],
}

function strings(v: unknown, limit = 12): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, limit)
}

function validate(raw: unknown, evidence: EvidenceSource[]): CompanyValidation | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>

  const whatTheyDo = String(r.what_they_do ?? '').trim()
  if (!whatTheyDo) return null

  const { claims, downgraded } = validateClaimsAgainstEvidence(
    Array.isArray(r.claims) ? r.claims : [],
    evidence.map((e) => e.url)
  )

  const employeeEstimate =
    typeof r.employee_estimate === 'number' && Number.isFinite(r.employee_estimate) && r.employee_estimate > 0
      ? Math.round(r.employee_estimate)
      : null

  // Trust the stated archetype, but fall back to headcount when it is missing
  // or bogus — the archetype decides which seniority band we search.
  const stated = String(r.archetype ?? '') as CompanyArchetype
  const archetype: CompanyArchetype = ARCHETYPES.includes(stated) ? stated : archetypeFromSize(employeeEstimate)

  // Prose titles return zero rows from Apollo, so normalization is not optional.
  const { titles, usedFallback } = resolveTitlesForCompany(strings(r.target_titles, 16), archetype)

  const verdictRaw = String(r.verdict ?? '').toUpperCase()
  const verdict: CompanyVerdict =
    verdictRaw === 'KEEP' || verdictRaw === 'MAYBE' || verdictRaw === 'REJECT'
      ? (verdictRaw as CompanyVerdict)
      : // No verdict is not a pass. Fall back to the relevance flag, and only to MAYBE.
        r.mission_relevant === true ? 'MAYBE' : 'REJECT'

  return {
    verdict,
    identity_confirmed: r.identity_confirmed === true,
    identity_note: String(r.identity_note ?? '').trim(),
    confirmed_domain: normalizeDomain(typeof r.confirmed_domain === 'string' ? r.confirmed_domain : null),
    what_they_do: whatTheyDo,
    products_services: strings(r.products_services),
    industries_served: strings(r.industries_served),
    customer_types: strings(r.customer_types),
    size_stage_context: typeof r.size_stage_context === 'string' ? r.size_stage_context : null,
    employee_estimate: employeeEstimate,
    archetype,
    target_titles: titles,
    target_titles_used_fallback: usedFallback,
    mission_relevant: r.mission_relevant === true,
    relevance_reasoning: String(r.relevance_reasoning ?? '').trim(),
    claims,
    uncertainties: strings(r.uncertainties),
    downgraded_claims: downgraded,
  }
}

export async function runCompanyValidation(
  input: CompanyValidationInput,
  ctx: ToolContext
): Promise<AgentResult<CompanyValidation>> {
  return runAgent<CompanyValidationInput, CompanyValidation>({
    agentId: 'company_validation',
    modelRole: 'reasoning',
    prompt: companyValidationPrompt,
    input,
    outputSchema: OUTPUT_SCHEMA,
    validate,
    ctx,
    webSearch: true,
    maxWebSearches: 4,
    maxSteps: 6,
    maxTokens: 6000,
    cacheKeyParts: {
      company: input.company.name,
      domain: input.company.domain,
      goal: input.mission.goal,
      segment: input.segment.name,
      // Deterministic POST-PROCESSING version. `validate()` normalizes the
      // model's titles, and a cached AgentResult replays the already-normalized
      // output — so a fix to lib/scouting/titles.ts would silently not apply to
      // any company already in the cache. The prompt version cannot cover this
      // because the prompt did not change. Bump on any change to
      // resolveTitlesForCompany, normalizeTitlePattern, or ARCHETYPE_TITLES.
      titles_logic: 2,
    },
  })
}

/**
 * The gate. A company advances only if it is correctly identified and not
 * rejected — and the reason is recorded either way, so "why isn't X here?"
 * stays answerable.
 *
 * MAYBE passes. Phase 6 measured the opposite error to be the expensive one:
 * a wrongly rejected company is gone from the run entirely, while a borderline
 * one costs a handful of credits and gets caught by person-level research.
 */
export function shouldEnrich(v: CompanyValidation): { pass: boolean; reason: string } {
  if (v.verdict === 'REJECT') return { pass: false, reason: `REJECT — ${v.relevance_reasoning || v.identity_note}` }
  if (!v.identity_confirmed) return { pass: false, reason: `identity not confirmed: ${v.identity_note}` }
  return { pass: true, reason: `${v.verdict} — ${v.relevance_reasoning}` }
}
