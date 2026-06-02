import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { researchContact } from '@/lib/ai/research'
import { upsertResearch, updateContactStatus, getProfile } from '@/lib/supabase/queries'
import type { ResearchRequest } from '@/types'

export async function POST(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = (await request.json()) as Partial<ResearchRequest> & { contact_id: string }
    if (!body.contact_id) return NextResponse.json({ error: 'contact_id is required' }, { status: 400 })

    // Fetch sender profile for relevance calibration
    const senderProfile = await getProfile(user.id)

    let req: ResearchRequest
    if (!body.name) {
      const { data: contact } = await supabase
        .from('contacts')
        .select('name, company, role, linkedin_url')
        .eq('id', body.contact_id)
        .single()
      if (!contact?.name) return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
      req = {
        contact_id: body.contact_id,
        name: contact.name,
        company: contact.company ?? undefined,
        role: contact.role ?? undefined,
        linkedin_url: contact.linkedin_url ?? undefined,
        pasted_bio: body.pasted_bio,
        senderProfile,
      }
    } else {
      req = { ...body as ResearchRequest, senderProfile }
    }

    await updateContactStatus(body.contact_id, 'researching')
    const result = await researchContact(req)

    const { error: dbError } = await upsertResearch({
      contact_id: body.contact_id,
      summary: result.summary,
      hooks: result.hooks,
      shared_context: result.shared_context,
      relevance_score: result.relevance_score,
      category: result.category,
      suggested_ask: result.suggested_ask,
      model_used: 'gpt-5.4',
    })
    if (dbError) console.error('DB error saving research:', dbError)

    await updateContactStatus(body.contact_id, 'researched')
    return NextResponse.json({ success: true, research: result })
  } catch (error) {
    console.error('Research error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Research failed' },
      { status: 500 }
    )
  }
}