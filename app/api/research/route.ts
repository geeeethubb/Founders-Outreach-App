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

    const body = (await request.json()) as ResearchRequest

    if (!body.contact_id || !body.name) {
      return NextResponse.json({ error: 'contact_id and name are required' }, { status: 400 })
    }

    // Mark contact as researching
    await updateContactStatus(body.contact_id, 'researching')

    // Run the AI research agent
    const result = await researchContact(body)

    // Persist to DB
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

    if (dbError) {
      console.error('DB error saving research:', dbError)
    }

    // Update contact status to researched
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
