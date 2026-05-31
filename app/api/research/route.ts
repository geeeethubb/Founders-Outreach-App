import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { researchContact } from '@/lib/ai/research'
import { upsertResearch, updateContactStatus } from '@/lib/supabase/queries'
import type { ResearchRequest } from '@/types'

export async function POST(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = (await request.json()) as Partial<ResearchRequest> & { contact_id: string }

    if (!body.contact_id) {
      return NextResponse.json({ error: 'contact_id is required' }, { status: 400 })
    }

    // If name wasn't passed, fetch the contact from DB
    let req: ResearchRequest
    if (!body.name) {
      const { data: contact } = await supabase
        .from('contacts')
        .select('name, company, role, linkedin_url')
        .eq('id', body.contact_id)
        .single()

      if (!contact?.name) {
        return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
      }

      req = {
        contact_id: body.contact_id,
        name: contact.name,
        company: contact.company ?? undefined,
        role: contact.role ?? undefined,
        linkedin_url: contact.linkedin_url ?? undefined,
        pasted_bio: body.pasted_bio,
      }
    } else {
      req = body as ResearchRequest
    }

    // Mark contact as researching
    await updateContactStatus(body.contact_id, 'researching')

    // Run the AI research agent
    const result = await researchContact(req)

    // Persist to DB
    const { error: dbError } = await upsertResearch({
      contact_id: 