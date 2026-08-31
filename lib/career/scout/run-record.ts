// A durable scout run as a VALUE: what a row means, and what the UI reads.
//
// Split out of run-store.ts (which owns the writes) because everything here is
// pure — no database, no HTTP, no clock beyond what is passed in. That matters
// most for the two judgements below, which are the ones that can be wrong in a
// way a user sees:
//
//   `isRunStale`  — is this run dead, or merely quiet?
//   `toRunView`   — the one shape every reader of a run gets.
//
// Both used to live next to the writes and disagree with them by minutes.

import { scoutDeadlineMs } from './run-dispatch'

export type ScoutRunStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled'

/** Terminal statuses — a run in one of these is never claimed, reaped or re-dispatched. */
export const TERMINAL_STATUSES: ScoutRunStatus[] = ['succeeded', 'partial', 'failed', 'cancelled']
export const ACTIVE_STATUSES: ScoutRunStatus[] = ['queued', 'running']

/** The progress payload is bounded: a run emits hundreds of events, the row keeps the last 40. */
export const PROGRESS_EVENT_LIMIT = 40
/** At most one progress write per this interval — plus always one on a stage change. */
export const PROGRESS_MIN_INTERVAL_MS = 2_000
/**
 * How long a heartbeat may lag before a 'running' run is *considered* for
 * reaping. It is only half the test — see `isRunStale`.
 */
export const DEFAULT_STALE_MS = 300_000
/** How far past its own deadline a silent run is given before it is declared dead. */
export const DEADLINE_GRACE_MS = 60_000
/** A 'queued' run older than this was probably a lost dispatch; re-dispatch it. */
export const REDISPATCH_AFTER_MS = 10_000
/** Quiet for this long AND past its deadline, and the UI is allowed to say so. */
export const STALE_DISPLAY_MS = 120_000
/** A progress `detail` is a sentence for a human, not a payload. */
export const MAX_DETAIL = 300

export interface ScoutRunProgressEvent {
  at: string
  stage: string
  detail: string
}

export interface ScoutRunProgress {
  stage: string | null
  detail: string | null
  counts: Record<string, number>
  events: ScoutRunProgressEvent[]
  /** When the worker that claimed this run promised to be finished. */
  deadline_at?: string | null
  /** Stamped by the reaper. A worker that later finishes the run may override it. */
  reaped_at?: string | null
}

export interface ScoutRunRow {
  id: string
  user_id: string
  kind?: string | null
  label?: string | null
  status: string
  stage?: string | null
  progress?: unknown
  params?: unknown
  claim_token?: string | null
  heartbeat_at?: string | null
  worker_started_at?: string | null
  started_at?: string | null
  completed_at?: string | null
  stats?: unknown
  error?: string | null
  career_mission_id?: string | null
}

/**
 * What a run produced, counted. Deliberately the same words as
 * `RunJobSummary` (lib/career/jobs/run-results.ts), which is where they are
 * computed — 'unverified' means UNVERIFIED here too, not "everything that is
 * not VERIFIED_OPEN".
 */
export interface RunJobCounts {
  total: number
  inserted: number
  verified_open: number
  likely_open: number
  unverified: number
  closed: number
  ranked: number
}

export function emptyJobCounts(): RunJobCounts {
  return { total: 0, inserted: 0, verified_open: 0, likely_open: 0, unverified: 0, closed: 0, ranked: 0 }
}

// ─── Reading a row ───────────────────────────────────────────────────────────

export function readProgress(row: ScoutRunRow): ScoutRunProgress {
  const p = (row.progress ?? {}) as Partial<ScoutRunProgress>
  const events = Array.isArray(p.events) ? (p.events as ScoutRunProgressEvent[]).slice(-PROGRESS_EVENT_LIMIT) : []
  return {
    stage: (row.stage ?? p.stage ?? null) as string | null,
    detail: (p.detail ?? null) as string | null,
    counts: (p.counts && typeof p.counts === 'object' ? p.counts : {}) as Record<string, number>,
    events,
    deadline_at: (p.deadline_at ?? null) as string | null,
    reaped_at: (p.reaped_at ?? null) as string | null,
  }
}

/**
 * When the worker that claimed this run said it would be finished by. From the
 * row where the claim recorded it; otherwise the environment's deadline
 * measured from `worker_started_at`. Null means we have no promise to hold the
 * run to — a legacy row, or one that was never claimed.
 */
export function expectedFinishAt(row: ScoutRunRow, deadlineMs = scoutDeadlineMs()): number | null {
  const stated = Date.parse(String(readProgress(row).deadline_at ?? ''))
  if (Number.isFinite(stated)) return stated
  const started = Date.parse(String(row.worker_started_at ?? ''))
  if (Number.isFinite(started)) return started + deadlineMs
  return null
}

/**
 * A 'running' run that is BOTH silent and out of time. Both halves matter.
 *
 * Silence alone is not death: `progress('plan','asking the mission planner')`
 * is followed by one awaited agent call that took 226s on a live run, and
 * ranking a dozen jobs reports nothing at all while it works. A reaper that
 * judged on the pulse alone would close healthy runs, the page would show
 * "Failed — the worker stopped responding" for a run that was still working,
 * and the founder would learn to distrust the status. So a run is declared
 * dead only once it has passed the deadline it was CLAIMED with (plus a grace
 * period) AND has stopped heartbeating.
 *
 * A row with NO heartbeat is never stale — UNLESS it is a scout run. Package,
 * verify and outreach runs share this table and none of them heartbeats, so
 * "quiet" would mean "old" and the reaper would kill live work. But a scout run
 * without a pulse is a different animal: it is either a row from before durable
 * runs existed, or a synchronous fallback run whose HTTP request died. Both are
 * dead and neither will ever heartbeat, so they are judged on `started_at`
 * against a full deadline plus the staleness window — long enough that a live
 * fallback run (bounded by the same deadline) is never touched. Without this,
 * every pre-016 scout run stays 'running' in the Runs list forever.
 */
export function isRunStale(
  row: ScoutRunRow,
  staleMs = DEFAULT_STALE_MS,
  now = Date.now(),
  opts: { deadlineMs?: number; graceMs?: number } = {}
): boolean {
  if (row.status !== 'running') return false
  const beat = Date.parse(String(row.heartbeat_at ?? ''))
  if (!Number.isFinite(beat)) {
    if (row.kind !== 'job_scout') return false
    const started = Date.parse(String(row.started_at ?? ''))
    if (!Number.isFinite(started)) return false
    return now - started > (opts.deadlineMs ?? scoutDeadlineMs()) + staleMs
  }
  if (now - beat <= staleMs) return false
  const finish = expectedFinishAt(row, opts.deadlineMs ?? scoutDeadlineMs())
  if (finish !== null && now < finish + (opts.graceMs ?? DEADLINE_GRACE_MS)) return false
  return true
}

export interface ScoutRunView {
  id: string
  status: string
  stage: string | null
  detail: string | null
  counts: Record<string, number>
  events: ScoutRunProgressEvent[]
  label: string | null
  started_at: string | null
  heartbeat_at: string | null
  completed_at: string | null
  /** When this run promised to be finished by, if it has been claimed. */
  deadline_at: string | null
  stats: unknown
  error: string | null
  jobs: RunJobCounts
  active: boolean
  partial: boolean
  stale: boolean
}

/**
 * One shape for every reader of a run, so the Jobs page, the Runs page and the
 * CLI cannot disagree about what a run is doing. `claim_token` is never in it.
 *
 * `stale` is the same test the reaper uses, with a shorter silence bound — so
 * the screen can never warn that a run "may have stopped" while the reaper
 * still considers it alive. The two used to disagree by four minutes.
 */
export function toRunView(row: ScoutRunRow, jobs: RunJobCounts = emptyJobCounts(), now = Date.now()): ScoutRunView {
  const p = readProgress(row)
  return {
    id: row.id,
    status: row.status,
    stage: p.stage,
    detail: p.detail,
    counts: p.counts,
    events: p.events,
    label: row.label ?? null,
    started_at: row.started_at ?? null,
    heartbeat_at: row.heartbeat_at ?? null,
    completed_at: row.completed_at ?? null,
    deadline_at: p.deadline_at ?? null,
    stats: row.stats ?? null,
    error: row.error ?? null,
    jobs,
    active: (ACTIVE_STATUSES as string[]).includes(row.status),
    partial: row.status === 'partial',
    stale: isRunStale(row, STALE_DISPLAY_MS, now),
  }
}

/**
 * What a finished run should be called. 'partial' is not a failure — it is
 * "this produced real jobs and then ran out of time". Hiding that behind
 * 'succeeded' would teach the founder to trust a short list; calling it
 * 'failed' would bury jobs they already paid for.
 */
export function terminalStatusFor(r: {
  migrationMissing: boolean
  deadlineHit: boolean
  errors: string[]
}): Exclude<ScoutRunStatus, 'queued' | 'running'> {
  if (r.migrationMissing) return 'failed'
  if (r.deadlineHit) return 'partial'
  if (r.errors.some((e) => /deadline|not started before|skipped:/i.test(e))) return 'partial'
  return 'succeeded'
}
