import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { ensureApplication, listApplications } from '@/lib/career/applications/store'
import { APPLICATION_STATES, type ApplicationState } from '@/lib/career/types'
import { STATE_LABELS, APPLICATION_TRANSITIONS } from '@/lib/career/applications/states'

export const dynamic = 'force-dynamic'

/** The tracker. `?states=APPLIED,INTERVIEW` narrows it. */
export async function GET(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const param = new URL(request.url).searchParams.get('states')
    const states = param
      ? (param.split(',').filter((s): s is ApplicationState => APPLICATION_STATES.includes(s as ApplicationState)))
      : undefined
    const { applications, migrationMissing, error } = await listApplications(user.id, { states })
    if (migrationMissing) {
      return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true }, { status: 409 })
    }
    if (error) return NextResponse.json({ error }, { status: 500 })
    return NextResponse.json({ applications, labels: STATE_LABELS, transitions: APPLICATION_TRANSITIONS })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}

/** Start tracking a job: { job_id, state? } → the (possibly pre-existing) application. */
export async function POST(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = (await request.json()) as { job_id?: string; state?: string }
    if (!body.job_id) return NextResponse.json({ error: 'job_id is required' }, { status: 400 })
    const initial = APPLICATION_STATES.includes(body.state as ApplicationState) ? (body.state as ApplicationState) : 'SAVED'

    const { data: job } = await supabase
      .from('job_opportunities')
      .select('id, company_id')
      .eq('user_id', user.id)
      .eq('id', body.job_id)
      .maybeSingle()
    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

    const result = await ensureApplication(user.id, body.job_id, { initialState: initial, companyId: job.company_id as string | null })
    if (result.migrationMissing) {
      return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true }, { status: 409 })
    }
    if (result.error || !result.application) return NextResponse.json({ error: result.error ?? 'Failed' }, { status: 500 })
    return NextResponse.json({ application: result.application, created: result.created })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}
