import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { syncReplies } from '@/lib/email/sync'
import { linkReplies } from '@/lib/outreach/replies'

// Pull replies from the user's Gmail into conversations, then attach them to
// the Outreach rows they answer. Triggered from the Conversations page (on load
// + manual refresh). linkReplies is idempotent: it only reads what syncReplies
// wrote and only updates a row when a newer inbound message exists.
export async function POST() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const result = await syncReplies(user.id)
  if (result.error) return NextResponse.json(result, { status: 400 })

  const linked = await linkReplies(user.id)
  return NextResponse.json({
    ...result,
    outreach: linked,
    errors: [...(result.error ? [result.error] : []), ...linked.errors],
  })
}
