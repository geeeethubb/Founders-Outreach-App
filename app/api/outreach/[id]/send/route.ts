import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { sendOutreach } from '@/lib/outreach/send'
import { MigrationMissingError } from '@/lib/outreach/store'

/**
 * Send one approved draft.
 *
 * Its own endpoint, separate from the approval PATCH, so that nothing which
 * merely updates a draft can ever end up putting mail in someone's inbox.
 * Idempotent: a repeated request against an already-sent outreach answers 200
 * with `alreadySent`, and never produces a second email.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const result = await sendOutreach(user.id, params.id)

    return NextResponse.json(
      {
        ok: result.ok,
        alreadySent: result.alreadySent ?? false,
        outreach: result.outreach ?? null,
        grounding: result.grounding ?? null,
        error: result.error ?? null,
      },
      { status: result.status }
    )
  } catch (error) {
    if (error instanceof MigrationMissingError) {
      return NextResponse.json({ error: error.message, migrationMissing: true }, { status: 503 })
    }
    console.error('Send failed:', error)
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Send failed' },
      { status: 500 }
    )
  }
}
