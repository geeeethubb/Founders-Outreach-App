// Outreach Agent.
//
// Judgment problem it owns: "say the decided angle in a way a busy person
// answers."
//
// Deliberately NOT allowed to re-decide the angle, the proof points or the ask —
// positioning already did that with the full research in front of it. Splitting
// the two means a bad email can be diagnosed as a writing problem or a
// positioning problem, which is impossible when one agent does both.
//
// Nothing here sends anything. Every draft goes to a human (ARCHITECTURE §10).

import { runAgent } from '../runtime/loop'
import type { AgentResult, ToolContext } from '../runtime/types'
import { outreachPrompt, type OutreachInput } from './prompt'

export type { OutreachInput }

export interface OutreachDraft {
  subject: string
  body: string
  wordCount: number
  alternate_angle: string
  /** Set when the body missed the word target — surfaced, not silently accepted. */
  lengthWarning: string | null
}

const OUTPUT_SCHEMA = {
  properties: {
    subject: { type: 'string', description: 'Six words or fewer. Specific, not clickbait.' },
    body: {
      type: 'string',
      description: 'The email body. No subject line, no signature block — those are added around it.',
    },
    alternate_angle: {
      type: 'string',
      description: 'One sentence: a different way in, for when the first framing does not land.',
    },
  },
  required: ['subject', 'body', 'alternate_angle'],
}

function countWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length
}

export async function runOutreach(
  input: OutreachInput,
  ctx: ToolContext
): Promise<AgentResult<OutreachDraft>> {
  const validate = (raw: unknown): OutreachDraft | null => {
    if (!raw || typeof raw !== 'object') return null
    const r = raw as Record<string, unknown>

    const subject = String(r.subject ?? '').trim()
    const body = String(r.body ?? '').trim()
    if (!subject || !body) return null

    const words = countWords(body)
    const { min, max } = input.wordTarget

    // Over the limit is rejected so the loop retries and actually cuts. Asking
    // for 60-120 and accepting 133 teaches the agent the limit is decorative,
    // and the drafts drifted longer every time the brief got richer.
    // The lower bound stays advisory: a genuinely tight email is a success.
    if (words > max) return null

    return {
      subject,
      body,
      wordCount: words,
      alternate_angle: String(r.alternate_angle ?? '').trim(),
      lengthWarning:
        words > max
          ? `${words} words, target was ${min}-${max}`
          : words < min
            ? `${words} words — shorter than the ${min}-word target`
            : null,
    }
  }

  return runAgent<OutreachInput, OutreachDraft>({
    agentId: 'outreach',
    // Writing is where model quality is most visible to the recipient, and this
    // runs only on prospects a human already chose to pursue.
    tier: 'standard',
    modelRole: 'writing',
    prompt: outreachPrompt,
    input,
    outputSchema: OUTPUT_SCHEMA,
    validate,
    ctx,
    webSearch: false,
    // 3 left no room for the loop's nudge turn: one draft died at the cap
    // without ever submitting.
    // Room for a length rejection AND the loop's nudge turn.
    maxSteps: 5,
    maxTokens: 1500,
    cacheKeyParts: {
      person: input.person.name,
      company: input.person.company,
      positioning: input.positioning,
      target: `${input.wordTarget.min}-${input.wordTarget.max}`,
    },
  })
}
