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
import { readScoutParams, scoutCaps, scoutDeadlineMs, toJobScoutParams, type ScoutCursor } from '@/lib/career/scout/run-dispatch'
import { claimScoutRun, finishScoutRun, recordProgress, recordRunCursor, resetProgressCache, terminalStatusFor, touchScoutRun } from '@/lib/career/scout/run-store'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * How often this worker says "still alive" while a stage is silent. The
 * orchestrator can be quiet for minutes inside one agent call, so without this
 * `heartbeat_at` would measure how talkative a stage is rather than whether
 * the process still exists — and the reaper reads it.
 */
const HEARTBEAT_MS = 30_000

/**
 * How often the task cursor is written while the run is alive. A cursor moves
 * after every strategy and every company; the row only needs to be right
 * enough that a killed worker leaves a useful resume point, and the finishing
 * write is unthrottled.
 */
const CURSOR_MIN_INTERVAL_MS = 10_000

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
  let cancelled = false
  const onProgress = (stage: string, detail: string, counts?: Record<string, number>) => {
    chain = chain
      .then(() => recordProgress(runId, { stage, detail, counts }))
      .then((r) => {
        // A guard that matched nothing means somebody else closed this run.
        // Surface it — a silent heartbeat is exactly the failure this whole
        // module exists to make visible.
        if (r.notRunning) lostRun = true
        // Cancellation arrives on the write that was happening anyway. The
        // orchestrator stops at its next stage boundary, so a stage part-way
        // through writing findings still finishes that write.
        else if (r.cancelRequested) cancelled = true
        else if (r.error) progressErrors++
      })
      .catch(() => {
        progressErrors++
      })
  }

  // Where the run has got to, written onto its own row WHILE it works.
  //
  // A worker that is killed at its platform deadline must leave a resumable
  // cursor behind, so this cannot wait for the finishing write: the whole
  // point of the cursor is the invocation that does not get to finish. It is
  // throttled (a cursor moves on every strategy and every company) and it
  // rides the same serialized chain as the progress writes, so at most one
  // write is ever in flight.
  let lastCursorAt = 0
  let latestCursor: ScoutCursor | null = null
  const onCursor = (cursor: ScoutCursor) => {
    latestCursor = cursor
    const now = Date.now()
    if (now - lastCursorAt < CURSOR_MIN_INTERVAL_MS) return
    lastCursorAt = now
    chain = chain
      .then(() => recordRunCursor(runId, cursor as unknown as Record<string, unknown>))
      .then((r) => {
        if (r.notRunning) lostRun = true
      })
      .catch(() => {})
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
    // ONE mapping from the stored row to what the orchestrator executes,
    // shared with the inline path and the CLI (toJobScoutParams). Listing the
    // fields by hand here is how `mode`, `maxSpendUsd` and `cursor` failed to
    // reach the only executor the Jobs page ever uses: every web run silently
    // executed the legacy budget, so the ceiling the founder typed did
    // nothing and a continuation had nothing to continue from.
    const result = await runJobScout(toJobScoutParams(params, { userId, deadlineMs, onProgress, onCursor }), { store })
    clearInterval(beat)
    // The last cursor the run emitted, written unthrottled — this is the one
    // a continuation actually reads.
    await chain.catch(() => {})
    await recordRunCursor(runId, result.cursor as unknown as Record<string, unknown>, { force: true }).catch(() => {})

    const status = terminalStatusFor({
      migrationMissing: result.migrationMissing,
      deadlineHit: result.stats.deadline_hit,
      errors: result.errors,
      // A run stopped by its spend ceiling is not a green tick: it stopped
      // short of the market because it ran out of money, and the founder has
      // to be able to see that (principle 11).
      partial: result.partial,
      stopped: result.stopped,
    })
    const errors = [
      ...result.errors,
      ...(progressErrors ? [`${progressErrors} progress write(s) failed`] : []),
      ...(lostRun ? ['the run row was closed by something else while this worker was still working'] : []),
    ]
    // stats MERGE onto what attachCareerRun already wrote, so cost_usd and
    // agent_calls survive: one stats shape for web, CLI and legacy runs.
    // A cancelled run is not a failure and not a success: the founder stopped
    // it. Recording it as 'partial' or 'succeeded' would hide that, and anything
    // it did find before stopping is still saved and still counted.
    const finalStatus = cancelled ? 'cancelled' : status
    const finished = await finishScoutRun(runId, finalStatus, {
      stats: { ...result.stats, jobs: result.jobs.length, rejected: result.rejected.length, errors: errors.slice(0, 10) },
      error: cancelled ? 'Cancelled while running; anything already found was kept.' : errors[0] ?? null,
    })
    return NextResponse.json({
      runId, status: finalStatus, cancelled, jobs: result.jobs.length, errors, finished: finished.ok, overrodeReap: finished.overrodeReap,
      mode: result.budget.mode, stopped: result.stopped, spentUsd: result.spend.spent_usd,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    await chain.catch(() => {})
    // A run that threw still knows where it got to. Keeping that cursor is the
    // difference between "continue" and "pay for all of it again".
    if (latestCursor) await recordRunCursor(runId, latestCursor as unknown as Record<string, unknown>, { force: true }).catch(() => {})
    await finishScoutRun(runId, 'failed', { error: message })
    return NextResponse.json({ runId, status: 'failed', error: message }, { status: 500 })
  } finally {
    clearInterval(beat)
    resetProgressCache(runId)
  }
}
