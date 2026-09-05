// POST /api/scout — ENQUEUE a People Scout run. It does not run one.
//
// The People Scout used to execute inside this request: a 300-second ceiling
// on a run that measured 527, a browser that had to stay open, and five rows
// left 'running' for ever when the request died. It is now the same kind of
// thing as the Job Scout — a row a worker claims, executes in bounded legs,
// checkpoints and finishes — through the same code (lib/runs/enqueue.ts).
//
//   → 202 { runId, status: 'queued' | 'running', claimed, dispatch }
//   → 409 { error, code: 'CONFLICT', runId, run }        (a scout is already going)
//   → 503 { error, code: 'CONFIGURATION' | 'DISPATCH' | 'SCHEMA_MIGRATION', remedy }

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { apiError, jsonError, thrownError, unauthorized } from '@/lib/http/api-error'
import { sanitizePeopleScoutParams } from '@/lib/scouting/run-params'
import { startScoutRun } from '@/lib/runs/enqueue'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** The whole run's clock across legs. Six hosted legs is more than a full-depth run needs. */
const PEOPLE_RUN_DEADLINE_MS = 40 * 60 * 1000

export async function POST(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return unauthorized()

    const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
    const params = sanitizePeopleScoutParams(body)
    if (!params.goal) return apiError('VALIDATION', 'A mission goal is required', { retryable: false })

    const outcome = await startScoutRun({
      userId: user.id,
      kind: 'outreach',
      params: { ...params },
      label: params.label,
      mission: { goal: params.goal, timeframe: params.timeframe, geography: params.geography, constraints: params.constraints },
      budget: { segments: params.segmentCount, companiesPerSegment: params.companiesPerSegment, maxDeepResearch: params.maxDeepResearch, searchMode: params.searchMode },
      runDeadlineMs: PEOPLE_RUN_DEADLINE_MS,
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
        claimed: outcome.claimed,
        claimInMs: outcome.claimInMs,
        searchMode: params.searchMode,
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
