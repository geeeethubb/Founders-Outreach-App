import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { revoke } from '@/lib/google/oauth'
import { getEmailAccount, deleteEmailAccount } from '@/lib/email/accounts'

// Revoke the Google grant and remove the stored account.
export async function POST() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const account = await getEmailAccount(user.id)
  if (account) await revoke(account.refreshToken)
  await deleteEmailAccount(user.id)

  return NextResponse.json({ success: true })
}
