import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { finalizePackage } from '@/lib/career/package/orchestrator'

export const dynamic = 'force-dynamic'

/** POST { acknowledge_letter?: boolean } → { status, application_state }. Requires ready_for_review and an approved/edited letter. */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = (await request.json().catch(() => ({}))) as { acknowledge_letter?: boolean }
    const r = await finalizePackage({ userId: user.id, packageId: params.id, acknowledgeLetter: body.acknowledge_letter === true })
    if (r.migrationMissing) return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true }, { status: 409 })
    if (!r.ok) return NextResponse.json({ error: r.error, status: r.status }, { status: r.error === 'package not found' ? 404 : 409 })
    return NextResponse.json({ status: r.status, application_state: r.applicationState })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}
