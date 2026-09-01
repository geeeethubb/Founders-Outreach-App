// GET /api/career/scout/runs/[id] — one durable scout run, as the UI reads it.
//
// This is the only thing the Jobs page polls while a scout is running. It is
// deliberately more than a SELECT, because polling is the moment we know a
// human is watching and it is the cheapest place to self-heal:
//
//   - a 'running' run whose worker died is REAPED here (a real write), so the
//     page stops showing a run that will never move again;
//   - a run still 'queued' after ~10s had its dispatch lost, so it is
//     RE-DISPATCHED here with the claim token still on the row — the token is
//     single-use, so the original worker (if it did arrive) still wins.
//
// The claim token is never in the response.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { dispatchScoutWorker, workerBaseUrl } from '@/lib/career/scout/run-dispatch'
import { reapStaleRuns } from '@/lib/career/scout/run-reaper'
import { getRunJobCounts, getScoutRun, REDISPATCH_AFTER_MS, toRunView } from '@/lib/career/scout/run-store'
import { sweepScoutQueue } from '@/lib/career/scout/queue-watchdog'
import { MAX_QUEUE_WAIT_MS } from '@/lib/career/scout/queue-health'

export const dynamic = 'force-dynamic'

/**
 * GET → { run: { id, status, stage, detail, counts, events, started_at, heartbeat_at,
 *                completed_at, deadline_at, stats, error,
 *                jobs: { total, inserted, verified_open, likely_open, unverified, closed, ranked },
 *                active, partial, stale }, redispatched, reaped }
 */
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Reap first, so the row we read back is already the truth.
    const reap = await reapStaleRuns(user.id)
    if (reap.migrationMissing) {
      return NextResponse.json({ error: 'Apply supabase/migrations/016_scout_durability_and_company_intent.sql first', migrationMissing: true, durable: false }, { status: 409 })
    }

    const { run, migrationMissing, error } = await getScoutRun(user.id, params.id)
    if (migrationMissing) {
      return NextResponse.json({ error: 'Apply supabase/migrations/016_scout_durability_and_company_intent.sql first', migrationMissing: true, durable: false }, { status: 409 })
    }
    if (error) return NextResponse.json({ error }, { status: 500 })
    if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 })

    // Two mechanisms, deliberately. The eager one below re-asks after ~10s so a
    // watched run starts fast. The WATCHDOG is what makes the invariant true:
    // past 60s it counts attempts and, once they are spent, FAILS the run. The
    // old code had only the eager half, so a run nobody was watching — the UI
    // says "you can close this tab" — had no path out of 'queued' at all.
    let redispatched = false
    if (run.status === 'queued' && run.claim_token) {
      const queuedFor = Date.now() - Date.parse(String(run.started_at ?? run.heartbeat_at ?? ''))
      if (Number.isFinite(queuedFor) && queuedFor > REDISPATCH_AFTER_MS && queuedFor <= MAX_QUEUE_WAIT_MS) {
        const d = await dispatchScoutWorker(workerBaseUrl(request.headers), run.id, run.claim_token, { raceMs: 800 })
        redispatched = d.dispatched
      }
    }
    const swept = await sweepScoutQueue(user.id, { baseUrl: workerBaseUrl(request.headers) })
    // The sweep may have just finalised this run; re-read so the caller is told
    // the truth rather than the status from before the watchdog acted.
    const after = swept.actions.some((a) => a.runId === run.id) ? (await getScoutRun(user.id, params.id)).run ?? run : run

    const jobs = await getRunJobCounts(user.id, after.id)
    return NextResponse.json({
      run: toRunView(after, jobs),
      redispatched,
      queueActions: swept.actions.filter((a) => a.runId === after.id),
      reaped: reap.reaped.filter((r) => r.runId === run.id),
    })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}
