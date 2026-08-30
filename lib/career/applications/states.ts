// Application state machine — a lookup table, tested, no model involved.
//
// Same shape as lib/outreach/states.ts: the code decides which transitions are
// legal, and the route decides nothing on its own. The one side effect that
// matters is APPLIED, which LOCKS the application: the package and documents
// that were submitted can never be overwritten afterwards (docs/CAREER_OS.md §4).

import type { ApplicationState } from '../types'

export const APPLICATION_TRANSITIONS: Record<ApplicationState, ApplicationState[]> = {
  DISCOVERED: ['SAVED', 'PREPARING', 'CLOSED'],
  SAVED: ['RESEARCHED', 'PREPARING', 'DISCOVERED', 'WITHDRAWN', 'CLOSED', 'APPLIED'],
  RESEARCHED: ['PREPARING', 'SAVED', 'WITHDRAWN', 'CLOSED', 'APPLIED'],
  PREPARING: ['READY_FOR_REVIEW', 'SAVED', 'RESEARCHED', 'CLOSED'],
  READY_FOR_REVIEW: ['READY_TO_APPLY', 'PREPARING', 'SAVED', 'CLOSED'],
  READY_TO_APPLY: ['APPLIED', 'PREPARING', 'READY_FOR_REVIEW', 'WITHDRAWN', 'CLOSED'],
  APPLIED: ['OA', 'INTERVIEW', 'FINAL_ROUND', 'OFFER', 'REJECTED', 'WITHDRAWN', 'CLOSED'],
  OA: ['INTERVIEW', 'FINAL_ROUND', 'OFFER', 'REJECTED', 'WITHDRAWN'],
  INTERVIEW: ['FINAL_ROUND', 'OFFER', 'REJECTED', 'WITHDRAWN', 'OA'],
  FINAL_ROUND: ['OFFER', 'REJECTED', 'WITHDRAWN', 'INTERVIEW'],
  OFFER: ['CLOSED', 'WITHDRAWN', 'REJECTED'],
  // Terminal states can be reopened — a mis-click should not be permanent.
  // A pre-application record reopens to SAVED; a post-application one to APPLIED.
  REJECTED: ['APPLIED', 'INTERVIEW', 'CLOSED'],
  WITHDRAWN: ['SAVED', 'APPLIED', 'CLOSED'],
  CLOSED: ['SAVED', 'APPLIED'],
}

export const PRE_APPLICATION_STATES: ApplicationState[] = [
  'DISCOVERED', 'SAVED', 'RESEARCHED', 'PREPARING', 'READY_FOR_REVIEW', 'READY_TO_APPLY',
]

export const POST_APPLICATION_STATES: ApplicationState[] = [
  'APPLIED', 'OA', 'INTERVIEW', 'FINAL_ROUND', 'OFFER', 'REJECTED', 'WITHDRAWN', 'CLOSED',
]

export const TERMINAL_STATES: ApplicationState[] = ['REJECTED', 'WITHDRAWN', 'CLOSED']

export function canTransition(from: ApplicationState, to: ApplicationState): boolean {
  return APPLICATION_TRANSITIONS[from]?.includes(to) ?? false
}

/** True for states in which the submitted documents must be immutable. */
export function isLockedState(state: ApplicationState): boolean {
  return LOCKED_STATES.includes(state)
}

const LOCKED_STATES: ApplicationState[] = ['APPLIED', 'OA', 'INTERVIEW', 'FINAL_ROUND', 'OFFER', 'REJECTED']

export const STATE_LABELS: Record<ApplicationState, string> = {
  DISCOVERED: 'Discovered',
  SAVED: 'Tracked',
  RESEARCHED: 'Researched',
  PREPARING: 'Preparing',
  READY_FOR_REVIEW: 'Ready for review',
  READY_TO_APPLY: 'Ready to apply',
  APPLIED: 'Applied',
  OA: 'Online assessment',
  INTERVIEW: 'Interview',
  FINAL_ROUND: 'Final round',
  OFFER: 'Offer',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
  CLOSED: 'Closed',
}

/** Outcome vocabulary for the learning table. Recorded on terminal transitions. */
export type ApplicationOutcome =
  | 'OFFER_ACCEPTED' | 'OFFER_DECLINED' | 'REJECTED_BEFORE_INTERVIEW' | 'REJECTED_AFTER_INTERVIEW'
  | 'WITHDRAWN' | 'NO_RESPONSE' | 'POSTING_CLOSED'

export function outcomeForTransition(from: ApplicationState, to: ApplicationState): ApplicationOutcome | null {
  if (to === 'REJECTED') return from === 'APPLIED' || from === 'OA' ? 'REJECTED_BEFORE_INTERVIEW' : 'REJECTED_AFTER_INTERVIEW'
  if (to === 'WITHDRAWN') return 'WITHDRAWN'
  if (to === 'CLOSED' && from === 'OFFER') return 'OFFER_ACCEPTED'
  if (to === 'CLOSED' && POST_APPLICATION_STATES.includes(from)) return 'NO_RESPONSE'
  if (to === 'CLOSED') return 'POSTING_CLOSED'
  return null
}
