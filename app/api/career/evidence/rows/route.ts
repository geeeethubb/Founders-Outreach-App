import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { insertRows } from '@/lib/career/evidence/store'
import { findExperienceMatch, findFactMatch } from '@/lib/career/evidence/plan'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { EDITABLE_TABLES, sanitizeRow, type EditableTable } from './shared'

export const dynamic = 'force-dynamic'

/**
 * Insert one row. The table is allow-listed and user_id is forced — never
 * trusted from the body. A row that already exists under the bank's own
 * matching rules (./plan) comes back as `{ id, existing: true }` instead of
 * a second copy: "+ add fact" twice is not two facts, and a skill the unique
 * index would reject is the row it collides with, not a 500.
 */
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

    const existing = await findExisting(supabase, table, row.row)
    if (existing) return NextResponse.json({ id: existing.id, existing: true, rule: existing.rule })

    const res = await insertRows(table, [{ ...row.row, user_id: user.id }])
    if (res.migrationMissing) {
      return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first.', migrationMissing: true }, { status: 409 })
    }
    if (res.error) {
      // The unique index on lower(name) fires when two requests race the
      // lookup above; the answer is still the row that won.
      if (table === 'evidence_skills' && /duplicate key|unique/i.test(res.error)) {
        const again = await findExisting(supabase, table, row.row)
        if (again) return NextResponse.json({ id: again.id, existing: true, rule: again.rule })
      }
      return NextResponse.json({ error: res.error }, { status: 500 })
    }
    return NextResponse.json({ id: res.ids[0], existing: false })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Insert failed' }, { status: 500 })
  }
}

/**
 * The row this insert would duplicate, if any. Reads through the user's own
 * client, so RLS scopes the lookup; a read error (including a missing
 * migration) is treated as "nothing found" and the insert reports it.
 */
async function findExisting(
  supabase: ReturnType<typeof createClient>,
  table: EditableTable,
  row: Record<string, unknown>
): Promise<{ id: string; rule: string } | null> {
  if (table === 'evidence_facts') {
    const statement = String(row.statement ?? '')
    const experienceId = typeof row.experience_id === 'string' ? row.experience_id : null
    let q = supabase.from('evidence_facts').select('id, experience_id, statement')
    q = experienceId === null ? q.is('experience_id', null) : q.eq('experience_id', experienceId)
    const { data } = await q
    const hit = findFactMatch((data ?? []) as { id: string; experience_id: string | null; statement: string }[], experienceId, statement)
    return hit ? { id: hit.id, rule: 'same_statement' } : null
  }
  if (table === 'evidence_skills') {
    const name = String(row.name ?? '').trim()
    const { data } = await supabase.from('evidence_skills').select('id, name').ilike('name', name)
    const hit = ((data ?? []) as { id: string; name: string }[]).find((s) => s.name.toLowerCase() === name.toLowerCase())
    return hit ? { id: hit.id, rule: 'same_name' } : null
  }
  if (table === 'evidence_experiences') {
    const { data } = await supabase.from('evidence_experiences').select('id, organization, title, start_date, end_date')
    // Exact or aliased key only. A human typing a distinct title means it;
    // the similar-title rule is for the importer, which does not.
    const { match } = findExperienceMatch(
      (data ?? []) as { id: string; organization: string; title: string; start_date: string | null; end_date: string | null }[],
      {
        organization: String(row.organization ?? ''),
        title: String(row.title ?? ''),
        start_date: typeof row.start_date === 'string' ? row.start_date : null,
        end_date: typeof row.end_date === 'string' ? row.end_date : null,
      },
      { allowSimilar: false }
    )
    return match ? { id: match.id, rule: match.rule } : null
  }
  return null
}
