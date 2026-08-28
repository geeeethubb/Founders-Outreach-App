import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { addJobFromUrl } from '@/lib/career/jobs/manual'
import { ensureDefaultMission } from '@/lib/career/missions/store'
import { DEFAULT_PACKAGE_BUDGET, startCareerRun } from '@/lib/career/runs'
import { scoutToolContext } from '@/lib/career/scout/orchestrator'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/** POST { url } → { jobId, job, warnings } · 422 with { error } when the URL cannot be read (LinkedIn etc.) */
export async function POST(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = ((await request.json().catch(() => ({}))) ?? {}) as { url?: string }
    if (!body.url || typeof body.url !== 'string') return NextResponse.json({ error: 'url is required' }, { status: 400 })

    const m = await ensureDefaultMission(user.id)
    if (m.error && /014_career_os/.test(m.error)) {
      return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true }, { status: 409 })
    }
    // One run row per manual add so the extractor/verifier calls it makes are
    // traced like every other agent call (agent_runs.run_id), not orphaned.
    const run = await startCareerRun({ userId: user.id, kind: 'job_scout', label: 'manual add', mission: { url: body.url }, careerMissionId: m.mission?.id ?? null })
    const result = await addJobFromUrl(user.id, body.url, { mission: m.mission, ctx: scoutToolContext(user.id, run.runId, DEFAULT_PACKAGE_BUDGET), run })
    await run.finish(result.error || result.migrationMissing ? 'failed' : 'succeeded', { job_id: result.jobId, warnings: result.warnings.length }, result.error)
    if (result.migrationMissing) {
      return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true }, { status: 409 })
    }
    if (result.error) return NextResponse.json({ error: result.error, warnings: result.warnings }, { status: 422 })
    return NextResponse.json({ jobId: result.jobId, job: result.job, warnings: result.warnings })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}
