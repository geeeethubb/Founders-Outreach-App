import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { isMissingSchema, setDisposition } from '@/lib/career/jobs/store'
import type { JobDisposition } from '@/lib/career/types'

export const dynamic = 'force-dynamic'

const DISPOSITIONS: JobDisposition[] = ['new', 'saved', 'dismissed']

/** POST { disposition: 'new'|'saved'|'dismissed' } → { ok, disposition } */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = ((await request.json().catch(() => ({}))) ?? {}) as { disposition?: string }
    if (!DISPOSITIONS.includes(body.disposition as JobDisposition)) {
      return NextResponse.json({ error: `disposition must be one of ${DISPOSITIONS.join(', ')}` }, { status: 400 })
    }
    // Before migration 014 this select fails on the missing table; say so rather than "not found".
    const { data: job, error: lookupError } = await supabase.from('job_opportunities').select('id').eq('user_id', user.id).eq('id', params.id).maybeSingle()
    if (lookupError && isMissingSchema(lookupError.message)) return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true }, { status: 409 })
    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

    const r = await setDisposition(user.id, params.id, body.disposition as JobDisposition)
    if (r.error) {
      if (isMissingSchema(r.error)) return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true }, { status: 409 })
      return NextResponse.json({ error: r.error }, { status: 500 })
    }
    return NextResponse.json({ ok: true, disposition: body.disposition })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}
