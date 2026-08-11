// Attaching synced replies to the outreach they answer.
//
// lib/email/sync.ts already does the hard part — Gmail polling, thread
// resolution, backfill, idempotent import — and it is explicitly not to be
// rewritten. So this does not touch it. It runs AFTER it and reads what it
// wrote, joining on the Gmail thread id that both sides already record.
//
// The join key exists because the send path writes an `emails` row carrying
// `gmail_thread_id`, and syncReplies keys conversations on that same id.

import { createServiceClient } from '@/lib/supabase/server'
import { hasBeenSent, type OutreachState } from './states'
import { recordEvent } from './store'

export interface InboundMessage {
  id: string
  conversationId: string
  subject: string | null
  body: string
  classification: string | null
  sentAt: string
}

export interface LinkResult {
  outreachChecked: number
  conversationsLinked: number
  newReplies: number
  /** Surfaced, never swallowed — "0 replies" has to be explainable. */
  errors: string[]
}

/**
 * Fold inbound Gmail messages into outreach state.
 *
 * Sets `conversation_id` on first contact and moves `sent` -> `replied` when an
 * inbound message arrives that is newer than anything already recorded. It never
 * moves further than `replied`: deciding that a reply is a meeting or a referral
 * is judgement, and that belongs to the Conversation Agent.
 */
export async function linkReplies(userId: string): Promise<LinkResult> {
  const supabase = createServiceClient()
  const errors: string[] = []

  const { data: rows, error } = await supabase
    .from('outreach')
    .select('id, state, gmail_thread_id, conversation_id, replied_at, sent_at, contact_id')
    .eq('user_id', userId)
    .not('gmail_thread_id', 'is', null)

  if (error) {
    return { outreachChecked: 0, conversationsLinked: 0, newReplies: 0, errors: [error.message] }
  }

  const candidates = (rows ?? []).filter((r) => hasBeenSent(r.state as OutreachState))
  let conversationsLinked = 0
  let newReplies = 0

  for (const row of candidates) {
    let conversationId = row.conversation_id as string | null

    if (!conversationId) {
      const { data: conv, error: convErr } = await supabase
        .from('conversations')
        .select('id')
        .eq('user_id', userId)
        .eq('email_thread_id', row.gmail_thread_id)
        .maybeSingle()
      if (convErr) {
        errors.push(`conversation lookup for ${row.id}: ${convErr.message}`)
        continue
      }
      // No conversation yet simply means nobody has replied in that thread.
      if (!conv) continue
      conversationId = conv.id
      await supabase.from('outreach').update({ conversation_id: conversationId }).eq('id', row.id)
      conversationsLinked++
    }

    if (!conversationId) continue
    const latest = await latestInbound(conversationId)
    if (!latest) continue

    const known = row.replied_at as string | null
    if (known && new Date(latest.sentAt) <= new Date(known)) continue

    const patch: Record<string, unknown> = { replied_at: latest.sentAt }
    const from = row.state as OutreachState
    // Only the first transition is a state move; later replies just update the
    // timestamp, so a long thread does not re-fire the same event repeatedly.
    if (from === 'sent') patch.state = 'replied'

    const { error: upErr } = await supabase.from('outreach').update(patch).eq('id', row.id)
    if (upErr) {
      errors.push(`update ${row.id}: ${upErr.message}`)
      continue
    }
    if (from === 'sent') {
      await recordEvent(row.id, 'sent', 'replied', 'system', { messageId: latest.id })
    }
    if (row.contact_id) {
      await supabase.from('contacts').update({ status: 'replied' }).eq('id', row.contact_id)
    }
    newReplies++
  }

  return { outreachChecked: candidates.length, conversationsLinked, newReplies, errors }
}

/** The most recent message the other side sent in this conversation. */
export async function latestInbound(conversationId: string): Promise<InboundMessage | null> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from('messages')
    .select('id, subject, body, classification, sent_at')
    .eq('conversation_id', conversationId)
    .eq('direction', 'inbound')
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!data) return null
  return {
    id: data.id,
    conversationId,
    subject: data.subject,
    body: data.body ?? '',
    classification: data.classification,
    sentAt: data.sent_at ?? new Date().toISOString(),
  }
}

/** Whole thread, oldest first — the Conversation Agent's context. */
export async function threadMessages(
  conversationId: string
): Promise<{ direction: string; body: string; sentAt: string }[]> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from('messages')
    .select('direction, body, sent_at')
    .eq('conversation_id', conversationId)
    .order('sent_at', { ascending: true })
    .limit(20)
  return (data ?? []).map((m) => ({
    direction: m.direction ?? 'inbound',
    body: m.body ?? '',
    sentAt: m.sent_at ?? '',
  }))
}
