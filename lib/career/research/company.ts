// Company research, rendered for its readers.
//
// Three consumers, three shapes:
//   the Fit Evaluator reads a compact prompt block (summary + a few FACT lines)
//   research_facts gets one row per claim, through persistResearchFacts
//   the Cover Letter Writer gets only the GROUNDED points, each with a stable
//   id it can cite — so a letter claim resolves to a point, which resolves to
//   FACT claims, which resolve to URLs (ADR-006, all the way down).

import type { CompanyResearch } from '@/lib/agents/company-researcher'
import type { ResearchClaim } from '@/lib/research/types'

/** Summary plus up to `maxClaims` typed claim lines. Kept tight — prompt budget. */
export function renderCompanyResearchForPrompt(
  research: CompanyResearch | null,
  opts: { maxClaims?: number } = {}
): string {
  if (!research) return '(no research yet)'
  const max = opts.maxClaims ?? 12
  const lines: string[] = [research.summary]
  lines.push(`TYPE: ${research.company_type}${research.size_stage ? ` · ${research.size_stage}` : ''}${research.industry_tags.length ? ` · ${research.industry_tags.join(', ')}` : ''}`)

  if (research.technical_challenges.length) {
    lines.push(`TECHNICAL CHALLENGES: ${research.technical_challenges.slice(0, 4).join('; ')}`)
  }
  if (research.intern_program_signals.length) {
    lines.push(`INTERN PROGRAM: ${research.intern_program_signals.slice(0, 3).join('; ')}`)
  }

  // FACTs first — they are what the evaluator may lean on — then inferences
  // to fill the budget. UNKNOWNs are surfaced as uncertainties instead.
  const facts = research.claims.filter((c) => c.type === 'FACT')
  const inferences = research.claims.filter((c) => c.type === 'INFERENCE')
  const chosen = [...facts, ...inferences].slice(0, max)
  if (chosen.length) {
    lines.push('CLAIMS:')
    for (const c of chosen) lines.push(`  ${c.type}: ${c.claim}`)
  }
  if (research.uncertainties.length) lines.push(`UNKNOWNS: ${research.uncertainties.slice(0, 3).join('; ')}`)
  return lines.join('\n')
}

/**
 * The claims, ready for persistResearchFacts({ ..., subjectLabel, claims }).
 * Placeholder UNKNOWNs inserted to keep indexes aligned are dropped here —
 * they were never claims.
 */
export function researchClaimsToFactRows(research: CompanyResearch): ResearchClaim[] {
  return research.claims
    .filter((c) => c.claim !== '(empty)')
    .map((c) => ({
      claim: c.claim,
      type: c.type,
      source_url: c.type === 'FACT' ? c.source_url : c.source_url ?? null,
      source_title: c.source_title ?? null,
      confidence: c.confidence,
      relevance: c.relevance ?? null,
    }))
}

export interface GroundedPoint {
  /** Stable within one research result: 'point:<index in why_interesting_for_intern>'. */
  id: string
  text: string
  /** Indexes into research.claims, FACT-typed only. */
  factClaimIndexes: number[]
  /** The URLs those facts cite, for a letter's claim map. */
  sourceUrls: string[]
}

/** Only the points the letter may use: each rests on at least one FACT with a retrieved URL. */
export function groundedPoints(research: CompanyResearch): GroundedPoint[] {
  const out: GroundedPoint[] = []
  research.why_interesting_for_intern.forEach((p, i) => {
    if (!p.grounded) return
    const factIdx = p.claim_refs.filter((r) => research.claims[r]?.type === 'FACT')
    if (!factIdx.length) return
    const urls = Array.from(new Set(factIdx.map((r) => research.claims[r].source_url).filter((u): u is string => Boolean(u))))
    out.push({ id: `point:${i}`, text: p.point, factClaimIndexes: factIdx, sourceUrls: urls })
  })
  return out
}
