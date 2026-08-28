import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { deleteRow, updateRow } from '@/lib/career/evidence/store'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { EDITABLE_TABLES, sanitizeRow, type EditableTable } from '../shared'

export const dynamic = 'force-dynamic'

function tableFrom(request: NextRequest): EditableTable | null {
  const t = new URL(request.url).searchParams.get('table') ?? ''
  return EDITABLE_TABLES.includes(t as EditableTable) ? (t as EditableTable) : null
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const table = tableFrom(request)
    if (!table) return NextResponse.json({ error: 'unknown or missing ?table=' }, { status: 400 })
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const patch = sanitizeRow(table, body, { partial: true })
    if ('error' in patch) return NextResponse.json({ error: patch.error }, { status: 400 })
    if (Object.keys(patch.row).length === 0) return NextResponse.json({ error: 'nothing to update' }, { status: 400 })

    const res = await updateRow(table, user.id, params.id, patch.row)
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Update failed' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const table = tableFrom(request)
    if (!table) return NextResponse.json({ error: 'unknown or missing ?table=' }, { status: 400 })
    const res = await deleteRow(table, user.id, params.id)
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Delete failed' }, { status: 500 })
  }
}
