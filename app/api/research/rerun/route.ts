import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// Resets all contacts to 'new' and clears old research so batch can re-run
export async function POST() {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Get all contact IDs for this user
    const { data: contacts } = await supabase
      .from('contacts')
      .select('id')
      .eq('user_id', user.id)

    if (!contacts || contacts.length === 0) {
      return NextResponse.json({ reset: 0 })
    }

    const ids = contacts.map((c) => c.id)

    // Delete all existing research
    await supabase.from('contact_research').delete().in('contact_id', ids)

    // Reset all statuses to 'new' so batch picks them up
    await supabase
      .from('contacts')
      .update({ status: 'new' })
      .eq('user_id', user.id)

    return NextResponse.json({ reset: ids.length })
  } catch (error) {
    console.error('Rerun reset error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed' },
      { status: 500 }
    )
  }
}
