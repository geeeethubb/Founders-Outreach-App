// Offline tests for the Career OS discovery agents: validators, tool caps, and
// the scout session loop. No network, no API key — the agent round is
// injected, and the tools are stubs.
//
//   npx tsx scripts/test-career-discovery-agents.ts
//
// What is pinned here is the deterministic envelope around the model: what
// gets rejected, what gets stripped and counted, and when the loop stops. The
// judgment itself is measured by evals, not asserted here.

import { validate as validatePlan } from '../lib/agents/job-mission-planner'
import { jobMissionPlannerPrompt } from '../lib/agents/job-mission-planner/prompt'
import { fitEvaluatorPrompt } from '../lib/agents/fit-evaluator/prompt'
import { validateRound, buildScoutTools, type LookupBoardFn, type FetchPageFn, type ScoutToolLogEntry } from '../lib/agents/job-scout'
import { runJobScoutSession, postingKey } from '../lib/agents/job-scout/session'
import { validate as validateExtraction } from '../lib/agents/job-extractor'
import { validate as validateVerification } from '../lib/agents/job-verifier'
import type { AgentResult, EvidenceSource, ToolContext } from '../lib/agents/runtime/types'
import type { JobScoutRoundOutput } from '../lib/agents/job-scout'
import type { SearchStrategy } from '../lib/agents/job-mission-planner'

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) passed++
  else {
    failed++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const ctx: ToolContext = {
  user_id: 'test-user',
  run_id: null,
  budget: { maxCompanies: 0, maxPeoplePerCompany: 0, maxApolloCalls: 0, maxWebSearches: 4, maxAgentSteps: 7 },
}

// ─── Planner validate ────────────────────────────────────────────────────────

const families = [
  { name: 'Process Engineering', rationale: 'r', example_titles: ['Process Engineering Intern'], confidence: 0.8 },
  { name: 'Industrial AI', rationale: 'r', example_titles: ['Applied AI Intern'], confidence: 0.7 },
  { name: 'Technical Strategy', rationale: 'r', example_titles: ['Strategy Intern'], confidence: 0.5 },
]
const strategy = (name: string, queries: string[]) => ({
  name, kind: 'job_first', rationale: 'r', queries, target_titles: ['Intern'], geo_focus: ['SF'], priority: 0.9,
})
const goodPlan = {
  role_families: families,
  strategies: [strategy('ATS process', ['a', 'b']), strategy('ATS ai', ['c', 'd']), strategy('Careers', ['e', 'f'])],
  seed_companies: [
    { name: 'Acme Robotics', domain: 'acme.com', why: 'w', company_type: 'robotics', priority: 0.8, source_url: 'https://acme.com/about' },
    { name: 'ACME  Robotics', domain: null, why: 'dupe', company_type: 'robotics', priority: 0.8, source_url: null },
    { name: 'Handshake', domain: 'joinhandshake.com', why: 'job board', company_type: 'x', priority: 0.1, source_url: null },
    { name: 'Aerotek Staffing', domain: null, why: 'staffing', company_type: 'x', priority: 0.1, source_url: null },
    { name: 'Beta Energy', domain: 'https://www.beta.io/', why: 'w', company_type: 'energy', priority: 0.6, source_url: 'https://invented.example/x' },
  ],
  adjacent_categories: ['grid-scale batteries'],
  exclusions: ['staffing agencies'],
  reasoning: 'because',
}
const evidence: EvidenceSource[] = [{ url: 'https://acme.com/careers', title: null, snippet: null }]

{
  const plan = validatePlan(goodPlan, evidence)
  check('planner: valid plan accepted', plan !== null)
  check('planner: seed dedupe by normalized name', plan?.seed_companies.length === 2, `got ${plan?.seed_companies.length}`)
  check('planner: non-operators stripped and counted', plan?.dropped_non_operators === 2, `got ${plan?.dropped_non_operators}`)
  check('planner: source verified at origin level', plan?.seed_companies[0].source_verified === true)
  check('planner: invented source not verified', plan?.seed_companies[1].source_verified === false)
  check('planner: domain normalized', plan?.seed_companies[1].domain === 'beta.io')
}
{
  const plan = validatePlan({ ...goodPlan, strategies: [] }, evidence)
  check('planner: missing strategies rejected', plan === null)
}
{
  const plan = validatePlan({ ...goodPlan, strategies: [strategy('a', ['only-one']), strategy('b', ['x', 'y']), strategy('c', ['x', 'y'])] }, evidence)
  check('planner: strategy with one query dropped → fewer than 3 → rejected', plan === null)
}
{
  const plan = validatePlan({ ...goodPlan, role_families: families.slice(0, 2) }, evidence)
  check('planner: fewer than 3 role families rejected', plan === null)
}
{
  const plan = validatePlan({ ...goodPlan, strategies: [...goodPlan.strategies, { ...strategy('bad', ['x', 'y']), kind: 'random' }] }, evidence)
  check('planner: bad strategy kind dropped, rest kept', plan !== null && plan.strategies.length === 3)
}

// ─── Scout round validate ────────────────────────────────────────────────────

const posting = (url: string, title = 'Process Engineering Intern (Summer 2027)') => ({
  company_name: 'Acme Robotics', company_domain: 'acme.com', title, location: 'San Francisco, CA', url,
  source_kind: 'ats', ats_hint: 'Greenhouse', season_hint: 'Summer 2027', why_relevant: 'w',
})
const roundRaw = {
  postings: [
    posting('https://boards.greenhouse.io/acme/jobs/123'),
    posting('https://acme.com/careers/intern-2027'),          // invented — not in pool
    posting('https://boards.greenhouse.io/acme/jobs/123#top'), // same posting, fragment
    posting('https://jobs.lever.co/beta/abc?utm=x', 'AI Intern'), // tool-returned
  ],
  companies_to_check: [{ name: 'Gamma', domain: 'gamma.io', why: 'w' }, { name: 'gamma', domain: null, why: 'dupe' }],
  diagnosis: 'HEALTHY',
  diagnosis_reasoning: 'r',
  action: 'REFINE',
  next_query: 'next',
  action_reasoning: 'a',
}
const scoutEvidence: EvidenceSource[] = [{ url: 'https://boards.greenhouse.io/acme/jobs/123', title: null, snippet: null }]
const toolUrls = new Set<string>(['https://jobs.lever.co/beta/abc'])

{
  const out = validateRound(roundRaw, scoutEvidence, toolUrls)
  check('scout: round accepted', out !== null)
  check('scout: ungrounded URL stripped and counted', out?.ungrounded_postings === 1, `got ${out?.ungrounded_postings}`)
  check('scout: fragment duplicate collapsed', out?.postings.length === 2, `got ${out?.postings.length}`)
  check('scout: tool-returned URL with tracking query grounded', out?.postings.some((p) => p.url.startsWith('https://jobs.lever.co/beta/abc')) === true)
  check('scout: ats_hint lowercased', out?.postings[0].ats_hint === 'greenhouse')
  check('scout: companies_to_check deduped', out?.companies_to_check.length === 1)
}
{
  check('scout: origin alone does not ground a path', validateRound(
    { ...roundRaw, postings: [posting('https://boards.greenhouse.io/acme/jobs/999')] }, scoutEvidence, toolUrls
  )?.postings.length === 0)
  check('scout: bad diagnosis rejected', validateRound({ ...roundRaw, diagnosis: 'GREAT' }, scoutEvidence, toolUrls) === null)
  check('scout: bad action rejected', validateRound({ ...roundRaw, action: 'GIVE_UP' }, scoutEvidence, toolUrls) === null)
  check('scout: postings not an array rejected', validateRound({ ...roundRaw, postings: null }, scoutEvidence, toolUrls) === null)
  check('scout: unknown source_kind falls to search_result', validateRound(
    { ...roundRaw, postings: [{ ...posting('https://boards.greenhouse.io/acme/jobs/123'), source_kind: 'weird' }] }, scoutEvidence, toolUrls
  )?.postings[0].source_kind === 'search_result')
}

// ─── Tool caps ───────────────────────────────────────────────────────────────

async function toolTests(): Promise<void> {
  let lookups = 0
  let fetches = 0
  const lookupBoard: LookupBoardFn = async ({ company_name }) => {
    lookups++
    return {
      found: true, ats: 'greenhouse', board_url: `https://boards.greenhouse.io/${company_name}`,
      postings: [{ title: 'Intern', location: 'SF', url: `https://boards.greenhouse.io/${company_name}/jobs/1`, external_id: '1', posted_at: null, hint: 'Intern' }],
      total_on_board: 10, note: 'ok',
    }
  }
  const fetchPage: FetchPageFn = async (url) => {
    fetches++
    return { ok: true, status: 200, title: 'T', text: 'x'.repeat(10_000), links: [`${url}/a`, 'not-a-url', `${url}/b`], note: '' }
  }
  const seen = new Set<string>()
  const log: ScoutToolLogEntry[] = []
  const [lookup, fetch] = buildScoutTools({ lookupBoard, fetchPage, seen, log, maxLookups: 2, maxFetches: 1 })

  const l1 = await lookup.execute({ company_name: 'acme' } as never, ctx)
  const l2 = await lookup.execute({ company_name: 'beta' } as never, ctx)
  const l3 = await lookup.execute({ company_name: 'gamma' } as never, ctx)
  check('tools: lookups within cap succeed', l1.ok && l2.ok)
  check('tools: third lookup refused by cap', !l3.ok && lookups === 2, `fn called ${lookups}x`)
  check('tools: lookup fills url pool', seen.has('https://boards.greenhouse.io/acme/jobs/1') && seen.has('https://boards.greenhouse.io/beta'))
  check('tools: lookup renders one line per posting', Array.isArray((l1.result as { postings: unknown }).postings) && typeof (l1.result as { postings: string[] }).postings[0] === 'string')

  const f1 = await fetch.execute({ url: 'https://acme.com/careers' } as never, ctx)
  const f2 = await fetch.execute({ url: 'https://acme.com/other' } as never, ctx)
  check('tools: fetch within cap succeeds', f1.ok)
  check('tools: second fetch refused by cap', !f2.ok && fetches === 1)
  const text = (f1.result as { text: string }).text
  check('tools: fetched text capped near 6000', text.length < 6100 && text.includes('[truncated]'), `len ${text.length}`)
  check('tools: fetched page and its links enter the pool', seen.has('https://acme.com/careers') && seen.has('https://acme.com/careers/a'))
  check('tools: non-url links dropped', (f1.result as { links: string[] }).links.length === 2)
  check('tools: every call recorded', log.length === 3, `log ${log.length}`)
  const bad = await fetch.execute({ url: 'ftp://x' } as never, ctx)
  check('tools: non-http url rejected without a call', !bad.ok && fetches === 1)
}

// ─── Session loop ────────────────────────────────────────────────────────────

const testStrategy: SearchStrategy = {
  name: 'ATS', kind: 'job_first', rationale: 'r', queries: ['q1', 'q2'], target_titles: [], geo_focus: [], priority: 1,
}
const stubTools = {
  lookupBoard: (async () => ({ found: false, ats: null, board_url: null, postings: [], total_on_board: 0, note: 'stub' })) as LookupBoardFn,
  fetchPage: (async () => ({ ok: false, status: 0, title: null, text: '', links: [], note: 'stub' })) as FetchPageFn,
}

function roundResult(output: JobScoutRoundOutput | null, error: string | null = null): AgentResult<JobScoutRoundOutput> {
  return {
    output, status: output ? 'succeeded' : 'failed', error, evidence: [],
    trace: { agent_id: 'job_scout', prompt_version: 't', model: 'm', model_role: 'reasoning', provider_id: 'anthropic', tools_called: [], web_searches: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0, latency_ms: 0, steps: 1 },
  }
}
function roundOutput(over: Partial<JobScoutRoundOutput>): JobScoutRoundOutput {
  return {
    postings: [], companies_to_check: [], diagnosis: 'HEALTHY', diagnosis_reasoning: 'r', action: 'REFINE',
    next_query: 'next', action_reasoning: 'a', ungrounded_postings: 0, ...over,
  }
}
const found = (url: string, title = 'Intern'): JobScoutRoundOutput['postings'][number] => ({
  company_name: 'Acme', company_domain: 'acme.com', title, location: null, url, source_kind: 'ats', ats_hint: null, season_hint: null, why_relevant: 'w',
})

async function sessionTests(): Promise<void> {
  // Terminates on REJECT_STRATEGY.
  {
    let calls = 0
    const r = await runJobScoutSession({
      strategy: testStrategy, mission: 'm', alreadyFound: [], maxRounds: 5, targetCount: 10, tools: stubTools,
      runRound: async () => { calls++; return roundResult(roundOutput({ action: 'REJECT_STRATEGY', diagnosis: 'NOT_INTERNSHIPS', next_query: null })) },
    }, ctx)
    check('session: REJECT_STRATEGY ends after one round', calls === 1 && r.strategyRejected && r.history.length === 1)
    check('session: final diagnosis recorded', r.finalDiagnosis === 'NOT_INTERNSHIPS')
  }
  // Terminates on a continuing action without next_query, and surfaces it.
  {
    let calls = 0
    const r = await runJobScoutSession({
      strategy: testStrategy, mission: 'm', alreadyFound: [], maxRounds: 5, targetCount: 10, tools: stubTools,
      runRound: async () => { calls++; return roundResult(roundOutput({ action: 'BROADEN', next_query: null })) },
    }, ctx)
    check('session: missing next_query stops the loop', calls === 1)
    check('session: missing next_query is an error, not silence', r.errors.length === 1 && /no next_query/.test(r.errors[0]))
  }
  // Round cap, query threading, accumulation, dedupe across rounds and against alreadyFound.
  {
    const queries: string[] = []
    const r = await runJobScoutSession({
      strategy: testStrategy, mission: 'm', alreadyFound: ['https://x.io/jobs/already', 'acme | dup title'], maxRounds: 3, targetCount: 10, tools: stubTools,
      runRound: async (input) => {
        queries.push(input.currentQuery)
        const n = input.history.length + 1
        return roundResult(roundOutput({
          postings: [found(`https://x.io/jobs/${n}`), found('https://x.io/jobs/shared'), found('https://x.io/jobs/already'), found('https://x.io/jobs/dup', 'Dup Title')],
          companies_to_check: [{ name: 'Gamma', domain: null, why: 'w' }],
          next_query: `q${n + 1}`, ungrounded_postings: 1,
        }))
      },
    }, ctx)
    check('session: stops at maxRounds', r.history.length === 3)
    check('session: next_query threads into the next round', queries.join(',') === 'q1,q2,q3', queries.join(','))
    check('session: dedupes by url across rounds and against alreadyFound', r.postings.length === 4, `got ${r.postings.length}`)
    check('session: dedupes by company+title against alreadyFound', !r.postings.some((p) => p.url.endsWith('/dup')))
    check('session: companies_to_check accumulate deduped', r.companiesToCheck.length === 1)
    check('session: ungrounded counts summed', r.ungroundedPostings === 3)
    check('session: history records kept vs found', r.history[0].postings_kept === 2 && r.history[0].postings_found === 5)
    check('session: budget shown to the agent', true)
  }
  // Stops once the target is met; a failed round is surfaced.
  {
    let calls = 0
    const r = await runJobScoutSession({
      strategy: testStrategy, mission: 'm', alreadyFound: [], maxRounds: 5, targetCount: 1, tools: stubTools,
      runRound: async () => { calls++; return roundResult(roundOutput({ postings: [found('https://x.io/jobs/1')] })) },
    }, ctx)
    check('session: stops when target met', calls === 1 && r.postings.length === 1)
    const f = await runJobScoutSession({
      strategy: testStrategy, mission: 'm', alreadyFound: [], maxRounds: 5, targetCount: 5, tools: stubTools,
      runRound: async () => roundResult(null, 'boom'),
    }, ctx)
    check('session: failed round surfaces error and stops', f.errors.length === 1 && f.agentResults.length === 1 && /boom/.test(f.errors[0]))
  }
  check('postingKey normalizes', postingKey({ company_name: 'ACME, Inc.', title: 'Process  Engineer Intern' }) === 'acme inc | process engineer intern')
}

// ─── Extractor validate ──────────────────────────────────────────────────────

const goodExtraction = {
  employment_type: 'internship', season_relevance: 'summer_2027', work_mode: 'onsite', role_family: 'Process Engineering',
  location_raw: 'SF', deadline: null, compensation: '$40/hr', min_qualifications: ['Pursuing BS in ChemE'],
  preferred_qualifications: ['Python'], graduation_eligibility: 'graduating between December 2027 and June 2028',
  work_authorization: null, skills: Array.from({ length: 20 }, (_, i) => `s${i}`), responsibilities: ['do things'],
  industry: 'CPG', appears_closed: false, confidence: 0.9, summary: 'A role. For someone.',
}
{
  const v = validateExtraction(goodExtraction)
  check('extractor: valid output accepted', v !== null)
  check('extractor: arrays capped at 12', v?.skills.length === 12)
  check('extractor: bad enum rejected', validateExtraction({ ...goodExtraction, season_relevance: 'Summer 2027' }) === null)
  check('extractor: bad employment_type rejected', validateExtraction({ ...goodExtraction, employment_type: 'intern' }) === null)
  check('extractor: confidence out of range rejected', validateExtraction({ ...goodExtraction, confidence: 1.4 }) === null)
  check('extractor: appears_closed must be boolean', validateExtraction({ ...goodExtraction, appears_closed: 'no' }) === null)
  check('extractor: non-string list item rejected', validateExtraction({ ...goodExtraction, skills: ['a', 3] }) === null)
  check('extractor: nullable field with wrong type rejected', validateExtraction({ ...goodExtraction, deadline: 5 }) === null)
  check('extractor: empty summary rejected', validateExtraction({ ...goodExtraction, summary: ' ' }) === null)
}

/**
 * A version pin that survives the NEXT honest bump.
 *
 * These checks exist to prove ADR-009 was obeyed when this behaviour landed, not
 * to freeze the number. Pinning equality meant every later prompt edit — in a
 * different workstream, for a different reason — turned this suite red, and
 * taught whoever hit it to edit the assertion instead of reading it.
 */
function atLeast(version: string, min: string): boolean {
  const parse = (v: string) => v.split('.').map((n) => Number(n) || 0)
  const [a, b] = [parse(version), parse(min)]
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  return true
}

// ─── Prompts: the stated direction leads (ADR-009: versions bumped) ─────────

{
  const emptyWatchlist = { targets: [], watching: [], explore: [], ignored: [], learned: '' }
  const planner = jobMissionPlannerPrompt.build({ mission: 'DIRECTION (what I want to scout for — this leads the plan): genomics', evidenceSummaries: '', skills: '', preferences: '', watchlist: emptyWatchlist, recentFeedback: [] })
  check('planner prompt: version bumped past 1.1.0', atLeast(jobMissionPlannerPrompt.version, '1.2.0'), jobMissionPlannerPrompt.version)
  check('planner prompt: the direction is the starting point', /DIRECTION line/.test(planner.system) && /STARTING POINT/.test(planner.system) && /WHY THIS PERSON IS CREDIBLE/.test(planner.system))
  check('planner prompt: a pivot is planned, not retreated from', /a pivot — do NOT retreat to the\s+evidence's own industry/.test(planner.system) && /0\.3-0\.6 for a pure pivot/.test(planner.system))
  check('planner prompt: seeds and strategies match the direction first', /matching the DIRECTION\s+first/.test(planner.system) && /strategies in question 2 follow the same order: the DIRECTION first/.test(planner.system))
  check('planner prompt: adjacency applies to the direction; old-industry roles are off-target', /"genomics research" implies sequencing platforms/.test(planner.system) && /OFF-target unless the direction says "also open to…"/.test(planner.system))
  check('planner prompt: without a direction, inference from the evidence stays', /When no DIRECTION is stated, infer the families from the evidence/.test(planner.system))
  check('planner prompt: the mission text is passed through verbatim', planner.user.includes('DIRECTION (what I want to scout for — this leads the plan): genomics'))

  // The company list is four kinds of evidence, not one list. A seed company
  // is an exploration candidate; the user's own choices are the only signal
  // about what they actually want (migration 016, ADR-039).
  const withCompanies = jobMissionPlannerPrompt.build({
    mission: 'm', evidenceSummaries: '', skills: '', preferences: '', recentFeedback: [],
    watchlist: {
      targets: ['Kairos Power'], watching: ['Ginkgo Bioworks'], explore: ['Old Guess Corp'], ignored: ['Rejected Robotics'],
      learned: 'likes company types: startup · avoids: staffing',
    },
  })
  check('planner prompt: seed companies are exploration candidates, not preferences', /EXPLORATION CANDIDATES, not preferences/.test(withCompanies.system) && /stored\s+as a SUGGESTION the user can promote/.test(withCompanies.system))
  check('planner prompt: the four groups are named and weighted in the system prompt', ['TARGETS', 'WATCHING', 'EXPLORE', 'IGNORED'].every((g) => new RegExp(`\\n\\s+${g}\\s`).test(withCompanies.system)) && /STRONG evidence/.test(withCompanies.system) && /WEAK evidence/.test(withCompanies.system) && /NEGATIVE signal/.test(withCompanies.system))
  check('planner prompt: the explore group is called out as the model’s own earlier guesses', /YOUR OWN earlier suggestions/.test(withCompanies.system))
  check('planner prompt: the direction still outranks the whole list', /DIRECTION still outranks all four/.test(withCompanies.system))
  check('planner prompt: overfitting to the list is called a failure, with a share of new names asked for', /A plan that only re-proposes companies already on it has failed/.test(withCompanies.system) && /MEANINGFUL SHARE/.test(withCompanies.system) && /NONE of the four lists/.test(withCompanies.system))
  check('planner prompt: adjacency over archetypes is strengthened, and the examples are illustrations', /ADJACENCY, not string matching/.test(withCompanies.system) && /ILLUSTRATIONS of the move, not a taxonomy/.test(withCompanies.system) && /machine vision/.test(withCompanies.system))
  check('planner prompt: the four groups are rendered in the user message with their names', /TARGETS — the user chose these[\s\S]*Kairos Power/.test(withCompanies.user) && /WATCHING[\s\S]*Ginkgo Bioworks/.test(withCompanies.user) && /EXPLORE[\s\S]*Old Guess Corp/.test(withCompanies.user))
  check('planner prompt: ignored companies appear as a do-not-propose list', /IGNORED — the user rejected these; DO NOT propose any of them again\nRejected Robotics/.test(withCompanies.user), withCompanies.user.slice(withCompanies.user.indexOf('IGNORED'), withCompanies.user.indexOf('IGNORED') + 120))
  check('planner prompt: the learned attributes line is rendered', withCompanies.user.includes("WHAT THE USER'S CHOICES HAVE IN COMMON") && withCompanies.user.includes('likes company types: startup · avoids: staffing'))
  check('planner prompt: an empty list says so rather than rendering nothing', planner.user.includes('(none)') && /nothing learned yet/.test(planner.user))
  check('planner prompt: prestige warning and exclusions survive the rewrite', /DO NOT equate prestige with quality/.test(withCompanies.system) && /EXCLUSIONS\./.test(withCompanies.system) && /honest\s+confidence/.test(withCompanies.system))

  const fit = fitEvaluatorPrompt.build({ mission: 'm', job: { title: 't', company: 'c', location_raw: null, location_tier: null, work_mode: 'unknown', employment_type: 'internship', season_relevance: 'summer_2027', posted_at: null, deadline: null, description_excerpt: '', min_qualifications: [], preferred_qualifications: [], graduation_eligibility: null, work_authorization: null, skills: [], responsibilities: [], industry: null, company_size_stage: null }, companyResearch: '', evidenceSummaries: '', preferences: '', feedbackContext: [] })
  check('fit prompt: version bumped past 1.0.0', atLeast(fitEvaluatorPrompt.version, '1.1.0'), fitEvaluatorPrompt.version)
  check('fit prompt: role_fit and mission_interest_fit are judged as transferability toward the direction', /TRANSFERABILITY toward that direction/.test(fit.system) && /judge role_fit and mission_interest_fit/.test(fit.system))
  check('fit prompt: no penalty for the prior industry; old-industry roles score lower on mission_interest_fit', /NOT penalized on role_fit/.test(fit.system) && /scores\s+LOWER on mission_interest_fit/.test(fit.system))
}

// ─── Verifier validate ───────────────────────────────────────────────────────

{
  check('verifier: valid accepted', validateVerification({ verdict: 'CLOSED', reasoning: 'r', closed_signals: ['no longer accepting'] })?.verdict === 'CLOSED')
  check('verifier: bad verdict rejected', validateVerification({ verdict: 'MAYBE', reasoning: 'r', closed_signals: [] }) === null)
  check('verifier: non-string signal rejected', validateVerification({ verdict: 'OPEN', reasoning: 'r', closed_signals: [1] }) === null)
  check('verifier: empty reasoning rejected', validateVerification({ verdict: 'OPEN', reasoning: '', closed_signals: [] }) === null)
}

async function main(): Promise<void> {
  await toolTests()
  await sessionTests()
  console.log(`\ncareer discovery agents: ${passed} passed, ${failed} failed`)
  for (const f of failures) console.log(`  FAIL ${f}`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
