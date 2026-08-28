import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { applyFeedbackToJob, recomputeFitForMission } from '@/lib/career/fit/rank'

export const dynamic = 'force-dynamic'

/**
 * POST { jobId?, missionId? } → { updated, overall?, errors }.
 * With jobId: re-sum that job's evaluations (after a feedback POST).
 * Without: every evaluation for the mission (or all of them when missionId is absent). Zero model calls.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = (await request.json().catch(() => ({}))) as { jobId?: string; missionId?: string }
    if (body.jobId) {
      const r = await applyFeedbackToJob(user.id, body.jobId)
      if (r.migrationMissing) return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true }, { status: 409 })
      return NextResponse.json({ updated: r.updated, overall: r.overall, errors: r.errors })
    }
    const r = await recomputeFitForMission(user.id, body.missionId ?? null)
    if (r.migrationMissing) return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true }, { status: 409 })
    return NextResponse.json({ updated: r.updated, errors: r.errors })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}
