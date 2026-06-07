import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { exchangeCode } from '@/lib/google/oauth'
import { upsertEmailAccount } from '@/lib/email/accounts'

// Google redirects here after consent. Exchange the code, store the refresh
// token (encrypted), and bounce back to Settings with a result.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)

  const result = (status: string, reason?: string): NextResponse => {
    const url = new URL('/dashboard/profile', request.url)
    url.searchParams.set('gmail', status)
    if (reason) url.searchParams.set('reason', reason)
    const res = NextResponse.redirect(url)
    res.cookies.set('g_oauth_state', '', { path: '/', maxAge: 0 }) // clear CSRF cookie
    return res
  }

  const oauthError = searchParams.get('error')
  if (oauthError) return result('error', oauthError)

  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const cookieState = request.cookies.get('g_oauth_state')?.value
  if (!code || !state || !cookieState || state !== cookieState) {
    return result('error', 'invalid_state')
  }

  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.redirect(new URL('/login', request.url))

  try {
    const { refreshToken, email, scope } = await exchangeCode(code)
    const { error } = await upsertEmailAccount(user.id, email, refreshToken, scope)
    if (error) throw new Error(error.message)
    return result('connected')
  } catch (e) {
    return result('error', e instanceof Error ? e.message : 'exchange_failed')
  }
}
