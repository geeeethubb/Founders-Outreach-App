import { OAuth2Client } from 'google-auth-library'

// Dedicated Google OAuth flow that grants this app permission to SEND mail as
// the user (gmail.send) and READ their mail (gmail.readonly) so we can fold
// replies into Conversations, plus openid/email so we can read which address
// they connected. This is separate from app login — users authorize here.

const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
]

export function oauthClient(): OAuth2Client {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  const redirectUri = process.env.GOOGLE_REDIRECT_URI
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('Google OAuth is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI)')
  }
  return new OAuth2Client({ clientId, clientSecret, redirectUri })
}

/** Build the consent-screen URL. `offline` + `consent` guarantee a refresh token. */
export function getAuthUrl(state: string): string {
  return oauthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state,
    include_granted_scopes: true,
  })
}

/** Exchange an authorization code for a refresh token + the connected email. */
export async function exchangeCode(code: string): Promise<{
  refreshToken: string
  email: string
  scope: string | null
}> {
  const client = oauthClient()
  const { tokens } = await client.getToken(code)

  if (!tokens.refresh_token) {
    // Happens when Google has a prior grant and skips re-consent. We force
    // prompt=consent above, so this is rare — but guard anyway.
    throw new Error('Google did not return a refresh token. Remove this app at myaccount.google.com/permissions and reconnect.')
  }

  let email = ''
  if (tokens.id_token) {
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_CLIENT_ID,
    })
    email = ticket.getPayload()?.email ?? ''
  }
  if (!email) throw new Error('Could not determine the connected Google account email')

  return { refreshToken: tokens.refresh_token, email, scope: tokens.scope ?? null }
}

/** Mint a fresh, short-lived access token from a stored refresh token. */
export async function getAccessToken(refreshToken: string): Promise<string> {
  const client = oauthClient()
  client.setCredentials({ refresh_token: refreshToken })
  const { token } = await client.getAccessToken()
  if (!token) {
    throw new Error('Failed to obtain a Google access token — the connection may have been revoked. Reconnect Gmail in Settings.')
  }
  return token
}

/** Best-effort revoke of a grant at Google (used on disconnect). */
export async function revoke(refreshToken: string): Promise<void> {
  try {
    await oauthClient().revokeToken(refreshToken)
  } catch {
    // Token may already be invalid/revoked — nothing to do.
  }
}
