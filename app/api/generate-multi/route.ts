import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { generateEmailVariants } from '@/lib/ai/personalize'
import { fillEmailTemplate } from '@/lib/ai/fill-template'
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
      template_id?: string
    }

    if (!body.contact_ids?.length || !body.outreach_goal) {
      return NextResponse.json({ error: 'contact_ids and outreach_goal are required' }, { status: 400 })
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

    const generated: string[] = []
    const skipped: { name: string; reason: string }[] = []

    for (const contactId of body.contact_ids) {
      const contact = await getContact(contactId)
      if (!contact) { skipped.push({ name: contactId, reason: 'Not found' }); continue }

      try {
        let subject: string
        let emailBody: string

        if (template) {
          // Template mode — fill placeholders for each contact
          const filled = await fillEmailTemplate(
            template,
            contact,
            contact.research ?? null,
            senderName,
            profile
          )
          subject = filled.subject
          emailBody = filled.body
        } else {
          // Fresh mode — require research, use best variant
          if (!contact.research) { skipped.push({ name: contact.name, reason: 'No research yet' }); continue }
          const variants = await generateEmailVariants(
            contact,
            contact.research,
            { contact_id: contactId, outreach_goal: body.outreach_goal, styles: body.styles, custom_note: body.custom_note },
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
            contact_id: contac