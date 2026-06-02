import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { sendEmail } from '@/lib/email/resend'
import { updateEmailStatus, updateContactStatus } from '@/lib/supabase/queries'
import type { SendRequest } from '@/types'

// Rate limiting constants — adjust as you scale
const MAX_EMAILS_PER_DAY = 500

// Sender allowlist — locks down public sign-up so only approved accounts can
// actually send mail. Everything currently sends from one shared Gmail
// (GMAIL_USER), so without this any registered user would send as that account.
// Configure via ALLOWED_SENDERS (comma-separated emails); defaults to the owner.
const ALLOWED_SENDERS = (process.env.ALLOWED_SENDERS ?? 'zuyu.alex06@gmail.com')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean)

export async function POST(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Sending is restricted to allowlisted accounts. All mail goes out from a
    // single shared Gmail, so non-owner sends would impersonate the owner and
    // damage their sender reputation. Block them here.
    if (!user.email || !ALLOWED_SENDERS.includes(user.email.toLowerCase())) {
      return NextResponse.json(
        { error: 'Sending is restricted to the platform owner on this deployment.' },
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

    // Send via Resend
    const result = await sendEmail({
      to: body.to_email,
      toName: body.to_name,
      subject: body.subject,
      body: body.body,
      ...(body.schedule_at && { scheduledAt: body.schedule_at }),
    })

    if (result.error) {
      await updateEmailStatus(body.email_id, 'failed')
      return NextResponse.json({ error: result.error }, { status: 500 })
    }

    // Update email status in DB
    await updateEmailStatus(body.email_id, 'sent', result.messageId)

    // Update contact status
    const { data: emailRow } = await supabase
      .from('emails')
      .select('contact_id')
      .eq('id', body.email_id)
      .single()

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
