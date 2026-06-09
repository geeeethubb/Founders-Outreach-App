import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { syncReplies } from '@/lib/email/sync'

// Pull replies from the user's Gmail into conversations. Triggered from the
// Conversations page (on load + manual refresh).
export async function POST() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const result = await syncReplies(user.id)
  if (result.error) return NextResponse.json(result, { status: 400 })
  return NextResponse.json(result)
}
