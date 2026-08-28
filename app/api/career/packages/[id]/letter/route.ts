import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { reviewCoverLetter, type LetterReviewResult } from '@/lib/career/package/review'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const MIGRATION = { error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true }

function respond(r: LetterReviewResult) {
  if (r.migrationMissing) return NextResponse.json(MIGRATION, { status: 409 })
  if (r.error) return NextResponse.json({ error: r.error, errors: r.errors }, { status: r.error === 'package not found' ? 404 : 400 })
  return NextResponse.json(
    { letter: r.letter, grounding: r.grounding, refused: r.refused, documents: r.documents, errors: r.errors },
    { status: r.refused ? 422 : 200 }
  )
}

/** PATCH { action: 'approve'|'reject'|'edit', text? } → { letter, grounding, refused, documents, errors }. */
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = (await request.json().catch(() => ({}))) as { action?: string; text?: string }
    const action = body.action
    if (action !== 'approve' && action !== 'reject' && action !== 'edit') {
      return NextResponse.json({ error: 'action must be approve, reject or edit' }, { status: 400 })
    }
    if (action === 'edit' && !body.text?.trim()) return NextResponse.json({ error: 'edit requires text' }, { status: 400 })

    return respond(await reviewCoverLetter({ userId: user.id, packageId: params.id, action, text: body.text }))
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}

/** POST { regenerate: true } → a new cover letter version through the whole pipeline. */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = (await request.json().catch(() => ({}))) as { regenerate?: boolean }
    if (body.regenerate !== true) return NextResponse.json({ error: '{ regenerate: true } is required' }, { status: 400 })

    return respond(await reviewCoverLetter({ userId: user.id, packageId: params.id, action: 'regenerate' }))
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}
