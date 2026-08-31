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

const COLUMNS =
  'id, user_id, kind, label, status, stage, progress, params, claim_token, heartbeat_at, worker_started_at, started_at, completed_at, stats, error, career_mission_id'

export function liveRunStoreDb(db = createServiceClient()): RunStoreDb {
  return {
    async insertRun(row) {
      const { data, error } = await db.from('scouting_runs').insert(row as never).select(COLUMNS).single()
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
      const { data, error } = await q.select(COLUMNS)
      if (error) return { rows: [], error: error.message }
      return { rows: (data ?? []) as unknown as ScoutRunRow[], error: null }
    },
    async getRun(id, userId = null) {
      let q = db.from('scouting_runs').select(COLUMNS).eq('id', id)
      if (userId) q = q.eq('user_id', userId)
      const { data, error } = await q.maybeSingle()
      if (error) return { row: null, error: error.message }
      return { row: (data as unknown as ScoutRunRow | null) ?? null, error: null }
    },
    async listRuns(userId, statuses, limit) {
      const { data, error } = await db
        .from('scouting_runs')
        .select(COLUMNS)
        .eq('user_id', userId)
        .in('status', statuses)
        .order('started_at', { ascending: false })
        .limit(limit)
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
