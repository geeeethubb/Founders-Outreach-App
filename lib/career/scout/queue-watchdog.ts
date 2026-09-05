// The thing that was missing: something that ACTS on a stuck queued run.
//
// `run-reaper.ts` handles the "claimed and then went quiet" case. It cannot
// handle "never claimed at all", because it selects `['running']` and
// `isRunStale` returns false for anything that is not running. So the entire
// class of failure where NOTHING PICKED THE RUN UP had no recovery path, and a
// run sat queued for 328 minutes.
//
// Three rules, and the last is the one that makes the invariant true:
//
//   A handed-back leg with no dispatch yet: ask a worker NOW (the chain link).
//   Past 60s queued, ask a worker again (up to MAX_START_ATTEMPTS, spaced).
//   Past 60s queued with the attempts spent, FAIL IT — with the real reason
//   the last dispatch gave, written on the row, never a fabricated count.
//
// It runs on read as well as from the cron, because the crons here are DAILY
// (vercel.json) and a founder looking at a stuck run should not wait until
// tomorrow for the system to agree with them. Every write is conditional on
// the status still being 'queued', so two concurrent sweeps — or a sweep
// racing the real worker — converge instead of fighting. The worker winning is
// the good outcome and it wins by claiming first.

import { scoutError } from '@/lib/runs/errors'
import { scoutLog } from '@/lib/runs/log'
import { queueVerdict, queueMessage, redispatchDue, MAX_START_ATTEMPTS, type QueueRow } from './queue-health'
import { reapStaleRuns } from './run-reaper'
import { liveRunStoreDb, type RunStoreDb } from './run-store-db'
import { failQueuedRun, noteDispatchAttempt, recordDispatchOutcome } from './run-store'
import { dispatchScoutWorker, resolveWorkerBase, type DispatchSettled, type WorkerBase } from './worker-target'
import { isMissingSchema } from '../evidence/store'
import type { ScoutRunRow } from './run-record'

export interface QueueAction {
  runId: string
  action: 'redispatched' | 'failed' | 'cancelled' | 'reaped'
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
  dispatch?: (runId: string, token: string) => Promise<{ dispatched: boolean; error: string | null; status?: number | null; outcome?: DispatchSettled['outcome'] }>
  /** Resolved from request headers when the sweep runs inside a route. */
  baseUrl?: string
  target?: WorkerBase
  limit?: number
  /** Also close running runs whose lease lapsed. Default true. */
  reap?: boolean
}

/**
 * Bring every queued run of this user to a decision, and close every running
 * run whose worker is gone. Idempotent: each write is conditional, so
 * concurrent sweeps converge.
 */
export async function sweepScoutQueue(userId: string, opts: SweepOptions = {}): Promise<QueueSweepResult> {
  const db = opts.db ?? liveRunStoreDb()
  const now = opts.now ?? Date.now()
  const actions: QueueAction[] = []

  // Running runs whose lease lapsed are the reaper's; do it first so a row it
  // closes is not also judged below.
  if (opts.reap !== false) {
    const reap = await reapStaleRuns(userId, { db, now })
    if (reap.migrationMissing) return { actions: [], checked: 0, error: reap.error, migrationMissing: true }
    for (const r of reap.reaped) actions.push({ runId: r.runId, action: 'reaped', waitedMs: 0, attempt: 0, message: `closed as ${r.status}: ${r.errorCode}` })
  }

  const { rows, error } = await db.listRuns(userId, ['queued'], opts.limit ?? 20)
  if (error) return { actions, checked: 0, error, migrationMissing: isMissingSchema(error) }

  const target = opts.target ?? (opts.baseUrl ? { baseUrl: opts.baseUrl, headers: resolveWorkerBase(null).headers } : resolveWorkerBase(null))

  for (const row of rows) {
    const verdict = queueVerdict(row as QueueRow, now)
    if (verdict.state === 'terminal') continue

    const attempt = Math.max(0, (row as QueueRow).attempt_count ?? 0)
    const waitedMs = 'waitedMs' in verdict ? verdict.waitedMs : 0
    const message = queueMessage(verdict)

    if (verdict.state === 'cancelled') {
      const done = await failQueuedRun(row.id, scoutError('CANCELLED', 'Scout cancelled before it started.', { retryable: false }), { db, now, status: 'cancelled' })
      if (done) actions.push({ runId: row.id, action: 'cancelled', waitedMs, attempt, message })
      continue
    }

    // Checked before the age-based verdicts, because it is true at every age:
    // a queued run with no claim token cannot satisfy the claim guard, so no
    // worker can ever start it however long we wait or however often we ask.
    // (The token is only ever cleared by the claim itself, in the statement
    // that makes the row 'running', so a queued row without one is not a race.)
    if (!row.claim_token) {
      const err = scoutError('CLAIM', 'This run was queued without a claim token, so no worker could ever start it. Start a new run.', { retryable: true })
      const done = await failQueuedRun(row.id, err, { db, now })
      if (done) actions.push({ runId: row.id, action: 'failed', waitedMs, attempt, message: err.message })
      continue
    }

    // Young enough that its dispatch may still be landing: nothing to do yet.
    if (verdict.state === 'starting' || verdict.state === 'slow_start') continue

    if (verdict.state === 'redispatch' || verdict.state === 'chain') {
      // Not twice inside the spacing window: the last dispatch may be a cold
      // start still landing, and a second POST would only burn the attempt.
      if (!redispatchDue(row as QueueRow, now)) continue
      const token = row.claim_token
      // Count the attempt BEFORE dispatching, guarded on the count we read: two
      // sweeps racing over one row cannot both bump and both dispatch.
      const bump = await noteDispatchAttempt(row.id, { db, now })
      if (!bump.won) continue
      const send =
        opts.dispatch ??
        (async (id: string, t: string) => {
          const d = await dispatchScoutWorker(target, id, t, { raceMs: 1_200 })
          return { dispatched: d.dispatched, error: d.error, status: d.status, outcome: d.outcome }
        })
      const d = await send(row.id, token)
      const settled: DispatchSettled = { outcome: d.outcome ?? (d.dispatched ? 'pending' : 'failed'), status: d.status ?? null, error: d.error, latencyMs: 0 }
      await recordDispatchOutcome(row.id, settled, { db, now, attempt: bump.attempt, source: 'watchdog' })
      scoutLog({ run_id: row.id, event: 'redispatched', queue_wait_ms: waitedMs, attempt: bump.attempt, status: settled.outcome, http_status: settled.status, error: settled.error, error_code: settled.outcome === 'failed' ? 'DISPATCH' : null }, settled.outcome === 'failed' ? 'warn' : 'log')
      const failedNow = settled.outcome === 'failed'
      // A dispatch that FAILED with the attempts now spent is a terminal
      // answer: nothing is listening, and the row says why.
      if (failedNow && bump.attempt >= MAX_START_ATTEMPTS) {
        const err = scoutError('DISPATCH', `Scouting could not start: the app could not reach its own worker (${settled.error ?? 'no reason given'}).`, {
          httpStatus: settled.status,
          attempt: bump.attempt,
          retryable: true,
        })
        const done = await failQueuedRun(row.id, err, { db, now })
        if (done) actions.push({ runId: row.id, action: 'failed', waitedMs, attempt: bump.attempt, message: err.message })
        continue
      }
      actions.push({
        runId: row.id,
        action: 'redispatched',
        waitedMs,
        attempt: bump.attempt,
        message: failedNow ? `retry ${bump.attempt} could not reach a worker: ${settled.error ?? 'no reason given'}` : message,
      })
      continue
    }

    if (verdict.state === 'no_worker') {
      // The row's own last_error (written by whichever dispatch last failed)
      // is the real cause; the generic sentence is the fallback.
      const last = (row as ScoutRunRow).last_error
      const err = scoutError('DISPATCH', last ? `Scouting could not start: ${last}` : message, { attempt, retryable: true })
      const done = await failQueuedRun(row.id, err, { db, now })
      if (done) actions.push({ runId: row.id, action: 'failed', waitedMs, attempt, message: err.message })
    }
  }

  return { actions, checked: rows.length, error: null, migrationMissing: false }
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
 *   RUNNING — `cancel_requested` is set; the worker sees it on its next
 *             heartbeat or progress write and stops at its next step. It is
 *             deliberately NOT killed mid-write: a stage part-way through
 *             writing findings should finish that write.
 *
 * Both writes are conditional on the status. A queued run that a worker claims
 * between the read and the write FALLS THROUGH to the running branch, so the
 * founder's intent is never dropped at the exact moment the run starts to
 * spend.
 */
export async function cancelScoutRun(
  userId: string,
  runId: string,
  opts: { db?: RunStoreDb; now?: number } = {}
): Promise<CancelResult> {
  const db = opts.db ?? liveRunStoreDb()
  const now = opts.now ?? Date.now()
  const iso = new Date(now).toISOString()

  // getRun takes the ID first. Passing these the wrong way round looked up a
  // run whose id was the user id, found nothing, and reported an empty message.
  const { row, error } = await db.getRun(runId, userId)
  if (error) return { cancelled: false, requested: false, status: null, message: '', error }
  if (!row) return { cancelled: false, requested: false, status: null, message: '', error: 'run not found' }

  if (row.status === 'queued') {
    const message = 'Scout cancelled before it started.'
    const ok = await failQueuedRun(runId, scoutError('CANCELLED', message, { retryable: false }), { db, now, status: 'cancelled' })
    if (ok) {
      scoutLog({ run_id: runId, event: 'cancelled', detail: 'from queued' })
      return { cancelled: true, requested: false, status: 'cancelled', message, error: null }
    }
    // A worker claimed it a moment ago: fall through and ask it to stop.
  }

  const { rows, error: wErr } = await db.patchRun(runId, { cancel_requested: true, last_dispatch_at: iso }, { status: 'running' })
  if (wErr) {
    // Pre-020: there is no flag to set, so the honest answer is that cancelling
    // a running run needs the migration. The run still ends on its own deadline.
    return {
      cancelled: false,
      requested: false,
      status: row.status,
      message: 'This run is already working. Cancelling a running scout needs migration 020; it will still stop at its own deadline.',
      error: null,
    }
  }
  if (rows.length > 0) {
    scoutLog({ run_id: runId, event: 'cancel_requested', detail: 'from running' })
    return {
      cancelled: false,
      requested: true,
      status: 'running',
      message: 'Asked the scout to stop — it finishes the step it is in, then stops.',
      error: null,
    }
  }
  const current = (await db.getRun(runId, userId)).row
  return { cancelled: false, requested: false, status: current?.status ?? row.status, message: `This run is already ${current?.status ?? row.status}.`, error: null }
}
