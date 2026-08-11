// Conversation Agent.
//
// Judgment problem it owns: "what did this reply actually mean, and what should
// happen next?"
//
// It classifies and drafts. It does not send, does not change state, and does
// not touch the database — the route persists what it returns. The mapping from
// classification to state is arithmetic and lives in lib/outreach/states.ts
// (CLAUDE.md principle 1).

import { runAgent } from '../runtime/loop'
import type { AgentResult, ToolContext } from '../runtime/types'
import { conversationPrompt, type ConversationInput } from './prompt'

export type { ConversationInput }

export const REPLY_CLASSIFICATIONS = [
  'POSITIVE',
  'NEUTRAL',
  'NEGATIVE',
  'REFERRAL',
  'MEETING_REQUEST',
  'QUESTION',
  'NOT_NOW',
  'NO_FIT',
  'OTHER',
] as const

export const REPLY_ACTIONS = [
  'REPLY',
  'BOOK_MEETING',
  'FOLLOW_REFERRAL',
  'FOLLOW_UP_LATER',
  'CLOSE',
] as const

export type ReplyClassification = (typeof REPLY_CLASSIFICATIONS)[number]
export type ReplyAction = (typeof REPLY_ACTIONS)[number]

export interface ConversationVerdict {
  classification: ReplyClassification
  action: ReplyAction
  /** One sentence on what they actually said. */
  summary: string
  suggested_subject: string | null
  suggested_body: string | null
  /** Set when the action names a time to come back. */
  follow_up_after_days: number | null
  confidence: number
  reasoning: string
}

const OUTPUT_SCHEMA = {
  properties: {
    classification: { type: 'string', enum: [...REPLY_CLASSIFICATIONS] },
    action: { type: 'string', enum: [...REPLY_ACTIONS] },
    summary: { type: 'string', description: 'One sentence: what they actually said.' },
    reasoning: { type: 'string', description: 'Two sentences at most. Why this reading.' },
    suggested_subject: {
      type: 'string',
      description: 'Usually "Re: <their subject>". Empty when no response is warranted.',
    },
    suggested_body: {
      type: 'string',
      description: '40-90 words. Empty string when the action is CLOSE or FOLLOW_UP_LATER.',
    },
    follow_up_after_days: {
      type: 'number',
      description: 'Days until it makes sense to come back. 0 when not applicable.',
    },
    confidence: { type: 'number', description: '0.0 to 1.0. Ambiguous replies deserve low numbers.' },
  },
  required: ['classification', 'action', 'summary', 'reasoning', 'confidence'],
}

/** Actions where silence is the correct output — an empty draft is not a failure. */
const NO_DRAFT_ACTIONS: ReplyAction[] = ['CLOSE', 'FOLLOW_UP_LATER']

export async function runConversation(
  input: ConversationInput,
  ctx: ToolContext
): Promise<AgentResult<ConversationVerdict>> {
  const validate = (raw: unknown): ConversationVerdict | null => {
    if (!raw || typeof raw !== 'object') return null
    const r = raw as Record<string, unknown>

    const classification = String(r.classification ?? '') as ReplyClassification
    const action = String(r.action ?? '') as ReplyAction
    if (!REPLY_CLASSIFICATIONS.includes(classification)) return null
    if (!REPLY_ACTIONS.includes(action)) return null

    const summary = String(r.summary ?? '').trim()
    if (!summary) return null

    const body = String(r.suggested_body ?? '').trim()
    // An action that calls for a response but produces none is an incomplete
    // answer, not a judgement — retry rather than hand the user an empty box.
    if (!NO_DRAFT_ACTIONS.includes(action) && !body) return null

    const confidence = Number(r.confidence)
    const days = Number(r.follow_up_after_days)

    return {
      classification,
      action,
      summary,
      reasoning: String(r.reasoning ?? '').trim(),
      suggested_subject: body ? String(r.suggested_subject ?? '').trim() || null : null,
      suggested_body: body || null,
      follow_up_after_days: Number.isFinite(days) && days > 0 ? Math.round(days) : null,
      confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5,
    }
  }

  return runAgent<ConversationInput, ConversationVerdict>({
    agentId: 'conversation',
    // Reading intent out of two ambiguous sentences is the whole task, and a
    // reply only exists because someone already engaged — the most expensive
    // moment in the funnel to misread. Still no search, so it stays cents.
    tier: 'standard',
    modelRole: 'reasoning',
    prompt: conversationPrompt,
    input,
    outputSchema: OUTPUT_SCHEMA,
    validate,
    ctx,
    webSearch: false,
    maxSteps: 4,
    maxTokens: 1200,
    cacheKeyParts: {
      person: input.person.name,
      reply: input.reply.slice(0, 400),
      thread: String(input.thread.length),
    },
  })
}
