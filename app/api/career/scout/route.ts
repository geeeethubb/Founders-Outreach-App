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
  resolveWorkerBase,
  sanitizeScoutParams,
  scoutCaps,
  toJobScoutParams,
  VERCEL_CAPS,
  VERCEL_DEADLINE_MS,
  workerBaseUrl,
} from '@/lib/career/scout/run-dispatch'
import { reapStaleRuns } from '@/lib/career/scout/run-reaper'
import { sweepScoutQueue } from '@/lib/career/scout/queue-watchdog'
import { runInBackground } from '@/lib/career/scout/background'
import { checkWorkerBase, logWorkerBaseHealth } from '@/lib/career/scout/worker-env'
import { HARD_QUEUE_CEILING_MS } from '@/lib/career/scout/queue-health'
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
      // AND the queue. reapStaleRuns only selects ['running'], so before this a
      // run stuck at 'queued' was not merely unrecoverable — it counted as
      // "active" and returned 409 to every subsequent Scout now. One lost
      // dispatch disabled scouting entirely until someone edited the database.
      await sweepScoutQueue(user.id, { baseUrl: workerBaseUrl(request.headers) })
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

    // Where are we dispatching, and is that address believable? On Vercel with
    // nothing pinned this is an ERROR — the fallback is the per-deployment
    // hostname that Deployment Protection answers with 401 — and it must never
    // be logged as if things were fine.
    const resolvedBase = resolveWorkerBase(request.headers)
    const baseHealth = checkWorkerBase(process.env, resolvedBase)
    logWorkerBaseHealth(baseHealth)

    const enqueuedAt = Date.now()
    const d = await dispatchScoutWorker(resolvedBase.baseUrl, queued.runId, queued.claimToken)
    const { dispatched, error } = d

    // Hand the still-in-flight POST to the platform so this function is not
    // frozen before it lands. A no-op off Vercel, and never load-bearing: the
    // watchdog is what guarantees the run starts or fails.
    const bg = d.outcome === 'pending' ? runInBackground(d.settled) : { extended: false }

    console.log(
      `[scout] run_id=${queued.runId} event=dispatch outcome=${d.outcome} http_status=${d.status ?? '-'} ` +
        `queue_wait_ms=${Date.now() - enqueuedAt} base=${resolvedBase.source} wait_until=${bg.extended} ` +
        `base_severity=${baseHealth.severity}${d.error ? ` error=${JSON.stringify(d.error)}` : ''}`
    )

    // FAIL FAST when nothing is listening. A dispatch that could not even be
    // sent will not be fixed by waiting: the founder gets a real error in a
    // second instead of a spinner that the watchdog eventually retires a minute
    // later. `dispatched` false with no error means the race timer won — the
    // request is still in flight — and that IS worth waiting for.
    if (!dispatched && error) {
      await sweepScoutQueue(user.id, {
        baseUrl: resolvedBase.baseUrl,
        // Judged immediately rather than in 60s: we already KNOW it failed, so
        // the ceiling is used to force the terminal branch rather than to wait.
        now: Date.now() + HARD_QUEUE_CEILING_MS + 1_000,
        dispatch: async () => ({ dispatched: false, error }),
      })
    }

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
        // Surfaced so a misconfigured deployment is visible in the response as
        // well as the log — this used to be returned and read by nobody.
        dispatchOutcome: d.outcome,
        dispatchStatus: d.status,
        workerBase: { source: resolvedBase.source, severity: baseHealth.severity, message: baseHealth.message, remedy: baseHealth.remedy },
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
