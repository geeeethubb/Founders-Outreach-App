import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { generateEmailVariants } from '@/lib/ai/personalize'
import { getContact, getProfile } from '@/lib/supabase/queries'
import type { GenerateRequest } from '@/types'

export async function POST(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = (await request.json()) as {
      contact_ids: string[]
      outreach_goal: GenerateRequest['outreach_goal']
      styles?: GenerateRequest['styles']
      custom_note?: string
    }

    if (!body.contact_ids?.length || !body.outreach_goal) {
      return NextResponse.json({ error: 'contact_ids and outreach_goal are required' }, { status: 400 })
    }

    const profile = await getProfile(user.id)
    const senderName = profile?.name ?? user.email?.split('@')[0] ?? 'A UIUC Student'

    const generated: string[] = []
    const skipped: { name: string; reason: string }[] = []

    for (const contactId of body.contact_ids) {
      const contact = await getContact(contactId)
      if (!contact) { skipped.push({ name: contactId, reason: 'Not found' }); continue }
      if (!contact.research) { skipped.push({ name: contact.name, reason: 'No research yet' }); continue }

      try {
        const variants = await generateEmailVariants(
          contact,
          contact.research,
          { contact_id: contactId, outreach_goal: body.outreach_goal, styles: body.styles, custom_note: body.custom_note },
          senderName
        )
        const best = variants.find((v) => v.hook_type === 'accomplishment') ?? variants[0]

        const { data: email } = await supabase
          .from('emails')
          .insert({
            user_id: user.id,
            contact_id: contactId,
            campaign_id: null,
            subject: best.subject,
            body: best.body,
            variant_label: best.label,
            status: 'draft',
            scheduled_for: null,
            sent_at: null,
            resend_message_id: null,
            generation_metadata: {
              model: 'gpt-5.4',
              prompt_version: '1.0',
              hooks_used: [best.hook_used],
              hook_type: best.hook_type,
              word_count: best.word_count,
              outreach_goal: body.outreach_goal,
            },
          })
          .select('id')
          .single()

        if (email) generated.push(email.id)
      } catch (e) {
        skipped.push({ name: contact.name, reason: e instanceof Error ? e.message : 'Failed' })
      }
    }

    return NextResponse.json({ success: true, generated: generated.length, skipped })
  } catch (error) {
    console.error('Generate multi error:', error)
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}
