// Market Discovery Agent.
//
// Judgment problem it owns: "which real companies exist in this segment?"
//
// This is research-led discovery. Phase 3 learned that company-first keyword
// search against a contact database matches company NAMES lexically and returns
// magazines, conferences and certification bodies (ADR-013). Reading the market
// first and only then resolving names to database records inverts that.

import { runAgent } from '../runtime/loop'
import { normalizeDomain } from '@/lib/providers/apollo/normalize'
import type { AgentResult, EvidenceSource, ToolContext } from '../runtime/types'
import { marketDiscoveryPrompt, type MarketDiscoveryInput } from './prompt'

export type { MarketDiscoveryInput }

export interface DiscoveredCompany {
  name: string
  domain: string | null
  what_they_do: string
  why_this_segment: string
  source_url: string | null
  /** False when the model cited a URL it never actually retrieved. */
  source_verified: boolean
}

export interface MarketDiscoveryOutput {
  companies: DiscoveredCompany[]
  segment_notes: string
  /** Set when the segment genuinely has thin supply — a finding, not a failure. */
  thin_supply: boolean
}

const OUTPUT_SCHEMA = {
  properties: {
    companies: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The company\'s actual name.' },
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
    segment_notes: {
      type: 'string',
      description: 'What you learned about this segment while searching, including what was hard to find.',
    },
    thin_supply: {
      type: 'boolean',
      description: 'True if this segment genuinely does not contain many good companies. Say so rather than padding.',
    },
  },
  required: ['companies', 'segment_notes', 'thin_supply'],
}

/** Organization types that are about a market rather than operating in it. */
const NON_OPERATOR = /\b(magazine|journal|review|times|weekly|daily|news|media|press|conference|summit|expo|forum|association|institute of|society of|council|federation|certification|accreditation|standards|staffing|recruit|headhunt|talent solutions|job board)\b/i

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

  return {
    companies,
    segment_notes: String(r.segment_notes ?? '').trim(),
    thin_supply: r.thin_supply === true,
  }
}

export async function runMarketDiscovery(
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
    maxWebSearches: Math.max(2, Math.min(6, input.targetCount)),
    maxSteps: 6,
    maxTokens: 8000,
  })
}
