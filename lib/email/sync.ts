import { createServiceClient } from '@/lib/supabase/server'
import { getEmailAccount, scopeCanReadReplies } from '@/lib/email/accounts'
import { getAccessToken } from '@/lib/google/oauth'
import { classifyReply } from '@/lib/ai/classify'
import type { ReplyClassification } from '@/types'

// Reply tracking for Gmail OAuth sending. We send via gmail.send and have no
// inbound webhook (Gmail isn't Resend), so we instead READ the user's Gmail
// (gmail.readonly) and fold replies into conversations. For every email we sent
// we stored its Gmail threadId; here we re-list those threads, pick out messages
// that aren't from the user (i.e. replies), and import the new ones. The Gmail
// message id is stored on each row so re-running is idempotent.

const threadUrl = (id: string) =>
  `https://gmail.googleapis.com/gmail/v1/users/me/threads/${id}?format=full`

const rfcLookupUrl = (rfcMessageId: string) =>
  `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1&q=${encodeURIComponent(
    `rfc822msgid:${rfcMessageId}`
  )}`

export interface SyncResult {
  newReplies: number
  threadsChecked: number
  error?: string
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
  await backfillThreadIds(supabase, userId, accessToken)

  // Map each Gmail thread we sent into -> the contact it belongs to. We know the
  // contact reliably because we initiated every thread ourselves.
  const { data: sentEmails } = await supabase
    .from('emails')
    .select('gmail_thread_id, contact_id')
    .eq('user_id', userId)
    .eq('status', 'sent')
    .not('gmail_thread_id', 'is', null)

  const threadToContact = new Map<string, string>()
  for (const row of sentEmails ?? []) {
    const threadId = row.gmail_thread_id as string | null
    const contactId = row.contact_id as string | null
    if (threadId && contactId && !threadToContact.has(threadId)) {
      threadToContact.set(threadId, contactId)
    }
  }

  // Provider message ids we've already imported, so we never duplicate a reply.
  const { data: existingMsgs } = await supabase
    .from('messages')
    .select('provider_message_id')
    .not('provider_message_id', 'is', null)
  const seen = new Set((existingMsgs ?? []).map((m) => m.provider_message_id as string))

  const ownEmail = account.email.toLowerCase()
  let newReplies = 0

  for (const [threadId, contactId] of threadToContact) {
    const res = await fetch(threadUrl(threadId), {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) continue
    const thread = (await res.json()) as GmailThread

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
      // A unique-violation means a concurrent sync already grabbed it — skip.
      if (error) continue

      seen.add(m.id)
      newReplies++
      await applyOutcome(supabase, conversationId, contactId, classification, intent, sentAt)
    }
  }

  return { newReplies, threadsChecked: threadToContact.size }
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
): Promise<void> {
  const { data: pending } = await supabase
    .from('emails')
    .select('id, resend_message_id')
    .eq('user_id', userId)
    .eq('status', 'sent')
    .is('gmail_thread_id', null)
    .not('resend_message_id', 'is', null)

  for (const row of pending ?? []) {
    // Stored as an RFC822 Message-ID with angle brackets; the search wants it bare.
    const rfcId = (row.resend_message_id as string).replace(/^<|>$/g, '')
    if (!rfcId) continue

    const res = await fetch(rfcLookupUrl(rfcId), {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) continue
    const found = (await res.json()) as { messages?: Array<{ threadId?: string }> }
    const threadId = found.messages?.[0]?.threadId
    if (!threadId) continue

    await supabase.from('emails').update({ gmail_thread_id: threadId }).eq('id', row.id)
  }
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

// ─── Gmail payload parsing ───────────────────────────────────────────────────

interface GmailHeader { name: string; value: string }
interface GmailPart {
  mimeType?: string
  body?: { data?: string }
  parts?: GmailPart[]
  headers?: GmailHeader[]
}
interface GmailMessage {
  id: string
  internalDate?: string
  snippet?: string
  payload?: GmailPart
}
interface GmailThread {
  id: string
  messages?: GmailMessage[]
}

function headerValue(m: GmailMessage, name: string): string {
  const headers = m.payload?.headers ?? []
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

function decodeB64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
}

/** Best plain-text rendering of a Gmail message, with the quoted reply trimmed. */
function extractPlainText(m: GmailMessage): string {
  const payload = m.payload
  if (!payload) return m.snippet ?? ''

  const plain = findPart(payload, 'text/plain')
  if (plain?.body?.data) return stripQuoted(decodeB64Url(plain.body.data))

  const html = findPart(payload, 'text/html')
  if (html?.body?.data) return stripQuoted(htmlToText(decodeB64Url(html.body.data)))

  if (payload.body?.data) return stripQuoted(decodeB64Url(payload.body.data))
  return m.snippet ?? ''
}

function findPart(part: GmailPart, mime: string): GmailPart | null {
  if (part.mimeType === mime && part.body?.data) return part
  for (const p of part.parts ?? []) {
    const found = findPart(p, mime)
    if (found) return found
  }
  return null
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/(p|div|br|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Drop the quoted "On … wrote:" history so we keep just the new reply text. */
function stripQuoted(text: string): string {
  const lines = text.split('\n')
  const kept: string[] = []
  for (const line of lines) {
    const t = line.trim()
    if (/^On .+wrote:$/.test(t)) break
    if (/^-{3,}\s*Original Message\s*-{3,}/i.test(t)) break
    if (/^From:\s.+/.test(t) && kept.some((l) => l.trim() !== '')) break
    kept.push(line)
  }
  const result = kept.join('\n').trim()
  return result || text.trim()
}
