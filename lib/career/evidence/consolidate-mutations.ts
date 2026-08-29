// planMutations — exactly what applying a set of proposals would write.
//
// Pure. A Mutation is one insert or update; there is no delete op in the
// type, so "a merge never deletes" is enforced by construction, and the
// no-data-loss tests read the list to assert every child of a merged row is
// re-pointed at the survivor before the survivor's tombstone is written.

import type { EvidenceBank, EvidenceExperience, EvidenceFact, EvidenceMetric } from '../types'
import type { MergeProposal } from './consolidate-types'
import { EVENT_ONLY_CONFIDENCE, isFullSupport } from './corroborate'
import { splitSourceLocation } from './sources'

export type MutationKind = 'repoint' | 'fill' | 'tombstone' | 'conflict' | 'suggestion' | 'link'

export interface Mutation {
  table:
    | 'evidence_experiences' | 'evidence_facts' | 'evidence_metrics' | 'evidence_deliverables'
    | 'evidence_skills' | 'evidence_stories' | 'evidence_projects' | 'resume_bullets'
    | 'evidence_experience_sources' | 'evidence_fact_sources' | 'evidence_conflicts' | 'evidence_merge_suggestions'
  op: 'insert' | 'update'
  kind: MutationKind
  id?: string
  values: Record<string, unknown>
  /** For re-points: the row's id whose parent moved (tests assert coverage). */
  child_id?: string
}

export interface PlanSlice {
  experiences: MergeProposal[]
  facts: MergeProposal[]
  metrics: MergeProposal[]
}

export type Selection = { entity_type: string; keep_id: string; merge_id: string }[]

const activeRows = <T extends { status?: string }>(rows: T[]): T[] => rows.filter((r) => (r.status ?? 'active') === 'active')

function suggestionRow(userId: string, p: MergeProposal, status: 'merged'): Record<string, unknown> {
  return {
    user_id: userId, entity_type: p.entity_type, keep_id: p.keep_id, merge_id: p.merge_id,
    confidence: p.confidence, rule: p.rule, signals: p.signals, why: p.why,
    data_preserved: p.data_preserved, risk: p.risk, status,
  }
}

function replaceId(ids: string[], from: string, to: string): string[] {
  return [...new Set(ids.map((id) => (id === from ? to : id)))]
}

// ─── Experience merge ────────────────────────────────────────────────────────

function experienceMerge(bank: EvidenceBank, p: MergeProposal, out: Mutation[]): void {
  const keep = bank.experiences.find((e) => e.id === p.keep_id)
  const merge = bank.experiences.find((e) => e.id === p.merge_id)
  if (!keep || !merge) return
  const userId = keep.user_id
  const repoint = (table: Mutation['table'], rows: { id: string; experience_id?: string | null }[]) => {
    for (const r of rows) if (r.experience_id === merge.id) out.push({ table, op: 'update', kind: 'repoint', id: r.id, child_id: r.id, values: { experience_id: keep.id } })
  }
  repoint('evidence_facts', bank.facts)
  repoint('evidence_metrics', bank.metrics)
  repoint('evidence_deliverables', bank.deliverables)
  repoint('evidence_stories', bank.stories)
  repoint('evidence_projects', bank.projects)
  repoint('resume_bullets', bank.bullets)
  repoint('evidence_experience_sources', bank.experienceSources ?? [])

  const fill: Record<string, unknown> = {}
  for (const field of ['start_date', 'end_date', 'location', 'description'] as const) {
    if ((keep[field] ?? null) === null && (merge[field] ?? null) !== null) fill[field] = merge[field]
  }
  fill.source_count = (keep.source_count ?? 1) + (merge.source_count ?? 1)
  fill.merge_status = p.conflicts.length ? 'CONFLICTING' : 'CORROBORATED'
  out.push({ table: 'evidence_experiences', op: 'update', kind: 'fill', id: keep.id, values: fill })

  for (const c of p.conflicts) {
    out.push({ table: 'evidence_conflicts', op: 'insert', kind: 'conflict', values: { user_id: userId, entity_type: c.entity_type, entity_id: c.entity_id, field: c.field, candidates: c.candidates, status: 'open' } })
  }
  out.push({ table: 'evidence_experiences', op: 'update', kind: 'tombstone', id: merge.id, values: { status: 'merged', merged_into: keep.id } })
  out.push({ table: 'evidence_merge_suggestions', op: 'insert', kind: 'suggestion', values: suggestionRow(userId, p, 'merged') })
}

// ─── Fact merge ──────────────────────────────────────────────────────────────

/**
 * Distinct sources that FULLY support these facts: provenance rows at
 * confidence ≥ 0.9 (an event-only row never counts), or the legacy source
 * column when a fact has no provenance rows yet.
 */
function distinctSources(bank: EvidenceBank, facts: EvidenceFact[]): number {
  const labels = new Set<string>()
  for (const f of facts) {
    const rows = bank.factSources.filter((fs) => fs.fact_id === f.id)
    if (rows.length) rows.filter(isFullSupport).forEach((r) => labels.add(`src:${r.source_id}`))
    else labels.add(`legacy:${splitSourceLocation(f.source, f.source_location).label}`)
  }
  return labels.size
}

function factMerge(bank: EvidenceBank, p: MergeProposal, out: Mutation[]): void {
  const keep = bank.facts.find((f) => f.id === p.keep_id)
  const merge = bank.facts.find((f) => f.id === p.merge_id)
  if (!keep || !merge) return
  const userId = keep.user_id
  // A weaker_restatement merge folds a number-less wording into the numbered
  // fact: its sources corroborate the event only, so their rows are
  // re-pointed at 0.5 and do not raise support_count.
  const eventOnly = p.rule === 'weaker_restatement' || p.signals.support === 'event_only'
  const repointArray = (table: Mutation['table'], rows: { id: string }[], field: string, get: (r: never) => string[]) => {
    for (const r of rows) {
      const ids = get(r as never)
      if (!ids.includes(merge.id)) continue
      out.push({ table, op: 'update', kind: 'repoint', id: r.id, child_id: r.id, values: { [field]: replaceId(ids, merge.id, keep.id) } })
    }
  }
  repointArray('evidence_metrics', bank.metrics, 'fact_ids', (r: EvidenceMetric) => r.fact_ids)
  repointArray('evidence_deliverables', bank.deliverables, 'fact_ids', (r: { fact_ids: string[] }) => r.fact_ids)
  repointArray('evidence_skills', bank.skills, 'evidence_fact_ids', (r: { evidence_fact_ids: string[] }) => r.evidence_fact_ids)
  repointArray('evidence_stories', bank.stories, 'evidence_fact_ids', (r: { evidence_fact_ids: string[] }) => r.evidence_fact_ids)
  repointArray('resume_bullets', bank.bullets, 'evidence_fact_ids', (r: { evidence_fact_ids: string[] }) => r.evidence_fact_ids)
  repointArray('evidence_projects', bank.projects, 'fact_ids', (r: { fact_ids: string[] }) => r.fact_ids)
  for (const fs of bank.factSources) {
    if (fs.fact_id !== merge.id) continue
    const values: Record<string, unknown> = { fact_id: keep.id, quote: fs.quote ?? merge.statement }
    if (eventOnly && isFullSupport(fs)) values.confidence = EVENT_ONLY_CONFIDENCE
    out.push({ table: 'evidence_fact_sources', op: 'update', kind: 'repoint', id: fs.id, child_id: fs.id, values })
  }

  const supportCount = distinctSources(bank, eventOnly ? [keep] : [keep, merge])
  const fill: Record<string, unknown> = {
    support_count: supportCount,
    fact_status: p.conflicts.length ? 'CONFLICTING' : supportCount >= 2 ? 'CORROBORATED' : keep.fact_status ?? 'VERIFIED',
  }
  const safest = typeof p.signals.safest === 'string' ? p.signals.safest : null
  if (safest && safest !== keep.statement && !(keep.edited_by_user ?? false)) fill.statement = safest
  out.push({ table: 'evidence_facts', op: 'update', kind: 'fill', id: keep.id, values: fill })
  out.push({ table: 'evidence_facts', op: 'update', kind: 'tombstone', id: merge.id, values: { status: 'merged', merged_into: keep.id } })
  out.push({ table: 'evidence_merge_suggestions', op: 'insert', kind: 'suggestion', values: suggestionRow(userId, p, 'merged') })
}

// ─── Metric merge / orphan link ──────────────────────────────────────────────

function metricMerge(bank: EvidenceBank, p: MergeProposal, out: Mutation[]): void {
  const keep = bank.metrics.find((m) => m.id === p.keep_id)
  if (!keep) return
  if (p.rule === 'link_orphan_to_fact') {
    out.push({ table: 'evidence_metrics', op: 'update', kind: 'link', id: keep.id, values: { fact_ids: [...new Set([...keep.fact_ids, p.merge_id])] } })
    out.push({ table: 'evidence_merge_suggestions', op: 'insert', kind: 'suggestion', values: suggestionRow(keep.user_id, p, 'merged') })
    return
  }
  const merge = bank.metrics.find((m) => m.id === p.merge_id)
  if (!merge) return
  const fill: Record<string, unknown> = { fact_ids: [...new Set([...keep.fact_ids, ...merge.fact_ids])] }
  if (keep.context === null && merge.context !== null) fill.context = merge.context
  if (keep.unit === null && merge.unit !== null) fill.unit = merge.unit
  out.push({ table: 'evidence_metrics', op: 'update', kind: 'fill', id: keep.id, values: fill })
  out.push({ table: 'evidence_metrics', op: 'update', kind: 'tombstone', id: merge.id, values: { status: 'merged', merged_into: keep.id } })
  out.push({ table: 'evidence_merge_suggestions', op: 'insert', kind: 'suggestion', values: suggestionRow(keep.user_id, p, 'merged') })
}

/**
 * Every write the selected proposals imply, in dependency order (children
 * first, tombstones last). Proposals not in `selection` are ignored; a
 * selection naming a pair the plan does not contain is ignored too.
 */
export function planMutations(plan: PlanSlice, bank: EvidenceBank, selection: Selection): Mutation[] {
  const wanted = new Set(selection.map((s) => `${s.entity_type}:${s.keep_id}:${s.merge_id}`))
  const chosen = (list: MergeProposal[]) => list.filter((p) => wanted.has(`${p.entity_type}:${p.keep_id}:${p.merge_id}`) && p.confidence !== 'CONFLICT')
  const out: Mutation[] = []
  const activeExp = new Set(activeRows(bank.experiences).map((e) => e.id))
  const activeFacts = new Set(activeRows(bank.facts).map((f) => f.id))
  const activeMetrics = new Set(activeRows(bank.metrics).map((m) => m.id))
  // A keep that is itself merged elsewhere in this selection would receive
  // children and then be tombstoned; the plan resolves chains so this cannot
  // happen, but the invariant is cheap to enforce here too.
  const chosenExp = chosen(plan.experiences)
  const mergedExp = new Set(chosenExp.map((p) => p.merge_id))
  const seenMerge = new Set<string>()
  for (const p of chosenExp) {
    if (!activeExp.has(p.keep_id) || !activeExp.has(p.merge_id)) continue
    if (mergedExp.has(p.keep_id) || seenMerge.has(p.merge_id)) continue
    seenMerge.add(p.merge_id)
    experienceMerge(bank, p, out)
  }
  for (const p of chosen(plan.facts)) if (activeFacts.has(p.keep_id) && activeFacts.has(p.merge_id)) factMerge(bank, p, out)
  for (const p of chosen(plan.metrics)) if (activeMetrics.has(p.keep_id)) metricMerge(bank, p, out)
  return out
}

export type { EvidenceExperience }
