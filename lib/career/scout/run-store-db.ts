// The only database surface the durable-run state machine uses.
//
// Five methods, one interface, so the offline suite
// (scripts/test-career-scout-run.ts) drives the whole machine in memory with
// no Supabase and no keys — and so the state machine cannot quietly grow a
// sixth kind of query nobody tests.
//
// The one idea worth naming is `guard`: an equality (or `in`, or `is null`)
// filter applied ON TOP of the id, so a claim — "the status is still queued
// AND the token matches" — is ONE statement. Two workers cannot both win it,
// because the database, not this process, decides who matched.

import { runJobSummary } from '@/lib/career/jobs/run-results'
import { createServiceClient } from '@/lib/supabase/server'
import { emptyJobCounts, type RunJobCounts, type ScoutRunRow } from './run-record'

export interface RunStoreDb {
  insertRun(row: Record<string, unknown>): Promise<{ row: ScoutRunRow | null; error: string | null }>
  /** Returns the rows the guard MATCHED — an empty array means "somebody else got there first". */
  patchRun(
    id: string,
    patch: Record<string, unknown>,
    guard?: Record<string, unknown>
  ): Promise<{ rows: ScoutRunRow[]; error: string | null }>
  getRun(id: string, userId?: string | null): Promise<{ row: ScoutRunRow | null; error: string | null }>
  listRuns(userId: string, statuses: string[], limit: number): Promise<{ rows: ScoutRunRow[]; error: string | null }>
  countJobs(runId: string, userId: string): Promise<{ counts: RunJobCounts; error: string | null }>
}

// Migration 020's columns are appended in a SECOND list. They are selected when
// the database has them and silently dropped when it does not, because the queue
// watchdog has to work on the pre-020 rows that are stuck right now — asking for
// a column that does not exist fails the whole select, which would blind the
// watchdog to exactly the runs it exists to rescue.
const BASE_COLUMNS =
  'id, user_id, kind, label, status, stage, progress, params, claim_token, heartbeat_at, worker_started_at, started_at, completed_at, stats, error, career_mission_id'
const QUEUE_COLUMNS = 'queued_at, claimed_at, attempt_count, last_dispatch_at, worker_id, lease_expires_at, cancel_requested, last_error'
const COLUMNS = `${BASE_COLUMNS}, ${QUEUE_COLUMNS}`

export function liveRunStoreDb(db = createServiceClient()): RunStoreDb {
  return {
    async insertRun(row) {
      // BASE_COLUMNS deliberately, not COLUMNS. A fresh row's 020 fields are all
      // defaults the caller does not read, and selecting them here would fail the
      // whole insert on a pre-020 database — which broke "Scout now" outright
      // until the acceptance run caught it. There is no safe retry either: the
      // id is server-generated, so a failed select cannot be turned into a
      // lookup, and re-inserting would duplicate the run.
      const { data, error } = await db.from('scouting_runs').insert(row as never).select(BASE_COLUMNS).single()
      if (error) return { row: null, error: error.message }
      return { row: data as unknown as ScoutRunRow, error: null }
    },
    async patchRun(id, patch, guard = {}) {
      let q = db.from('scouting_runs').update(patch as never).eq('id', id)
      for (const [k, v] of Object.entries(guard)) {
        if (v === null) q = q.is(k, null)
        else if (Array.isArray(v)) q = q.in(k, v as string[])
        else q = q.eq(k, v as string)
      }
      let { data, error } = await q.select(COLUMNS)
      if (error) {
        // Re-run the guarded update returning only the base columns. The update
        // itself is idempotent, so repeating it is safe; what must not happen is
        // a caller reading `rows: []` — that means "somebody else got there
        // first" and would make a live run look claimed by another worker.
        let retry = db.from('scouting_runs').update(patch as never).eq('id', id)
        for (const [k, v] of Object.entries(guard)) {
          if (v === null) retry = retry.is(k, null)
          else if (Array.isArray(v)) retry = retry.in(k, v as string[])
          else retry = retry.eq(k, v as string)
        }
        ;({ data, error } = await retry.select(BASE_COLUMNS))
      }
      if (error) return { rows: [], error: error.message }
      return { rows: (data ?? []) as unknown as ScoutRunRow[], error: null }
    },
    async getRun(id, userId = null) {
      const read = async (cols: string) => {
        let q = db.from('scouting_runs').select(cols).eq('id', id)
        if (userId) q = q.eq('user_id', userId)
        return q.maybeSingle()
      }
      let { data, error } = await read(COLUMNS)
      if (error) ({ data, error } = await read(BASE_COLUMNS))
      if (error) return { row: null, error: error.message }
      return { row: (data as unknown as ScoutRunRow | null) ?? null, error: null }
    },
    async listRuns(userId, statuses, limit) {
      const read = (cols: string) =>
        db
          .from('scouting_runs')
          .select(cols)
          .eq('user_id', userId)
          .in('status', statuses)
          .order('started_at', { ascending: false })
          .limit(limit)
      let { data, error } = await read(COLUMNS)
      if (error) ({ data, error } = await read(BASE_COLUMNS))
      if (error) return { rows: [], error: error.message }
      return { rows: (data ?? []) as unknown as ScoutRunRow[], error: null }
    },
    // ONE owner for "what did this run find?". `runJobSummary` scopes by
    // user_id, reads `scouting_run_jobs` and unions in the legacy
    // `discovery_run_id`, so this answers before migration 016 as well as
    // after it — and it is the same count the Jobs page shows, because it is
    // literally the same function.
    async countJobs(runId, userId) {
      const s = await runJobSummary(userId, runId, db)
      return {
        counts: {
          ...emptyJobCounts(),
          total: s.total,
          inserted: s.inserted,
          verified_open: s.verified_open,
          likely_open: s.likely_open,
          unverified: s.unverified,
          closed: s.closed,
          ranked: s.ranked,
        },
        error: s.error,
      }
    },
  }
}
