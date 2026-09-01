// The thing that was missing: something that ACTS on a stuck queued run.
//
// `run-reaper.ts` already handles the "claimed and then went quiet" case. It
// cannot handle "never claimed at all", because it selects `['running']` and
// `isRunStale` returns false for anything that is not running. So the entire
// class of failure where NOTHING PICKED THE RUN UP had no recovery path, and a
// run sat queued for 328 minutes.
//
// Two rules, and the second is the one that makes the invariant true:
//
//   Past 60s queued, ask a worker again (up to MAX_START_ATTEMPTS).
//   Past 60s queued with the attempts spent, FAIL IT with a real message.
//
// The second rule is what stops "queued" from being an absorbing state. A
// watchdog that only ever retries is the same bug wearing a hat.
//
// It runs on read as well as from the cron, because the crons here are DAILY
// (vercel.json: `0 11 * * *`, `0 13 * * *`) and a founder looking at a stuck run
// should not wait until tomorrow for the system to agree with them.

import { queueVerdict, queueMessage, MAX_START_ATTEMPTS, type QueueRow } from './queue-health'
import { dispatchScoutWorker, workerBaseUrl } from './run-dispatch'
import { liveRunStoreDb, type RunStoreDb } from './run-store-db'
import { isMissingSchema } from '../evidence/store'
import type { ScoutRunProgress } from './run-record'

export interface QueueAction {
  runId: string
  action: 'redispatched' | 'failed' | 'cancelled'
  waitedMs: number
  attempt: number
  message: string
}

export interface QueueSweepResult {
  actions: QueueAction[]
  checked: number
  error: string | null
  migrationMissing: boolean
}

export interface SweepOptions {
  now?: number
  db?: RunStoreDb
  /** Injected in tests; production dispatches over HTTP. */
  dispatch?: (runId: string, token: string) => Promise<{ dispatched: boolean; error: string | null }>
  /** Resolved from request headers when the sweep runs inside a route. */
  baseUrl?: string
  limit?: number
}

/**
 * Bring every queued run of this user to a decision. Idempotent: each write is
 * conditional on the status still being 'queued', so two concurrent sweeps —
 * or a sweep racing the real worker — converge instead of fighting. The worker
 * winning is the good outcome and it wins by claiming first.
 */
export async function sweepScoutQueue(userId: string, opts: SweepOptions = {}): Promise<QueueSweepResult> {
  const db = opts.db ?? liveRunStoreDb()
  const now = opts.now ?? Date.now()
  const actions: QueueAction[] = []

  const { rows, error } = await db.listRuns(userId, ['queued'], opts.limit ?? 20)
  if (error) return { actions: [], checked: 0, error, migrationMissing: isMissingSchema(error) }

  for (const row of rows) {
    const verdict = queueVerdict(row as QueueRow, now)
    if (verdict.state === 'starting' || verdict.state === 'slow_start' || verdict.state === 'terminal') continue

    const attempt = Math.max(0, (row as QueueRow).attempt_count ?? 0)
    const waitedMs = 'waitedMs' in verdict ? verdict.waitedMs : 0
    const message = queueMessage(verdict)

    if (verdict.state === 'cancelled') {
      const done = await finishQueued(db, row.id, 'cancelled', message, now)
      if (done) actions.push({ runId: row.id, action: 'cancelled', waitedMs, attempt, message })
      log(row.id, 'cancelled', { waitedMs, attempt })
      continue
    }

    // Checked before the verdict branches, because it is true at every age: a
    // queued run with no claim token cannot satisfy the claim guard, so no
    // worker can ever start it however long we wait or however often we ask.
    if (!row.claim_token) {
      const why = 'This run was queued without a claim token, so no worker could ever start it. Retry to create a fresh run.'
      const done = await finishQueued(db, row.id, 'failed', why, now)
      if (done) actions.push({ runId: row.id, action: 'failed', waitedMs, attempt, message: 'queued without a claim token' })
      log(row.id, 'failed', { waitedMs, attempt, reason: 'no_claim_token' })
      continue
    }

    if (verdict.state === 'redispatch') {
      const token = row.claim_token
      // Count the attempt BEFORE dispatching. A dispatch that hangs must not be
      // retried for ever by a sweep that only counts successes.
      await bumpAttempt(db, row.id, attempt + 1, now)
      const send = opts.dispatch ?? ((id: string, t: string) => dispatchScoutWorker(opts.baseUrl ?? workerBaseUrl(null), id, t, { raceMs: 1_200 }))
      const d = await send(row.id, token)
      log(row.id, 'redispatched', { waitedMs, attempt: attempt + 1, ok: d.dispatched, error: d.error })
      actions.push({
        runId: row.id,
        action: 'redispatched',
        waitedMs,
        attempt: attempt + 1,
        message: d.dispatched ? message : `retry ${attempt + 1} could not reach a worker: ${d.error ?? 'no reason given'}`,
      })
      continue
    }

    if (verdict.state === 'no_worker') {
      const done = await finishQueued(db, row.id, 'failed', message, now)
      if (done) actions.push({ runId: row.id, action: 'failed', waitedMs, attempt, message })
      log(row.id, 'failed', { waitedMs, attempt, reason: 'no_worker' })
    }
  }

  return { actions, checked: rows.length, error: null, migrationMissing: false }
}

/**
 * Terminal, conditional on still being queued. If the real worker claimed the
 * run a moment ago the guard matches nothing and the worker keeps it — which is
 * exactly the resolution we want for that race.
 */
async function finishQueued(db: RunStoreDb, runId: string, status: 'failed' | 'cancelled', message: string, now: number): Promise<boolean> {
  const iso = new Date(now).toISOString()
  const progress: ScoutRunProgress = {
    stage: status,
    detail: message,
    counts: {},
    events: [{ at: iso, stage: status, detail: message }],
  }
  const full = { status, error: message, last_error: message, completed_at: iso, stage: status, claim_token: null, progress }
  const { rows, error } = await db.patchRun(runId, full, { status: 'queued' })
  if (!error) return rows.length > 0
  // Pre-020 databases have no `last_error`. Recovery matters more than the column.
  const { rows: rows2 } = await db.patchRun(
    runId,
    { status, error: message, completed_at: iso, stage: status, claim_token: null, progress },
    { status: 'queued' }
  )
  return rows2.length > 0
}

/** Best-effort: a database without `attempt_count` still gets retried, just not counted. */
async function bumpAttempt(db: RunStoreDb, runId: string, attempt: number, now: number): Promise<void> {
  const { error } = await db.patchRun(runId, { attempt_count: attempt, last_dispatch_at: new Date(now).toISOString() }, { status: 'queued' })
  if (error) await db.patchRun(runId, { heartbeat_at: new Date(now).toISOString() }, { status: 'queued' }).catch(() => undefined)
}

/** One structured line per queue event, so a stuck run is diagnosable from the log alone. */
function log(runId: string, event: string, fields: Record<string, unknown>): void {
  const rest = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v) : v}`)
    .join(' ')
  console.log(`[scout] run_id=${runId} event=${event}${rest ? ` ${rest}` : ''}`)
}

export { MAX_START_ATTEMPTS }

// ─── Cancel ──────────────────────────────────────────────────────────────────

export interface CancelResult {
  cancelled: boolean
  requested: boolean
  status: string | null
  message: string
  error: string | null
}

/**
 * Stop a run. Two different things depending on where it is:
 *
 *   QUEUED  — nothing has started, so it is cancelled outright and immediately.
 *   RUNNING — `cancel_requested` is set and the worker stops at its next stage
 *             boundary. It is deliberately NOT killed mid-stage: a stage part-way
 *             through writing findings should finish that write, and a worker
 *             that ignores the request is already handled by the lease.
 *
 * Both writes are conditional on the status, so cancelling a run that finished a
 * moment ago changes nothing and says so.
 */
export async function cancelScoutRun(
  userId: string,
  runId: string,
  opts: { db?: RunStoreDb; now?: number } = {}
): Promise<CancelResult> {
  const db = opts.db ?? liveRunStoreDb()
  const now = opts.now ?? Date.now()
  const iso = new Date(now).toISOString()

  const { row, error } = await db.getRun(userId, runId)
  if (error) return { cancelled: false, requested: false, status: null, message: '', error }
  if (!row) return { cancelled: false, requested: false, status: null, message: '', error: 'run not found' }

  if (row.status === 'queued') {
    const message = 'Scout cancelled before it started.'
    const ok = await finishQueued(db, runId, 'cancelled', message, now)
    log(runId, 'cancelled', { from: 'queued' })
    return { cancelled: ok, requested: false, status: ok ? 'cancelled' : row.status, message, error: ok ? null : 'the run is no longer queued' }
  }

  if (row.status === 'running') {
    const { rows, error: wErr } = await db.patchRun(runId, { cancel_requested: true, last_dispatch_at: iso }, { status: 'running' })
    if (wErr) {
      // Pre-020: there is no flag to set, so the honest answer is that cancelling
      // a running run needs the migration. The run still ends on its own deadline.
      return {
        cancelled: false, requested: false, status: row.status,
        message: 'This run is already working. Cancelling a running scout needs migration 020; it will still stop at its own deadline.',
        error: null,
      }
    }
    log(runId, 'cancel_requested', { from: 'running' })
    return {
      cancelled: false, requested: rows.length > 0, status: row.status,
      message: 'Asked the scout to stop — it finishes the stage it is in, then stops.',
      error: null,
    }
  }

  return { cancelled: false, requested: false, status: row.status, message: `This run is already ${row.status}.`, error: null }
}
