import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { setUserCompanyIntent } from '@/lib/career/jobs/store'
import { clampPriority, normalizeIntent } from '@/lib/career/companies/intent'
import type { CompanyIntent } from '@/lib/career/types'

export const dynamic = 'force-dynamic'

/**
 * The four things a company can mean to the user. `opening_available` is not
 * here any more: whether a board has a role open right now is state
 * (`open_roles_count`), and it never was a preference.
 */
const USER_SETTABLE: CompanyIntent[] = ['target', 'watching', 'suggested', 'ignored']

interface Body {
  watch_status?: string
  /** Alias, so the UI can promote with { intent: 'target' } in one call. */
  intent?: string
  watch_priority?: number | null
  watch_note?: string | null
  careers_url?: string | null
}

/**
 * The only path in the system that writes `target`, `watching` or `ignored`.
 * It stamps `watch_source = 'user'` and `watch_status_at`, and from then on no
 * planner, scout or careers check may change what this company means.
 */
async function applyUserEdit(request: NextRequest, id: string) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = ((await request.json().catch(() => ({}))) ?? {}) as Body
  const asked = body.watch_status ?? body.intent
  const edit: Parameters<typeof setUserCompanyIntent>[2] = {}
  if (asked !== undefined) {
    const intent = normalizeIntent(asked)
    if (!intent || !USER_SETTABLE.includes(intent)) return NextResponse.json({ error: `watch_status must be one of ${USER_SETTABLE.join(', ')}` }, { status: 400 })
    edit.watch_status = intent
  }
  // Priority is 0–100, higher = more important, everywhere.
  if (body.watch_priority !== undefined) edit.watch_priority = clampPriority(body.watch_priority)
  if (body.watch_note !== undefined) edit.watch_note = typeof body.watch_note === 'string' ? body.watch_note.slice(0, 500) : null
  if (body.careers_url !== undefined) edit.careers_url = typeof body.careers_url === 'string' && body.careers_url.trim() ? body.careers_url.trim() : null
  if (!Object.keys(edit).length) return NextResponse.json({ error: 'nothing to update' }, { status: 400 })

  const r = await setUserCompanyIntent(user.id, id, edit)
  if (r.notFound) return NextResponse.json({ error: 'Company not found' }, { status: 404 })
  if (r.migrationMissing) return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true }, { status: 409 })
  if (r.error) return NextResponse.json({ error: r.error }, { status: 500 })
  return NextResponse.json({ ok: true, company: r.company, intent: r.company?.intent ?? edit.watch_status ?? null, downgraded: r.downgraded })
}

/** PATCH { watch_status?|intent?, watch_priority?, watch_note?, careers_url? } → { ok, company, intent } */
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    return await applyUserEdit(request, params.id)
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}

/** POST — the same edit, so a one-click promote is one call: { intent: 'target' } → { ok, company, intent } */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    return await applyUserEdit(request, params.id)
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}

/**
 * DELETE → intent 'ignored' (the row stays; it may own jobs and contacts).
 * Because the row is now stamped as the user's, no agent can ever re-add it:
 * `resolveAgentIntent` returns the stored intent for a user-owned row.
 *
 * It is not a one-way door: GET /api/career/companies returns ignored rows in
 * their own section, and a PATCH back to `watching` undoes this. The stored
 * company is returned so the page can keep showing the row it just moved.
 */
export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const r = await setUserCompanyIntent(user.id, params.id, { watch_status: 'ignored' })
    if (r.notFound) return NextResponse.json({ error: 'Company not found' }, { status: 404 })
    if (r.migrationMissing) return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true }, { status: 409 })
    if (r.error) return NextResponse.json({ error: r.error }, { status: 500 })
    return NextResponse.json({ ok: true, intent: 'ignored', company: r.company })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}
