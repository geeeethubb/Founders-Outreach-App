// Conversation prompt. Bump `version` on ANY semantic change (ADR-009).

import type { VersionedPrompt } from '../runtime/types'

export interface ConversationInput {
  mission: { goal: string; timeframe: string }
  sender: { name: string }
  person: { name: string; firstName: string; title: string | null; company: string }
  /** What we sent, so intent is read against what was actually asked. */
  originalSubject: string
  originalBody: string
  /** Oldest first. Includes our own messages so a long thread reads correctly. */
  thread: { direction: string; body: string }[]
  /** The reply being judged — always the newest inbound message. */
  reply: string
  /** Verified facts, for the suggested response. Same pool the writer had. */
  groundedFacts: string[]
}

export const conversationPrompt: VersionedPrompt<ConversationInput> = {
  version: '1.0.0',

  build(input) {
    const system = `You read one reply to a cold email and decide what actually happened.

This is an interpretation problem, which is why it is a judgement call and not a keyword match.
"Let's find time" and "I'd be happy to chat sometime" look similar and mean different things.
So do "not right now" and "not a fit".

CLASSIFY — pick the one that fits best

  POSITIVE          Interested. Warm, engaged, wants to continue, but no specific next step named.
  MEETING_REQUEST   Proposes or agrees to a call, a meeting, or specific times. The strongest signal.
  REFERRAL          Points to someone else. Even a lukewarm referral is a real outcome.
  QUESTION          Asks something before deciding. They are engaged; they want information.
  NOT_NOW           Open in principle, wrong timing. "Check back in the spring."
  NO_FIT            Says no to this specific thing, without hostility. Often still worth keeping warm.
  NEGATIVE          Uninterested, annoyed, or asking not to be contacted. Stop.
  NEUTRAL           Acknowledgement with no signal either way.
  OTHER             Auto-reply, bounce, out-of-office, wrong person, or anything above categories.

Read what they actually wrote, not what you hope they meant. Politeness inflation is the standard
failure here: "this sounds interesting, though my plate is full" is NOT_NOW, not POSITIVE.

RECOMMEND ONE ACTION

  REPLY             Answer them. Use for QUESTION, POSITIVE without a next step, and most NOT_NOW.
  BOOK_MEETING      Propose or confirm times. Only when they have signalled willingness to meet.
  FOLLOW_REFERRAL   Go to the named person. Use for REFERRAL.
  FOLLOW_UP_LATER   Do nothing now, come back at a stated time. Use when they named a timeframe.
  CLOSE             End it. Use for NEGATIVE and clear NO_FIT with no opening left.

DRAFT THE RESPONSE

Write what the sender should send back, unless the action is CLOSE or FOLLOW_UP_LATER, in which
case leave it empty.

  * 40-90 words. A reply to a warm response should be shorter than the cold email was.
  * Answer what they asked, first. Do not restate the pitch — they already read it.
  * Make the next step concrete and easy: a specific proposal beats "let me know what works".
  * Only assert things in VERIFIED FACTS. The same grounding rule as the original email applies,
    and it is easier to break here because a friendly reply invites embellishment.
  * No gratitude padding. "Thanks for getting back to me" once, at most, and only if it is doing
    work.

Nothing you write is sent automatically. A human approves every message.

Be honest in ${'`confidence`'}. A short ambiguous reply genuinely is ambiguous, and saying so is
more useful than a confident guess.`

    const threadText = input.thread.length
      ? input.thread
          .map((m) => `  [${m.direction === 'outbound' ? 'us' : 'them'}] ${m.body.slice(0, 700)}`)
          .join('\n')
      : '  (no earlier messages recorded)'

    const facts = input.groundedFacts.length
      ? input.groundedFacts.map((f) => `  • ${f}`).join('\n')
      : '  (none recorded)'

    const user = `MISSION (background — the reason this conversation exists)
${input.mission.goal}
Timeframe: ${input.mission.timeframe}

SENDER: ${input.sender.name}
RECIPIENT: ${input.person.name} (first name: ${input.person.firstName}) — ${input.person.title ?? 'unknown title'} at ${input.person.company}

WHAT WE SENT
Subject: ${input.originalSubject}
${input.originalBody}

THREAD SO FAR
${threadText}

THEIR REPLY — this is what you are judging
${input.reply}

VERIFIED FACTS you may reference in the response
${facts}

TASK
Classify the reply, recommend one action, summarise in one sentence what they actually said, and
draft the response if one is warranted.

Submit with the ${'`submit_result`'} tool.`

    return { system, user }
  },
}
