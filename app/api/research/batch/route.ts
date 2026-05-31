import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// Kicks off research for all contacts with status 'new' (not yet researched)
export async function POST() {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: contacts } = await supabase
      .from('contacts')
      .select('id')
      .eq('user_id', user.id)
      .eq('status', 'new')

    if (!contacts || contacts.length === 0) {
      return NextResponse.json({ queued: 0 })
    }

    // Stagger by 1.5s per contact to avoid rate limits
    contacts.forEach((c, i) => {
      setTimeout(() => {
        fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/research`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contact_id: c.id }),
        }).catch(() => {})
      }, i * 1500)
    })

    return NextResponse.json({ queued: contacts.length })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed' },
      { status: 500 }
    )
  }
}
