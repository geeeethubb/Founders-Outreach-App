// Company Validation Agent.
//
// Judgment problem it owns: "is this company real, correctly identified, and
// worth spending a paid credit on?"
//
// Runs BEFORE enrichment (ADR-014). Phase 6 measured 40% of discovered companies
// rejected at this gate — every one of those is credits not spent.

import { runAgent } from '../runtime/loop'
import { validateClaimsAgainstEvidence } from '@/lib/research/types'
import type { ResearchClaim } from '@/lib/research/types'
import type { AgentResult, EvidenceSource, ToolContext } from '../runtime/types'
import { companyValidationPrompt, type CompanyValidationInput } from './prompt'

export type { CompanyValidationInput }

export interface CompanyValidation {
  identity_confirmed: boolean
  identity_note: string
  what_they_do: string
  products_services: string[]
  industries_served: string[]
  customer_types: string[]
  size_stage_context: string | null
  mission_relevant: boolean
  relevance_reasoning: string
  claims: ResearchClaim[]
  uncertainties: string[]
  /** FACTs downgraded because the cited URL was never actually retrieved. */
  downgraded_claims: number
}

const OUTPUT_SCHEMA = {
  properties: {
    identity_confirmed: {
      type: 'boolean',
      description: 'True only if the company you researched is clearly the one you were given.',
    },
    identity_note: { type: 'string', description: 'What you matched on, or what mismatched.' },
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
    'identity_confirmed', 'identity_note', 'what_they_do', 'products_services',
    'industries_served', 'customer_types', 'size_stage_context', 'mission_relevant',
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

  return {
    identity_confirmed: r.identity_confirmed === true,
    identity_note: String(r.identity_note ?? '').trim(),
    what_they_do: whatTheyDo,
    products_services: strings(r.products_services),
    industries_served: strings(r.industries_served),
    customer_types: strings(r.customer_types),
    size_stage_context: typeof r.size_stage_context === 'string' ? r.size_stage_context : null,
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
  })
}

/**
 * The gate. A company advances only if it is both correctly identified and
 * relevant — and the reason is recorded either way, so "why isn't X here?"
 * stays answerable.
 */
export function shouldEnrich(v: CompanyValidation): { pass: boolean; reason: string } {
  if (!v.identity_confirmed) return { pass: false, reason: `identity not confirmed: ${v.identity_note}` }
  if (!v.mission_relevant) return { pass: false, reason: `not mission-relevant: ${v.relevance_reasoning}` }
  return { pass: true, reason: v.relevance_reasoning }
}
