// How long may a scouting run sit before somebody does something about it?
//
// THE INCIDENT. A run sat at `status='queued'` for 328 minutes. The row said
// exactly what had happened and nobody was reading it: `claim_token` set and
// `heartbeat_at` stamped at the ENQUEUE instant, `worker_started_at` NULL. A
// worker was asked to start and never did.
//
// Three things had to be true at once, and all three were:
//
//   1. `isRunStale` opens with `if (row.status !== 'running') return false`, and
//      the reaper only ever selects `['running']`. A QUEUED run was invisible to
//      the entire recovery system — not judged and found healthy, never looked at.
//   2. The only thing that retried a lost dispatch was the run-detail route,
//      which redispatches when POLLED. That makes recovery conditional on a
//      browser being open, while the UI says "you can close this tab".
//   3. vercel.json schedules the crons DAILY (`0 11 * * *`, `0 13 * * *`), so
//      even the sweep that does exist could be 24 hours away — and it would not
//      have looked at a queued run anyway.
//
// This module is the missing judgement. It is pure and it reads columns that
// exist TODAY (`started_at`, `heartbeat_at`, `worker_started_at`, `status`), so
// it recovers the runs already stuck without waiting for a migration.

/** Past this, a queued run is no longer merely slow to start. */
export const MAX_QUEUE_WAIT_MS = 60_000

/** Past this the UI says "taking longer than expected", before anything is wrong. */
export const SLOW_QUEUE_MS = 30_000

/**
 * How many times the system will ask a worker to start one run.
 *
 * Two, not more. A dispatch that fails twice is not flaky — nothing is
 * listening — and a third attempt just extends the time the founder spends
 * looking at a spinner instead of at an honest error.
 */
export const MAX_START_ATTEMPTS = 2

/** A claimed run must beat this often or it is presumed abandoned. */
export const LEASE_MS = 90_000

/**
 * The absolute ceiling on time spent queued, whatever the attempt bookkeeping
 * says.
 *
 * This exists because attempt counting can FAIL. On a database without
 * migration 020 there is no `attempt_count` column, the counter never persists,
 * and a watchdog that decides purely on attempts redispatches for ever — which
 * is the original bug with extra steps. Caught by sweeping the real stuck run:
 * it reported "attempt 1" three times in a row.
 *
 * So the terminal decision rests on the CLOCK, which is always available, and
 * the attempt count only decides whether to retry along the way.
 */
export const HARD_QUEUE_CEILING_MS = MAX_QUEUE_WAIT_MS * (MAX_START_ATTEMPTS + 1)

export interface QueueRow {
  status: string
  kind?: string | null
  started_at?: string | null
  heartbeat_at?: string | null
  worker_started_at?: string | null
  claim_token?: string | null
  /** Migration 020. Absent on rows written before it — treated as 0. */
  attempt_count?: number | null
  queued_at?: string | null
  cancel_requested?: boolean | null
}

export type QueueVerdict =
  /** Nothing to do. */
  | { state: 'terminal' }
  /** Queued, and it is reasonable to still be waiting. */
  | { state: 'starting'; waitedMs: number }
  /** Queued longer than expected but still inside the wait. Say so; do nothing. */
  | { state: 'slow_start'; waitedMs: number }
  /** Queued past the wait, and an attempt remains. Ask a worker again. */
  | { state: 'redispatch'; waitedMs: number; attempt: number }
  /** Queued past the wait with no attempts left. Nothing is listening. */
  | { state: 'no_worker'; waitedMs: number; attempt: number }
  /** Someone pressed Cancel. */
  | { state: 'cancelled' }
  /** Claimed, beating, inside its lease. */
  | { state: 'working'; quietMs: number }
  /** Claimed and gone quiet past the lease. */
  | { state: 'abandoned'; quietMs: number }

const TERMINAL = ['succeeded', 'partial', 'failed', 'cancelled']

function ms(v: string | null | undefined): number | null {
  if (!v) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

/**
 * The one verdict, for queued AND running. Pure, so the watchdog, the API and
 * the screen cannot disagree about whether a run is in trouble — which is how
 * the UI ended up narrating "it may have stopped" for five hours while nothing
 * acted on it.
 */
export function queueVerdict(row: QueueRow, now = Date.now()): QueueVerdict {
  if (TERMINAL.includes(row.status)) return { state: 'terminal' }
  if (row.cancel_requested) return { state: 'cancelled' }

  if (row.status === 'queued') {
    // `queued_at` after migration 020; `started_at` is when the row was written,
    // which is the same instant for a queued run and exists today.
    const since = ms(row.queued_at) ?? ms(row.started_at) ?? ms(row.heartbeat_at)
    const waitedMs = since === null ? 0 : Math.max(0, now - since)
    const attempt = Math.max(0, row.attempt_count ?? 0)
    if (waitedMs <= SLOW_QUEUE_MS) return { state: 'starting', waitedMs }
    if (waitedMs <= MAX_QUEUE_WAIT_MS) return { state: 'slow_start', waitedMs }
    // The clock decides the ending; attempts only decide whether to try again.
    if (waitedMs >= HARD_QUEUE_CEILING_MS) return { state: 'no_worker', waitedMs, attempt }
    if (attempt < MAX_START_ATTEMPTS) return { state: 'redispatch', waitedMs, attempt }
    return { state: 'no_worker', waitedMs, attempt }
  }

  if (row.status === 'running') {
    // A running run that never recorded a worker start is a contradiction; judge
    // it on whatever timestamp it has rather than trusting the status.
    const beat = ms(row.heartbeat_at) ?? ms(row.worker_started_at) ?? ms(row.started_at)
    const quietMs = beat === null ? 0 : Math.max(0, now - beat)
    return quietMs > LEASE_MS ? { state: 'abandoned', quietMs } : { state: 'working', quietMs }
  }

  return { state: 'terminal' }
}

/** True when the watchdog must act rather than merely report. */
export function needsAction(v: QueueVerdict): boolean {
  return v.state === 'redispatch' || v.state === 'no_worker' || v.state === 'cancelled'
}

/**
 * The sentence a person reads. Written for someone who does not know what a
 * worker is — "no worker picked this up" is jargon; "nothing started it" is not.
 */
export function queueMessage(v: QueueVerdict): string {
  switch (v.state) {
    case 'starting':
      return 'Starting scout…'
    case 'slow_start':
      return `Taking longer than expected to start (${Math.round(v.waitedMs / 1000)}s)…`
    case 'redispatch':
      return 'Nothing picked this up — asking again.'
    case 'no_worker':
      return `Scouting could not start: nothing was available to run it after ${MAX_START_ATTEMPTS} attempts over ${Math.round(v.waitedMs / 1000)}s. This usually means the app server is not running.`
    case 'abandoned':
      return `The run stopped responding ${Math.round(v.quietMs / 1000)}s ago and was abandoned.`
    case 'cancelled':
      return 'Scout cancelled.'
    case 'working':
      return 'Searching companies and openings…'
    default:
      return ''
  }
}
