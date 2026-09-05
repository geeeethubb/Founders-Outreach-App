// The HTTP face of the worker, shared by both route paths.
//
//   POST /api/scout/worker          { runId, token } → one leg of the run
//   POST /api/career/scout/worker   the same handler (the older address)
//   GET  /api/scout/worker          health — answered to the readiness probe
//
// Machine-to-machine. There is no user session here (the request comes from
// another function invocation, not a browser), so the ONLY credential is the
// run's single-use claim token: it authenticates the caller and, because
// claiming consumes it under a status guard, it also makes double execution
// impossible. A stolen or replayed token claims nothing.
//
// The route files themselves declare `dynamic` and `maxDuration` literally —
// Next reads segment config from the file, not from a re-export.

import { NextRequest, NextResponse } from 'next/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { jobScoutExecutor } from '@/lib/career/scout/execute'
import { peopleScoutExecutor } from '@/lib/scouting/execute'
import { platformWaitUntil } from '@/lib/career/scout/background'
import { invocationBudgetMs } from './deadline'
import { runWorkerLeg } from './worker'

export async function workerPost(request: NextRequest): Promise<NextResponse> {
  // The platform's ceiling counts from here.
  const entryMs = Date.now()
  try {
    const body = ((await request.json().catch(() => ({}))) ?? {}) as { runId?: string; token?: string }
    const res = await runWorkerLeg(body, entryMs, { executors: { job_scout: jobScoutExecutor, outreach: peopleScoutExecutor } })
    return NextResponse.json(res.body, { status: res.status })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    // A throw BEFORE the claim (a malformed body, a database outage while
    // claiming). Nothing was claimed, so nothing is closed here.
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: message, code: 'INTERNAL' }, { status: 500 })
  }
}

/** What the readiness probe asks: are you the worker, which deployment, and how long may a leg run? */
export async function workerHealth(): Promise<NextResponse> {
  return NextResponse.json({
    ok: true,
    worker: 'scout',
    deployment: process.env.VERCEL_DEPLOYMENT_ID ?? null,
    env: process.env.VERCEL_ENV ?? (process.env.VERCEL ? 'unknown' : 'local'),
    budget_ms: invocationBudgetMs(),
    wait_until: platformWaitUntil() !== null,
    node: process.version,
  })
}
