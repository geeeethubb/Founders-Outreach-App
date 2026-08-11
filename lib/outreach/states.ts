// The outreach state machine.
//
// Pure functions over a string union — no database, no side effects. Transitions
// are data so the API, the UI and the tests all read the same table rather than
// each re-deciding what "can I send this?" means.
//
// The one rule the whole phase exists to protect: nothing reaches `sending`
// except from `approved`, and only a human puts anything in `approved`
// (ARCHITECTURE §10 / CLAUDE.md principle 10).

export const OUTREACH_STATES = [
  'draft',
  'ready_for_review',
  'approved',
  'skipped',
  'sending',
  'sent',
  'failed',
  'replied',
  'meeting',
  'referred',
  'closed',
] as const

export type OutreachState = (typeof OUTREACH_STATES)[number]

/**
 * Allowed transitions. Absent pairs are rejected — a state machine that lets
 * anything reach anything is just a string column.
 */
const TRANSITIONS: Record<OutreachState, OutreachState[]> = {
  // A fresh draft. Grounding has not been checked yet.
  draft: ['ready_for_review', 'approved', 'skipped'],
  // Grounding passed; waiting on the human.
  ready_for_review: ['approved', 'skipped', 'draft'],
  // The human said yes. Only this state may be claimed by the sender.
  approved: ['sending', 'draft', 'skipped'],
  // Held by the send path. Terminal-ish: only the sender itself moves it on.
  sending: ['sent', 'failed'],
  // Gmail accepted it. Irreversible — you cannot unsend.
  sent: ['replied', 'closed'],
  // Gmail rejected it. The approved draft is preserved and retryable.
  failed: ['sending', 'approved', 'draft', 'skipped'],
  replied: ['meeting', 'referred', 'closed', 'replied'],
  meeting: ['closed', 'referred'],
  referred: ['closed', 'meeting'],
  // Revivable: a person you passed on this month may fit next month.
  skipped: ['draft'],
  closed: [],
}

/** States after which the outbound message physically exists. */
const IRREVERSIBLE: OutreachState[] = ['sending', 'sent', 'replied', 'meeting', 'referred', 'closed']

export function canTransition(from: OutreachState, to: OutreachState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false
}

export function nextStates(from: OutreachState): OutreachState[] {
  return TRANSITIONS[from] ?? []
}

/**
 * True once the email has left. Editing, re-approving or re-drafting after this
 * point would mean the stored draft no longer matches what the recipient read,
 * which quietly destroys the provenance the rest of the system depends on.
 */
export function isSendCommitted(state: OutreachState): boolean {
  return IRREVERSIBLE.includes(state)
}

export function isEditable(state: OutreachState): boolean {
  return !isSendCommitted(state)
}

/** Everything that has actually gone out, for funnel arithmetic. */
export function hasBeenSent(state: OutreachState): boolean {
  return ['sent', 'replied', 'meeting', 'referred', 'closed'].includes(state)
}

export function hasReplied(state: OutreachState): boolean {
  return ['replied', 'meeting', 'referred'].includes(state)
}

export function isOutreachState(v: unknown): v is OutreachState {
  return typeof v === 'string' && (OUTREACH_STATES as readonly string[]).includes(v)
}

export const OUTCOMES = [
  'NO_RESPONSE',
  'REPLIED',
  'CALL_BOOKED',
  'REFERRED',
  'RESUME_REQUESTED',
  'PROJECT_DISCUSSION',
  'INTERNSHIP_DISCUSSION',
  'OPPORTUNITY_CREATED',
  'NOT_INTERESTED',
] as const

export type Outcome = (typeof OUTCOMES)[number]

export function isOutcome(v: unknown): v is Outcome {
  return typeof v === 'string' && (OUTCOMES as readonly string[]).includes(v)
}

/** Outcomes that represent a real conversation, for the funnel's last two rows. */
export const CONVERSATION_OUTCOMES: Outcome[] = [
  'CALL_BOOKED',
  'REFERRED',
  'RESUME_REQUESTED',
  'PROJECT_DISCUSSION',
  'INTERNSHIP_DISCUSSION',
  'OPPORTUNITY_CREATED',
]

export const OPPORTUNITY_OUTCOMES: Outcome[] = [
  'INTERNSHIP_DISCUSSION',
  'PROJECT_DISCUSSION',
  'OPPORTUNITY_CREATED',
]

/**
 * Where a reply classification should move the relationship. The Conversation
 * Agent judges what the reply meant; this maps that judgement onto state, which
 * is arithmetic and belongs in code (CLAUDE.md principle 1).
 */
export function stateForClassification(
  classification: string,
  current: OutreachState
): OutreachState {
  if (!hasBeenSent(current)) return current
  switch (classification) {
    case 'MEETING_REQUEST':
      return 'meeting'
    case 'REFERRAL':
      return 'referred'
    case 'NO_FIT':
    case 'NEGATIVE':
      return 'closed'
    default:
      return current === 'sent' ? 'replied' : current
  }
}
