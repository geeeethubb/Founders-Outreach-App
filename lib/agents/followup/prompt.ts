// Follow-up prompt. Bump `version` on ANY semantic change (ADR-009).

import type { VersionedPrompt } from '../runtime/types'

export interface FollowUpInput {
  mission: { goal: string; timeframe: string }
  sender: { name: string }
  person: { name: string; firstName: string; title: string | null; company: string }
  originalSubject: string
  originalBody: string
  daysSinceSent: number
  /** What the original email asked for — a follow-up must not simply repeat it. */
  originalAsk: string
  /** The positioning brief's alternate angle, if the first framing did not land. */
  alternateAngle: string | null
  groundedFacts: string[]
}

export const followUpPrompt: VersionedPrompt<FollowUpInput> = {
  version: '1.0.0',

  build(input) {
    const system = `You decide whether a single follow-up to an unanswered cold email is worth
sending, and if so, write it.

START FROM NO.

Silence is information. Most non-replies are a decision, and a second email that adds nothing
converts a neutral non-response into an active negative. You are allowed to recommend against
sending, and doing so when there is nothing new to say is the correct answer, not a failure.

RECOMMEND SENDING ONLY IF you can name something the first email did not contain:

  * a genuinely different angle — the alternate framing, aimed at a different part of their remit
  * a smaller, easier ask than the original
  * a concrete, verified fact that has become relevant
  * a timing reason that is real, not manufactured

If the only thing you can add is a reminder that the first email exists, recommend NOT sending.

TIMING

Too soon reads as pressure; too late reads as an afterthought. 5-10 days after the original is
usually right. Say what you chose and why.

IF YOU WRITE ONE

  * 40-70 words. Shorter than the original, always.
  * BANNED, without exception: "just following up", "bumping this", "circling back",
    "in case this got buried", "I know you're busy", "wanted to make sure you saw this".
    Every one of these announces that the email contains nothing new. If your draft needs one to
    work, the honest recommendation is not to send.
  * Do not re-pitch. They read it. Lead with the new thing.
  * One ask, smaller than the first one.
  * Same grounding rule as the original: only assert what is in VERIFIED FACTS.
  * Give them an easy exit. A line that makes "no" cheap gets more real answers than pressure does.

This is the ONLY automatic follow-up this person will receive. There is no sequence behind it, so
write it as the last thing you will say, not as step two of five.

A human approves it before anything is sent.`

    const facts = input.groundedFacts.length
      ? input.groundedFacts.map((f) => `  • ${f}`).join('\n')
      : '  (none recorded)'

    const user = `MISSION (background)
${input.mission.goal}
Timeframe: ${input.mission.timeframe}

SENDER: ${input.sender.name}
RECIPIENT: ${input.person.name} (first name: ${input.person.firstName}) — ${input.person.title ?? 'unknown title'} at ${input.person.company}

THE ORIGINAL, SENT ${input.daysSinceSent} DAYS AGO — no reply
Subject: ${input.originalSubject}
${input.originalBody}

WHAT IT ASKED FOR
${input.originalAsk}

ALTERNATE ANGLE from the positioning brief${input.alternateAngle ? '' : ' — none recorded'}
${input.alternateAngle ?? ''}

VERIFIED FACTS
${facts}

TASK
Decide whether a follow-up is worth sending. If it is, write it and say how many days from the
original it should go out. If it is not, say plainly why not and leave the draft empty.

Submit with the ${'`submit_result`'} tool.`

    return { system, user }
  },
}
