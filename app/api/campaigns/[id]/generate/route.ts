import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { generateEmailVariants } from '@/lib/ai/personalize'
import { getProfile } from '@/lib/supabase/queries'
import type { GenerateRequest } from '@/types'

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const campaignId = params.id
    const body = (await request.json()) as {
      outreach_goal: GenerateRequest['outreach_goal']
      styles?: GenerateRequest['styles']
      custom_note?: string
    }

    if (!body.outreach_goal) {
      return NextResponse.json({ error: 'outreach_goal is required' }, { status: 400 })
    }

    // Load all campaign contacts with research
    const { data: rows } = await supabase
      .from('campaign_contacts')
      .select('contact_id, contact:contacts(*, research:contact_research(*))')
      .eq('campaign_id', campaignId)

    if (!rows || rows.length === 0) {
      return NextResponse.json({ error: 'No contacts in this campaign' }, { status: 400 })
    }

    const profile = await getProfile(user.id)
    const senderName = profile?.name ?? user.email?.split('@')[0] ?? 'A UIUC Student'

    const generated: { contact_id: string; email_id: string }[] = []
    const skipped: { contact_id: string; name: string; reason: string }[] = []

    for (const row of rows) {
      const contact = row.contact as any
      if (!contact) { skipped.push({ contact_id: row.contact_id, name: '?', reason: 'Contact not found' }); continue }
      if (!contact.research) { skipped.push({ contact_id: row.contact_id, name: contact.name, reason: 'No research yet' }); continue }

      try {
        const variants = await generateEmailVariants(
          contact,
          contact.research,
          { contact_id: row.contact_id, outreach_goal: body.outreach_goal, styles: body.styles, custom_note: body.custom_note },
          senderName
        )

        // Pick accomplishment hook first, fall back to first variant
        const best = variants.find((v) => v.hook_type === 'accomplishment') ?? variants[0]

        const { data: email } = await supabase
          .from('emails')
          .insert({
            user_id: user.id,
            contact_id: row.contact_id,
            campaign_id: campaignId,
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

        if (email) generated.push({ contact_id: row.contact_id, email_id: email.id })
      } catch (e) {
        skipped.push({
          contact_id: row.contact_id,
          name: contact.name,
          reason: e instanceof Error ? e.message : 'Generation failed',
        })
      }
    }

    return NextResponse.json({ success: true, generated: generated.length, skipped })
  } catch (error) {
    console.error('Campaign generate error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed' },
      { status: 500 }
    )
  }
}
