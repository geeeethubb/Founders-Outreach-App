// Closing the runs nobody else will close.
//
// A worker can die without finishing its row — Vercel kills the function, the
// laptop sleeps, the process is Ctrl-C'd. Nothing in the state machine next
// door (run-store.ts) would ever move that row off 'running', so the Jobs page
// would poll a corpse forever.
//
// This is its own file because it is a POLICY, not a transition: it decides,
// on incomplete information, that a run is dead. Getting that decision wrong
// in either direction is expensive — declare a healthy run dead and the screen
// says "the worker stopped responding" for a run that is still working, which
// is how an operator learns to ignore the status; never declare anything dead
// and the page shows a spinner that outlives the laptop. The test it uses
// (`isRunStale`) is the same one the UI uses, so the two can never disagree.
//
// It closes every KIND that can be stuck: both scouts (leased, or pulseless
// legacy rows), package, verify and import runs written inline by a request
// that ended before they did. A reap is FENCED on the worker id the row carries
// (when it has one), so a worker that revives cannot keep writing over it.

import { isMissingSchema } from '@/lib/career/jobs/db'
import { invocationBudgetMs } from '@/lib/runs/deadline'
import { scoutError, toRowError, type ScoutErrorCode } from '@/lib/runs/errors'
import { scoutLog } from '@/lib/runs/log'
import { DEFAULT_STALE_MS, isRunStale, readProgress, type ScoutRunProgress, type ScoutRunRow } from './run-record'
import { liveRunStoreDb, type RunStoreDb } from './run-store-db'
import { resetProgressCache } from './run-store'

export interface ReapResult {
  reaped: { runId: string; status: 'partial' | 'failed'; jobs: number; errorCode: ScoutErrorCode }[]
  migrationMissing: boolean
  error: string | null
}

/**
 * A worker that died THIS early into a leg it had planned to run much longer
 * was not slow — something ended it. Below this share of the planned leg, the
 * reaper says PLATFORM_KILL (a lower function ceiling than assumed, an
 * out-of-memory kill) instead of "stopped responding", so the founder reads a
 * cause and not a mystery.
 */
export const EARLY_KILL_SHARE = 0.5

function observedLifetime(row: ScoutRunRow): { observedMs: number | null; plannedMs: number | null } {
  const started = Date.parse(String(row.worker_started_at ?? row.claimed_at ?? ''))
  const beat = Date.parse(String(row.heartbeat_at ?? ''))
  const deadline = Date.parse(String(readProgress(row).deadline_at ?? ''))
  const observedMs = Number.isFinite(started) && Number.isFinite(beat) ? Math.max(0, beat - started) : null
  const plannedMs = Number.isFinite(started) && Number.isFinite(deadline) ? Math.max(0, deadline - started) : null
  return { observedMs, plannedMs }
}

/**
 * A REAL write, and idempotent by construction: the update is guarded on
 * `status = 'running'` (and on the worker id the row carries), so a second
 * pass matches nothing.
 *
 * It is also patient where patience is warranted — see `isRunStale`: a
 * leased run is dead once its lease lapses; a lease-less run inside the
 * deadline it was claimed with is left alone however quiet it is. A run that
 * stored jobs (or prospects) before dying is 'partial' (it produced value and
 * the page should show it); one that stored nothing is 'failed'. The reap is
 * stamped in `progress.reaped_at`, so a worker that turns up afterwards with
 * the real outcome can correct it (`finishScoutRun`) instead of being refused
 * by the terminal-status guard.
 */
export async function reapStaleRuns(
  userId: string,
  opts: { staleMs?: number; now?: number; db?: RunStoreDb; deadlineMs?: number } = {}
): Promise<ReapResult> {
  const db = opts.db ?? liveRunStoreDb()
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS
  const now = opts.now ?? Date.now()
  const { rows, error } = await db.listRuns(userId, ['running'], 20)
  if (error) return { reaped: [], migrationMissing: isMissingSchema(error), error }

  const reaped: ReapResult['reaped'] = []
  for (const row of rows) {
    if (!isRunStale(row, staleMs, now, { deadlineMs: opts.deadlineMs ?? invocationBudgetMs() })) continue
    // A row with no kind predates migration 014 and was a job scout in every
    // reader's convention; the database itself defaults new rows to 'outreach'.
    const kind = row.kind ?? 'job_scout'
    const { counts } = kind === 'job_scout' && typeof db.countJobs === 'function' ? await db.countJobs(row.id, userId) : { counts: { total: 0 } }
    // A People Scout's value is its persisted result; a Job Scout's is its rows.
    // `listRuns` deliberately leaves the heavy columns out, so the candidate
    // is re-read in full before the verdict: reaping is rare, and closing a
    // run as failed while hiding the prospects it paid for is not allowed.
    let hasResult = false
    if (kind === 'outreach') {
      const full = await db.getRun(row.id, null, { full: true })
      hasResult = Boolean(full.row?.result)
    }
    const produced = counts.total > 0 || hasResult
    const status: 'partial' | 'failed' = produced ? 'partial' : 'failed'

    const { observedMs, plannedMs } = observedLifetime(row)
    const killedEarly = observedMs !== null && plannedMs !== null && plannedMs > 0 && observedMs < plannedMs * EARLY_KILL_SHARE && Boolean(row.lease_expires_at)
    const quietFor = Math.round((now - Date.parse(String(row.heartbeat_at ?? row.started_at ?? new Date(now).toISOString()))) / 1000)
    const pulseless = !row.heartbeat_at
    const message = pulseless
      ? `this run was executed inside a request that ended before the run did (no heartbeat, ${Math.round((now - Date.parse(String(row.started_at ?? new Date(now).toISOString()))) / 60_000)} min old)`
      : killedEarly
        ? `the worker was ended by the platform after ${Math.round((observedMs ?? 0) / 1000)}s of a ${Math.round((plannedMs ?? 0) / 1000)}s pass (no heartbeat for ${quietFor}s)`
        : `the worker stopped responding (no heartbeat for ${quietFor}s, past this run's lease)`
    const withValue = counts.total > 0 ? ` — ${counts.total} job(s) from this run were saved` : hasResult ? ' — the prospects it found are kept' : ''
    const err = scoutError(killedEarly ? 'PLATFORM_KILL' : 'RUN_DEADLINE', `${message}${withValue}`, {
      stage: readProgress(row).stage ?? null,
      retryable: true,
    })
    const rowErr = toRowError(err)
    const progress: ScoutRunProgress = { ...readProgress(row), reaped_at: new Date(now).toISOString() }
    const patch: Record<string, unknown> = {
      status,
      completed_at: new Date(now).toISOString(),
      claim_token: null,
      worker_id: null,
      lease_expires_at: null,
      progress,
      error: row.error ? `${row.error}; ${rowErr.error}` : rowErr.error,
      error_code: rowErr.error_code,
      error_detail: { ...rowErr.error_detail, observed_ms: observedMs, planned_ms: plannedMs, reaped: true },
      last_error: rowErr.error,
    }
    const guard: Record<string, unknown> = row.worker_id ? { status: 'running', worker_id: row.worker_id } : { status: 'running' }
    let res = await db.patchRun(row.id, patch, guard)
    if (res.error && isMissingSchema(res.error)) {
      // Older schema: the columns that matter are status and the sentence.
      res = await db.patchRun(row.id, { status, completed_at: new Date(now).toISOString(), claim_token: null, progress, error: patch.error }, guard)
    }
    if (res.error) return { reaped, migrationMissing: isMissingSchema(res.error), error: res.error }
    if (res.rows.length > 0) {
      resetProgressCache(row.id)
      reaped.push({ runId: row.id, status, jobs: counts.total, errorCode: rowErr.error_code })
      scoutLog(
        { run_id: row.id, scout_kind: kind === 'outreach' ? 'people' : kind === 'job_scout' ? 'jobs' : kind, event: 'reaped', terminal_status: status, error_code: rowErr.error_code, observed_ms: observedMs, planned_ms: plannedMs, detail: rowErr.error },
        'warn'
      )
    }
  }
  return { reaped, migrationMissing: false, error: null }
}
