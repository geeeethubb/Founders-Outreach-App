import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { generateEmailVariants } from '@/lib/ai/personalize'
import { fillEmailTemplate } from '@/lib/ai/fill-template'
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
      template_id?: string
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

    // Load template if provided
    let template: { id: string; name: string; subject_template: string | null; body_template: string } | null = null
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

        if (template) {
          // Template mode — fill placeholders per contact
          const filled = await fillEmailTemplate(
            template,
            contact,
            contact.research ?? null,
            senderName,
            profile
          )
          subject = filled.subject
          emailBody = filled.body
          templateId = template.id
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