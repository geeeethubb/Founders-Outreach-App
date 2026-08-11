// Follow-Up Agent.
//
// Judgment problem it owns: "is there anything left worth saying to someone who
// did not answer, and what is it?"
//
// The cap is one automatic suggested follow-up per cold outreach, enforced in
// the route against `outreach.followup_count` — not here, and not in the prompt.
// A limit an agent is asked to respect is a suggestion; a limit the schema
// enforces is a limit.

import { runAgent } from '../runtime/loop'
import type { AgentResult, ToolContext } from '../runtime/types'
import { followUpPrompt, type FollowUpInput } from './prompt'

export type { FollowUpInput }

export interface FollowUpSuggestion {
  should_follow_up: boolean
  /** Why, either way. A "no" needs a reason as much as a "yes" does. */
  rationale: string
  send_after_days: number | null
  subject: string | null
  body: string | null
  wordCount: number
  /** What this adds that the original did not. Empty when not sending. */
  new_value: string | null
}

const OUTPUT_SCHEMA = {
  properties: {
    should_follow_up: { type: 'boolean' },
    rationale: { type: 'string', description: 'One or two sentences. Required either way.' },
    new_value: {
      type: 'string',
      description: 'The specific thing this adds that the first email did not. Empty if not sending.',
    },
    send_after_days: {
      type: 'number',
      description: 'Days after the original send. 0 when not following up.',
    },
    subject: { type: 'string', description: 'Usually "Re: <original>". Empty when not sending.' },
    body: { type: 'string', description: '40-70 words. Empty when not sending.' },
  },
  required: ['should_follow_up', 'rationale'],
}

const MAX_WORDS = 90

const BANNED = [
  'just following up',
  'following up on',
  'bumping this',
  'circling back',
  'in case this got buried',
  'in case you missed',
  'wanted to make sure you saw',
  'i know you',
  'gentle nudge',
  'checking in',
]

function countWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length
}

export async function runFollowUp(
  input: FollowUpInput,
  ctx: ToolContext
): Promise<AgentResult<FollowUpSuggestion>> {
  const validate = (raw: unknown): FollowUpSuggestion | null => {
    if (!raw || typeof raw !== 'object') return null
    const r = raw as Record<string, unknown>

    const should = Boolean(r.should_follow_up)
    const rationale = String(r.rationale ?? '').trim()
    if (!rationale) return null

    if (!should) {
      return {
        should_follow_up: false,
        rationale,
        send_after_days: null,
        subject: null,
        body: null,
        wordCount: 0,
        new_value: null,
      }
    }

    const body = String(r.body ?? '').trim()
    if (!body) return null

    // The banned openers are checked here rather than trusted to the prompt.
    // "Just following up" is the exact failure this agent exists to avoid, so a
    // draft containing one is rejected and rewritten.
    const lower = body.toLowerCase()
    if (BANNED.some((b) => lower.includes(b))) return null

    const words = countWords(body)
    if (words > MAX_WORDS) return null

    const days = Number(r.send_after_days)

    return {
      should_follow_up: true,
      rationale,
      send_after_days: Number.isFinite(days) && days > 0 ? Math.round(days) : 7,
      subject: String(r.subject ?? '').trim() || null,
      body,
      wordCount: words,
      new_value: String(r.new_value ?? '').trim() || null,
    }
  }

  return runAgent<FollowUpInput, FollowUpSuggestion>({
    agentId: 'followup',
    tier: 'standard',
    modelRole: 'writing',
    prompt: followUpPrompt,
    input,
    outputSchema: OUTPUT_SCHEMA,
    validate,
    ctx,
    webSearch: false,
    maxSteps: 4,
    maxTokens: 1000,
    cacheKeyParts: {
      person: input.person.name,
      original: input.originalSubject,
      days: String(input.daysSinceSent),
    },
  })
}
