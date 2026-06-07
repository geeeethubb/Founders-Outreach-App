import { createServiceClient } from '@/lib/supabase/server'
import { encryptSecret, decryptSecret } from '@/lib/crypto'

// All access to email_accounts goes through the service-role client so refresh
// tokens never travel to the browser (RLS denies anon reads). Tokens are stored
// encrypted and only decrypted here, server-side.

export interface ConnectedAccount {
  email: string
  refreshToken: string // decrypted — server use only
  scope: string | null
}

/** Full account incl. decrypted refresh token — for the send path. */
export async function getEmailAccount(userId: string): Promise<ConnectedAccount | null> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from('email_accounts')
    .select('email, refresh_token, scope')
    .eq('user_id', userId)
    .maybeSingle()
  if (!data) return null
  return {
    email: data.email,
    refreshToken: decryptSecret(data.refresh_token),
    scope: data.scope,
  }
}

/** Just the connected address — for status UI, no token decryption. */
export async function getConnectedEmail(userId: string): Promise<string | null> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from('email_accounts')
    .select('email')
    .eq('user_id', userId)
    .maybeSingle()
  return data?.email ?? null
}

export async function upsertEmailAccount(
  userId: string,
  email: string,
  refreshToken: string,
  scope: string | null
) {
  const supabase = createServiceClient()
  return supabase.from('email_accounts').upsert({
    user_id: userId,
    email,
    refresh_token: encryptSecret(refreshToken),
    scope,
    updated_at: new Date().toISOString(),
  })
}

export async function deleteEmailAccount(userId: string) {
  const supabase = createServiceClient()
  return supabase.from('email_accounts').delete().eq('user_id', userId)
}
