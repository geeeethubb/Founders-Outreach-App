import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { packageView } from '@/lib/career/package/view'

export const dynamic = 'force-dynamic'

/** GET → the package view JSON (see lib/career/package/view.ts shapePackageView). */
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const r = await packageView(user.id, params.id)
    if (r.migrationMissing) return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true }, { status: 409 })
    if (!r.view) return NextResponse.json({ error: r.error ?? 'Failed' }, { status: r.error === 'package not found' ? 404 : 500 })
    return NextResponse.json(r.view)
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}
