// Offline checks for the "What I'm scouting for" helpers behind the Jobs page,
// the Mission page and the Scout panel.
//
//   npx tsx scripts/test-career-ui-direction.ts
//
// No DOM, no React: only the pure functions in app/dashboard/jobs/direction.ts.

import { DEFAULT_MISSION_PREFERENCES, DEFAULT_HARD_CONSTRAINTS, renderMission, sanitizePreferences } from '../lib/career/missions/store'
import { fitJudgmentVersion } from '../lib/career/intelligence/orchestrator'
import { fitEvaluatorPrompt } from '../lib/agents/fit-evaluator'
import { directionDirty, directionPatch, NO_DIRECTION_LINE, normalizeDirection, scoutingLine } from '../app/dashboard/jobs/direction'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

console.log('normalizeDirection')
check('trims', normalizeDirection('  life sciences  ') === 'life sciences')
check('whitespace is null', normalizeDirection('   \n') === null)
check('undefined is null', normalizeDirection(undefined) === null)

console.log('directionDirty')
check('same text is clean', !directionDirty('genomics', 'genomics'))
check('trailing whitespace is clean', !directionDirty('genomics ', 'genomics'))
check('empty vs null is clean', !directionDirty('', null))
check('empty vs undefined is clean', !directionDirty('', undefined))
check('changed text is dirty', directionDirty('genomics', 'process engineering'))
check('clearing is dirty', directionDirty('', 'genomics'))

console.log('directionPatch')
const prefs = { ...DEFAULT_MISSION_PREFERENCES, industries: ['energy'], notes: 'keep me' }
const snapshot = JSON.stringify(prefs)
const patch = directionPatch('  Pivot into genomics  ')
check('sends only the direction key (the store merges it; a stale tab cannot wipe the lists)', Object.keys(patch.preferences).join(',') === 'direction')
check('trims direction', patch.preferences.direction === 'Pivot into genomics')
check('empty direction stores null', directionPatch('  ').preferences.direction === null)
check('does not touch the page preferences', JSON.stringify(prefs) === snapshot)
check('only preferences in the body', Object.keys(patch).join(',') === 'preferences')

console.log('scoutingLine')
check('null is the no-direction line', scoutingLine(null) === NO_DIRECTION_LINE)
check('blank is the no-direction line', scoutingLine('  ') === NO_DIRECTION_LINE)
check('short text is shown whole', scoutingLine('genomics research') === 'Scouting for: genomics research')
check('newlines collapse', scoutingLine('life\nsciences') === 'Scouting for: life sciences')
const long = scoutingLine('x'.repeat(300))
check('long text truncates to 140 + ellipsis', long === `Scouting for: ${'x'.repeat(140)}…`, `${long.length} chars`)
check('exactly 140 is not truncated', scoutingLine('y'.repeat(140)) === `Scouting for: ${'y'.repeat(140)}`)

console.log(failures ? `\n${failures} FAIL` : '\nPASS')
process.exit(failures ? 1 : 0)
