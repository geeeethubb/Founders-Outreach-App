// Starting a durable scout run, for either kind — everything the two enqueue
// routes share, so they cannot drift.
//
//   readiness ──▶ sweep the queue ──▶ one active run per kind? ──▶ insert
//   ──▶ dispatch ──▶ observe the claim on the row ──▶ answer
//
// Nothing paid starts before readiness says the deployment can execute it.
// A second click lands on the database's own uniqueness rule (migration 021)
// and is answered with the run that is already going, never with a second
// paid row. A dispatch that fails outright is recorded on the row with the
// real reason, retried once, and — if that fails too — the run is closed as
// DISPATCH with that reason, in seconds, instead of sitting for minutes.
//
// No cookies here: the routes authenticate, this does the work.

import { runInBackground } from '@/lib/career/scout/background'
import { sweepScoutQueue } from '@/lib/career/scout/queue-watchdog'
import {
  activeScoutRun,
  awaitClaim,
  enqueueScoutRun,
  failQueuedRun,
  getRunJobCounts,
  noteDispatchAttempt,
  recordDispatchOutcome,
  toRunView,
  type DurableScoutKind,
  type ScoutRunView,
} from '@/lib/career/scout/run-store'
import { cancelScoutRun } from '@/lib/career/scout/queue-watchdog'
import { dispatchScoutWorker, resolveWorkerBase, type DispatchSettled, type WorkerBase } from '@/lib/career/scout/worker-target'
import { checkScoutReadiness, type ScoutReadiness } from './readiness'
import { defaultRemedy, scoutError, type ScoutError } from './errors'
import { scoutLog } from './log'

type HeaderBag = { get(name: string): string | null }

export interface StartRunInput {
  userId: string
  kind: DurableScoutKind
  params: Record<string, unknown>
  label: string
  missionId?: string | null
  mission?: unknown
  budget?: unknown
  runDeadlineMs?: number
  headers?: HeaderBag | null
  /** Cancel the active run of this kind first. */
  force?: boolean
  /** Injected in tests. */
  target?: WorkerBase
  dispatch?: (target: WorkerBase, runId: string, token: string) => Promise<DispatchSettled & { dispatched: boolean; settled?: Promise<DispatchSettled> }>
  readiness?: ScoutReadiness
  /** How long to watch the row for the claim. */
  observeMs?: number
}

export type StartRunOutcome =
  | { kind: 'not_ready'; error: ScoutError; readiness: ScoutReadiness }
  | { kind: 'conflict'; run: ScoutRunView; error: ScoutError; cancelRequested: boolean }
  | { kind: 'failed'; error: ScoutError; runId: string | null }
  | {
      kind: 'queued'
      runId: string
      /** 'running' once the claim was observed, else 'queued'. */
      status: 'queued' | 'running'
      claimed: boolean
      claimInMs: number | null
      dispatch: { outcome: DispatchSettled['outcome']; status: number | null; error: string | null; attempt: number }
      worker: { source: string; baseUrl: string }
      readiness: ScoutReadiness
    }

export async function startScoutRun(input: StartRunInput): Promise<StartRunOutcome> {
  const scoutKind = input.kind === 'outreach' ? 'people' : 'jobs'

  // 1. Nothing paid before the deployment can execute it.
  const readiness = input.readiness ?? (await checkScoutReadiness())
  const gate = scoutKind === 'people' ? readiness.people : readiness.jobs
  if (!gate.ready) {
    const code = gate.code ?? 'CONFIGURATION'
    return { kind: 'not_ready', readiness, error: scoutError(code, `Scouting is unavailable: ${gate.reason}`, { remedy: gate.remedy ?? defaultRemedy(code), retryable: false }) }
  }

  // 2. Reap and sweep first, so a run whose worker really died does not block
  //    the next one — then the one-active-run check, then the insert, which
  //    the database itself guards.
  const target = input.target ?? resolveWorkerBase(input.headers ?? null)
  await sweepScoutQueue(input.userId, { target })
  const existing = await activeScoutRun(input.userId, input.kind)
  if (existing.run) {
    if (input.force) {
      const c = await cancelScoutRun(input.userId, existing.run.id)
      if (!c.cancelled) {
        const view = toRunView(existing.run, await getRunJobCounts(input.userId, existing.run.id))
        return { kind: 'conflict', run: view, cancelRequested: c.requested, error: scoutError('CONFLICT', c.requested ? 'The active run was asked to stop. Start again once it has.' : `A scout run is already ${existing.run.status}.`, { runId: existing.run.id, retryable: true }) }
      }
    } else {
      const view = toRunView(existing.run, await getRunJobCounts(input.userId, existing.run.id))
      return { kind: 'conflict', run: view, cancelRequested: false, error: scoutError('CONFLICT', `A scout run is already ${existing.run.status}. Watch it, or cancel it to start another.`, { runId: existing.run.id, retryable: false }) }
    }
  }

  const queued = await enqueueScoutRun(input.userId, { kind: input.kind, missionId: input.missionId, params: input.params, label: input.label, mission: input.mission, budget: input.budget, runDeadlineMs: input.runDeadlineMs })
  if (queued.conflict) {
    const again = await activeScoutRun(input.userId, input.kind)
    if (again.run) {
      const view = toRunView(again.run, await getRunJobCounts(input.userId, again.run.id))
      return { kind: 'conflict', run: view, cancelRequested: false, error: scoutError('CONFLICT', `A scout run is already ${again.run.status}. Watch it, or cancel it to start another.`, { runId: again.run.id, retryable: false }) }
    }
    return { kind: 'failed', runId: null, error: scoutError('CONFLICT', 'A scout run of this kind is already active.', { retryable: true }) }
  }
  if (!queued.durable || !queued.runId || !queued.claimToken) {
    const code = queued.migrationMissing ? 'SCHEMA_MIGRATION' : 'DATABASE'
    return { kind: 'failed', runId: null, error: scoutError(code, queued.migrationMissing ? 'The database predates the durable-run migrations; apply supabase/migrations/021_scout_reliability.sql.' : `The run could not be queued: ${queued.error ?? 'unknown'}`, { remedy: defaultRemedy(code) }) }
  }
  const runId = queued.runId

  // 3. Where is the worker? An address this deployment cannot prove it may
  //    call is a configuration error — and the row says so.
  if (target.problem || !target.baseUrl) {
    const err = scoutError('CONFIGURATION', target.problem?.message ?? 'no worker address is configured', { remedy: target.problem?.remedy ?? null, runId, retryable: false })
    await failQueuedRun(runId, err)
    return { kind: 'failed', runId, error: err }
  }

  // 4. Dispatch, and observe. Two attempts back-to-back when the first fails
  //    outright; a 'pending' request is the normal case (the worker answers at
  //    the end of its leg), so the claim is read off the row.
  const send = input.dispatch ?? (async (t: WorkerBase, id: string, tok: string) => dispatchScoutWorker(t, id, tok, { raceMs: 1_500 }))
  let attempt = 0
  let settled: (DispatchSettled & { dispatched: boolean; settled?: Promise<DispatchSettled> }) | null = null
  for (let i = 0; i < 2; i++) {
    const bump = await noteDispatchAttempt(runId)
    attempt = bump.attempt
    settled = await send(target, runId, queued.claimToken)
    scoutLog({ run_id: runId, scout_kind: scoutKind, event: 'dispatch', attempt, status: settled.outcome, http_status: settled.status, latency_ms: settled.latencyMs, error: settled.error, worker_source: target.source }, settled.outcome === 'failed' ? 'warn' : 'log')
    if (settled.outcome !== 'failed') break
    await recordDispatchOutcome(runId, settled, { attempt, source: 'enqueue' })
  }
  if (!settled) settled = { dispatched: false, outcome: 'failed', status: null, error: 'no dispatch was made', latencyMs: 0 }

  if (settled.outcome === 'failed') {
    const err = scoutError('DISPATCH', `Scouting could not start: the app could not reach its own worker (${settled.error ?? 'no reason given'}).`, { runId, httpStatus: settled.status, attempt, remedy: defaultRemedy('DISPATCH'), retryable: true })
    await failQueuedRun(runId, err)
    return { kind: 'failed', runId, error: err }
  }

  const observe = input.observeMs ?? 10_000
  const seen = settled.outcome === 'accepted' || settled.outcome === 'claimed_elsewhere' ? { claimed: true, status: 'running', waitedMs: settled.latencyMs } : await awaitClaim(runId, { timeoutMs: observe })
  if (!seen.claimed) {
    // Still queued after the observation window. The row is judged by the
    // next poll (the chain link) and by the watchdog; the request's eventual
    // answer is written to the row by a best-effort background hop.
    await recordDispatchOutcome(runId, settled, { attempt, source: 'enqueue' })
    if (settled.settled) runInBackground(settled.settled.then((late) => recordDispatchOutcome(runId, late, { attempt, source: 'enqueue-late' })))
  }
  scoutLog({ run_id: runId, scout_kind: scoutKind, event: 'enqueue_done', status: seen.claimed ? 'running' : 'queued', queue_wait_ms: seen.waitedMs, attempt })
  return {
    kind: 'queued',
    runId,
    status: seen.claimed ? 'running' : 'queued',
    claimed: seen.claimed,
    claimInMs: seen.claimed ? seen.waitedMs : null,
    dispatch: { outcome: settled.outcome, status: settled.status, error: settled.error, attempt },
    worker: { source: target.source, baseUrl: target.baseUrl },
    readiness,
  }
}
