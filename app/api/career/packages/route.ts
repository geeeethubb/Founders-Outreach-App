import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { generatePackage } from '@/lib/career/package/orchestrator'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * POST { job_id } → intelligence + tailoring, then STOP at résumé review.
 * Documents are built only after the human approves the diff (POST …/resume { approve: true }).
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = (await request.json().catch(() => ({}))) as { job_id?: string }
    if (!body.job_id) return NextResponse.json({ error: 'job_id is required' }, { status: 400 })

    const r = await generatePackage({ userId: user.id, jobId: body.job_id })
    if (r.migrationMissing) return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true }, { status: 409 })
    if (!r.packageId) {
      const status = r.error === 'job not found' ? 404 : r.error?.startsWith('Evidence Bank') ? 400 : 500
      return NextResponse.json({ error: r.error ?? 'Failed', errors: r.errors }, { status })
    }

    return NextResponse.json(
      {
        package_id: r.packageId, status: r.status, stage: r.stage, version: r.version,
        application: { id: r.applicationId, state: r.applicationState },
        resume: r.resume, costUsd: r.costUsd, warnings: r.warnings, errors: r.errors, error: r.error,
      },
      { status: r.status === 'failed' ? 500 : 200 }
    )
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}
