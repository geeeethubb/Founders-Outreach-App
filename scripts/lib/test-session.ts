// A real browser session for the acceptance scripts — minted, never typed.
//
// The scouting routes authenticate with the Supabase auth cookie the browser
// carries, and an acceptance run has to go through those routes exactly as the
// founder's browser does — enqueue, poll, cancel — or it proves nothing about
// them. Nobody should have to paste a password into a script for that, so this
// asks the Supabase admin API for a magic-link token (it sends no email),
// exchanges it for a session, and writes that session the way @supabase/ssr
// writes it: `sb-<project-ref>-auth-token`, base64url with the `base64-` prefix,
// split into 3180-byte chunks. The result is a Cookie header any fetch can send.
//
// Service role only, local scripts only. Never imported by the app.

import { createClient as createSupabaseClient } from '@supabase/supabase-js'

const MAX_CHUNK = 3180

export interface MintedSession {
  userId: string
  email: string
  cookieHeader: string
  accessToken: string
}

function projectRef(url: string): string {
  const host = new URL(url).hostname
  return host.split('.')[0]
}

function chunk(key: string, value: string): { name: string; value: string }[] {
  if (value.length <= MAX_CHUNK) return [{ name: key, value }]
  const out: { name: string; value: string }[] = []
  for (let i = 0, n = 0; i < value.length; i += MAX_CHUNK, n++) out.push({ name: `${key}.${n}`, value: value.slice(i, i + MAX_CHUNK) })
  return out
}

export async function mintSession(userId?: string | null): Promise<MintedSession> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !anon || !service) throw new Error('NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are required')

  const admin = createSupabaseClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } })
  let email: string | null = null
  if (userId) {
    const { data, error } = await admin.auth.admin.getUserById(userId)
    if (error || !data.user?.email) throw new Error(`could not load auth user ${userId}: ${error?.message ?? 'no email'}`)
    email = data.user.email
  } else {
    const { data, error } = await admin.from('profiles').select('id, email').order('created_at', { ascending: true })
    if (error) throw new Error(`could not list profiles: ${error.message}`)
    const rows = (data ?? []) as { id: string; email: string | null }[]
    if (rows.length !== 1) throw new Error(`${rows.length} profiles exist — pass a user id`)
    userId = rows[0].id
    const { data: au, error: auErr } = await admin.auth.admin.getUserById(userId)
    if (auErr || !au.user?.email) throw new Error(`could not load auth user ${userId}: ${auErr?.message ?? 'no email'}`)
    email = au.user.email
  }

  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email })
  if (linkErr || !link?.properties?.hashed_token) throw new Error(`generateLink failed: ${linkErr?.message ?? 'no token'}`)

  const client = createSupabaseClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: verified, error: verifyErr } = await client.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' })
  if (verifyErr || !verified.session) throw new Error(`verifyOtp failed: ${verifyErr?.message ?? 'no session'}`)

  const session = verified.session
  const key = `sb-${projectRef(url)}-auth-token`
  const encoded = 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url')
  const cookieHeader = chunk(key, encoded).map((c) => `${c.name}=${c.value}`).join('; ')
  return { userId: userId!, email, cookieHeader, accessToken: session.access_token }
}
