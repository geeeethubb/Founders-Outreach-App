// Relationship history, computed deterministically from what already happened.
//
// This is the single most valuable signal the existing database holds and the
// one nothing currently reads. 250 of the 897 stored contacts have been emailed,
// 11 replied, 3 reached a meeting — and today a new mission would treat all 897
// identically and happily draft a first cold email to someone who already met
// the user.
//
// No model is involved. Who was emailed, who answered, and what the answer was
// classified as are all facts in the database; interpreting them is arithmetic.

import { createServiceClient } from '@/lib/supabase/server'

export type RelationshipStatus =
  | 'never_contacted'
  | 'contacted_no_reply'
  | 'in_conversation'
  | 'replied_positive'
  | 'replied_negative'
  | 'referred'
  | 'met'

export interface RelationshipHistory {
  status: RelationshipStatus
  touches: number
  replies: number
  lastContactedAt: string | null
  lastReplyAt: string | null
  /** One line the retrieval agent and the writer both read. */
  note: string
  /**
   * Ranking modifier, applied in code. A warm contact is worth surfacing above
   * a marginally better stranger; a contact who has already ignored two emails
   * is worth surfacing below one.
   */
  scoreModifier: number
}

export function emptyHistory(): RelationshipHistory {
  return {
    status: 'never_contacted',
    touches: 0,
    replies: 0,
    lastContactedAt: null,
    lastReplyAt: null,
    note: 'No prior contact.',
    scoreModifier: 0,
  }
}

const POSITIVE = new Set(['positive', 'POSITIVE', 'MEETING_REQUEST', 'REFERRAL'])
const NEGATIVE = new Set(['negative', 'NEGATIVE', 'NO_FIT'])

/**
 * Precedence, strongest outcome first. A thread that produced a meeting and
 * later a polite decline is still a relationship where you have met.
 */
function statusFrom(signals: {
  met: boolean
  referred: boolean
  positive: boolean
  negative: boolean
  anyReply: boolean
  touches: number
}): RelationshipStatus {
  if (signals.met) return 'met'
  if (signals.referred) return 'referred'
  if (signals.positive) return 'replied_positive'
  if (signals.negative) return 'replied_negative'
  if (signals.anyReply) return 'in_conversation'
  if (signals.touches > 0) return 'contacted_no_reply'
  return 'never_contacted'
}

function describe(status: RelationshipStatus, touches: number, lastContactedAt: string | null): string {
  const when = lastContactedAt ? ` (last touch ${lastContactedAt.slice(0, 10)})` : ''
  switch (status) {
    case 'met':
      return `You have already met or booked time with this person${when}. Reconnect — do not cold-open.`
    case 'referred':
      return `This person referred you onward${when}. Warm relationship; acknowledge the referral.`
    case 'replied_positive':
      return `Replied positively before${when}. Reference the earlier exchange rather than introducing yourself.`
    case 'replied_negative':
      return `Replied but declined${when}. Only re-approach with a materially different ask.`
    case 'in_conversation':
      return `An open thread exists${when}. Continue it instead of starting a new one.`
    case 'contacted_no_reply':
      return `Emailed ${touches} time${touches === 1 ? '' : 's'} with no reply${when}. Do not resend the same approach.`
    default:
      return 'No prior contact.'
  }
}

/**
 * Ranking modifiers. Small on purpose: relationship is a tiebreaker on top of
 * mission fit, never a substitute for it. A warm contact in the wrong industry
 * is still the wrong person.
 */
const MODIFIER: Record<RelationshipStatus, number> = {
  met: 0.12,
  referred: 0.12,
  replied_positive: 0.1,
  in_conversation: 0.06,
  never_contacted: 0,
  contacted_no_reply: -0.08,
  replied_negative: -0.15,
}

export interface RelationshipLoadResult {
  byContact: Map<string, RelationshipHistory>
  /** Missing tables degrade to "no history" rather than failing the run. */
  degraded: string[]
}

/**
 * Load history for every contact of a user, in a handful of queries.
 *
 * Per-contact queries would be 897 round trips; this is four, and the joins are
 * done in memory where they are free.
 */
export async function loadRelationshipHistory(userId: string): Promise<RelationshipLoadResult> {
  const supabase = createServiceClient()
  const degraded: string[] = []
  const byContact = new Map<string, RelationshipHistory>()

  const acc = new Map<
    string,
    { met: boolean; referred: boolean; positive: boolean; negative: boolean; anyReply: boolean; touches: number; lastContactedAt: string | null; lastReplyAt: string | null }
  >()
  const bump = (id: string) => {
    let a = acc.get(id)
    if (!a) {
      a = { met: false, referred: false, positive: false, negative: false, anyReply: false, touches: 0, lastContactedAt: null, lastReplyAt: null }
      acc.set(id, a)
    }
    return a
  }
  const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b)

  // ─── sent mail ───
  const { data: emails, error: emailErr } = await supabase
    .from('emails')
    .select('contact_id, status, sent_at')
    .eq('user_id', userId)
    .eq('status', 'sent')
    .limit(5000)
  if (emailErr) degraded.push(`emails: ${emailErr.message.slice(0, 80)}`)
  for (const e of emails ?? []) {
    if (!e.contact_id) continue
    const a = bump(e.contact_id)
    a.touches++
    a.lastContactedAt = later(a.lastContactedAt, e.sent_at)
  }

  // ─── conversations + inbound messages ───
  const { data: convos, error: convoErr } = await supabase
    .from('conversations')
    .select('id, contact_id, status, outcome, last_message_at')
    .eq('user_id', userId)
    .limit(2000)
  if (convoErr) degraded.push(`conversations: ${convoErr.message.slice(0, 80)}`)

  const convoContact = new Map<string, string>()
  for (const c of convos ?? []) {
    if (!c.contact_id) continue
    convoContact.set(c.id, c.contact_id)
    const a = bump(c.contact_id)
    if (c.status === 'meeting_booked') a.met = true
    if (c.status === 'closed_positive') a.positive = true
    if (c.status === 'closed_negative') a.negative = true
  }

  const replyCount = new Map<string, number>()
  if (convoContact.size > 0) {
    const { data: msgs, error: msgErr } = await supabase
      .from('messages')
      .select('conversation_id, direction, classification, sent_at')
      .in('conversation_id', Array.from(convoContact.keys()))
      .eq('direction', 'inbound')
      .limit(4000)
    if (msgErr) degraded.push(`messages: ${msgErr.message.slice(0, 80)}`)
    for (const m of msgs ?? []) {
      const contactId = convoContact.get(m.conversation_id)
      if (!contactId) continue
      const a = bump(contactId)
      // auto_reply and bounce are not a human answering.
      if (m.classification === 'auto_reply' || m.classification === 'bounce') continue
      replyCount.set(contactId, (replyCount.get(contactId) ?? 0) + 1)
      a.anyReply = true
      a.lastReplyAt = later(a.lastReplyAt, m.sent_at)
      if (POSITIVE.has(String(m.classification))) a.positive = true
      if (NEGATIVE.has(String(m.classification))) a.negative = true
    }
  }

  // ─── outreach state, which is the richest of the three ───
  const { data: outreach, error: outErr } = await supabase
    .from('outreach')
    .select('contact_id, state, outcome, reply_classification, sent_at, replied_at')
    .eq('user_id', userId)
    .limit(2000)
  if (outErr && !/does not exist|schema cache/i.test(outErr.message)) {
    degraded.push(`outreach: ${outErr.message.slice(0, 80)}`)
  }
  for (const o of outreach ?? []) {
    if (!o.contact_id) continue
    const a = bump(o.contact_id)
    if (o.sent_at) a.lastContactedAt = later(a.lastContactedAt, o.sent_at)
    if (o.replied_at) {
      a.anyReply = true
      a.lastReplyAt = later(a.lastReplyAt, o.replied_at)
    }
    if (o.state === 'meeting' || o.outcome === 'CALL_BOOKED') a.met = true
    if (o.state === 'referred' || o.outcome === 'REFERRED') a.referred = true
    if (POSITIVE.has(String(o.reply_classification))) a.positive = true
    if (NEGATIVE.has(String(o.reply_classification)) || o.outcome === 'NOT_INTERESTED') a.negative = true
  }

  // ─── contacts.status, the V1 signal, as a floor ───
  const { data: contacts, error: contactErr } = await supabase
    .from('contacts')
    .select('id, status, last_contacted_at')
    .eq('user_id', userId)
    .limit(5000)
  if (contactErr) degraded.push(`contacts: ${contactErr.message.slice(0, 80)}`)
  for (const c of contacts ?? []) {
    const a = bump(c.id)
    if (c.status === 'meeting') a.met = true
    if (c.status === 'replied') a.anyReply = true
    if (c.status === 'sent' && a.touches === 0) a.touches = 1
    if (c.last_contacted_at) a.lastContactedAt = later(a.lastContactedAt, c.last_contacted_at)
  }

  for (const [contactId, a] of acc) {
    const status = statusFrom({ ...a, touches: a.touches })
    byContact.set(contactId, {
      status,
      touches: a.touches,
      replies: replyCount.get(contactId) ?? (a.anyReply ? 1 : 0),
      lastContactedAt: a.lastContactedAt,
      lastReplyAt: a.lastReplyAt,
      note: describe(status, a.touches, a.lastContactedAt),
      scoreModifier: MODIFIER[status],
    })
  }

  return { byContact, degraded }
}
