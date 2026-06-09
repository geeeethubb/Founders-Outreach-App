import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { generateEmailVariants } from '@/lib/ai/personalize'
import { buildEmailFromTemplate } from '@/lib/ai/fill-template'
import { getProfile } from '@/lib/supabase/queries'
import type { GenerateRequest } from '@/types'

// Generating an email per contact is many sequential OpenAI calls; give the
// function room so large campaigns don't get killed mid-loop (which truncates
// the HTTP response and surfaces client-side as "Unexpected token" on res.json()).
export const maxDuration = 300

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
      template_id?: string
      contact_ids?: string[]
    }

    if (!body.outreach_goal) {
      return NextResponse.json({ error: 'outreach_goal is required' }, { status: 400 })
    }

    // Load campaign contacts with research. When contact_ids is provided, scope
    // this batch to just those members (the rest stay in the campaign untouched).
    let query = supabase
      .from('campaign_contacts')
      .select('contact_id, contact:contacts(*, research:contact_research(*))')
      .eq('campaign_id', campaignId)
    if (body.contact_ids && body.contact_ids.length > 0) {
      query = query.in('contact_id', body.contact_ids)
    }
    const { data: rows } = await query

    if (!rows || rows.length === 0) {
      return NextResponse.json({ error: 'No contacts to generate for' }, { status: 400 })
    }

    const profile = await getProfile(user.id)
    const senderName = profile?.name ?? user.email?.split('@')[0] ?? 'A UIUC Student'

    // Load template if provided
    let template: { id: string; name: string; type: 'initial' | 'followup'; subject_template: string | null; body_template: string } | null = null
    if (body.template_id) {
      const { data } = await supabase
        .from('templates')
        .select('*')
        .eq('id', body.template_id)
        .eq('user_id', user.id)
        .single()
      template = data
    }

    const generated: { contact_id: string; email_id: string }[] = []
    const skipped: { contact_id: string; name: string; reason: string }[] = []

    for (const row of rows) {
      const contact = row.contact as any
      if (!contact) { skipped.push({ contact_id: row.contact_id, name: '?', reason: 'Contact not found' }); continue }

      try {
        let subject: string
        let emailBody: string
        let templateId: string | null = null
        let replyToEmailId: string | null = null

        if (template) {
          // Template mode — fill placeholders per contact (handles follow-ups)
          const built = await buildEmailFromTemplate({
            template,
            contact,
            research: contact.research ?? null,
            senderName,
            senderProfile: profile,
          })
          if (!built.ok) {
            skipped.push({ contact_id: row.contact_id, name: contact.name, reason: built.reason })
            continue
          }
          subject = built.subject
          emailBody = built.body
          templateId = template.id
          replyToEmailId = built.replyToEmailId
        } else {
          // Fresh mode — require research
          if (!contact.research) {
            skipped.push({ contact_id: row.contact_id, name: contact.name, reason: 'No research yet' })
            continue
          }
          const variants = await generateEmailVariants(
            contact,
            contact.research,
            { contact_id: row.contact_id, outreach_goal: body.outreach_goal, styles: body.styles, custom_note: body.custom_note },
            senderName,
            profile
          )
          const best = variants.find((v) => v.hook_type === 'accomplishment') ?? variants[0]
          subject = best.subject
          emailBody = best.body
        }

        const { data: email } = await supabase
          .from('emails')
          .insert({
            user_id: user.id,
            contact_id: row.contact_id,
            campaign_id: campaignId,
            template_id: templateId,
            subject,
            body: emailBody,
            variant_label: 'A',
            status: 'draft',
            reply_to_email_id: replyToEmailId,
            scheduled_for: null,
            sent_at: null,
            resend_message_id: null,
            gmail_thread_id: null,
            generation_metadata: {
              model: 'gpt-5.4',
              prompt_version: template ? '2.0' : '1.0',
              hooks_used: [],
              hook_type: 'accomplishment',
              word_count: emailBody.split(/\s+/).length,
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
