// POST /api/career/scout — ENQUEUE a Job Scout run. It does not run one.
//
// Scouting takes minutes; an HTTP request does not. This handler checks the
// deployment can execute a run at all, writes a `scouting_runs` row,
// dispatches a worker at it, watches the row for the worker's claim, and
// answers in a few seconds. The browser then polls GET /api/career/scout/runs/[id].
// Nothing about the run lives in the browser, so a refresh, a closed tab or a
// dead Wi-Fi connection costs nothing — the run is a row, and it keeps going.
//
// There is NO synchronous fallback. A deployment that cannot execute a
// durable run is answered with the reason and the remedy before anything is
// paid for; it is never quietly downgraded to a five-minute request.
//
//   → 202 { runId, status: 'queued' | 'running', claimed, dispatch, workerBase }
//   → 409 { error, code: 'CONFLICT', runId, run }        (a scout is already going)
//   → 503 { error, code: 'CONFIGURATION' | 'DISPATCH' | 'SCHEMA_MIGRATION', remedy }

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { apiError, jsonError, thrownError, unauthorized } from '@/lib/http/api-error'
import { continuationParams, describeCursor, isCursorComplete, readRunCursor, sanitizeScoutParams, scoutCaps } from '@/lib/career/scout/run-dispatch'
import { getScoutRun } from '@/lib/career/scout/run-store'
import { resolveRunBudget } from '@/lib/career/discovery/modes'
import { startScoutRun } from '@/lib/runs/enqueue'
import { invocationBudgetMs } from '@/lib/runs/deadline'
import { MAX_INVOCATIONS } from '@/lib/career/scout/run-store'

export const dynamic = 'force-dynamic'
// The enqueue holds its own request only for the dispatch race and the claim
// observation (~15 s). The budget is generous for a cold Supabase connection.
export const maxDuration = 60

export async function POST(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return unauthorized()

    const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
    let params = sanitizeScoutParams(body, scoutCaps())
    let continuedFrom: string | null = null

    // A continuation: same work, new row. The cursor comes from the stored
    // row — never from the request — so a caller cannot dictate what a run
    // believes it has already done.
    if (typeof body.continueRun === 'string' && body.continueRun) {
      const prior = await getScoutRun(user.id, body.continueRun)
      if (!prior.run) return apiError(prior.migrationMissing ? 'SCHEMA_MIGRATION' : 'NOT_FOUND', prior.error ?? 'that run was not found')
      const cursor = readRunCursor(prior.run)
      if (isCursorComplete(cursor)) return apiError('CONFLICT', 'that run finished every stage — there is nothing left to continue', { retryable: false, runId: prior.run.id })
      const priorParams = sanitizeScoutParams((prior.run.params ?? {}) as Record<string, unknown>, scoutCaps())
      params = continuationParams({ ...priorParams, label: `${priorParams.label} · continued` }, cursor)
      // A continuation is the same run at the same shape — EXCEPT its ceiling.
      if (body.maxSpendUsd !== undefined) params = { ...params, maxSpendUsd: sanitizeScoutParams({ maxSpendUsd: body.maxSpendUsd }, scoutCaps()).maxSpendUsd }
      continuedFrom = prior.run.id
    }

    // The whole run's clock across legs: the mode's runtime, or six legs.
    const runtime = params.mode ? resolveRunBudget(params.mode, { maxSpendUsd: params.maxSpendUsd }).maxRuntimeMs : invocationBudgetMs() * MAX_INVOCATIONS
    const outcome = await startScoutRun({
      userId: user.id,
      kind: 'job_scout',
      params: { ...params },
      label: params.label,
      missionId: params.missionId,
      runDeadlineMs: Math.max(runtime, invocationBudgetMs()) + 60_000,
      headers: request.headers,
      force: body.force === true,
    })

    if (outcome.kind === 'not_ready') return jsonError(outcome.error, { readiness: outcome.readiness })
    if (outcome.kind === 'conflict') return jsonError(outcome.error, { runId: outcome.run.id, status: outcome.run.status, alreadyActive: true, durable: true, run: outcome.run, cancelRequested: outcome.cancelRequested })
    if (outcome.kind === 'failed') return jsonError(outcome.error, { runId: outcome.runId })

    return NextResponse.json(
      {
        runId: outcome.runId,
        status: outcome.status,
        durable: true,
        dispatched: outcome.dispatch.outcome !== 'failed',
        claimed: outcome.claimed,
        claimInMs: outcome.claimInMs,
        mode: params.mode,
        maxSpendUsd: params.maxSpendUsd,
        continuedFrom,
        resuming: continuedFrom ? describeCursor(params.cursor) : null,
        dispatch: outcome.dispatch,
        workerBase: outcome.worker,
      },
      { status: 202 }
    )
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return thrownError(error)
  }
}
