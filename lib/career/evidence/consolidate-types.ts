// Consolidation contract — shared by the engine (consolidate.ts), the CLI
// (scripts/evidence-consolidate.ts), the review API and the Evidence UI.
//
// Pure data. The engine computes a ConsolidationPlan from an EvidenceBank in
// memory (no DB); apply steps take a plan and write. A plan is what the dry
// run prints and what the review tab shows, so the two can never disagree.

import type { MergeConfidence, MergeEntityType, MergeStatus } from '@/lib/career/types'

/** One proposed merge: `merge_id` folds into `keep_id`. Never a delete. */
export interface MergeProposal {
  entity_type: MergeEntityType
  keep_id: string
  merge_id: string
  /** HIGH → the engine may apply it; POSSIBLE → user decides; CONFLICT → both kept, review. */
  confidence: MergeConfidence
  /** Matcher rule that fired: 'exact' | 'alias' | 'similar_title' | 'same_org_same_dates' | 'statement_norm' | 'near_duplicate_statement' | ... */
  rule: string
  /** Machine-readable evidence for the decision (similarity scores, normalized keys, date ranges). */
  signals: Record<string, unknown>
  /** Human-readable labels for the report and the UI. */
  keep_label: string
  merge_label: string
  why: string
  data_preserved: string
  risk: string
  /** Field-level disagreements discovered while comparing (title, dates, value). */
  conflicts: ConflictProposal[]
}

export interface ConflictProposal {
  entity_type: 'experience' | 'fact' | 'metric'
  entity_id: string
  field: string
  candidates: { value: string; source_id: string | null; source_label: string }[]
}

export interface OrganizationProposal {
  canonical_name: string
  normalized_name: string
  aliases: string[]
  experience_ids: string[]
  /** Existing evidence_organizations row when one already matches. */
  existing_id: string | null
}

export interface ProvenanceProposal {
  /** Facts that have no evidence_fact_sources row yet: (fact_id → source label + location) to backfill. */
  facts_missing_provenance: { fact_id: string; source: string; source_location: string | null }[]
  experiences_missing_provenance: { experience_id: string; source: string }[]
  /** Distinct source records the backfill would create (label → kind). */
  sources_to_create: { label: string; kind: string; count: number }[]
}

export interface ConsolidationSummary {
  experiences: { active: number; high: number; possible: number; conflict: number }
  facts: { active: number; high: number; possible: number; conflict: number }
  metrics: { active: number; high: number; possible: number; orphaned: number }
  organizations: { proposed: number; existing: number }
  /** Rows the plan would tombstone if every HIGH merge were applied. */
  would_tombstone: number
  /** Facts/metrics that would be re-pointed (never lost) by those merges. */
  would_repoint: number
}

export interface ConsolidationPlan {
  user_id: string
  generated_at: string
  migration015: boolean
  organizations: OrganizationProposal[]
  provenance: ProvenanceProposal
  experiences: MergeProposal[]
  facts: MergeProposal[]
  metrics: MergeProposal[]
  conflicts: ConflictProposal[]
  /** Experiences whose canonical_summary would change (id → new summary). */
  summaries: { experience_id: string; label: string; summary: string; changed: boolean }[]
  /** Suggestions the user already marked kept_separate — excluded from `experiences`/`facts` but listed for the report. */
  suppressed: { entity_type: MergeEntityType; keep_id: string; merge_id: string }[]
  summary: ConsolidationSummary
  warnings: string[]
}

/** What one apply run did. Every id here is also in evidence_snapshots.payload. */
export interface ConsolidationResult {
  snapshot_id: string | null
  organizations_created: number
  sources_created: number
  fact_sources_created: number
  experience_sources_created: number
  merged: { entity_type: MergeEntityType; keep_id: string; merge_id: string; repointed: number }[]
  suggestions_written: number
  conflicts_written: number
  summaries_refreshed: number
  skipped: { entity_type: MergeEntityType; keep_id: string; merge_id: string; reason: string }[]
  errors: string[]
}

export interface ApplyOptions {
  /** Apply only these pairs (the review tab's Merge button); default = every HIGH proposal. */
  only?: { entity_type: MergeEntityType; keep_id: string; merge_id: string }[]
  /** Also apply POSSIBLE pairs listed in `only` (user-confirmed). Never applies CONFLICT. */
  allowPossible?: boolean
  /** Skip the snapshot (tests only). */
  skipSnapshot?: boolean
  reason?: string
}

export type { MergeConfidence, MergeEntityType, MergeStatus }
