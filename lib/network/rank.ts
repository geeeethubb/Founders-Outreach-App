// Deterministic ranking of internal candidates.
//
// ADR-004 in practice: the retrieval agent emits three component judgments; the
// weighted sum, the relationship adjustment and the ordering are arithmetic
// here. Re-weighting re-ranks with no model call.
//
// The scores produced here are MISSION-SPECIFIC and are written to
// network_matches, never back onto the contact. A person who scores 0.3 for
// "winter industrial AI" and 0.85 for "summer consulting" is not inconsistent —
// they are two different questions, and collapsing them into one stored
// "quality" number is the mistake this table exists to prevent.

import type { RetrievedCandidate } from '@/lib/agents/network-retrieval'
import type { NetworkCandidate } from './search'
import { emptyHistory, type RelationshipHistory } from './relationship'

export interface NetworkWeights {
  mission_fit: number
  decision_access: number
  user_differentiation: number
}

/**
 * Mission fit dominates, because the most expensive error here is a warm,
 * senior, delightful contact who has nothing to do with the mission.
 */
export const DEFAULT_NETWORK_WEIGHTS: NetworkWeights = {
  mission_fit: 0.5,
  decision_access: 0.3,
  user_differentiation: 0.2,
}

export interface RankedInternalCandidate {
  contact: NetworkCandidate
  /** 0-1, this mission only. */
  total: number
  /** Before the relationship adjustment — kept so the adjustment is auditable. */
  base: number
  relationshipModifier: number
  components: RetrievedCandidate['components']
  confidence: number
  reason: string
  evidence: string[]
  approach: string | null
  relationship: RelationshipHistory
  rank: number
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}

export function rankInternalCandidates(
  shortlist: RetrievedCandidate[],
  seen: Map<string, NetworkCandidate>,
  history: Map<string, RelationshipHistory>,
  weights: NetworkWeights = DEFAULT_NETWORK_WEIGHTS
): RankedInternalCandidate[] {
  const total = weights.mission_fit + weights.decision_access + weights.user_differentiation
  const w = total > 0 ? weights : DEFAULT_NETWORK_WEIGHTS
  const denom = w.mission_fit + w.decision_access + w.user_differentiation

  const ranked = shortlist
    .map((c) => {
      const contact = seen.get(c.contact_id)
      if (!contact) return null
      const rel = history.get(c.contact_id) ?? emptyHistory()
      const base =
        (c.components.mission_fit * w.mission_fit +
          c.components.decision_access * w.decision_access +
          c.components.user_differentiation * w.user_differentiation) /
        denom
      return {
        contact,
        base,
        relationshipModifier: rel.scoreModifier,
        total: clamp01(base + rel.scoreModifier),
        components: c.components,
        confidence: c.confidence,
        reason: c.reason,
        evidence: c.evidence,
        // The agent's approach note wins when it wrote one; otherwise the
        // deterministic relationship note stands in, so a warm contact never
        // reaches a draft looking cold.
        approach: c.approach ?? (rel.status === 'never_contacted' ? null : rel.note),
        relationship: rel,
        rank: 0,
      }
    })
    .filter((r): r is Omit<RankedInternalCandidate, 'rank'> & { rank: number } => r !== null)
    .sort((a, b) => b.total - a.total)

  ranked.forEach((r, i) => {
    r.rank = i + 1
  })
  return ranked
}

/** One person per company, matching the product rule the scout already enforces. */
export function declumpByCompany<T extends { contact: NetworkCandidate }>(ranked: T[]): T[] {
  const seen = new Set<string>()
  const first: T[] = []
  const rest: T[] = []
  for (const r of ranked) {
    const key = (r.contact.company ?? 'unknown').toLowerCase().trim()
    if (seen.has(key)) rest.push(r)
    else {
      seen.add(key)
      first.push(r)
    }
  }
  return [...first, ...rest]
}
