// The inbox at 500 postings: score everything, page a little.
//
// Relevance is computed at READ time (lib/career/jobs/inbox-relevance.ts), which
// is what makes "change the direction and everything re-ranks" true with no
// migration — and it is also why the naive shape does not work. PostgREST can
// page and count in the database; it cannot page or count by a number that does
// not exist until this request runs. Filtering a page in memory gives a list
// with holes and a header that lies about how many were hidden, which is the
// exact failure the founder is complaining about, one level up.
//
// So: two queries.
//
//   1. The CENSUS — every posting matching the non-relevance filters, scalar
//      columns only, no embedded relations. Cheap enough to fetch whole (a few
//      hundred narrow rows), and it is the only thing that can answer "how many
//      are there, how many are strong, how many am I hiding" truthfully.
//   2. The PAGE — full rows, with fit, applications, feedback and warm paths,
//      for the ≤ 50 ids the ordering actually selected.
//
// The census deliberately does NOT select `description_text` — it is the
// largest column in the table — and `InboxRelevanceJob` deliberately does not
// declare it, so no other read path can score from it either. Otherwise the run
// view (which fetches full rows) and the inbox (which scores from this census)
// would put different numbers on the same posting. Scoring happens once, in the
// census, and the page carries those scores by id, so what the header counted
// and what the card displays can never disagree.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { JobListRow } from '@/lib/career/jobs/store'
import {
  bestFirstKey,
  passesRelevance,
  relevanceCounts,
  scoreRelevance,
  type HiddenGroup,
  type InboxRelevance,
  type RelevanceContext,
  type RelevanceCounts,
  type RelevanceFilter,
} from '@/lib/career/jobs/inbox-relevance'

type Db = SupabaseClient

/** How many postings one census reads. Well past what a year of daily sweeps produces. */
export const CENSUS_CEILING = 2_000

/** What relevance needs, and nothing else. Keep in step with `InboxRelevanceJob`. */
const CENSUS_COLUMNS =
  'id, title, company_name, role_family, industry, skills, location_tier, employment_type, season_relevance, extraction_version, fit_overall, deadline, first_seen_at, last_seen_at'

/**
 * The embedded relations a job card needs. Mirrors `listJobs`'s select in
 * lib/career/jobs/store.ts, because that function cannot yet be asked for a
 * specific set of ids — see the `ids` request in this workstream's contracts.
 * When it can, this constant and `fetchJobRows` collapse into one call to it.
 */
const PAGE_SELECT = '*, fit:job_fit_evaluations(*), applications(id, state, current_package_id), feedback:job_feedback(verdict, created_at), warm_paths(count)'

export interface CensusFilters {
  status?: string[]
  disposition?: string[]
  tier?: number[]
  role_family?: string[]
  minFit?: number
  search?: string
}

export type InboxSort = 'best' | 'fit' | 'recent' | 'deadline'
export type InboxView = 'all' | 'needs_look'

export interface ScoredJob {
  id: string
  relevance: InboxRelevance
  /** Has the Job Extractor stored this posting's fields? Drives the card's "listing only" copy. */
  extracted: boolean
  /** Has ANY model read the posting — extractor or fit evaluator? Drives the "needs a look" queue. */
  read: boolean
  key: number
}

export interface InboxOrdering {
  /** Every posting matching the non-relevance filters, with its band. The header's source of truth. */
  counts: RelevanceCounts
  /** How many survive the relevance filter and the view — the number the header says it is showing. */
  matched: number
  /**
   * Why every other posting is off the screen, one bucket per row. Sums to
   * `counts.total − matched` by construction; the header prints it verbatim.
   */
  hidden: HiddenGroup[]
  /** Those, in display order. */
  ids: string[]
  /** Relevance by job id, so the page's cards carry exactly what was counted. */
  byId: Map<string, ScoredJob>
  /** Set when the census hit its ceiling, so the header can stop claiming a total it did not see. */
  truncated: boolean
  error: string | null
}

/** One census row. Exported so the offline suite can build the whole ordering from fixtures. */
export interface CensusRow {
  id: string
  title: string
  company_name: string | null
  role_family: string | null
  industry: string | null
  skills: string[] | null
  location_tier: number | null
  employment_type: string | null
  season_relevance: string | null
  extraction_version: string | null
  fit_overall: number | null
  deadline: string | null
  first_seen_at: string | null
  last_seen_at: string | null
}

/** A literal string inside a PostgREST `or(...)` filter — the same defensive trim `listJobs` applies. */
function safeSearch(s: string): string {
  return s.replace(/[%,()]/g, ' ').trim()
}

/**
 * Score the whole inventory and decide what this page shows.
 *
 * One query, no embedded rows, no model. Everything the header claims comes
 * from here, so it is always about the same set the list is drawn from.
 */
export async function orderInbox(
  db: Db,
  userId: string,
  ctx: RelevanceContext,
  filters: CensusFilters,
  opts: { relevance: RelevanceFilter; view: InboxView; sort: InboxSort }
): Promise<InboxOrdering> {
  const empty: RelevanceCounts = { total: 0, strong: 0, possible: 0, off: 0, needsLook: 0 }
  const failed = (message: string): InboxOrdering => ({ counts: empty, matched: 0, hidden: [], ids: [], byId: new Map(), truncated: false, error: message })
  let q = db.from('job_opportunities').select(CENSUS_COLUMNS).eq('user_id', userId).eq('is_canonical', true)
  if (filters.status?.length) q = q.in('verification_status', filters.status)
  if (filters.disposition?.length) q = q.in('disposition', filters.disposition)
  if (filters.tier?.length) q = q.in('location_tier', filters.tier)
  if (filters.role_family?.length) q = q.in('role_family', filters.role_family)
  if (filters.minFit !== undefined) q = q.gte('fit_overall', filters.minFit)
  if (filters.search) {
    const s = safeSearch(filters.search)
    // Search reaches the whole inventory, not the page: it runs in the census.
    if (s) q = q.or(`title.ilike.%${s}%,company_name.ilike.%${s}%`)
  }
  const { data, error } = await q.order('first_seen_at', { ascending: false }).limit(CENSUS_CEILING)
  if (error) return failed(error.message)

  const rows = (data ?? []) as unknown as CensusRow[]
  return { ...rankAndFilter(rows, ctx, opts), truncated: rows.length >= CENSUS_CEILING, error: null }
}

/**
 * The whole ordering, as a pure function of the census rows.
 *
 * Split out from the query so the offline suite exercises exactly what the
 * route runs — counting, filtering and ranking are where an inbox lies to its
 * operator, and a test that reimplements them proves nothing.
 */
export function rankAndFilter(
  rows: CensusRow[],
  ctx: RelevanceContext,
  opts: { relevance: RelevanceFilter; view: InboxView; sort: InboxSort }
): Omit<InboxOrdering, 'truncated' | 'error'> {
  const scored: (ScoredJob & { row: CensusRow })[] = rows.map((row) => {
    const relevance = scoreRelevance(row, ctx)
    return {
      id: row.id,
      relevance,
      extracted: !!row.extraction_version,
      // A fit evaluation means a model read the posting even when the extractor
      // never stored its fields, so it counts as read for the queue.
      read: !!row.extraction_version || row.fit_overall != null,
      key: bestFirstKey(row, relevance),
      row,
    }
  })

  const counts = relevanceCounts(scored)
  let shown = scored.filter((s) => passesRelevance(s.relevance.band, opts.relevance))
  // "Needs a look" is a queue, not a filter on top of a filter: relevant
  // postings nobody — no model, no person — has read yet.
  if (opts.view === 'needs_look') shown = shown.filter((s) => !s.read && s.relevance.band !== 'off')

  shown.sort(comparatorFor(opts.sort))

  const shownIds = new Set(shown.map((s) => s.id))
  return {
    counts,
    // The list itself, counted. Deriving this from the relevance filter alone
    // was how the header claimed to be "showing all 7 strong" while displaying
    // a different 7 — the view had narrowed the list and the arithmetic had not
    // heard about it.
    matched: shown.length,
    hidden: hiddenGroups(scored, shownIds, opts),
    ids: shown.map((s) => s.id),
    byId: new Map(scored.map((s) => [s.id, { id: s.id, relevance: s.relevance, extracted: s.extracted, read: s.read, key: s.key }])),
  }
}

/**
 * Every posting that is NOT on the screen, sorted into exactly one reason.
 *
 * Written as a partition rather than as a sum of filter effects, so the groups
 * cannot drift out of step with what was actually removed: each hidden row
 * increments one counter, and `filtered` catches anything a future narrowing
 * introduces without saying so. The invariant the header depends on — the
 * groups total `counts.total − matched` — then holds by construction.
 */
function hiddenGroups(
  scored: { id: string; relevance: InboxRelevance; read: boolean }[],
  shownIds: Set<string>,
  opts: { relevance: RelevanceFilter; view: InboxView }
): HiddenGroup[] {
  let off = 0
  let possible = 0
  let read = 0
  let other = 0
  for (const s of scored) {
    if (shownIds.has(s.id)) continue
    if (s.relevance.band === 'off') off++
    else if (!passesRelevance(s.relevance.band, opts.relevance)) possible++
    else if (opts.view === 'needs_look' && s.read) read++
    else other++
  }
  const out: HiddenGroup[] = []
  if (off) out.push({ label: 'off-direction', count: off })
  if (possible) out.push({ label: 'possible', count: possible })
  if (read) out.push({ label: 'already read', count: read })
  if (other) out.push({ label: 'filtered', count: other })
  return out
}

/** Nulls always last, whichever direction the column sorts. An unset deadline is not "soonest". */
function nullsLast(a: string | null, b: string | null, ascending: boolean): number {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  return ascending ? a.localeCompare(b) : b.localeCompare(a)
}

function comparatorFor(sort: InboxSort) {
  return (a: ScoredJob & { row: CensusRow }, b: ScoredJob & { row: CensusRow }): number => {
    if (sort === 'recent') return nullsLast(a.row.first_seen_at, b.row.first_seen_at, false) || b.key - a.key
    if (sort === 'deadline') return nullsLast(a.row.deadline, b.row.deadline, true) || b.key - a.key
    if (sort === 'fit') {
      const fa = a.row.fit_overall ?? -1
      const fb = b.row.fit_overall ?? -1
      return fb - fa || b.key - a.key
    }
    // 'best': band, then fit-where-known, then relevance, then newest.
    return b.key - a.key || b.relevance.score - a.relevance.score || nullsLast(a.row.first_seen_at, b.row.first_seen_at, false)
  }
}

/**
 * Full rows for exactly these ids, returned in the order asked for.
 *
 * PostgREST's `in` answers in its own order, so the ordering computed above is
 * reapplied here — a page that came back sorted by insertion time would silently
 * undo the ranking the header just described.
 */
export async function fetchJobRows(db: Db, userId: string, ids: string[]): Promise<{ rows: JobListRow[]; error: string | null }> {
  if (ids.length === 0) return { rows: [], error: null }
  const { data, error } = await db.from('job_opportunities').select(PAGE_SELECT).eq('user_id', userId).in('id', ids)
  if (error) return { rows: [], error: error.message }
  const byId = new Map((data ?? []).map((r) => [(r as { id: string }).id, r as unknown as JobListRow]))
  const rows: JobListRow[] = []
  for (const id of ids) {
    const row = byId.get(id)
    if (row) rows.push(row)
  }
  return { rows, error: null }
}
