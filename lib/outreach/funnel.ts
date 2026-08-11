// Funnel arithmetic.
//
// Pure functions over rows. No model, no inference, no scoring — counting is
// counting (CLAUDE.md principle 1). Deliberately NOT machine learning: this
// phase's job is to produce clean structured data that a later Learning Agent
// can read, and the fastest way to poison that is to start fitting things to
// twenty data points.
//
// Every breakdown carries its denominator. A 100% reply rate on one send is the
// single most misleading number this file could emit, so no rate is ever
// reported without the count it came from.

import {
  CONVERSATION_OUTCOMES,
  OPPORTUNITY_OUTCOMES,
  hasBeenSent,
  hasReplied,
  type Outcome,
  type OutreachState,
} from './states'

export interface FunnelRow {
  state: OutreachState
  outcome: Outcome | null
  segment: string | null
  company_type: string | null
  recipient_role: string | null
  angle: string | null
  proof_point_ids: string[] | null
  cta: string | null
  word_count: number | null
  sent_at: string | null
  replied_at: string | null
}

export interface FunnelStage {
  label: string
  count: number
  /** Share of the stage above. Null for the first stage and for empty parents. */
  ofPrevious: number | null
}

export interface Breakdown {
  key: string
  drafted: number
  sent: number
  replies: number
  conversations: number
  /** Null below the minimum sample — a rate on 2 sends is noise, not signal. */
  replyRate: number | null
}

export interface FunnelReport {
  stages: FunnelStage[]
  bySegment: Breakdown[]
  byCompanyType: Breakdown[]
  byRole: Breakdown[]
  byAngle: Breakdown[]
  byProofPoint: Breakdown[]
  byCta: Breakdown[]
  byLength: Breakdown[]
  outcomes: { outcome: string; count: number }[]
  medianDaysToReply: number | null
}

/** Below this a rate is not reported. Five is already generous. */
export const MIN_SAMPLE_FOR_RATE = 5

function rate(numerator: number, denominator: number): number | null {
  if (denominator < MIN_SAMPLE_FOR_RATE) return null
  return numerator / denominator
}

function isConversation(row: FunnelRow): boolean {
  if (row.outcome && CONVERSATION_OUTCOMES.includes(row.outcome)) return true
  return row.state === 'meeting' || row.state === 'referred'
}

function isOpportunity(row: FunnelRow): boolean {
  return !!row.outcome && OPPORTUNITY_OUTCOMES.includes(row.outcome)
}

function bucketLength(words: number | null): string {
  if (words === null) return 'unknown'
  if (words < 80) return 'under 80 words'
  if (words <= 110) return '80-110 words'
  if (words <= 140) return '111-140 words'
  return 'over 140 words'
}

/** The CTA varies in wording, so group by the shape of the ask. */
function bucketCta(cta: string | null): string {
  if (!cta) return 'unknown'
  const c = cta.toLowerCase()
  if (/\b(\d+)\s*(?:-|\s)?min/.test(c) || /call|chat|conversation|speak/.test(c)) return 'time on a call'
  if (/refer|point me|who else|introduc/.test(c)) return 'referral'
  if (/read|look at|review|send|one-page|sketch|attach/.test(c)) return 'review something'
  if (/advice|thoughts|perspective|opinion/.test(c)) return 'advice'
  return 'other'
}

function tally(rows: FunnelRow[], keyOf: (r: FunnelRow) => string[]): Breakdown[] {
  const map = new Map<string, Breakdown>()
  for (const row of rows) {
    for (const key of keyOf(row)) {
      if (!key) continue
      const b = map.get(key) ?? { key, drafted: 0, sent: 0, replies: 0, conversations: 0, replyRate: null }
      b.drafted++
      if (hasBeenSent(row.state)) b.sent++
      if (hasReplied(row.state) || row.replied_at) b.replies++
      if (isConversation(row)) b.conversations++
      map.set(key, b)
    }
  }
  return Array.from(map.values())
    .map((b) => ({ ...b, replyRate: rate(b.replies, b.sent) }))
    .sort((a, b) => b.sent - a.sent || b.drafted - a.drafted)
}

/**
 * @param prospectsScouted total ranked prospects the run produced — the top of
 *   the funnel. Passed in rather than derived: prospects that never reached a
 *   draft have no `outreach` row by design, and pretending the funnel starts at
 *   "drafted" would hide the biggest drop in it.
 */
export function buildFunnel(rows: FunnelRow[], prospectsScouted: number): FunnelReport {
  const drafted = rows.length
  const approved = rows.filter(
    (r) => r.state === 'approved' || hasBeenSent(r.state) || r.state === 'sending'
  ).length
  const sent = rows.filter((r) => hasBeenSent(r.state)).length
  const replies = rows.filter((r) => hasReplied(r.state) || r.replied_at).length
  const conversations = rows.filter(isConversation).length
  const opportunities = rows.filter(isOpportunity).length

  const counts = [
    { label: 'Prospects scouted', count: Math.max(prospectsScouted, drafted) },
    { label: 'Drafts generated', count: drafted },
    { label: 'Approved', count: approved },
    { label: 'Sent', count: sent },
    { label: 'Replies', count: replies },
    { label: 'Conversations', count: conversations },
    { label: 'Opportunities', count: opportunities },
  ]

  const stages: FunnelStage[] = counts.map((c, i) => ({
    ...c,
    ofPrevious: i === 0 || counts[i - 1].count === 0 ? null : c.count / counts[i - 1].count,
  }))

  const outcomeCounts = new Map<string, number>()
  for (const r of rows) {
    if (!r.outcome) continue
    outcomeCounts.set(r.outcome, (outcomeCounts.get(r.outcome) ?? 0) + 1)
  }

  return {
    stages,
    bySegment: tally(rows, (r) => [r.segment ?? 'unassigned']),
    byCompanyType: tally(rows, (r) => [r.company_type ?? 'unknown']),
    byRole: tally(rows, (r) => [r.recipient_role ?? 'unknown']),
    // Theses are unique per prospect, so group by the first few words — enough
    // to spot a repeated framing without pretending two sentences are the same.
    byAngle: tally(rows, (r) => [r.angle ? r.angle.split(/\s+/).slice(0, 6).join(' ') : 'unknown']),
    byProofPoint: tally(rows, (r) => r.proof_point_ids ?? []),
    byCta: tally(rows, (r) => [bucketCta(r.cta)]),
    byLength: tally(rows, (r) => [bucketLength(r.word_count)]),
    outcomes: Array.from(outcomeCounts.entries())
      .map(([outcome, count]) => ({ outcome, count }))
      .sort((a, b) => b.count - a.count),
    medianDaysToReply: medianDaysToReply(rows),
  }
}

function medianDaysToReply(rows: FunnelRow[]): number | null {
  const gaps = rows
    .filter((r) => r.sent_at && r.replied_at)
    .map((r) => (new Date(r.replied_at!).getTime() - new Date(r.sent_at!).getTime()) / 86_400_000)
    .filter((d) => d >= 0)
    .sort((a, b) => a - b)
  if (gaps.length === 0) return null
  const mid = Math.floor(gaps.length / 2)
  const value = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2
  return Math.round(value * 10) / 10
}
