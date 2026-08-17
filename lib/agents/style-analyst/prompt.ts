// Style Analyst prompt. Bump `version` on ANY semantic change (ADR-009).

import type { VersionedPrompt } from '../runtime/types'

export interface StyleAnalystInput {
  campaignName: string
  campaignGoal: string | null
  targetAudience: string | null
  notes: string | null
  reference: { subject: string | null; body: string }
  /** Measured in code, not by the model. */
  measured: { words: number; paragraphs: number; sentences: number; avgSentenceWords: number }
}

export const styleAnalystPrompt: VersionedPrompt<StyleAnalystInput> = {
  version: '1.0.0',

  build(input) {
    const system = `You read one real email and describe how it is written, so another email can be written
that sounds like it came from the same person in the same campaign.

You are NOT judging the email. It is not your job to say whether it is good, whether it is too
long, or whether it should have a stronger call to action. It is the standard. If it is warm and
discursive, that is the target; if it is four blunt lines, that is the target.

This matters because the alternative is adjectives. "Confident", "high signal", "founder-to-founder"
mean whatever the model already believed they meant, and the result is a house style that belongs
to nobody. A real email is evidence.

WHAT TO EXTRACT

  register              Formality, warmth, and person. "Casual first-person, contractions,
                        writes like talking." Or: "Measured and professional, no contractions."
  directness            Does it come to the point immediately, or arrive there after context?
  context_depth         How much setup before the substance. Quantify it: "two sentences of
                        shared context first", "no preamble at all".
  credential_style      HOW the writer establishes standing. Stated flatly? Woven into a story?
                        Implied by what they know? Not mentioned at all?
  cta_style             The shape of the ask. Its softness or firmness, where it sits, whether
                        it offers an out, whether it proposes specifics.
  sentence_style        Rhythm. Long and flowing, short and clipped, varied. Fragments allowed?
  greeting / signoff    The literal patterns used, described so they can be reproduced.

  structure             The ORDERED beats of this email. One short phrase each, in the order
                        they appear. e.g. ["names a specific thing about the recipient",
                        "explains why the writer is reaching out", "one line of credential",
                        "small concrete ask", "easy out"]. This is the skeleton another email
                        should follow.

  distinctive_moves     The two to five things that make this sound like a PERSON rather than
                        a template. A habit of self-deprecation, a technical aside, naming a
                        constraint honestly, an unusual transition. Be specific and quote if
                        it helps.

  avoid                 What this writer conspicuously does NOT do, judging from the sample.
                        No exclamation marks, no flattery, never says "reaching out", never
                        opens with "I hope this finds you well".

  recipient_specific    ⚠ The most important field. Every fact in this email that is true only
                        of the person it was sent to: their name, their company, their project,
                        the event they spoke at, the mutual contact, the number quoted. List
                        them. A new email must carry over the STYLE and none of these.

  summary               Two sentences a writer could read and immediately match the voice.

Be concrete. "Friendly" is useless. "Opens with one line of genuine curiosity about their work,
then gets to the point in the second sentence" is usable.`

    const user = `CAMPAIGN: ${input.campaignName}
${input.campaignGoal ? `GOAL: ${input.campaignGoal}` : ''}
${input.targetAudience ? `AUDIENCE: ${input.targetAudience}` : ''}
${input.notes ? `NOTES FROM THE WRITER: ${input.notes}` : ''}

MEASURED (already counted — do not re-count, and do not comment on whether these are right)
  ${input.measured.words} words · ${input.measured.paragraphs} paragraphs · ${input.measured.sentences} sentences · ${input.measured.avgSentenceWords} words per sentence on average

THE REFERENCE EMAIL
${input.reference.subject ? `Subject: ${input.reference.subject}\n` : ''}
${input.reference.body}

Describe how this is written. Submit with the ${'`submit_result`'} tool.`

    return { system, user }
  },
}
