import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { isMissingSchema } from '@/lib/career/jobs/store'
import type { WatchStatus } from '@/lib/career/types'

export const dynamic = 'force-dynamic'

const WATCH_STATUSES: WatchStatus[] = ['target', 'watching', 'opening_available', 'ignored']

async function ownedCompany(userId: string, id: string): Promise<{ id: string } | null> {
  const db = createServiceClient()
  const { data } = await db.from('companies').select('id').eq('user_id', userId).eq('id', id).maybeSingle()
  return (data as { id: string } | null) ?? null
}

/** PATCH { watch_status?, watch_priority?, watch_note?, careers_url? } → { ok, company } — a user edit always owns the row afterwards. */
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!(await ownedCompany(user.id, params.id))) return NextResponse.json({ error: 'Company not found' }, { status: 404 })

    const body = ((await request.json().catch(() => ({}))) ?? {}) as { watch_status?: string; watch_priority?: number | null; watch_note?: string | null; careers_url?: string | null }
    const patch: Record<string, unknown> = {}
    if (body.watch_status !== undefined) {
      if (!WATCH_STATUSES.includes(body.watch_status as WatchStatus)) return NextResponse.json({ error: `watch_status must be one of ${WATCH_STATUSES.join(', ')}` }, { status: 400 })
      patch.watch_status = body.watch_status
      patch.watch_source = 'user'
    }
    if (body.watch_priority !== undefined) patch.watch_priority = typeof body.watch_priority === 'number' ? Math.round(body.watch_priority) : null
    if (body.watch_note !== undefined) patch.watch_note = typeof body.watch_note === 'string' ? body.watch_note.slice(0, 500) : null
    if (body.careers_url !== undefined) patch.careers_url = typeof body.careers_url === 'string' && body.careers_url.trim() ? body.careers_url.trim() : null
    if (!Object.keys(patch).length) return NextResponse.json({ error: 'nothing to update' }, { status: 400 })

    const db = createServiceClient()
    const { data, error } = await db.from('companies').update(patch as never).eq('id', params.id).eq('user_id', user.id).select('id, name, domain, careers_url, ats_type, ats_identifier, watch_status, watch_priority, watch_note, watch_source').single()
    if (error) {
      if (isMissingSchema(error.message)) return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true }, { status: 409 })
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ ok: true, company: data })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}

/** DELETE → watch_status 'ignored' (the company row stays; it may own jobs and contacts) → { ok } */
export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!(await ownedCompany(user.id, params.id))) return NextResponse.json({ error: 'Company not found' }, { status: 404 })

    const db = createServiceClient()
    const { error } = await db.from('companies').update({ watch_status: 'ignored', watch_source: 'user' } as never).eq('id', params.id).eq('user_id', user.id)
    if (error) {
      if (isMissingSchema(error.message)) return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true }, { status: 409 })
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}
