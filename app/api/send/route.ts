import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { sendEmail } from '@/lib/email/resend'
import { getEmailAccount } from '@/lib/email/accounts'
import { getAccessToken } from '@/lib/google/oauth'
import { updateEmailStatus, updateContactStatus, getProfile } from '@/lib/supabase/queries'
import type { SendRequest } from '@/types'

// Rate limiting constants — adjust as you scale
const MAX_EMAILS_PER_DAY = 500

export async function POST(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Each user sends from their OWN connected Gmail. No connection → no sending.
    const account = await getEmailAccount(user.id)
    if (!account) {
      return NextResponse.json(
        { error: 'Connect your Gmail in Settings to send.' },
        { status: 403 }
      )
    }

    const body = (await request.json()) as SendRequest

    if (!body.email_id || !body.to_email || !body.subject || !body.body) {
      return NextResponse.json(
        { error: 'email_id, to_email, subject, and body are required' },
        { status: 400 }
      )
    }

    // Check daily send limit
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)

    const { count: sentToday } = await supabase
      .from('emails')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('status', 'sent')
      .gte('sent_at', todayStart.toISOString())

    if ((sentToday ?? 0) >= MAX_EMAILS_PER_DAY) {
      return NextResponse.json(
        { error: `Daily send limit reached (${MAX_EMAILS_PER_DAY} emails/day). This protects your sender reputation.` },
        { status: 429 }
      )
    }

    // Load this email's row up front — we need its contact_id, and whether it's
    // a follow-up that should thread onto an earlier message.
    const { data: emailRow } = await supabase
      .from('emails')
      .select('contact_id, reply_to_email_id')
      .eq('id', body.email_id)
      .single()

    // If this is a follow-up, look up the parent's Message-ID so Gmail threads
    // it into the original conversation (In-Reply-To / References headers).
    let threadHeaders: { inReplyTo?: string; references?: string } = {}
    if (emailRow?.reply_to_email_id) {
      const { data: parent } = await supabase
        .from('emails')
        .select('resend_message_id')
        .eq('id', emailRow.reply_to_email_id)
        .single()
      if (parent?.resend_message_id) {
        threadHeaders = {
          inReplyTo: parent.resend_message_id,
          references: parent.resend_message_id,
        }
      }
    }

    // Mint a fresh Google access token from the user's stored refresh token.
    let accessToken: string
    try {
      accessToken = await getAccessToken(account.refreshToken)
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'Gmail authorization failed — reconnect in Settings.' },
        { status: 401 }
      )
    }

    const profile = await getProfile(user.id)
    const senderName = profile?.name ?? account.email.split('@')[0]

    // Send from the user's own Gmail via OAuth2
    const result = await sendEmail(
      {
        to: body.to_email,
        toName: body.to_name,
        subject: body.subject,
        body: body.body,
        ...threadHeaders,
        ...(body.schedule_at && { scheduledAt: body.schedule_at }),
      },
      { email: account.email, name: senderName, accessToken }
    )

    if (result.error) {
      await updateEmailStatus(body.email_id, 'failed')
      return NextResponse.json({ error: result.error }, { status: 500 })
    }

    // Update email status in DB, recording the Gmail thread id so reply-sync can
    // later find replies the contact sends back into this same thread.
    await updateEmailStatus(body.email_id, 'sent', result.messageId, result.threadId)

    // Update contact status
    if (emailRow?.contact_id) {
      await updateContactStatus(emailRow.contact_id, 'sent')
    }

    return NextResponse.json({
      success: true,
      message_id: result.messageId,
    })
  } catch (error) {
    console.error('Send error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Send failed' },
      { status: 500 }
    )
  }
}
