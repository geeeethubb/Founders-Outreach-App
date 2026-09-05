// Fault-injection suite for the People Scout orchestrator — in memory, in milliseconds.
//
//   npx tsx scripts/reliability/people-scout.ts
//
// No network, no keys, no database. Every collaborator is a stub from
// people-fixtures.ts, and the run's clock is injected, so "the deadline fell
// after the second dossier" is arranged by advancing a number inside a stub.
// Each case asserts on three things at once: the ScoutRunResult the leg
// returned, the checkpoint it left for the next leg, and which stubs were
// called how many times — because a leg that resumes correctly but pays for
// the strategy twice is a bug the result alone cannot show.
//
// Also included by scripts/test-scout-reliability.ts; standalone when run directly.

import { runScouting, buildPeopleScoutResult, type ScoutRunParams, type ScoutRunResult } from '../../lib/scouting/orchestrator'
import { emptyCheckpoint, personKeyOf, readCheckpoint, PEOPLE_SCOUT_CHECKPOINT_VERSION, type PeopleScoutCheckpoint } from '../../lib/scouting/checkpoint'
import type { ScoutedProspect } from '../../lib/scouting/prospect'
import { createRunContext, withRunContext } from '../../lib/runs/context'
import { RunClock } from '../../lib/runs/deadline'
import {
  buildStubDeps, failedResult, makeDiscovered, makePerson, makeRanked, makeValidation, standardWorld,
  DEADLINE_ERROR, SCHEMA_ERROR, type Faults, type StubDeps, type World,
} from './people-fixtures'

let passed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed++
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`)
}
const json = (v: unknown) => JSON.stringify(v)

// ─── Harness ─────────────────────────────────────────────────────────────────

const BIG_BUDGET_MS = 100_000_000

function baseParams(): Omit<ScoutRunParams, 'deps'> {
  return {
    userId: 'u-1',
    label: 'reliability',
    mission: { goal: 'find a winter internship in process AI', timeframe: 'winter 2026', geography: 'Houston, TX', constraints: [] },
    backgroundItems: [{ id: 'bg-1', summary: 'shipped agentic AI into a chemical plant' }],
    budget: { maxCompanies: 10, maxPeoplePerCompany: 5, maxApolloCalls: 100, maxWebSearches: 50, maxAgentSteps: 50 },
    segmentCount: 2,
    companiesPerSegment: 2,
    maxProspects: 10,
    concurrency: 1,
    searchMode: 'internal_first',
  }
}

interface CaseOutcome {
  result: ScoutRunResult
  stubs: StubDeps
  /** Every console line the run printed, so a structured log line can be asserted. */
  lines: string[]
  checkpoints: number
  results: number
  /** Intervals created during the run that were never cleared. */
  leakedTimers: number
}

async function runCase(world: World, opts: { budgetMs?: number; faults?: Faults; params?: Partial<ScoutRunParams>; stubs?: StubDeps } = {}): Promise<CaseOutcome> {
  let t = 1_000_000
  const now = () => t
  const tick = (ms: number) => { t += ms }
  const stubs = opts.stubs ?? buildStubDeps(world, tick, opts.faults)
  const clock = new RunClock({ hardDeadlineAt: t + (opts.budgetMs ?? BIG_BUDGET_MS), finalizeReserveMs: 0, minAttemptMs: 50, now })
  const ctx = createRunContext({ clock, kind: 'people', runId: opts.params?.runId ?? null, label: 'reliability' })

  const lines: string[] = []
  const orig = { log: console.log, warn: console.warn, error: console.error }
  const capture = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
  const live = new Set<unknown>()
  const origSet = globalThis.setInterval
  const origClear = globalThis.clearInterval
  let checkpoints = 0
  let results = 0
  try {
    console.log = capture
    console.warn = capture
    console.error = capture
    ;(globalThis as { setInterval: unknown }).setInterval = ((...args: Parameters<typeof setInterval>) => { const h = origSet(...args); live.add(h); return h }) as typeof setInterval
    ;(globalThis as { clearInterval: unknown }).clearInterval = ((h: Parameters<typeof clearInterval>[0]) => { live.delete(h); return origClear(h) }) as typeof clearInterval
    const result = await withRunContext(ctx, () =>
      runScouting({ ...baseParams(), ...opts.params, deps: stubs.deps, onCheckpoint: () => { checkpoints++ }, onResult: () => { results++ } })
    )
    return { result, stubs, lines, checkpoints, results, leakedTimers: live.size }
  } finally {
    for (const h of live) origClear(h as ReturnType<typeof setInterval>)
    ;(globalThis as { setInterval: unknown }).setInterval = origSet
    ;(globalThis as { clearInterval: unknown }).clearInterval = origClear
    console.log = orig.log
    console.warn = orig.warn
    console.error = orig.error
  }
}

const keyFor = (world: World, name: string) => personKeyOf(makePerson(name, world.companies.find((c) => c.people.includes(name))?.name ?? 'x'))
const counts = (s: StubDeps) => json(s.counters)
const statusWrites = (s: StubDeps) => s.store.updates.filter((u) => typeof u.patch.status === 'string')

// ─── Cases ───────────────────────────────────────────────────────────────────

async function fullSuccess(): Promise<void> {
  console.log('\nfull success: internal insufficient → every external stage, merged and de-clumped')
  const world = standardWorld()
  // Aaron is already in the database under the same contact the internal phase surfaced: a rediscovery, never a duplicate.
  world.owned = [{ contactId: 'c-int-1', apolloId: 'apollo-aaron-ames', name: 'Aaron Ames', title: 'VP Engineering', company: 'Acme Process', email: null, linkedinUrl: 'https://linkedin.com/in/aaron-ames', location: null, seniority: null, department: null, emailStatus: null, status: null }]
  const { result: r, stubs, lines, checkpoints, results, leakedTimers } = await runCase(world)
  const c = stubs.counters
  check('stopped complete, not partial, not continuable', r.stopped === 'complete' && !r.partial && !r.continuable, `${r.stopped} partial=${r.partial}`)
  check('checkpoint.stages runs in order and ends with done', json(r.checkpoint.stages) === json(['strategy', 'internal', 'discovery', 'validation', 'people', 'triage', 'research', 'rescout', 'rank', 'done']), json(r.checkpoint.stages))
  check('every stage stub ran the expected number of times',
    c.strategist === 1 && c.internalPhase === 1 && c.scoreInternal === 1 && c.loadOwned === 1 && c.discovery === 2 && c.validation === 4 && c.scoutPeople === 2 && c.triage === 3 && c.research === 7 && c.ranking === 6,
    counts(stubs))
  check('the rejected company never reached Apollo', !stubs.researched.includes('Dan Dull') && r.rejections.length === 1 && r.rejections[0].company === 'Dud Staffing', json(r.rejections))
  check('research asked for a different person at Cobalt and the re-scout found one', stubs.researched.includes('Chris Chase') && r.checkpoint.rescouted.length === 1, json(stubs.researched))
  check('the SEARCH_FOR_DIFFERENT_PERSON person was not ranked', !stubs.rankedNames.includes('Carl Cross'), json(stubs.rankedNames))
  check('funnel counts add up', json(r.funnel) === json({ segments: 2, networkIndexed: 200, internalRetrieved: 1, internalStrong: 1, companiesDiscovered: 4, companiesValidated: 3, companiesRejected: 1, stubsFound: 6, peopleEnriched: 7, peopleReused: 0, peopleTriaged: 6, peopleResearched: 7, prospectsRanked: 6 }), json(r.funnel))
  const names = r.payload.prospects.map((p) => p.name)
  check('the rediscovered person merged into the internal entry (6 prospects, not 7)', names.length === 6 && !names.includes('Aaron Ames') && r.payload.prospects.find((p) => p.name === 'Ines Inner')?.source === 'existing_rediscovered', json(names))
  const firstFour = r.payload.prospects.slice(0, 4).map((p) => p.company)
  check('de-clumped: the best person at each company comes first', new Set(firstFour).size === 4 && json(names.slice(4)) === json(['Chris Chase', 'Ben Bright']), json(names))
  check('the first block is ordered by score', r.payload.prospects.slice(0, 4).every((p, i, a) => i === 0 || a[i - 1].score >= p.score), json(r.payload.prospects.map((p) => p.score)))
  check('prospects carry whyCompany from the accepted validation', r.payload.prospects.filter((p) => p.source === 'new').every((p) => p.whyCompany?.includes('process control software')), json(r.payload.prospects.map((p) => p.whyCompany)))
  check('payload.unranked is empty on a complete run', r.payload.unranked.length === 0, json(r.payload.unranked))
  const by = r.usage.byAgent
  // Provider-level usage (cp.usage.costUsd) is the Anthropic client's accounting, which stubs never touch; byAgent is the trace's.
  const spent = Object.values(by).reduce((s, a) => s + a.costUsd, 0)
  check('usage.byAgent counts every agent call with its cost', by.mission_strategist?.calls === 1 && by.market_discovery?.calls === 2 && by.company_validation?.calls === 4 && by.person_triage?.calls === 3 && by.person_research?.calls === 7 && by.ranking?.calls === 7 && by.network_retrieval?.calls === 1 && spent > 2 && r.payload.usage.byAgent.ranking?.costUsd > 0, json(by))
  check('persistence counters match what the store holds', r.persistence.companiesInserted === 3 && stubs.store.companies.size === 3 && stubs.store.contacts.size === 7 && r.persistence.agentRunsRecorded === 25 && stubs.store.agentRuns.size === 25 && r.persistence.factsInserted === 20 && !r.persistence.migrationMissing, json(r.persistence))
  check('contactsInserted counts the re-scouted contact too', r.persistence.contactsInserted === 7,
    `DEFECT lib/scouting/orchestrator.ts:854 — the rescout persistContacts result is used only for idByKey; its inserted/migrationMissing/errors are dropped (got ${r.persistence.contactsInserted}, store holds ${stubs.store.contacts.size})`)
  check('checkpoint and result were written progressively', checkpoints >= 10 && results >= 3, `checkpoints=${checkpoints} results=${results}`)
  check('a structured leg_result line was logged', lines.some((l) => l.startsWith('[scout]') && l.includes('event="leg_result"') && l.includes('status="complete"')), lines.filter((l) => l.includes('leg_result')).join(' | '))
  check('no errors on the happy path', r.errors.length === 0, json(r.errors))
  check('the heartbeat timer was cleared', leakedTimers === 0, `${leakedTimers} live`)
}

async function internalOnly(): Promise<void> {
  console.log('\ninternal only: no discovery, no validation, no Apollo')
  const { result: r, stubs } = await runCase(standardWorld(), { params: { searchMode: 'internal_only' } })
  const c = stubs.counters
  check('stopped complete', r.stopped === 'complete' && r.checkpoint.stages.includes('done'), r.stopped)
  check('nothing external was called', c.discovery === 0 && c.validation === 0 && c.scoutPeople === 0 && c.triage === 0 && c.research === 0 && c.loadOwned === 0, counts(stubs))
  check('the decision says why', r.internal.decision.decision === 'INTERNAL_SUFFICIENT' && !r.internal.decision.runExternal && r.payload.internal?.headline.includes('sufficient') === true, json(r.internal.decision))
  check('the internal prospect is the answer', r.payload.prospects.length === 1 && r.payload.prospects[0].source === 'existing' && r.payload.prospects[0].name === 'Ines Inner', json(r.payload.prospects.map((p) => p.name)))
  check('stages: strategy, internal, done', json(r.checkpoint.stages) === json(['strategy', 'internal', 'done']), json(r.checkpoint.stages))
}

async function internalSufficient(): Promise<void> {
  console.log('\ninternal sufficient: internal_first with enough strong candidates never spends')
  const world = standardWorld()
  world.internal = { candidates: Array.from({ length: 6 }, (_, i) => ({ contactId: `c-int-${i + 1}`, name: `Inner Person${i + 1}`, company: `Inner Co ${i + 1}`, total: 0.85 })) }
  const { result: r, stubs } = await runCase(world, { params: { internalTarget: 6 } })
  const c = stubs.counters
  check('stopped complete', r.stopped === 'complete', r.stopped)
  check('the decision is INTERNAL_SUFFICIENT with 6 strong', r.internal.decision.decision === 'INTERNAL_SUFFICIENT' && r.internal.decision.strongCount === 6, json(r.internal.decision))
  check('external stages never called', c.discovery === 0 && c.validation === 0 && c.scoutPeople === 0 && c.triage === 0 && c.research === 0 && c.ranking === 0 && c.persistCompanies === 0, counts(stubs))
  check('six internal prospects, six companies', r.payload.prospects.length === 6 && new Set(r.payload.prospects.map((p) => p.company)).size === 6, json(r.payload.prospects.map((p) => p.company)))
}

async function internalScoringDeadline(): Promise<void> {
  console.log('\ninternal scoring cut by the clock: the leg hands back the unscored candidates, and the next leg scores exactly those')
  const world = standardWorld()
  world.internal = { candidates: Array.from({ length: 5 }, (_, i) => ({ contactId: `c-int-${i + 1}`, name: `Inner Person${i + 1}`, company: `Inner Co ${i + 1}`, total: 0.85 })) }
  const cut = ['Inner Person4', 'Inner Person5']
  const leg1 = await runCase(world, { faults: { internalDeadlined: { names: cut, onlyFirstCall: true } }, params: { searchMode: 'internal_only', internalTarget: 5, runId: 'run-int', workerId: 'w-1' } })
  const r1 = leg1.result
  const c1 = leg1.stubs.counters
  check('leg 1: stopped deadline, partial, continuable — NOT complete (DEFECT if complete: the leg treated clock-cut candidates as scored-and-failed)', r1.stopped === 'deadline' && r1.partial && r1.continuable, `${r1.stopped} partial=${r1.partial} continuable=${r1.continuable}`)
  check('leg 1: the internal stage is not marked done', !r1.checkpoint.stages.includes('internal') && !r1.checkpoint.stages.includes('done') && r1.checkpoint.stages.includes('strategy'), json(r1.checkpoint.stages))
  check('leg 1: the checkpoint holds the three scored prospects and the two pending candidates', r1.checkpoint.internal?.prospects.length === 3 && json((r1.checkpoint.internal?.pending ?? []).map((c) => c.contact.name)) === json(cut), json({ scored: r1.checkpoint.internal?.prospects.length, pending: r1.checkpoint.internal?.pending?.map((c) => c.contact.name) }))
  check('leg 1: the clock-cut candidates are not reported as errors', !r1.errors.some((e) => e.startsWith('ranking(internal:')), json(r1.errors))
  check('leg 1: the payload shows the three scored prospects', r1.payload.prospects.length === 3 && r1.payload.prospects.every((p) => p.source === 'existing'), json(r1.payload.prospects.map((p) => p.name)))
  check('leg 1: retrieval ran once, scoring once, nothing external', c1.internalPhase === 1 && c1.scoreInternal === 1 && c1.discovery === 0 && c1.ranking === 0, counts(leg1.stubs))
  const read = readCheckpoint(JSON.parse(JSON.stringify(r1.checkpoint)))
  check('the checkpoint round-trips with its pending candidates', !read.fresh && read.checkpoint.internal?.pending?.length === 2, json(read.checkpoint.internal?.pending?.map((c) => c.contact.name)))
  const leg2 = await runCase(world, { params: { searchMode: 'internal_only', internalTarget: 5, checkpoint: read.checkpoint, runId: 'run-int', workerId: 'w-2' } })
  const r2 = leg2.result
  const c2 = leg2.stubs.counters
  check('leg 2: strategist and retrieval NOT called again', c2.strategist === 0 && c2.internalPhase === 0, counts(leg2.stubs))
  check('leg 2: scoring was called once, with exactly the two pending candidates', c2.scoreInternal === 1 && json(leg2.stubs.internalScoredNames) === json([cut]), json(leg2.stubs.internalScoredNames))
  check('leg 2: stopped complete with all five prospects, no duplicates', r2.stopped === 'complete' && r2.payload.prospects.length === 5 && new Set(r2.payload.prospects.map((p) => p.name)).size === 5, json(r2.payload.prospects.map((p) => p.name)))
  check('leg 2: stages strategy, internal, done; nothing pending', json(r2.checkpoint.stages) === json(['strategy', 'internal', 'done']) && (r2.checkpoint.internal?.pending ?? []).length === 0, json(r2.checkpoint.stages))
  check('leg 2: the funnel still knows what retrieval found', r2.funnel.internalRetrieved === 5 && r2.funnel.internalStrong === 5, json(r2.funnel))
}

async function strategistFailure(): Promise<void> {
  console.log('\nstrategist failure: invalid output is a failed leg, and only the row owner writes the status')
  const faults: Faults = { strategist: () => failedResult('mission_strategist', SCHEMA_ERROR, 'invalid_output') }
  const own = await runCase(standardWorld(), { faults })
  check('own-row: stopped failed, not partial, not continuable', own.result.stopped === 'failed' && !own.result.partial && !own.result.continuable, own.result.stopped)
  check('own-row: the error names the strategist', own.result.errors.some((e) => e.startsWith('mission_strategist failed:') && e.includes('schema validation')), json(own.result.errors))
  const w = statusWrites(own.stubs)
  check('own-row: updateRun wrote status failed with the error, completed', w.length === 1 && w[0].patch.status === 'failed' && w[0].patch.completed === true && String(w[0].patch.error).includes('schema validation') && own.stubs.store.runs.get(own.result.runId ?? '')?.status === 'failed', json(w))
  check('own-row: nothing after the strategist ran', own.stubs.counters.internalPhase === 0 && own.stubs.counters.discovery === 0, counts(own.stubs))
  check('own-row: strategy stage not marked done', own.result.checkpoint.stages.length === 0 && own.result.checkpoint.strategy === null, json(own.result.checkpoint.stages))
  const att = await runCase(standardWorld(), { faults, params: { runId: 'run-att', workerId: 'w-1' } })
  check('attached: stopped failed', att.result.stopped === 'failed', att.result.stopped)
  check('attached: no status was written — the worker owns it', statusWrites(att.stubs).length === 0 && att.stubs.counters.startRun === 0, json(att.stubs.store.updates))
}

async function strategistDeadline(): Promise<void> {
  console.log('\nstrategist deadline: a provider refused by the clock is the clock\'s doing')
  const { result: r, stubs } = await runCase(standardWorld(), { faults: { strategist: () => failedResult('mission_strategist', DEADLINE_ERROR) } })
  check('stopped deadline, continuable, partial', r.stopped === 'deadline' && r.continuable && r.partial, `${r.stopped} continuable=${r.continuable}`)
  check('the error is kept', r.errors.some((e) => e.startsWith('mission_strategist:') && /deadline/i.test(e)), json(r.errors))
  check('no stage done, strategy null — the next leg asks again', r.checkpoint.stages.length === 0 && r.checkpoint.strategy === null, json(r.checkpoint.stages))
  check('own-row status is partial', statusWrites(stubs)[0]?.patch.status === 'partial', json(statusWrites(stubs)))
  check('attempts counted', r.checkpoint.attempts === 1, String(r.checkpoint.attempts))
}

async function gateDeadlines(): Promise<void> {
  console.log('\nstage gates: a stage that cannot fit is not started')
  const a = await runCase(standardWorld(), { budgetMs: 40_000 })
  check('40 s: the strategy gate (45 s) refuses before the strategist is called', a.result.stopped === 'deadline' && a.result.continuable && a.stubs.counters.strategist === 0 && a.result.checkpoint.stages.length === 0, `${a.result.stopped} ${counts(a.stubs)}`)
  check('40 s: the refusal is logged with the stage', a.lines.some((l) => l.includes('stage="strategy"') && l.includes('not enough time left for strategy')), a.lines.filter((l) => l.includes('strategy')).join(' | '))
  const b = await runCase(standardWorld(), { budgetMs: 100_000, faults: { advance: { strategist: 60_000 } } })
  check('100 s with a 60 s strategy: internal (30 s) starts, discovery (45 s) is refused', b.result.stopped === 'deadline' && json(b.result.checkpoint.stages) === json(['strategy', 'internal']) && b.stubs.counters.internalPhase === 1 && b.stubs.counters.discovery === 0, `${b.result.stopped} ${json(b.result.checkpoint.stages)} ${counts(b.stubs)}`)
  check('the strategy survives in the checkpoint for the next leg', b.result.checkpoint.strategy?.segments.length === 2 && b.result.checkpoint.internal?.runExternal === true, json(b.result.checkpoint.strategy?.segments.map((s) => s.name)))
}

async function deadlineMidResearchThenResume(): Promise<void> {
  console.log('\ndeadline mid-research, then leg 2 resumes from the checkpoint')
  const world = standardWorld()
  // 185 s of clock, 80 s per dossier: two dossiers land, the third is refused (30 s minimum), the rest never start.
  const leg1 = await runCase(world, { budgetMs: 185_000, faults: { advance: { research: 80_000 } } })
  const r1 = leg1.result
  const c1 = leg1.stubs.counters
  check('leg 1: stopped deadline, continuable, partial', r1.stopped === 'deadline' && r1.continuable && r1.partial, `${r1.stopped}`)
  check('leg 1: exactly two dossiers were paid for', c1.research === 2 && json(leg1.stubs.researched) === json(['Alice Adams', 'Aaron Ames']), json(leg1.stubs.researched))
  const researchedKeys = Object.keys(r1.checkpoint.research)
  check('leg 1: checkpoint.research holds exactly those two, both ok', researchedKeys.length === 2 && researchedKeys.every((k) => r1.checkpoint.research[k].ok && r1.checkpoint.research[k].tries === 1) && researchedKeys.includes(keyFor(world, 'Alice Adams')) && researchedKeys.includes(keyFor(world, 'Aaron Ames')), json(researchedKeys))
  check('leg 1: toResearch intact (6), research stage not done', r1.checkpoint.toResearch.length === 6 && !r1.checkpoint.stages.includes('research') && json(r1.checkpoint.stages) === json(['strategy', 'internal', 'discovery', 'validation', 'people', 'triage']), json(r1.checkpoint.stages))
  check('leg 1: no ranking ran', c1.ranking === 0 && Object.keys(r1.checkpoint.ranked).length === 0, counts(leg1.stubs))
  check('leg 1: payload.unranked shows the researched-but-unranked people', json(r1.payload.unranked.map((u) => [u.name, u.reason])) === json([['Alice Adams', 'not_ranked'], ['Aaron Ames', 'not_ranked']]) && r1.payload.unranked.every((u) => u.researchSummary?.includes('OWNS:')), json(r1.payload.unranked))
  check('leg 1: payload still shows the internal prospect, not complete', r1.payload.prospects.length === 1 && !r1.payload.complete && r1.funnel.peopleResearched === 2, json(r1.payload.prospects.map((p) => p.name)))
  check('leg 1: own-row status partial', statusWrites(leg1.stubs)[0]?.patch.status === 'partial', json(statusWrites(leg1.stubs)))
  check('leg 1: the stop was logged at the research stage', leg1.lines.some((l) => l.includes('stage="research"') && l.includes('not enough time left')), leg1.lines.filter((l) => l.includes('research')).slice(-2).join(' | '))

  // The worker persists the checkpoint as JSON and reads it back on the next claim.
  const read = readCheckpoint(JSON.parse(JSON.stringify(r1.checkpoint)))
  check('the checkpoint survives a JSON round trip', !read.fresh && read.note === null && json(read.checkpoint.stages) === json(r1.checkpoint.stages) && Object.keys(read.checkpoint.research).length === 2, json(read))

  const leg2 = await runCase(world, { params: { checkpoint: read.checkpoint, runId: 'run-durable', workerId: 'w-2' } })
  const r2 = leg2.result
  const c2 = leg2.stubs.counters
  check('leg 2: stopped complete', r2.stopped === 'complete' && r2.checkpoint.stages.includes('done') && r2.checkpoint.attempts === 2, `${r2.stopped} attempts=${r2.checkpoint.attempts}`)
  check('leg 2: strategist/discovery/validation/people/triage/internal NOT called again', c2.strategist === 0 && c2.discovery === 0 && c2.validation === 0 && c2.triage === 0 && c2.internalPhase === 0 && c2.scoreInternal === 0 && c2.persistCompanies === 0, counts(leg2.stubs))
  check('leg 2: only the remaining four dossiers plus the re-scout replacement', c2.research === 5 && json(leg2.stubs.researched) === json(['Bea Brown', 'Ben Bright', 'Cara Cole', 'Carl Cross', 'Chris Chase']) && c2.scoutPeople === 1, json(leg2.stubs.researched))
  check('leg 2: ranking ran for the six qualified people', c2.ranking === 6 && !leg2.stubs.rankedNames.includes('Carl Cross'), json(leg2.stubs.rankedNames))
  const names2 = r2.payload.prospects.map((p) => p.name)
  check('leg 2: prospects include the leg-1 researched people', names2.includes('Alice Adams') && names2.includes('Aaron Ames') && names2.length === 7, json(names2))
  check('leg 2: leg-1 dossiers were reused, not re-bought (tries still 1)', r2.checkpoint.research[keyFor(world, 'Alice Adams')].tries === 1, json(r2.checkpoint.research[keyFor(world, 'Alice Adams')]))
  check('leg 2: attached — no status write, no start, no heartbeat', statusWrites(leg2.stubs).length === 0 && c2.startRun === 0 && c2.touchRun === 0, json(leg2.stubs.store.updates))
  check('leg 2: attempts=2 so the searchMode patch was not repeated', !leg2.stubs.store.updates.some((u) => 'searchMode' in u.patch), json(leg2.stubs.store.updates))
  check('leg 2: usage accumulates across legs', r2.usage.byAgent.person_research.calls === 7 && r2.persistence.agentRunsRecorded > r1.persistence.agentRunsRecorded, json(r2.usage.byAgent.person_research))
}

async function invalidRankingOutput(): Promise<void> {
  console.log('\ninvalid ranking output for one person: skipped with an error line, the rest ranked')
  const { result: r, stubs } = await runCase(standardWorld(), { faults: { rankingFor: { 'Bea Brown': () => failedResult('ranking', SCHEMA_ERROR, 'invalid_output') } } })
  check('the run completes', r.stopped === 'complete' && r.checkpoint.stages.includes('done'), r.stopped)
  check('ranking was attempted for all six', stubs.counters.ranking === 6, counts(stubs))
  check('an error line names the person', r.errors.some((e) => e.startsWith('ranking(Bea Brown):') && e.includes('schema validation')), json(r.errors))
  const names = r.payload.prospects.map((p) => p.name)
  check('the others were ranked (5 external + 1 internal)', names.length === 6 && !names.includes('Bea Brown') && names.includes('Ben Bright'), json(names))
  check('the skipped person is shown as unranked, never discarded', r.payload.unranked.length === 1 && r.payload.unranked[0].name === 'Bea Brown' && r.payload.unranked[0].reason === 'not_ranked', json(r.payload.unranked))
  check('the failed agent run was still traced', [...stubs.store.agentRuns.values()].some((a) => a.agentId === 'ranking' && a.status === 'invalid_output'), '')
}

async function persistenceFailure(): Promise<void> {
  console.log('\npersistence failure: a missing contacts schema degrades, never halts')
  const { result: r, stubs } = await runCase(standardWorld(), { faults: { contactsMigrationMissing: true } })
  check('the run completes', r.stopped === 'complete', r.stopped)
  check('persistence.migrationMissing is true', r.persistence.migrationMissing && r.payload.prospects.length === 7, json(r.persistence))
  check('errors mention the missing relation', r.errors.some((e) => /relation "contacts" does not exist/.test(e)), json(r.errors))
  check('no contact ids were attached, contactId null on the new prospects', r.persistence.contactsInserted === 0 && r.payload.prospects.filter((p) => p.source === 'new').every((p) => p.contactId === null), json(r.payload.prospects.map((p) => p.contactId)))
  check('research and ranking still ran', stubs.counters.research === 7 && stubs.counters.ranking === 6, counts(stubs))
}

async function cancellation(): Promise<void> {
  console.log('\ncancellation: shouldStop after the strategy stage')
  let strategyDone = false
  const world = standardWorld()
  const stubs = buildStubDeps(world, () => undefined)
  const inner = stubs.deps.strategist!
  stubs.deps.strategist = async (input, ctx) => { const r = await inner(input, ctx); strategyDone = true; return r }
  const { result: r } = await runCase(world, { stubs, params: { shouldStop: () => strategyDone } })
  check('stopped cancelled, not continuable, partial', r.stopped === 'cancelled' && !r.continuable && r.partial, `${r.stopped} continuable=${r.continuable}`)
  check('the strategy stage finished, nothing after it ran', json(r.checkpoint.stages) === json(['strategy']) && stubs.counters.strategist === 1 && stubs.counters.internalPhase === 0 && stubs.counters.discovery === 0, `${json(r.checkpoint.stages)} ${counts(stubs)}`)
  check('own-row status is cancelled', statusWrites(stubs)[0]?.patch.status === 'cancelled', json(statusWrites(stubs)))
  check('the cancel was logged at the internal gate', r.errors.length === 0 && stubs.store.runs.size === 1, json(r.errors))
}

async function attachedFences(): Promise<void> {
  console.log('\nattached mode: every row write is fenced on the worker, and none sets a status')
  const { result: r, stubs } = await runCase(standardWorld(), { params: { runId: 'run-att', workerId: 'w-1' } })
  const u = stubs.store.updates
  check('the run completed', r.stopped === 'complete' && r.runId === 'run-att', r.stopped)
  check('no row was started and no heartbeat sent — the worker did both', stubs.counters.startRun === 0 && stubs.counters.touchRun === 0, counts(stubs))
  check('searchMode, strategy and internalDecision were written, in that order', json(u.map((x) => Object.keys(x.patch)[0])) === json(['searchMode', 'strategy', 'internalDecision']), json(u.map((x) => Object.keys(x.patch))))
  check('every write carries guard {workerId, statuses:[running]}', u.length === 3 && u.every((x) => x.runId === 'run-att' && x.guard.workerId === 'w-1' && json(x.guard.statuses) === json(['running'])), json(u.map((x) => x.guard)))
  check('no write sets a status', u.every((x) => !('status' in x.patch) && !('completed' in x.patch)), json(u.map((x) => Object.keys(x.patch))))
}

async function ownRowHeartbeat(): Promise<void> {
  console.log('\nown-row mode: starts its row, heartbeats it, closes it, clears the timer')
  const out = await runCase(standardWorld())
  const { result: r, stubs } = out
  check('startRun created the row and the run carries its id', stubs.counters.startRun === 1 && r.runId !== null && stubs.store.runs.has(r.runId ?? ''), json([...stubs.store.runs.keys()]))
  check('touchRun was called at the start with that id', stubs.counters.touchRun >= 1 && stubs.store.touches[0] === r.runId, json(stubs.store.touches))
  check('the heartbeat interval was cleared', out.leakedTimers === 0, `${out.leakedTimers} live`)
  const w = statusWrites(stubs)
  check('the row was closed succeeded with stats', w.length === 1 && w[0].patch.status === 'succeeded' && w[0].patch.completed === true && w[0].patch.error === null && (w[0].patch.stats as { stopped?: string })?.stopped === 'complete' && stubs.store.runs.get(r.runId ?? '')?.status === 'succeeded', json(w))
  check('own-row writes are unguarded', stubs.store.updates.every((x) => !x.guard.workerId && !x.guard.statuses), json(stubs.store.updates.map((x) => x.guard)))
}

function checkpointReading(): void {
  console.log('\nreadCheckpoint')
  const foreign = readCheckpoint({ v: 2, stages: ['strategy', 'internal'], strategy: { segments: [] } })
  check('a different version is fresh, with a note', foreign.fresh && foreign.note?.includes('v2') === true && foreign.checkpoint.stages.length === 0 && foreign.checkpoint.v === PEOPLE_SCOUT_CHECKPOINT_VERSION, json(foreign.note))
  check('null and a string are fresh without a note', readCheckpoint(null).fresh && readCheckpoint('x').fresh && readCheckpoint(null).note === null, '')
  const cp = emptyCheckpoint()
  cp.stages = ['strategy', 'internal']
  cp.attempts = 2
  cp.strategy = { segments: [], positioning_angle: 'x', reasoning: '' }
  cp.toResearch = ['k1']
  cp.research.k1 = { ok: true, personContext: 'OWNS: x', verdict: 'KEEP', betterRole: null, companyContext: 'c', tries: 1 }
  cp.funnel.segments = 3
  cp.usage.costUsd = 1.5
  cp.errors = ['e1']
  const back = readCheckpoint(JSON.parse(JSON.stringify(cp)))
  check('a valid checkpoint round-trips through JSON', !back.fresh && back.note === null && json(back.checkpoint) === json(cp), json(back.checkpoint).slice(0, 200))
  const junkStages = readCheckpoint({ ...JSON.parse(JSON.stringify(cp)), stages: ['strategy', 'bogus', 'done'] })
  check('unknown stage names are dropped', json(junkStages.checkpoint.stages) === json(['strategy', 'done']), json(junkStages.checkpoint.stages))
}

function externalProspect(name: string, company: string, normalized: number): ScoutedProspect {
  const person = makePerson(name, company)
  return { ...makeRanked(personKeyOf(person), normalized), person, company, companyRef: company, researchSummary: 'OWNS: x', researchVerdict: 'KEEP', source: 'new', contactId: null, companyContext: `WHAT THEY DO: ${company} (context)` }
}

function resultBuilding(): void {
  console.log('\nbuildPeopleScoutResult')
  const cp: PeopleScoutCheckpoint = emptyCheckpoint()
  const mk = (n: string, co: string) => makePerson(n, co)
  const people = [mk('Kept Keep', 'Acme'), mk('Rejected Rej', 'Acme'), mk('Search Other', 'Beta'), mk('Failed Fail', 'Beta'), mk('Ranked Rank', 'Acme'), mk('Never Researched', 'Beta')]
  cp.people = people
  cp.toResearch = people.map(personKeyOf)
  const note = (ok: boolean, verdict: string | null) => ({ ok, personContext: ok ? 'OWNS: something' : null, verdict, betterRole: null, companyContext: 'c', tries: 1 })
  cp.research[personKeyOf(people[0])] = note(true, 'KEEP')
  cp.research[personKeyOf(people[1])] = note(true, 'REJECT')
  cp.research[personKeyOf(people[2])] = note(true, 'SEARCH_FOR_DIFFERENT_PERSON')
  cp.research[personKeyOf(people[3])] = { ...note(false, null), error: 'boom' }
  cp.ranked[personKeyOf(people[4])] = externalProspect('Ranked Rank', 'Acme', 0.8)
  cp.ranked.other = externalProspect('Other Co', 'Zeta', 0.5)
  const accepted: PeopleScoutCheckpoint['accepted'] = [{ company: makeDiscovered('Acme'), segmentName: 's', validation: makeValidation('Acme', { what_they_do: 'Acme makes widgets' }), agentRunId: null }]
  const out = buildPeopleScoutResult(cp, { runId: 'r', searchMode: 'internal_first', complete: false, accepted })
  check('unranked excludes REJECT and SEARCH_FOR_DIFFERENT_PERSON, keeps ok and failed research', json(out.unranked.map((u) => [u.name, u.reason])) === json([['Kept Keep', 'not_ranked'], ['Failed Fail', 'research_failed']]), json(out.unranked.map((u) => [u.name, u.reason])))
  check('a person never researched is not listed as unranked (no note yet)', !out.unranked.some((u) => u.name === 'Never Researched'), '')
  check('prospects carry whyCompany from the accepted validation', out.prospects.find((p) => p.name === 'Ranked Rank')?.whyCompany === 'Acme makes widgets', json(out.prospects.map((p) => p.whyCompany)))
  check('a company outside accepted falls back to the prospect\'s companyContext', out.prospects.find((p) => p.name === 'Other Co')?.whyCompany === 'WHAT THEY DO: Zeta (context)', json(out.prospects.map((p) => p.whyCompany)))
  check('prospects are ordered by score and funnel.prospectsRanked matches', out.prospects[0].name === 'Ranked Rank' && out.funnel.prospectsRanked === 2 && out.complete === false && out.v === 1, json(out.funnel))
  check('components are rounded points per dimension', out.prospects[0].components.length === 5 && out.prospects[0].components.every((c) => Number.isInteger(c.points) && c.max > 0), json(out.prospects[0].components))
}

// ─── Entry ───────────────────────────────────────────────────────────────────

export async function runPeopleScoutReliability(): Promise<{ passed: number; failed: number; failures: string[] }> {
  passed = 0
  failures.length = 0
  console.log('People Scout orchestrator — fault injection (in memory)')
  const cases: (() => Promise<void> | void)[] = [
    fullSuccess, internalOnly, internalSufficient, internalScoringDeadline, strategistFailure, strategistDeadline, gateDeadlines,
    deadlineMidResearchThenResume, invalidRankingOutput, persistenceFailure, cancellation, attachedFences,
    ownRowHeartbeat, checkpointReading, resultBuilding,
  ]
  for (const c of cases) {
    try {
      await c()
    } catch (e) {
      check(`${c.name} threw`, false, e instanceof Error ? `${e.message}\n${e.stack}` : String(e))
    }
  }
  console.log(failures.length === 0 ? `
people-scout: all ${passed} checks passed` : `
people-scout: ${failures.length} FAILED, ${passed} passed`)
  for (const f of failures) console.log(`  FAIL ${f}`)
  return { passed, failed: failures.length, failures: [...failures] }
}

if (/people-scout\.ts$/i.test((process.argv[1] ?? '').replace(/\\/g, '/'))) {
  runPeopleScoutReliability().then((r) => process.exit(r.failed > 0 ? 1 : 0)).catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
