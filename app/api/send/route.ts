import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { sendEmail } from '@/lib/email/resend'
import { updateEmailStatus, updateContactStatus } from '@/lib/supabase/queries'
import type { SendRequest } from '@/types'

// Rate limiting constants — adjust as you scale
const MAX_EMAILS_PER_DAY = 20

export async function POST(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
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
