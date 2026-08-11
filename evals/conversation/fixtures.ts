// Reply fixtures for the Conversation Agent.
//
// Hand-written rather than sampled, because there is no reply corpus yet — the
// first real replies arrive after this phase ships. They are modelled on the
// replies this specific outreach earns: a student writing to directors and
// founders, where the common answers are a warm deferral, a referral, or a
// short question.
//
// `acceptable` lists every defensible action, not just one. A REFERRAL could
// reasonably be FOLLOW_REFERRAL or REPLY, and marking the second wrong would
// measure the fixture author's taste rather than the agent's judgement.

export interface ReplyFixture {
  id: string
  reply: string
  expected: string
  /**
   * Other classifications a careful human would also accept.
   *
   * Set from reasoning about the reply, never from what the agent answered.
   * Widening this after seeing a result is how an eval stops measuring
   * anything — the one entry here was declared in `note` before the first run.
   */
  alsoAcceptable?: string[]
  /** Actions a careful human would accept. */
  acceptable: string[]
  /** What makes this one hard. */
  note: string
}

export const REPLY_FIXTURES: ReplyFixture[] = [
  {
    id: 'plain-meeting',
    reply: `Happy to chat. I have Thursday afternoon or Friday morning free — send over a time that works and I'll get it in the diary.`,
    expected: 'MEETING_REQUEST',
    acceptable: ['BOOK_MEETING'],
    note: 'Unambiguous. If this one fails, nothing else matters.',
  },
  {
    id: 'soft-meeting',
    reply: `This is interesting. Easier to talk than type — are you around next week?`,
    expected: 'MEETING_REQUEST',
    acceptable: ['BOOK_MEETING', 'REPLY'],
    note: 'A meeting without the word meeting, and no times offered.',
  },
  {
    id: 'politeness-inflation',
    reply: `Thanks for reaching out, this sounds like interesting work. Unfortunately my plate is completely full through the end of the year.`,
    expected: 'NOT_NOW',
    acceptable: ['FOLLOW_UP_LATER', 'REPLY'],
    note: 'The classic false POSITIVE. Warm words, closed door, open later.',
  },
  {
    id: 'referral',
    reply: `Not my area, but Dana Whitfield runs our advanced manufacturing group and would be the right person. Feel free to say I sent you.`,
    expected: 'REFERRAL',
    acceptable: ['FOLLOW_REFERRAL', 'REPLY'],
    note: 'A real outcome that looks like a rejection if you only read the first clause.',
  },
  {
    id: 'question-gate',
    reply: `Before I take this further — are you looking for a paid internship, and what are your dates? We have a hard cutoff for the winter cohort.`,
    expected: 'QUESTION',
    acceptable: ['REPLY'],
    note: 'Engaged, gating on information. Must not be read as NOT_NOW.',
  },
  {
    id: 'flat-no',
    // Originally "...not hiring interns THIS CYCLE", which the agent read as
    // NOT_NOW — defensibly, since "this cycle" is a temporal qualifier. The
    // fixture was testing timing when it meant to test fit, so the qualifier
    // was removed rather than the expected answer widened.
    reply: `We don't take interns — it isn't something this group does. Good luck with the search.`,
    expected: 'NO_FIT',
    acceptable: ['CLOSE', 'FOLLOW_UP_LATER', 'REPLY'],
    note: 'A no to this ask, without hostility, and with no timing escape hatch.',
  },
  {
    id: 'hostile',
    reply: `Please remove me from your list and do not contact me again.`,
    expected: 'NEGATIVE',
    acceptable: ['CLOSE'],
    note: 'Any answer other than CLOSE here is a product failure, not a scoring quibble.',
  },
  {
    id: 'warm-no-step',
    reply: `Really enjoyed the note — the adoption point is exactly right and most people miss it. I'll keep you in mind.`,
    expected: 'POSITIVE',
    acceptable: ['REPLY', 'FOLLOW_UP_LATER'],
    note: 'Genuinely warm, genuinely no next step. The agent has to propose one.',
  },
  {
    id: 'timed-deferral',
    reply: `Circle back in March — we plan summer projects then and this could fit.`,
    expected: 'NOT_NOW',
    acceptable: ['FOLLOW_UP_LATER', 'REPLY'],
    note: 'Names a date. The suggested follow-up window should reflect it.',
  },
  {
    id: 'ooo',
    reply: `I am out of the office until 4 August with limited access to email. For urgent matters contact operations@example.com.`,
    expected: 'OTHER',
    acceptable: ['FOLLOW_UP_LATER', 'REPLY', 'CLOSE'],
    note: 'Automated. Must not be scored as engagement.',
  },
  {
    id: 'wrong-person',
    reply: `I think you have the wrong Jonathan — I work in finance, not manufacturing.`,
    expected: 'OTHER',
    acceptable: ['CLOSE', 'REPLY', 'FOLLOW_REFERRAL'],
    note: 'A data-quality failure surfacing as a reply.',
  },
  {
    id: 'terse-ack',
    reply: `Noted, thanks.`,
    expected: 'NEUTRAL',
    acceptable: ['REPLY', 'FOLLOW_UP_LATER', 'CLOSE'],
    note: 'Two words. Confidence should be low and the agent should say so.',
  },
  {
    id: 'resume-request',
    reply: `Send me your CV and a paragraph on what you'd want to work on, and I'll pass it to the team.`,
    expected: 'QUESTION',
    alsoAcceptable: ['POSITIVE'],
    acceptable: ['REPLY'],
    note: 'A concrete request for material. POSITIVE is also defensible; the ACTION is what matters.',
  },
  {
    id: 'skeptical',
    reply: `We have tried floor-level AI tools twice and both stalled at adoption. What makes you think a student project gets further?`,
    expected: 'QUESTION',
    acceptable: ['REPLY'],
    note: 'Challenging but engaged. Reading this as NEGATIVE would abandon a live lead.',
  },
]

/** Classifications where a mistake costs the most. */
export const CRITICAL_IDS = ['hostile', 'referral', 'plain-meeting', 'politeness-inflation']
