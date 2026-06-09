import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { loadConversationContext } from '@/lib/email/conversation'
import { getProfile } from '@/lib/supabase/queries'
import { sendEmail } from '@/lib/email/resend'

// Send a reply into the conversation's Gmail thread and log it.
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { body, subject: subjectOverride } = (await request.json().catch(() => ({}))) as {
    body?: string
    subject?: string
  }
  if (!body || !body.trim()) {
    return NextResponse.json({ error: 'Reply body is required.' }, { status: 400 })
  }

  const ctx = await loadConversationContext(user.id, params.id)
  if (!ctx.conversation) return NextResponse.json({ error: ctx.error }, { status: ctx.status ?? 404 })
  if (!ctx.accessToken) {
    return NextResponse.json({ error: ctx.error ?? 'Gmail not connected.' }, { status: ctx.status ?? 403 })
  }

  const contact = ctx.conversation.contact
  if (!contact.email) {
    return NextResponse.json({ error: 'This contact has no email address on file.' }, { status: 400 })
  }

  const profile = await getProfile(user.id)
  const senderName = profile?.name ?? ctx.accountEmail!.split('@')[0]

  // Re: the thread's subject, avoiding "Re: Re:".
  const baseSubject = (subjectOverride || ctx.thread?.lastSubject || '').replace(/^\s*(re:\s*)+/i, '').trim()
  const subject = baseSubject ? `Re: ${baseSubject}` : 'Re:'

  const inReplyTo = ctx.thread?.lastMessageId ?? undefined

  const result = await sendEmail(
    {
      to: contact.email,
      toName: contact.name,
      subject,
      body: body.trim(),
      ...(inReplyTo && { inReplyTo, references: inReplyTo }),
      ...(ctx.conversation.email_thread_id && { threadId: ctx.conversation.email_thread_id }),
    },
    { email: ctx.accountEmail!, name: senderName, accessToken: ctx.accessToken }
  )

  if (result.error) {
    return NextResponse.json({ error: result.error }, { status: 500 })
  }

  // Log the outbound message + bump the conversation. Use the service client so
  // this isn't blocked by RLS write nuances, scoped to the verified conversation.
  const service = createServiceClient()
  const now = new Date().toISOString()
  await service.from('messages').insert({
    conversation_id: params.id,
    direction: 'outbound',
    subject,
    body: body.trim(),
    sent_at: now,
  })
  await service
    .from('conversations')
    .update({
      last_message_at: now,
      // Re-engaging a ghosted thread reopens it; otherwise keep the current state.
      ...(ctx.conversation.status === 'ghosted' && { status: 'open' }),
    })
    .eq('id', params.id)

  return NextResponse.json({ ok: true })
}
