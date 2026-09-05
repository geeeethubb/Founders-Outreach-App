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
//
// `insertRun` reports a UNIQUE VIOLATION distinctly (`conflict: true`): the
// partial unique index from migration 021 allows one active run per scout
// kind per user, so a second click lands here rather than as a second paid
// row, and the caller answers 409 with the run that is already going.
//
// MIGRATION 021 IS APPLIED BY HAND, like every migration here, so the live
// database may lack its six columns for a while. The state machine still
// needs every one of them (a leg number, a whole-run deadline, an error code,
// a checkpoint, a result), so this port gives each a fallback home inside the
// row's `params` jsonb — `params.__reliability.<column>` — the moment Postgres
// says the column does not exist, and lifts them back out on every read. The
// state machine above never knows. What a pre-021 database cannot provide is
// the INDEX: the one-active-run rule then rests on the enqueue's read-then-
// insert, and readiness says so.

import { runJobSummary } from '@/lib/career/jobs/run-results'
import { createServiceClient } from '@/lib/supabase/server'
import { emptyJobCounts, type RunJobCounts, type ScoutRunRow } from './run-record'

export interface RunStoreDb {
  insertRun(row: Record<string, unknown>): Promise<{ row: ScoutRunRow | null; error: string | null; conflict?: boolean }>
  /** Returns the rows the guard MATCHED — an empty array means "somebody else got there first". */
  patchRun(
    id: string,
    patch: Record<string, unknown>,
    guard?: Record<string, unknown>
  ): Promise<{ rows: ScoutRunRow[]; error: string | null }>
  /** `full` also selects the heavy columns (checkpoint, result) — for the worker's claim and the result endpoint, never for a poll. */
  getRun(id: string, userId?: string | null, opts?: { full?: boolean }): Promise<{ row: ScoutRunRow | null; error: string | null }>
  /** `kinds` narrows in the database — a page of five rows must not be filled by the wrong kind. */
  listRuns(userId: string, statuses: string[], limit: number, kinds?: string[]): Promise<{ rows: ScoutRunRow[]; error: string | null }>
  countJobs(runId: string, userId: string): Promise<{ counts: RunJobCounts; error: string | null }>
}

// Migration 020's and 021's columns are appended in later lists. They are
// selected when the database has them and dropped when it does not, because
// the queue watchdog has to work on the rows that are stuck right now — asking
// for a column that does not exist fails the whole select, which would blind
// the watchdog to exactly the runs it exists to rescue.
const BASE_COLUMNS =
  'id, user_id, kind, label, status, stage, progress, params, claim_token, heartbeat_at, worker_started_at, started_at, completed_at, stats, error, career_mission_id'
const QUEUE_COLUMNS = 'queued_at, claimed_at, attempt_count, last_dispatch_at, worker_id, lease_expires_at, cancel_requested, last_error'
const RELIABILITY_COLUMNS = 'error_code, error_detail, invocation_count, run_deadline_at'
// The heavy columns. A People Scout's checkpoint and result are tens of
// kilobytes; the 3-second poll must not carry them, so they are selected only
// on request (the worker's claim, the result endpoint).
const HEAVY_COLUMNS = 'checkpoint, result'
const COLUMNS = `${BASE_COLUMNS}, ${QUEUE_COLUMNS}, ${RELIABILITY_COLUMNS}`
const COLUMNS_FULL = `${COLUMNS}, ${HEAVY_COLUMNS}`
const COLUMNS_020 = `${BASE_COLUMNS}, ${QUEUE_COLUMNS}`

/** The columns migration 021 adds, and their fallback home before it is applied. */
export const RELIABILITY_FIELDS = ['error_code', 'error_detail', 'invocation_count', 'run_deadline_at', 'checkpoint', 'result'] as const
export const FALLBACK_KEY = '__reliability'

/** Postgres unique-violation, as PostgREST reports it. */
function isUniqueViolation(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  return error.code === '23505' || /duplicate key value|violates unique constraint/i.test(error.message ?? '')
}

/** Which column PostgREST says is missing, or null. */
function missingColumn(error: { message?: string } | null): string | null {
  if (!error?.message) return null
  const m = error.message.match(/Could not find the '(\w+)' column|column (?:\w+\.)?"?(\w+)"? does not exist/i)
  return m ? (m[1] ?? m[2] ?? null) : null
}

function isReliabilityField(name: string | null): boolean {
  return !!name && (RELIABILITY_FIELDS as readonly string[]).includes(name)
}

/** Split a patch into what every database has and what only a 021 database has. */
export function splitReliabilityFields(patch: Record<string, unknown>): { base: Record<string, unknown>; extra: Record<string, unknown> } {
  const base: Record<string, unknown> = {}
  const extra: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) {
    if ((RELIABILITY_FIELDS as readonly string[]).includes(k)) extra[k] = v
    else base[k] = v
  }
  return { base, extra }
}

/** Fold 021 fields into `params.__reliability` on top of the row's existing params. */
export function foldReliabilityFields(params: unknown, extra: Record<string, unknown>): Record<string, unknown> {
  const p = params && typeof params === 'object' && !Array.isArray(params) ? (params as Record<string, unknown>) : {}
  const prior = p[FALLBACK_KEY] && typeof p[FALLBACK_KEY] === 'object' ? (p[FALLBACK_KEY] as Record<string, unknown>) : {}
  return { ...p, [FALLBACK_KEY]: { ...prior, ...extra } }
}

/** Lift folded 021 fields back onto the row wherever the real column is absent. */
export function liftReliabilityFields<T extends { params?: unknown }>(row: T): T {
  const p = row.params && typeof row.params === 'object' && !Array.isArray(row.params) ? (row.params as Record<string, unknown>) : null
  const folded = p?.[FALLBACK_KEY] && typeof p[FALLBACK_KEY] === 'object' ? (p[FALLBACK_KEY] as Record<string, unknown>) : null
  if (!folded) return row
  const out = row as unknown as Record<string, unknown>
  for (const k of RELIABILITY_FIELDS) if (out[k] === undefined && folded[k] !== undefined) out[k] = folded[k]
  return row
}

export function liveRunStoreDb(db = createServiceClient()): RunStoreDb {
  // Learned once per process: after the first "column does not exist" every
  // later write folds straight away instead of paying a failed round trip.
  let missing021 = false

  const applyGuard = <Q extends { eq(k: string, v: string): Q; is(k: string, v: null): Q; in(k: string, v: string[]): Q }>(q: Q, guard: Record<string, unknown>): Q => {
    for (const [k, v] of Object.entries(guard)) {
      if (v === null) q = q.is(k, null)
      else if (Array.isArray(v)) q = q.in(k, v as string[])
      else q = q.eq(k, v as string)
    }
    return q
  }
  const lift = (rows: unknown[]): ScoutRunRow[] => (rows as ScoutRunRow[]).map((r) => liftReliabilityFields(r))

  return {
    async insertRun(row) {
      // BASE_COLUMNS deliberately, not COLUMNS. A fresh row's later fields are
      // all defaults the caller does not read, and selecting them here would
      // fail the whole insert on an older database — which broke "Scout now"
      // outright until the acceptance run caught it. There is no safe retry
      // either: the id is server-generated, so a failed select cannot be
      // turned into a lookup, and re-inserting would duplicate the run.
      const attempt = async (r: Record<string, unknown>) => db.from('scouting_runs').insert(r as never).select(BASE_COLUMNS).single()
      const { base, extra } = splitReliabilityFields(row)
      let { data, error } = missing021 ? await attempt({ ...base, params: foldReliabilityFields(base.params, extra) }) : await attempt(row)
      if (error && !missing021 && isReliabilityField(missingColumn(error))) {
        missing021 = true
        ;({ data, error } = await attempt({ ...base, params: foldReliabilityFields(base.params, extra) }))
      }
      if (error) return { row: null, error: error.message, conflict: isUniqueViolation(error) }
      return { row: liftReliabilityFields(data as unknown as ScoutRunRow), error: null }
    },
    async patchRun(id, patch, guard = {}) {
      const run = async (p: Record<string, unknown>, cols: string) => {
        const q = applyGuard(db.from('scouting_runs').update(p as never).eq('id', id), guard)
        return q.select(cols)
      }
      const foldPatch = async (p: Record<string, unknown>): Promise<Record<string, unknown>> => {
        const { base, extra } = splitReliabilityFields(p)
        if (Object.keys(extra).length === 0) return base
        // The fallback lives in params, and params must be merged, not
        // replaced: read the row's current params (the guard still decides
        // whether the write lands).
        const current = await db.from('scouting_runs').select('params').eq('id', id).maybeSingle()
        const params = base.params !== undefined ? base.params : (current.data as { params?: unknown } | null)?.params
        return { ...base, params: foldReliabilityFields(params, extra) }
      }
      let p = missing021 ? await foldPatch(patch) : patch
      let cols = missing021 ? COLUMNS_020 : COLUMNS
      let { data, error } = await run(p, cols)
      if (error && !missing021 && isReliabilityField(missingColumn(error))) {
        missing021 = true
        p = await foldPatch(patch)
        cols = COLUMNS_020
        ;({ data, error } = await run(p, cols))
      }
      // Fall back column list by column list for older databases still. The
      // update itself is idempotent, so repeating it is safe; what must not
      // happen is a caller reading `rows: []` — that means "somebody else got
      // there first" and would make a live run look claimed by another worker.
      if (error) ({ data, error } = await run(p, COLUMNS_020))
      if (error) ({ data, error } = await run(p, BASE_COLUMNS))
      if (error) return { rows: [], error: error.message }
      return { rows: lift((data ?? []) as unknown[]), error: null }
    },
    async getRun(id, userId = null, opts = {}) {
      const read = async (cols: string) => {
        let q = db.from('scouting_runs').select(cols).eq('id', id)
        if (userId) q = q.eq('user_id', userId)
        return q.maybeSingle()
      }
      let { data, error } = missing021 ? await read(COLUMNS_020) : await read(opts.full ? COLUMNS_FULL : COLUMNS)
      if (error && !missing021 && isReliabilityField(missingColumn(error))) missing021 = true
      if (error && opts.full && !missing021) ({ data, error } = await read(COLUMNS))
      if (error) ({ data, error } = await read(COLUMNS_020))
      if (error) ({ data, error } = await read(BASE_COLUMNS))
      if (error) return { row: null, error: error.message }
      const row = (data as unknown as ScoutRunRow | null) ?? null
      return { row: row ? liftReliabilityFields(row) : null, error: null }
    },
    async listRuns(userId, statuses, limit, kinds) {
      const read = (cols: string) => {
        let q = db.from('scouting_runs').select(cols).eq('user_id', userId).in('status', statuses)
        if (kinds && kinds.length) q = q.in('kind', kinds)
        return q.order('started_at', { ascending: false }).limit(limit)
      }
      let { data, error } = missing021 ? await read(COLUMNS_020) : await read(COLUMNS)
      if (error && !missing021 && isReliabilityField(missingColumn(error))) missing021 = true
      if (error) ({ data, error } = await read(COLUMNS_020))
      if (error) ({ data, error } = await read(BASE_COLUMNS))
      if (error) return { rows: [], error: error.message }
      return { rows: lift((data ?? []) as unknown[]), error: null }
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
