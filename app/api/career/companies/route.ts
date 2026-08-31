import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { listWatchlist, toCompanyView, upsertWatch } from '@/lib/career/jobs/store'
import { ACTIVE_INTENTS, clampPriority, normalizeIntent } from '@/lib/career/companies/intent'
import type { CompanyIntent } from '@/lib/career/types'

export const dynamic = 'force-dynamic'

/** What a user may set. `opening_available` is gone: an opening is state, not intent. */
const USER_SETTABLE: CompanyIntent[] = ['target', 'watching', 'suggested', 'ignored']

/**
 * GET → { companies: [{ …company, watch_status, watch_status_stored, watch_origin, watch_status_at,
 *   open_roles_count, intent, origin, reinterpreted, jobs_total, open_internships }],
 *   counts: { target, watching, suggested, ignored }, intentColumns, reinterpreted }
 *
 * `intent` is the row's meaning to the user (target / watching / suggested /
 * ignored) and `origin` is how it got here. Rows arrive in check order —
 * priority DESCENDING, higher = more important — so a page may render them as
 * received.
 *
 * Ignored rows ARE returned (`?include=active` leaves them out): the page shows
 * them in their own collapsed section, which is the only way a rejection can be
 * undone. The scout still never sees them — it reads the watchlist without
 * them.
 *
 * `reinterpreted` counts rows an agent had written as `target`/`watching` that
 * this read corrected to `suggested`. Non-zero means migration 016 is still
 * pending, and the page says so rather than presenting 163 invented targets as
 * the user's own choices.
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const db = createServiceClient()
    const include = new URL(request.url).searchParams.get('include')
    const res = await listWatchlist(user.id, db, { includeIgnored: include !== 'active' })
    if (res.migrationMissing) return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true }, { status: 409 })
    if (res.error) return NextResponse.json({ error: res.error }, { status: 500 })

    // Open internships per company: one query over the user's open jobs, counted here.
    const { data: open } = await db
      .from('job_opportunities')
      .select('company_id')
      .eq('user_id', user.id)
      .eq('is_canonical', true)
      .in('verification_status', ['VERIFIED_OPEN', 'LIKELY_OPEN'])
      .in('employment_type', ['internship', 'co_op'])
    const openByCompany = new Map<string, number>()
    for (const r of (open ?? []) as { company_id: string | null }[]) if (r.company_id) openByCompany.set(r.company_id, (openByCompany.get(r.company_id) ?? 0) + 1)

    const companies: Record<string, unknown>[] = res.companies.map((c) => {
      const view = toCompanyView(c)
      return { ...view, open_internships: openByCompany.get(String(view.id)) ?? 0 }
    })
    const counts = {
      target: companies.filter((c) => c.intent === 'target').length,
      watching: companies.filter((c) => c.intent === 'watching').length,
      suggested: companies.filter((c) => c.intent === 'suggested').length,
      ignored: companies.filter((c) => c.intent === 'ignored').length,
    }
    return NextResponse.json({ companies, counts, intentColumns: res.intentColumns, reinterpreted: res.reinterpreted })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}

/**
 * POST { name, domain?, careers_url?, watch_status?='watching', watch_priority?, watch_note? } → { id, intent }
 *
 * A company the user typed in. It defaults to **watching**, not target: adding
 * a name is "keep an eye on this", and promoting it to a target is a separate,
 * deliberate click. The row is stamped as the user's, which is what stops any
 * later agent write from changing it.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = ((await request.json().catch(() => ({}))) ?? {}) as { name?: string; domain?: string | null; careers_url?: string | null; watch_status?: string; intent?: string; watch_priority?: number | null; watch_note?: string | null }
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })
    const asked = normalizeIntent(body.watch_status ?? body.intent)
    if ((body.watch_status ?? body.intent) !== undefined && (!asked || !USER_SETTABLE.includes(asked))) {
      return NextResponse.json({ error: `watch_status must be one of ${USER_SETTABLE.join(', ')}` }, { status: 400 })
    }

    const r = await upsertWatch(user.id, {
      name,
      domain: typeof body.domain === 'string' ? body.domain.trim() || null : null,
      careers_url: typeof body.careers_url === 'string' ? body.careers_url.trim() || null : null,
      watch_status: asked ?? 'watching',
      watch_priority: body.watch_priority !== undefined ? clampPriority(body.watch_priority) : undefined,
      watch_note: typeof body.watch_note === 'string' ? body.watch_note.slice(0, 500) : undefined,
      watch_source: 'user',
      watch_origin: 'user',
    })
    if (r.migrationMissing) return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true }, { status: 409 })
    if (r.error || !r.id) return NextResponse.json({ error: r.error ?? 'Failed' }, { status: 500 })
    return NextResponse.json({ id: r.id, intent: r.intent, active: r.intent ? ACTIVE_INTENTS.includes(r.intent) : false })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}
