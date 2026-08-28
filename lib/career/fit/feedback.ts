// Feedback → ranking. Pure, bounded, inspectable.
//
// LOVE / INTERESTED / MAYBE / NOT_INTERESTED with reasons adjusts SOFT
// preferences through a modifier small enough to reorder neighbours and never
// large enough to bury a strong fit or rescue a weak one. It never touches
// hard constraints and never touches eligibility — those are not preferences.
//
// Two regimes, in priority order:
//
//   1. Direct feedback on THIS job dominates. If the user said NOT_INTERESTED
//      to the very posting, no attribute aggregate should argue with them.
//   2. Otherwise, attributes. An attribute counts only when at least two
//      NOT_INTERESTED verdicts share it AND their reasons name that category —
//      one "no" is a data point, two with the same stated reason is a pattern,
//      and a "no" for location says nothing about the role family.
//
// No ML. Every number here has a sentence attached, and the sentences are
// returned so the UI can show why a job moved.

import type { FeedbackReason, FeedbackVerdict } from '../types'

export interface FeedbackJobAttrs {
  id: string
  role_family: string | null
  industry: string | null
  company_name: string | null
  location_tier: number | null
  company_type?: string | null
}

export interface FeedbackRow {
  job_id: string
  verdict: FeedbackVerdict
  reasons: (FeedbackReason | string)[]
  role_family: string | null
  industry: string | null
  company_name: string | null
  location_tier: number | null
  company_type?: string | null
  note?: string | null
  /**
   * ISO timestamp. When present, rows are ordered by it here — job_feedback's
   * indexes are `created_at desc`, so a loader that reads them naively hands
   * us newest-first and "latest wins" would silently pick the oldest.
   */
  created_at?: string | null
}

/** Oldest first. Rows without a timestamp keep their given order (stable sort). */
function chronological(feedback: FeedbackRow[]): FeedbackRow[] {
  if (!feedback.some((f) => f.created_at)) return feedback
  return feedback
    .map((f, i) => ({ f, i }))
    .sort((a, b) => {
      const ta = a.f.created_at ?? ''
      const tb = b.f.created_at ?? ''
      return ta < tb ? -1 : ta > tb ? 1 : a.i - b.i
    })
    .map((x) => x.f)
}

export interface FeedbackAdjustment {
  /** Bounded to [-0.25, +0.12]. */
  adjustment: number
  reasons: string[]
}

export const FEEDBACK_ADJUSTMENT_MIN = -0.25
export const FEEDBACK_ADJUSTMENT_MAX = 0.12

const DIRECT: Record<FeedbackVerdict, number> = {
  NOT_INTERESTED: -0.25,
  MAYBE: -0.05,
  INTERESTED: 0.06,
  LOVE: 0.12,
}

const NEGATIVE_PER_ATTRIBUTE = -0.03
const NEGATIVE_CAP = -0.10
const POSITIVE_PER_MATCH = 0.02
const POSITIVE_CAP = 0.06

type Attribute = 'role_family' | 'industry' | 'company_name' | 'location_tier'

/** Which stated reasons make a NOT_INTERESTED count against which attribute. */
const REASON_CATEGORIES: Record<Attribute, Set<string>> = {
  role_family: new Set(['role', 'too_software_heavy', 'too_operations_heavy', 'not_technical_enough', 'too_narrow']),
  industry: new Set(['industry']),
  company_name: new Set(['company', 'brand', 'too_corporate']),
  location_tier: new Set(['location']),
}

const norm = (s: string | null | undefined): string | null => {
  const v = (s ?? '').trim().toLowerCase()
  return v || null
}

function attributeValue(row: FeedbackJobAttrs | FeedbackRow, attr: Attribute): string | null {
  switch (attr) {
    case 'role_family':
      return norm(row.role_family)
    case 'industry':
      return norm(row.industry)
    case 'company_name':
      // company/brand/too_corporate map to the company itself OR its type — a
      // "too corporate" on one Fortune 500 is a signal about the next one.
      return norm(row.company_name)
    case 'location_tier':
      return row.location_tier === null || row.location_tier === undefined ? null : String(row.location_tier)
  }
}

function matches(job: FeedbackJobAttrs, fb: FeedbackRow, attr: Attribute): boolean {
  const a = attributeValue(job, attr)
  const b = attributeValue(fb, attr)
  if (a && b && a === b) return true
  if (attr === 'company_name') {
    const t1 = norm(job.company_type)
    const t2 = norm(fb.company_type)
    return Boolean(t1 && t2 && t1 === t2)
  }
  return false
}

function reasonsName(fb: FeedbackRow, attr: Attribute): boolean {
  const set = REASON_CATEGORIES[attr]
  return fb.reasons.some((r) => set.has(String(r).toLowerCase()))
}

export function clampAdjustment(n: number): number {
  return Math.min(FEEDBACK_ADJUSTMENT_MAX, Math.max(FEEDBACK_ADJUSTMENT_MIN, n))
}

export function computeFeedbackAdjustment(job: FeedbackJobAttrs, rows: FeedbackRow[]): FeedbackAdjustment {
  const reasons: string[] = []
  const feedback = chronological(rows)

  // ─── 1. Direct feedback on the same job ───
  // Latest wins when there are several — by created_at when supplied, else
  // by the caller's order.
  const direct = feedback.filter((f) => f.job_id === job.id)
  if (direct.length) {
    const last = direct[direct.length - 1]
    const adj = DIRECT[last.verdict] ?? 0
    reasons.push(`direct ${last.verdict} on this job: ${fmt(adj)}`)
    return { adjustment: clampAdjustment(adj), reasons }
  }

  // ─── 2. Attribute aggregates ───
  let negative = 0
  let positive = 0
  const attrs: Attribute[] = ['role_family', 'industry', 'company_name', 'location_tier']

  for (const attr of attrs) {
    const nos = feedback.filter((f) => f.verdict === 'NOT_INTERESTED' && matches(job, f, attr) && reasonsName(f, attr))
    if (nos.length >= 2) {
      negative += NEGATIVE_PER_ATTRIBUTE
      const value = attributeValue(job, attr) ?? norm(job.company_type) ?? '?'
      reasons.push(`${nos.length}× NOT_INTERESTED citing ${attr}=${value}: ${fmt(NEGATIVE_PER_ATTRIBUTE)}`)
    }

    const yes = feedback.filter((f) => (f.verdict === 'LOVE' || f.verdict === 'INTERESTED') && matches(job, f, attr))
    if (yes.length) {
      positive += POSITIVE_PER_MATCH
      const value = attributeValue(job, attr) ?? norm(job.company_type) ?? '?'
      reasons.push(`${yes.length}× LOVE/INTERESTED sharing ${attr}=${value}: ${fmt(POSITIVE_PER_MATCH)}`)
    }
  }

  const negCapped = Math.max(NEGATIVE_CAP, negative)
  const posCapped = Math.min(POSITIVE_CAP, positive)
  if (negCapped !== negative) reasons.push(`negative aggregate capped at ${fmt(NEGATIVE_CAP)}`)
  if (posCapped !== positive) reasons.push(`positive aggregate capped at ${fmt(POSITIVE_CAP)}`)

  const total = round4(negCapped + posCapped)
  return { adjustment: clampAdjustment(total), reasons }
}

function fmt(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}`
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

/**
 * Feedback as prompt hints. The agent READS these to understand what the
 * person means by their preferences; the number above is applied in code.
 * Newest first, capped, because a long list of past reactions is exactly the
 * kind of context that crowds out the job itself.
 */
export function renderFeedbackHints(feedback: FeedbackRow[], opts: { max?: number } = {}): string[] {
  const max = opts.max ?? 8
  return chronological(feedback)
    .slice()
    .reverse()
    .slice(0, max)
    .map((f) => {
      const where = [f.role_family, f.industry, f.company_name].filter(Boolean).join(' · ') || 'a similar job'
      const why = f.reasons.length ? ` — reasons: ${f.reasons.join(', ')}` : ''
      const note = f.note?.trim() ? ` — "${f.note.trim().slice(0, 140)}"` : ''
      return `${f.verdict} on ${where}${why}${note}`
    })
}
