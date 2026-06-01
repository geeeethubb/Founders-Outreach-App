import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { researchContact } from '@/lib/ai/research'
import { upsertResearch, updateContactStatus, getProfile } from '@/lib/supabase/queries'

export const maxDuration = 300

export async function POST() {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: contacts } = await supabase
      .from('contacts')
      .select('id, name, company, role, linkedin_url')
      .eq('user_id', user.id)
      .eq('status', 'new')

    if (!contacts || contacts.length === 0) {
      return NextResponse.json({ queued: 0, completed: 0 })
    }

    // Fetch sender profile once for all contacts
    const senderProfile = await getProfile(user.id)

    let completed = 0
    const errors: string[] = []

    for (const contact of contacts) {
      try {
        await updateContactStatus(contact.id, 'researching')

        const result = await researchContact({
          contact_id: contact.id,
          name: contact.name,
          company: contact.company ?? undefined,
          role: contact.role ?? undefined,
          linkedin_url: contact.linkedin_url ?? undefined,
          senderProfile,
        })

        await upsertResearch({
          contact_id: contact.id,
          summary: result.summary,
          hooks: result.hooks,
          shared_context: result.shared_context,
          relevance_score: result.relevance_score,
          fit_reason: result.fit_reason,
          category: result.category,
          suggested_ask: result.suggested_ask,
          model_used: 'gpt-5.4',
        })

        await updateContactStatus(contact.id, 'researched')
        completed++
      } catch (e) {
        await updateContactStatus(contact.id, 'new').catch(() => {})
        errors.push(`${contact.name}: ${e instanceof Error ? e.message : 'failed'}`)
        console.error('Batch research error for', contact.name, e)
      }
    }

    return NextResponse.json({ queued: contacts.length, completed, errors: errors.length > 0 ? errors : undefined })
  } catch (error) {
    console.error('Batch research error:', error)
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}
