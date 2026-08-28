import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { verifyJobs } from '@/lib/career/jobs/verify-batch'
import { DEFAULT_PACKAGE_BUDGET, startCareerRun } from '@/lib/career/runs'
import { scoutToolContext } from '@/lib/career/scout/orchestrator'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** POST → { status, note, last_verified_at, changed: boolean, from, applicationsClosed } */
export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // A run row per click, so a Job Verifier call made here is traced like the cron's.
    const run = await startCareerRun({ userId: user.id, kind: 'job_verify', label: 'verify · one job', mission: { job_id: params.id } })
    const res = await verifyJobs(user.id, { scope: 'ids', ids: [params.id], limit: 1, ctx: scoutToolContext(user.id, run.runId, DEFAULT_PACKAGE_BUDGET), run })
    await run.finish(res.migrationMissing || (res.errors.length && !res.checked) ? 'failed' : 'succeeded', { checked: res.checked, outcomes: res.outcomes, changed: res.changed.length }, res.errors[0] ?? null)
    if (res.migrationMissing) return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true }, { status: 409 })
    const outcome = res.results[0]
    if (!outcome) return NextResponse.json({ error: res.errors[0] ?? 'Job not found' }, { status: res.errors.length ? 500 : 404 })
    const change = res.changed.find((c) => c.id === params.id) ?? null
    return NextResponse.json({
      status: outcome.status,
      note: outcome.note,
      last_verified_at: outcome.last_verified_at,
      changed: change !== null,
      from: change?.from ?? outcome.status,
      applicationsClosed: res.applicationsClosed,
    })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}
