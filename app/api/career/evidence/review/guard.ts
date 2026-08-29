// Route-level safety gate over the consolidation plan.
//
// The engine (lib/career/evidence/consolidate*.ts) can class an experience
// pair HIGH when the two rows differ only by an organization qualifier it
// takes for a place ("UIUC (Mironenko)" vs "University of Illinois (Diao)")
// or when one side has no qualifier at all, and it picks the keep row by
// source/age without looking at `edited_by_user`. Both are fine for a human
// clicking Merge on one card; neither is fine for the unattended paths
// (Review tab "Merge all high-confidence", POST /consolidate {dryRun:false}).
//
// This module demotes such pairs to POSSIBLE before any bulk apply and before
// the plan reaches the UI, so what the tab shows and what the button does
// agree. Favouring false negatives over destructive false positives, per the
// founder's rule. Pure: plan + bank in, new plan out.
//
// Both rules now also live in the engine (consolidate-rules.ts compareExperiences
// holds qualifier-vs-no-dates pairs; preferKeep puts an edited row on the keep
// side and consolidate.ts demotes a pair whose merge side was edited), so the
// CLI apply path is covered too. This gate stays as a second, independent check
// in front of the unattended UI paths; on a plan the engine already guarded it
// is a no-op.

import { compareQualifiers, dateOverlapRatio, nowMonthIndex } from '@/lib/career/evidence/consolidate-rules'
import type { ConsolidationPlan, MergeProposal } from '@/lib/career/evidence/consolidate-types'
import type { EvidenceBank, EvidenceExperience } from '@/lib/career/types'

export type GuardReason = 'merge_side_edited_by_user' | 'qualifiers_differ_no_dates'

/**
 * Why a HIGH experience proposal must not be applied unattended, or null when
 * it may. Non-experience proposals are never demoted here: the fact rules
 * already prefer the edited row and only equal normalized statements are HIGH.
 */
export function guardReason(p: MergeProposal, keep: EvidenceExperience | undefined, merge: EvidenceExperience | undefined, now: string): GuardReason | null {
  if (p.entity_type !== 'experience' || p.confidence !== 'HIGH') return null
  if (!keep || !merge) return null
  if (merge.edited_by_user) return 'merge_side_edited_by_user'
  const q = compareQualifiers(keep.organization, merge.organization)
  if (q !== 'same') {
    const overlap = dateOverlapRatio(keep, merge, nowMonthIndex(now))
    if (overlap === null) return 'qualifiers_differ_no_dates'
  }
  return null
}

const WHY: Record<GuardReason, string> = {
  merge_side_edited_by_user: 'the row that would be tombstoned was edited by hand — confirm the merge yourself',
  qualifiers_differ_no_dates: 'the organizations differ by a qualifier and neither row has dates to tell two labs/sites apart — confirm yourself',
}

/**
 * The plan with unsafe HIGH experience pairs demoted to POSSIBLE. Summary
 * counts are recomputed; `signals.downgraded` records why so the card and
 * the audit row explain themselves.
 */
export function guardPlan(plan: ConsolidationPlan, bank: EvidenceBank, now = new Date().toISOString()): ConsolidationPlan {
  const byId = new Map(bank.experiences.map((e) => [e.id, e]))
  let demoted = 0
  const experiences = plan.experiences.map((p): MergeProposal => {
    const reason = guardReason(p, byId.get(p.keep_id), byId.get(p.merge_id), now)
    if (!reason) return p
    demoted++
    return {
      ...p,
      confidence: 'POSSIBLE',
      signals: { ...p.signals, downgraded: reason, guarded_by: 'review_route' },
      why: `${p.why} — held for review: ${WHY[reason]}`,
      risk: `needs a human: ${WHY[reason]}`,
    }
  })
  if (demoted === 0) return plan
  const count = (c: MergeProposal['confidence']) => experiences.filter((p) => p.confidence === c).length
  return {
    ...plan,
    experiences,
    summary: {
      ...plan.summary,
      experiences: { ...plan.summary.experiences, high: count('HIGH'), possible: count('POSSIBLE'), conflict: count('CONFLICT') },
      would_tombstone: Math.max(0, plan.summary.would_tombstone - demoted),
    },
    warnings: [...plan.warnings, `${demoted} HIGH experience pair(s) held for review by the route guard (see signals.downgraded)`],
  }
}
