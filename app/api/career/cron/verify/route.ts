import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { isMissingSchema } from '@/lib/career/jobs/store'
import { verifyJobs } from '@/lib/career/jobs/verify-batch'
import { DEFAULT_PACKAGE_BUDGET, startCareerRun } from '@/lib/career/runs'
import { scoutToolContext } from '@/lib/career/scout/orchestrator'
import { reapStaleRuns } from '@/lib/career/scout/run-reaper'
import { sweepScoutQueue } from '@/lib/career/scout/queue-watchdog'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const PER_USER_LIMIT = 40
// Leave headroom under the function ceiling so the last user's results persist.
const DEADLINE_MS = 250_000

/**
 * GET (Authorization: Bearer $CRON_SECRET) → { users: [{ user_id, checked, outcomes, changed, applicationsClosed, errors, reaped }], skipped, elapsed_ms }
 * No cookies — Vercel cron has none. 401 on a bad secret, 503 when none is configured.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) return NextResponse.json({ error: 'CRON_SECRET is not set; the verification cron is disabled' }, { status: 503 })
  if (request.headers.get('authorization') !== `Bearer ${secret}`) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const started = Date.now()
  const db = createServiceClient()
  const { data: profiles, error } = await db.from('profiles').select('id')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const users: Record<string, unknown>[] = []
  let skipped = 0
  for (const p of (profiles ?? []) as { id: string }[]) {
    if (Date.now() - started > DEADLINE_MS) {
      skipped++
      continue
    }
    // A scout worker that died takes its run row with it: nothing else moves a
    // run out of 'running' unless someone opens the page and polls it. This is
    // the one process that runs whether or not anybody is watching, so it is
    // where a dead run finally becomes 'partial' (it stored jobs) or 'failed'.
    const reap = await reapStaleRuns(p.id)
    // The queue too. reapStaleRuns only looks at ['running']; without this a run
    // that no worker ever claimed is invisible to the only scheduled sweep there is.
    const queue = await sweepScoutQueue(p.id)

    const run = await startCareerRun({ userId: p.id, kind: 'job_verify', label: 'cron verify', mission: { scope: 'stale' } })
    try {
      const r = await verifyJobs(p.id, { scope: 'stale', limit: PER_USER_LIMIT, ctx: scoutToolContext(p.id, run.runId, DEFAULT_PACKAGE_BUDGET), run })
      if (r.migrationMissing) {
        await run.finish('failed', {}, 'migration 014 missing')
        return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true, users }, { status: 409 })
      }
      await run.finish(r.errors.length && !r.checked ? 'failed' : 'succeeded', { checked: r.checked, outcomes: r.outcomes, changed: r.changed.length, applications_closed: r.applicationsClosed.length }, r.errors[0] ?? null)
      users.push({ user_id: p.id, run_id: run.runId, checked: r.checked, outcomes: r.outcomes, changed: r.changed, applicationsClosed: r.applicationsClosed, errors: r.errors, reaped: reap.reaped, queue: queue.actions })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      await run.finish('failed', {}, message)
      if (isMissingSchema(message)) return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true, users }, { status: 409 })
      users.push({ user_id: p.id, run_id: run.runId, checked: 0, outcomes: {}, changed: [], applicationsClosed: [], errors: [message], reaped: reap.reaped, queue: queue.actions })
    }
  }
  return NextResponse.json({ users, skipped, elapsed_ms: Date.now() - started })
}
