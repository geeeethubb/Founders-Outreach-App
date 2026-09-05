// Offline checks for the job-scout orchestration, resolution, batch
// verification and manual entry.
//
//   npx tsx scripts/test-career-scout.ts
//
// No network, no keys, no database: every agent, adapter, fetcher and store
// is a stub injected through the deps parameters. What is asserted is the
// orchestration — which stage sees what, what the deadline stops, what is
// verified by construction, what is rejected and why, what still persists.

import type { AgentResult } from '../lib/agents/runtime/types'
import type { JobMissionPlan } from '../lib/agents/job-mission-planner'
import type { JobScoutSessionResult } from '../lib/agents/job-scout/session'
import type { CompanyToCheck, ScoutedPosting } from '../lib/agents/job-scout'
import type { JobExtraction } from '../lib/agents/job-extractor'
import type { JobVerification } from '../lib/agents/job-verifier'
import { createSourceRegistry } from '../lib/career/sources/registry'
import type { FetchedPage, JobSourceAdapter, PageFetcher, RawJobPosting } from '../lib/career/sources/types'
import { DEFAULT_MISSION_PREFERENCES, defaultMission, renderMission, sanitizeMissionPatch, sanitizePreferences } from '../lib/career/missions/store'
import { emptyBank } from '../lib/career/evidence/store'
import type { CareerRun } from '../lib/career/runs'
import type { NormalizedJob } from '../lib/career/jobs/normalize'
import { buildPlannerWatchlist, directionMatches, directionPhrases, directionTerms, fallbackStrategies, runJobScout, selectJobsToRank, toWatched, type JobScoutDeps, type ScoutStore } from '../lib/career/scout/orchestrator'
import { terminalStatusFor } from '../lib/career/scout/run-record'
import type { PlannerWatchlist } from '../lib/agents/job-mission-planner'
// The run monitor's own parser, so "these counts are what the UI reads" is an
// assertion rather than a claim.
import { parseRunDetail } from '../app/dashboard/jobs/run-view'
import { runSummary } from '../app/dashboard/jobs/run-copy'
import { resolveScoutedPosting } from '../lib/career/scout/resolve'
import { emptyStats, summarizeStats } from '../lib/career/scout/stats'
import { constraintRejections, extractAndNormalize, orderForExtraction } from '../lib/career/scout/extract'
import { toFetchPageResult } from '../lib/career/scout/tools'
import { verifyJobs, type VerifiableRow, type VerifyStore } from '../lib/career/jobs/verify-batch'
import { addJobFromUrl, EXCLUDED_PLATFORM_MESSAGE } from '../lib/career/jobs/manual'
import type { ApplicationState, CareerMission, CareerMissionPreferences } from '../lib/career/types'

// renderMission() of the default mission, pinned verbatim: adding a direction
// must not change any other line an agent reads.
//
// Since migration 017 the shipped default names NO city: geography went from a
// built-in preference to a dial the user sets, and "no direction" renders as an
// instruction to explore broadly rather than as two coastal tiers. If a city
// reappears in this fixture, that is the bug — scripts/test-career-mission.ts
// defends the property directly.
const RENDERED_DEFAULT_MISSION = [
  'DIRECTION: none stated — explore broadly from the evidence. Do not assume a role family, an industry, or a place; infer what this person could plausibly do and search wide.',
  'OBJECTIVE: Find high-quality Summer 2027 internships where I will learn fast, own real work, and sit with intelligent colleagues on technically interesting, important problems — anywhere in the United States.',
  'SEASON: summer_2027',
  'LOCATIONS: ANYWHERE in the United States — no place preference. Where a role is neither counts for it nor against it. Do not put a city in a query and do not prefer one posting over another for where it is.',
  'COMPANY TYPES: high-quality startups, growth-stage technology companies, major industrial companies, energy / oil & gas, advanced manufacturing, industrial AI, chemicals, materials, CPG, healthcare, medical technology, pharma where relevant, robotics / automation, other technically interesting industries',
  'OPTIMIZE FOR (in order): learning > ownership > intelligent colleagues > technically interesting work > mentorship > exposure to important problems > professional growth > strong career optionality > company quality > mission relevance',
  'WORK MODES: onsite, hybrid, remote',
  'NOTES: Do not equate prestige with quality. Learn adjacent categories rather than filtering on these strings. Roles may span technical, engineering, technical strategy, product, industrial innovation, operations technology, AI/manufacturing, analytical, or cross-functional work — when no direction is stated, infer plausible roles from the evidence bank; when one is, it decides the roles and the evidence explains why I am credible for them.',
  'HARD CONSTRAINTS: Internships only; Not a different season; United States',
].join('\n')

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ─── Fixtures ────────────────────────────────────────────────────────────────

const USER = 'user-1'
const MISSION: CareerMission = { ...defaultMission(USER), id: 'mission-1', created_at: '', updated_at: '' }
const JD = 'We are hiring a Process Engineer Intern for Summer 2027 in our San Francisco pilot plant. You will own process improvement work, run experiments and present results. Requirements: pursuing a BS in chemical or mechanical engineering. '.repeat(3)

function raw(over: Partial<RawJobPosting>): RawJobPosting {
  return {
    source_type: 'greenhouse', source_url: 'https://boards.greenhouse.io/acme/jobs/1', external_id: '1', company_name: 'Acme', company_domain: 'acme.com',
    title: 'Process Engineer Intern', location_raw: 'San Francisco, CA', description_text: JD, description_html: null, department: null, posted_at: null, updated_at: null,
    apply_url: 'https://boards.greenhouse.io/acme/jobs/1', canonical_url: 'https://boards.greenhouse.io/acme/jobs/1', ats_type: 'greenhouse', ats_job_id: '1', requisition_id: null,
    employment_type_hint: 'Intern', raw: {}, retrieved_at: new Date().toISOString(), ...over,
  }
}
const ACME_INTERN = raw({})
const ACME_SENIOR = raw({ source_url: 'https://boards.greenhouse.io/acme/jobs/2', canonical_url: 'https://boards.greenhouse.io/acme/jobs/2', apply_url: 'https://boards.greenhouse.io/acme/jobs/2', external_id: '2', ats_job_id: '2', title: 'Senior Process Engineer', employment_type_hint: null, description_text: JD.replace(/Intern/g, 'Senior') })
const ACME_UK = raw({ source_url: 'https://boards.greenhouse.io/acme/jobs/3', canonical_url: 'https://boards.greenhouse.io/acme/jobs/3', apply_url: 'https://boards.greenhouse.io/acme/jobs/3', external_id: '3', ats_job_id: '3', title: 'Materials Intern', location_raw: 'London, United Kingdom' })

const fakeAdapter: JobSourceAdapter = {
  id: 'greenhouse', source_type: 'greenhouse', isAvailable: () => true,
  matchUrl(url) {
    const m = /boards\.greenhouse\.io\/([^/?#]+)(?:\/jobs\/(\d+))?/.exec(url)
    return m ? { board: { ats: 'greenhouse', identifier: m[1], board_url: `https://boards.greenhouse.io/${m[1]}` }, jobId: m[2] ?? null } : null
  },
  async detectBoard({ companyName }) {
    return /acme/i.test(companyName) ? { ats: 'greenhouse', identifier: 'acme', board_url: 'https://boards.greenhouse.io/acme' } : null
  },
  async listPostings(board, options) {
    if (board.identifier !== 'acme') return { postings: [], total_on_board: 0, board_url: null, note: 'unknown board' }
    const all = [ACME_INTERN, ACME_SENIOR, ACME_UK]
    const postings = options?.internshipsOnly ? all.filter((p) => /intern/i.test(p.title)) : all
    return { postings, total_on_board: all.length, board_url: 'https://boards.greenhouse.io/acme' }
  },
  async fetchPosting(_board, id) {
    const p = [ACME_INTERN, ACME_SENIOR, ACME_UK].find((x) => x.ats_job_id === id)
    return p ? { status: 'open', posting: p, note: 'fetched' } : { status: 'not_found', posting: null, note: '404' }
  },
}
const registry = createSourceRegistry([fakeAdapter])

const PAGES: Record<string, Partial<FetchedPage>> = {
  'https://www.beta.com/careers/mech-intern': { status: 200, title: 'Mechanical Engineering Intern - Beta', text: `Mechanical Engineering Intern at Beta in New York, NY. Summer 2027. ${JD}`, links: [] },
  'https://aggregator.example/job/1': { status: 200, title: 'Gamma internship', text: 'Aggregated listing', links: ['https://boards.greenhouse.io/acme/jobs/3', 'https://www.linkedin.com/jobs/1'] },
  'https://aggregator.example/job/2': { status: 200, title: 'Delta internship', text: 'Aggregated listing with no first-party link', links: ['https://aggregator.example/about'] },
  'https://acme.wd5.myworkdayjobs.com/en-US/careers/job/SF/Quality-Intern_R123': { status: 200, title: 'Quality Intern', text: `Quality Intern, Summer 2027, San Francisco. ${JD}`, links: [] },
  'https://www.beta.com/careers/closed': { status: 200, title: 'Closed', text: 'This position has been filled.', links: [] },
  'https://www.beta.com/careers/gone': { status: 404, title: null, text: '', links: [] },
  'https://www.beta.com/careers/vague': { status: 200, title: 'Careers', text: 'We hire great people. Come build with us.', links: [] },
}
const fetched: string[] = []
const fetcher: PageFetcher = {
  async fetch(url) {
    fetched.push(url)
    const p = PAGES[url]
    if (!p) return { url, final_url: url, status: 0, text: '', title: null, links: [], robots_blocked: false, error: 'no such fixture', retrieved_at: new Date().toISOString() }
    return { url, final_url: url, status: 200, text: '', title: null, links: [], robots_blocked: false, retrieved_at: new Date().toISOString(), ...p }
  },
}

function agentResult<T>(output: T | null, agentId: string, error: string | null = null): AgentResult<T> {
  return {
    output, status: output ? 'succeeded' : 'failed', error, evidence: [],
    trace: { agent_id: agentId, prompt_version: 'test', model: 'stub', model_role: 'fast', provider_id: 'stub', tools_called: [], web_searches: 1, tokens_in: 0, tokens_out: 0, cost_usd: 0.01, latency_ms: 1, steps: 1 },
  }
}
const PLAN: JobMissionPlan = {
  role_families: [{ name: 'process_engineering', rationale: '', example_titles: [], confidence: 0.8 }],
  strategies: [
    { name: 'Bay Area process interns', kind: 'job_first', rationale: '', queries: ['process engineer intern summer 2027 san francisco'], target_titles: [], geo_focus: ['SF'], priority: 0.9 },
    { name: 'Low priority', kind: 'job_first', rationale: '', queries: ['q2'], target_titles: [], geo_focus: [], priority: 0.2 },
  ],
  seed_companies: [{ name: 'Acme', domain: 'acme.com', why: 'already', company_type: 'startup', priority: 0.9, source_url: null, source_verified: false }, { name: 'Beta Robotics', domain: 'beta.com', why: 'robotics', company_type: 'startup', priority: 0.7, source_url: null, source_verified: false }],
  adjacent_categories: ['industrial AI'], exclusions: [], reasoning: 'x', dropped_non_operators: 0,
}
const SCOUTED: ScoutedPosting[] = [
  { company_name: 'Acme', company_domain: 'acme.com', title: 'Process Engineer Intern', location: 'San Francisco, CA', url: 'https://boards.greenhouse.io/acme/jobs/1', source_kind: 'ats', ats_hint: 'greenhouse', season_hint: 'Summer 2027', why_relevant: 'x' },
  { company_name: 'Acme', company_domain: 'acme.com', title: 'Senior Process Engineer', location: 'San Francisco, CA', url: 'https://boards.greenhouse.io/acme/jobs/2', source_kind: 'ats', ats_hint: 'greenhouse', season_hint: null, why_relevant: 'x' },
  { company_name: 'Beta', company_domain: 'beta.com', title: 'Mechanical Engineering Intern', location: 'New York, NY', url: 'https://www.beta.com/careers/mech-intern', source_kind: 'careers_page', ats_hint: null, season_hint: 'Summer 2027', why_relevant: 'x' },
  { company_name: 'Delta', company_domain: null, title: 'Delta internship', location: null, url: 'https://aggregator.example/job/2', source_kind: 'aggregator', ats_hint: null, season_hint: null, why_relevant: 'x' },
  { company_name: 'LinkedIn Co', company_domain: null, title: 'Intern', location: null, url: 'https://www.linkedin.com/jobs/view/1', source_kind: 'search_result', ats_hint: null, season_hint: null, why_relevant: 'x' },
]
function sessionResult(postings: ScoutedPosting[]): JobScoutSessionResult {
  return {
    postings, companiesToCheck: [{ name: 'Acme', domain: 'acme.com', why: 'seen' }, { name: 'Omega Labs', domain: null, why: 'mentioned' }], history: [{ round: 1, query_used: 'process engineer intern summer 2027', postings_found: postings.length, postings_kept: postings.length, postings_ungrounded: 0, diagnosis: 'HEALTHY', action: 'ACCEPT', note: '' }],
    strategyRejected: false, needsNewStrategy: false, finalDiagnosis: 'HEALTHY', agentResults: [agentResult({} as never, 'job_scout')], errors: [], toolLog: [], toolUrls: new Set(), ungroundedPostings: 0,
  }
}
const extractor = async (input: { title: string; text: string }): Promise<AgentResult<JobExtraction>> =>
  agentResult<JobExtraction>({
    employment_type: /intern/i.test(input.title) ? 'internship' : 'full_time', season_relevance: /2027/.test(input.text) ? 'summer_2027' : 'unknown', work_mode: 'onsite', role_family: null, location_raw: null,
    deadline: null, compensation: null, min_qualifications: ['BS in engineering'], preferred_qualifications: [], graduation_eligibility: null, work_authorization: null, skills: ['process'], responsibilities: [], industry: 'manufacturing', appears_closed: false, confidence: 0.9, summary: 's',
  }, 'job_extractor')
const verifier = async (): Promise<AgentResult<JobVerification>> => agentResult<JobVerification>({ verdict: 'OPEN', reasoning: 'title present', closed_signals: [] }, 'job_verifier')

interface Mem {
  /** Every DISTINCT job the store holds, in insertion order — `job-<index>` is its id. */
  jobs: NormalizedJob[]
  /** One entry per upsertJobs call: the batch it was handed. Incremental persistence is visible here. */
  batches: NormalizedJob[][]
  upserts: number
  /** Ordered record of what happened, so "persisted BEFORE the next stage" is assertable. */
  timeline: string[]
  watch: { name: string; source: string; status: string }[]
  checked: { id: string; status: string | null | undefined; openings: number }[]
  runs: { status: string; stats: Record<string, unknown> }[]
  traces: string[]
  refreshed: { id: string; status: string }[]
  ranked: { ids: string[]; skipResearch: boolean; deadlineMs: number; concurrency: number }[]
}
function memStore(opts: { watchlist?: Record<string, unknown>[]; ignored?: Record<string, unknown>[]; slowCheck?: number; rerun?: boolean } = {}): { store: ScoutStore; mem: Mem; rank: NonNullable<JobScoutDeps['rank']> } {
  const mem: Mem = { jobs: [], batches: [], upserts: 0, timeline: [], watch: [], checked: [], runs: [], traces: [], refreshed: [], ranked: [] }
  // The real store dedupes an incoming job against what it already holds (ATS
  // id, canonical URL, then company + title + location) — which is what makes
  // cross-batch dedupe correct now that a run persists in several batches. The
  // stub models exactly that; without it these tests would "prove" a dedupe
  // the production store does and the orchestrator no longer performs.
  const idByKey = new Map<string, string>()
  const keyOf = (j: NormalizedJob) => (j.ats_type && j.ats_job_id ? `${j.ats_type}:${j.ats_job_id}` : j.canonical_url ?? `${j.company_name}|${j.title}|${j.location_raw}`)
  // The post-scout ranking stub: records what it was asked, answers a fit for every id, costs a cent each.
  const rank: NonNullable<JobScoutDeps['rank']> = async (_u, ids, o) => {
    mem.ranked.push({ ids, skipResearch: o.skip.research, deadlineMs: o.deadlineMs, concurrency: o.concurrency })
    return { results: Object.fromEntries(ids.map((id) => [id, { fit: 0.7, eligibility: 'QUALIFIED', errors: [] }])), skipped: [], costUsd: 0.01 * ids.length, errors: [], runId: null }
  }
  const watchlist = opts.watchlist ?? []
  const run: CareerRun = {
    runId: 'run-1', migrationMissing: false, costUsd: () => 0.05, agentCalls: () => mem.traces.length,
    async trace(r) { mem.traces.push(r.trace.agent_id); return null },
    async finish(status, stats) { mem.runs.push({ status, stats }) },
  }
  const store: ScoutStore = {
    async getMission() { return { mission: MISSION, error: null, migrationMissing: false } },
    async loadBank() { return { bank: emptyBank(), migrationMissing: false, errors: [] } },
    async recentFeedback() { return [] },
    async startRun() { return run },
    async listWatchlist() { return { companies: watchlist, error: null, migrationMissing: false } },
    async listIgnoredCompanies() { return { companies: opts.ignored ?? [], error: null } },
    async listJobs() { return { jobs: [], error: null, migrationMissing: false } },
    async upsertJobs(_u, jobs) {
      mem.upserts++
      mem.batches.push(jobs)
      mem.timeline.push(`upsert:${jobs.length}`)
      let inserted = 0
      let updated = 0
      const ids: string[] = []
      for (const job of jobs) {
        const key = keyOf(job)
        const existing = idByKey.get(key)
        if (existing) {
          updated++
          ids.push(existing)
          continue
        }
        const id = `job-${mem.jobs.length}`
        idByKey.set(key, id)
        mem.jobs.push(job)
        ids.push(id)
        // rerun: every row already existed in the database, so the store
        // reports updates and no inserts.
        if (opts.rerun) updated++
        else inserted++
      }
      return { inserted, updated, skippedClosed: 0, ids, companyIds: {}, errors: [], migrationMissing: false }
    },
    async updateJobVerification(_u, id, result) { mem.refreshed.push({ id, status: result.status }); return { error: null } },
    async upsertWatch(_u, input) { mem.watch.push({ name: input.name, source: input.watch_source, status: input.watch_status }); return { id: `c-${input.name}`, error: null, migrationMissing: false } },
    async markCareersChecked(id, c) { if (opts.slowCheck) await sleep(opts.slowCheck); mem.checked.push({ id, status: c.status, openings: c.openings }); return { error: null } },
    async ensureCompany() { return { id: 'c-x', error: null, migrationMissing: false } },
  }
  return { store, mem, rank }
}

async function main() {
  // ─── A0. Re-run: ATS-listed rows already in the store get their verification refreshed ──
  console.log('orchestrator: re-run refresh')
  {
    const { store, mem, rank } = memStore({ rerun: true, watchlist: [{ id: 'c-acme', name: 'Acme', domain: 'acme.com', careers_url: null, ats_type: 'greenhouse', ats_identifier: 'acme', watch_status: 'target', watch_priority: 90 }] })
    const r = await runJobScout({ userId: USER, maxStrategies: 1 }, {
      store, rank, registry, fetcher, extractor, verifier,
      planner: async () => agentResult(PLAN, 'job_mission_planner'),
      session: async () => sessionResult(SCOUTED),
    })
    const listed = mem.jobs.filter((j) => j.verification_method === 'ats_listing')
    const listedIds = new Set(listed.map((j) => `job-${mem.jobs.indexOf(j)}`))
    check('re-run reports updates, not inserts', r.stats.jobs_updated > 0 && r.stats.jobs_inserted === 0)
    check('every ATS-listed job is refreshed to VERIFIED_OPEN on re-run', listed.length > 0 && mem.refreshed.length >= listed.length && mem.refreshed.every((x) => x.status === 'VERIFIED_OPEN'), `${listed.length} listed, ${mem.refreshed.length} refreshed`)
    check('only ATS-listed rows are refreshed; page-resolved ones are left to the verifier', mem.refreshed.every((x) => listedIds.has(x.id)) && mem.refreshed.length < mem.jobs.length + listed.length, JSON.stringify(mem.refreshed))
  }

  // ─── A. Full run ──────────────────────────────────────────────────────────
  console.log('orchestrator: full run')
  {
    const { store, mem, rank } = memStore({ watchlist: [{ id: 'c-acme', name: 'Acme', domain: 'acme.com', careers_url: null, ats_type: 'greenhouse', ats_identifier: 'acme', watch_status: 'target', watch_priority: 90 }] })
    fetched.length = 0
    let sessionCalls = 0
    const r = await runJobScout({ userId: USER, maxStrategies: 1 }, {
      store, rank, registry, fetcher, extractor, verifier,
      planner: async () => agentResult(PLAN, 'job_mission_planner'),
      session: async (p) => { sessionCalls++; mem.timeline.push(`session:${p.strategy.name}`); check('session receives the highest-priority strategy', p.strategy.name === 'Bay Area process interns'); check('session receives the run deadline', typeof p.deadline === 'number' && p.deadline > Date.now()); return sessionResult(SCOUTED) },
    })
    check('run succeeded', !r.migrationMissing && mem.runs[0]?.status === 'succeeded', JSON.stringify(r.errors))
    check('one session for maxStrategies 1', sessionCalls === 1)
    check('plan summarized', r.plan?.strategies.length === 2 && r.plan.seed_companies_count === 2)
    check('planner seeds new companies only', mem.watch.some((w) => w.name === 'Beta Robotics' && w.source === 'planner') && !mem.watch.some((w) => w.name === 'Acme' && w.source === 'planner'))
    // A company an agent found is a HYPOTHESIS: written `suggested`, with a
    // scout origin. Only the user's own click ever writes target/watching.
    check('scout companies_to_check are watched with source scout, known ones skipped', mem.watch.some((w) => w.name === 'Omega Labs' && w.source === 'scout') && !mem.watch.some((w) => w.name === 'Acme' && w.source === 'scout'))
    check('a scout-discovered company is written suggested, never target', mem.watch.find((w) => w.name === 'Omega Labs')?.status === 'suggested' && !mem.watch.some((w) => w.source === 'scout' && w.status !== 'suggested'), JSON.stringify(mem.watch))
    check('company-first checked Acme and found its two openings', mem.checked.some((c) => c.id === 'c-acme' && c.openings === 2))
    check('every agent result traced', mem.traces.includes('job_mission_planner') && mem.traces.includes('job_scout') && mem.traces.filter((t) => t === 'job_extractor').length >= 2)
    const acme = mem.jobs.find((j) => j.company_name === 'Acme' && /Process Engineer Intern/.test(j.title))
    check('ATS-listed posting is VERIFIED_OPEN by construction', acme?.verification_status === 'VERIFIED_OPEN' && acme.verification_method === 'ats_listing')
    // Company-first and job-first now persist in SEPARATE batches, so the
    // cross-batch dedupe is the store's find-existing match, not clustering:
    // one row, seen twice, reported as an update.
    check('company-first and job-first copies of the same posting collapse to one stored row', mem.jobs.filter((j) => j.canonical_url === 'https://boards.greenhouse.io/acme/jobs/1').length === 1 && r.stats.jobs_updated >= 1, `${r.stats.jobs_inserted} new, ${r.stats.jobs_updated} updated`)
    check('the result lists each stored job once', r.jobs.length === mem.jobs.length && new Set(r.jobs.map((j) => j.id)).size === r.jobs.length, `${r.jobs.length} result rows, ${mem.jobs.length} stored`)
    const beta = mem.jobs.find((j) => j.company_name === 'Beta')
    check('page-resolved posting went through verifyJob (its page was fetched twice: resolve + verify)', fetched.filter((u) => u === 'https://www.beta.com/careers/mech-intern').length === 2)
    check('page-resolved posting is LIKELY_OPEN via title coverage', beta?.verification_status === 'LIKELY_OPEN' && beta.verification_method === 'page', beta?.verification_note ?? '')
    const delta = mem.jobs.find((j) => j.company_name === 'Delta')
    check('unfollowed aggregator lead is stored UNVERIFIED with no canonical url', delta?.verification_status === 'UNVERIFIED' && delta.canonical_url === null)
    check('linkedin result excluded, not fetched', !fetched.some((u) => u.includes('linkedin')) && (r.stats.sources_consulted['resolve:excluded'] ?? 0) === 1)
    check('senior role rejected under "Internships only"', (r.stats.jobs_rejected['Internships only'] ?? 0) === 1 && r.rejected.some((x) => x.title === 'Senior Process Engineer'))
    check('UK role rejected under "United States"', (r.stats.jobs_rejected['United States'] ?? 0) === 1)
    check('rejected jobs are not persisted', !mem.jobs.some((j) => j.title === 'Senior Process Engineer'))
    // Incremental persistence: company-first is stored BEFORE the first
    // strategy runs, and each strategy is stored as it finishes.
    check('jobs persist in batches, not once at the end', mem.upserts >= 2 && r.stats.jobs_inserted === mem.jobs.length && mem.jobs.length === 3, `${mem.upserts} upserts, ${mem.jobs.length} jobs`)
    check('the company-first batch reached the store before the first scout session', mem.timeline[0]?.startsWith('upsert') && mem.timeline.indexOf('session:Bay Area process interns') > 0, mem.timeline.join(' → '))
    check('result jobs carry ids and source types', r.jobs.every((j) => j.id) && r.jobs.some((j) => j.source_types.includes('greenhouse')))
    check('stats: queries include planner and session queries', r.stats.queries.includes('process engineer intern summer 2027 san francisco') && r.stats.queries.includes('process engineer intern summer 2027'))
    check('stats: verification histogram sums to every job handed to the store', Object.values(r.stats.verification).reduce((a, b) => a + b, 0) === mem.batches.flat().length)
    check('stats: web searches and model calls counted', r.stats.web_searches >= 2 && r.stats.model_calls >= 4)
    check('post-scout ranking asked for every stored id, research skipped, within the deadline', mem.ranked.length === 1 && mem.ranked[0].ids.length === mem.jobs.length && mem.ranked[0].skipResearch && mem.ranked[0].deadlineMs > 0 && mem.ranked[0].deadlineMs < 270_000 && mem.ranked[0].concurrency === 3, JSON.stringify(mem.ranked))
    check('post-scout ranking puts the extracted, board-verified Summer 2027 intern first and the unverified lead last', mem.ranked[0]?.ids[0] === `job-${mem.jobs.indexOf(acme!)}` && mem.ranked[0]?.ids[mem.ranked[0].ids.length - 1] === `job-${mem.jobs.indexOf(delta!)}`, JSON.stringify(mem.ranked[0]?.ids))
    check('stats: ranked count and rank cost recorded', r.stats.jobs_ranked === mem.jobs.length && r.stats.rank_cost_usd === 0.03, `${r.stats.jobs_ranked} ranked, $${r.stats.rank_cost_usd}`)
    check('stats: cost from the run plus ranking', r.costUsd === 0.08 && mem.runs[0].stats.cost_usd === 0.08, `${r.costUsd}`)
    // The mission fixture is the SHIPPED default, and since migration 017 that
    // states no place preference at all — so nothing may stamp a geography tier
    // on a posting. (locationTier itself, and the tiers a dial writes, are
    // exercised in scripts/test-career-jobs.ts against the old tier fixture.)
    check('no geography tier is stamped when the mission prefers no place', acme?.location_tier == null && beta?.location_tier == null, `${acme?.location_tier} / ${beta?.location_tier}`)
    check('summarizeStats renders lines', summarizeStats(r.stats).length === 8 && summarizeStats(r.stats)[3].includes('Internships only'))
  }

  // ─── A1. Company selection by INTENT, with a rotating explore sample ──────
  // The company list is an input to the run, not its universe: the user's own
  // choices are checked first, and the scout's accumulated guesses get a
  // bounded, rotating share so they can never starve fresh discovery.
  console.log('orchestrator: company selection')
  {
    const co = (id: string, status: string, priority: number, checked: string | null) => ({ id, name: id, domain: null, careers_url: null, ats_type: null, ats_identifier: null, watch_status: status, watch_priority: priority, last_careers_check_at: checked })
    // Deliberately perverse priorities: the explore rows are the "most
    // important" by number, so only intent can put the targets first.
    const list: Record<string, unknown>[] = [
      co('E1', 'suggested', 99, '2026-01-01T00:00:00Z'),
      co('E2', 'suggested', 99, '2026-02-01T00:00:00Z'),
      co('E3', 'suggested', 99, '2026-03-01T00:00:00Z'),
      co('E4', 'suggested', 99, '2026-04-01T00:00:00Z'),
      co('E5', 'suggested', 99, '2026-05-01T00:00:00Z'),
      co('E6', 'suggested', 99, '2026-06-01T00:00:00Z'),
      co('W1', 'watching', 10, null),
      co('T1', 'target', 5, '2026-01-15T00:00:00Z'),
      co('T2', 'target', 5, null),
    ]
    const { store, mem, rank } = memStore({ watchlist: list })
    const params = { userId: USER, maxStrategies: 0, maxCompaniesFirst: 5, rank: false, concurrency: 1 }
    const deps: JobScoutDeps = { store, rank, registry, fetcher, extractor, verifier, planner: async () => agentResult(PLAN, 'job_mission_planner'), session: async () => { throw new Error('job-first must not run in this fixture') } }
    const r = await runJobScout(params, deps)
    const order = mem.checked.map((c) => c.id)
    check('selection: every target first, then watching, then explore — intent beats watch_priority', order.slice(0, 3).sort().join(',') === 'T1,T2,W1' && order.indexOf('T1') < order.indexOf('W1') && order.indexOf('W1') < order.indexOf('E1'), order.join(','))
    check('selection: explore never takes the whole budget', order.length === 5 && order.filter((n) => n.startsWith('E')).length === 2, order.join(','))
    check('selection: the least-recently-checked explore rows go first', order.includes('E1') && order.includes('E2') && !order.includes('E6'), order.join(','))
    check('selection: reported in stats by intent, with what was left over', JSON.stringify(r.stats.companies_selected) === JSON.stringify({ target: 2, watching: 1, suggested: 2, skipped: 4 }), JSON.stringify(r.stats.companies_selected))
    check('selection: a job-first floor is reserved and stated', r.stats.job_first_reserve_ms > 0 && r.stats.job_first_reserve_ms < 270_000, `${r.stats.job_first_reserve_ms}ms`)

    // Rotation: the run stamps a check date (markCareersChecked), so the next
    // run reaches the explore rows it did not get to last time.
    for (const row of list) if (mem.checked.some((c) => c.id === row.id)) row.last_careers_check_at = '2026-09-01T00:00:00Z'
    mem.checked.length = 0
    await runJobScout(params, deps)
    const second = mem.checked.map((c) => c.id)
    check('selection: explore rotates — the next run reaches different guesses', second.filter((n) => n.startsWith('E')).join(',') === 'E3,E4', second.join(','))
    check('selection: the user’s own choices are re-checked every run', second.filter((n) => !n.startsWith('E')).sort().join(',') === 'T1,T2,W1', second.join(','))

    // Nothing left for discovery is a diagnostic, not silence.
    const empty = memStore({ watchlist: [co('X1', 'ignored', 50, null)] })
    const er = await runJobScout({ ...params, maxCompaniesFirst: 0 }, { ...deps, store: empty.store, rank: empty.rank })
    check('selection: a run that checks no company says so', er.errors.some((e) => e.startsWith('company-first checked nothing')), er.errors.join(' | '))
    check('selection: an ignored company is never checked', empty.mem.checked.length === 0)
  }

  // ─── A1b. Whose choice was this row? ──────────────────────────────────────
  // `watch_status` alone cannot answer that: the old build wrote 'target' from
  // planner seeds and scout discoveries, and migration 016 is applied by hand.
  // `toWatched` resolves intent from `watch_source`, so the run behaves the same
  // before and after the migration — and the planner is never told that its own
  // earlier guesses are the user's preferences.
  console.log('orchestrator: stored intent')
  {
    const row = (over: Record<string, unknown>) => ({ id: 'x', name: 'X', domain: null, careers_url: null, ats_type: null, ats_identifier: null, watch_priority: 50, last_careers_check_at: null, company_type: null, industry_tags: null, ...over })
    const active = [
      toWatched(row({ id: 'u1', name: 'User Target', watch_status: 'target', watch_source: 'user', company_type: 'startup', industry_tags: ['advanced manufacturing'] })),
      toWatched(row({ id: 'u2', name: 'User Watching', watch_status: 'opening_available', watch_source: 'user' })),
      toWatched(row({ id: 'p1', name: 'Planner Guess', watch_status: 'target', watch_source: 'planner', company_type: 'bigco', industry_tags: ['aerospace'] })),
      toWatched(row({ id: 's1', name: 'Scout Guess', watch_status: 'target', watch_source: 'scout' })),
      toWatched(row({ id: 'g1', name: 'Legacy Guess', watch_status: 'suggested', watch_source: 'planner' })),
    ]
    const ignored = [toWatched(row({ id: 'i1', name: 'Rejected Co', watch_status: 'ignored', watch_source: 'user', company_type: 'consultancy' }))]
    const w = buildPlannerWatchlist(active, ignored, [])
    check('planner context: a user row is a target', w.targets.join(',') === 'User Target', w.targets.join(','))
    check('planner context: a legacy opening_available row is watching', w.watching.join(',') === 'User Watching', w.watching.join(','))
    check('planner context: a target an AGENT wrote is EXPLORE, never a preference', [...w.explore].sort().join(',') === 'Legacy Guess,Planner Guess,Scout Guess', w.explore.join(','))
    check('planner context: an ignored company is a do-not-propose list and nothing else', w.ignored.join(',') === 'Rejected Co' && !w.targets.includes('Rejected Co') && !w.watching.includes('Rejected Co') && !w.explore.includes('Rejected Co'))
    check('planner context: learned attributes come from the user’s choices, not the guesses', w.learned.includes('advanced manufacturing') && w.learned.includes('startup') && !w.learned.includes('aerospace'), w.learned)
    const none = buildPlannerWatchlist([toWatched(row({ id: 'p2', name: 'Only A Guess', watch_status: 'target', watch_source: 'planner' }))], [], [])
    check('planner context: nothing learned when the user has chosen nothing', none.learned === '' && none.targets.length === 0 && none.explore.join(',') === 'Only A Guess', JSON.stringify(none))

    // End to end, on the shape the live database actually holds: one row the
    // user chose and six an agent wrote as 'target'.
    const agentRow = (n: string, month: number) => row({ id: n, name: n, watch_status: 'target', watch_source: 'planner', watch_priority: 99, last_careers_check_at: `2026-0${month}-01T00:00:00Z` })
    const live: Record<string, unknown>[] = [
      row({ id: 'U1', name: 'U1', watch_status: 'target', watch_source: 'user', watch_priority: 5 }),
      agentRow('A1', 1), agentRow('A2', 2), agentRow('A3', 3), agentRow('A4', 4), agentRow('A5', 5), agentRow('A6', 6),
    ]
    const { store, mem, rank } = memStore({ watchlist: live })
    let seen: PlannerWatchlist = { targets: [], watching: [], explore: [], ignored: [], learned: '' }
    const r = await runJobScout({ userId: USER, maxStrategies: 0, maxCompaniesFirst: 3, rank: false, concurrency: 1 }, {
      store, rank, registry, fetcher, extractor, verifier,
      planner: async (input) => { seen = input.watchlist; return agentResult(PLAN, 'job_mission_planner') },
      session: async () => { throw new Error('job-first must not run in this fixture') },
    })
    check('pre-016 rows: the planner is told only the user chose U1', seen.targets.join(',') === 'U1' && seen.explore.length === 6 && seen.watching.length === 0, JSON.stringify({ t: seen.targets, e: seen.explore.length }))
    check('pre-016 rows: an agent’s "target" is budgeted as a guess', JSON.stringify(r.stats.companies_selected) === JSON.stringify({ target: 1, watching: 0, suggested: 2, skipped: 4 }), JSON.stringify(r.stats.companies_selected))
    check('pre-016 rows: the user’s row is checked first, then the least recently checked guesses', mem.checked.map((c) => c.id).join(',') === 'U1,A1,A2', mem.checked.map((c) => c.id).join(','))
  }

  // ─── A2. Incremental persistence ──────────────────────────────────────────
  // A run that dies must not lose what it paid for. Everything gathered before
  // a stage fails is already in the store when that stage throws.
  console.log('orchestrator: incremental persistence')
  {
    const { store, mem, rank } = memStore({ watchlist: [{ id: 'c-acme', name: 'Acme', domain: 'acme.com', careers_url: null, ats_type: 'greenhouse', ats_identifier: 'acme', watch_status: 'target', watch_priority: 90 }] })
    const seen: string[] = []
    const r = await runJobScout({ userId: USER, maxStrategies: 2, rank: false }, {
      store, rank, registry, fetcher, extractor, verifier,
      planner: async () => agentResult(PLAN, 'job_mission_planner'),
      session: async (p) => {
        seen.push(p.strategy.name)
        mem.timeline.push(`session:${p.strategy.name}`)
        if (seen.length === 1) throw new Error('board went away')
        return sessionResult(SCOUTED)
      },
    })
    check('a strategy that throws is surfaced, not swallowed', r.errors.some((e) => /board went away/.test(e)), r.errors.join(' | '))
    check('the company-first batch was already stored when the strategy threw', mem.timeline[0] === 'upsert:1' && mem.jobs.some((j) => j.canonical_url === 'https://boards.greenhouse.io/acme/jobs/1'), mem.timeline.join(' → '))
    check('the surviving strategy still persists its own batch afterwards', mem.upserts === 2 && mem.timeline[mem.timeline.length - 1].startsWith('upsert'), mem.timeline.join(' → '))
    check('a re-seen posting updates the row the earlier batch created', r.stats.jobs_updated >= 1 && mem.jobs.length === 3, `${mem.jobs.length} rows`)
  }

  // ─── A3. Progress counts ──────────────────────────────────────────────────
  console.log('orchestrator: progress counts')
  {
    const { store, mem, rank } = memStore({ watchlist: [{ id: 'c-acme', name: 'Acme', domain: 'acme.com', careers_url: null, ats_type: 'greenhouse', ats_identifier: 'acme', watch_status: 'target', watch_priority: 90 }] })
    const emitted: Record<string, number>[] = []
    // Every key is the name that number has where it is READ — run-view.ts and
    // run-copy.ts — so the monitor never has to guess which count it has.
    const CUMULATIVE = ['discovered', 'companies_checked', 'jobs_extracted', 'jobs', 'inserted', 'ranked', 'rejected']
    const KEYS = [...CUMULATIVE, 'verified_open', 'likely_open', 'closed']
    await runJobScout({ userId: USER, maxStrategies: 1, onProgress: (_s, _d, counts) => { if (counts) emitted.push(counts) } }, {
      store, rank, registry, fetcher, extractor, verifier,
      planner: async () => agentResult(PLAN, 'job_mission_planner'),
      session: async () => sessionResult(SCOUTED),
    })
    check('progress carries counts on every line', emitted.length > 5 && emitted.every((c) => KEYS.every((k) => typeof c[k] === 'number')), `${emitted.length} lines`)
    const monotonic = CUMULATIVE.every((k) => emitted.every((c, i) => i === 0 || c[k] >= emitted[i - 1][k]))
    check('progress counts only ever go up', monotonic, JSON.stringify(emitted[emitted.length - 1]))
    const last = emitted[emitted.length - 1]
    check('progress counts are the real funnel, not a timer', last.companies_checked >= 1 && last.discovered >= 3 && last.jobs_extracted >= 1 && last.jobs === mem.jobs.length && last.inserted === mem.jobs.length && last.rejected === 2 && last.ranked === mem.jobs.length, JSON.stringify(last))
    // Rows, not sightings: company-first and job-first both saw the Acme
    // posting, and it is one stored row with one verdict.
    const verdict = (s: string) => mem.jobs.filter((j) => j.verification_status === s).length
    check('verdict counts are distinct stored rows, not sightings', last.verified_open === verdict('VERIFIED_OPEN') && last.likely_open === verdict('LIKELY_OPEN') && last.closed === verdict('CLOSED') && last.verified_open <= last.jobs, JSON.stringify(last))
    // The names are not private to this file: this is the monitor's own parser.
    const parsed = parseRunDetail({ id: '11111111-1111-1111-1111-111111111111', status: 'running', counts: last })
    check('the run monitor reads the emitted counts by name', !!parsed && parsed.jobs.total === last.jobs && parsed.jobs.inserted === last.inserted && parsed.jobs.verified_open === last.verified_open && parsed.jobs.ranked === last.ranked, JSON.stringify(parsed?.jobs))
    const summary = parsed ? runSummary(parsed) : null
    check('the run summary reads discovered and rejected off the same payload', !!summary && summary.discovered === last.discovered && summary.rejected === last.rejected, JSON.stringify(summary))
  }

  // ─── B. Deadline ──────────────────────────────────────────────────────────
  console.log('orchestrator: deadline')
  {
    const { store, mem, rank } = memStore({ slowCheck: 30, watchlist: [
      { id: 'c-acme', name: 'Acme', domain: 'acme.com', careers_url: null, ats_type: 'greenhouse', ats_identifier: 'acme', watch_status: 'target', watch_priority: 90 },
      { id: 'c-beta', name: 'Beta', domain: 'beta.com', careers_url: null, ats_type: null, ats_identifier: null, watch_status: 'watching', watch_priority: 10 },
    ] })
    let sessionCalls = 0
    let extractCalls = 0
    const r = await runJobScout({ userId: USER, budget: { deadlineMs: 20 }, concurrency: 1 }, {
      store, rank, registry, fetcher, verifier,
      extractor: async (i) => { extractCalls++; return extractor(i) },
      planner: async () => agentResult(PLAN, 'job_mission_planner'),
      session: async () => { sessionCalls++; return sessionResult(SCOUTED) },
    })
    check('deadline hit is recorded', r.stats.deadline_hit && r.errors.some((e) => e.startsWith('deadline reached before')), r.errors.join(' | '))
    check('no scout session starts past the deadline', sessionCalls === 0)
    check('no extraction starts past the deadline', extractCalls === 0)
    check('second company not checked past the deadline', mem.checked.length === 1)
    check('jobs found before the deadline still persist (the UK one is constraint-rejected)', mem.upserts === 1 && mem.jobs.length === 1 && (r.stats.jobs_rejected['United States'] ?? 0) === 1, `${mem.jobs.length}`)
    check('unextracted ATS postings still VERIFIED_OPEN', mem.jobs.every((j) => j.verification_status === 'VERIFIED_OPEN'))
    check('run still finishes succeeded', mem.runs[0]?.status === 'succeeded')
    // The caller records it as `partial`: everything found is stored, but the
    // run did not get through the work it planned.
    check('a deadline-hit run reports itself partial', r.partial && r.stats.deadline_hit && (mem.runs[0]?.stats.deadline_hit as boolean), `partial=${r.partial}`)
    check('ranking is not started past the deadline, and says so', mem.ranked.length === 0 && r.errors.some((e) => e.startsWith('ranking skipped')) && r.stats.jobs_ranked === 0, r.errors.join(' | '))
  }

  // ─── B2. A sweep the clock cut is a DEADLINE hit, never "complete" ────────
  //
  // The live BROAD run of 2026-09-04: the planner's web-search call took 145 s
  // of a 280 s leg, so the sweep started with its share of the clock already
  // spent, checked 0 of 298 companies, said so in its own sentence — and the
  // run was closed "succeeded", cursor done, never to get its second pass.
  console.log('orchestrator: sweep cut by the clock')
  {
    const { store, rank } = memStore({ watchlist: [
      { id: 'c-acme', name: 'Acme', domain: 'acme.com', careers_url: null, ats_type: 'greenhouse', ats_identifier: 'acme', watch_status: 'target', watch_priority: 90 },
      { id: 'c-beta', name: 'Beta', domain: 'beta.com', careers_url: null, ats_type: null, ats_identifier: null, watch_status: 'watching', watch_priority: 10 },
    ] })
    const r = await runJobScout({ userId: USER, budget: { deadlineMs: 4_000 }, sweep: true, maxStrategies: 1, concurrency: 1 }, {
      store, rank, registry, fetcher, extractor, verifier,
      // Longer than the sweep's quarter of the run, shorter than the run.
      planner: async () => { await sleep(1_100); return agentResult(PLAN, 'job_mission_planner') },
      session: async () => sessionResult(SCOUTED),
    })
    check('the sweep says it stopped at its deadline with companies unchecked', r.errors.some((e) => /sweep stopped at its deadline with \d+ of \d+ companies unchecked/.test(e)), r.errors.join(' | '))
    check('no stage was refused outright — the run itself had time', !r.errors.some((e) => e.startsWith('deadline reached before')), r.errors.join(' | '))
    check('a sweep the clock cut is a deadline hit (DEFECT if false: the run is reported complete with the watchlist unswept)', r.stats.deadline_hit === true, `deadline_hit=${r.stats.deadline_hit}`)
    check('the run is partial and stopped by the deadline, not complete', r.partial === true && r.stopped === 'deadline', `partial=${r.partial} stopped=${r.stopped}`)
    check('the cursor leaves the sweep open and the run unfinished, so the next pass continues', !r.cursor.stages.includes('done') && !r.cursor.stages.includes('sweep'), JSON.stringify(r.cursor.stages))
    check('the row is recorded partial', terminalStatusFor({ migrationMissing: false, deadlineHit: r.stats.deadline_hit, errors: r.errors, partial: r.partial, stopped: r.stopped }) === 'partial')
  }

  // ─── B3. Company-first cut at its share of the clock leaves work: a DEADLINE hit ─
  //
  // The live BROAD run of 2026-09-04 also had "company-first stopped at its
  // share of the run; 42 companies not checked" in its errors — and was
  // closed "succeeded".
  console.log('orchestrator: company-first cut at its share')
  {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `c-many-${i}`, name: `Many Co ${i}`, domain: `many-${i}.example`, careers_url: null, ats_type: 'greenhouse', ats_identifier: `many-${i}`, watch_status: 'target', watch_priority: 50 }))
    const { store, rank } = memStore({ slowCheck: 160, watchlist: many })
    const r = await runJobScout({ userId: USER, budget: { deadlineMs: 6_000 }, maxStrategies: 1, concurrency: 1 }, {
      store, rank, registry, fetcher, extractor, verifier,
      planner: async () => agentResult(PLAN, 'job_mission_planner'),
      session: async () => sessionResult(SCOUTED),
    })
    check('company-first says it stopped at its share with companies unchecked', r.errors.some((e) => /company-first stopped at its share of the run .* companies not checked/.test(e)), r.errors.join(' | '))
    check('no stage was refused outright — the run itself had time', !r.errors.some((e) => e.startsWith('deadline reached before')), r.errors.join(' | '))
    check('a lane cut at its share is a deadline hit (DEFECT if false: the run is reported complete with companies unchecked)', r.stats.deadline_hit === true, `deadline_hit=${r.stats.deadline_hit}`)
    check('the run is partial, stopped by the deadline, cursor open for the next pass', r.partial === true && r.stopped === 'deadline' && !r.cursor.stages.includes('done') && !r.cursor.stages.includes('company-first'), `partial=${r.partial} stopped=${r.stopped} stages=${JSON.stringify(r.cursor.stages)}`)
  }

  // ─── B4. Extractions the clock refused leave work: a DEADLINE hit ─────────
  //
  // The same live run: four "extract …: run deadline: no time left for a
  // structured call" lines — the Anthropic client refusing inside the
  // finalisation reserve — recorded as per-posting failures on a run closed
  // "succeeded".
  console.log('orchestrator: extraction refused by the clock')
  {
    const { store, mem, rank } = memStore({ watchlist: [{ id: 'c-acme', name: 'Acme', domain: 'acme.com', careers_url: null, ats_type: 'greenhouse', ats_identifier: 'acme', watch_status: 'target', watch_priority: 90 }] })
    const r = await runJobScout({ userId: USER, maxStrategies: 1, concurrency: 1 }, {
      store, rank, registry, fetcher, verifier,
      extractor: async () => agentResult<JobExtraction>(null, 'job_extractor', 'run deadline: no time left for a structured call'),
      planner: async () => agentResult(PLAN, 'job_mission_planner'),
      session: async () => sessionResult(SCOUTED),
    })
    check('postings the clock kept unread are still stored', mem.jobs.length > 0, `${mem.jobs.length} stored`)
    check('the run says how many postings were not read because of the clock, once', r.errors.filter((e) => /not read before the run.s clock ran out/.test(e)).length >= 1 && !r.errors.some((e) => /^extract .*run deadline/.test(e)), r.errors.join(' | '))
    check('extractions refused by the clock are a deadline hit (DEFECT if false: the run is reported complete with postings unread)', r.stats.deadline_hit === true, `deadline_hit=${r.stats.deadline_hit}`)
    check('the run is partial and resumable', r.partial === true && r.stopped === 'deadline' && !r.cursor.stages.includes('done'), `partial=${r.partial} stopped=${r.stopped}`)
  }

  // ─── B1b. selectJobsToRank: the best 12, not the first 12 ─────────────────
  console.log('orchestrator: rank selection')
  {
    const j = (over: Partial<NormalizedJob>): NormalizedJob => ({ title: 'Process Engineer Intern', employment_type: 'internship', extraction_version: 'x', verification_status: 'VERIFIED_OPEN', season_relevance: 'summer_2027', location_tier: 1, ...over } as NormalizedJob)
    const best = j({})
    const thin = j({ extraction_version: null })
    const unverified = j({ verification_status: 'UNVERIFIED' })
    const otherSeason = j({ season_relevance: 'unspecified' })
    const tier3 = j({ location_tier: 3 })
    const noTier = j({ location_tier: null })
    const notIntern = j({ employment_type: 'unknown', title: 'Engineering Program' })
    // Fourteen rows in store order with the strongest candidates at the end — the old slice(0, 12) would have dropped them.
    const jobs = [thin, thin, unverified, otherSeason, tier3, noTier, notIntern, thin, unverified, tier3, noTier, thin, best, j({ location_tier: 2 })]
    const ids = jobs.map((_, i) => `job-${i}`)
    const picked = selectJobsToRank(jobs, ids, 12)
    check('selection: 12 of 14, the best (stored last) first', picked.length === 12 && picked[0] === 'job-12' && picked.includes('job-13'), picked.join(','))
    check('selection: preference order extracted > verified > season > tier > internship-like', picked.join(',') === 'job-12,job-6,job-13,job-4,job-9,job-5,job-10,job-3,job-2,job-8,job-0,job-1', picked.join(','))
    check('selection: thin unextracted rows are what gets dropped', !picked.includes('job-7') && !picked.includes('job-11'), picked.join(','))
    check('selection: ties keep store order', picked.indexOf('job-4') < picked.indexOf('job-9') && picked.indexOf('job-5') < picked.indexOf('job-10'))
    check('selection: fewer jobs than the cap → every id, best first', selectJobsToRank([thin, best], ['a', 'b'], 12).join(',') === 'b,a')
    check('selection: ids that do not line up with jobs fall back to store order', selectJobsToRank([best, thin], ['a'], 12).join(',') === 'a')
    // A stated direction reorders the pick: a posting that speaks its language
    // outranks an explicit Summer 2027 posting in the old industry, but never an
    // unextracted or unverified one. Without a direction nothing changes.
    {
      const direction = "Pivot into Life Sciences / genomic bio research — computational or wet-lab R&D internships where a chemical engineer's process, lab and data experience transfers."
      const terms = directionTerms(direction)
      check('direction terms: genomic / research / life science present', ['genomic', 'research', 'life'].every((t) => terms.has(t)), [...terms].join(','))
      check('direction terms: filler and credential words absent', !terms.has('into') && !terms.has('chemical') && !terms.has('engineer'), [...terms].join(','))
      const genomics = j({ title: 'Automation Scientist Intern', company_name: 'Ginkgo Bioworks', description_text: 'Genomic research in an autonomous lab', season_relevance: 'unspecified', location_tier: 2 })
      const nuclear = j({ title: 'Nuclear Engineering Internship - Summer 2027', company_name: 'Kairos Power', description_text: 'Reactor design', season_relevance: 'summer_2027', location_tier: 1 })
      const thinGenomics = j({ ...genomics, extraction_version: null })
      const unverifiedGenomics = j({ ...genomics, verification_status: 'UNVERIFIED' })
      const withDir = selectJobsToRank([nuclear, genomics, thinGenomics, unverifiedGenomics], ['n', 'g', 'tg', 'ug'], 12, direction)
      check('selection: direction-relevant posting ranks first despite no explicit season', withDir[0] === 'g', withDir.join(','))
      check('selection: an unextracted or unverified match never beats an extracted verified posting', withDir.indexOf('n') < withDir.indexOf('tg') && withDir.indexOf('n') < withDir.indexOf('ug'), withDir.join(','))
      const noDir = selectJobsToRank([nuclear, genomics], ['n', 'g'], 12)
      check('selection: without a direction the old order holds (season, then tier)', noDir.join(',') === 'n,g', noDir.join(','))
      check('selection: directionMatches counts terms in title/company/description', directionMatches(genomics, terms) >= 2 && directionMatches(nuclear, terms) === 0)
    }
  }

  // ─── B2. rank: false ─────────────────────────────────────────────────────
  console.log('orchestrator: rank off')
  {
    const { store, mem, rank } = memStore({ watchlist: [{ id: 'c-acme', name: 'Acme', domain: 'acme.com', careers_url: null, ats_type: 'greenhouse', ats_identifier: 'acme', watch_status: 'target', watch_priority: 90 }] })
    const r = await runJobScout({ userId: USER, maxStrategies: 1, rank: false }, { store, rank, registry, fetcher, extractor, verifier, planner: async () => agentResult(PLAN, 'job_mission_planner'), session: async () => sessionResult(SCOUTED) })
    check('rank: false never calls the batch', mem.ranked.length === 0 && r.stats.jobs_ranked === 0 && r.costUsd === 0.05)
  }

  // A failed planner must not remove job-first discovery. The eval saw one
  // schema-invalid plan turn a $4.71 run into "company-first only".
  console.log('orchestrator: planner failed')
  {
    const { store, rank, registry: reg, fetcher: f } = { ...memStore({ watchlist: [] }), registry, fetcher }
    const seen: string[] = []
    const r = await runJobScout({ userId: USER, maxStrategies: 2, rank: false }, {
      store, rank, registry: reg, fetcher: f, extractor, verifier,
      planner: async () => agentResult<JobMissionPlan>(null, 'job_mission_planner', 'submitted output failed schema validation'),
      session: async (p) => { seen.push(p.strategy.name); return sessionResult(SCOUTED) },
    })
    check('planner failure is surfaced', r.errors.some((e) => /planner/.test(e)) && r.plan === null)
    check('job-first still runs on the fallback strategies', seen.length === 2 && seen.every((n) => n.startsWith('fallback')))
    check('the fallback is labelled in errors', r.errors.some((e) => /deterministic fallback strategies/.test(e)))
    // Under the neutral default the fallback is NATIONWIDE. A deterministic
    // floor that quietly appended "San Francisco / Bay Area" to every query was
    // the product having a place preference nobody stated.
    const fb = fallbackStrategies({ season: 'summer_2027', preferences: DEFAULT_MISSION_PREFERENCES })
    check('fallback strategies carry the season', fb.every((s) => s.queries.some((q) => q.includes('Summer 2027'))))
    check('fallback strategies go nationwide when no place is preferred', fb.every((s) => s.geo_focus[0] === 'United States'), JSON.stringify(fb.map((s) => s.geo_focus)))
    check('no fallback query names a city the founder never asked for', !/San Francisco|New York|Boston|Seattle|Los Angeles|Washington DC/.test(JSON.stringify(fb)))
  }

  // ─── B2. The stated direction ─────────────────────────────────────────────
  // The founder describes what to scout for; it leads the rendered mission,
  // the fallback strategies, and (via --direction) one CLI run — never the row.
  console.log('mission: direction')
  {
    check('sanitizePreferences trims and collapses direction whitespace', sanitizePreferences({ direction: '  life  sciences /\n genomics   research ' }).direction === 'life sciences / genomics research')
    check('sanitizePreferences caps direction at 1500 chars', (sanitizePreferences({ direction: 'x'.repeat(2000) }).direction ?? '').length === 1500)
    const emoji = sanitizePreferences({ direction: 'a' + '😀'.repeat(1600) }).direction ?? ''
    check('sanitizePreferences caps by code point, never splitting a surrogate pair', Array.from(emoji).length === 1500 && emoji.length === 2999 && emoji.isWellFormed() && emoji.endsWith('😀'), `${emoji.length} units, ${Array.from(emoji).length} code points`)
    check('sanitizePreferences: empty / whitespace / missing / non-string direction → key omitted', !('direction' in sanitizePreferences({ direction: '   ' })) && !('direction' in sanitizePreferences({})) && !('direction' in sanitizePreferences({ direction: 42 as unknown as string })))
    check('DEFAULT_MISSION_PREFERENCES.direction is null', DEFAULT_MISSION_PREFERENCES.direction === null)

    const withoutDirection = renderMission(MISSION)
    check('renderMission without a direction is unchanged (fixture equality)', withoutDirection === RENDERED_DEFAULT_MISSION, withoutDirection)
    // "No direction" is no longer silence. Since 017 it is an instruction — the
    // widest search there is — and it is the FIRST thing an agent reads either way.
    check('renderMission without a direction says so, and says to explore broadly', withoutDirection.split('\n')[0].startsWith('DIRECTION: none stated — explore broadly from the evidence'))

    const DIRECTION = 'Life Sciences / genomic bio research — as a chemical engineer my experience is very transferable'
    const directed = renderMission({ ...MISSION, preferences: { ...MISSION.preferences, direction: DIRECTION } })
    const lines = directed.split('\n')
    // The direction line now says what the direction DOES, not just what it is:
    // BOOST is the default, and it means "search hardest here" — not "only this".
    check('renderMission with a direction puts DIRECTION first, and says it is a boost', lines[0] === `DIRECTION — BOOST (search hardest here, and still take strong adjacent postings): ${DIRECTION}` && lines[1].startsWith('OBJECTIVE: '), lines[0])
    check('renderMission with a direction relabels company types as default examples', directed.includes('COMPANY TYPES (default examples — the DIRECTION above takes precedence where they differ): high-quality startups'))
    check('renderMission with a direction otherwise renders the same lines', lines.slice(1).map((l) => l.replace(/^COMPANY TYPES \([^)]*\)/, 'COMPANY TYPES').replace(/^NOTES \([^)]*\)/, 'NOTES')).join('\n') === withoutDirection.split('\n').slice(1).join('\n'))

    check('directionPhrases: split on slashes / commas / and, filler and the credential clause dropped', directionPhrases(DIRECTION).join('|') === 'Life Sciences|genomic bio research', directionPhrases(DIRECTION).join('|'))
    check('directionPhrases: "pivot into", "I want" and "or" handled, capped at 4', directionPhrases('I want to pivot into quantum computing, synthetic biology or robotics, energy storage, semiconductors').join('|') === 'quantum computing|synthetic biology|robotics|energy storage')
    check('directionPhrases: null / empty → none', directionPhrases(null).length === 0 && directionPhrases('').length === 0)
    check('directionPhrases: two-letter acronyms survive (AI/ML), lowercase fragments do not', directionPhrases('Robotics, and also open to AI/ML; fintech, or so').join('|') === 'Robotics|AI|ML|fintech', directionPhrases('Robotics, and also open to AI/ML; fintech, or so').join('|'))

    const fb = fallbackStrategies({ season: 'summer_2027', preferences: { ...DEFAULT_MISSION_PREFERENCES, direction: DIRECTION } })
    check('fallback with a direction: the direction strategy comes first, at priority 0.6, job_first', fb[0].name === 'fallback · stated direction' && fb[0].priority === 0.6 && fb[0].kind === 'job_first' && fb.length === 3)
    check('fallback with a direction: a season query and an ATS-scoped query per phrase, none empty', fb[0].queries.length === 4 && fb[0].queries.includes('Life Sciences "Summer 2027" internship') && fb[0].queries.some((q) => q.startsWith('genomic bio research intern "Summer 2027" site:')) && fb[0].queries.every((q) => q.trim().length > 10), fb[0].queries.join(' | '))
    check('fallback with a direction: target titles are the phrases + Intern', fb[0].target_titles.join('|') === 'Life Sciences Intern|genomic bio research Intern')
    check('fallback without a direction is unchanged (two strategies)', fallbackStrategies({ season: 'summer_2027', preferences: DEFAULT_MISSION_PREFERENCES }).length === 2)

    // directionOverride: the planner sees it; the mission object does not change.
    const { store, rank, registry: reg, fetcher: f } = { ...memStore({ watchlist: [] }), registry, fetcher }
    const before = JSON.stringify(MISSION)
    let seenMission = ''
    const progressLines: string[] = []
    const seenStrategies: { name: string; queries: string[] }[] = []
    let rankCalls = 0
    const r = await runJobScout({ userId: USER, maxStrategies: 1, directionOverride: '  computational biology  ', onProgress: (s, d) => progressLines.push(`${s}: ${d}`) }, {
      store, rank: async (...args) => { rankCalls++; return rank(...args) }, registry: reg, fetcher: f, extractor, verifier,
      planner: async (input) => { seenMission = input.mission; return agentResult<JobMissionPlan>(null, 'job_mission_planner', 'x') },
      session: async (p) => { seenStrategies.push({ name: p.strategy.name, queries: p.strategy.queries }); return sessionResult([]) },
    })
    check('directionOverride reaches the planner as the first mission line', seenMission.startsWith('DIRECTION — BOOST (search hardest here, and still take strong adjacent postings): computational biology\n'), seenMission.split('\n')[0])
    check('directionOverride does not touch the mission object', JSON.stringify(MISSION) === before && MISSION.preferences.direction == null)
    check('progress says which direction the plan started from', progressLines.some((l) => l === 'plan: planning from your direction: computational biology'), progressLines.join(' | '))
    check('directionOverride reaches the fallback strategies too', seenStrategies[0]?.name === 'fallback · stated direction' && seenStrategies[0].queries.some((q) => q.includes('computational biology')), JSON.stringify(seenStrategies))
    check('directionOverride: the fallback ran because the planner failed', r.errors.some((e) => /fallback/.test(e)))
    check('directionOverride: nothing ranked when nothing was stored', rankCalls === 0)
    {
      // A run that DOES store jobs: ranking must be skipped and said, never run
      // against a direction that was never saved (fit rows persist per mission).
      const w = memStore({ watchlist: [{ id: 'c-acme', name: 'Acme', domain: 'acme.com', careers_url: null, ats_type: 'greenhouse', ats_identifier: 'acme', watch_status: 'target', watch_priority: 90 }] })
      const rr = await runJobScout({ userId: USER, maxStrategies: 1, directionOverride: 'computational biology' }, { store: w.store, rank: w.rank, registry, fetcher, extractor, verifier, planner: async () => agentResult(PLAN, 'job_mission_planner'), session: async () => sessionResult(SCOUTED) })
      check('directionOverride: jobs are stored but the ranking batch is never called', w.mem.jobs.length === 3 && w.mem.ranked.length === 0 && rr.stats.jobs_ranked === 0, `${w.mem.jobs.length} jobs, ${w.mem.ranked.length} rank calls`)
      check('directionOverride: the skipped ranking is surfaced, not hidden', rr.errors.some((e) => e.startsWith('ranking skipped: --direction is not applied to fit')), rr.errors.join(' | '))
    }
    const undirected: string[] = []
    await runJobScout({ userId: USER, maxStrategies: 1, rank: false, onProgress: (s, d) => undirected.push(`${s}: ${d}`) }, {
      store, rank, registry: reg, fetcher: f, extractor, verifier,
      planner: async () => agentResult<JobMissionPlan>(null, 'job_mission_planner', 'x'),
      session: async () => sessionResult([]),
    })
    check('progress says when no direction is stated', undirected.includes('plan: planning from the evidence (no direction stated)'), undirected.join(' | '))

    // A partial preferences patch merges over the stored preferences.
    const patched = sanitizeMissionPatch({ preferences: { direction: 'genomics' } }, MISSION.preferences).preferences as CareerMissionPreferences
    check('sanitizeMissionPatch merges a partial preferences patch over the base', patched.direction === 'genomics' && patched.company_types.length === MISSION.preferences.company_types.length && patched.notes === MISSION.preferences.notes)
    check('sanitizeMissionPatch without a base takes the patch whole (lists empty)', (sanitizeMissionPatch({ preferences: { direction: 'genomics' } }).preferences as CareerMissionPreferences).company_types.length === 0)
  }

  // ─── C. Migration missing ─────────────────────────────────────────────────
  console.log('orchestrator: migration missing')
  {
    const { store } = memStore()
    store.getMission = async () => ({ mission: null, error: 'migration 014_career_os.sql has not been applied', migrationMissing: true })
    const r = await runJobScout({ userId: USER }, { store, registry, fetcher })
    check('migrationMissing surfaces without touching agents', r.migrationMissing && r.runId === null)
  }

  // ─── D. resolve.ts routing ────────────────────────────────────────────────
  console.log('resolve')
  {
    const deps = () => ({ registry, fetcher, stats: emptyStats(), fetchBudget: { left: 5 }, companiesToCheck: [] as CompanyToCheck[] })
    const sp = (over: Partial<ScoutedPosting>): ScoutedPosting => ({ company_name: 'Acme', company_domain: 'acme.com', title: 'X', location: null, url: '', source_kind: 'search_result', ats_hint: null, season_hint: null, why_relevant: '', ...over })
    let d = deps()
    let r = await resolveScoutedPosting(sp({ url: 'https://boards.greenhouse.io/acme/jobs/3' }), d)
    check('ATS posting URL → adapter record', r.outcome === 'ats_fetched' && r.posting?.ats_job_id === '3' && d.fetchBudget.left === 5)
    d = deps()
    r = await resolveScoutedPosting(sp({ url: 'https://boards.greenhouse.io/acme' }), d)
    check('board URL → null + company to check', r.outcome === 'board_url' && r.posting === null && d.companiesToCheck[0]?.name === 'Acme')
    d = deps()
    r = await resolveScoutedPosting(sp({ url: 'https://acme.wd5.myworkdayjobs.com/en-US/careers/job/SF/Quality-Intern_R123', title: 'Quality Intern' }), d)
    check('workday URL with no adapter in scope → careers_page posting that keeps its family', r.outcome === 'other_ats_page' && r.posting?.ats_type === 'workday' && r.posting.source_type === 'careers_page' && r.posting.canonical_url === 'https://acme.wd5.myworkdayjobs.com/en-US/careers/job/SF/Quality-Intern_R123')
    d = deps()
    r = await resolveScoutedPosting(sp({ url: 'https://aggregator.example/job/1', source_kind: 'aggregator', title: 'Materials Intern' }), d)
    check('aggregator with an ATS link → followed to the first-party record', r.outcome === 'aggregator_followed' && r.posting?.ats_job_id === '3' && d.fetchBudget.left === 4)
    d = deps()
    r = await resolveScoutedPosting(sp({ url: 'https://aggregator.example/job/2', source_kind: 'aggregator' }), d)
    check('aggregator without a link → lead with canonical_url null', r.outcome === 'aggregator_lead' && r.posting?.source_type === 'aggregator' && r.posting.canonical_url === null && r.posting.source_url === 'https://aggregator.example/job/2')
    d = deps()
    r = await resolveScoutedPosting(sp({ url: 'https://www.beta.com/careers/mech-intern', source_kind: 'search_result', company_name: 'Beta' }), d)
    check('plain page → web_search posting with page text', r.outcome === 'page' && r.posting?.source_type === 'web_search' && (r.posting.description_text ?? '').length > 200)
    d = deps()
    d.fetchBudget.left = 0
    r = await resolveScoutedPosting(sp({ url: 'https://www.beta.com/careers/mech-intern' }), d)
    check('page fetch refused when the budget is spent', r.outcome === 'budget' && r.posting === null)
    d = deps()
    r = await resolveScoutedPosting(sp({ url: 'https://www.beta.com/careers/gone' }), d)
    check('404 page → failed, nothing stored', r.outcome === 'failed' && r.posting === null)
    r = await resolveScoutedPosting(sp({ url: 'https://www.indeed.com/viewjob?jk=1' }), d)
    check('indeed excluded', r.outcome === 'excluded')
    check('stats count seen and resolved', d.stats.postings_seen === 2 && d.stats.postings_resolved === 0)
  }

  // ─── E. extract.ts ────────────────────────────────────────────────────────
  console.log('extract')
  {
    const ordered = orderForExtraction([ACME_SENIOR, raw({ title: 'Analyst', employment_type_hint: null, description_text: 'x'.repeat(5000) }), ACME_INTERN])
    check('internship-like titles extract first, then longest text', ordered[0].title === 'Process Engineer Intern' && ordered[1].title === 'Analyst')
    let calls = 0
    const ex = await extractAndNormalize([ACME_INTERN, ACME_SENIOR, raw({ title: 'Tiny', description_text: 'short', source_url: 'https://x/1', canonical_url: 'https://x/1' })], {
      mission: MISSION, ctx: { user_id: USER, run_id: null, budget: { maxCompanies: 0, maxPeoplePerCompany: 0, maxApolloCalls: 0, maxWebSearches: 0, maxAgentSteps: 1 } },
      maxExtract: 1, extractor: async (i) => { calls++; return extractor(i) },
    })
    check('maxExtract caps agent calls; short text is never sent', calls === 1 && ex.extracted === 1)
    check('unextracted postings are still normalized (thin row, not dropped)', ex.jobs.length + ex.rejected.length === 3)
    const unspecified = { ...ex.jobs[0], season_relevance: 'unspecified' as const }
    check('season unspecified is not rejected', constraintRejections(unspecified, MISSION.hard_constraints).length === 0)
    const unknownIntern = { ...ex.jobs[0], employment_type: 'unknown' as const, title: 'Engineering Intern' }
    check('employment_type unknown with an intern title is not rejected', constraintRejections(unknownIntern, MISSION.hard_constraints).length === 0)
    const unknownPlain = { ...ex.jobs[0], employment_type: 'unknown' as const, title: 'Engineer' }
    check('employment_type unknown without an intern title IS rejected', constraintRejections(unknownPlain, MISSION.hard_constraints).some((f) => f.label === 'Internships only'))
    const closed = await extractAndNormalize([ACME_INTERN], { mission: MISSION, ctx: { user_id: USER, run_id: null, budget: { maxCompanies: 0, maxPeoplePerCompany: 0, maxApolloCalls: 0, maxWebSearches: 0, maxAgentSteps: 1 } }, extractor: async (i) => { const r = await extractor(i); r.output!.appears_closed = true; return r } })
    check('appears_closed is rejected with its own reason', closed.jobs.length === 0 && closed.rejected[0]?.reason === 'appears_closed')
  }

  // ─── F. tools.ts fetch mapping ────────────────────────────────────────────
  console.log('tools')
  {
    const blocked = toFetchPageResult({ url: 'u', final_url: 'u', status: 0, text: '', title: null, links: [], robots_blocked: true, error: 'x', retrieved_at: '' })
    check('robots-blocked page → ok=false with the policy note', !blocked.ok && blocked.note === 'blocked by robots/policy')
    const ok = toFetchPageResult({ url: 'u', final_url: 'u', status: 200, text: 'x'.repeat(9000), title: 't', links: ['https://a', 'mailto:x', 'https://b'], robots_blocked: false, retrieved_at: '' })
    check('ok page text capped at 6000 and links http-only', ok.ok && ok.text.length === 6000 && ok.links.length === 2)
  }

  // ─── G. verify-batch ──────────────────────────────────────────────────────
  console.log('verify-batch')
  {
    const rows: VerifiableRow[] = [
      { id: 'j1', title: 'Mechanical Engineering Intern', company_name: 'Beta', ats_type: null, ats_job_id: null, canonical_url: 'https://www.beta.com/careers/gone', apply_url: null, verification_status: 'LIKELY_OPEN', last_verified_at: null },
      { id: 'j2', title: 'Quality Intern', company_name: 'Beta', ats_type: null, ats_job_id: null, canonical_url: 'https://www.beta.com/careers/closed', apply_url: null, verification_status: 'LIKELY_OPEN', last_verified_at: null },
      { id: 'j3', title: 'Robotics Intern', company_name: 'Beta', ats_type: null, ats_job_id: null, canonical_url: 'https://www.beta.com/careers/vague', apply_url: null, verification_status: 'UNVERIFIED', last_verified_at: null },
      { id: 'j4', title: 'Process Engineer Intern', company_name: 'Acme', ats_type: 'greenhouse', ats_job_id: '1', canonical_url: 'https://boards.greenhouse.io/acme/jobs/1', apply_url: null, verification_status: 'STALE', last_verified_at: null },
      { id: 'j5', title: 'Old Intern', company_name: 'Beta', ats_type: null, ats_job_id: null, canonical_url: 'https://www.beta.com/careers/unreachable', apply_url: null, verification_status: 'LIKELY_OPEN', last_verified_at: new Date(Date.now() - 30 * 86400_000).toISOString() },
      { id: 'j6', title: 'Gone Intern', company_name: 'Acme', ats_type: 'greenhouse', ats_job_id: '99', canonical_url: 'https://boards.greenhouse.io/acme/jobs/99', apply_url: null, verification_status: 'VERIFIED_OPEN', last_verified_at: null },
    ]
    const updates: Record<string, string> = {}
    const transitions: { id: string; to: ApplicationState; actor: string; note: string }[] = []
    const apps = [
      { id: 'a1', job_id: 'j1', state: 'SAVED' as ApplicationState },
      { id: 'a2', job_id: 'j2', state: 'APPLIED' as ApplicationState },
      { id: 'a6', job_id: 'j6', state: 'READY_TO_APPLY' as ApplicationState },
    ]
    const store: VerifyStore = {
      async listCandidates(_u, scope) { return { jobs: scope === 'ids' ? rows.slice(0, 1) : rows, error: null, migrationMissing: false } },
      async updateJobVerification(_u, id, result) { updates[id] = result.status; return { error: null } },
      async applicationsForJobs(_u, ids) { return apps.filter((a) => ids.includes(a.job_id)) },
      async transitionApplication(_u, id, to, opts) { transitions.push({ id, to, actor: opts.actor, note: opts.note }); return { ok: true, error: null } },
    }
    let verifierCalls = 0
    const r = await verifyJobs(USER, { scope: 'all', store, registry, fetcher, verifier: async () => { verifierCalls++; return verifier() }, ctx: { user_id: USER, run_id: null, budget: { maxCompanies: 0, maxPeoplePerCompany: 0, maxApolloCalls: 0, maxWebSearches: 0, maxAgentSteps: 1 } } })
    check('all candidates checked', r.checked === 6, JSON.stringify(r.errors))
    check('404 page → CLOSED', updates.j1 === 'CLOSED')
    check('closed banner → CLOSED', updates.j2 === 'CLOSED')
    check('ambiguous page → verifier → OPEN maps to LIKELY_OPEN', updates.j3 === 'LIKELY_OPEN' && verifierCalls === 1)
    check('ATS presence → VERIFIED_OPEN (STALE recovers)', updates.j4 === 'VERIFIED_OPEN')
    check('unreachable and past the window → STALE', updates.j5 === 'STALE')
    check('ATS 404 → CLOSED', updates.j6 === 'CLOSED')
    check('changed rows reported with from/to', r.changed.some((c) => c.id === 'j1' && c.from === 'LIKELY_OPEN' && c.to === 'CLOSED') && r.changed.length === 6)
    check('tracked SAVED application flips to CLOSED by the system', transitions.some((t) => t.id === 'a1' && t.to === 'CLOSED' && t.actor === 'system' && t.note === 'posting closed'))
    check('READY_TO_APPLY application also closes', transitions.some((t) => t.id === 'a6'))
    check('APPLIED application is never touched', !transitions.some((t) => t.id === 'a2'))
    check('applicationsClosed reported', r.applicationsClosed.length === 2 && r.applicationsClosed.some((a) => a.from === 'SAVED'))
    const one = await verifyJobs(USER, { scope: 'ids', ids: ['j1'], store, registry, fetcher, ctx: { user_id: USER, run_id: null, budget: { maxCompanies: 0, maxPeoplePerCompany: 0, maxApolloCalls: 0, maxWebSearches: 0, maxAgentSteps: 1 } } })
    check('scope ids verifies just that job and returns its result row', one.checked === 1 && one.results[0]?.id === 'j1' && one.results[0].status === 'CLOSED')
  }

  // ─── H. manual.ts ─────────────────────────────────────────────────────────
  console.log('manual')
  {
    const ctx = { user_id: USER, run_id: null, budget: { maxCompanies: 0, maxPeoplePerCompany: 0, maxApolloCalls: 0, maxWebSearches: 0, maxAgentSteps: 1 } }
    const stored: NormalizedJob[] = []
    let dispo: string | null = null
    const deps = {
      registry, fetcher, extractor, verifier,
      upsertJobs: async (_u: string, jobs: NormalizedJob[]) => { stored.push(...jobs); return { inserted: 1, updated: 0, skippedClosed: 0, ids: ['job-m'], companyIds: {}, errors: [], migrationMissing: false } },
      setDisposition: async (_u: string, _id: string, d: string) => { dispo = d; return { error: null } },
    }
    const li = await addJobFromUrl(USER, 'https://www.linkedin.com/jobs/view/12345', { mission: MISSION, ctx }, deps)
    check('linkedin URL refused with the manual-entry message', li.error === EXCLUDED_PLATFORM_MESSAGE && li.jobId === null)
    const hs = await addJobFromUrl(USER, 'https://app.joinhandshake.com/jobs/1', { mission: MISSION, ctx }, deps)
    check('handshake URL refused', hs.error === EXCLUDED_PLATFORM_MESSAGE)
    const bad = await addJobFromUrl(USER, 'not a url', { mission: MISSION, ctx }, deps)
    check('garbage refused', bad.error !== null && stored.length === 0)
    const board = await addJobFromUrl(USER, 'https://boards.greenhouse.io/acme', { mission: MISSION, ctx }, deps)
    check('board URL refused (not a single posting)', board.error !== null && stored.length === 0)
    const ats = await addJobFromUrl(USER, 'https://boards.greenhouse.io/acme/jobs/3', { mission: MISSION, ctx }, deps)
    check('ATS posting added, VERIFIED_OPEN, saved', ats.jobId === 'job-m' && ats.job?.verification_status === 'VERIFIED_OPEN' && dispo === 'saved', ats.error ?? '')
    check('hard-constraint failure is a warning, not a rejection', ats.warnings.some((w) => w.includes('United States')) && stored.length === 1)
    const page = await addJobFromUrl(USER, 'https://www.beta.com/careers/mech-intern', { mission: MISSION, ctx }, deps)
    check('careers page added via fetch + extract + verify', page.jobId === 'job-m' && page.job?.verification_status === 'LIKELY_OPEN' && page.job.employment_type === 'internship', page.error ?? '')
    check('company guessed from the host', page.job?.company_name === 'Beta')
    // The ATS reporting 'closed' outranks a fetched posting body: stored CLOSED, never VERIFIED_OPEN.
    const closedRegistry = createSourceRegistry([{ ...fakeAdapter, async fetchPosting(_b, id) { return { status: 'closed', posting: [ACME_INTERN, ACME_SENIOR, ACME_UK].find((x) => x.ats_job_id === id) ?? null, note: 'closed on the board' } } }])
    const closedAts = await addJobFromUrl(USER, 'https://boards.greenhouse.io/acme/jobs/1', { mission: MISSION, ctx }, { ...deps, registry: closedRegistry })
    check('ATS-reported closed posting is stored CLOSED with a warning', closedAts.jobId === 'job-m' && closedAts.job?.verification_status === 'CLOSED' && closedAts.warnings.some((w) => /closed/.test(w)), closedAts.error ?? '')
  }

  console.log(failures === 0 ? '\nall scout checks passed' : `\n${failures} check(s) FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
