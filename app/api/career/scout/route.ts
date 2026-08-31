// POST /api/career/scout — ENQUEUE a scout run. It does not run one.
//
// Scouting takes minutes; an HTTP request does not. This handler writes a
// `scouting_runs` row, dispatches a worker at it, and returns in about a
// second. The browser then polls GET /api/career/scout/runs/[id]. Nothing
// about the run lives in the browser, so a refresh, a closed tab or a dead
// Wi-Fi connection costs nothing — the run is a row, and it keeps going.
//
// Because the request no longer waits for the work, it no longer serializes
// it either: two clicks used to mean two long requests, and now they would
// mean two paid runs. So an active run is answered with 409 and ITS id — the
// page attaches to the run that is already going — unless the caller says
// `force: true`.
//
// Before migration 016 there is no queue state to write, so this falls back to
// the old synchronous behaviour and says so (`durable: false`), rather than
// failing. The app must keep working until the founder applies the migration.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { runJobScout } from '@/lib/career/scout/orchestrator'
import {
  continuationParams,
  describeCursor,
  dispatchScoutWorker,
  isCursorComplete,
  readRunCursor,
  sanitizeScoutParams,
  scoutCaps,
  toJobScoutParams,
  VERCEL_CAPS,
  VERCEL_DEADLINE_MS,
  workerBaseUrl,
} from '@/lib/career/scout/run-dispatch'
import { reapStaleRuns } from '@/lib/career/scout/run-reaper'
import { activeJobScoutRun, enqueueScoutRun, getRunJobCounts, getScoutRun, toRunView } from '@/lib/career/scout/run-store'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * POST { missionId?, mode?, maxSpendUsd?, verify?, rank?, label?, force?, continueRun? }
 *   → 202 { runId, status: 'queued', durable: true, dispatched }
 *   → 409 { runId, status, alreadyActive: true, run }        (a scout is already going)
 *   → 200 { durable: false, migrationMissing, ...JobScoutResult }  (pre-016 fallback)
 *
 * `mode` is the whole of "how big is this run" (QUICK · BROAD · EXHAUSTIVE) and
 * `maxSpendUsd` is the ceiling. The four old per-stage numbers — strategies,
 * rounds, companies, extract — are still accepted and still win over the mode
 * for one release, so an old client or a saved script keeps working unchanged.
 *
 * `continueRun` carries a previous run's cursor into a new row: a BROAD or
 * EXHAUSTIVE run legitimately outlives one worker invocation, and continuing
 * must not mean paying for the plan, the sweep and the finished strategies
 * again.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
    let params = sanitizeScoutParams(body, scoutCaps())
    let continuedFrom: string | null = null

    // A continuation: same work, new invocation. The cursor comes from the
    // stored row — never from the request — so a caller cannot dictate what a
    // run believes it has already done.
    if (typeof body.continueRun === 'string' && body.continueRun) {
      const prior = await getScoutRun(user.id, body.continueRun)
      if (!prior.run) {
        return NextResponse.json({ error: prior.error ?? 'that run was not found', migrationMissing: prior.migrationMissing }, { status: 404 })
      }
      const cursor = readRunCursor(prior.run)
      if (isCursorComplete(cursor)) {
        return NextResponse.json({ error: 'that run finished every stage — there is nothing left to continue', runId: prior.run.id }, { status: 409 })
      }
      const priorParams = sanitizeScoutParams((prior.run.params ?? {}) as Record<string, unknown>, scoutCaps())
      params = continuationParams({ ...priorParams, label: `${priorParams.label} · continued` }, cursor)
      // A continuation is the same run at the same shape — EXCEPT its ceiling.
      // "It stopped at its spend limit" is only actionable if raising the
      // limit and continuing does something, and the spend already made
      // counts against the new ceiling either way (the cursor carries it).
      if (body.maxSpendUsd !== undefined) {
        params = { ...params, maxSpendUsd: sanitizeScoutParams({ maxSpendUsd: body.maxSpendUsd }, scoutCaps()).maxSpendUsd }
      }
      continuedFrom = prior.run.id
    }

    // "No paid work without a click" has to hold on the server too: the button
    // being hidden does not survive a second tab or a direct call. Reap first,
    // so a run whose worker really did die does not block the next one.
    if (body.force !== true) {
      await reapStaleRuns(user.id)
      const existing = await activeJobScoutRun(user.id)
      if (existing.run) {
        const view = toRunView(existing.run, await getRunJobCounts(user.id, existing.run.id))
        return NextResponse.json(
          {
            runId: existing.run.id,
            status: existing.run.status,
            alreadyActive: true,
            durable: true,
            run: view,
            error: `A scout run is already ${existing.run.status}. Watch it, or send force:true to start another.`,
          },
          { status: 409 }
        )
      }
    }

    const queued = await enqueueScoutRun(user.id, { missionId: params.missionId, params: { ...params }, label: params.label })

    if (!queued.durable || !queued.runId || !queued.claimToken) {
      return runInline(user.id, body, queued.migrationMissing, queued.error)
    }

    const { dispatched, error } = await dispatchScoutWorker(workerBaseUrl(request.headers), queued.runId, queued.claimToken)
    return NextResponse.json(
      {
        runId: queued.runId,
        status: 'queued',
        durable: true,
        dispatched,
        mode: params.mode,
        maxSpendUsd: params.maxSpendUsd,
        continuedFrom,
        resuming: continuedFrom ? describeCursor(params.cursor) : null,
        // Not fatal: polling the run re-dispatches one still queued after ~10s.
        dispatchError: error,
      },
      { status: 202 }
    )
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}

/**
 * The pre-016 path, unchanged from what this route used to be: run it inside
 * the request under the 270s ceiling and return the result. Slower, loses the
 * run on a refresh — which is exactly why 016 exists.
 */
async function runInline(userId: string, body: Record<string, unknown>, migrationMissing: boolean, enqueueError: string | null) {
  const p = sanitizeScoutParams(body, VERCEL_CAPS)
  // One mapping, shared with the worker and the CLI, so a field added to the
  // run's parameters cannot reach one executor and not another.
  const result = await runJobScout(toJobScoutParams(p, { userId, deadlineMs: VERCEL_DEADLINE_MS - 10_000 }))
  if (result.migrationMissing) {
    return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true, durable: false, result }, { status: 409 })
  }
  return NextResponse.json({
    ...result,
    durable: false,
    migrationMissing,
    // The UI shows this: the run worked, but it could not survive a refresh.
    durableNote: migrationMissing
      ? 'Apply supabase/migrations/016_scout_durability_and_company_intent.sql to make scout runs survive a page refresh. This run was executed inside the request.'
      : `The run could not be queued (${enqueueError ?? 'unknown'}), so it ran inside the request.`,
  })
}
