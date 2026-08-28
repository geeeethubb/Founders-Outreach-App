import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { listWatchlist, upsertWatch } from '@/lib/career/jobs/store'
import type { WatchStatus } from '@/lib/career/types'

export const dynamic = 'force-dynamic'

const WATCH_STATUSES: WatchStatus[] = ['target', 'watching', 'opening_available', 'ignored']

/**
 * GET → { companies: [{ id, name, domain, website_url, careers_url, ats_type, ats_identifier, watch_status,
 *   watch_priority, watch_note, watch_source, last_careers_check_at, careers_check_note, company_type,
 *   industry_tags, jobs_total, open_internships }] }
 */
export async function GET() {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const res = await listWatchlist(user.id)
    if (res.migrationMissing) return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true }, { status: 409 })
    if (res.error) return NextResponse.json({ error: res.error }, { status: 500 })

    // Open internships per company: one query over the user's open jobs, counted here.
    const db = createServiceClient()
    const { data: open } = await db
      .from('job_opportunities')
      .select('company_id')
      .eq('user_id', user.id)
      .eq('is_canonical', true)
      .in('verification_status', ['VERIFIED_OPEN', 'LIKELY_OPEN'])
      .in('employment_type', ['internship', 'co_op'])
    const openByCompany = new Map<string, number>()
    for (const r of (open ?? []) as { company_id: string | null }[]) if (r.company_id) openByCompany.set(r.company_id, (openByCompany.get(r.company_id) ?? 0) + 1)

    const companies = res.companies.map((c) => {
      const { jobs, ...rest } = c as Record<string, unknown> & { jobs?: { count: number }[] }
      return { ...rest, jobs_total: Number(jobs?.[0]?.count ?? 0), open_internships: openByCompany.get(String(c.id)) ?? 0 }
    })
    return NextResponse.json({ companies })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}

/** POST { name, domain?, careers_url?, watch_status?='target', watch_priority?, watch_note? } → { id } */
export async function POST(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = ((await request.json().catch(() => ({}))) ?? {}) as { name?: string; domain?: string | null; careers_url?: string | null; watch_status?: string; watch_priority?: number | null; watch_note?: string | null }
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })
    const status = WATCH_STATUSES.includes(body.watch_status as WatchStatus) ? (body.watch_status as WatchStatus) : 'target'

    const r = await upsertWatch(user.id, {
      name,
      domain: typeof body.domain === 'string' ? body.domain.trim() || null : null,
      careers_url: typeof body.careers_url === 'string' ? body.careers_url.trim() || null : null,
      watch_status: status,
      watch_priority: typeof body.watch_priority === 'number' ? body.watch_priority : undefined,
      watch_note: typeof body.watch_note === 'string' ? body.watch_note.slice(0, 500) : undefined,
      watch_source: 'user',
    })
    if (r.migrationMissing) return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true }, { status: 409 })
    if (r.error || !r.id) return NextResponse.json({ error: r.error ?? 'Failed' }, { status: 500 })
    return NextResponse.json({ id: r.id })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}
