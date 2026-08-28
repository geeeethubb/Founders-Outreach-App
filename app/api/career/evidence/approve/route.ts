import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { setApproved } from '@/lib/career/evidence/store'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { APPROVABLE_TABLES } from '../rows/shared'

export const dynamic = 'force-dynamic'

/** Bulk approve / un-approve. `{ table, ids, approved }`. */
export async function POST(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = (await request.json().catch(() => ({}))) as { table?: string; ids?: unknown; approved?: unknown }
    const table = String(body.table ?? '') as (typeof APPROVABLE_TABLES)[number]
    if (!APPROVABLE_TABLES.includes(table)) return NextResponse.json({ error: `table not approvable: ${body.table}` }, { status: 400 })
    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : []
    if (ids.length === 0) return NextResponse.json({ error: 'ids required' }, { status: 400 })

    const res = await setApproved(table, user.id, ids, body.approved !== false)
    if (res.error) {
      const missing = /relation .* does not exist|schema cache|could not find/i.test(res.error)
      return NextResponse.json(
        { error: missing ? 'Apply supabase/migrations/014_career_os.sql first.' : res.error, migrationMissing: missing },
        { status: missing ? 409 : 500 }
      )
    }
    return NextResponse.json({ updated: res.updated })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Approve failed' }, { status: 500 })
  }
}
