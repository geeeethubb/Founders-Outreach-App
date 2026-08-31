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
import { activeRunIdOf, durableOf, isActive, isRunId, isTerminal, legacyRunDetail, parseRunDetail, parseStartResponse, runJobsQuery, runResultsHref } from '../app/dashboard/jobs/run-view'
import { partialReason, runDuration, runHeadline, runJobsCountLine, runSummary, stalenessNote, statsLines, tabSafetyLine } from '../app/dashboard/jobs/run-copy'
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
check('an UNKNOWN answer is worded like the undurable one — never the reverse', tabSafetyLine(null) === tabSafetyLine(false) && tabSafetyLine(undefined) === tabSafetyLine(false))
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
