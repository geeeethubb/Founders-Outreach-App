import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { generateEmailVariants } from '@/lib/ai/personalize'
import { buildEmailFromTemplate } from '@/lib/ai/fill-template'
import { getContact, getProfile, createEmail } from '@/lib/supabase/queries'
import type { GenerateRequest } from '@/types'

export async function POST(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = (await request.json()) as GenerateRequest & { template_id?: string }

    if (!body.contact_id || !body.outreach_goal) {
      return NextResponse.json({ error: 'contact_id and outreach_goal are required' }, { status: 400 })
    }

    const contact = await getContact(body.contact_id)
    if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 })

    const profile = await getProfile(user.id)
    const senderName = profile?.name ?? user.email?.split('@')[0] ?? 'A UIUC Student'

    // ── Template mode ────────────────────────────────────────────────────────
    if (body.template_id) {
      const { data: template, error: tmplErr } = await supabase
        .from('templates')
        .select('*')
        .eq('id', body.template_id)
        .eq('user_id', user.id)
        .single()

      if (tmplErr || !template) {
        return NextResponse.json({ error: 'Template not found' }, { status: 404 })
      }

      const built = await buildEmailFromTemplate({
        template,
        contact,
        research: contact.research ?? null,
        senderName,
        senderProfile: profile,
      })

      if (!built.ok) {
        return NextResponse.json(
          { error: `${built.reason} — send an initial email to ${contact.name} first.` },
          { status: 400 }
        )
      }

      const savedEmail = await createEmail({
        user_id: user.id,
        contact_id: body.contact_id,
        campaign_id: null,
        template_id: body.template_id,
        subject: built.subject,
        body: built.body,
        variant_label: 'A',
        status: 'draft',
        reply_to_email_id: built.replyToEmailId,
        scheduled_for: null,
        sent_at: null,
        resend_message_id: null,
        generation_metadata: {
          model: 'gpt-5.4',
          prompt_version: '2.0',
          hooks_used: [],
          hook_type: 'accomplishment',
          word_count: built.body.split(/\s+/).length,
          outreach_goal: body.outreach_goal,
        },
      })

      return NextResponse.json({
        success: true,
        mode: 'template',
        variants: [{
          label: 'A',
          subject: built.subject,
          body: built.body,
          hook_type: 'accomplishment',
          hook_used: `Template: ${template.name}`,
          word_count: built.body.split(/\s+/).length,
          email_id: savedEmail.id,
        }],
      })
    }

    // ── Fresh generate mode (A/B/C variants) ─────────────────────────────────
    if (!contact.research) {
      return NextResponse.json(
        { error: 'Contact has not been researched yet. Run research first.' },
        { status: 400 }
      )
    }

    const variants = await generateEmailVariants(
      contact,
      contact.research,
      body,
      senderName,
      profile
    )

    const savedEmails = await Promise.all(
      variants.map((variant) =>
        createEmail({
          user_id: user.id,
          contact_id: body.contact_id,
          campaign_id: null,
          template_id: null,
          subject: variant.subject,
          body: variant.body,
          variant_label: variant.label,
          status: 'draft',
          reply_to_email_id: null,
          scheduled_for: null,
          sent_at: null,
          resend_message_id: null,
          generation_metadata: {
            model: 'gpt-5.4',
            prompt_version: '1.0',
            hooks_used: [variant.hook_used],
            hook_type: variant.hook_type,
            word_count: variant.word_count,
            outreach_goal: body.outreach_goal,
          },
        })
      )
    )

    return NextResponse.json({
      success: true,
      mode: 'fresh',
      variants: variants.map((v, i) => ({
        ...v,
        email_id: savedEmails[i].id,
      })),
    })
  } catch (error) {
    console.error('Generate error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Generation failed' },
      { status: 500 }
    )
  }
}
