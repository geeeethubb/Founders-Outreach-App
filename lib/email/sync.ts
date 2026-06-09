import { createServiceClient } from '@/lib/supabase/server'
import { getEmailAccount, scopeCanReadReplies } from '@/lib/email/accounts'
import { getAccessToken } from '@/lib/google/oauth'
import { classifyReply } from '@/lib/ai/classify'
import { fetchThread, headerValue, extractPlainText, type GmailThread } from '@/lib/email/gmail'
import type { ReplyClassification } from '@/types'

// Reply tracking for Gmail OAuth sending. We send via gmail.send and have no
// inbound webhook (Gmail isn't Resend), so we instead READ the user's Gmail
// (gmail.readonly) and fold replies into conversations. For every email we sent
// we stored its Gmail threadId; here we re-list those threads, pick out messages
// that aren't from the user (i.e. replies), and import the new ones. The Gmail
// message id is stored on each row so re-running is idempotent.

/** Run a Gmail search and return the threadId of the first matching message. */
async function lookupThread(accessToken: string, query: string): Promise<string | undefined> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1&q=${encodeURIComponent(query)}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) {
    console.error(`[syncReplies] gmail search failed (${query}): ${res.status} ${await res.text().catch(() => '')}`.slice(0, 200))
    return undefined
  }
  const found = (await res.json()) as { messages?: Array<{ threadId?: string }> }
  return found.messages?.[0]?.threadId
}

export interface SyncResult {
  newReplies: number
  threadsChecked: number
  // Diagnostics surfaced in the UI so a "0 replies" result is explainable.
  sentEmails?: number
  threadsResolved?: number
  backfilled?: number
  error?: string
}

// Missing-column / un-migrated DB shows up as a Postgres "column does not exist"
// or PostgREST schema-cache error — turn that into an actionable message.
function schemaHint(message: string): string | null {
  if (/gmail_thread_id|provider_message_id|does not exist|schema cache|column/i.test(message)) {
    return 'Reply-sync columns are missing — run migration 007_reply_sync.sql in Supabase, then sync again.'
  }
  return null
}

export async function syncReplies(userId: string): Promise<SyncResult> {
  const account = await getEmailAccount(userId)
  if (!account) {
    return { newReplies: 0, threadsChecked: 0, error: 'Connect your Gmail in Settings to track replies.' }
  }
  if (!scopeCanReadReplies(account.scope)) {
    return {
      newReplies: 0,
      threadsChecked: 0,
      error: 'Reconnect Gmail in Settings to grant read access — reply tracking needs it.',
    }
  }

  let accessToken: string
  try {
    accessToken = await getAccessToken(account.refreshToken)
  } catch {
    return { newReplies: 0, threadsChecked: 0, error: 'Gmail authorization failed — reconnect in Settings.' }
  }

  const supabase = createServiceClient()

  // Backfill: emails sent before we tracked thread ids (or via an older path)
  // have no gmail_thread_id. Resolve it from the RFC822 Message-ID we stored so
  // replies the contact already sent get picked up too.
  const backfill = await backfillThreadIds(supabase, userId, accessToken)
  if (backfill.error) {
    console.error('[syncReplies] backfill failed:', backfill.error)
    return { newReplies: 0, threadsChecked: 0, error: schemaHint(backfill.error) ?? backfill.error }
  }

  // Map each Gmail thread we sent into -> the contact it belongs to. We know the
  // contact reliably because we initiated every thread ourselves.
  const { data: sentEmails, error: sentErr } = await supabase
    .from('emails')
    .select('gmail_thread_id, contact_id')
    .eq('user_id', userId)
    .eq('status', 'sent')

  if (sentErr) {
    console.error('[syncReplies] read sent emails failed:', sentErr)
    return { newReplies: 0, threadsChecked: 0, error: schemaHint(sentErr.message) ?? `Could not read sent emails: ${sentErr.message}` }
  }

  const sentRows = sentEmails ?? []
  const threadToContact = new Map<string, string>()
  for (const row of sentRows) {
    const threadId = row.gmail_thread_id as string | null
    const contactId = row.contact_id as string | null
    if (threadId && contactId && !threadToContact.has(threadId)) {
      threadToContact.set(threadId, contactId)
    }
  }

  const diag = {
    sentEmails: sentRows.length,
    threadsResolved: threadToContact.size,
    backfilled: backfill.backfilled,
  }

  // Provider message ids we've already imported, so we never duplicate a reply.
  const { data: existingMsgs, error: msgErr } = await supabase
    .from('messages')
    .select('provider_message_id')
    .not('provider_message_id', 'is', null)
  if (msgErr) {
    console.error('[syncReplies] read messages failed:', msgErr)
    return { newReplies: 0, threadsChecked: 0, ...diag, error: schemaHint(msgErr.message) ?? `Could not read messages: ${msgErr.message}` }
  }
  const seen = new Set((existingMsgs ?? []).map((m) => m.provider_message_id as string))

  const ownEmail = account.email.toLowerCase()
  let newReplies = 0

  for (const [threadId, contactId] of threadToContact) {
    const thread = await fetchThread(accessToken, threadId)
    if (!thread) continue

    // Replies = thread messages not sent by the user, that we haven't imported.
    const newInbound = (thread.messages ?? []).filter((m) => {
      if (seen.has(m.id)) return false
      const from = headerValue(m, 'From').toLowerCase()
      return from !== '' && !from.includes(ownEmail)
    })
    if (newInbound.length === 0) continue

    const conversationId = await ensureConversation(supabase, userId, contactId, threadId)
    if (!conversationId) continue

    // Import oldest-first so conversation state reflects the latest reply.
    newInbound.sort((a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0))

    for (const m of newInbound) {
      const body = extractPlainText(m)
      const subject = headerValue(m, 'Subject') || null
      const sentAt = m.internalDate
        ? new Date(Number(m.internalDate)).toISOString()
        : new Date().toISOString()

      let classification: ReplyClassification = 'neutral'
      let intent = 'other'
      try {
        const c = await classifyReply(body)
        classification = c.classification
        intent = c.intent
      } catch {
        // Keep the reply even if classification fails.
      }

      const { error } = await supabase.from('messages').insert({
        conversation_id: conversationId,
        direction: 'inbound',
        subject,
        body: body.slice(0, 5000),
        classification,
        provider_message_id: m.id,
        sent_at: sentAt,
      })
      if (error) {
        // 23505 = unique violation: a concurrent/prior sync already imported it.
        if (error.code === '23505') {
          seen.add(m.id)
          continue
        }
        const hint = schemaHint(error.message)
        if (hint) return { newReplies, threadsChecked: threadToContact.size, ...diag, error: hint }
        console.error('[syncReplies] message insert failed:', error)
        continue
      }

      seen.add(m.id)
      newReplies++
      await applyOutcome(supabase, conversationId, contactId, classification, intent, sentAt)
    }
  }

  return { newReplies, threadsChecked: threadToContact.size, ...diag }
}

/**
 * Resolve and persist gmail_thread_id for sent emails that don't have one yet,
 * using the RFC822 Message-ID we recorded at send time. Lets reply-sync cover
 * emails sent before thread-id tracking existed.
 */
async function backfillThreadIds(
  supabase: ReturnType<typeof createServiceClient>,
  userId: string,
  accessToken: string
): Promise<{ backfilled: number; error?: string }> {
  const { data: pending, error } = await supabase
    .from('emails')
    .select('id, resend_message_id, contact:contacts(email)')
    .eq('user_id', userId)
    .eq('status', 'sent')
    .is('gmail_thread_id', null)

  if (error) return { backfilled: 0, error: error.message }

  let backfilled = 0
  for (const row of pending ?? []) {
    let threadId: string | undefined

    // 1) Exact match via the RFC822 Message-ID we recorded — works when Gmail
    //    preserved the header we set at send time.
    const rfcId = (row.resend_message_id as string | null)?.replace(/^<|>$/g, '')
    if (rfcId) threadId = await lookupThread(accessToken, `rfc822msgid:${rfcId}`)

    // 2) Fallback: find the thread by mail we sent TO this contact. Stable even
    //    if Gmail rewrote our Message-ID on send (which breaks step 1).
    const contactEmail = (row.contact as { email?: string } | null)?.email
    if (!threadId && contactEmail) threadId = await lookupThread(accessToken, `to:${contactEmail}`)

    if (!threadId) continue

    await supabase.from('emails').update({ gmail_thread_id: threadId }).eq('id', row.id)
    backfilled++
  }
  return { backfilled }
}

/** Find the conversation for this Gmail thread, creating it on first reply. */
async function ensureConversation(
  supabase: ReturnType<typeof createServiceClient>,
  userId: string,
  contactId: string,
  threadId: string
): Promise<string | null> {
  const { data: existing } = await supabase
    .from('conversations')
    .select('id')
    .eq('user_id', userId)
    .eq('email_thread_id', threadId)
    .maybeSingle()
  if (existing) return existing.id

  const { data: created } = await supabase
    .from('conversations')
    .insert({
      user_id: userId,
      contact_id: contactId,
      email_thread_id: threadId,
      status: 'open',
      last_message_at: new Date().toISOString(),
    })
    .select('id')
    .maybeSingle()
  return created?.id ?? null
}

/** Roll an imported reply up into conversation + contact status. */
async function applyOutcome(
  supabase: ReturnType<typeof createServiceClient>,
  conversationId: string,
  contactId: string,
  classification: ReplyClassification,
  intent: string,
  sentAt: string
) {
  const convUpdate: Record<string, unknown> = { last_message_at: sentAt }

  // Automated noise (OOO, bounces) is logged but doesn't change anyone's status.
  if (classification === 'auto_reply' || classification === 'bounce') {
    await supabase.from('conversations').update(convUpdate).eq('id', conversationId)
    return
  }

  let contactStatus = 'replied'
  if (intent === 'meeting_request') {
    convUpdate.status = 'meeting_booked'
    contactStatus = 'meeting'
  } else if (classification === 'negative') {
    convUpdate.status = 'closed_negative'
  }

  await supabase.from('conversations').update(convUpdate).eq('id', conversationId)
  await supabase.from('contacts').update({ status: contactStatus }).eq('id', contactId)
}
