import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getConnectedEmail } from '@/lib/email/accounts'

// Connection status for the Settings UI — returns the address only, never a token.
export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const email = await getConnectedEmail(user.id)
  return NextResponse.json({ connected: !!email, email })
}
