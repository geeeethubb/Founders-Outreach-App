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

import { isMissingSchema } from '@/lib/career/jobs/db'
import { DEFAULT_STALE_MS, isRunStale, readProgress, type ScoutRunProgress } from './run-record'
import { liveRunStoreDb, type RunStoreDb } from './run-store-db'
import { resetProgressCache } from './run-store'

export interface ReapResult {
  reaped: { runId: string; status: 'partial' | 'failed'; jobs: number }[]
  migrationMissing: boolean
  error: string | null
}

/**
 * A REAL write, and idempotent by construction: the update is guarded on
 * `status = 'running'`, so a second pass matches nothing.
 *
 * It is also patient — see `isRunStale`: a run inside the deadline it was
 * claimed with is left alone however quiet it is, because a healthy scout is
 * silent for minutes at a time. A run that stored jobs before dying is
 * 'partial' (it produced value and the Jobs page should show it); one that
 * stored nothing is 'failed'. The reap is stamped in `progress.reaped_at`, so
 * a worker that turns up afterwards with the real outcome can correct it
 * (`finishScoutRun`) instead of being refused by the terminal-status guard.
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
    // Scout runs only. A package or verify run in the same table has no
    // heartbeat and is nobody's business here.
    if (row.kind && row.kind !== 'job_scout') continue
    if (!isRunStale(row, staleMs, now, { deadlineMs: opts.deadlineMs })) continue
    const { counts } = await db.countJobs(row.id, userId)
    const status: 'partial' | 'failed' = counts.total > 0 ? 'partial' : 'failed'
    const quietFor = Math.round((now - Date.parse(String(row.heartbeat_at ?? row.started_at ?? new Date(now).toISOString()))) / 1000)
    const message = `the worker stopped responding (no heartbeat for ${quietFor}s, past this run's deadline)${counts.total > 0 ? ` — ${counts.total} job(s) from this run were saved` : ''}`
    const progress: ScoutRunProgress = { ...readProgress(row), reaped_at: new Date(now).toISOString() }
    const res = await db.patchRun(
      row.id,
      { status, completed_at: new Date(now).toISOString(), claim_token: null, progress, error: row.error ? `${row.error}; ${message}` : message },
      { status: 'running' }
    )
    if (res.error) return { reaped, migrationMissing: isMissingSchema(res.error), error: res.error }
    if (res.rows.length > 0) {
      resetProgressCache(row.id)
      reaped.push({ runId: row.id, status, jobs: counts.total })
    }
  }
  return { reaped, migrationMissing: false, error: null }
}
