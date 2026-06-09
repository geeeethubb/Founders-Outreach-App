import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getConnectedAccountInfo } from '@/lib/email/accounts'

// Connection status for the Settings UI — returns the address + whether reply
// tracking is authorized, never a token.
export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const info = await getConnectedAccountInfo(user.id)
  return NextResponse.json({
    connected: !!info,
    email: info?.email ?? null,
    canReadReplies: info?.canReadReplies ?? false,
  })
}
