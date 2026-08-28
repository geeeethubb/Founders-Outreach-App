import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { insertRows } from '@/lib/career/evidence/store'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { EDITABLE_TABLES, sanitizeRow, type EditableTable } from './shared'

export const dynamic = 'force-dynamic'

/** Insert one row. The table is allow-listed and user_id is forced — never trusted from the body. */
export async function POST(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = (await request.json().catch(() => ({}))) as { table?: string; row?: Record<string, unknown> }
    const table = String(body.table ?? '') as EditableTable
    if (!EDITABLE_TABLES.includes(table)) return NextResponse.json({ error: `unknown table: ${body.table}` }, { status: 400 })
    if (!body.row || typeof body.row !== 'object') return NextResponse.json({ error: 'row required' }, { status: 400 })

    const row = sanitizeRow(table, body.row)
    if ('error' in row) return NextResponse.json({ error: row.error }, { status: 400 })

    const res = await insertRows(table, [{ ...row.row, user_id: user.id }])
    if (res.migrationMissing) {
      return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first.', migrationMissing: true }, { status: 409 })
    }
    if (res.error) return NextResponse.json({ error: res.error }, { status: 500 })
    return NextResponse.json({ id: res.ids[0] })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Insert failed' }, { status: 500 })
  }
}
