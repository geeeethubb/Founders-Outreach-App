// What one scouting run found — the single answer to "what did that run do?".
//
// Two tables can answer it, and they answer differently:
//
//   `job_opportunities.discovery_run_id` names the run that first INSERTED a
//   job. A run that re-found ten live postings therefore looked like it found
//   nothing, which is exactly the report the founder does not want.
//
//   `scouting_run_jobs` (migration 016) records every job a run TOUCHED, with
//   `inserted` saying which of them were new.
//
// Both are read and unioned here, so this is correct before migration 016 is
// applied (under-reporting re-seen postings, never failing) and complete after
// it. Nothing in this file judges anything — it counts what the run stored.

import { createServiceClient } from '@/lib/supabase/server'
import { isMissingSchema, type Db } from './db'

/**
 * The most job ids one PostgREST `in(...)` may carry.
 *
 * The filter travels in the URL — `id=in.(<uuid>,<uuid>,…)`, ~37 bytes per id —
 * so the ceiling is a request-size budget, not a taste: 250 ids is a ~9 KB query
 * string, comfortably inside the 16 KB an HTTP gateway typically allows, while
 * 500 would be ~19 KB and could be refused outright. A refused request shows the
 * founder nothing; a capped one shows 250 results and says how many it left out.
 *
 * Chosen here rather than inherited from PostgREST's max-rows, and `truncated`
 * reports whatever a run touched beyond it.
 */
export const MAX_RUN_JOB_IDS = 250
/** Bytes one id costs in the URL: 36 for the uuid, one for the separator. */
export const RUN_JOB_ID_URL_BYTES = 37

export interface RunJobIds {
  ids: string[]
  inserted: Set<string>
  /** Where the answer came from — the 016 table, the legacy column, or both. */
  source: 'run_jobs' | 'discovery_run_id' | 'both' | 'none'
  /**
   * Jobs this run touched beyond `MAX_RUN_JOB_IDS`, dropped from `ids`. Read
   * from PostgREST's exact count, so it is the real overflow and not a page
   * boundary. The two sources overlap, so the larger overflow is reported
   * rather than their sum — never an inflated number.
   */
  truncated: number
  /** Set when the 016 table is absent: the answer is the legacy one, and says so. */
  note: string | null
  error: string | null
}

/**
 * Every job a run touched, newest link first, capped at `MAX_RUN_JOB_IDS`.
 */
export async function runJobIds(userId: string, runId: string, db: Db = createServiceClient()): Promise<RunJobIds> {
  const ids = new Set<string>()
  const inserted = new Set<string>()
  let fromLinks = 0
  let fromLegacy = 0
  let overflowLinks = 0
  let overflowLegacy = 0
  let note: string | null = null
  let error: string | null = null

  const link = await db.from('scouting_run_jobs').select('job_id, inserted', { count: 'exact' }).eq('user_id', userId).eq('run_id', runId).limit(MAX_RUN_JOB_IDS)
  if (link.error) {
    if (isMissingSchema(link.error.message)) note = 'run results fall back to discovery_run_id — apply migration 016'
    else error = link.error.message
  } else {
    const rows = (link.data ?? []) as { job_id: string; inserted: boolean }[]
    for (const r of rows) {
      ids.add(r.job_id)
      if (r.inserted) inserted.add(r.job_id)
      fromLinks++
    }
    overflowLinks = Math.max(0, (link.count ?? rows.length) - rows.length)
  }

  const legacy = await db.from('job_opportunities').select('id', { count: 'exact' }).eq('user_id', userId).eq('discovery_run_id', runId).limit(MAX_RUN_JOB_IDS)
  if (legacy.error) {
    if (!isMissingSchema(legacy.error.message) && !error) error = legacy.error.message
  } else {
    const rows = (legacy.data ?? []) as { id: string }[]
    for (const r of rows) {
      if (!ids.has(r.id) && ids.size >= MAX_RUN_JOB_IDS) {
        overflowLegacy++
        continue
      }
      ids.add(r.id)
      inserted.add(r.id)
      fromLegacy++
    }
    overflowLegacy += Math.max(0, (legacy.count ?? rows.length) - rows.length)
  }

  const source: RunJobIds['source'] = fromLinks && fromLegacy ? 'both' : fromLinks ? 'run_jobs' : fromLegacy ? 'discovery_run_id' : 'none'
  return { ids: [...ids], inserted, source, truncated: Math.max(overflowLinks, overflowLegacy), note, error }
}

export interface RunJobSummary {
  /** Every job the run touched — not the size of a page of them. */
  total: number
  inserted: number
  verified_open: number
  likely_open: number
  unverified: number
  closed: number
  ranked: number
  unranked: number
  /** Jobs beyond `MAX_RUN_JOB_IDS`, counted in `total` but absent from the detail. */
  truncated: number
  source: RunJobIds['source']
  note: string | null
  rejected_note?: string
  error: string | null
}

const EMPTY: RunJobSummary = {
  total: 0, inserted: 0, verified_open: 0, likely_open: 0, unverified: 0, closed: 0,
  ranked: 0, unranked: 0, truncated: 0, source: 'none', note: null, error: null,
}

/**
 * The header of a run's results: what it found, how much of it was new, how
 * confident we are that the postings are open, and how much has been ranked.
 */
export async function runJobSummary(userId: string, runId: string, db: Db = createServiceClient()): Promise<RunJobSummary> {
  const link = await runJobIds(userId, runId, db)
  const base = { ...EMPTY, source: link.source, note: link.note, truncated: link.truncated, error: link.error }
  if (link.ids.length === 0) return { ...base, ...(await rejectedNote(db, userId, runId)) }

  const { data, error } = await db.from('job_opportunities').select('id, verification_status, fit_overall').eq('user_id', userId).in('id', link.ids)
  if (error) return { ...base, total: link.ids.length + link.truncated, inserted: link.inserted.size, error: error.message }

  const rows = (data ?? []) as { id: string; verification_status: string | null; fit_overall: number | null }[]
  const count = (s: string) => rows.filter((r) => r.verification_status === s).length
  const ranked = rows.filter((r) => r.fit_overall != null).length
  return {
    ...base,
    total: rows.length + link.truncated,
    inserted: rows.filter((r) => link.inserted.has(r.id)).length,
    verified_open: count('VERIFIED_OPEN'),
    likely_open: count('LIKELY_OPEN'),
    unverified: count('UNVERIFIED'),
    closed: count('CLOSED'),
    ranked,
    unranked: rows.length - ranked,
    ...(await rejectedNote(db, userId, runId)),
  }
}

/** "4 postings rejected — Internships only ×3, United States ×1", when the run said so. */
async function rejectedNote(db: Db, userId: string, runId: string): Promise<{ rejected_note?: string }> {
  const { data, error } = await db.from('scouting_runs').select('stats').eq('user_id', userId).eq('id', runId).limit(1).maybeSingle()
  if (error || !data) return {}
  const stats = (data as { stats?: Record<string, unknown> | null }).stats
  const rejected = stats && typeof stats === 'object' ? (stats as Record<string, unknown>).jobs_rejected : null
  if (!rejected || typeof rejected !== 'object') return {}
  const entries = Object.entries(rejected as Record<string, unknown>)
    .map(([k, v]) => [k, Number(v)] as const)
    .filter(([, v]) => Number.isFinite(v) && v > 0)
    .sort((a, b) => b[1] - a[1])
  if (!entries.length) return {}
  const total = entries.reduce((a, [, v]) => a + v, 0)
  return { rejected_note: `${total} posting${total === 1 ? '' : 's'} rejected — ${entries.map(([k, v]) => `${k} ×${v}`).join(', ')}` }
}
