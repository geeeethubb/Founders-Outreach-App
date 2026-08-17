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
import { outreachPrompt, type OutreachInput, type OutreachReference } from './prompt'

export type { OutreachInput, OutreachReference }

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
  // Counts submit attempts, so the length rule can be strict once and then
  // yield. See the under-length branch below.
  let attempts = 0

  const validate = (raw: unknown): OutreachDraft | null => {
    attempts++
    if (!raw || typeof raw !== 'object') return null
    const r = raw as Record<string, unknown>

    const subject = String(r.subject ?? '').trim()
    const body = String(r.body ?? '').trim()
    if (!subject || !body) return null

    const words = countWords(body)
    // In reference mode the band comes from the user's own email, not from a
    // house rule — matching the reference IS the job.
    const { min, max } = input.reference?.style.target_words ?? input.wordTarget

    // Over the limit is rejected so the loop retries and actually cuts. Asking
    // for 60-120 and accepting 133 teaches the agent the limit is decorative,
    // and the drafts drifted longer every time the brief got richer.
    if (words > max) return null

    // In BRIEF mode the lower bound stays advisory: a genuinely tight email is
    // a success. In REFERENCE mode it is not — under-shooting the reference by
    // 40% is precisely the over-compression this mode exists to stop.
    //
    // But only for two attempts. ADR-010: a draft that still fails reaches the
    // human FLAGGED, it is never discarded. Rejecting forever would turn the
    // most common style miss into no draft at all, which is worse than a short
    // draft the user can extend — and `lengthWarning` says exactly what happened.
    if (input.reference && words < min && attempts < 3) return null

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
      // Changing the campaign's reference email must produce a different draft,
      // not a replay of the one written before it existed.
      reference: input.reference ? `${input.reference.campaignName}:${input.reference.body}` : null,
      relationship: input.relationshipNote ?? null,
    },
  })
}
