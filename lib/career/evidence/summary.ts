// Canonical experience summaries — deterministic, from the bank's own words.
//
// One line per experience, built from its two strongest approved facts. The
// ordering is fixed (category rank → support → age) so the same bank always
// yields the same sentence, and the text is only ever the facts' own
// statements: nothing is paraphrased, nothing is invented. Truncation cuts at
// a word boundary and says so with an ellipsis.

import type { EvidenceBank, EvidenceFact, FactCategory } from '../types'
import { normalizeStatement } from './normalize'

export const SUMMARY_MAX_CHARS = 240
export const SUMMARY_FACT_COUNT = 2

const CATEGORY_RANK: Record<string, number> = {
  achievement: 0, metric: 1, responsibility: 2, scope: 3, other: 4, context: 5,
}

function rankOf(category: FactCategory): number {
  return CATEGORY_RANK[category] ?? 6
}

/** `**bold**`, `_em_`, list markers, trailing period. */
export function stripMarkdownText(s: string): string {
  return s
    .replace(/\*\*|__/g, '')
    .replace(/(?<!\w)[*_](?=\w)|(?<=\w)[*_](?!\w)/g, '')
    .replace(/^\s*[-•]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.]+$/, '')
}

function isActive(f: EvidenceFact): boolean {
  return (f.status ?? 'active') === 'active'
}

/** The facts a summary is made of, in the order it uses them. */
export function summaryFacts(bank: EvidenceBank, experienceId: string): EvidenceFact[] {
  return bank.facts
    .filter((f) => f.experience_id === experienceId && f.approved && isActive(f))
    .sort((a, b) => {
      const r = rankOf(a.category) - rankOf(b.category)
      if (r !== 0) return r
      const s = (b.support_count ?? 1) - (a.support_count ?? 1)
      if (s !== 0) return s
      if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1
      return a.id < b.id ? -1 : 1
    })
}

export interface CanonicalSummary {
  summary: string
  fact_ids: string[]
}

export function buildCanonicalSummary(bank: EvidenceBank, experienceId: string): CanonicalSummary {
  const ordered = summaryFacts(bank, experienceId)
  const chosen: EvidenceFact[] = []
  const seen = new Set<string>()
  for (const f of ordered) {
    const norm = normalizeStatement(f.statement)
    if (seen.has(norm)) continue
    seen.add(norm)
    chosen.push(f)
    if (chosen.length === SUMMARY_FACT_COUNT) break
  }
  let summary = chosen.map((f) => stripMarkdownText(f.statement)).join('; ')
  if (summary.length > SUMMARY_MAX_CHARS) {
    const cut = summary.slice(0, SUMMARY_MAX_CHARS - 1)
    const at = cut.lastIndexOf(' ')
    summary = `${(at > SUMMARY_MAX_CHARS / 2 ? cut.slice(0, at) : cut).replace(/[,;:\s]+$/, '')}…`
  }
  return { summary, fact_ids: chosen.map((f) => f.id) }
}

export function canonicalSummaryText(bank: EvidenceBank, experienceId: string): string {
  return buildCanonicalSummary(bank, experienceId).summary
}
