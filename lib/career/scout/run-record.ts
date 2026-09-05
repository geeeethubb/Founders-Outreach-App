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
//
// Two scout kinds share this record. `job_scout` is the Career OS Job Scout;
// `outreach` is the People Scout (the kind its rows have carried since
// migration 011, kept so history stays readable). Both are queued, claimed,
// leased, checkpointed and finished by the same code.

import { invocationBudgetMs } from '@/lib/runs/deadline'
import type { ScoutErrorCode } from '@/lib/runs/errors'
import { isCursorComplete, isCursorEmpty, readRunCursor } from './run-dispatch'

export type ScoutRunStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled'

/** The two kinds of run that go through the queue. Everything else in the table is inline. */
export type DurableScoutKind = 'job_scout' | 'outreach'
export const DURABLE_KINDS: DurableScoutKind[] = ['job_scout', 'outreach']
/** The People Scout's kind on the row. */
export const PEOPLE_SCOUT_KIND: DurableScoutKind = 'outreach'
export const JOB_SCOUT_KIND: DurableScoutKind = 'job_scout'

/** Terminal statuses — a run in one of these is never claimed, reaped or re-dispatched. */
export const TERMINAL_STATUSES: ScoutRunStatus[] = ['succeeded', 'partial', 'failed', 'cancelled']
export const ACTIVE_STATUSES: ScoutRunStatus[] = ['queued', 'running']

/** The progress payload is bounded: a run emits hundreds of events, the row keeps the last 40. */
export const PROGRESS_EVENT_LIMIT = 40
/** At most one progress write per this interval — plus always one on a stage change. */
export const PROGRESS_MIN_INTERVAL_MS = 2_000
/**
 * How long a heartbeat may lag before a 'running' run WITHOUT a lease is
 * considered for reaping. Rows written before this pass carry no lease; they
 * are judged on the older, more patient rule.
 */
export const DEFAULT_STALE_MS = 300_000
/** How far past its own deadline a silent, lease-less run is given before it is declared dead. */
export const DEADLINE_GRACE_MS = 60_000
/** A 'queued' run older than this was probably a lost dispatch; re-dispatch it. */
export const REDISPATCH_AFTER_MS = 10_000
/** Quiet for this long AND past its deadline, and the UI is allowed to say so. */
export const STALE_DISPLAY_MS = 120_000
/** A progress `detail` is a sentence for a human, not a payload. */
export const MAX_DETAIL = 300

/**
 * THE LEASE. A claimed run must renew it (the worker heartbeats every 30s) or it
 * is presumed abandoned. Ninety seconds is three missed beats: long enough that
 * a busy instance never loses a live run, short enough that a killed worker's
 * row is closed in about two minutes rather than ten. The lease is what makes
 * "worker crash does not orphan the run" true without a human reading the page.
 */
export const LEASE_MS = 90_000
/** Slack past the lease before it is acted on, for clock skew and a slow write. */
export const LEASE_GRACE_MS = 30_000
/** How often a worker renews its lease. */
export const HEARTBEAT_MS = 30_000

/**
 * A package run's own SLA — five minutes, the same promise the package row
 * carries. Deliberately not the scout's: a scout run may legitimately take
 * twenty minutes, and borrowing its patience is what let a dead package run
 * look alive for a day.
 */
export const PACKAGE_RUN_DEADLINE_MS = 5 * 60 * 1000
/** Slack for a worker finishing just past the wall before it writes its result. */
export const PACKAGE_RUN_GRACE_MS = 60_000

/**
 * How old a PULSELESS 'running' row of each kind may be before it is dead.
 *
 * A row with no heartbeat was executed inline — inside a request, a cron or a
 * CLI — by code that never renews anything. Silence there means nothing, so
 * the only test is age against what such a run could legitimately take. Scout
 * kinds get the invocation budget plus the old staleness window (a synchronous
 * fallback run is bounded by the same deadline, so a live one is never
 * touched); the short inline kinds get their own ceilings.
 */
export function pulselessCeilingMs(kind: string | null | undefined, invocationMs = invocationBudgetMs()): number | null {
  // A row with no kind predates migration 014 and was a job scout in every reader's convention.
  switch (kind ?? 'job_scout') {
    case 'package':
      return PACKAGE_RUN_DEADLINE_MS + PACKAGE_RUN_GRACE_MS
    case 'job_verify':
      return 5 * 60 * 1000 + PACKAGE_RUN_GRACE_MS
    case 'evidence_import':
      return 15 * 60 * 1000
    case 'job_scout':
    case 'outreach':
      return invocationMs + DEFAULT_STALE_MS
    default:
      return null
  }
}

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
  /** Which leg of the run this progress belongs to (1 on a first invocation). */
  invocation?: number | null
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
  // ─── Migration 020. Optional because the watchdog must work before it is
  // applied by hand: a missing attempt_count reads as 0, and a missing
  // queued_at falls back to started_at.
  queued_at?: string | null
  claimed_at?: string | null
  attempt_count?: number | null
  last_dispatch_at?: string | null
  worker_id?: string | null
  lease_expires_at?: string | null
  cancel_requested?: boolean | null
  last_error?: string | null
  // ─── Migration 021.
  error_code?: string | null
  error_detail?: unknown
  invocation_count?: number | null
  run_deadline_at?: string | null
  checkpoint?: unknown
  result?: unknown
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

/** Is this row one the queue owns — enqueued with a token, or claimed by a worker? */
export function isDurableRow(row: Pick<ScoutRunRow, 'claim_token' | 'worker_started_at' | 'queued_at'>): boolean {
  return Boolean(row.claim_token) || Boolean(row.worker_started_at) || Boolean(row.queued_at)
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
    invocation: typeof p.invocation === 'number' ? p.invocation : null,
  }
}

/**
 * When the worker that claimed this run said it would be finished by. From the
 * row where the claim recorded it; otherwise the environment's deadline
 * measured from `worker_started_at`. Null means we have no promise to hold the
 * run to — a legacy row, or one that was never claimed.
 */
export function expectedFinishAt(row: ScoutRunRow, deadlineMs = invocationBudgetMs()): number | null {
  const stated = Date.parse(String(readProgress(row).deadline_at ?? ''))
  if (Number.isFinite(stated)) return stated
  const started = Date.parse(String(row.worker_started_at ?? ''))
  if (Number.isFinite(started)) return started + deadlineMs
  return null
}

/**
 * A 'running' run that is dead.
 *
 * Three rules, in order of how much the row tells us:
 *
 *   LEASED     (written by this pass) the worker renews `lease_expires_at`
 *              every heartbeat. Past it plus a grace, the worker is gone —
 *              however long ago it claimed, whatever stage it named. Silence
 *              here is death, because the heartbeat runs on a timer that does
 *              not care how long an agent call takes.
 *
 *   PULSED     (rows from before the lease existed) silent for `staleMs` AND
 *              past the deadline it was claimed with plus a grace. Silence
 *              alone was never enough: one live planner call took 226s.
 *
 *   PULSELESS  executed inline by something that never heartbeats. Judged on
 *              age against what a run of that kind could take (see
 *              `pulselessCeilingMs`). This is what closed five People Scout
 *              rows that had been 'running' since August.
 */
export function isRunStale(
  row: ScoutRunRow,
  staleMs = DEFAULT_STALE_MS,
  now = Date.now(),
  opts: { deadlineMs?: number; graceMs?: number } = {}
): boolean {
  if (row.status !== 'running') return false

  const lease = Date.parse(String(row.lease_expires_at ?? ''))
  if (Number.isFinite(lease)) return now > lease + LEASE_GRACE_MS

  const beat = Date.parse(String(row.heartbeat_at ?? ''))
  if (!Number.isFinite(beat)) {
    const ceiling = pulselessCeilingMs(row.kind, opts.deadlineMs ?? invocationBudgetMs())
    if (ceiling === null) return false
    const started = Date.parse(String(row.started_at ?? ''))
    if (!Number.isFinite(started)) return false
    return now - started > ceiling
  }
  if (now - beat <= staleMs) return false
  const finish = expectedFinishAt(row, opts.deadlineMs ?? invocationBudgetMs())
  if (finish !== null && now < finish + (opts.graceMs ?? DEADLINE_GRACE_MS)) return false
  return true
}

/** Has the WHOLE run (across every invocation) run out of the time it was given? */
export function pastRunDeadline(row: Pick<ScoutRunRow, 'run_deadline_at'>, now = Date.now()): boolean {
  const t = Date.parse(String(row.run_deadline_at ?? ''))
  return Number.isFinite(t) && now > t
}

export interface ScoutRunView {
  id: string
  kind: string
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
  /** When the whole run, across every leg, must be over. */
  run_deadline_at: string | null
  stats: unknown
  error: string | null
  /** Stable code for `error`, when the run recorded one. */
  error_code: string | null
  /** What to do about it, when the run recorded one. */
  remedy: string | null
  jobs: RunJobCounts
  active: boolean
  partial: boolean
  stale: boolean
  /** Which leg of the run is (or was) executing. 1 on a first pass. */
  invocation: number
  /** Dispatch attempts for the current leg. */
  attempts: number
  /** The run's own cursor or checkpoint has work left that a continuation would skip past. */
  resumable: boolean
  cancel_requested: boolean
  /** The People Scout's persisted result payload; null for a Job Scout. */
  result: unknown
}

function readErrorDetail(row: ScoutRunRow): { remedy: string | null } {
  const d = row.error_detail && typeof row.error_detail === 'object' ? (row.error_detail as Record<string, unknown>) : null
  return { remedy: typeof d?.remedy === 'string' ? d.remedy : null }
}

/** Does this row carry resume state that is neither empty nor finished? */
export function isResumable(row: ScoutRunRow): boolean {
  if ((row.kind ?? 'job_scout') === 'job_scout') {
    const cursor = readRunCursor(row)
    return !isCursorEmpty(cursor) && !isCursorComplete(cursor)
  }
  const cp = row.checkpoint && typeof row.checkpoint === 'object' ? (row.checkpoint as { stages?: unknown }) : null
  const stages = Array.isArray(cp?.stages) ? (cp!.stages as string[]) : []
  return stages.length > 0 && !stages.includes('done')
}

/**
 * One shape for every reader of a run, so the Jobs page, the Scout page, the
 * Runs page and the CLI cannot disagree about what a run is doing.
 * `claim_token` is never in it.
 *
 * `stale` is the same test the reaper uses, with a shorter silence bound for
 * lease-less rows — so the screen can never warn that a run "may have
 * stopped" while the reaper still considers it alive.
 */
export function toRunView(row: ScoutRunRow, jobs: RunJobCounts = emptyJobCounts(), now = Date.now()): ScoutRunView {
  const p = readProgress(row)
  return {
    id: row.id,
    kind: row.kind ?? 'job_scout',
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
    run_deadline_at: row.run_deadline_at ?? null,
    stats: row.stats ?? null,
    error: row.error ?? null,
    error_code: row.error_code ?? null,
    remedy: readErrorDetail(row).remedy,
    jobs,
    active: (ACTIVE_STATUSES as string[]).includes(row.status),
    partial: row.status === 'partial',
    stale: isRunStale(row, STALE_DISPLAY_MS, now),
    invocation: Math.max(1, row.invocation_count ?? p.invocation ?? 1),
    attempts: Math.max(0, row.attempt_count ?? 0),
    resumable: isResumable(row),
    cancel_requested: row.cancel_requested === true,
    result: row.result ?? null,
  }
}

/**
 * What a finished run should be called. 'partial' is not a failure — it is
 * "this produced real jobs and then stopped short". Hiding that behind
 * 'succeeded' would teach the founder to trust a short list; calling it
 * 'failed' would bury jobs they already paid for.
 *
 * There are three ways to stop short and only one of them is the clock:
 *
 *   deadline   the invocation, or the run's total runtime, ran out.
 *   budget     the SPEND CEILING was reached — the run stopped starting paid
 *              work. It used to be recorded as 'succeeded', so a run that
 *              stopped because it ran out of money looked exactly like one
 *              that had swept the market.
 *   saturated  the sources stopped producing anything new. That is the
 *              intended good ending of a wide run, and it is 'succeeded'.
 *
 * And one way to not start at all: `failed` — no mission, no bank, a broken
 * input. That is a failure, never a partial success that "ran out of time".
 */
export function terminalStatusFor(r: {
  migrationMissing: boolean
  deadlineHit: boolean
  errors: string[]
  /** The orchestrator's own verdict, when the caller has one. */
  partial?: boolean
  /** 'complete' | 'deadline' | 'budget' | 'saturated' | 'failed', when the caller has one. */
  stopped?: string | null
}): Exclude<ScoutRunStatus, 'queued' | 'running'> {
  if (r.migrationMissing) return 'failed'
  if (r.stopped === 'failed') return 'failed'
  if (r.stopped === 'saturated') return 'succeeded'
  if (r.stopped === 'budget' || r.stopped === 'deadline') return 'partial'
  if (r.partial === true) return 'partial'
  if (r.deadlineHit) return 'partial'
  if (r.errors.some((e) => /deadline|not started before|skipped:/i.test(e))) return 'partial'
  return 'succeeded'
}

/** The error code a terminal status implies when the run recorded none of its own. */
export function impliedErrorCode(status: Exclude<ScoutRunStatus, 'queued' | 'running'>, stopped?: string | null): ScoutErrorCode | null {
  if (status === 'cancelled') return 'CANCELLED'
  if (status === 'partial') return stopped === 'budget' ? null : 'RUN_DEADLINE'
  return null
}

/** Whole-run time a Job Scout must have left for another pass to be worth dispatching. */
export const MIN_CONTINUATION_MS = 45_000

/**
 * Does a Job Scout leg hand the run to another pass by itself?
 *
 * Only the CLOCK makes a leg continuable: a run stopped by its spend ceiling
 * stops (raising the ceiling is the founder's decision), a cursor marked done
 * has nothing left, and a run that has used its mode's whole runtime is over —
 * the next pass would open, find a zero-length window and close. `reason` is
 * the sentence the row carries when the answer is no and the run is partial.
 */
export function jobLegContinuation(i: {
  status: string
  stopped: string | null | undefined
  cursor: { stages?: unknown; elapsed_ms?: unknown } | null | undefined
  runtimeMs: number
}): { continuable: boolean; reason: string | null } {
  if (i.status !== 'partial' || i.stopped !== 'deadline') return { continuable: false, reason: null }
  const stages = Array.isArray(i.cursor?.stages) ? (i.cursor!.stages as unknown[]) : []
  if (stages.includes('done')) return { continuable: false, reason: null }
  const elapsed = typeof i.cursor?.elapsed_ms === 'number' && Number.isFinite(i.cursor.elapsed_ms) ? Math.max(0, i.cursor.elapsed_ms) : 0
  const left = i.runtimeMs - elapsed
  if (left < MIN_CONTINUATION_MS) {
    return {
      continuable: false,
      reason: `the run has used all ${Math.max(1, Math.round(i.runtimeMs / 60_000))} minutes it was allowed (${Math.max(0, Math.round(left / 1000))}s left is not enough for another pass); everything found is saved`,
    }
  }
  return { continuable: true, reason: null }
}
