// The send path.
//
// Reuses the existing Gmail layer wholesale — lib/email/resend.ts (which sends
// via the Gmail API despite its name), lib/email/accounts.ts, lib/google/oauth.ts.
// Nothing in there is rewritten or "improved"; this file only decides WHEN to
// call it and what to record afterwards.
//
// It also writes an `emails` row for every send. That is not bookkeeping: reply
// sync finds replies by re-listing the Gmail threads recorded on `emails`
// (lib/email/sync.ts), so an outreach with no `emails` row is an outreach whose
// replies are invisible.
//
// Five preconditions, all checked before anything leaves:
//   1. the draft is APPROVED and unsent  (compare-and-swap, so clicks race safely)
//   2. the recipient has an email address
//   3. the claim-safety gate passes on the FINAL text
//   4. Gmail is connected and the token still mints
//   5. the daily cap is not blown

import { createServiceClient } from '@/lib/supabase/server'
import { sendEmail } from '@/lib/email/resend'
import { getEmailAccount } from '@/lib/email/accounts'
import { getAccessToken } from '@/lib/google/oauth'
import { checkGrounding, summarizeGrounding, type GroundingResult } from './grounding'
import {
  CLAIMABLE_STATES,
  claimForSend,
  getOutreach,
  patchOutreach,
  recordSendFailure,
  recordSendSuccess,
  type OutreachRow,
} from './store'

/** Same cap the V1 send route uses. Sender-reputation protection, not policy. */
const MAX_EMAILS_PER_DAY = 500

export interface SendOutcome {
  ok: boolean
  outreach?: OutreachRow
  /** Set when the request was a no-op because the send already happened. */
  alreadySent?: boolean
  error?: string
  grounding?: GroundingResult
  status: number
}

export async function sendOutreach(userId: string, id: string): Promise<SendOutcome> {
  const supabase = createServiceClient()

  const before = await getOutreach(userId, id)
  if (!before) return { ok: false, error: 'Outreach not found', status: 404 }

  // Idempotency, part one: a completed send answers success rather than
  // erroring, so a double-click or a client retry is indistinguishable from a
  // single click — and neither produces a second email.
  if (before.sent_at || ['sent', 'replied', 'meeting', 'referred', 'closed'].includes(before.state)) {
    return { ok: true, outreach: before, alreadySent: true, status: 200 }
  }
  if (before.state === 'sending') {
    return { ok: false, error: 'This email is already being sent.', status: 409 }
  }
  if (!CLAIMABLE_STATES.includes(before.state)) {
    return {
      ok: false,
      error: `Only an approved draft can be sent — this one is ${before.state}.`,
      status: 409,
    }
  }

  // ─── recipient ───
  const { data: contact } = await supabase
    .from('contacts')
    .select('id, name, email')
    .eq('id', before.contact_id)
    .eq('user_id', userId)
    .maybeSingle()

  if (!contact?.email) {
    return {
      ok: false,
      error: `No email address on record for ${contact?.name ?? 'this contact'}.`,
      status: 422,
    }
  }

  // ─── gate, on the text that will actually go out ───
  const finalBody = before.body_edited ?? before.body ?? ''
  const grounding = checkGrounding({
    subject: before.subject ?? '',
    body: finalBody,
    evidence: before.allowed_claims ?? [],
    safeNames: [contact.name, ''].filter(Boolean),
  })
  if (!grounding.ok) {
    return {
      ok: false,
      error: `Blocked by the claim-safety gate. ${summarizeGrounding(grounding)}`,
      grounding,
      status: 422,
    }
  }

  // ─── Gmail ───
  const account = await getEmailAccount(userId)
  if (!account) {
    return { ok: false, error: 'Connect your Gmail in Settings to send.', status: 403 }
  }

  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const { count: sentToday } = await supabase
    .from('emails')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', 'sent')
    .gte('sent_at', todayStart.toISOString())
  if ((sentToday ?? 0) >= MAX_EMAILS_PER_DAY) {
    return {
      ok: false,
      error: `Daily send limit reached (${MAX_EMAILS_PER_DAY}/day). This protects your sender reputation.`,
      status: 429,
    }
  }

  let accessToken: string
  try {
    accessToken = await getAccessToken(account.refreshToken)
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'Gmail authorization failed — reconnect in Settings.',
      status: 401,
    }
  }

  // ─── Idempotency, part two: claim the row ───
  // Nothing above this line has side effects, so failing out of any of it is
  // free. From here on exactly one caller holds the row.
  const claimed = await claimForSend(userId, id)
  if (!claimed) {
    const now = await getOutreach(userId, id)
    if (now?.sent_at) return { ok: true, outreach: now, alreadySent: true, status: 200 }
    return { ok: false, error: 'Another send is already in flight for this prospect.', status: 409 }
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('name')
    .eq('id', userId)
    .maybeSingle()
  const senderName = profile?.name ?? account.email.split('@')[0]

  // The writer is told not to produce a signature so the same body can be
  // reused across channels; it gets added here, once, at the boundary.
  const body = `${finalBody.trim()}\n\n${senderName}`

  // Create (or reuse) the emails row BEFORE sending. A crash between the API
  // call and the write then leaves evidence instead of a silent gap, and a
  // retry reuses the same row rather than accumulating orphans.
  let existingEmailId: string | null = claimed.email_id
  if (!existingEmailId) {
    const { data: created, error: emailErr } = await supabase
      .from('emails')
      .insert({
        user_id: userId,
        contact_id: contact.id,
        subject: before.subject,
        body,
        status: 'draft',
        generation_metadata: {
          source: 'scout',
          outreach_id: id,
          positioning_version: before.positioning_version,
          draft_version: before.draft_version,
          proof_point_ids: before.proof_point_ids,
          angle: before.angle,
          edited: before.body_edited !== null,
        },
      })
      .select('id')
      .maybeSingle()
    if (emailErr || !created) {
      await recordSendFailure(userId, id, `Could not record the email: ${emailErr?.message ?? 'no row'}`)
      return { ok: false, error: `Could not record the email: ${emailErr?.message ?? 'unknown'}`, status: 500 }
    }
    existingEmailId = String(created.id)
    await patchOutreach(userId, id, { email_id: existingEmailId })
  }
  const emailId: string = existingEmailId

  const result = await sendEmail(
    {
      to: contact.email,
      toName: contact.name,
      subject: before.subject ?? '(no subject)',
      body,
    },
    { email: account.email, name: senderName, accessToken }
  )

  if (result.error) {
    await supabase.from('emails').update({ status: 'failed' }).eq('id', emailId)
    const failed = await recordSendFailure(userId, id, result.error)
    return { ok: false, outreach: failed, error: result.error, status: 502 }
  }

  await supabase
    .from('emails')
    .update({
      status: 'sent',
      sent_at: new Date().toISOString(),
      resend_message_id: result.messageId,
      gmail_thread_id: result.threadId ?? null,
    })
    .eq('id', emailId)

  await supabase.from('contacts').update({ status: 'sent' }).eq('id', contact.id)

  const sent = await recordSendSuccess(userId, id, {
    emailId,
    rfc822MessageId: result.messageId,
    gmailThreadId: result.threadId ?? null,
  })

  return { ok: true, outreach: sent, status: 200 }
}
