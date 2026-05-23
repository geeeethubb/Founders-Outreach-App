import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { generateEmailVariants } from '@/lib/ai/personalize'
import { getContact, getProfile, createEmail } from '@/lib/supabase/queries'
import type { GenerateRequest } from '@/types'

export async function POST(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = (await request.json()) as GenerateRequest

    if (!body.contact_id || !body.outreach_goal) {
      return NextResponse.json(
        { error: 'contact_id and outreach_goal are required' },
        { status: 400 }
      )
    }

    // Load contact + research
    const contact = await getContact(body.contact_id)
    if (!contact) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    }

    if (!contact.research) {
      return NextResponse.json(
        { error: 'Contact has not been researched yet. Run research first.' },
        { status: 400 }
      )
    }

    // Load sender profile
    const profile = await getProfile(user.id)
    const senderName = profile?.name ?? user.email?.split('@')[0] ?? 'A UIUC Student'

    // Generate 3 email variants
    const variants = await generateEmailVariants(
      contact,
      contact.research,
      body,
      senderName
    )

    // Persist all variants as draft emails
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
          scheduled_for: null,
          sent_at: null,
          resend_message_id: null,
          generation_metadata: {
            model: 'gpt-4.1',
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
