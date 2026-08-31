// Durable scout runs — the state machine of a run that outlives its request.
//
// A browser scout used to BE one HTTP request: the work, the progress and the
// result all lived inside it, so a refresh lost the run and Vercel's 300s
// function ceiling was the product's ceiling. After migration 016 a run is a
// row: the request that starts it only ENQUEUES it, a worker CLAIMS it with a
// single-use token, heartbeats while it works, and FINISHES it. The browser
// polls the row. Nothing about the run lives in React or in localStorage.
//
// This module owns the WRITES and nothing else. Its neighbours own the rest,
// and it re-exports them so callers still have one door:
//
//   run-record.ts    what a row means, and what the UI reads (pure)
//   run-store-db.ts  the five-method database port and its Supabase impl
//   run-dispatch.ts  what the worker will execute, and where the worker is
//   run-reaper.ts    closing the runs whose worker died (a policy, not a
//                    transition — it is imported directly, not re-exported,
//                    because it depends on this module)
//
// Migration 016 is applied by hand. Until it is, every function here reports
// `migrationMissing: true` / `durable: false` instead of throwing, and the
// caller falls back to the old synchronous path (app/api/career/scout).

import { randomBytes } from 'crypto'
import { isMissingSchema } from '@/lib/career/jobs/db'
import { scoutDeadlineMs } from './run-dispatch'
import {
  ACTIVE_STATUSES,
  MAX_DETAIL,
  PROGRESS_EVENT_LIMIT,
  PROGRESS_MIN_INTERVAL_MS,
  readProgress,
  type RunJobCounts,
  type ScoutRunProgress,
  type ScoutRunProgressEvent,
  type ScoutRunRow,
  type ScoutRunStatus,
} from './run-record'
import { liveRunStoreDb, type RunStoreDb } from './run-store-db'

export * from './run-record'
export { liveRunStoreDb, type RunStoreDb } from './run-store-db'

// ─── Enqueue ─────────────────────────────────────────────────────────────────

export interface EnqueueInput {
  missionId?: string | null
  /** The run parameters the worker will execute. Persisted verbatim. */
  params: Record<string, unknown>
  label?: string
}

export interface EnqueueResult {
  runId: string | null
  claimToken: string | null
  /** false when the row could not be created durably — the caller runs it synchronously instead. */
  durable: boolean
  migrationMissing: boolean
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
  const now = new Date().toISOString()
  const { row, error } = await db.insertRun({
    user_id: userId,
    kind: 'job_scout',
    label: input.label ?? 'job scout',
    mission: {},
    budget: {},
    status: 'queued',
    stage: 'queued',
    progress: {
      stage: 'queued',
      detail: 'waiting for a worker',
      counts: {},
      events: [{ at: now, stage: 'queued', detail: 'waiting for a worker' }],
    } satisfies ScoutRunProgress,
    params: input.params,
    claim_token: token,
    heartbeat_at: now,
    career_mission_id: input.missionId ?? null,
  })
  if (error || !row) {
    const missing = error ? isMissingSchema(error) : false
    return { runId: null, claimToken: null, durable: false, migrationMissing: missing, error: error ?? 'no row returned' }
  }
  return { runId: row.id, claimToken: token, durable: true, migrationMissing: false, error: null }
}

// ─── Claim ───────────────────────────────────────────────────────────────────

export interface ClaimResult {
  claimed: boolean
  run: ScoutRunRow | null
  params: Record<string, unknown> | null
  migrationMissing: boolean
  error: string | null
}

/**
 * queued → running, guarded on BOTH the status and the token, in one statement.
 * The token is consumed (set null), so a duplicate dispatch — the same worker
 * fetched twice, or a CLI racing a browser — claims nothing and does no work.
 *
 * The worker's deadline is recorded on the row here. That is what lets the
 * reaper tell "silent" from "dead": a run that has not yet reached the time it
 * promised to finish by is still working, however quiet it is. Pass the real
 * budget (the CLI's `--deadline` differs from the web worker's) so the row
 * records the promise that was actually made.
 */
export async function claimScoutRun(
  runId: string,
  token: string,
  db: RunStoreDb = liveRunStoreDb(),
  opts: { deadlineMs?: number; now?: number } = {}
): Promise<ClaimResult> {
  const nowMs = opts.now ?? Date.now()
  const now = new Date(nowMs).toISOString()
  const deadlineMs = opts.deadlineMs ?? scoutDeadlineMs()
  const deadlineAt = new Date(nowMs + deadlineMs).toISOString()
  const progress: ScoutRunProgress = {
    stage: 'starting',
    detail: 'a worker claimed the run',
    counts: {},
    events: [{ at: now, stage: 'starting', detail: 'a worker claimed the run' }],
    deadline_at: deadlineAt,
  }
  const { rows, error } = await db.patchRun(
    runId,
    { status: 'running', worker_started_at: now, heartbeat_at: now, claim_token: null, stage: 'starting', error: null, progress },
    { status: 'queued', claim_token: token }
  )
  if (error) return { claimed: false, run: null, params: null, migrationMissing: isMissingSchema(error), error }
  const row = rows[0]
  if (!row) return { claimed: false, run: null, params: null, migrationMissing: false, error: 'run is not queued, or the claim token is wrong' }
  // Seed the in-memory progress cache so the first recordProgress carries the
  // deadline and this event forward instead of overwriting them.
  progressCache.set(runId, { lastWriteAt: nowMs, stage: 'starting', events: [...progress.events], counts: {}, deadlineAt })
  return { claimed: true, run: row, params: (row.params as Record<string, unknown> | null) ?? {}, migrationMissing: false, error: null }
}

// ─── Progress ────────────────────────────────────────────────────────────────

interface ProgressCache {
  lastWriteAt: number
  stage: string | null
  events: ScoutRunProgressEvent[]
  counts: Record<string, number>
  deadlineAt: string | null
}

const progressCache = new Map<string, ProgressCache>()

/** Test seam, and hygiene after a run finishes. */
export function resetProgressCache(runId?: string): void {
  if (runId) progressCache.delete(runId)
  else progressCache.clear()
}

export interface ProgressInput {
  stage: string
  detail?: string
  counts?: Record<string, number>
}

export interface ProgressResult {
  written: boolean
  /** The guarded update matched nothing: the run is no longer 'running'. */
  notRunning: boolean
  progress: ScoutRunProgress
  migrationMissing: boolean
  error: string | null
}

/**
 * The orchestrator calls this on EVERY progress event, so it must be cheap:
 * the event list is kept in memory and written at most once per
 * PROGRESS_MIN_INTERVAL_MS — except on a stage change, which always writes,
 * because the stage is what the user is reading.
 *
 * The write is guarded on `status = 'running'`. A guard that matches nothing
 * is not an error and not a write: PostgREST answers `{ data: [], error: null }`
 * for it, so a function that only inspected `error` would report every
 * heartbeat as landing while writing nothing. It means somebody else closed
 * this run (the reaper, a cancel), and `notRunning` says so rather than
 * leaving the worker to believe it is still being watched.
 */
export async function recordProgress(
  runId: string,
  input: ProgressInput,
  opts: { db?: RunStoreDb; now?: number; force?: boolean } = {}
): Promise<ProgressResult> {
  const now = opts.now ?? Date.now()
  const detail = (input.detail ?? '').slice(0, MAX_DETAIL)
  const cache = progressCache.get(runId) ?? { lastWriteAt: 0, stage: null, events: [], counts: {}, deadlineAt: null }
  const stageChanged = cache.stage !== input.stage
  cache.events.push({ at: new Date(now).toISOString(), stage: input.stage, detail })
  if (cache.events.length > PROGRESS_EVENT_LIMIT) cache.events.splice(0, cache.events.length - PROGRESS_EVENT_LIMIT)
  if (input.counts) cache.counts = { ...cache.counts, ...input.counts }
  cache.stage = input.stage
  progressCache.set(runId, cache)

  const progress: ScoutRunProgress = { stage: input.stage, detail, counts: { ...cache.counts }, events: [...cache.events], deadline_at: cache.deadlineAt }
  const due = opts.force || stageChanged || now - cache.lastWriteAt >= PROGRESS_MIN_INTERVAL_MS
  if (!due) return { written: false, notRunning: false, progress, migrationMissing: false, error: null }

  cache.lastWriteAt = now
  const db = opts.db ?? liveRunStoreDb()
  const { rows, error } = await db.patchRun(
    runId,
    { stage: input.stage, progress, heartbeat_at: new Date(now).toISOString() },
    { status: 'running' }
  )
  if (error) return { written: false, notRunning: false, progress, migrationMissing: isMissingSchema(error), error }
  if (rows.length === 0) return { written: false, notRunning: true, progress, migrationMissing: false, error: 'the run is no longer running' }
  return { written: true, notRunning: false, progress, migrationMissing: false, error: null }
}

export interface TouchResult {
  ok: boolean
  /** The guarded update matched nothing: the run is no longer 'running'. */
  notRunning: boolean
  migrationMissing: boolean
  error: string | null
}

/**
 * "The worker is still alive" — a heartbeat with nothing to report.
 *
 * The orchestrator is silent for minutes at a time (one live planner call took
 * 226s; ranking a dozen jobs says nothing at all), so without this the only
 * thing separating a working run from a dead one is the deadline, which is 20
 * minutes off Vercel. A worker calls this on a timer while it works, and
 * `heartbeat_at` goes back to meaning what it says.
 *
 * It appends NO event: a tick is not progress, and flooding the bounded event
 * list with "still working" would push out the forty lines that are.
 */
export async function touchScoutRun(runId: string, opts: { db?: RunStoreDb; now?: number } = {}): Promise<TouchResult> {
  const db = opts.db ?? liveRunStoreDb()
  const now = new Date(opts.now ?? Date.now()).toISOString()
  const { rows, error } = await db.patchRun(runId, { heartbeat_at: now }, { status: 'running' })
  if (error) return { ok: false, notRunning: false, migrationMissing: isMissingSchema(error), error }
  return { ok: rows.length > 0, notRunning: rows.length === 0, migrationMissing: false, error: rows.length ? null : 'the run is no longer running' }
}

// ─── Finish ──────────────────────────────────────────────────────────────────

export interface FinishInput {
  stats?: Record<string, unknown> | null
  error?: string | null
  /** Replace the stats blob instead of merging onto what the run already wrote. */
  replaceStats?: boolean
  /** Close the run even if it is already terminal. A reaped run is overridden anyway. */
  force?: boolean
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

/**
 * Close a run. Guarded on the run still being active, so a worker cannot move
 * a run out of a terminal status by accident — with one deliberate exception:
 * a run the REAPER closed is a guess ("the worker stopped responding"), and a
 * worker turning up with the real outcome is better information, so it wins
 * and says so in the error line. A 'cancelled' run is never reopened: that one
 * is a human decision.
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
  const cache = progressCache.get(runId)

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
    ...(stats !== undefined ? { stats } : {}),
    ...(input.error !== undefined ? { error: input.error } : {}),
    ...(cache
      ? {
          progress: {
            stage: cache.stage,
            detail: cache.events[cache.events.length - 1]?.detail ?? null,
            counts: { ...cache.counts },
            events: [...cache.events],
            deadline_at: cache.deadlineAt,
          } satisfies ScoutRunProgress,
        }
      : {}),
  }

  const first = await db.patchRun(runId, patch, { status: [...ACTIVE_STATUSES] })
  if (first.error) {
    return { ok: false, alreadyTerminal: false, overrodeReap: false, migrationMissing: isMissingSchema(first.error), error: first.error }
  }
  if (first.rows.length > 0) {
    resetProgressCache(runId)
    return { ok: true, alreadyTerminal: false, overrodeReap: false, migrationMissing: false, error: null }
  }

  // Nothing matched: the run is already terminal (or gone). Re-read, because
  // whatever closed it did so after `before` was taken.
  const current = (await db.getRun(runId)).row
  if (!current) {
    resetProgressCache(runId)
    return { ok: false, alreadyTerminal: false, overrodeReap: false, migrationMissing: false, error: 'run not found' }
  }
  const reapedAt = readProgress(current).reaped_at ?? null
  const overridable = current.status !== 'cancelled' && (input.force === true || Boolean(reapedAt))
  if (!overridable) {
    resetProgressCache(runId)
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
  resetProgressCache(runId)
  if (second.error) {
    return { ok: false, alreadyTerminal: true, overrodeReap: false, migrationMissing: isMissingSchema(second.error), error: second.error }
  }
  return { ok: second.rows.length > 0, alreadyTerminal: true, overrodeReap: second.rows.length > 0, migrationMissing: false, error: null }
}

// ─── Read ────────────────────────────────────────────────────────────────────

export async function getScoutRun(
  userId: string,
  runId: string,
  db: RunStoreDb = liveRunStoreDb()
): Promise<{ run: ScoutRunRow | null; migrationMissing: boolean; error: string | null }> {
  const { row, error } = await db.getRun(runId, userId)
  if (error) return { run: null, migrationMissing: isMissingSchema(error), error }
  return { run: row, migrationMissing: false, error: null }
}

export async function listActiveScoutRuns(
  userId: string,
  db: RunStoreDb = liveRunStoreDb(),
  limit = 5
): Promise<{ runs: ScoutRunRow[]; migrationMissing: boolean; error: string | null }> {
  const { rows, error } = await db.listRuns(userId, ACTIVE_STATUSES, limit)
  if (error) return { runs: [], migrationMissing: isMissingSchema(error), error }
  return { runs: rows, migrationMissing: false, error: null }
}

/**
 * The one job scout that is already queued or running for this user, if any.
 * Both the Jobs page's "resume after a refresh" and the enqueue route's "no
 * second paid run without asking" read this, so they cannot disagree about
 * what counts as active.
 */
export async function activeJobScoutRun(
  userId: string,
  db: RunStoreDb = liveRunStoreDb()
): Promise<{ run: ScoutRunRow | null; migrationMissing: boolean; error: string | null }> {
  const { runs, migrationMissing, error } = await listActiveScoutRuns(userId, db)
  const run = runs.find((r) => (r.kind ?? 'job_scout') === 'job_scout' && (ACTIVE_STATUSES as string[]).includes(r.status)) ?? null
  return { run, migrationMissing, error }
}

export async function getRunJobCounts(userId: string, runId: string, db: RunStoreDb = liveRunStoreDb()): Promise<RunJobCounts> {
  const { counts } = await db.countJobs(runId, userId)
  return counts
}
