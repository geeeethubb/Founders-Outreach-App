// The Scout page's pure half, offline: every shape the run endpoints can
// answer is a fixture here, and the page's decisions — when to ask for the
// result payload, what a failed poll means, what a finished run says — are
// checked without a browser, a server or a key.
//
//   npx tsx scripts/test-scout-page-view.ts

import {
  describePollFailure,
  isActive,
  isTerminal,
  MAX_POLL_FAILURES,
  nextPollDelayMs,
  parseFormPrefs,
  parsePeopleReadiness,
  parseRunDetail,
  parseRunsList,
  parseStartResponse,
  POLL_MS,
  RESULT_EVERY_N_POLLS,
  runCancelHref,
  runDetailHref,
  shouldRequestResult,
  SLOW_POLL_MS,
  type ScoutFormPrefs,
} from '../app/dashboard/scout/scout-run-view'
import { parseScoutResult } from '../app/dashboard/scout/scout-result-view'
import { costSoFar, countPairs, eventLine, queuedLine, relativeTime, runElapsed, runHeadline, stalenessNote, terminalNotice } from '../app/dashboard/scout/scout-run-copy'

let passed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failures.push(`${name} — ${detail}`)
    console.log(`  FAIL ${name} — ${detail}`)
  }
}

const RUN_ID = '0b8e6d2a-5c1f-4a7e-9b3d-2f6a8c4e1d90'
const NOW = Date.parse('2026-09-04T12:00:00Z')

const resultFixture = {
  v: 1,
  runId: RUN_ID,
  searchMode: 'internal_first',
  backgroundSource: { source: 'bank', items: 14, warning: null },
  internal: { headline: 'Your network has 2 strong matches', decision: 'EXTERNAL_DISCOVERY_NEEDED', reasons: ['only 2 of 8'], strongCount: 2, targetCount: 8, indexed: 120, classified: 118, poolAssessment: 'thin', missingProfile: ['process engineers'], searches: [{ query: 'industrial ai', matches: 12, shown: 6 }] },
  funnel: { companiesValidated: 5, peopleEnriched: 12, peopleResearched: 6, peopleReused: 2 },
  prospects: [
    { key: 'p1', name: 'Ada Example', title: 'VP Ops', company: 'Acme', location: 'Ohio', email: 'ada@acme.example', emailStatus: 'verified', linkedin: null, score: 82, recommendation: 'STRONG', source: 'new', contactId: null, relationshipStatus: null, approach: null, internalReason: null, whyCompany: 'fits', whyThem: 'runs plants', whyYou: 'you built the thing', backgroundIds: ['exp_1'], risks: '', researchSummary: 'dossier', components: [{ dimension: 'role_fit', normalized: 0.9, points: 27, max: 30, explanation: 'good' }] },
    { name: 'No Key Person', company: 'Beta', score: '40', recommendation: 'ODD', source: 'weird' },
    'not a prospect',
  ],
  unranked: [{ key: 'u1', name: 'Bo Unranked', title: null, company: 'Gamma', linkedin: null, email: null, researchSummary: 'partial dossier', verdict: 'GOOD_TARGET', reason: 'not_ranked' }],
  usage: { costUsd: 1.2345, apolloCredits: 3, apolloCallsAvoided: 2, webSearches: 4, modelCalls: 20, latencyMs: 250_000, byAgent: { research: { calls: 6, costUsd: 0.9, webSearches: 4 } } },
  errors: ['one dossier timed out'],
  stages: ['strategy', 'internal', 'discovery'],
  complete: false,
  updated_at: '2026-09-04T11:58:00Z',
}

const runningRow = {
  id: RUN_ID,
  kind: 'outreach',
  status: 'running',
  stage: 'research',
  detail: '3/6 person dossiers',
  counts: { ranked: 0, companies: 5, people: 12, researched: 3, extra_thing: 1 },
  events: [
    { at: '2026-09-04T11:50:00Z', stage: 'strategy', detail: '2 segments' },
    { at: '2026-09-04T11:52:00Z', stage: 'research', detail: '3/6 person dossiers' },
    'a bare string event',
    42,
  ],
  label: 'people scout',
  started_at: '2026-09-04T11:49:30Z',
  heartbeat_at: '2026-09-04T11:59:40Z',
  completed_at: null,
  deadline_at: '2026-09-04T11:54:30Z',
  run_deadline_at: '2026-09-04T12:29:30Z',
  stats: { cost_usd: 0.8, stopped: null },
  error: null,
  error_code: null,
  remedy: null,
  jobs: { total: 0 },
  active: true,
  partial: false,
  stale: false,
  invocation: 2,
  attempts: 1,
  resumable: true,
  cancel_requested: false,
  result: null,
}

console.log('\nparseRunDetail')
{
  const bare = parseRunDetail(runningRow)
  check('bare row parses', !!bare && bare.id === RUN_ID && bare.status === 'running')
  check('wrapped { run, queueActions } parses to the same run', parseRunDetail({ run: runningRow, queueActions: [] })?.id === RUN_ID)
  check('no id → null', parseRunDetail({ status: 'running' }) === null && parseRunDetail(null) === null && parseRunDetail('x') === null)
  check('result absent → null result', bare?.result === null)
  check('stage and detail are read', bare?.stage === 'research' && bare?.detail === '3/6 person dossiers')
  check('events keep objects and strings, drop numbers', bare?.events.length === 3 && bare?.events[2].detail === 'a bare string event')
  check('invocation and attempts', bare?.invocation === 2 && bare?.attempts === 1)
  check('invocation floors at 1 and attempts at 0', parseRunDetail({ id: RUN_ID, status: 'queued', invocation: -3, attempts: 'x' })?.invocation === 1 && parseRunDetail({ id: RUN_ID, status: 'queued', attempts: -1 })?.attempts === 0)
  check('stats object kept, cost readable', bare?.stats?.cost_usd === 0.8)
  const withResult = parseRunDetail({ run: { ...runningRow, result: resultFixture } })
  check('result present → parsed', !!withResult?.result && withResult.result.prospects.length === 2)
  check('malformed prospect is dropped, partial one is defaulted', withResult?.result?.prospects[1].name === 'No Key Person' && withResult?.result?.prospects[1].recommendation === 'WEAK' && withResult?.result?.prospects[1].source === 'new' && withResult?.result?.prospects[1].score === 40)
  check('unranked list parsed', withResult?.result?.unranked.length === 1 && withResult?.result?.unranked[0].reason === 'not_ranked')
  check('funnel defaults the keys the payload lacks', withResult?.result?.funnel.companiesValidated === 5 && withResult?.result?.funnel.stubsFound === 0)
  check('usage numbers and byAgent', withResult?.result?.usage.costUsd === 1.2345 && withResult?.result?.usage.byAgent.research?.calls === 6)
  check('internal decision parsed', withResult?.result?.internal?.decision === 'EXTERNAL_DISCOVERY_NEEDED' && withResult?.result?.internal?.searches[0].matches === 12)
  check('unknown status while unfinished → running', parseRunDetail({ id: RUN_ID, status: 'weird' })?.status === 'running')
  check('unknown status when finished → failed, never succeeded', parseRunDetail({ id: RUN_ID, status: 'weird', completed_at: '2026-09-04T11:00:00Z' })?.status === 'failed')
  check('partial status implies partial flag', parseRunDetail({ id: RUN_ID, status: 'partial' })?.partial === true)
  check('error_code and remedy are read', parseRunDetail({ id: RUN_ID, status: 'failed', error_code: 'PLATFORM_KILL', remedy: 'check the plan' })?.error_code === 'PLATFORM_KILL')
}

console.log('\nparseScoutResult')
{
  check('non-object → null', parseScoutResult(null) === null && parseScoutResult('x') === null)
  check('no prospects array → null', parseScoutResult({ v: 1, usage: {} }) === null)
  const minimal = parseScoutResult({ prospects: [] })
  check('minimal payload is fully defaulted', !!minimal && minimal.unranked.length === 0 && minimal.errors.length === 0 && minimal.internal === null && minimal.backgroundSource === null && minimal.usage.costUsd === 0 && minimal.complete === false)
  check('fixture background source', parseScoutResult(resultFixture)?.backgroundSource?.source === 'bank')
  check('non-bank source reads as fixture', parseScoutResult({ prospects: [], backgroundSource: { source: 'other', items: 0, warning: 'w' } })?.backgroundSource?.source === 'fixture')
}

console.log('\nterminal detection')
{
  check('succeeded/partial/failed/cancelled are terminal', isTerminal('succeeded') && isTerminal('partial') && isTerminal('failed') && isTerminal('cancelled'))
  check('queued/running are active, not terminal', isActive('queued') && isActive('running') && !isTerminal('queued') && !isTerminal('running'))
  check('null is neither', !isTerminal(null) && !isActive(null))
}

console.log('\nshouldRequestResult (poll cadence)')
{
  const active = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => shouldRequestResult(i, 'running'))
  check(`every ${RESULT_EVERY_N_POLLS}th poll asks for the result while running`, JSON.stringify(active) === JSON.stringify([false, false, false, true, false, false, false, true]), JSON.stringify(active))
  check('status unknown (first poll) does not ask', shouldRequestResult(1, null) === false)
  check('a terminal known status always asks', shouldRequestResult(1, 'succeeded') && shouldRequestResult(2, 'partial') && shouldRequestResult(3, 'failed') && shouldRequestResult(5, 'cancelled'))
  check('queued never asks off-cadence', shouldRequestResult(3, 'queued') === false && shouldRequestResult(4, 'queued') === true)
}

console.log('\nnextPollDelayMs')
{
  check('healthy → 3s', nextPollDelayMs(0) === POLL_MS && POLL_MS === 3_000)
  check('below the tolerance → still 3s', nextPollDelayMs(MAX_POLL_FAILURES - 1) === POLL_MS)
  check('at the tolerance → 10s, never stops', nextPollDelayMs(MAX_POLL_FAILURES) === SLOW_POLL_MS && SLOW_POLL_MS === 10_000 && nextPollDelayMs(50) === SLOW_POLL_MS)
  check('tolerance is 5', MAX_POLL_FAILURES === 5)
}

console.log('\ndescribePollFailure')
{
  const signedOut = describePollFailure(401, 'You are signed out.')
  check('401 stops and says sign in, run keeps going', signedOut.stop && signedOut.immediate && /signed out/i.test(signedOut.message) && /keeps going/.test(signedOut.message))
  check('403 stops too', describePollFailure(403, null).stop)
  const notFound = describePollFailure(404, 'The server has no such run (404).')
  check('404 stops and says not found', notFound.stop && /not found/i.test(notFound.message))
  const network = describePollFailure(0, 'The request never reached the server (no network, or the connection was dropped).')
  check('network failure keeps polling', !network.stop && !network.immediate)
  check('network message names the error and says the run keeps going', /Lost contact with the run \(The request never reached/.test(network.message) && /keeps going on the server; reloading picks it back up/.test(network.message))
  check('500 keeps polling', !describePollFailure(500, 'boom').stop)
  check('null error reads as "no answer"', /\(no answer\)/.test(describePollFailure(502, null).message))
}

console.log('\nparseStartResponse')
{
  const started = parseStartResponse(202, { runId: RUN_ID, status: 'queued', claimed: false, dispatch: { outcome: 'pending' } })
  check('202 → started with the run id', started.kind === 'started' && started.runId === RUN_ID && started.status === 'queued')
  const conflict = parseStartResponse(409, { error: 'A scout is already going', code: 'CONFLICT', runId: RUN_ID, status: 'running', alreadyActive: true, run: runningRow })
  check('409 CONFLICT → attach to the run in the body', conflict.kind === 'conflict' && conflict.runId === RUN_ID && conflict.run?.status === 'running')
  const conflictNoRun = parseStartResponse(409, { error: 'x', code: 'CONFLICT', runId: RUN_ID })
  check('409 CONFLICT without a run object still attaches by id', conflictNoRun.kind === 'conflict' && conflictNoRun.run === null)
  const notReady = parseStartResponse(503, { error: 'ANTHROPIC_API_KEY is not set', code: 'CONFIGURATION', remedy: 'Set it' })
  check('503 → error with the server sentence', notReady.kind === 'error' && notReady.message === 'ANTHROPIC_API_KEY is not set')
  check('409 without CONFLICT code or alreadyActive → error, not attach', parseStartResponse(409, { error: 'migration missing', code: 'SCHEMA_MIGRATION', runId: RUN_ID }).kind === 'error')
  check('202 without a run id → error', parseStartResponse(202, {}).kind === 'error')
  const html = parseStartResponse(504, null)
  check('non-JSON body → an error that names the status', html.kind === 'error' && /504/.test(html.message))
}

console.log('\nparseRunsList')
{
  const withActive = parseRunsList({ runs: [runningRow], active: runningRow, durable: true })
  check('active run is attached', withActive.active?.id === RUN_ID && withActive.last?.id === RUN_ID)
  const finished = { ...runningRow, status: 'succeeded', completed_at: '2026-09-04T11:59:00Z', active: false }
  const noActive = parseRunsList({ runs: [finished], active: null, durable: true })
  check('no active → last run is the newest', noActive.active === null && noActive.last?.status === 'succeeded')
  check('an "active" that is not queued/running is ignored', parseRunsList({ runs: [], active: finished }).active === null)
  check('empty answer → nothing', parseRunsList({ runs: [], active: null }).last === null && parseRunsList(null).active === null)
}

console.log('\nrelativeTime')
{
  check('just now', relativeTime(NOW - 20_000, NOW) === 'just now')
  check('minutes', relativeTime(new Date(NOW - 5 * 60_000).toISOString(), NOW) === '5 min ago')
  check('one hour', relativeTime(NOW - 60 * 60_000, NOW) === '1 hour ago')
  check('hours', relativeTime(NOW - 3 * 3_600_000, NOW) === '3 hours ago')
  check('days', relativeTime(NOW - 2 * 86_400_000, NOW) === '2 days ago')
  check('unparseable is honest', relativeTime('nonsense', NOW) === 'an unknown time ago' && relativeTime(null, NOW) === 'an unknown time ago')
}

console.log('\nwords on screen')
{
  const run = parseRunDetail(runningRow)!
  check('running headline names the stage', runHeadline(run, null) === 'Running · research')
  check('queued headline', runHeadline({ ...run, status: 'queued' }, null).startsWith('Queued'))
  check('succeeded headline counts prospects', runHeadline({ ...run, status: 'succeeded' }, 6) === 'Completed · 6 prospects' && runHeadline({ ...run, status: 'succeeded' }, 1) === 'Completed · 1 prospect')
  check('queued line: attempts and waiting time', queuedLine({ ...run, status: 'queued', attempts: 2 }, NOW) === 'dispatch attempt 2 · waiting 10m 30s')
  check('queued line before any dispatch', /not dispatched yet/.test(queuedLine({ ...run, status: 'queued', attempts: 0 }, NOW)))
  check('elapsed from started_at', runElapsed(run, NOW) === '10m 30s')
  check('elapsed of a finished run uses completed_at', runElapsed({ ...run, completed_at: '2026-09-04T11:50:00Z' }, NOW) === '30s')
  check('elapsed without a start is a dash', runElapsed({ ...run, started_at: null }, NOW) === '—')
  check('event line joins stage and detail', eventLine({ at: null, stage: 'validation', detail: '5 accepted' }) === 'validation — 5 accepted' && eventLine({ at: null, stage: null, detail: 'x' }) === 'x')
  const pairs = countPairs(run.counts)
  check('counts: known keys first in a fixed order, the rest sorted after', pairs.map(([k]) => k).join(',') === 'companies,people,researched,ranked,extra_thing', pairs.map(([k]) => k).join(','))
  check('cost from stats wins', costSoFar(run, parseScoutResult(resultFixture)) === 0.8)
  check('cost falls back to the result payload', costSoFar({ ...run, stats: null }, parseScoutResult(resultFixture)) === 1.2345)
  check('no cost anywhere → null', costSoFar({ ...run, stats: {} }, null) === null)
  check('a healthy run has no staleness note', stalenessNote(run, NOW) === null)
  check('a stale run says how long it has been quiet', /No progress reported for 20s/.test(stalenessNote({ ...run, stale: true }, NOW) ?? ''))
  check('a stale run with no heartbeat says so', /not reported any progress yet/.test(stalenessNote({ ...run, stale: true, heartbeat_at: null }, NOW) ?? ''))
  check('finished runs never get a staleness note', stalenessNote({ ...run, status: 'succeeded', stale: true }, NOW) === null)
}

console.log('\nterminalNotice')
{
  const run = parseRunDetail(runningRow)!
  check('running → none', terminalNotice(run) === null && terminalNotice({ ...run, status: 'succeeded' }) === null)
  const partial = terminalNotice({ ...run, status: 'partial', error: 'the run used its whole clock', error_code: 'RUN_DEADLINE', remedy: 'continue it' })
  check('partial → amber with error, code and remedy', partial?.kind === 'warn' && partial.title === 'Partial run — the run used its whole clock [RUN_DEADLINE]' && partial.lines[0] === 'continue it')
  const partialBare = terminalNotice({ ...run, status: 'partial', error: null })
  check('partial without an error still explains', partialBare?.kind === 'warn' && /stopped before it finished/.test(partialBare.title) && partialBare.lines.length === 1)
  const failed = terminalNotice({ ...run, status: 'failed', error: 'Anthropic answered 529', error_code: 'PROVIDER_ERROR', remedy: null })
  check('failed → red with the code', failed?.kind === 'error' && failed.title === 'Failed — Anthropic answered 529 [PROVIDER_ERROR]' && failed.lines.length === 0)
  const cancelled = terminalNotice({ ...run, status: 'cancelled', error: null })
  check('cancelled → grey', cancelled?.kind === 'info' && /Cancelled/.test(cancelled.title))
}

console.log('\nparsePeopleReadiness')
{
  const r = parsePeopleReadiness({ ready: false, people: { ready: false, reason: 'ANTHROPIC_API_KEY is not set; no agent can run.', remedy: 'Set ANTHROPIC_API_KEY.', code: 'CONFIGURATION', warnings: ['APOLLO_API_KEY is not set'] }, jobs: { ready: true }, checks: [], checkedAt: '2026-09-04T12:00:00Z' })
  check('blocking reason, remedy, code and warnings are read', !!r && !r.ready && r.reason?.startsWith('ANTHROPIC') === true && r.remedy === 'Set ANTHROPIC_API_KEY.' && r.code === 'CONFIGURATION' && r.warnings.length === 1)
  check('ready with warnings', parsePeopleReadiness({ people: { ready: true, reason: null, remedy: null, code: null, warnings: ['x'] } })?.ready === true)
  check('not a readiness payload → null', parsePeopleReadiness({ error: 'signed out' }) === null && parsePeopleReadiness(null) === null)
}

console.log('\nparseFormPrefs')
{
  const defaults: ScoutFormPrefs = { goal: 'g', geography: 'US', segments: 2, depth: 7, searchMode: 'internal_first', campaignId: '' }
  check('null → defaults', parseFormPrefs(null, defaults) === defaults)
  check('garbage → defaults', parseFormPrefs('{not json', defaults) === defaults && parseFormPrefs('[1,2]', defaults) === defaults)
  const p = parseFormPrefs(JSON.stringify({ goal: 'find people', geography: 'Canada', segments: 9, depth: 1, searchMode: 'both', campaignId: 'c1' }), defaults)
  check('values are read and clamped', p.goal === 'find people' && p.geography === 'Canada' && p.segments === 3 && p.depth === 2 && p.searchMode === 'both' && p.campaignId === 'c1')
  check('unknown search mode falls back', parseFormPrefs(JSON.stringify({ searchMode: 'psychic' }), defaults).searchMode === 'internal_first')
  check('a stored result blob is not a preferences blob', parseFormPrefs(JSON.stringify({ at: 1, result: { prospects: [] } }), defaults).goal === 'g')
}

console.log('\nhrefs')
{
  check('detail without result', runDetailHref(RUN_ID, false) === `/api/scout/runs/${RUN_ID}`)
  check('detail with result', runDetailHref(RUN_ID, true) === `/api/scout/runs/${RUN_ID}?result=1`)
  check('cancel', runCancelHref(RUN_ID) === `/api/scout/runs/${RUN_ID}/cancel`)
  check('ids are encoded', runDetailHref('a b', false) === '/api/scout/runs/a%20b')
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
