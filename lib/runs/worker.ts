// One worker invocation — a LEG — of a durable scout run, for either kind.
//
// The route hands this the body of the dispatch (`runId`, `token`) and the
// instant the handler was entered. Everything after that is here:
//
//   claim ──▶ one clock for the leg ──▶ execute (fenced writes, heartbeat,
//   last-resort timer) ──▶ finish, or hand off to the next leg and ask a
//   worker to take it, observing the claim on the row.
//
// The work executes INSIDE the worker's own POST. That is the proven path —
// a hosted function holds its request for the full function ceiling — and it
// depends on no platform internal. What the dispatcher needs to know ("did a
// worker take it?") is observed on the row, never inferred from HTTP.
//
// Every write this leg makes is fenced on the worker id it claimed with
// (lib/career/scout/run-store.ts). A leg the platform freezes mid-await and
// thaws later cannot touch a row the next leg now owns.
//
// Nothing here reads cookies or headers: there is no user session in a
// worker, and after the response Next's request stores are gone.

import { invocationBudgetMs, RunClock } from './deadline'
import { createRunContext, withRunContext, type RunContext } from './context'
import { classifyError, defaultRemedy, scoutError, type ScoutError, type ScoutErrorCode } from './errors'
import { scoutLog, type ScoutKind } from './log'
import {
  awaitClaim,
  claimScoutRun,
  finishFromError,
  finishScoutRun,
  handoffScoutRun,
  HEARTBEAT_MS,
  noteDispatchAttempt,
  recordDispatchOutcome,
  recordProgress,
  recordRunCheckpoint,
  recordRunCursor,
  recordRunResult,
  touchScoutRun,
  type DurableScoutKind,
  type RunStoreDb,
} from '@/lib/career/scout/run-store'
import { dispatchScoutWorker, resolveWorkerBase, type DispatchSettled, type WorkerBase } from '@/lib/career/scout/worker-target'

/** Kept back for the finishing writes of a leg: cursor/checkpoint, result, stats, status, handoff, dispatch. */
export const FINALIZE_RESERVE_MS: Record<DurableScoutKind, number> = { job_scout: 45_000, outreach: 60_000 }

/** How long a finishing leg waits to see the next leg claimed before leaving it to the poll and the watchdog. */
export const CHAIN_OBSERVE_MS = 10_000

/** Past the hard deadline by this much, the executor is abandoned and the leg finalised with what it has. */
export const LAST_RESORT_GRACE_MS = 5_000

export interface LegInput {
  runId: string
  userId: string
  kind: DurableScoutKind
  params: Record<string, unknown>
  /** The People Scout's resume state; null on a first leg. */
  checkpoint: Record<string, unknown> | null
  invocation: number
  workerId: string
  ctx: RunContext
  /** Report a stage. Cheap; throttled and fenced by the kernel. */
  onProgress: (stage: string, detail: string, counts?: Record<string, number>) => void
  /** Job Scout: the cursor moved. */
  onCursor: (cursor: Record<string, unknown>) => void
  /** People Scout: the checkpoint moved. */
  onCheckpoint: (checkpoint: Record<string, unknown>) => void
  /** People Scout: the result so far. */
  onResult: (result: Record<string, unknown>) => void
  /** True once the row asked the run to stop, or the row moved on. */
  shouldStop: () => boolean
}

export interface LegOutcome {
  status: 'succeeded' | 'partial' | 'failed' | 'cancelled'
  /** Work is left that a next leg can resume from the cursor / checkpoint. */
  continuable: boolean
  cursor?: Record<string, unknown> | null
  checkpoint?: Record<string, unknown> | null
  result?: Record<string, unknown> | null
  stats?: Record<string, unknown> | null
  error?: ScoutError | null
  errors: string[]
}

export interface LegExecutor {
  kind: DurableScoutKind
  execute(input: LegInput): Promise<LegOutcome>
}

export interface WorkerDeps {
  db?: RunStoreDb
  executors: Partial<Record<DurableScoutKind, LegExecutor>>
  /** Injected in tests; production dispatches over HTTP to resolveWorkerBase(null). */
  dispatch?: (target: WorkerBase, runId: string, token: string) => Promise<DispatchSettled & { dispatched: boolean }>
  /** Injected in tests. */
  target?: WorkerBase
  now?: () => number
  budgetMs?: number
}

export interface WorkerResponse {
  status: number
  body: Record<string, unknown>
}

function kindLabel(kind: string | null | undefined): ScoutKind {
  return (kind ?? 'job_scout') === 'outreach' ? 'people' : 'jobs'
}

/**
 * Execute one leg. Returns what the route answers with; never throws for a
 * run it claimed — a throw after the claim is a `failed` row with a code.
 */
export async function runWorkerLeg(body: { runId?: string; token?: string }, entryMs: number, deps: WorkerDeps): Promise<WorkerResponse> {
  if (!body.runId || !body.token) return { status: 400, body: { error: 'runId and token are required', code: 'VALIDATION' } }
  const now = deps.now ?? (() => Date.now())
  const budgetMs = deps.budgetMs ?? invocationBudgetMs()
  // The platform's ceiling counts from the request, so the leg's deadline does too.
  const deadlineAt = entryMs + budgetMs

  const claim = await claimScoutRun(body.runId, body.token, deps.db, { deadlineAt, now: now() })
  if (!claim.claimed || !claim.run || !claim.workerId) {
    // Already claimed, already finished, or the wrong token — all the same
    // answer, and never a retry: exactly one worker executes a leg. 409 tells
    // a dispatcher "somebody else has it", which is a success for the system.
    const status = claim.migrationMissing ? 503 : 409
    return { status, body: { error: claim.error ?? 'run is not claimable', code: claim.migrationMissing ? 'SCHEMA_MIGRATION' : 'CLAIM', claimed: false, migrationMissing: claim.migrationMissing } }
  }

  const runId = body.runId
  const workerId = claim.workerId
  const kind: DurableScoutKind = ((claim.run.kind ?? 'job_scout') as DurableScoutKind) === 'outreach' ? 'outreach' : 'job_scout'
  const userId = claim.run.user_id
  const executor = deps.executors[kind]
  const clock = new RunClock({ hardDeadlineAt: deadlineAt, finalizeReserveMs: FINALIZE_RESERVE_MS[kind], startedAt: entryMs, now })
  const ctx = createRunContext({ runId, kind: kindLabel(kind), invocation: claim.invocation, clock, label: claim.run.label ?? null })

  if (!executor) {
    const err = scoutError('INTERNAL', `no executor is registered for run kind '${kind}'`, { retryable: false, runId })
    await finishScoutRun(runId, 'failed', finishFromError(err, { workerId }), deps.db)
    return { status: 500, body: { runId, status: 'failed', error: err.message, code: err.code } }
  }

  return withRunContext(ctx, () => executeLeg({ runId, userId, kind, workerId, claim, executor, ctx, deps, deadlineAt, now }))
}

async function executeLeg(a: {
  runId: string
  userId: string
  kind: DurableScoutKind
  workerId: string
  claim: Awaited<ReturnType<typeof claimScoutRun>>
  executor: LegExecutor
  ctx: RunContext
  deps: WorkerDeps
  deadlineAt: number
  now: () => number
}): Promise<WorkerResponse> {
  const { runId, userId, kind, workerId, claim, executor, ctx, deps, deadlineAt, now } = a
  const db = deps.db
  const invocation = claim.invocation
  const log = (fields: Record<string, unknown>, level: 'log' | 'warn' | 'error' = 'log') => scoutLog({ run_id: runId, scout_kind: kindLabel(kind), invocation, ...fields }, level)

  // Every write rides one serialized chain: at most one in flight, in order,
  // so a burst of progress events cannot pile up and a checkpoint cannot race
  // its own predecessor.
  let chain: Promise<unknown> = Promise.resolve()
  let lostRun = false
  let cancelled = false
  let progressErrors = 0
  let latestCursor: Record<string, unknown> | null = null
  let latestCheckpoint: Record<string, unknown> | null = claim.checkpoint
  let latestResult: Record<string, unknown> | null = (claim.run?.result as Record<string, unknown> | null) ?? null
  let lastCheckpointWriteAt = 0
  let lastResultWriteAt = 0
  const WRITE_MIN_INTERVAL_MS = 10_000

  const enqueue = (fn: () => Promise<unknown>) => {
    chain = chain.then(fn).catch(() => undefined)
  }
  const noteWrite = (r: { notRunning?: boolean; cancelRequested?: boolean; error?: string | null }) => {
    if (r.notRunning) lostRun = true
    else if (r.cancelRequested) {
      cancelled = true
      ctx.cancelRequested = true
    } else if (r.error) progressErrors++
  }

  const onProgress = (stage: string, detail: string, counts?: Record<string, number>) => {
    enqueue(() => recordProgress(runId, { stage, detail, counts }, { db, workerId }).then(noteWrite))
  }
  const onCursor = (cursor: Record<string, unknown>) => {
    latestCursor = cursor
    const t = now()
    if (t - lastCheckpointWriteAt < WRITE_MIN_INTERVAL_MS) return
    lastCheckpointWriteAt = t
    enqueue(() => recordRunCursor(runId, cursor, { db, workerId }).then(noteWrite))
  }
  const onCheckpoint = (checkpoint: Record<string, unknown>) => {
    latestCheckpoint = checkpoint
    const t = now()
    if (t - lastCheckpointWriteAt < WRITE_MIN_INTERVAL_MS) return
    lastCheckpointWriteAt = t
    enqueue(() => recordRunCheckpoint(runId, checkpoint, { db, workerId }).then(noteWrite))
  }
  const onResult = (result: Record<string, unknown>) => {
    latestResult = result
    const t = now()
    if (t - lastResultWriteAt < WRITE_MIN_INTERVAL_MS) return
    lastResultWriteAt = t
    enqueue(() => recordRunResult(runId, result, { db, workerId }).then(noteWrite))
  }
  const shouldStop = () => cancelled || lostRun || ctx.cancelRequested

  // The pulse. Renews the lease every 30s whatever the stage is doing, and
  // learns about a cancel even during a silent stage.
  const beat = setInterval(() => {
    enqueue(() => touchScoutRun(runId, { db, workerId }).then(noteWrite))
  }, HEARTBEAT_MS)

  let outcome: LegOutcome
  let abandoned = false
  try {
    // The executor is cooperative: it stops starting work at the clock. The
    // last-resort timer is for the case it cannot stop — a stage inside an
    // await that ignores the clock — so the leg is still finalised with what
    // it has before the platform kills the function.
    const lastResort = new Promise<LegOutcome>((resolve) => {
      const ms = Math.max(0, deadlineAt + LAST_RESORT_GRACE_MS - now())
      setTimeout(() => {
        abandoned = true
        resolve({ status: 'partial', continuable: true, cursor: latestCursor, checkpoint: latestCheckpoint, result: latestResult, errors: ['the leg was abandoned at its hard deadline while a stage was still running'] })
      }, ms).unref?.()
    })
    outcome = await Promise.race([
      executor.execute({ runId, userId, kind, params: claim.params ?? {}, checkpoint: claim.checkpoint, invocation, workerId, ctx, onProgress, onCursor, onCheckpoint, onResult, shouldStop }),
      lastResort,
    ])
  } catch (e) {
    const code = classifyError(e)
    const message = e instanceof Error ? e.message : String(e)
    outcome = {
      status: 'failed',
      continuable: false,
      cursor: latestCursor,
      checkpoint: latestCheckpoint,
      result: latestResult,
      error: scoutError(code, message.slice(0, 500), { runId, remedy: defaultRemedy(code) }),
      errors: [message],
    }
    log({ event: 'leg_threw', error_code: code, error: message.slice(0, 300) }, 'error')
  } finally {
    clearInterval(beat)
  }
  await chain.catch(() => undefined)

  const finalCursor = outcome.cursor ?? latestCursor
  const finalCheckpoint = outcome.checkpoint ?? latestCheckpoint
  const finalResult = outcome.result ?? latestResult
  const errors = [...outcome.errors, ...(progressErrors ? [`${progressErrors} progress write(s) failed`] : []), ...(lostRun ? ['the run row was taken over or closed by something else while this worker was still working'] : [])]

  if (lostRun) {
    // Another leg or a reap owns the row now. Nothing this leg writes may land;
    // say so and stop. (Every write is fenced, so this is belt and braces.)
    log({ event: 'leg_lost', detail: 'row no longer owned by this worker' }, 'warn')
    return { status: 200, body: { runId, status: 'lost', invocation } }
  }

  // ─── Cancelled ─────────────────────────────────────────────────────────────
  if (cancelled || ctx.cancelRequested || outcome.status === 'cancelled') {
    const r = await finishScoutRun(
      runId,
      'cancelled',
      { workerId, stats: outcome.stats ?? undefined, result: finalResult, error: 'Cancelled while running; anything already found was kept.', errorCode: 'CANCELLED', errorDetail: { stage: ctx.clock ? undefined : undefined, retryable: false } },
      db
    )
    if (finalCursor) await recordRunCursor(runId, finalCursor, { db, force: true }).catch(() => undefined)
    if (finalCheckpoint) await recordRunCheckpoint(runId, finalCheckpoint, { db, force: true }).catch(() => undefined)
    log({ event: 'leg_done', terminal_status: 'cancelled', finished: r.ok })
    return { status: 200, body: { runId, status: 'cancelled', invocation, finished: r.ok } }
  }

  // ─── Failed ────────────────────────────────────────────────────────────────
  if (outcome.status === 'failed') {
    const err = outcome.error ?? scoutError('INTERNAL', errors[0] ?? 'the run failed', { runId })
    const r = await finishScoutRun(runId, 'failed', finishFromError(err, { workerId, stats: { ...(outcome.stats ?? {}), errors: errors.slice(0, 10) }, result: finalResult }), db)
    if (finalCursor) await recordRunCursor(runId, finalCursor, { db, force: true }).catch(() => undefined)
    if (finalCheckpoint) await recordRunCheckpoint(runId, finalCheckpoint, { db, force: true }).catch(() => undefined)
    log({ event: 'leg_done', terminal_status: 'failed', error_code: err.code, error: err.message.slice(0, 200), finished: r.ok }, 'warn')
    return { status: 200, body: { runId, status: 'failed', invocation, error: err.message, code: err.code, finished: r.ok } }
  }

  // ─── Work left: hand the run to the next leg ───────────────────────────────
  if (outcome.continuable) {
    const reason = abandoned ? `pass ${invocation} was cut off at its hard deadline — queued for pass ${invocation + 1}` : undefined
    const h = await handoffScoutRun(runId, { db, workerId, reason, cursor: finalCursor, checkpoint: finalCheckpoint, result: finalResult, stats: { ...(outcome.stats ?? {}), errors: errors.slice(0, 10) } })
    if (h.ok && h.claimToken) {
      // Ask a worker to take the next leg — and OBSERVE the claim on the row.
      // If it does not land, the row is 'queued' with a token and the next
      // poll or enqueue sweep dispatches it (queue-health: 'chain').
      const target = deps.target ?? resolveWorkerBase(null)
      const bump = await noteDispatchAttempt(runId, { db })
      const send = deps.dispatch ?? (async (t: WorkerBase, id: string, tok: string) => dispatchScoutWorker(t, id, tok, { raceMs: 1_500 }))
      let settled: DispatchSettled & { dispatched: boolean }
      if (target.problem) settled = { dispatched: false, outcome: 'failed', status: null, error: target.problem.message, latencyMs: 0 }
      else settled = await send(target, runId, h.claimToken)
      const observe = Math.max(0, Math.min(CHAIN_OBSERVE_MS, deadlineAt - now() - 2_000))
      const seen = settled.outcome === 'failed' ? { claimed: false, status: 'queued', waitedMs: 0 } : await awaitClaim(runId, { db, timeoutMs: observe })
      if (!seen.claimed) await recordDispatchOutcome(runId, settled, { db, attempt: bump.attempt, source: 'handoff' })
      log({ event: 'chained', next_invocation: invocation + 1, dispatch: settled.outcome, http_status: settled.status, next_claimed: seen.claimed, observe_ms: seen.waitedMs, error: settled.error })
      return { status: 200, body: { runId, status: 'queued', invocation, nextInvocation: invocation + 1, nextClaimed: seen.claimed, dispatch: settled.outcome, dispatchError: settled.error } }
    }
    if (h.refused === 'cancelled') {
      // The handoff refused BEFORE writing, so the row is still RUNNING under
      // this leg — close it here exactly like a mid-leg cancel. A queued-only
      // close would match nothing, and the row would sit running until the
      // reaper closed it with the wrong cause.
      const r = await finishScoutRun(
        runId,
        'cancelled',
        { workerId, stats: { ...(outcome.stats ?? {}), errors: errors.slice(0, 10) }, result: finalResult, error: 'Cancelled between passes; anything already found was kept.', errorCode: 'CANCELLED', errorDetail: { retryable: false } },
        db
      )
      if (finalCursor) await recordRunCursor(runId, finalCursor, { db, force: true }).catch(() => undefined)
      if (finalCheckpoint) await recordRunCheckpoint(runId, finalCheckpoint, { db, force: true }).catch(() => undefined)
      log({ event: 'leg_done', terminal_status: 'cancelled', detail: 'cancelled at handoff', finished: r.ok })
      return { status: 200, body: { runId, status: 'cancelled', invocation, finished: r.ok } }
    }
    // The whole run's clock or leg cap is spent (or the row moved on): terminal partial, resumable by hand.
    const why = h.refused === 'run_deadline' ? 'the run used all the time it was allowed' : h.refused === 'max_invocations' ? `the run used all ${invocation} passes it was allowed` : (h.error ?? 'the run could not be handed to another pass')
    const err = scoutError('RUN_DEADLINE', `${why}; everything found so far is saved${finalCursor || finalCheckpoint ? ' and the run can be continued' : ''}.`, { runId, retryable: true, remedy: defaultRemedy('RUN_DEADLINE') })
    const r = await finishScoutRun(runId, 'partial', finishFromError(err, { workerId, stats: { ...(outcome.stats ?? {}), errors: errors.slice(0, 10) }, result: finalResult }), db)
    if (finalCursor) await recordRunCursor(runId, finalCursor, { db, force: true }).catch(() => undefined)
    if (finalCheckpoint) await recordRunCheckpoint(runId, finalCheckpoint, { db, force: true }).catch(() => undefined)
    log({ event: 'leg_done', terminal_status: 'partial', error_code: 'RUN_DEADLINE', detail: why, finished: r.ok }, 'warn')
    return { status: 200, body: { runId, status: 'partial', invocation, error: err.message, code: err.code, finished: r.ok } }
  }

  // ─── Done: succeeded or partial with nothing to continue ───────────────────
  const status = outcome.status === 'partial' ? 'partial' : 'succeeded'
  const errCode: ScoutErrorCode | null = outcome.error?.code ?? (status === 'partial' ? 'RUN_DEADLINE' : null)
  const r = await finishScoutRun(
    runId,
    status,
    {
      workerId,
      stats: { ...(outcome.stats ?? {}), errors: errors.slice(0, 10) },
      result: finalResult,
      error: outcome.error?.message ?? errors[0] ?? null,
      errorCode: errCode,
      errorDetail: outcome.error ? { stage: outcome.error.stage ?? null, provider: outcome.error.provider ?? null, remedy: outcome.error.remedy ?? null, retryable: outcome.error.retryable } : status === 'partial' ? { remedy: defaultRemedy('RUN_DEADLINE') } : null,
    },
    db
  )
  if (finalCursor) await recordRunCursor(runId, finalCursor, { db, force: true }).catch(() => undefined)
  if (finalCheckpoint) await recordRunCheckpoint(runId, finalCheckpoint, { db, force: true }).catch(() => undefined)
  log({ event: 'leg_done', terminal_status: status, error_code: errCode, finished: r.ok, overrode_reap: r.overrodeReap })
  return { status: 200, body: { runId, status, invocation, errors, finished: r.ok, overrodeReap: r.overrodeReap } }
}
