// Durable scout runs — the state machine of a run that outlives its request.
//
// A browser scout used to BE one HTTP request: the work, the progress and the
// result all lived inside it, so a refresh lost the run and Vercel's 300s
// function ceiling was the product's ceiling. A run is a ROW: the request that
// starts it only ENQUEUES it, a worker CLAIMS it with a single-use token, holds
// a LEASE it renews by heartbeat while it works, CHECKPOINTS what it has done,
// and either FINISHES it or HANDS IT BACK to the queue for the next invocation.
// The browser polls the row. Nothing about the run lives in React.
//
//   queued ──claim──▶ running ──finish──▶ succeeded | partial | failed | cancelled
//     ▲                  │
//     └────handoff───────┘        (a leg ended at its deadline with work left)
//
// Two scout kinds go through it — the Job Scout (`job_scout`) and the People
// Scout (`outreach`) — with one vocabulary and one set of guarantees.
//
// This module owns the WRITES and nothing else. Its neighbours own the rest,
// and it re-exports them so callers still have one door:
//
//   run-record.ts    what a row means, and what the UI reads (pure)
//   run-store-db.ts  the five-method database port and its Supabase impl
//   run-dispatch.ts  what the worker will execute; worker-target.ts, where it is
//   run-reaper.ts    closing the runs whose worker died (a policy, not a
//                    transition — imported directly, not re-exported, because
//                    it depends on this module)
//
// EVERY WRITE A WORKER MAKES IS FENCED on the run still being 'running' AND on
// the worker id it was claimed with. A leg the platform is about to kill —
// still awaiting a provider, its heartbeat timer still armed — cannot write
// onto a leg that has since been handed to another worker, because its id no
// longer matches. The in-memory progress cache is keyed the same way, so two
// legs of one run on one warm instance never share or wipe each other's state.

import { randomBytes } from 'crypto'
import { isMissingSchema } from '@/lib/career/jobs/db'
import { invocationBudgetMs } from '@/lib/runs/deadline'
import { scoutError, toRowError, type ScoutError, type ScoutErrorCode } from '@/lib/runs/errors'
import { scoutLog } from '@/lib/runs/log'
import {
  ACTIVE_STATUSES,
  DURABLE_KINDS,
  isDurableRow,
  LEASE_MS,
  MAX_DETAIL,
  PROGRESS_EVENT_LIMIT,
  PROGRESS_MIN_INTERVAL_MS,
  readProgress,
  type DurableScoutKind,
  type RunJobCounts,
  type ScoutRunProgress,
  type ScoutRunProgressEvent,
  type ScoutRunRow,
  type ScoutRunStatus,
} from './run-record'
import { liveRunStoreDb, type RunStoreDb } from './run-store-db'
import type { DispatchSettled } from './worker-target'

export * from './run-record'
export { liveRunStoreDb, type RunStoreDb } from './run-store-db'

/** How many worker invocations one run may chain before it is closed as partial. */
export const MAX_INVOCATIONS = 6

function kindLabel(kind: string | null | undefined): 'people' | 'jobs' {
  return (kind ?? 'job_scout') === 'outreach' ? 'people' : 'jobs'
}

// ─── Enqueue ─────────────────────────────────────────────────────────────────

export interface EnqueueInput {
  kind?: DurableScoutKind
  missionId?: string | null
  /** The run parameters the worker will execute. Persisted verbatim. */
  params: Record<string, unknown>
  label?: string
  /** The whole run's clock, across every invocation. Default: six invocations' worth. */
  runDeadlineMs?: number
  /** For a People Scout: the mission as given, kept on the row's own column. */
  mission?: unknown
  budget?: unknown
}

export interface EnqueueResult {
  runId: string | null
  claimToken: string | null
  /** false when the row could not be created durably. */
  durable: boolean
  migrationMissing: boolean
  /** A run of this kind is already queued or running for this user. */
  conflict: boolean
  error: string | null
}

export function newClaimToken(): string {
  return randomBytes(24).toString('base64url')
}

export async function enqueueScoutRun(
  userId: string,
  input: EnqueueInput,
  db: RunStoreDb = liveRunStoreDb()
): Promise<EnqueueResult> {
  const token = newClaimToken()
  const nowMs = Date.now()
  const now = new Date(nowMs).toISOString()
  const kind: DurableScoutKind = input.kind ?? 'job_scout'
  const runDeadlineMs = input.runDeadlineMs ?? invocationBudgetMs() * MAX_INVOCATIONS
  const { row, error, conflict } = await db.insertRun({
    user_id: userId,
    kind,
    label: input.label ?? (kind === 'outreach' ? 'people scout' : 'job scout'),
    mission: input.mission ?? {},
    budget: input.budget ?? {},
    status: 'queued',
    stage: 'queued',
    progress: {
      stage: 'queued',
      detail: 'waiting for a worker',
      counts: {},
      events: [{ at: now, stage: 'queued', detail: 'waiting for a worker' }],
      invocation: 0,
    } satisfies ScoutRunProgress,
    params: input.params,
    claim_token: token,
    heartbeat_at: now,
    queued_at: now,
    attempt_count: 0,
    invocation_count: 0,
    run_deadline_at: new Date(nowMs + runDeadlineMs).toISOString(),
    career_mission_id: input.missionId ?? null,
  })
  if (error || !row) {
    const missing = error ? isMissingSchema(error) : false
    return { runId: null, claimToken: null, durable: false, migrationMissing: missing, conflict: conflict === true, error: error ?? 'no row returned' }
  }
  scoutLog({ run_id: row.id, scout_kind: kindLabel(kind), event: 'enqueued', detail: input.label ?? null })
  return { runId: row.id, claimToken: token, durable: true, migrationMissing: false, conflict: false, error: null }
}

/**
 * Count a dispatch attempt for the current leg BEFORE it is sent, guarded on
 * the count we read — so two sweeps racing over one row cannot both bump and
 * both dispatch. `won: false` means the other sweep got there first and will
 * dispatch; the caller must not.
 */
export async function noteDispatchAttempt(runId: string, opts: { db?: RunStoreDb; now?: number } = {}): Promise<{ attempt: number; won: boolean; error: string | null }> {
  const db = opts.db ?? liveRunStoreDb()
  const now = new Date(opts.now ?? Date.now()).toISOString()
  const before = await db.getRun(runId)
  if (before.error || !before.row) return { attempt: 0, won: false, error: before.error ?? 'run not found' }
  const current = Math.max(0, before.row.attempt_count ?? 0)
  const attempt = current + 1
  // Guarded on the count we read when the row carries one; a pre-020 row (no
  // column) or a fake without it is bumped on status alone.
  const guard: Record<string, unknown> = typeof before.row.attempt_count === 'number' ? { status: 'queued', attempt_count: current } : { status: 'queued' }
  const { rows, error } = await db.patchRun(runId, { attempt_count: attempt, last_dispatch_at: now }, guard)
  if (error) {
    // Pre-020: no counter to keep. The dispatch still goes out, uncounted.
    await db.patchRun(runId, { heartbeat_at: now }, { status: 'queued' }).catch(() => undefined)
    return { attempt, won: true, error: null }
  }
  return { attempt, won: rows.length > 0, error: null }
}

/**
 * Record how a dispatch settled, ON THE ROW, from whichever caller made it —
 * the enqueue route, the poll, the watchdog, or a finishing leg. A failed
 * dispatch used to live only in a log line that the platform discards within
 * the hour; the founder then read a fabricated sentence off the row. Guarded
 * on the run still being queued: a claim that landed in between wins.
 */
export async function recordDispatchOutcome(
  runId: string,
  settled: DispatchSettled,
  opts: { db?: RunStoreDb; now?: number; attempt?: number | null; source?: string } = {}
): Promise<{ recorded: boolean }> {
  const db = opts.db ?? liveRunStoreDb()
  const nowMs = opts.now ?? Date.now()
  const iso = new Date(nowMs).toISOString()
  const before = await db.getRun(runId)
  if (before.error || !before.row || before.row.status !== 'queued') return { recorded: false }
  const prior = readProgress(before.row)
  const detail =
    settled.outcome === 'accepted' || settled.outcome === 'claimed_elsewhere'
      ? `a worker accepted the run (${Math.round(settled.latencyMs / 1000)}s)`
      : settled.outcome === 'pending'
        ? `dispatch sent (${opts.source ?? 'dispatch'}); waiting for a worker to claim it`
        : `dispatch ${opts.attempt ? `attempt ${opts.attempt} ` : ''}failed: ${settled.error ?? 'no reason given'}`
  const progress: ScoutRunProgress = {
    ...prior,
    detail,
    events: [...prior.events.slice(-(PROGRESS_EVENT_LIMIT - 1)), { at: iso, stage: 'dispatch', detail }],
  }
  const patch: Record<string, unknown> = { progress }
  if (settled.outcome === 'failed') {
    const err = scoutError('DISPATCH', settled.error ?? 'the worker could not be reached', { httpStatus: settled.status ?? null, attempt: opts.attempt ?? null })
    const row = toRowError(err)
    patch.last_error = row.error
    patch.error_code = row.error_code
    patch.error_detail = { ...row.error_detail, source: opts.source ?? 'dispatch' }
  }
  const { rows, error } = await db.patchRun(runId, patch, { status: 'queued' })
  if (error) {
    // Older schema: at least the sentence, in the progress payload.
    const { rows: r2 } = await db.patchRun(runId, { progress }, { status: 'queued' })
    return { recorded: r2.length > 0 }
  }
  return { recorded: rows.length > 0 }
}

/**
 * Has a worker taken the run yet? Acceptance is observed on the ROW, not
 * inferred from an HTTP answer: the worker executes inside its POST and only
 * responds at the end, so the request stays in flight for minutes. What the
 * dispatcher needs to know — did a worker claim it — is one column.
 */
export async function awaitClaim(
  runId: string,
  opts: { db?: RunStoreDb; timeoutMs?: number; intervalMs?: number } = {}
): Promise<{ claimed: boolean; status: string | null; waitedMs: number }> {
  const db = opts.db ?? liveRunStoreDb()
  const started = Date.now()
  const timeout = opts.timeoutMs ?? 12_000
  const interval = opts.intervalMs ?? 1_500
  for (;;) {
    const { row } = await db.getRun(runId)
    const status = row?.status ?? null
    if (row && status !== 'queued') return { claimed: status === 'running' || Boolean(row.worker_started_at), status, waitedMs: Date.now() - started }
    if (Date.now() - started >= timeout) return { claimed: false, status, waitedMs: Date.now() - started }
    await new Promise((r) => setTimeout(r, interval))
  }
}

// ─── Claim ───────────────────────────────────────────────────────────────────

export interface ClaimResult {
  claimed: boolean
  run: ScoutRunRow | null
  params: Record<string, unknown> | null
  /** The People Scout's resume state, when the row carries one. */
  checkpoint: Record<string, unknown> | null
  /** Which leg of the run this claim starts. 1 on a first pass. */
  invocation: number
  /** The id this worker must present on every later write. */
  workerId: string | null
  /** The instant this leg promised to be finished by. */
  deadlineAt: number
  migrationMissing: boolean
  error: string | null
}

export function newWorkerId(): string {
  return `w_${randomBytes(6).toString('base64url')}`
}

/**
 * queued → running, guarded on BOTH the status and the token, in one statement.
 * The token is consumed (set null), so a duplicate dispatch — the same worker
 * fetched twice, or a CLI racing a browser — claims nothing and does no work.
 *
 * The claim records the leg's deadline, its lease and its worker id on the
 * row. The deadline is what a lease-less reader holds the run to; the lease is
 * what a live worker renews; the id is what every later write is fenced on.
 * `deadlineAt` should be computed from the HANDLER'S ENTRY, not from now: the
 * platform's ceiling counts from the request, and a slow claim must not push
 * the promised finish past the kill.
 */
export async function claimScoutRun(
  runId: string,
  token: string,
  db: RunStoreDb = liveRunStoreDb(),
  opts: { deadlineMs?: number; deadlineAt?: number; now?: number; workerId?: string } = {}
): Promise<ClaimResult> {
  const nowMs = opts.now ?? Date.now()
  const now = new Date(nowMs).toISOString()
  const deadlineAtMs = opts.deadlineAt ?? nowMs + (opts.deadlineMs ?? invocationBudgetMs())
  const deadlineAt = new Date(deadlineAtMs).toISOString()
  const workerId = opts.workerId ?? newWorkerId()
  const nope = (error: string | null, migrationMissing = false): ClaimResult => ({ claimed: false, run: null, params: null, checkpoint: null, invocation: 0, workerId: null, deadlineAt: deadlineAtMs, migrationMissing, error })

  // The leg number and the checkpoint need the row; the token guard keeps the claim atomic.
  const before = await db.getRun(runId, null, { full: true })
  if (before.error) return nope(before.error, isMissingSchema(before.error))
  if (!before.row) return nope('run not found')
  const invocation = Math.max(0, before.row.invocation_count ?? 0) + 1
  const prior = readProgress(before.row)

  const progress: ScoutRunProgress = {
    stage: 'starting',
    detail: invocation > 1 ? `pass ${invocation}: a worker picked the run back up` : 'a worker claimed the run',
    counts: { ...prior.counts },
    // Keep the tail of the previous leg's events so the story reads across passes.
    events: [...prior.events.slice(-Math.floor(PROGRESS_EVENT_LIMIT / 2)), { at: now, stage: 'starting', detail: invocation > 1 ? `pass ${invocation} started` : 'a worker claimed the run' }],
    deadline_at: deadlineAt,
    invocation,
  }
  const { rows, error } = await db.patchRun(
    runId,
    {
      status: 'running',
      worker_started_at: now,
      claimed_at: now,
      heartbeat_at: now,
      lease_expires_at: new Date(nowMs + LEASE_MS).toISOString(),
      worker_id: workerId,
      invocation_count: invocation,
      claim_token: null,
      stage: 'starting',
      error: null,
      progress,
    },
    { status: 'queued', claim_token: token }
  )
  if (error) return nope(error, isMissingSchema(error))
  const row = rows[0]
  if (!row) return nope('run is not queued, or the claim token is wrong')
  // Seed this LEG's progress cache so the first recordProgress carries the
  // deadline and this event forward instead of overwriting them.
  progressCache.set(cacheKeyFor(runId, workerId), { lastWriteAt: nowMs, stage: 'starting', events: [...progress.events], counts: { ...progress.counts }, deadlineAt, invocation })
  // The one place the real queue wait is knowable: the gap between the row
  // being (re)queued and a worker winning the claim.
  const queuedAt = Date.parse(String(row.queued_at ?? row.started_at ?? ''))
  const queueWaitMs = Number.isFinite(queuedAt) ? Math.max(0, nowMs - queuedAt) : null
  scoutLog({
    run_id: runId,
    scout_kind: kindLabel(row.kind),
    invocation,
    event: 'claimed',
    queue_wait_ms: queueWaitMs,
    attempt: (row.attempt_count ?? 0) || null,
    worker: workerId,
    deadline_ms: deadlineAtMs - nowMs,
  })
  const checkpoint = before.row.checkpoint && typeof before.row.checkpoint === 'object' ? (before.row.checkpoint as Record<string, unknown>) : null
  return { claimed: true, run: row, params: (row.params as Record<string, unknown> | null) ?? {}, checkpoint, invocation, workerId, deadlineAt: deadlineAtMs, migrationMissing: false, error: null }
}

// ─── Progress ────────────────────────────────────────────────────────────────

interface ProgressCache {
  lastWriteAt: number
  stage: string | null
  events: ScoutRunProgressEvent[]
  counts: Record<string, number>
  deadlineAt: string | null
  invocation: number | null
}

/** Keyed PER LEG. Two legs of one run on one instance never share or wipe each other's state. */
const progressCache = new Map<string, ProgressCache>()

function cacheKeyFor(runId: string, workerId?: string | null): string {
  return workerId ? `${runId}:${workerId}` : runId
}

/** Test seam, and hygiene after a leg finishes. Without a worker id, every leg of the run. */
export function resetProgressCache(runId?: string, workerId?: string | null): void {
  if (!runId) {
    progressCache.clear()
    return
  }
  if (workerId) {
    progressCache.delete(cacheKeyFor(runId, workerId))
    return
  }
  for (const key of [...progressCache.keys()]) if (key === runId || key.startsWith(`${runId}:`)) progressCache.delete(key)
}

export interface ProgressInput {
  stage: string
  detail?: string
  counts?: Record<string, number>
}

export interface ProgressResult {
  written: boolean
  /** The guarded update matched nothing: the run is no longer 'running' under this worker. */
  notRunning: boolean
  /**
   * Somebody pressed Cancel while this run was working.
   *
   * Read off the row the update RETURNED rather than by polling: the write was
   * happening anyway, so cancellation costs nothing extra and arrives at the
   * next progress tick. On a pre-020 database the column is absent, which reads
   * as false — cancelling a running scout then needs the migration, and
   * `cancelScoutRun` says so rather than pretending it worked.
   */
  cancelRequested: boolean
  progress: ScoutRunProgress
  migrationMissing: boolean
  error: string | null
}

/** The fence every worker write uses: still running, and still MY leg. */
function workerGuard(workerId?: string | null): Record<string, unknown> {
  return workerId ? { status: 'running', worker_id: workerId } : { status: 'running' }
}

/**
 * The orchestrator calls this on EVERY progress event, so it must be cheap:
 * the event list is kept in memory and written at most once per
 * PROGRESS_MIN_INTERVAL_MS — except on a stage change, which always writes,
 * because the stage is what the user is reading.
 *
 * Every write renews the lease. A guard that matches nothing is not an error
 * and not a write: PostgREST answers `{ data: [], error: null }` for it. It
 * means somebody else closed (or took over) this run, and `notRunning` says so
 * rather than leaving the worker to believe it is still being watched.
 */
export async function recordProgress(
  runId: string,
  input: ProgressInput,
  opts: { db?: RunStoreDb; now?: number; force?: boolean; workerId?: string | null } = {}
): Promise<ProgressResult> {
  const now = opts.now ?? Date.now()
  const detail = (input.detail ?? '').slice(0, MAX_DETAIL)
  const key = cacheKeyFor(runId, opts.workerId)
  const cache = progressCache.get(key) ?? { lastWriteAt: 0, stage: null, events: [], counts: {}, deadlineAt: null, invocation: null }
  const stageChanged = cache.stage !== input.stage
  cache.events.push({ at: new Date(now).toISOString(), stage: input.stage, detail })
  if (cache.events.length > PROGRESS_EVENT_LIMIT) cache.events.splice(0, cache.events.length - PROGRESS_EVENT_LIMIT)
  if (input.counts) cache.counts = { ...cache.counts, ...input.counts }
  cache.stage = input.stage
  progressCache.set(key, cache)

  const progress: ScoutRunProgress = { stage: input.stage, detail, counts: { ...cache.counts }, events: [...cache.events], deadline_at: cache.deadlineAt, invocation: cache.invocation }
  const due = opts.force || stageChanged || now - cache.lastWriteAt >= PROGRESS_MIN_INTERVAL_MS
  if (!due) return { written: false, notRunning: false, cancelRequested: false, progress, migrationMissing: false, error: null }

  cache.lastWriteAt = now
  const db = opts.db ?? liveRunStoreDb()
  const { rows, error } = await db.patchRun(
    runId,
    { stage: input.stage, progress, heartbeat_at: new Date(now).toISOString(), lease_expires_at: new Date(now + LEASE_MS).toISOString() },
    workerGuard(opts.workerId)
  )
  if (error) return { written: false, notRunning: false, cancelRequested: false, progress, migrationMissing: isMissingSchema(error), error }
  if (rows.length === 0) return { written: false, notRunning: true, cancelRequested: false, progress, migrationMissing: false, error: 'the run is no longer running under this worker' }
  return { written: true, notRunning: false, cancelRequested: rows[0]?.cancel_requested === true, progress, migrationMissing: false, error: null }
}

export interface TouchResult {
  ok: boolean
  /** The guarded update matched nothing: the run is no longer 'running' under this worker. */
  notRunning: boolean
  /** Somebody pressed Cancel. Read off the row the update returned, so a silent stage still learns it. */
  cancelRequested: boolean
  migrationMissing: boolean
  error: string | null
}

/**
 * "The worker is still alive" — a heartbeat that renews the lease and reports
 * nothing else.
 *
 * The orchestrator is silent for minutes at a time (one live planner call took
 * 226s; ranking a dozen jobs says nothing at all), so without this the only
 * thing separating a working run from a dead one would be the deadline. A
 * worker calls this on a timer while it works, and `lease_expires_at` goes on
 * meaning what it says.
 *
 * It appends NO event: a tick is not progress, and flooding the bounded event
 * list with "still working" would push out the forty lines that are.
 */
export async function touchScoutRun(runId: string, opts: { db?: RunStoreDb; now?: number; workerId?: string | null } = {}): Promise<TouchResult> {
  const db = opts.db ?? liveRunStoreDb()
  const nowMs = opts.now ?? Date.now()
  const { rows, error } = await db.patchRun(
    runId,
    { heartbeat_at: new Date(nowMs).toISOString(), lease_expires_at: new Date(nowMs + LEASE_MS).toISOString() },
    workerGuard(opts.workerId)
  )
  if (error) return { ok: false, notRunning: false, cancelRequested: false, migrationMissing: isMissingSchema(error), error }
  return { ok: rows.length > 0, notRunning: rows.length === 0, cancelRequested: rows[0]?.cancel_requested === true, migrationMissing: false, error: rows.length ? null : 'the run is no longer running under this worker' }
}

// ─── Cursor, checkpoint, result ──────────────────────────────────────────────

export interface WriteResult {
  ok: boolean
  /** The guarded update matched nothing: the run is no longer active under this worker. */
  notRunning: boolean
  migrationMissing: boolean
  error: string | null
}

/**
 * Write where a JOB SCOUT run has GOT TO onto its own row.
 *
 * It is merged onto the run's EXISTING params — the cursor says what is done,
 * never what the run is — and mirrored into `progress` so the reader has two
 * places to find it and the UI can show the pass number. Fenced on this
 * worker's leg unless `force` (a finishing write that has already closed the
 * row and needs the final cursor on it regardless).
 */
export async function recordRunCursor(
  runId: string,
  cursor: Record<string, unknown>,
  opts: { db?: RunStoreDb; force?: boolean; workerId?: string | null } = {}
): Promise<WriteResult> {
  const db = opts.db ?? liveRunStoreDb()
  const before = await db.getRun(runId)
  if (before.error) return { ok: false, notRunning: false, migrationMissing: isMissingSchema(before.error), error: before.error }
  if (!before.row) return { ok: false, notRunning: true, migrationMissing: false, error: 'run not found' }
  const params = (before.row.params && typeof before.row.params === 'object' ? (before.row.params as Record<string, unknown>) : {}) as Record<string, unknown>
  const progress = (before.row.progress && typeof before.row.progress === 'object' ? (before.row.progress as Record<string, unknown>) : {}) as Record<string, unknown>
  const { rows, error } = await db.patchRun(
    runId,
    { params: { ...params, cursor }, progress: { ...progress, cursor } },
    opts.force ? undefined : workerGuard(opts.workerId)
  )
  if (error) return { ok: false, notRunning: false, migrationMissing: isMissingSchema(error), error }
  return { ok: rows.length > 0, notRunning: rows.length === 0, migrationMissing: false, error: rows.length ? null : 'the run is no longer running under this worker' }
}

/**
 * Write a PEOPLE SCOUT run's stage checkpoint onto its own column.
 *
 * The checkpoint is what a later invocation resumes from — every stage output
 * the run has already paid for — so it is written at stage boundaries and,
 * throttled, inside the long stages. It is never returned to a poll.
 */
export async function recordRunCheckpoint(
  runId: string,
  checkpoint: Record<string, unknown>,
  opts: { db?: RunStoreDb; force?: boolean; workerId?: string | null } = {}
): Promise<WriteResult> {
  const db = opts.db ?? liveRunStoreDb()
  const { rows, error } = await db.patchRun(runId, { checkpoint }, opts.force ? undefined : workerGuard(opts.workerId))
  if (error) return { ok: false, notRunning: false, migrationMissing: isMissingSchema(error), error }
  return { ok: rows.length > 0, notRunning: rows.length === 0, migrationMissing: false, error: rows.length ? null : 'the run is no longer running under this worker' }
}

/**
 * Write what a PEOPLE SCOUT run has PRODUCED so far — the payload the page
 * renders. Written after the internal phase, after each ranked person and at
 * the end, so a run that stops short still shows its prospects. Fenced like
 * every other worker write unless `force` (the finishing write).
 */
export async function recordRunResult(
  runId: string,
  result: Record<string, unknown>,
  opts: { db?: RunStoreDb; force?: boolean; workerId?: string | null } = {}
): Promise<WriteResult> {
  const db = opts.db ?? liveRunStoreDb()
  const { rows, error } = await db.patchRun(runId, { result }, opts.force ? undefined : workerGuard(opts.workerId))
  if (error) return { ok: false, notRunning: false, migrationMissing: isMissingSchema(error), error }
  return { ok: rows.length > 0, notRunning: rows.length === 0, migrationMissing: false, error: rows.length ? null : 'the run is no longer running under this worker' }
}

// ─── Handoff ─────────────────────────────────────────────────────────────────

export interface HandoffResult {
  ok: boolean
  claimToken: string | null
  /** The run was refused another leg: its whole-run clock or its leg cap is spent, or it was cancelled. */
  refused: 'run_deadline' | 'max_invocations' | 'cancelled' | 'not_running' | null
  invocation: number
  error: string | null
}

/**
 * running → queued, for the NEXT invocation — in ONE fenced statement that
 * also carries the last checkpoint / cursor / result, so a kill between "save
 * where I got to" and "hand it back" cannot happen.
 *
 * The row is re-stamped as freshly queued (`queued_at`, `attempt_count`,
 * `heartbeat_at`), so the watchdog judges the wait for pass N+1 from the
 * handoff, never from the original enqueue. A run whose whole-run clock or leg
 * cap is spent, or that was cancelled meanwhile, is refused — the caller then
 * finishes it as partial or cancelled instead.
 */
export async function handoffScoutRun(
  runId: string,
  opts: {
    db?: RunStoreDb
    now?: number
    workerId?: string | null
    reason?: string
    /** Job Scout: the cursor to carry (merged onto params). */
    cursor?: Record<string, unknown> | null
    /** People Scout: the checkpoint to carry. */
    checkpoint?: Record<string, unknown> | null
    /** People Scout: the result so far. */
    result?: Record<string, unknown> | null
    stats?: Record<string, unknown> | null
  } = {}
): Promise<HandoffResult> {
  const db = opts.db ?? liveRunStoreDb()
  const nowMs = opts.now ?? Date.now()
  const now = new Date(nowMs).toISOString()
  const before = await db.getRun(runId)
  if (before.error || !before.row) return { ok: false, claimToken: null, refused: 'not_running', invocation: 0, error: before.error ?? 'run not found' }
  const row = before.row
  const invocation = Math.max(0, row.invocation_count ?? 0)
  if (row.cancel_requested) return { ok: false, claimToken: null, refused: 'cancelled', invocation, error: null }
  const deadline = Date.parse(String(row.run_deadline_at ?? ''))
  if (Number.isFinite(deadline) && nowMs >= deadline) return { ok: false, claimToken: null, refused: 'run_deadline', invocation, error: null }
  if (invocation >= MAX_INVOCATIONS) return { ok: false, claimToken: null, refused: 'max_invocations', invocation, error: null }

  const token = newClaimToken()
  const key = cacheKeyFor(runId, opts.workerId)
  const cache = progressCache.get(key)
  const detail = opts.reason ?? `pass ${invocation} reached its time limit — queued for pass ${invocation + 1}`
  const priorProgress = readProgress(row)
  const progress: ScoutRunProgress = {
    stage: 'queued',
    detail,
    counts: { ...(cache?.counts ?? priorProgress.counts) },
    events: [...(cache?.events ?? priorProgress.events).slice(-(PROGRESS_EVENT_LIMIT - 1)), { at: now, stage: 'queued', detail }],
    deadline_at: null,
    invocation,
  }
  const params = (row.params && typeof row.params === 'object' ? (row.params as Record<string, unknown>) : {}) as Record<string, unknown>
  const priorStats = (row.stats && typeof row.stats === 'object' ? (row.stats as Record<string, unknown>) : {}) as Record<string, unknown>
  const { rows, error } = await db.patchRun(
    runId,
    {
      status: 'queued',
      stage: 'queued',
      claim_token: token,
      queued_at: now,
      attempt_count: 0,
      last_dispatch_at: null,
      heartbeat_at: now,
      worker_id: null,
      lease_expires_at: null,
      progress: opts.cursor ? { ...progress, cursor: opts.cursor } : progress,
      ...(opts.cursor ? { params: { ...params, cursor: opts.cursor } } : {}),
      ...(opts.checkpoint ? { checkpoint: opts.checkpoint } : {}),
      ...(opts.result ? { result: opts.result } : {}),
      ...(opts.stats ? { stats: { ...priorStats, ...opts.stats } } : {}),
    },
    workerGuard(opts.workerId)
  )
  progressCache.delete(key)
  if (error) return { ok: false, claimToken: null, refused: null, invocation, error }
  if (rows.length === 0) return { ok: false, claimToken: null, refused: 'not_running', invocation, error: 'the run is no longer running under this worker' }
  // Cancel may have arrived on the very row we just re-queued; the caller
  // must not dispatch it, and the watchdog would cancel it anyway.
  if (rows[0]?.cancel_requested) return { ok: true, claimToken: null, refused: 'cancelled', invocation, error: null }
  scoutLog({ run_id: runId, scout_kind: kindLabel(row.kind), invocation, event: 'handoff', detail })
  return { ok: true, claimToken: token, refused: null, invocation, error: null }
}

// ─── Finish ──────────────────────────────────────────────────────────────────

export interface FinishInput {
  stats?: Record<string, unknown> | null
  error?: string | null
  /** The stable cause. Written to `error_code` / `error_detail` (migration 021). */
  errorCode?: ScoutErrorCode | null
  errorDetail?: Record<string, unknown> | null
  /** A People Scout's final payload, when the caller has one. */
  result?: Record<string, unknown> | null
  /** Replace the stats blob instead of merging onto what the run already wrote. */
  replaceStats?: boolean
  /** Close the run even if it is already terminal. A reaped run is overridden anyway. */
  force?: boolean
  /** The leg finishing. Fences the write: a late finish from an earlier leg matches nothing. */
  workerId?: string | null
}

export interface FinishResult {
  ok: boolean
  /** The run was already terminal and this call did not change it. */
  alreadyTerminal: boolean
  /** The run had been reaped and the worker's real outcome replaced that guess. */
  overrodeReap: boolean
  migrationMissing: boolean
  error: string | null
}

/** Build a FinishInput from a ScoutError: sentence, code and bounded detail in one go. */
export function finishFromError(e: ScoutError, extra: Omit<FinishInput, 'error' | 'errorCode' | 'errorDetail'> = {}): FinishInput {
  const row = toRowError(e)
  return { ...extra, error: row.error, errorCode: row.error_code, errorDetail: row.error_detail }
}

/**
 * Close a run. Guarded on the run still being active — and, when the caller
 * names its leg, on that leg still owning the row — so a worker cannot move a
 * run out of a terminal status by accident and a straggling earlier leg cannot
 * close a later one. One deliberate exception: a run the REAPER closed is a
 * guess ("the worker stopped responding"), and the worker of THAT leg turning
 * up with the real outcome is better information, so it wins and says so in
 * the error line. A 'cancelled' run is never reopened: that is a human
 * decision. A reap of a LATER leg is never overridden by an earlier one.
 *
 * `stats` merges onto whatever the run already wrote (the CareerRun's own
 * finish records `cost_usd` and `agent_calls` first), so one shape of stats
 * exists whether a run came from the web worker, the CLI or a legacy path.
 */
export async function finishScoutRun(
  runId: string,
  status: Exclude<ScoutRunStatus, 'queued' | 'running'>,
  input: FinishInput = {},
  db: RunStoreDb = liveRunStoreDb()
): Promise<FinishResult> {
  const now = new Date().toISOString()
  const key = cacheKeyFor(runId, input.workerId)
  const cache = progressCache.get(key)

  const before = await db.getRun(runId)
  if (before.error) {
    return { ok: false, alreadyTerminal: false, overrodeReap: false, migrationMissing: isMissingSchema(before.error), error: before.error }
  }

  const priorStats = (before.row?.stats && typeof before.row.stats === 'object' ? (before.row.stats as Record<string, unknown>) : {}) as Record<string, unknown>
  const stats = input.stats == null ? undefined : input.replaceStats ? input.stats : { ...priorStats, ...input.stats }

  const patch: Record<string, unknown> = {
    status,
    completed_at: now,
    heartbeat_at: now,
    claim_token: null,
    worker_id: null,
    lease_expires_at: null,
    ...(stats !== undefined ? { stats } : {}),
    ...(input.error !== undefined ? { error: input.error, ...(input.error ? { last_error: input.error } : {}) } : {}),
    ...(input.errorCode !== undefined ? { error_code: input.errorCode } : {}),
    ...(input.errorDetail !== undefined ? { error_detail: input.errorDetail } : {}),
    ...(input.result !== undefined && input.result !== null ? { result: input.result } : {}),
    ...(cache
      ? {
          progress: {
            stage: cache.stage,
            detail: cache.events[cache.events.length - 1]?.detail ?? null,
            counts: { ...cache.counts },
            events: [...cache.events],
            deadline_at: cache.deadlineAt,
            invocation: cache.invocation,
          } satisfies ScoutRunProgress,
        }
      : {}),
  }

  // Active, and — when a leg is named — still that leg's row. A queued row is
  // finishable by its own leg only through the watchdog's failQueuedRun; a
  // worker finishing its running leg is the normal case.
  const guard: Record<string, unknown> = input.workerId && !input.force ? { status: [...ACTIVE_STATUSES], worker_id: input.workerId } : { status: [...ACTIVE_STATUSES] }
  const first = await db.patchRun(runId, patch, guard)
  if (first.error) {
    return { ok: false, alreadyTerminal: false, overrodeReap: false, migrationMissing: isMissingSchema(first.error), error: first.error }
  }
  if (first.rows.length > 0) {
    progressCache.delete(key)
    scoutLog({ run_id: runId, scout_kind: kindLabel(before.row?.kind), invocation: cache?.invocation ?? null, event: 'finished', terminal_status: status, error_code: input.errorCode ?? null, error: input.error ?? null })
    return { ok: true, alreadyTerminal: false, overrodeReap: false, migrationMissing: false, error: null }
  }

  // Nothing matched: the run is already terminal, owned by another leg, or
  // gone. Re-read, because whatever changed it did so after `before`.
  const current = (await db.getRun(runId)).row
  if (!current) {
    progressCache.delete(key)
    return { ok: false, alreadyTerminal: false, overrodeReap: false, migrationMissing: false, error: 'run not found' }
  }
  if ((ACTIVE_STATUSES as string[]).includes(current.status)) {
    // Another leg owns it now. This finish is a straggler and must not land.
    progressCache.delete(key)
    return { ok: false, alreadyTerminal: false, overrodeReap: false, migrationMissing: false, error: `run is now owned by another worker (leg ${current.invocation_count ?? '?'})` }
  }
  const reapedAt = readProgress(current).reaped_at ?? null
  const laterLeg = input.workerId && cache?.invocation != null && (current.invocation_count ?? 0) > cache.invocation
  const overridable = current.status !== 'cancelled' && !laterLeg && (input.force === true || Boolean(reapedAt))
  if (!overridable) {
    progressCache.delete(key)
    return { ok: false, alreadyTerminal: true, overrodeReap: false, migrationMissing: false, error: `run is already '${current.status}'` }
  }

  // The reaper's verdict was a guess about a worker that had gone quiet; the
  // worker itself is better information. The reap is kept in the progress
  // payload and named in the error line — never erased.
  const note = reapedAt ? `declared dead by the reaper at ${reapedAt}, then finished by its own worker` : null
  const second = await db.patchRun(
    runId,
    {
      ...patch,
      ...(reapedAt && patch.progress ? { progress: { ...(patch.progress as ScoutRunProgress), reaped_at: reapedAt } } : {}),
      error: [input.error ?? null, note].filter(Boolean).join(' — ') || null,
    },
    { status: current.status }
  )
  progressCache.delete(key)
  if (second.error) {
    return { ok: false, alreadyTerminal: true, overrodeReap: false, migrationMissing: isMissingSchema(second.error), error: second.error }
  }
  return { ok: second.rows.length > 0, alreadyTerminal: true, overrodeReap: second.rows.length > 0, migrationMissing: false, error: null }
}

/**
 * Close a QUEUED run that nothing will ever start, with the real reason.
 * Conditional on still being queued: if a worker claimed it a moment ago the
 * guard matches nothing and the worker keeps it — the resolution we want.
 */
export async function failQueuedRun(
  runId: string,
  err: ScoutError,
  opts: { db?: RunStoreDb; now?: number; status?: 'failed' | 'cancelled' | 'partial' } = {}
): Promise<boolean> {
  const db = opts.db ?? liveRunStoreDb()
  const iso = new Date(opts.now ?? Date.now()).toISOString()
  const status = opts.status ?? 'failed'
  const rowErr = toRowError(err)
  const before = await db.getRun(runId)
  const prior = before.row ? readProgress(before.row) : null
  const progress: ScoutRunProgress = {
    stage: status,
    detail: rowErr.error,
    counts: { ...(prior?.counts ?? {}) },
    events: [...(prior?.events ?? []).slice(-(PROGRESS_EVENT_LIMIT - 1)), { at: iso, stage: status, detail: rowErr.error }],
    invocation: prior?.invocation ?? null,
  }
  const full = {
    status,
    error: rowErr.error,
    last_error: rowErr.error,
    error_code: rowErr.error_code,
    error_detail: rowErr.error_detail,
    completed_at: iso,
    stage: status,
    claim_token: null,
    progress,
  }
  const { rows, error } = await db.patchRun(runId, full, { status: 'queued' })
  if (!error) {
    if (rows.length > 0) scoutLog({ run_id: runId, scout_kind: kindLabel(before.row?.kind), event: 'finished', terminal_status: status, error_code: rowErr.error_code, error: rowErr.error }, 'warn')
    return rows.length > 0
  }
  // Older databases lack some of these columns. Recovery matters more than the column.
  const { rows: rows2 } = await db.patchRun(runId, { status, error: rowErr.error, completed_at: iso, stage: status, claim_token: null, progress }, { status: 'queued' })
  return rows2.length > 0
}

// ─── Read ────────────────────────────────────────────────────────────────────

export async function getScoutRun(
  userId: string,
  runId: string,
  db: RunStoreDb = liveRunStoreDb(),
  opts: { full?: boolean } = {}
): Promise<{ run: ScoutRunRow | null; migrationMissing: boolean; error: string | null }> {
  const { row, error } = await db.getRun(runId, userId, opts)
  if (error) return { run: null, migrationMissing: isMissingSchema(error), error }
  return { run: row, migrationMissing: false, error: null }
}

export async function listActiveScoutRuns(
  userId: string,
  db: RunStoreDb = liveRunStoreDb(),
  limit = 5,
  kinds: string[] = [...DURABLE_KINDS]
): Promise<{ runs: ScoutRunRow[]; migrationMissing: boolean; error: string | null }> {
  const { rows, error } = await db.listRuns(userId, ACTIVE_STATUSES, limit, kinds)
  if (error) return { runs: [], migrationMissing: isMissingSchema(error), error }
  return { runs: rows, migrationMissing: false, error: null }
}

/**
 * The one DURABLE run of this kind that is already queued or running for this
 * user, if any. Both the page's "resume after a refresh" and the enqueue
 * route's "no second paid run without asking" read this, so they cannot
 * disagree about what counts as active.
 *
 * Durable only: a `manual add` or a company check writes a short inline
 * `job_scout` row with no token and no lease, and those must never block
 * "Scout now" or be handed to the monitor as the run to resume.
 */
export async function activeScoutRun(
  userId: string,
  kind: DurableScoutKind,
  db: RunStoreDb = liveRunStoreDb()
): Promise<{ run: ScoutRunRow | null; migrationMissing: boolean; error: string | null }> {
  const { runs, migrationMissing, error } = await listActiveScoutRuns(userId, db, 10, [kind])
  const run = runs.find((r) => (r.kind ?? 'job_scout') === kind && (ACTIVE_STATUSES as string[]).includes(r.status) && isDurableRow(r)) ?? null
  return { run, migrationMissing, error }
}

/** The Job Scout's active run. Kept for existing callers. */
export async function activeJobScoutRun(userId: string, db: RunStoreDb = liveRunStoreDb()) {
  return activeScoutRun(userId, 'job_scout', db)
}

export async function getRunJobCounts(userId: string, runId: string, db: RunStoreDb = liveRunStoreDb()): Promise<RunJobCounts> {
  const { counts } = await db.countJobs(runId, userId)
  return counts
}
