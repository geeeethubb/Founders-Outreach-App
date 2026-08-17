// The one shape a scouted prospect has, whatever it came from.
//
// Extracted so the internal-first phase and the external pipeline can produce
// identical objects without importing each other. They must be identical: the
// final list interleaves people who were already in the database with people
// discovered this run, and sorting two different score scales together would
// produce a ranking that means nothing.
//
// Both paths run the SAME Ranking agent over the same five dimensions, so
// `total` is comparable across sources by construction rather than by
// convention.

import type { RankedProspect } from '@/lib/agents/ranking'
import type { PersonCandidate } from '@/lib/providers/types'

/**
 * Where this person came from.
 *
 *   existing               already in the database; retrieved, not discovered
 *   new                    discovered externally this run
 *   existing_rediscovered  external discovery surfaced someone we already had —
 *                          merged into the existing row, never duplicated
 */
export type ProspectSource = 'existing' | 'new' | 'existing_rediscovered'

export interface ScoutedProspect extends RankedProspect {
  person: PersonCandidate
  company: string
  /** Discovery-side company name — the key for candidatePool / enrichedCompanies. */
  companyRef: string
  /** Person-level research as text. What the eval judge is allowed to see. */
  researchSummary: string
  researchVerdict: string | null
  source: ProspectSource
  /** Set whenever the person exists in `contacts`. */
  contactId: string | null
  /** Company research as text, so the brief step does not have to re-derive it. */
  companyContext: string
  /** Present for internal candidates: why retrieval surfaced them. */
  internalReason?: string
  internalEvidence?: string[]
  /** Present when there is prior history: how to open. */
  relationshipStatus?: string
  approach?: string | null
}
