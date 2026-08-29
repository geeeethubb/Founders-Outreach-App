// Consolidation plan builder — what the bank should become, before anything
// is written.
//
// buildConsolidationPlan is a pure function of (bank, options). No database,
// no randomness, no clock when `now` is given. The dry run prints it, the
// review tab shows it, applyConsolidation executes the HIGH part of it; the
// three can never disagree because they read the same object.
//
// Rules live in ./consolidate-rules; this file walks the bank, pairs rows
// under the same organization key, classifies each pair once, and folds the
// verdicts into proposals with signals, conflicts and human-readable labels.

import type {
  EvidenceBank, EvidenceExperience, EvidenceFact, EvidenceMetric, MergeEntityType,
} from '../types'
import type { ConflictProposal, ConsolidationPlan, MergeProposal } from './consolidate-types'
import { resolveExperienceChains } from './consolidate-chains'
import { planMutations } from './consolidate-mutations'
import {
  compareExperiences, compareFacts, contextTokens, jaccard, METRIC_CONTEXT_OVERLAP, nowMonthIndex,
  numericTokens, orgKey, preferKeep, safestWording, sameDate, titleKey,
} from './consolidate-rules'
import { normalizeMetricValue } from './normalize'
import { splitSourceLocation } from './sources'
import { planOrganizations, planProvenance, planSummaries } from './consolidate-groups'

export { organizationKindFor } from './consolidate-groups'

export type PairRef = { entity_type: MergeEntityType; keep_id: string; merge_id: string }

export interface PlanOptions {
  /** Pairs the user marked kept_separate — excluded from proposals, listed under `suppressed`. */
  suppressed?: PairRef[]
  migration015?: boolean
  /** ISO timestamp used for generated_at and to resolve "Present". */
  now?: string
}

const active = <T extends { status?: string }>(rows: T[]): T[] => rows.filter((r) => (r.status ?? 'active') === 'active')

export function experienceLabelShort(e: EvidenceExperience): string {
  const dates = [e.start_date, e.end_date].filter(Boolean).join('–')
  return `${e.organization} | ${e.title}${dates ? ` | ${dates}` : ''}`
}

function sourceLabelOf(row: { source: string; source_location?: string | null }): string {
  return splitSourceLocation(row.source, row.source_location ?? null).label
}

function pairKey(p: PairRef): string {
  return `${p.entity_type}:${p.keep_id}:${p.merge_id}`
}

// ─── Experiences ─────────────────────────────────────────────────────────────

function experienceConflicts(keep: EvidenceExperience, merge: EvidenceExperience): ConflictProposal[] {
  const out: ConflictProposal[] = []
  const cand = (field: string, a: string | null, b: string | null) => {
    if (!a || !b) return
    out.push({
      entity_type: 'experience', entity_id: keep.id, field,
      candidates: [
        { value: a, source_id: null, source_label: keep.source },
        { value: b, source_id: null, source_label: merge.source },
      ],
    })
  }
  if (titleKey(keep.title) !== titleKey(merge.title)) cand('title', keep.title, merge.title)
  if (!sameDate(keep.start_date, merge.start_date)) cand('start_date', keep.start_date, merge.start_date)
  if (!sameDate(keep.end_date, merge.end_date)) cand('end_date', keep.end_date, merge.end_date)
  return out
}

function childCounts(bank: EvidenceBank, id: string): { facts: number; metrics: number; bullets: number } {
  return {
    facts: active(bank.facts).filter((f) => f.experience_id === id).length,
    metrics: active(bank.metrics).filter((m) => m.experience_id === id).length,
    bullets: bank.bullets.filter((b) => b.experience_id === id).length,
  }
}

function planExperiences(bank: EvidenceBank, nowMonth: number, warnings: string[]): MergeProposal[] {
  const rows = active(bank.experiences)
  const byOrg = new Map<string, EvidenceExperience[]>()
  for (const e of rows) {
    const k = orgKey(e.organization)
    byOrg.set(k, [...(byOrg.get(k) ?? []), e])
  }
  const proposals: MergeProposal[] = []
  for (const [key, group] of [...byOrg.entries()].sort()) {
    const sorted = [...group].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1))
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const verdict = compareExperiences(sorted[i], sorted[j], nowMonth)
        if (verdict.class === 'NEVER') {
          if (verdict.rule === 'disjoint_dates' && titleKey(sorted[i].title) === titleKey(sorted[j].title)) {
            warnings.push(`same org+title in disjoint periods, kept separate: "${experienceLabelShort(sorted[i])}" vs "${experienceLabelShort(sorted[j])}"`)
          }
          continue
        }
        const [keep, merge] = preferKeep(sorted[i], sorted[j])
        const conflicts = experienceConflicts(keep, merge)
        const titleConflict = conflicts.some((c) => c.field === 'title')
        let confidence: MergeProposal['confidence'] = verdict.class
        if (confidence === 'HIGH' && titleConflict) confidence = 'POSSIBLE'
        const mc = childCounts(bank, merge.id)
        proposals.push({
          entity_type: 'experience',
          keep_id: keep.id,
          merge_id: merge.id,
          confidence,
          rule: verdict.rule,
          signals: {
            org_key: key,
            title_similarity: verdict.similarity,
            date_overlap: verdict.class === 'POSSIBLE' ? verdict.overlap : null,
            title_conflict: titleConflict,
            keep_source: keep.source, merge_source: merge.source,
            keep_approved: keep.approved, merge_approved: merge.approved,
            keep_kind: keep.kind, merge_kind: merge.kind,
            downgraded: verdict.class === 'HIGH' && titleConflict ? 'title_conflict' : null,
          },
          keep_label: experienceLabelShort(keep),
          merge_label: experienceLabelShort(merge),
          why: describeExperienceWhy(verdict.rule, verdict.similarity, verdict.class === 'POSSIBLE' ? verdict.overlap : null, titleConflict),
          data_preserved: `${mc.facts} facts, ${mc.metrics} metrics, ${mc.bullets} bullets re-pointed to keep; merged row tombstoned (status=merged), both titles/dates stored${conflicts.length ? ` as ${conflicts.length} conflict(s)` : ''}`,
          risk: confidence === 'HIGH' ? 'low — same org, same role, compatible dates' : 'needs a human: titles differ',
          conflicts,
        })
      }
    }
  }
  const labelOf = (id: string) => { const e = rows.find((r) => r.id === id); return e ? experienceLabelShort(e) : id }
  const resolved = resolveExperienceChains(proposals, labelOf)
  warnings.push(...resolved.warnings)
  return resolved.proposals
}

function describeExperienceWhy(rule: string, similarity: number, overlap: number | null, titleConflict: boolean): string {
  switch (rule) {
    case 'exact_title': return 'same organization (alias table) and the same normalized title; dates compatible'
    case 'similar_title': return `same organization; titles differ only by seniority qualifiers (similarity ${similarity})`
    case 'near_title': return `same organization; title similarity ${similarity} is in the near-miss band [0.3, 0.6)`
    case 'same_org_same_dates': return `same organization and the same period (overlap ${overlap}) under different titles${titleConflict ? ' — title conflict recorded' : ''}`
    case 'different_qualifier': return 'same organization and title, but the org qualifiers name different units (labs/teams)'
    default: return rule
  }
}

// ─── Facts ───────────────────────────────────────────────────────────────────

function factLabel(f: EvidenceFact): string {
  const s = f.statement.replace(/\s+/g, ' ')
  return s.length > 90 ? `${s.slice(0, 87)}…` : s
}

/**
 * `cap` is the parent experience pair's confidence: children of a POSSIBLE
 * experience pair are listed but never graded above POSSIBLE, so nothing under
 * an unconfirmed experience merge is ever auto-applied.
 */
function factProposal(a: EvidenceFact, b: EvidenceFact, scope: string, cap: MergeProposal['confidence'] = 'HIGH'): MergeProposal | null {
  const v = compareFacts(a, b)
  if (!v) return null
  if (v.class === 'CONFLICT') {
    const [keep, merge] = a.source === 'master_resume' || a.created_at <= b.created_at ? [a, b] : [b, a]
    return {
      entity_type: 'fact', keep_id: keep.id, merge_id: merge.id, confidence: 'CONFLICT', rule: v.rule,
      signals: { jaccard: Number(v.jaccard.toFixed(2)), numbers_keep: keep === a ? v.numbers[0] : v.numbers[1], numbers_merge: keep === a ? v.numbers[1] : v.numbers[0], scope },
      keep_label: factLabel(keep), merge_label: factLabel(merge),
      why: `same claim (word overlap ${v.jaccard.toFixed(2)}) with different numbers — never harmonized`,
      data_preserved: 'both facts kept active; nothing merged',
      risk: 'none applied — listed for review only',
      conflicts: [{ entity_type: 'fact', entity_id: keep.id, field: 'value', candidates: [
        { value: keep.statement, source_id: null, source_label: sourceLabelOf(keep) },
        { value: merge.statement, source_id: null, source_label: sourceLabelOf(merge) },
      ] }],
    }
  }
  const safest = safestWording(a, b)
  // A statement the user edited by hand survives as the keep with its own
  // wording; the safest wording is still recorded so the user can see it.
  const aEdited = a.edited_by_user ?? false
  const bEdited = b.edited_by_user ?? false
  const { keep, other } = aEdited && !bEdited ? { keep: a, other: b } : bEdited && !aEdited ? { keep: b, other: a } : safest
  const capped = cap !== 'HIGH' && v.class === 'HIGH'
  return {
    entity_type: 'fact', keep_id: keep.id, merge_id: other.id, confidence: capped ? 'POSSIBLE' : v.class, rule: v.rule,
    signals: {
      jaccard: Number(v.jaccard.toFixed(2)), scope,
      safest: safest.keep.statement, other_wording: other.statement,
      keep_source: sourceLabelOf(keep), merge_source: sourceLabelOf(other),
      keep_edited_by_user: keep.edited_by_user ?? false,
      ...(capped ? { downgraded: 'experience_pair_not_high' } : {}),
    },
    keep_label: factLabel(keep), merge_label: factLabel(other),
    why: v.rule === 'statement_norm' ? 'identical statement after normalization' : `same numbers, word overlap ${v.jaccard.toFixed(2)}`,
    data_preserved: 'other wording kept as a provenance quote; every citation re-pointed; support_count summed; merged row tombstoned',
    risk: capped ? 'needs a human: the experiences themselves are only a POSSIBLE match' : v.class === 'HIGH' ? 'low' : 'needs a human: wording differs',
    conflicts: [],
  }
}

function planFacts(bank: EvidenceBank, experienceProposals: MergeProposal[]): MergeProposal[] {
  const facts = active(bank.facts)
  const byExp = new Map<string, EvidenceFact[]>()
  for (const f of facts) {
    const k = f.experience_id ?? '(none)'
    byExp.set(k, [...(byExp.get(k) ?? []), f])
  }
  const out: MergeProposal[] = []
  const seen = new Set<string>()
  const push = (p: MergeProposal | null) => {
    if (!p) return
    const k = `${p.keep_id}:${p.merge_id}`
    if (seen.has(k)) return
    seen.add(k)
    out.push(p)
  }
  for (const [expId, group] of [...byExp.entries()].sort()) {
    if (expId === '(none)') continue
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) push(factProposal(group[i], group[j], 'same_experience'))
  }
  for (const ep of experienceProposals) {
    const left = byExp.get(ep.keep_id) ?? []
    const right = byExp.get(ep.merge_id) ?? []
    for (const a of left) for (const b of right) push(factProposal(a, b, `experience_pair:${ep.confidence}`, ep.confidence))
  }
  return out
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

function metricLabel(m: EvidenceMetric): string {
  return `${m.value}${m.unit ? ` ${m.unit}` : ''}${m.context ? ` — ${m.context}` : ''}`
}

function planMetrics(bank: EvidenceBank, experienceProposals: MergeProposal[], warnings: string[]): { proposals: MergeProposal[]; orphaned: string[] } {
  const metrics = active(bank.metrics)
  const facts = active(bank.facts)
  const proposals: MergeProposal[] = []
  const groupOf = new Map<string, string>()
  for (const m of metrics) groupOf.set(m.id, m.experience_id ?? '(none)')
  for (const ep of experienceProposals) if (ep.confidence === 'HIGH') for (const m of metrics) if (m.experience_id === ep.merge_id) groupOf.set(m.id, ep.keep_id)
  // Metrics under a POSSIBLE experience pair are compared too, but capped at POSSIBLE.
  const possiblePair = new Map<string, string>()
  for (const ep of experienceProposals) if (ep.confidence !== 'HIGH') { possiblePair.set(`${ep.keep_id}|${ep.merge_id}`, ep.confidence); possiblePair.set(`${ep.merge_id}|${ep.keep_id}`, ep.confidence) }

  const seen = new Set<string>()
  for (let i = 0; i < metrics.length; i++) {
    for (let j = i + 1; j < metrics.length; j++) {
      const a = metrics[i], b = metrics[j]
      const ga = groupOf.get(a.id) as string, gb = groupOf.get(b.id) as string
      if (ga === '(none)' || gb === '(none)') continue
      const capped = ga !== gb && possiblePair.has(`${ga}|${gb}`)
      if (ga !== gb && !capped) continue
      if (normalizeMetricValue(a.value) !== normalizeMetricValue(b.value)) continue
      const overlap = jaccard(contextTokens(a.context), contextTokens(b.context))
      if (overlap < METRIC_CONTEXT_OVERLAP) continue
      const [keep, merge] = a.source === 'master_resume' && b.source !== 'master_resume' ? [a, b] : b.source === 'master_resume' && a.source !== 'master_resume' ? [b, a] : [a, b]
      const k = `${keep.id}:${merge.id}`
      if (seen.has(k)) continue
      seen.add(k)
      proposals.push({
        entity_type: 'metric', keep_id: keep.id, merge_id: merge.id, confidence: capped ? 'POSSIBLE' : 'HIGH', rule: 'same_value_same_context',
        signals: { value_norm: normalizeMetricValue(a.value), context_overlap: Number(overlap.toFixed(2)), ...(capped ? { downgraded: 'experience_pair_not_high' } : {}) },
        keep_label: metricLabel(keep), merge_label: metricLabel(merge),
        why: `same normalized value "${normalizeMetricValue(a.value)}" and context overlap ${overlap.toFixed(2)}`,
        data_preserved: 'fact_ids unioned onto keep; context filled when keep has none; merged row tombstoned',
        risk: capped ? 'needs a human: the experiences themselves are only a POSSIBLE match' : 'low', conflicts: [],
      })
    }
  }

  const orphaned: string[] = []
  for (const m of metrics) {
    if (m.fact_ids.length > 0 || !m.experience_id) { if (m.fact_ids.length === 0) orphaned.push(m.id); continue }
    const nums = numericTokens(m.value)
    const hits = facts.filter((f) => f.experience_id === m.experience_id && nums.length > 0 && nums.every((n) => numericTokens(f.statement).includes(n)))
    if (hits.length === 1) {
      proposals.push({
        entity_type: 'metric', keep_id: m.id, merge_id: hits[0].id, confidence: 'HIGH', rule: 'link_orphan_to_fact',
        signals: { numeric_tokens: nums, fact_statement: hits[0].statement },
        keep_label: metricLabel(m), merge_label: factLabel(hits[0]),
        why: `exactly one fact under the same experience contains ${nums.join(', ')}`,
        data_preserved: 'metric.fact_ids set to the fact; nothing tombstoned',
        risk: 'low', conflicts: [],
      })
    } else {
      orphaned.push(m.id)
      warnings.push(`orphan metric "${metricLabel(m)}" — ${hits.length === 0 ? 'no' : `${hits.length}`} facts under its experience contain ${nums.join(', ') || 'a number'}`)
    }
  }
  return { proposals, orphaned }
}

// ─── The plan ────────────────────────────────────────────────────────────────

export function buildConsolidationPlan(bank: EvidenceBank, opts: PlanOptions = {}): ConsolidationPlan {
  const now = opts.now ?? new Date().toISOString()
  const nowMonth = nowMonthIndex(now)
  const warnings: string[] = []
  const suppressed = new Set((opts.suppressed ?? []).map(pairKey))
  const suppressedReverse = new Set((opts.suppressed ?? []).map((p) => pairKey({ ...p, keep_id: p.merge_id, merge_id: p.keep_id })))
  const notSuppressed = (p: MergeProposal) => !suppressed.has(pairKey(p)) && !suppressedReverse.has(pairKey(p))

  const experiences = planExperiences(bank, nowMonth, warnings).filter(notSuppressed)
  const facts = planFacts(bank, experiences).filter(notSuppressed)
  const { proposals: metrics, orphaned } = planMetrics(bank, experiences, warnings)
  const metricProposals = metrics.filter(notSuppressed)
  const organizations = planOrganizations(bank)
  const provenance = planProvenance(bank)
  const summaries = planSummaries(bank)
  // Conflict rows are written only when a pair is actually merged (HIGH
  // experiences) or when two facts disagree on a number (CONFLICT facts).
  // Disagreements inside a POSSIBLE pair stay in that suggestion's signals.
  const conflicts = [...experiences.filter((p) => p.confidence === 'HIGH'), ...facts.filter((p) => p.confidence === 'CONFLICT')].flatMap((p) => p.conflicts)

  const count = (list: MergeProposal[], c: MergeProposal['confidence']) => list.filter((p) => p.confidence === c).length
  const high = [...experiences, ...facts, ...metricProposals].filter((p) => p.confidence === 'HIGH')
  const mutations = planMutations({ experiences, facts, metrics: metricProposals }, bank, high)
  const userId = bank.experiences[0]?.user_id ?? bank.facts[0]?.user_id ?? ''

  return {
    user_id: userId,
    generated_at: now,
    migration015: opts.migration015 ?? bank.experiences.some((e) => e.status !== undefined),
    organizations,
    provenance,
    experiences,
    facts,
    metrics: metricProposals,
    conflicts,
    summaries,
    suppressed: (opts.suppressed ?? []).map((p) => ({ entity_type: p.entity_type, keep_id: p.keep_id, merge_id: p.merge_id })),
    summary: {
      experiences: { active: active(bank.experiences).length, high: count(experiences, 'HIGH'), possible: count(experiences, 'POSSIBLE'), conflict: count(experiences, 'CONFLICT') },
      facts: { active: active(bank.facts).length, high: count(facts, 'HIGH'), possible: count(facts, 'POSSIBLE'), conflict: count(facts, 'CONFLICT') },
      metrics: { active: active(bank.metrics).length, high: count(metricProposals, 'HIGH'), possible: count(metricProposals, 'POSSIBLE'), orphaned: orphaned.length },
      organizations: { proposed: organizations.filter((o) => !o.existing_id).length, existing: organizations.filter((o) => o.existing_id).length },
      would_tombstone: mutations.filter((m) => m.kind === 'tombstone').length,
      would_repoint: mutations.filter((m) => m.kind === 'repoint').length,
    },
    warnings,
  }
}
