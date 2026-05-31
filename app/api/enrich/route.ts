import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

const APOLLO_API_KEY = process.env.APOLLO_API_KEY ?? ''

interface ApolloPersonResponse {
  person?: {
    first_name?: string
    last_name?: string
    name?: string
    email?: string
    personal_emails?: string[]
    title?: string
    linkedin_url?: string
    city?: string
    state?: string
    country?: string
    organization?: {
      name?: string
      website_url?: string
    }
    employment_history?: Array<{
      title?: string
      organization_name?: string
      current?: boolean
    }>
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { linkedin_url } = (await request.json()) as { linkedin_url: string }

    if (!linkedin_url?.includes('linkedin.com')) {
      return NextResponse.json({ error: 'A valid LinkedIn URL is required' }, { status: 400 })
    }

    if (!APOLLO_API_KEY) {
      return NextResponse.json({ error: 'Apollo API key not configured' }, { status: 500 })
    }

    // Call Apollo People Match
    // Apollo v1 requires api_key in the request body (not as a header)
    const apolloRes = await fetch('https://api.apollo.io/v1/people/match', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      },
      body: JSON.stringify({
        api_key: APOLLO_API_KEY,
        linkedin_url,
        reveal_personal_emails: true,
        reveal_phone_number: false,
      }),
    })

    if (!apolloRes.ok) {
      const text = await apolloRes.text()
      console.error('Apollo error:', apolloRes.status, text)
      return NextResponse.json(
        { error: `Apollo returned ${apolloRes.status} — check your API key or plan limits` },
        { status: 502 }
      )
    }

    const apolloData = (await apolloRes.json()) as ApolloPersonResponse
    const p = apolloData.person

    if (!p) {
      return NextResponse.json(
        { error: 'No person found for this LinkedIn URL. Try a different URL or add manually.' },
        { status: 404 }
      )
    }

    // Resolve best email — prefer personal, fall back to work email
    const email =
      (p.personal_emails && p.personal_emails.length > 0 ? p.personal_emails[0] : null) ??
      p.email ??
      null

    // Build location string
    const locationParts = [p.city, p.state, p.country].filter(Boolean)
    const location = locationParts.length > 0 ? locationParts.join(', ') : null

    // Normalise to Contact shape
    const contact = {
      name: p.name ?? [p.first_name, p.last_name].filter(Boolean).join(' ') ?? '',
      email,
      role: p.title ?? null,
      company: p.organization?.name ?? null,
      location,
      linkedin_url: p.linkedin_url ?? linkedin_url,
      raw_apollo_data: apolloData,
    }

    return NextResponse.json({ success: true, contact })
  } catch (error) {
    console.error('Enrich error:', error)
    return NextResponse.json(
      { err