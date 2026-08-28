// Deterministic checks for the application state machine.
//
//   npx tsx scripts/test-career-applications.ts
//
// No network, no keys. The transition table is the product rule that documents
// submitted with an application can never be overwritten; a wrong edge here is
// a data-loss bug, so every edge is asserted rather than sampled.

import {
  APPLICATION_TRANSITIONS,
  PRE_APPLICATION_STATES,
  POST_APPLICATION_STATES,
  canTransition,
  isLockedState,
  outcomeForTransition,
} from '../lib/career/applications/states'
import { APPLICATION_STATES } from '../lib/career/types'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

console.log('application state machine')
check('every state has a row', APPLICATION_STATES.every((s) => Array.isArray(APPLICATION_TRANSITIONS[s])))
check('every target is a real state', Object.values(APPLICATION_TRANSITIONS).flat().every((s) => APPLICATION_STATES.includes(s)))
check('no self-transitions', Object.entries(APPLICATION_TRANSITIONS).every(([from, tos]) => !tos.includes(from as never)))
check('pre + post partition the states', PRE_APPLICATION_STATES.length + POST_APPLICATION_STATES.length === APPLICATION_STATES.length)

check('happy path SAVED→PREPARING→READY_FOR_REVIEW→READY_TO_APPLY→APPLIED',
  canTransition('SAVED', 'PREPARING') && canTransition('PREPARING', 'READY_FOR_REVIEW') &&
  canTransition('READY_FOR_REVIEW', 'READY_TO_APPLY') && canTransition('READY_TO_APPLY', 'APPLIED'))
check('cannot skip from DISCOVERED to APPLIED', !canTransition('DISCOVERED', 'APPLIED'))
check('cannot go back from APPLIED to SAVED', !canTransition('APPLIED', 'SAVED'))
check('cannot go back from APPLIED to READY_TO_APPLY', !canTransition('APPLIED', 'READY_TO_APPLY'))
check('APPLIED→INTERVIEW→FINAL_ROUND→OFFER', canTransition('APPLIED', 'INTERVIEW') && canTransition('INTERVIEW', 'FINAL_ROUND') && canTransition('FINAL_ROUND', 'OFFER'))
check('OFFER cannot become INTERVIEW', !canTransition('OFFER', 'INTERVIEW'))
check('a mis-clicked REJECTED can reopen to APPLIED', canTransition('REJECTED', 'APPLIED'))
check('a mis-clicked CLOSED before applying reopens to SAVED', canTransition('CLOSED', 'SAVED'))
check('mark-applied directly from SAVED is allowed (user applied without a package)', canTransition('SAVED', 'APPLIED'))

console.log('locking')
check('APPLIED is locked', isLockedState('APPLIED'))
check('OFFER is locked', isLockedState('OFFER'))
check('READY_TO_APPLY is not locked', !isLockedState('READY_TO_APPLY'))
check('SAVED is not locked', !isLockedState('SAVED'))

console.log('outcomes')
check('APPLIED→REJECTED is rejected before interview', outcomeForTransition('APPLIED', 'REJECTED') === 'REJECTED_BEFORE_INTERVIEW')
check('INTERVIEW→REJECTED is rejected after interview', outcomeForTransition('INTERVIEW', 'REJECTED') === 'REJECTED_AFTER_INTERVIEW')
check('OFFER→CLOSED is offer accepted', outcomeForTransition('OFFER', 'CLOSED') === 'OFFER_ACCEPTED')
check('SAVED→CLOSED is posting closed', outcomeForTransition('SAVED', 'CLOSED') === 'POSTING_CLOSED')
check('APPLIED→CLOSED is no response', outcomeForTransition('APPLIED', 'CLOSED') === 'NO_RESPONSE')
check('SAVED→PREPARING has no outcome', outcomeForTransition('SAVED', 'PREPARING') === null)

console.log(failures === 0 ? '\nall application checks passed' : `\n${failures} check(s) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
