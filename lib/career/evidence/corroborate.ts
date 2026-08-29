// What a second source does for a fact that is already in the bank.
//
// The founder's rules, which this file is the deterministic half of:
//   "if a fact appears in résumé and LinkedIn, one fact with two sources"
//   "corroboration of an event ≠ support for its metric"
//   "the model judges, the code computes"
//
// The importer agent may say a sentence RESTATES an existing fact
// (`corroborates`). Whether that restatement also supports the fact's
// numbers is not the agent's call: a source that repeats the event without
// the "$300K+" corroborates the event, not the metric. So a provenance row
// carries a SUPPORT LEVEL, encoded as its `confidence`, and only full support
// counts towards `support_count` / CORROBORATED (./sources refreshFactSupport,
// ./consolidate-mutations distinctSources). Event-only rows are still
// visible — label and quote — they just never make a number look supported.

import { FACT_HIGH_JACCARD, jaccard, numericTokens, statementTokens } from './consolidate-rules'

export type SupportLevel = 'full' | 'event_only'

/** Provenance confidence at or above this counts as a supporting source. */
export const FULL_SUPPORT_CONFIDENCE = 0.9
export const EVENT_ONLY_CONFIDENCE = 0.5

/**
 * full  — every numeric token of the existing statement appears in the
 *         incoming wording (or the existing statement has none);
 * event_only — the existing statement carries numbers the incoming lacks.
 */
export function supportLevel(existingStatement: string, incomingStatement: string): SupportLevel {
  const need = numericTokens(existingStatement)
  if (need.length === 0) return 'full'
  const have = numericTokens(incomingStatement)
  return need.every((n) => have.includes(n)) ? 'full' : 'event_only'
}

/** True when the incoming wording asserts a number the existing statement does not — a disagreement, never a corroboration. */
export function introducesNumbers(existingStatement: string, incomingStatement: string): boolean {
  const have = numericTokens(existingStatement)
  return numericTokens(incomingStatement).some((n) => !have.includes(n))
}

export function confidenceFor(level: SupportLevel): number {
  return level === 'full' ? 1.0 : EVENT_ONLY_CONFIDENCE
}

export function isFullSupport(row: { confidence?: number | null }): boolean {
  return (row.confidence ?? 1) >= FULL_SUPPORT_CONFIDENCE
}

/**
 * The deterministic second check behind the agent's `corroborates`: two
 * wordings of one claim when their numeric multisets are identical (both
 * empty counts) and their content words overlap at ≥ 0.8 Jaccard. Below that
 * the fact is inserted and the consolidation engine's POSSIBLE band covers it.
 */
export function nearDuplicate(a: string, b: string): { jaccard: number } | null {
  const ta = statementTokens(a)
  const tb = statementTokens(b)
  if (ta.numeric.join('|') !== tb.numeric.join('|')) return null
  const j = jaccard(ta.words, tb.words)
  return j >= FACT_HIGH_JACCARD ? { jaccard: j } : null
}
