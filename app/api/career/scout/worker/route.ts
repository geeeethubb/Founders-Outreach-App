// POST /api/career/scout/worker — executes one enqueued scout run.
//
// Machine-to-machine. There is no user session here (the request comes from
// another function invocation, not a browser), so the ONLY credential is the
// run's single-use claim token: it authenticates the caller and, because
// claiming consumes it under a status guard, it also makes double execution
// impossible. A stolen or replayed token claims nothing.
//
// Nothing in this handler touches a run it has not claimed — including the
// outer catch. `runId` stays null until the claim succeeds, so a throw while
// claiming (or a caller sending someone else's run id with a wrong token) can
// never close another user's run row.
//
// The run row is created by /api/career/scout; this handler attaches its
// CareerRun to that same row (attachCareerRun) so the agent traces, the cost
// and the stats land where the browser is looking.

import { NextRequest, NextResponse } from 'next/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { attachCareerRun } from '@/lib/career/runs'
import { liveScoutStore, runJobScout, type ScoutStore } from '@/lib/career/scout/orchestrator'
import { readScoutParams, scoutCaps, scoutDeadlineMs } from '@/lib/career/scout/run-dispatch'
import { claimScoutRun, finishScoutRun, recordProgress, resetProgressCache, terminalStatusFor, touchScoutRun } from '@/lib/career/scout/run-store'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * How often this worker says "still alive" while a stage is silent. The
 * orchestrator can be quiet for minutes inside one agent call, so without this
 * `heartbeat_at` would measure how talkative a stage is rather than whether
 * the process still exists — and the reaper reads it.
 */
const HEARTBEAT_MS = 30_000

/** POST { runId, token } → { runId, status, jobs, errors } */
export async function POST(request: NextRequest) {
  // Null until this request owns the run. The catch below writes to it, so it
  // must never name a run this request has not claimed.
  let claimedRunId: string | null = null
  try {
    const body = ((await request.json().catch(() => ({}))) ?? {}) as { runId?: string; token?: string }
    if (!body.runId || !body.token) return NextResponse.json({ error: 'runId and token are required' }, { status: 400 })

    const deadlineMs = scoutDeadlineMs()
    const claim = await claimScoutRun(body.runId, body.token, undefined, { deadlineMs })
    if (!claim.claimed || !claim.run) {
      // Already claimed, already finished, or the wrong token — all the same
      // answer, and never a retry: exactly one worker executes a run.
      const status = claim.migrationMissing ? 409 : 403
      return NextResponse.json({ error: claim.error ?? 'run is not claimable', claimed: false, migrationMissing: claim.migrationMissing }, { status })
    }
    claimedRunId = body.runId

    const userId = claim.run.user_id
    const params = readScoutParams(claim.params, scoutCaps())
    return await execute(body.runId, userId, params, deadlineMs)
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    const message = error instanceof Error ? error.message : String(error)
    // A throw must still close the row we claimed, or the UI polls a run that
    // will not move again until the reaper reaches it.
    if (claimedRunId) await finishScoutRun(claimedRunId, 'failed', { error: message }).catch(() => {})
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

async function execute(runId: string, userId: string, params: ReturnType<typeof readScoutParams>, deadlineMs: number) {
  // Serialize progress writes behind one chain: the orchestrator's onProgress
  // is synchronous and fires hundreds of times, and recordProgress throttles,
  // so this is at most one in-flight write at a time and never a pile-up.
  let chain: Promise<unknown> = Promise.resolve()
  let progressErrors = 0
  let lostRun = false
  const onProgress = (stage: string, detail: string, counts?: Record<string, number>) => {
    chain = chain
      .then(() => recordProgress(runId, { stage, detail, counts }))
      .then((r) => {
        // A guard that matched nothing means somebody else closed this run.
        // Surface it — a silent heartbeat is exactly the failure this whole
        // module exists to make visible.
        if (r.notRunning) lostRun = true
        else if (r.error) progressErrors++
      })
      .catch(() => {
        progressErrors++
      })
  }

  // One run row, not two: the scout's CareerRun attaches to the row the
  // enqueue step already created. It writes cost_usd and agent_calls; the
  // terminal status is finishScoutRun's, below.
  const store: ScoutStore = { ...liveScoutStore(), startRun: (p) => attachCareerRun({ ...p, runId }) }

  // A pulse for the silent stages. Cheap (one column), guarded on 'running',
  // and it stops the moment somebody else closes the run.
  const beat = setInterval(() => {
    chain = chain
      .then(() => touchScoutRun(runId))
      .then((r) => {
        if (r.notRunning) lostRun = true
      })
      .catch(() => {})
  }, HEARTBEAT_MS)

  try {
    const result = await runJobScout(
      {
        userId,
        missionId: params.missionId,
        budget: { deadlineMs },
        maxStrategies: params.strategies,
        maxRoundsPerStrategy: params.rounds,
        maxCompaniesFirst: params.companies,
        maxExtract: params.extract,
        verify: params.verify,
        rank: params.rank,
        label: params.label,
        onProgress,
      },
      { store }
    )
    clearInterval(beat)
    await chain.catch(() => {})

    const status = terminalStatusFor({ migrationMissing: result.migrationMissing, deadlineHit: result.stats.deadline_hit, errors: result.errors })
    const errors = [
      ...result.errors,
      ...(progressErrors ? [`${progressErrors} progress write(s) failed`] : []),
      ...(lostRun ? ['the run row was closed by something else while this worker was still working'] : []),
    ]
    // stats MERGE onto what attachCareerRun already wrote, so cost_usd and
    // agent_calls survive: one stats shape for web, CLI and legacy runs.
    const finished = await finishScoutRun(runId, status, {
      stats: { ...result.stats, jobs: result.jobs.length, rejected: result.rejected.length, errors: errors.slice(0, 10) },
      error: errors[0] ?? null,
    })
    return NextResponse.json({ runId, status, jobs: result.jobs.length, errors, finished: finished.ok, overrodeReap: finished.overrodeReap })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    await chain.catch(() => {})
    await finishScoutRun(runId, 'failed', { error: message })
    return NextResponse.json({ runId, status: 'failed', error: message }, { status: 500 })
  } finally {
    clearInterval(beat)
    resetProgressCache(runId)
  }
}
