import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { syncReplies } from '@/lib/email/sync'
import { linkReplies } from '@/lib/outreach/replies'

export const maxDuration = 120

/**
 * Pull replies and attach them to outreach.
 *
 * Two steps, deliberately in this order and deliberately not merged: the first
 * is V1's Gmail sync, untouched; the second reads what it wrote. Diagnostics
 * from both are returned so "0 replies" stays explainable — the reason V1's
 * syncReplies returns them in the first place.
 */
export async function POST() {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const gmail = await syncReplies(user.id)
    const linked = await linkReplies(user.id)

    return NextResponse.json({
      gmail,
      outreach: linked,
      newReplies: linked.newReplies,
      // A Gmail-side error is not fatal to the link step, and vice versa. Both
      // are surfaced rather than collapsed into one message.
      errors: [...(gmail.error ? [gmail.error] : []), ...linked.errors],
    })
  } catch (error) {
    console.error('Reply sync failed:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Reply sync failed' },
      { status: 500 }
    )
  }
}
