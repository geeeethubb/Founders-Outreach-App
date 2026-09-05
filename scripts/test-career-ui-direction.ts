// Offline checks for the pure helpers behind the Career OS screens: the
// "What I'm scouting for" input, the scout run monitor, and the Companies page.
//
//   npx tsx scripts/test-career-ui-direction.ts
//
// No DOM, no React, no network: only the pure functions in
// app/dashboard/jobs/direction.ts, app/dashboard/jobs/run-view.ts, run-copy.ts and
// app/dashboard/companies/company-view.ts. Every run payload below is a
// synthetic fixture — which is how the polling shape is verified without paying
// for a live scout.

import { DEFAULT_MISSION_PREFERENCES, DEFAULT_HARD_CONSTRAINTS, renderMission, sanitizePreferences } from '../lib/career/missions/store'
import { fitJudgmentVersion } from '../lib/career/intelligence/orchestrator'
import { fitEvaluatorPrompt } from '../lib/agents/fit-evaluator'
import { directionDirty, directionPatch, NO_DIRECTION_LINE, normalizeDirection, scoutingLine } from '../app/dashboard/jobs/direction'
import { activeRunIdOf, durableOf, isActive, isRunId, isTerminal, legacyRunDetail, LOST_CONTACT_POLL_MS, MAX_POLL_FAILURES, parseQueueActions, parseRunDetail, parseStartResponse, POLL_MS, runCancelHref, runJobsQuery, runResultsHref } from '../app/dashboard/jobs/run-view'
import { dispatchNote, partialReason, queueActionLine, queueAttemptsLine, runContinuation, runDuration, runHeadline, runJobsCountLine, runPassLine, runSummary, stalenessNote, statsLines, tabSafetyLine, workerSourceLine } from '../app/dashboard/jobs/run-copy'
import { errorCodeSentence, parseReadiness, pollVerdict, readinessBlockLine, runStopReason } from '../app/dashboard/jobs/run-reasons'
import { careersOpenRoles, groupCompanies, intentOf, mergeCompanyPatch, openRoles, originOf, type CompanyView } from '../app/dashboard/companies/company-view'

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

// ─── The scout run monitor (app/dashboard/jobs/run-view.ts) ──────────────────
//
// The panel renders nothing it did not read from GET /api/career/scout/runs/[id].
// These fixtures are the shapes that endpoint can answer, including the ones a
// half-finished run produces.

const RUN_ID = '11111111-2222-3333-4444-555555555555'

console.log('parseRunDetail')
const queued = parseRunDetail({ id: RUN_ID, status: 'queued', stage: null, counts: {}, events: [], jobs: {} })
check('a queued run parses', queued?.status === 'queued')
check('queued is active, not terminal', !!queued && isActive(queued.status) && !isTerminal(queued.status))

const running = parseRunDetail({
  run: {
    id: RUN_ID,
    status: 'running',
    stage: 'verify',
    detail: 'checking 12 postings are still open',
    counts: { discovered: 23 },
    events: [
      { at: '2026-08-30T10:00:00Z', stage: 'plan', detail: 'planned 2 strategies' },
      { at: '2026-08-30T10:01:00Z', stage: 'discover', detail: 'checked 10 companies' },
    ],
    started_at: '2026-08-30T10:00:00Z',
    heartbeat_at: '2026-08-30T10:02:00Z',
    jobs: { total: 16, inserted: 16, verified_open: 11, unverified: 5, ranked: 9 },
  },
})
check('unwraps a { run } envelope', running?.id === RUN_ID)
check('keeps the stage', running?.stage === 'verify')
check('keeps every progress event', running?.events.length === 2)
check('headline names the stage', !!running && runHeadline(running) === 'Running · verify')
check('a running run is not terminal', !!running && !isTerminal(running.status))

const succeeded = parseRunDetail({
  id: RUN_ID,
  status: 'succeeded',
  counts: { discovered: 23 },
  started_at: '2026-08-30T10:00:00Z',
  completed_at: '2026-08-30T10:04:10Z',
  jobs: { total: 16, inserted: 16, verified_open: 11, unverified: 5, ranked: 9 },
})
check(
  'the completed headline is the founder’s sentence',
  !!succeeded && runHeadline(succeeded) === 'Scout completed · 23 discovered · 16 saved · 11 verified open · 9 ranked',
  succeeded ? runHeadline(succeeded) : ''
)
check('duration comes from the run’s own timestamps', !!succeeded && runDuration(succeeded) === '4m 10s', succeeded ? runDuration(succeeded) : '')
check('a finished run has no partial reason', !!succeeded && partialReason(succeeded) === null)

const partial = parseRunDetail({
  id: RUN_ID,
  status: 'partial',
  partial: true,
  started_at: '2026-08-30T10:00:00Z',
  completed_at: '2026-08-30T10:04:30Z',
  stats: { deadline_hit: true, jobs_rejected: { season: 3, geography: 1 } },
  jobs: { total: 12, inserted: 12, verified_open: 7, unverified: 5, ranked: 4 },
})
check('the partial headline says what survived', !!partial && runHeadline(partial) === 'Partial run — 12 jobs saved, 7 verified', partial ? runHeadline(partial) : '')
check('a deadline is explained in plain English', !!partial && (partialReason(partial) ?? '').startsWith('It ran out of time'))
check('rejected comes from the stats histogram', !!partial && runSummary(partial).rejected === 4)
check('partial is terminal — polling stops', !!partial && isTerminal(partial.status))

const failed = parseRunDetail({ id: RUN_ID, status: 'failed', error: 'the ATS adapter timed out', completed_at: '2026-08-30T10:01:00Z', jobs: { total: 3, inserted: 3 } })
check('a failure names what failed', !!failed && runHeadline(failed) === 'Failed — the ATS adapter timed out')
check('the failure reason is the error itself', !!failed && partialReason(failed) === 'the ATS adapter timed out')
check('a failed run can still have results to link to', !!failed && failed.jobs.total === 3)

check('no id means nothing to poll', parseRunDetail({ status: 'running' }) === null)
check('a non-object is not a run', parseRunDetail('nope') === null)
const unknownStatus = parseRunDetail({ id: RUN_ID, status: 'weird' })
check('an unreadable status on an unfinished run stays running (never a false success)', unknownStatus?.status === 'running')
check('an unreadable status on a completed run reads as succeeded', parseRunDetail({ id: RUN_ID, status: '', completed_at: '2026-08-30T10:04:00Z' })?.status === 'succeeded')

const statsOnly = parseRunDetail({
  id: RUN_ID,
  status: 'succeeded',
  completed_at: '2026-08-30T10:04:00Z',
  stats: { jobs_inserted: 8, jobs_ranked: 5, verification: { VERIFIED_OPEN: 6, LIKELY_OPEN: 2 }, postings_seen: 14 },
})
check('counts fall back to the run’s stats when `jobs` is absent', statsOnly?.jobs.inserted === 8 && statsOnly?.jobs.verified_open === 6)
check('discovered falls back to postings seen', !!statsOnly && runSummary(statsOnly).discovered === 14)
check('likely open is its own count, not folded into unverified', statsOnly?.jobs.likely_open === 2, String(statsOnly?.jobs.likely_open))
// 8 touched − 6 verified − 2 likely − 0 closed: the parts never exceed the whole.
check('unverified is what is left after every status the run reported', !!statsOnly && runSummary(statsOnly).unverified === 0, String(statsOnly?.jobs.unverified))

// The endpoint's own counts always win over the derivation above.
const counted = parseRunDetail({
  id: RUN_ID,
  status: 'succeeded',
  completed_at: '2026-08-30T10:04:00Z',
  jobs: { total: 20, inserted: 18, verified_open: 9, likely_open: 4, unverified: 5, closed: 2, ranked: 12 },
})
check('the endpoint’s likely_open and closed are read verbatim', counted?.jobs.likely_open === 4 && counted?.jobs.closed === 2)
check('a reported unverified is never re-derived', counted?.jobs.unverified === 5)
check('a payload with no verification breakdown reports zero, not a guess', succeeded?.jobs.likely_open === 0 && succeeded?.jobs.closed === 0)
check('unverified is never negative when the parts exceed the whole', parseRunDetail({ id: RUN_ID, status: 'running', jobs: { total: 1, verified_open: 5, likely_open: 5 } })?.jobs.unverified === 0)

console.log('staleness')
const quiet = parseRunDetail({ id: RUN_ID, status: 'running', started_at: '2026-08-30T10:00:00Z', heartbeat_at: '2026-08-30T10:00:30Z' })
const NOW = Date.parse('2026-08-30T10:06:00Z')
check('a quiet run warns with how long it has been quiet', (stalenessNote(quiet!, NOW) ?? '').includes('5m'), stalenessNote(quiet!, NOW) ?? '')
check('a fresh heartbeat does not warn', stalenessNote(quiet!, Date.parse('2026-08-30T10:01:00Z')) === null)
check('a finished run never warns about heartbeats', stalenessNote(succeeded!, NOW) === null)

console.log('parseStartResponse')
const started = parseStartResponse({ runId: RUN_ID, status: 'queued' }, 202)
check('202 + runId is a durable run to poll', started.queued && started.runId === RUN_ID && !started.legacy)
const sync = parseStartResponse({ runId: RUN_ID, stats: { jobs_inserted: 4 }, jobs: [], errors: [], costUsd: 0.4, latencyMs: 1000 }, 200)
check('a synchronous 200 answer is not polled (pre-016 database)', !sync.queued && sync.legacy)
check('no runId at all is not queued', !parseStartResponse({ error: 'boom' }, 500).queued)

const legacy = legacyRunDetail({ runId: RUN_ID, stats: { deadline_hit: true, jobs_inserted: 6, jobs_ranked: 2, verification: { VERIFIED_OPEN: 4 } }, jobs: [1, 2, 3, 4, 5, 6], errors: [], latencyMs: 90_000 })
check('a synchronous run that hit its deadline reads as partial', legacy?.status === 'partial')
check('a synchronous run keeps its counts', legacy?.jobs.inserted === 6 && legacy?.jobs.verified_open === 4)
check('a synchronous run is terminal', !!legacy && isTerminal(legacy.status))

console.log('statsLines')
check('an empty stats blob still renders its zeroed lines rather than throwing', statsLines({}).length === 5)
check('a null stats blob renders nothing', statsLines(null).length === 0)
check('a partial stats blob does not throw on a missing histogram', statsLines({ jobs_inserted: 3 }).some((l) => l.includes('persisted: 3 new')))

console.log('run links')
check('the results link is the run view', runResultsHref(RUN_ID) === `/dashboard/jobs?run=${RUN_ID}`)
check('a real run id is linkable', isRunId(RUN_ID))
check('a synchronous run with no id is NOT linked to a page that cannot answer', !isRunId('legacy') && !isRunId(null))
check('the jobs query names the run and nothing else', runJobsQuery(RUN_ID, 200) === `run=${RUN_ID}&limit=200`)

console.log('runJobsCountLine')
check('a run that fits on one page just says how many', runJobsCountLine(16, 16) === '16 jobs from this run')
check('one job is singular', runJobsCountLine(1, 1) === '1 job from this run')
check(
  'a truncated page says so instead of contradicting the header count',
  runJobsCountLine(200, 340) === 'Showing 200 of 340 jobs this run touched — best fit first',
  runJobsCountLine(200, 340)
)

// ─── Is the run detached from this request? ──────────────────────────────────
//
// The sentence "you can close this tab" is true only after migration 016. On
// the founder's database today the scout still runs inside the POST, so the
// wording must default to the safe answer whenever the server has not said.

console.log('durableOf / tabSafetyLine')
check('the server saying durable is believed', durableOf({ durable: true, active: null }) === true)
check('the server saying NOT durable is believed', durableOf({ durable: false }) === false)
check('a missing answer is unknown, not a promise', durableOf({ runs: [] }) === null && durableOf(null) === null)
check('a durable run is the only case that says the tab can be closed', tabSafetyLine(true) === 'The run happens on the server — you can close this tab.')
check('an undurable run tells the founder to keep the tab open', tabSafetyLine(false).includes('keep the tab open'))
// Defect 7: an unknown answer used to be worded like the pre-016 one, which told a
// founder on a migrated database that migration 016 was missing on every load.
check('an UNKNOWN answer says the check is still running — not that 016 is missing', tabSafetyLine(null) === 'Checking whether runs survive this request…' && tabSafetyLine(undefined) === tabSafetyLine(null))
check('an unknown answer never claims a migration is missing', !/016|migration/.test(tabSafetyLine(null)))
check('an unknown answer never promises the tab can be closed', !/close this tab/.test(tabSafetyLine(null)))
check('a 202 is durable by definition', parseStartResponse({ runId: RUN_ID, status: 'queued' }, 202).durable === true)
check('the synchronous answer carries durable:false through', parseStartResponse({ durable: false, stats: {}, jobs: [] }, 200).durable === false)

console.log('activeRunIdOf')
check('a queued run is resumed', activeRunIdOf({ active: { id: RUN_ID, status: 'queued' } }) === RUN_ID)
check('a running run is resumed', activeRunIdOf({ active: { id: RUN_ID, status: 'running' } }) === RUN_ID)
check('a finished run is not resumed', activeRunIdOf({ active: { id: RUN_ID, status: 'succeeded' } }) === null)
check(
  'a STALLED run is not resumed — the runs route already decided it is dead',
  activeRunIdOf({ active: { id: RUN_ID, status: 'stalled' } }) === null
)
check(
  'the runs list is never mined for an active run (its status is a display value)',
  activeRunIdOf({ durable: false, active: null, runs: [{ id: RUN_ID, kind: 'job_scout', status: 'stalled', persisted_status: 'running' }] }) === null
)
check('no active run means nothing to resume', activeRunIdOf({ active: null, runs: [] }) === null && activeRunIdOf(null) === null)
check('a non-uuid id is never polled', activeRunIdOf({ active: { id: 'legacy', status: 'running' } }) === null)

// ─── The monitor tells the truth (run-view.ts, run-copy.ts, run-reasons.ts) ──
//
// Each block below is one release blocker from the reliability pass. The
// fixtures are the shapes the routes answer TODAY — the 202 with its dispatch
// report, the 409 with the run already going, a row carrying an error code.

console.log('1. the 202 body’s dispatch report is read')
const twoOhTwo = parseStartResponse(
  { runId: RUN_ID, status: 'queued', durable: true, claimed: false, claimInMs: null, dispatch: { outcome: 'failed', status: 401, error: 'HTTP 401 with an HTML page', attempt: 2 }, workerBase: { source: 'env:VERCEL_URL+bypass', baseUrl: 'https://x.vercel.app' } },
  202
)
check('the dispatch outcome, status, error and attempt come through', twoOhTwo.dispatch?.outcome === 'failed' && twoOhTwo.dispatch.status === 401 && twoOhTwo.dispatch.error === 'HTTP 401 with an HTML page' && twoOhTwo.dispatch.attempt === 2)
check('the worker source comes through', twoOhTwo.workerBase?.source === 'env:VERCEL_URL+bypass' && twoOhTwo.workerBase.baseUrl === 'https://x.vercel.app')
check('claimed and claimInMs come through', twoOhTwo.claimed === false && twoOhTwo.claimInMs === null)
check('a failed dispatch is a sentence with its error', (dispatchNote(twoOhTwo.dispatch) ?? '').includes('HTTP 401') && (dispatchNote(twoOhTwo.dispatch) ?? '').includes('HTML page'), dispatchNote(twoOhTwo.dispatch) ?? '')
const claimedFast = parseStartResponse({ runId: RUN_ID, status: 'running', claimed: true, claimInMs: 812.4, dispatch: { outcome: 'pending', status: null, error: null, attempt: 1 }, workerBase: { source: 'env:SCOUT_WORKER_BASE_URL', baseUrl: 'https://prod.example' } }, 202)
check('a claimed run keeps how long the claim took', claimedFast.claimed && claimedFast.claimInMs === 812)
check('a pending dispatch is not a warning (the worker answers at the end of its leg)', dispatchNote(claimedFast.dispatch) === null)
check('the worker note names the source and the address', workerSourceLine(claimedFast.workerBase) === 'worker: env:SCOUT_WORKER_BASE_URL → https://prod.example')
check('a 202 with no dispatch report has none, not a guess', parseStartResponse({ runId: RUN_ID, status: 'queued' }, 202).dispatch === null && parseStartResponse({ runId: RUN_ID, status: 'queued' }, 202).workerBase === null)

console.log('2. a 409 alreadyActive attaches to the run already going')
const conflict = parseStartResponse(
  { error: 'A scout run is already running. Watch it, or cancel it to start another.', code: 'CONFLICT', retryable: false, runId: RUN_ID, status: 'running', alreadyActive: true, durable: true, run: { id: RUN_ID, kind: 'job_scout', status: 'running', stage: 'discover', invocation: 2, attempts: 1, resumable: false, cancel_requested: false, jobs: { total: 4 } } },
  409
)
check('the 409 is recognised as already active, not as queued and not as a legacy result', conflict.alreadyActive && !conflict.queued && !conflict.legacy)
check('it attaches to body.run.id', conflict.runId === RUN_ID && conflict.run?.id === RUN_ID)
check('the run already going is parsed so the monitor can render it at once', conflict.run?.status === 'running' && conflict.run.stage === 'discover' && conflict.run.invocation === 2)
check('an already-going run is durable by definition', conflict.durable === true)
const conflictNoRun = parseStartResponse({ error: 'already', code: 'CONFLICT', runId: RUN_ID, alreadyActive: true }, 409)
check('a 409 without the run object still attaches by runId', conflictNoRun.alreadyActive && conflictNoRun.runId === RUN_ID && conflictNoRun.run === null)
check('a 409 that is not alreadyActive (e.g. nothing left to continue) does not attach', !parseStartResponse({ error: 'that run finished every stage', code: 'CONFLICT', runId: RUN_ID }, 409).alreadyActive)
const refused = parseStartResponse({ error: 'Scouting could not start: the app could not reach its own worker (HTTP 401).', code: 'DISPATCH', retryable: true, runId: RUN_ID, remedy: 'Enable Protection Bypass.' }, 503)
check('a 503 refusal is neither queued, legacy nor already active — but names the row it closed', !refused.queued && !refused.legacy && !refused.alreadyActive && refused.runId === RUN_ID)

console.log('RunDetail carries the reliability fields, parsed defensively')
const full = parseRunDetail({ run: { id: RUN_ID, kind: 'job_scout', status: 'failed', error: 'x', error_code: 'dispatch', remedy: 'do y', invocation: '3', attempts: 2, resumable: true, cancel_requested: true } })
check('error_code is upper-cased, remedy and kind are kept', full?.error_code === 'DISPATCH' && full.remedy === 'do y' && full.kind === 'job_scout')
check('invocation and attempts are counts', full?.invocation === 3 && full.attempts === 2)
check('resumable and cancel_requested are booleans', full?.resumable === true && full.cancel_requested === true)
const bare = parseRunDetail({ id: RUN_ID, status: 'running' })
check('absent fields: no code, no remedy, pass 1, no attempts, resumable UNKNOWN (null), not cancelling', bare?.error_code === null && bare.remedy === null && bare.invocation === 1 && bare.attempts === 0 && bare.resumable === null && bare.cancel_requested === false)
check('a resumable that is not a boolean is unknown, never true', parseRunDetail({ id: RUN_ID, status: 'partial', resumable: 'yes' })?.resumable === null)
check('a negative invocation is still pass 1', parseRunDetail({ id: RUN_ID, status: 'running', invocation: -4 })?.invocation === 1)

console.log('4. Continue this run follows run.resumable, the server’s judgement')
const reaped = parseRunDetail({ id: RUN_ID, status: 'partial', error_code: 'PLATFORM_KILL', resumable: true, stats: {}, jobs: { total: 3, inserted: 3 } })
check('a reaped run with no discovery report is offered when the server says its cursor has work left', !!reaped && runContinuation(reaped).canContinue)
check('and says it stopped before finishing', !!reaped && runContinuation(reaped).note === 'It stopped before finishing; continuing picks up from what it saved.')
const budgetRun = parseRunDetail({ id: RUN_ID, status: 'partial', resumable: true, stats: { discovery: { stopped: 'budget', cursor: { stages: ['plan'] } } } })
check('the existing spend-limit note is kept when the report has a stopping reason', !!budgetRun && (runContinuation(budgetRun).note ?? '').includes('spend limit'))
const serverSaysNo = parseRunDetail({ id: RUN_ID, status: 'partial', resumable: false, stats: { discovery: { stopped: 'deadline', cursor: { stages: ['plan'] } } } })
check('the server saying NOT resumable wins over a report that looks continuable', !!serverSaysNo && !runContinuation(serverSaysNo).canContinue)
const succeededResumable = parseRunDetail({ id: RUN_ID, status: 'succeeded', resumable: true, completed_at: '2026-08-30T10:04:00Z' })
check('a finished run is never offered a second pass', !!succeededResumable && !runContinuation(succeededResumable).canContinue)
const unknownResumable = parseRunDetail({ id: RUN_ID, status: 'partial', stats: { discovery: { stopped: 'deadline', cursor: { stages: ['plan'] } } } })
check('when the server did not say, the discovery report decides as before', !!unknownResumable && runContinuation(unknownResumable).canContinue)
check('when the server did not say and there is no report, nothing is offered', !runContinuation(parseRunDetail({ id: RUN_ID, status: 'partial' })!).canContinue)

console.log('5. partialReason prefers the row’s error code and remedy')
const codes: [string, RegExp][] = [
  ['RUN_DEADLINE', /ran out of time/],
  ['PLATFORM_KILL', /hosting platform ended the worker/],
  ['DISPATCH', /could not reach its own worker/],
  ['PROVIDER_TIMEOUT', /too slow to answer/],
  ['PROVIDER_RATE_LIMIT', /rate-limited/],
  ['CANCELLED', /was cancelled/],
  ['SCHEMA_MIGRATION', /missing a migration/],
  ['CONFIGURATION', /missing configuration/],
]
for (const [code, re] of codes) check(`${code} maps to a sentence`, re.test(errorCodeSentence(code) ?? ''), errorCodeSentence(code) ?? 'null')
check('an unmapped code has no sentence of its own', errorCodeSentence('INTERNAL') === null && errorCodeSentence(null) === null)
const coded = parseRunDetail({ id: RUN_ID, status: 'partial', error: 'run deadline passed in discover', error_code: 'RUN_DEADLINE', remedy: 'Continue the run to pick up where it stopped.', stats: { deadline_hit: false } })
check('the code’s sentence beats the raw error text', !!coded && (partialReason(coded) ?? '').startsWith('It ran out of time'), coded ? partialReason(coded) ?? '' : '')
const codedReason = coded ? runStopReason(coded) : null
check('the raw error is kept as a detail line', codedReason?.detail === 'run deadline passed in discover')
check('the remedy is its own line', codedReason?.remedy === 'Continue the run to pick up where it stopped.')
const dispatchFailed = parseRunDetail({ id: RUN_ID, status: 'failed', error: 'Scouting could not start: the app could not reach its own worker (HTTP 401).', error_code: 'DISPATCH', remedy: 'Enable Protection Bypass for Automation.' })
check('a DISPATCH failure explains itself and carries its fix', !!dispatchFailed && (partialReason(dispatchFailed) ?? '').includes('could not reach its own worker') && runStopReason(dispatchFailed)?.remedy === 'Enable Protection Bypass for Automation.')
const unmapped = parseRunDetail({ id: RUN_ID, status: 'failed', error: 'boom', error_code: 'INTERNAL' })
check('an unmapped code falls back to the error text', !!unmapped && partialReason(unmapped) === 'boom')
check('an unmapped code with no error text still names the code', partialReason(parseRunDetail({ id: RUN_ID, status: 'failed', error_code: 'DATABASE' })!) === 'The run stopped with DATABASE.')
check('a run that recorded no code keeps the old fallbacks (the error text)', !!failed && partialReason(failed) === 'the ATS adapter timed out')
check('a finished run still has no reason', !!succeeded && runStopReason(succeeded) === null)
const cancelledRun = parseRunDetail({ id: RUN_ID, status: 'cancelled', error_code: 'CANCELLED' })
check('a cancelled run says so, with no remedy', !!cancelledRun && partialReason(cancelledRun) === 'The run was cancelled.' && runStopReason(cancelledRun)?.remedy === null)

console.log('6. the poll verdict')
const base = { error: 'HTTP 500', maxFailures: MAX_POLL_FAILURES, pollMs: POLL_MS, lostContactPollMs: LOST_CONTACT_POLL_MS }
check('one miss is silent and polls again at the normal rate', pollVerdict({ ...base, status: 500, failures: 1 }).message === null && pollVerdict({ ...base, status: 500, failures: 1 }).nextMs === POLL_MS && !pollVerdict({ ...base, status: 500, failures: 1 }).stop)
const lost = pollVerdict({ ...base, status: 502, failures: MAX_POLL_FAILURES, error: 'gateway' })
check('five misses say lost contact, with the error, and keep polling at 10s', !lost.stop && lost.nextMs === 10_000 && lost.message === 'Lost contact (gateway). The run keeps going on the server; reload to pick it up.', lost.message ?? '')
const signedOut = pollVerdict({ ...base, status: 401, failures: 1 })
check('a 401 stops the poll and says sign in again', signedOut.stop && /sign in again/i.test(signedOut.message ?? ''))
const gone = pollVerdict({ ...base, status: 404, failures: 1 })
check('a 404 stops the poll and says not found', gone.stop && /no such run/.test(gone.message ?? ''))
check('the cancel URL sits under the run', runCancelHref(RUN_ID) === `/api/career/scout/runs/${RUN_ID}/cancel`)

console.log('9. queue actions, passes and attempts')
const actions = parseQueueActions({ run: { id: RUN_ID }, queueActions: [{ runId: RUN_ID, action: 'redispatched', waitedMs: 31_000, attempt: 2, message: 'queued for 31s; asking a worker again' }, { action: 'failed', attempt: 2, message: 'Scouting could not start: HTTP 401' }, 'nope', { message: 'no action' }] })
check('only well-formed actions are read', actions.length === 2 && actions[0].attempt === 2 && actions[0].waitedMs === 31_000)
check('a redispatch reads as asking a worker again with its attempt', queueActionLine(actions[0]) === 'asking a worker again (attempt 2)', queueActionLine(actions[0]))
check('a queue failure names its reason', queueActionLine(actions[1]) === 'closed as failed (attempt 2): Scouting could not start: HTTP 401')
check('a poll with no actions reads as none', parseQueueActions({ run: { id: RUN_ID } }).length === 0 && parseQueueActions(null).length === 0)
const secondPass = parseRunDetail({ id: RUN_ID, status: 'running', invocation: 2 })
check('a later leg reads as pass N', !!secondPass && runPassLine(secondPass) === 'pass 2' && runPassLine(bare!) === null)
const queuedTwice = parseRunDetail({ id: RUN_ID, status: 'queued', attempts: 2 })
check('attempts show while queued', !!queuedTwice && queueAttemptsLine(queuedTwice) === 'worker asked 2 times')
check('attempts are not shown once running', queueAttemptsLine(secondPass!) === null)

console.log('10. the queued headline is the row’s own detail')
const queuedDetail = parseRunDetail({ id: RUN_ID, status: 'queued', detail: 'asked a worker; waiting for it to claim the run' })
check('run.detail leads when present', !!queuedDetail && runHeadline(queuedDetail) === 'Queued — asked a worker; waiting for it to claim the run', queuedDetail ? runHeadline(queuedDetail) : '')
check('the generic text stays when there is none', !!queued && runHeadline(queued) === 'Queued — waiting for the worker to pick it up')

console.log('3. readiness')
const notReady = parseReadiness({ ready: false, people: { ready: true, reason: null, remedy: null, code: null, warnings: [] }, jobs: { ready: false, reason: 'The scouting worker at https://x did not answer: HTTP 401.', remedy: 'Enable Protection Bypass for Automation.', code: 'DISPATCH', warnings: ['CRON_SECRET is not set'] }, worker: { source: 'env:VERCEL_URL+bypass', baseUrl: 'https://x' } })
check('a blocked kind is read with its reason, remedy and code', notReady.known && notReady.ready === false && notReady.code === 'DISPATCH' && notReady.warnings.length === 1 && notReady.worker?.source === 'env:VERCEL_URL+bypass')
check('the block line is "Scouting is unavailable: <reason> — Fix: <remedy>"', readinessBlockLine(notReady) === 'Scouting is unavailable: The scouting worker at https://x did not answer: HTTP 401. — Fix: Enable Protection Bypass for Automation.')
check('the other kind is its own verdict', parseReadiness({ people: { ready: true, warnings: ['APOLLO_API_KEY is not set'] }, jobs: { ready: false } }, 'people').ready === true)
const noVerdict = parseReadiness({ error: 'boom' })
check('a body without a verdict is unknown — neither ready nor blocked', !noVerdict.known && noVerdict.ready === null && readinessBlockLine(noVerdict) === null)
check('a ready kind has no block line', readinessBlockLine(parseReadiness({ jobs: { ready: true, warnings: [] } })) === null)

// ─── The Companies page (app/dashboard/companies/company-view.ts) ────────────

function company(over: Partial<CompanyView> & { name: string; id: string }): CompanyView {
  return {
    domain: null,
    website_url: null,
    careers_url: null,
    ats_type: null,
    ats_identifier: null,
    watch_status: 'suggested',
    watch_priority: null,
    watch_note: null,
    watch_source: null,
    last_careers_check_at: null,
    careers_check_note: null,
    company_type: null,
    industry_tags: null,
    jobs_total: 0,
    open_internships: 0,
    ...over,
  }
}

console.log('intentOf / originOf / openRoles')
check("a legacy 'opening_available' row reads as watching, never as a target", intentOf(company({ id: '1', name: 'A', watch_status: 'opening_available' })) === 'watching')
check('an unreadable status is a suggestion, never a preference', intentOf(company({ id: '1', name: 'A', watch_status: 'nonsense' })) === 'suggested')
check('a null status is a suggestion', intentOf(company({ id: '1', name: 'A', watch_status: null })) === 'suggested')
check('origin prefers watch_origin', originOf(company({ id: '1', name: 'A', watch_origin: 'scout', watch_source: 'user' })) === 'scout')
check('origin falls back to watch_source before 016 is applied', originOf(company({ id: '1', name: 'A', watch_source: 'planner' })) === 'planner')
check('a row with no origin at all is treated as the user’s', originOf(company({ id: '1', name: 'A', watch_status: 'target' })) === 'user')
check('openings read from either column', openRoles(company({ id: '1', name: 'A', open_roles_count: 0, open_internships: 3 })) === 3)
check('but only a careers check counts as a CONFIRMED opening', careersOpenRoles(company({ id: '1', name: 'A', open_roles_count: 0, open_internships: 3 })) === 0)
check('a careers check count is a confirmed opening', careersOpenRoles(company({ id: '1', name: 'A', open_roles_count: 2, open_internships: 0 })) === 2)

console.log('groupCompanies')
const watchlist: CompanyView[] = [
  company({ id: 'a', name: 'Alpha', watch_status: 'suggested', watch_priority: 10, watch_origin: 'planner' }),
  company({ id: 'b', name: 'Bravo', watch_status: 'target', watch_priority: 90, watch_origin: 'user' }),
  company({ id: 'c', name: 'Charlie', watch_status: 'watching', watch_priority: 60, watch_origin: 'user' }),
  company({ id: 'd', name: 'Delta', watch_status: 'suggested', watch_priority: 80, watch_origin: 'scout', open_roles_count: 2 }),
  company({ id: 'e', name: 'Echo', watch_status: 'ignored', watch_priority: 95, watch_origin: 'user', open_roles_count: 4 }),
  company({ id: 'f', name: 'Foxtrot', watch_status: 'suggested', watch_priority: 70, watch_origin: 'scout' }),
]
const sections = groupCompanies(watchlist)
const byKey = Object.fromEntries(sections.map((s) => [s.key, s]))
check('the sections are in the founder’s order', sections.map((s) => s.key).join(',') === 'opening,target,watching,suggested,ignored')
check('an opening is state — it outranks the intent for placement', byKey.opening.rows.map((c) => c.id).join(',') === 'd')
check('an ignored company never appears under openings', !byKey.opening.rows.some((c) => c.id === 'e'))
check('an ignored company is kept so it can be undone', byKey.ignored.rows.map((c) => c.id).join(',') === 'e')
check(
  'the ignored section offers the undo the list route can actually deliver (it returns ignored rows unless asked not to)',
  byKey.ignored.hint.includes('promote one to bring it back'),
  byKey.ignored.hint
)
check('targets hold only the user’s own targets', byKey.target.rows.map((c) => c.id).join(',') === 'b')
check('explore holds the scout’s guesses', byKey.suggested.rows.map((c) => c.id).join(',') === 'f,a', byKey.suggested.rows.map((c) => c.id).join(','))
check('PRIORITY SORTS DESCENDING — the same direction as the store and the scout', byKey.suggested.rows[0].name === 'Foxtrot', byKey.suggested.rows.map((c) => `${c.name}:${c.watch_priority}`).join(' '))
check('every company lands in exactly one section', sections.reduce((n, s) => n + s.rows.length, 0) === watchlist.length)
check('explore is collapsible, the user’s own sections are not', byKey.suggested.collapsible && !byKey.target.collapsible)
check('explore says it is not a preference yet', byKey.suggested.hint.includes('not preferences until you say so'))

// The live database has no open_roles_count until migration 016 is applied, and
// nearly every scout-discovered company has a stored posting. Sectioning on that
// buried the founder's own targets under the whole Explore list.
const pre016 = groupCompanies([
  company({ id: 't', name: 'Target Co', watch_status: 'target', watch_priority: 100, watch_origin: 'user' }),
  company({ id: 's', name: 'Suggested Co', watch_status: 'suggested', watch_priority: 1, watch_origin: 'scout', open_internships: 1 }),
])
const pre016Sections = pre016.filter((s) => s.rows.length > 0)
check(
  'a stored posting does NOT lift a suggestion above the user’s own targets',
  pre016Sections[0].key === 'target' && pre016Sections[0].rows[0].id === 't',
  pre016Sections.map((s) => `${s.key}:${s.rows.map((r) => r.id).join('/')}`).join(' ')
)
check('before 016 the opening section is simply empty, not wrong', pre016[0].rows.length === 0)

const neverChecked = groupCompanies([
  company({ id: 'x', name: 'Xray', watch_status: 'suggested', watch_priority: 50, last_careers_check_at: '2026-08-29T00:00:00Z' }),
  company({ id: 'y', name: 'Yankee', watch_status: 'suggested', watch_priority: 50 }),
])
check('at equal priority, a never-checked company comes first', neverChecked[3].rows[0].id === 'y')

console.log('mergeCompanyPatch')
const held = company({ id: 'z', name: 'Zulu', watch_status: 'suggested', watch_origin: 'scout', jobs_total: 9, open_internships: 3, open_roles_count: 3 })
const promoted = mergeCompanyPatch(held, { id: 'z', name: 'Zulu', watch_status: 'target', watch_source: 'user', watch_origin: 'scout', intent: 'target', origin: 'scout', jobs_total: 0 })
check('a promotion takes the server’s intent', intentOf(promoted) === 'target')
check('a promotion does not erase how the company was found', originOf(promoted) === 'scout')
check('a promotion never blanks the page’s counts', promoted.jobs_total === 9 && openRoles(promoted) === 3)
check('an empty answer changes nothing', mergeCompanyPatch(held, null).watch_status === 'suggested')

console.log(failures ? `\n${failures} FAIL` : '\nPASS')
process.exit(failures ? 1 : 0)
