import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { getAuthUrl } from '@/lib/google/oauth'

// Kick off the Google consent flow for Gmail send permission.
export async function GET(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.redirect(new URL('/login', request.url))

  try {
    const state = crypto.randomBytes(16).toString('hex')
    const res = NextResponse.redirect(getAuthUrl(state))
    // Short-lived CSRF token, verified in the callback.
    res.cookies.set('g_oauth_state', state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 600,
    })
    return res
  } catch (e) {
    const url = new URL('/dashboard/profile', request.url)
    url.searchParams.set('gmail', 'error')
    url.searchParams.set('reason', e instanceof Error ? e.message : 'config')
    return NextResponse.redirect(url)
  }
}
