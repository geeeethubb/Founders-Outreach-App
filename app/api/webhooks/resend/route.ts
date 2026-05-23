import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { classifyReply } from '@/lib/ai/classify'

export async function POST(request: NextRequest) {
  try {
    const payload = await request.text()
    const signature = request.headers.get('svix-signature') ?? ''
    const secret = process.env.RESEND_WEBHOOK_SECRET ?? ''

    // Skip signature verification in dev if no secret is set
    if (secret && signature) {
      const { verifyWebhookSignature } = await import('@/lib/email/resend')
      const isValid = verifyWebhookSignature(payload, signature, secret)
      if (!isValid) {
        return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
      }
    }

    const event = JSON.parse(payload) as {
      type: string
      data: {
        email_id?: string
        object?: string
        from?: string
        to?: string[]
        subject?: string
        text?: string
        html?: string
        created_at?: string
      }
    }

    const supabase = createServiceClient()

    // Map Resend event type to our event type
    const eventTypeMap: Record<string, string> = {
      'email.delivered':    'delivered',
      'email.opened':       'opened',
      'email.clicked':      'clicked',
      'email.bounced':      'bounced',
      'email.complained':   'complained',
    }

    const ourEventType = eventTypeMap[event.type]

    if (ourEventType && event.data.email_id) {
      // Find our email record by Resend message ID
      const { data: emailRow } = await supabase
        .from('emails')
        .select('id, contact_id, user_id')
        .eq('resend_message_id', event.data.email_id)
        .single()

      if (emailRow) {
        // Insert the event
        await supabase.from('email_events').insert({
          email_id: emailRow.id,
          event_type: ourEventType,
          occurred_at: event.data.created_at ?? new Date().toISOString(),
          metadata: event.data,
        })

        // If it was a reply, classify it and update conversation
        if (ourEventType === 'opened') {
          // Just track it — no further action needed
        }
      }
    }

    // Handle inbound email (reply) — Resend sends these as email.inbound_reply
    if (event.type === 'email.inbound_reply' || event.type === 'inbound.email') {
      const replyText = event.data.text ?? ''
      if (replyText) {
        const classification = await classifyReply(replyText)

        // Try to find the conversation from thread
        const fromEmail = event.data.from ?? ''
        const { data: contact } = await supabase
          .from('contacts')
          .select('id, user_id')
          .eq('email', fromEmail)
          .single()

        if (contact) {
          // Find or create conversation
          let { data: conversation } = await supabase
            .from('conversations')
            .select('id')
            .eq('contact_id', contact.id)
            .eq('status', 'open')
            .single()

          if (!conversation) {
            const { data: newConv } = await supabase
              .from('conversations')
              .insert({
                user_id: contact.user_id,
                contact_id: contact.id,
                status: 'open',
                last_message_at: new Date().toISOString(),
              })
              .select('id')
              .single()
            conversation = newConv
          }

          if (conversation) {
            await supabase.from('messages').insert({
              conversation_id: conversation.id,
              direction: 'inbound',
              subject: event.data.subject,
              body: replyText,
              classification: classification.classification,
              sent_at: new Date().toISOString(),
            })

            // Update contact status based on classification
            if (classification.classification === 'positive') {
              await supabase
                .from('contacts')
                .update({ status: 'replied' })
                .eq('id', contact.id)
            }
          }
        }
      }
    }

    return NextResponse.json({ received: true })
  } catch (error) {
    console.error('Webhook error:', error)
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 })
  }
}
