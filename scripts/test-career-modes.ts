// Offline checks for run modes, the spend ceiling, saturation stopping and
// resumable runs.
//
//   npx tsx scripts/test-career-modes.ts
//
// No network, no keys, no database: every agent, adapter, fetcher and store is
// a stub injected through the deps parameters. What is asserted is the thing
// the audit measured — that a run stops when the market is exhausted or the
// money runs out, and NOT when a counter reaches twelve.

import { readFileSync } from 'fs'
import { createSourceRegistry } from '../lib/career/sources/registry'
import type { FetchedPage, JobSourceAdapter, PageFetcher, RawJobPosting } from '../lib/career/sources/types'
import type { AgentResult } from '../lib/agents/runtime/types'
import type { JobMissionPlan } from '../lib/agents/job-mission-planner'
import type { JobScoutSessionParams, JobScoutSessionResult } from '../lib/agents/job-scout/session'
import type { ScoutedPosting } from '../lib/agents/job-scout'
import type { JobExtraction } from '../lib/agents/job-extractor'
import { defaultMission } from '../lib/career/missions/store'
import { emptyBank } from '../lib/career/evidence/store'
import type { CareerRun } from '../lib/career/runs'
import type { NormalizedJob } from '../lib/career/jobs/normalize'
import type { SweepJob } from '../lib/career/jobs/sweep'
import { collectRunJobs, runRankStage } from '../lib/career/scout/rank-stage'
import type { CareerMission } from '../lib/career/types'
import { runJobScout, type JobScoutDeps, type ScoutStore } from '../lib/career/scout/orchestrator'
import {
  LEGACY_BUDGET,
  MAX_CONFIGURABLE_SPEND_USD,
  MODES,
  MODE_DESCRIPTIONS,
  parseRunMode,
  resolveRunBudget,
  RUN_MODES,
  summarizeBudget,
  type RunMode,
} from '../lib/career/discovery/modes'
import { recordRunCursor, terminalStatusFor } from '../lib/career/scout/run-store'
import { runContinuation, statsLines } from '../app/dashboard/jobs/run-copy'
import { createSpendLedger, saturated, STAGE_COST_ESTIMATE_USD, summarizeYield, yieldRatio } from '../lib/career/discovery/budget'
import {
  continuationParams,
  describeCursor,
  emptyCursor,
  isCursorComplete,
  isCursorEmpty,
  LOCAL_LEGACY_DEFAULTS,
  readRunCursor,
  readScoutParams,
  sanitizeCursor,
  sanitizeScoutParams,
  scoutCaps,
  toJobScoutParams,
  type ScoutCursor,
} from '../lib/career/scout/run-dispatch'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ─── Fixtures ────────────────────────────────────────────────────────────────

const USER = 'user-1'
const MISSION: CareerMission = { ...defaultMission(USER), id: 'mission-1', created_at: '', updated_at: '' }
const JD =
  'We are hiring a Process Engineer Intern for Summer 2027 in our San Francisco pilot plant. You will own process work, run experiments and present results. Requirements: pursuing a BS in chemical engineering. '.repeat(
    3
  )

function raw(over: Partial<RawJobPosting>): RawJobPosting {
  return {
    source_type: 'greenhouse', source_url: 'https://boards.greenhouse.io/acme/jobs/1', external_id: '1', company_name: 'Acme', company_domain: 'acme.com',
    title: 'Process Engineer Intern', location_raw: 'San Francisco, CA', description_text: JD, description_html: null, department: null, posted_at: null, updated_at: null,
    apply_url: 'https://boards.greenhouse.io/acme/jobs/1', canonical_url: 'https://boards.greenhouse.io/acme/jobs/1', ats_type: 'greenhouse', ats_job_id: '1', requisition_id: null,
    employment_type_hint: 'Intern', raw: {}, retrieved_at: new Date().toISOString(), ...over,
  }
}
const ACME_1 = raw({})
const ACME_2 = raw({
  source_url: 'https://boards.greenhouse.io/acme/jobs/2', canonical_url: 'https://boards.greenhouse.io/acme/jobs/2', apply_url: 'https://boards.greenhouse.io/acme/jobs/2',
  external_id: '2', ats_job_id: '2', title: 'Materials Intern',
})
const OMEGA_9 = raw({
  source_url: 'https://boards.greenhouse.io/omega/jobs/9', canonical_url: 'https://boards.greenhouse.io/omega/jobs/9', apply_url: 'https://boards.greenhouse.io/omega/jobs/9',
  external_id: '9', ats_job_id: '9', company_name: 'Omega', company_domain: 'omega.com', title: 'Reliability Engineering Intern',
})

const fakeAdapter: JobSourceAdapter = {
  id: 'greenhouse', source_type: 'greenhouse', isAvailable: () => true,
  matchUrl(url) {
    const m = /boards\.greenhouse\.io\/([^/?#]+)(?:\/jobs\/(\d+))?/.exec(url)
    return m ? { board: { ats: 'greenhouse', identifier: m[1], board_url: `https://boards.greenhouse.io/${m[1]}` }, jobId: m[2] ?? null } : null
  },
  async detectBoard({ companyName }) {
    const name = companyName.toLowerCase()
    if (/acme/.test(name)) return { ats: 'greenhouse', identifier: 'acme', board_url: 'https://boards.greenhouse.io/acme' }
    if (/omega/.test(name)) return { ats: 'greenhouse', identifier: 'omega', board_url: 'https://boards.greenhouse.io/omega' }
    return null
  },
  async listPostings(board) {
    if (board.identifier === 'acme') return { postings: [ACME_1, ACME_2], total_on_board: 2, board_url: 'https://boards.greenhouse.io/acme' }
    if (board.identifier === 'omega') return { postings: [OMEGA_9], total_on_board: 1, board_url: 'https://boards.greenhouse.io/omega' }
    return { postings: [], total_on_board: 0, board_url: null, note: 'unknown board' }
  },
  async fetchPosting(_board, id) {
    const p = [ACME_1, ACME_2, OMEGA_9].find((x) => x.ats_job_id === id)
    return p ? { status: 'open', posting: p, note: 'fetched' } : { status: 'not_found', posting: null, note: '404' }
  },
}
const registry = createSourceRegistry([fakeAdapter])
const fetcher: PageFetcher = {
  async fetch(url): Promise<FetchedPage> {
    return { url, final_url: url, status: 0, text: '', title: null, links: [], robots_blocked: false, error: 'no such fixture', retrieved_at: new Date().toISOString() }
  },
}

/** Every agent call costs the same, so "what did this run spend" is arithmetic. */
const CALL_COST = 0.25
function agentResult<T>(output: T | null, agentId: string, costUsd = CALL_COST, error: string | null = null): AgentResult<T> {
  return {
    output, status: output ? 'succeeded' : 'failed', error, evidence: [],
    trace: { agent_id: agentId, prompt_version: 'test', model: 'stub', model_role: 'fast', provider_id: 'stub', tools_called: [], web_searches: 1, tokens_in: 0, tokens_out: 0, cost_usd: costUsd, latency_ms: 1, steps: 1 },
  }
}

const strategy = (name: string, priority: number) => ({ name, kind: 'job_first' as const, rationale: '', queries: [`${name} query`], target_titles: [], geo_focus: [], priority })
const PLAN: JobMissionPlan = {
  role_families: [{ name: 'process_engineering', rationale: '', example_titles: [], confidence: 0.8 }],
  strategies: [strategy('S1', 0.9), strategy('S2', 0.5)],
  seed_companies: [],
  adjacent_categories: [], exclusions: [], reasoning: 'x', dropped_non_operators: 0,
}

const scouted = (n: number): ScoutedPosting[] =>
  [
    { company_name: 'Acme', company_domain: 'acme.com', title: 'Process Engineer Intern', location: 'San Francisco, CA', url: 'https://boards.greenhouse.io/acme/jobs/1', source_kind: 'ats' as const, ats_hint: 'greenhouse', season_hint: 'Summer 2027', why_relevant: 'x' },
    { company_name: 'Omega', company_domain: 'omega.com', title: 'Reliability Engineering Intern', location: 'Houston, TX', url: 'https://boards.greenhouse.io/omega/jobs/9', source_kind: 'ats' as const, ats_hint: 'greenhouse', season_hint: 'Summer 2027', why_relevant: 'x' },
  ].slice(0, n)

function sessionResult(postings: ScoutedPosting[]): JobScoutSessionResult {
  return {
    postings, companiesToCheck: [], history: [{ round: 1, query_used: 'q', postings_found: postings.length, postings_kept: postings.length, postings_ungrounded: 0, diagnosis: 'HEALTHY', action: 'ACCEPT', note: '' }],
    strategyRejected: false, needsNewStrategy: false, finalDiagnosis: 'HEALTHY', agentResults: [agentResult({} as never, 'job_scout')], errors: [], toolLog: [], toolUrls: new Set(), ungroundedPostings: 0,
  }
}

const extractor = async (input: { title: string; text: string }): Promise<AgentResult<JobExtraction>> =>
  agentResult<JobExtraction>({
    employment_type: /intern/i.test(input.title) ? 'internship' : 'full_time', season_relevance: 'summer_2027', work_mode: 'onsite', role_family: null, location_raw: null,
    deadline: null, compensation: null, min_qualifications: [], preferred_qualifications: [], graduation_eligibility: null, work_authorization: null, skills: [], responsibilities: [],
    industry: 'manufacturing', appears_closed: false, confidence: 0.9, summary: 's',
  }, 'job_extractor', 0.01)

interface Mem {
  jobs: NormalizedJob[]
  checked: string[]
  runs: { status: string; stats: Record<string, unknown> }[]
  traces: string[]
  ranked: string[][]
  cost: number
}

function memStore(opts: { watchlist?: Record<string, unknown>[] } = {}): { store: ScoutStore; mem: Mem; rank: NonNullable<JobScoutDeps['rank']> } {
  const mem: Mem = { jobs: [], checked: [], runs: [], traces: [], ranked: [], cost: 0 }
  const idByKey = new Map<string, string>()
  const keyOf = (j: NormalizedJob) => (j.ats_type && j.ats_job_id ? `${j.ats_type}:${j.ats_job_id}` : j.canonical_url ?? `${j.company_name}|${j.title}`)
  const rank: NonNullable<JobScoutDeps['rank']> = async (_u, ids) => {
    mem.ranked.push(ids)
    return { results: Object.fromEntries(ids.map((id) => [id, { fit: 0.7, eligibility: 'QUALIFIED', errors: [] }])), skipped: [], costUsd: 0.01 * ids.length, errors: [], runId: null }
  }
  const watchlist = opts.watchlist ?? []
  // The run's own cost accumulates from the traces, so the ledger's view of
  // spend is the run's real spend rather than a fixture constant.
  const run: CareerRun = {
    runId: 'run-1', migrationMissing: false, costUsd: () => Number(mem.cost.toFixed(6)), agentCalls: () => mem.traces.length,
    async trace(r) { mem.traces.push(r.trace.agent_id); mem.cost += r.trace.cost_usd; return null },
    async finish(status, stats) { mem.runs.push({ status, stats }) },
  }
  const store: ScoutStore = {
    async getMission() { return { mission: MISSION, error: null, migrationMissing: false } },
    async loadBank() { return { bank: emptyBank(), migrationMissing: false, errors: [] } },
    async recentFeedback() { return [] },
    async startRun() { return run },
    async listWatchlist() { return { companies: watchlist, error: null, migrationMissing: false } },
    async listIgnoredCompanies() { return { companies: [], error: null } },
    async listJobs() { return { jobs: [], error: null, migrationMissing: false } },
    async upsertJobs(_u, jobs) {
      let inserted = 0
      let updated = 0
      const ids: string[] = []
      for (const job of jobs) {
        const key = keyOf(job)
        const existing = idByKey.get(key)
        if (existing) { updated++; ids.push(existing); continue }
        const id = `job-${mem.jobs.length}`
        idByKey.set(key, id)
        mem.jobs.push(job)
        ids.push(id)
        inserted++
      }
      return { inserted, updated, skippedClosed: 0, ids, companyIds: {}, errors: [], migrationMissing: false }
    },
    async updateJobVerification() { return { error: null } },
    async upsertWatch(_u, input) { return { id: `c-${input.name}`, error: null, migrationMissing: false } },
    async markCareersChecked(id) { mem.checked.push(id); return { error: null } },
    async ensureCompany() { return { id: 'c-x', error: null, migrationMissing: false } },
  }
  return { store, mem, rank }
}

const ACME_ROW = { id: 'c-acme', name: 'Acme', domain: 'acme.com', careers_url: null, ats_type: 'greenhouse', ats_identifier: 'acme', watch_status: 'target', watch_source: 'user', watch_priority: 90 }

async function main() {
  // ─── A. Each mode produces its declared budget ────────────────────────────
  console.log('modes: declared budgets')
  {
    check('three modes, no more', RUN_MODES.length === 3 && RUN_MODES.join(',') === 'QUICK,BROAD,EXHAUSTIVE')
    for (const m of RUN_MODES) {
      const b = resolveRunBudget(m)
      check(`${m}: the budget is the mode's own, unchanged`, JSON.stringify(b) === JSON.stringify({ ...MODES[m], saturation: { ...MODES[m].saturation } }), summarizeBudget(b))
      check(`${m}: every declared field is present and finite`, [b.maxRuntimeMs, b.maxPagesPerSource, b.maxQueryFamilies, b.maxExtract, b.maxFullFit, b.maxPostingsPerStrategy].every((n) => Number.isFinite(n) && n > 0))
      check(`${m}: has UI copy that names it`, Boolean(MODE_DESCRIPTIONS[m].label && MODE_DESCRIPTIONS[m].blurb && MODE_DESCRIPTIONS[m].cost))
    }
    const q = MODES.QUICK
    const br = MODES.BROAD
    const ex = MODES.EXHAUSTIVE
    check('depth grows QUICK → BROAD → EXHAUSTIVE', q.maxPagesPerSource < br.maxPagesPerSource && br.maxPagesPerSource < ex.maxPagesPerSource && q.maxQueryFamilies < br.maxQueryFamilies && br.maxQueryFamilies < ex.maxQueryFamilies)
    check('spend and runtime grow with depth', q.maxSpendUsd < br.maxSpendUsd && br.maxSpendUsd < ex.maxSpendUsd && q.maxRuntimeMs < br.maxRuntimeMs && br.maxRuntimeMs <= ex.maxRuntimeMs)
    check('QUICK buys nothing from a paid provider', q.usePaidSources === false && br.usePaidSources && ex.usePaidSources)
    // The audit's finding: company-first must SHRINK as the run widens.
    check('company-first shrinks as the run widens', q.exploreShare > br.exploreShare && br.exploreShare > ex.exploreShare && q.companyFirstTimeShare > br.companyFirstTimeShare && br.companyFirstTimeShare > ex.companyFirstTimeShare, `${q.exploreShare} → ${br.exploreShare} → ${ex.exploreShare}`)
    // The two numbers the audit named as binding.
    check('no mode stops a strategy at twelve postings', RUN_MODES.every((m) => MODES[m].maxPostingsPerStrategy >= 12) && br.maxPostingsPerStrategy > 12 && ex.maxPostingsPerStrategy > 12)
    check('no mode ranks only twelve jobs', br.maxFullFit > 12 && ex.maxFullFit > 12)
    check('saturation gets stricter as the run widens', q.saturation.minYieldRatio > br.saturation.minYieldRatio && br.saturation.minYieldRatio > ex.saturation.minYieldRatio)

    check('parseRunMode accepts the three, case-insensitively, and nothing else', parseRunMode('broad') === 'BROAD' && parseRunMode(' Exhaustive ') === 'EXHAUSTIVE' && parseRunMode('deep') === null && parseRunMode(null) === null && parseRunMode(7) === null)
    const capped = resolveRunBudget('EXHAUSTIVE', { maxSpendUsd: 9999, maxRuntimeMs: 99_999_999 })
    check('an override can never raise a limit past what is configurable', capped.maxSpendUsd === 100 && capped.maxRuntimeMs === 3_600_000, `$${capped.maxSpendUsd} / ${capped.maxRuntimeMs}ms`)
    check('usePaidSources can be turned off but never on', resolveRunBudget('BROAD', { usePaidSources: false }).usePaidSources === false && resolveRunBudget('QUICK', {}).usePaidSources === false)
    check('a caller that names no mode gets the legacy budget with NO ceiling', resolveRunBudget(null).mode === 'LEGACY' && resolveRunBudget(null).maxSpendUsd === Number.POSITIVE_INFINITY && LEGACY_BUDGET.sweep === false)
    // The one path with no ceiling must not also get bigger counts: raising
    // them there buys a more expensive run on the only caller nobody capped.
    check(
      'the uncapped legacy path keeps today’s counts, so nothing gets more expensive by accident',
      LEGACY_BUDGET.maxFullFit === 12 && LEGACY_BUDGET.maxPostingsPerStrategy === 12,
      `fit ${LEGACY_BUDGET.maxFullFit} · ${LEGACY_BUDGET.maxPostingsPerStrategy}/strategy`
    )
    check('an explicit ceiling applies to the legacy budget too', resolveRunBudget(null, { maxSpendUsd: 2 }).maxSpendUsd === 2)
    check('summarizeBudget says the ceiling in words', summarizeBudget(MODES.BROAD).includes('$4.00 ceiling') && summarizeBudget(LEGACY_BUDGET).includes('no spend ceiling'))
  }

  // ─── B. The spend ceiling is enforced, not decorative ─────────────────────
  console.log('budget: the spend ceiling')
  {
    const l = createSpendLedger({ limitUsd: 1 })
    check('a fresh ledger has spent nothing and may start work', l.spent() === 0 && l.canSpend(0.5).ok && !l.stopped())
    l.record({ stage: 'plan', source: 'job_mission_planner', model: 'reasoning', usd: 0.4, units: 1 })
    l.record({ stage: 'extract', source: 'job_extractor', model: 'fast', usd: 0.3, units: 20 })
    check('spend is attributed by stage, source and model', l.summary().by_stage.plan === 0.4 && l.summary().by_source.job_extractor === 0.3 && l.summary().by_model.fast === 0.3, JSON.stringify(l.summary().by_stage))
    check('spent and remaining agree with the ceiling', l.spent() === 0.7 && Math.abs(l.remaining() - 0.3) < 1e-9)
    const refused = l.canSpend(0.4, { stage: 'strategy "S2"' })
    check('work that would cross the ceiling is refused BEFORE it starts', !refused.ok && refused.reason !== null && refused.reason.includes('spend ceiling reached') && refused.reason.includes('S2'), refused.reason ?? '')
    check('a refusal does not latch: cheaper work that still fits is allowed', l.canSpend(0.2).ok && !l.stopped())
    check('affordable() answers in units, not dollars', l.affordable(0.1) === 3 && l.affordable(1) === 0)
    l.record({ stage: 'rank', source: 'fit', usd: 0.3, units: 6 })
    check('the ceiling is reached exactly, never exceeded silently', l.spent() === 1 && l.remaining() === 0 && l.stopped() && !l.canSpend(0.01).ok)
    check('the pre-check estimates are pessimistic, so a stage cannot start and then overshoot', STAGE_COST_ESTIMATE_USD.strategy > STAGE_COST_ESTIMATE_USD.plan / 2 && STAGE_COST_ESTIMATE_USD.rank > STAGE_COST_ESTIMATE_USD.extract && STAGE_COST_ESTIMATE_USD.extract > 0)
    const m = l.metrics({ uniquePostings: 50, storedJobs: 40, rankedJobs: 10 })
    check('cost per unique posting is reported', m.cost_per_unique_posting === 0.02 && m.cost_per_stored_job === 0.025 && m.cost_per_ranked_job === 0.1, JSON.stringify(m))
    check('metrics never divide by zero', createSpendLedger({ limitUsd: 1 }).metrics({ uniquePostings: 0 }).cost_per_unique_posting === null)

    const none = createSpendLedger({ limitUsd: Number.POSITIVE_INFINITY })
    none.record({ stage: 'plan', source: 'x', usd: 900 })
    check('no configured ceiling means nothing is ever refused', none.canSpend(1000).ok && !none.stopped() && none.affordable(0.01) > 1000)

    const resumed = createSpendLedger({ limitUsd: 1, openingUsd: 0.9 })
    check('a resumed run counts what earlier invocations spent against the SAME ceiling', resumed.spent() === 0.9 && !resumed.canSpend(0.2).ok && resumed.summary().by_stage['earlier invocations'] === 0.9)

    const reserved = createSpendLedger({ limitUsd: 1, reserveUsd: 0.25 })
    reserved.record({ stage: 'x', source: 'y', usd: 0.7 })
    check('a reserve is held back so a run can always finish cleanly', !reserved.canSpend(0.1).ok && reserved.remaining() === 0.05)

    const synced = createSpendLedger({ limitUsd: 5 })
    synced.syncTotal(0.3, { stage: 'plan' })
    synced.syncTotal(0.5, { stage: 'job-first' })
    synced.syncTotal(0.5, { stage: 'job-first' })
    check('syncTotal records the delta of a running total, never double-counts', synced.spent() === 0.5 && synced.summary().by_stage.plan === 0.3 && synced.summary().by_stage['job-first'] === 0.2, JSON.stringify(synced.summary().by_stage))
  }

  // ─── C. Saturation, not counters ──────────────────────────────────────────
  console.log('budget: saturation')
  {
    const policy = { minYieldRatio: 0.1, lowYieldStreak: 2, minSamples: 2 }
    check('an empty history never saturates', !saturated([], policy).saturated && !saturated([{ seen: 10, unique: 0 }], policy).saturated)
    const productive = [{ seen: 20, unique: 18 }, { seen: 20, unique: 15 }, { seen: 20, unique: 12 }]
    check('a productive source is never stopped, however many pages it has read', !saturated(productive, policy).saturated && saturated(productive, policy).ratio === 0.6)
    const twoBad = [...productive, { seen: 20, unique: 1 }, { seen: 20, unique: 1 }]
    const sat = saturated(twoBad, policy)
    check('two consecutive low-yield pages stop it, with a reason in words', sat.saturated && (sat.reason ?? '').includes('saturated') && (sat.reason ?? '').includes('2 new of 40'), sat.reason ?? '')
    check('ONE low-yield page does not stop it', !saturated([...productive, { seen: 20, unique: 1 }], policy).saturated)
    check('a productive page after a bad one resets the streak', !saturated([{ seen: 20, unique: 1 }, { seen: 20, unique: 19 }], policy).saturated)
    const empty = saturated([{ seen: 0, unique: 0 }, { seen: 0, unique: 0 }], policy)
    check('empty pages are reported as exhaustion, not as low yield', empty.saturated && (empty.reason ?? '').includes('exhausted'), empty.reason ?? '')
    check('a stricter streak needs more evidence before stopping', !saturated([{ seen: 20, unique: 1 }, { seen: 20, unique: 1 }], { ...policy, lowYieldStreak: 3, minSamples: 3 }).saturated)
    check('the threshold is honoured: 15% passes at 10%, fails at 20%', !saturated([{ seen: 20, unique: 3 }, { seen: 20, unique: 3 }], policy).saturated && saturated([{ seen: 20, unique: 3 }, { seen: 20, unique: 3 }], { ...policy, minYieldRatio: 0.2 }).saturated)
    check('yieldRatio is total and never NaN', yieldRatio({ seen: 0, unique: 5 }) === 0 && yieldRatio({ seen: 4, unique: 2 }) === 0.5)
    check('summarizeYield totals a lane', JSON.stringify(summarizeYield(twoBad)) === JSON.stringify({ seen: 100, unique: 47, ratio: 0.47, pages: 5 }))
    check('a saturated result never claims to be saturated on garbage input', !saturated(undefined as never, policy).saturated)
  }

  // ─── D. Parameters: one mode, and the old fields for one more release ─────
  console.log('run params: modes, legacy fields, cursor')
  {
    const caps = scoutCaps(false)
    const legacy = sanitizeScoutParams({}, caps)
    check('no mode, no fields → the legacy defaults, unchanged', legacy.mode === null && legacy.strategies === LOCAL_LEGACY_DEFAULTS.strategies && legacy.extract === LOCAL_LEGACY_DEFAULTS.extract && legacy.companies === LOCAL_LEGACY_DEFAULTS.companies, JSON.stringify(legacy))
    check('no mode → no spend ceiling is invented', legacy.maxSpendUsd === null && legacy.legacyFields.length === 0)

    const old = sanitizeScoutParams({ strategies: 1, rounds: 1, companies: 10, extract: 15 }, caps)
    check('the old slider fields still work exactly as they did', old.strategies === 1 && old.rounds === 1 && old.companies === 10 && old.extract === 15)
    check('the old fields are recorded as deprecated inputs', old.legacyFields.join(',') === 'strategies,rounds,companies,extract')

    const broad = sanitizeScoutParams({ mode: 'BROAD', maxSpendUsd: 2.5 }, caps)
    check('a mode derives the per-stage numbers so nobody has to', broad.mode === 'BROAD' && broad.strategies === MODES.BROAD.maxStrategies && broad.extract === MODES.BROAD.maxExtract && broad.maxSpendUsd === 2.5, JSON.stringify(broad))
    const mixed = sanitizeScoutParams({ mode: 'BROAD', extract: 5 }, caps)
    check('an explicit old field still wins over the mode (one release of mercy)', mixed.extract === 5 && mixed.strategies === MODES.BROAD.maxStrategies && mixed.legacyFields.join(',') === 'extract')
    const hosted = sanitizeScoutParams({ mode: 'EXHAUSTIVE' }, scoutCaps(true))
    check('a mode is still clamped by the platform ceiling', hosted.strategies === scoutCaps(true).strategies && hosted.extract === scoutCaps(true).extract, JSON.stringify(hosted))
    check('junk is refused without throwing', sanitizeScoutParams({ mode: 'ludicrous', maxSpendUsd: 'lots' } as never, caps).mode === null && sanitizeScoutParams({ maxSpendUsd: -5 }, caps).maxSpendUsd === 0)
    // The stored (and echoed) number must be the number that will be enforced:
    // a row promising $1000 under a $100 ceiling is a run that says it may
    // spend ten times what it may.
    check(
      'a posted ceiling is clamped to what will actually be enforced',
      sanitizeScoutParams({ mode: 'BROAD', maxSpendUsd: 1000 }, caps).maxSpendUsd === MAX_CONFIGURABLE_SPEND_USD &&
        resolveRunBudget('BROAD', { maxSpendUsd: sanitizeScoutParams({ mode: 'BROAD', maxSpendUsd: 1000 }, caps).maxSpendUsd }).maxSpendUsd === MAX_CONFIGURABLE_SPEND_USD,
      `${sanitizeScoutParams({ mode: 'BROAD', maxSpendUsd: 1000 }, caps).maxSpendUsd}`
    )

    // The cursor is executed by a LATER invocation, so it is untrusted input.
    const hostile = sanitizeCursor({ v: 1, stages: Array(500).fill('x'), companies: 'nope', pages: { a: -3, b: 'x', c: 2.9 }, planned: [{ name: 'S', kind: 'weird', queries: Array(200).fill(0).map((_, i) => `q${i}`) }], spent_usd: -1, attempts: 3.7 })
    check('a hostile cursor is bounded, not trusted', hostile.stages.length === 1 && hostile.companies.length === 0 && hostile.pages.a === 0 && hostile.pages.c === 2 && !('b' in hostile.pages) && hostile.spent_usd === 0 && hostile.attempts === 3)
    check('a planned strategy is sanitized into the shape the loop executes', hostile.planned?.length === 1 && hostile.planned[0].kind === 'job_first' && hostile.planned[0].queries.length === 40)
    check('an unversioned cursor is read as empty', isCursorEmpty(sanitizeCursor({ stages: ['plan'] })) && isCursorEmpty(sanitizeCursor(null)) && isCursorEmpty(emptyCursor()))
    check('a finished run is not resumable', isCursorComplete(sanitizeCursor({ v: 1, stages: ['plan', 'done'] })) && !isCursorComplete(emptyCursor()))
    check('the cursor is read from the row params first, then progress', readRunCursor({ params: { cursor: { v: 1, stages: ['plan'] } }, progress: { cursor: { v: 1, stages: ['rank'] } } }).stages.join() === 'plan' && readRunCursor({ progress: { cursor: { v: 1, stages: ['rank'] } } }).stages.join() === 'rank' && isCursorEmpty(readRunCursor(null)))
    // Where the orchestrator's own report puts it. A reader that looked only
    // at params is how "continue this run" quietly re-ran the whole run.
    check(
      'a cursor written only into the run’s stats is still found',
      readRunCursor({ stats: { discovery: { cursor: { v: 1, stages: ['plan', 'sweep'], strategies: ['S1'] } } } }).strategies.join() === 'S1' &&
        readRunCursor({ stats: { discovery: { cursor: { v: 1, stages: ['done'] } } } }).stages.join() === 'done'
    )
    check('a run with no cursor anywhere reads as empty, never as done', isCursorEmpty(readRunCursor({ params: {}, progress: {}, stats: { discovery: {} } })))
    check('a cursor in a REQUEST is ignored; only a stored row may say what is done', isCursorEmpty(sanitizeScoutParams({ cursor: { v: 1, stages: ['plan', 'job-first', 'done'] } }, caps).cursor) && sanitizeScoutParams({ cursor: { v: 1, stages: ['plan'] } }, caps, { trustCursor: true }).cursor.stages.join() === 'plan')
    const cont = continuationParams(sanitizeScoutParams({ mode: 'BROAD' }, caps), sanitizeCursor({ v: 1, stages: ['plan'], strategies: ['S1'], attempts: 1 }))
    // `attempts` is incremented by the ORCHESTRATOR, which is the thing that
    // makes an attempt. Counting it here as well made pass 2 report "pass 3".
    check('a continuation keeps the run’s parameters and carries its cursor forward', cont.mode === 'BROAD' && cont.cursor.strategies.join() === 'S1' && cont.cursor.attempts === 1)
    check('describeCursor says how much is behind us', describeCursor(cont.cursor).includes('1 strategy executed') && describeCursor(emptyCursor()) === 'nothing done yet')
    const mapped = toJobScoutParams(cont, { userId: USER, deadlineMs: 1000 })
    check('toJobScoutParams carries mode, ceiling and cursor to the orchestrator', mapped.mode === 'BROAD' && mapped.cursor.strategies.join() === 'S1' && mapped.budget.deadlineMs === 1000 && mapped.userId === USER)
  }

  // ─── E. A run executes its mode's budget, and measures its own lanes ──────
  console.log('run: the mode reaches the stages')
  {
    const { store, mem, rank } = memStore({ watchlist: [ACME_ROW] })
    const seen: JobScoutSessionParams[] = []
    const r = await runJobScout(
      { userId: USER, mode: 'BROAD', verify: false, budget: { deadlineMs: 120_000 } },
      {
        store, rank, registry, fetcher, extractor,
        planner: async () => agentResult(PLAN, 'job_mission_planner'),
        session: async (p) => { seen.push(p); return sessionResult(scouted(2)) },
      }
    )
    check('run succeeded', mem.runs[0]?.status === 'succeeded', r.errors.join(' | '))
    check('the run reports the budget it executed', r.budget.mode === 'BROAD' && r.budget.maxSpendUsd === MODES.BROAD.maxSpendUsd)
    // The audit's binding constraint, gone: a strategy is no longer told 12.
    check('a strategy is given the MODE’s posting target, not twelve', seen.length === 2 && seen.every((p) => p.targetCount === MODES.BROAD.maxPostingsPerStrategy), `${seen[0]?.targetCount}`)
    check('a strategy is given the mode’s round budget', seen.every((p) => p.maxRounds === MODES.BROAD.maxRoundsPerStrategy))
    check('both lanes are measured, and broad market discovery is one of them', r.lanes.broad_market > 0 && r.lanes.company_first > 0 && r.lanes.broad_market_share > 0 && r.lanes.broad_market_share < 1, JSON.stringify(r.lanes))
    check('the lanes account for every posting the run found', r.lanes.broad_market + r.lanes.company_first === r.stats.postings_seen, `${r.lanes.broad_market}+${r.lanes.company_first} vs ${r.stats.postings_seen}`)
    check('cost per unique posting is reported', r.cost.cost_per_unique_posting !== null && r.cost.spend_usd > 0, JSON.stringify(r.cost))
    check('a run that got through everything is complete and not resumable', r.stopped === 'complete' && isCursorComplete(r.cursor) && r.partial === false)
    check('the run’s stats carry the discovery report for the UI', typeof (mem.runs[0]?.stats as Record<string, unknown>).discovery === 'object')
    check('more than twelve jobs may be ranked', MODES.BROAD.maxFullFit > 12 && mem.ranked[0].length === mem.jobs.length)

    // The audit's second binding limit, measured rather than asserted about a
    // constant: with twenty stored rows in hand, a BROAD run judges all twenty
    // and the old twelve judges twelve. The ceiling still wins over both.
    const twenty: SweepJob[] = Array.from({ length: 20 }, (_, i) => ({
      id: `sweep-${i}`, title: `Intern ${i}`, company_name: `Co ${i}`, location_raw: null, location_tier: null, season_relevance: 'summer_2027',
      employment_type: 'internship', verification_status: 'LIKELY_OPEN', canonical_url: `https://x/${i}`, source_types: ['greenhouse'], relevance: 1 - i / 100, extracted: false,
    }))
    const collected = collectRunJobs({ persistedJobs: [], idByJob: new Map(), sweepJobs: twenty })
    const rankedWith = async (maxFullFit: number, affordable = 1000) => {
      let sent: string[] = []
      const out = await runRankStage({
        userId: USER, mission: MISSION, jobs: collected, maxFullFit, affordable, refusalReason: null, windowMs: 120_000, directionOverridden: false,
        progress: () => {},
        rank: async (_u, ids) => { sent = ids; return { results: Object.fromEntries(ids.map((id) => [id, { fit: 0.5, eligibility: 'QUALIFIED', errors: [] }])), skipped: [], costUsd: 0, errors: [], runId: null } },
      })
      return { sent, out }
    }
    const broadRank = await rankedWith(MODES.BROAD.maxFullFit)
    const oldRank = await rankedWith(12)
    check('a BROAD run judges every one of twenty stored jobs; the old cap judged twelve', broadRank.sent.length === 20 && oldRank.sent.length === 12, `${broadRank.sent.length} vs ${oldRank.sent.length}`)
    const poor = await rankedWith(MODES.BROAD.maxFullFit, 4)
    check('what the ceiling can still buy caps the count, whatever the mode says', poor.sent.length === 4)
    const broke = await runRankStage({ userId: USER, mission: MISSION, jobs: collected, maxFullFit: 40, affordable: 0, refusalReason: 'spend ceiling reached', windowMs: 120_000, directionOverridden: false, progress: () => {}, rank: async () => { throw new Error('must not be called') } })
    check('a run out of money does not rank silently — it says ranking did not happen', broke.ranked === 0 && broke.budgetStopped === 'spend ceiling reached' && (broke.skipped ?? '').startsWith('ranking skipped'), broke.skipped ?? '')
  }

  // ─── F. The ceiling stops new paid work, and the run says so ──────────────
  console.log('run: the spend ceiling stops it')
  {
    // $0.50 buys the plan ($0.25 of real trace cost) and nothing else: the
    // next strategy's estimate does not fit, so no session is ever started.
    const { store, mem, rank } = memStore({ watchlist: [ACME_ROW] })
    let sessions = 0
    const r = await runJobScout(
      { userId: USER, mode: 'BROAD', maxSpendUsd: 0.5, verify: false, budget: { deadlineMs: 30_000 } },
      {
        store, rank, registry, fetcher, extractor,
        planner: async () => agentResult(PLAN, 'job_mission_planner'),
        session: async () => { sessions++; return sessionResult(scouted(2)) },
      }
    )
    check('no paid strategy starts once the ceiling is in reach', sessions === 0, `${sessions} sessions`)
    check('the run stopped for MONEY and says which stage it refused', r.stopped === 'budget' && r.errors.some((e) => e.includes('spend ceiling reached') && e.includes('strategy')), r.errors.join(' | '))
    check('a run stopped by its ceiling finishes cleanly as partial', r.partial === true && mem.runs[0]?.status === 'succeeded')
    // What the worker will WRITE on the row. A budget stop used to be recorded
    // as 'succeeded': a green run that in fact stopped short of the market
    // because it ran out of money.
    check(
      'the run row records a budget stop as partial, not as a green tick',
      terminalStatusFor({ migrationMissing: false, deadlineHit: r.stats.deadline_hit, errors: r.errors, partial: r.partial, stopped: r.stopped }) === 'partial',
      `stopped=${r.stopped}`
    )
    check('it never exceeds the configured maximum', r.spend.spent_usd <= 0.5 && r.spend.limit_usd === 0.5, `$${r.spend.spent_usd}`)
    check('what it did find is still stored', mem.jobs.length > 0 && r.jobs.length > 0)
    check('the cursor is left resumable, not marked done', !isCursorComplete(r.cursor) && r.cursor.strategies.length === 0)

    // A ceiling of zero: nothing paid may start at all, including the plan.
    const z = memStore({ watchlist: [ACME_ROW] })
    let planned = 0
    const zr = await runJobScout(
      { userId: USER, mode: 'QUICK', maxSpendUsd: 0, verify: false, rank: false, budget: { deadlineMs: 30_000 } },
      { store: z.store, rank: z.rank, registry, fetcher, extractor, planner: async () => { planned++; return agentResult(PLAN, 'job_mission_planner') }, session: async () => sessionResult(scouted(2)) }
    )
    check('a zero ceiling stops even the planner, and says so', planned === 0 && zr.errors.some((e) => e.startsWith('planning skipped')), zr.errors.join(' | '))
    check('a zero-ceiling run still does the free work and stores it', z.mem.jobs.length > 0 && zr.spend.spent_usd === 0, `${z.mem.jobs.length} jobs`)
  }

  // ─── G. Saturation stops the strategy loop ────────────────────────────────
  console.log('run: saturation stops the loop')
  {
    // Every strategy after the first re-finds the SAME two postings, so the
    // marginal unique yield is zero twice in a row.
    const { store, mem, rank } = memStore({ watchlist: [] })
    const names: string[] = []
    const many: JobMissionPlan = { ...PLAN, strategies: [strategy('S1', 0.9), strategy('S2', 0.8), strategy('S3', 0.7), strategy('S4', 0.6), strategy('S5', 0.5)] }
    const r = await runJobScout(
      { userId: USER, mode: 'BROAD', verify: false, rank: false, budget: { deadlineMs: 30_000 } },
      {
        store, rank, registry, fetcher, extractor,
        planner: async () => agentResult(many, 'job_mission_planner'),
        session: async (p) => { names.push(p.strategy.name); return sessionResult(scouted(2)) },
      }
    )
    check('the loop stops once new strategies stop finding anything new', names.length < 5 && names.length >= 3, names.join(','))
    check('it stops for SATURATION, and the reason names the yield', r.stopped === 'saturated' && r.errors.some((e) => e.includes('saturated')), r.errors.join(' | '))
    check('the yield of every executed strategy is reported', r.yields.length === names.length && r.yields[0].unique > 0 && r.yields[r.yields.length - 1].unique === 0, JSON.stringify(r.yields))
    check('a saturated run still stored what it found', mem.jobs.length > 0)
    // Saturation is the intended GOOD ending of a wide run: there was nothing
    // new left to find. So the run is finished, not partial, and its cursor
    // does not invite a second pass over an exhausted market.
    check('a saturated run is finished, not partial', r.partial === false && isCursorComplete(r.cursor), JSON.stringify({ partial: r.partial, stages: r.cursor.stages }))
    check('and it is recorded as a success that says why it stopped', terminalStatusFor({ migrationMissing: false, deadlineHit: false, errors: r.errors, partial: r.partial, stopped: r.stopped }) === 'succeeded')

    // A legacy caller (no mode) is never stopped by saturation: it executes
    // exactly the strategies it asked for.
    const l = memStore({ watchlist: [] })
    const legacyNames: string[] = []
    await runJobScout(
      { userId: USER, maxStrategies: 5, verify: false, rank: false, budget: { deadlineMs: 30_000 } },
      { store: l.store, rank: l.rank, registry, fetcher, extractor, planner: async () => agentResult(many, 'job_mission_planner'), session: async (p) => { legacyNames.push(p.strategy.name); return sessionResult(scouted(2)) } }
    )
    check('a legacy run’s behaviour is unchanged: no saturation stopping', legacyNames.length === 5, legacyNames.join(','))
  }

  // ─── H. Resumable across worker invocations ───────────────────────────────
  console.log('run: resuming where the last invocation stopped')
  {
    // Pass 1: the deadline lands in the middle of the strategy list.
    const first = memStore({ watchlist: [ACME_ROW] })
    const pass1: string[] = []
    let cursorAtEnd: ScoutCursor = emptyCursor()
    const r1 = await runJobScout(
      { userId: USER, mode: 'BROAD', verify: false, rank: false, budget: { deadlineMs: 350 }, onCursor: (c) => { cursorAtEnd = c } },
      {
        store: first.store, rank: first.rank, registry, fetcher, extractor,
        planner: async () => agentResult(PLAN, 'job_mission_planner'),
        session: async (p) => { pass1.push(p.strategy.name); await sleep(400); return sessionResult(scouted(2)) },
      }
    )
    check('pass 1 ran out of clock inside the strategy list', pass1.length === 1 && r1.stats.deadline_hit && r1.partial, pass1.join(','))
    check('pass 1 finishes partial with a cursor, not with nothing', !isCursorComplete(r1.cursor) && r1.cursor.strategies.join() === 'S1' && r1.cursor.stages.includes('plan'), JSON.stringify(r1.cursor.stages))
    check('the plan it paid for is carried in the cursor', (r1.cursor.planned ?? []).map((s) => s.name).join(',') === 'S1,S2')
    check('the companies it checked are carried in the cursor', r1.cursor.companies.join() === 'c-acme' && first.mem.checked.includes('c-acme'), `${r1.cursor.companies.join()} | checked ${first.mem.checked.join(',')}`)
    check('the cursor was emitted DURING the run, not only at the end', cursorAtEnd.strategies.length >= 1 && cursorAtEnd.attempts === 1)
    check('what pass 1 spent is carried forward', r1.cursor.spent_usd > 0 && r1.cursor.spent_usd === r1.spend.spent_usd)

    // Pass 2: the same run, continued. Nothing finished is done twice.
    const second = memStore({ watchlist: [ACME_ROW] })
    const pass2: string[] = []
    let planners = 0
    const r2 = await runJobScout(
      { userId: USER, mode: 'BROAD', verify: false, rank: false, budget: { deadlineMs: 30_000 }, cursor: r1.cursor },
      {
        store: second.store, rank: second.rank, registry, fetcher, extractor,
        planner: async () => { planners++; return agentResult(PLAN, 'job_mission_planner') },
        session: async (p) => { pass2.push(p.strategy.name); return sessionResult(scouted(2)) },
      }
    )
    check('pass 2 does NOT pay the planner again', planners === 0 && r2.stats.model_calls < r1.stats.model_calls + 2)
    check('pass 2 executes only the strategy pass 1 did not reach', pass2.join() === 'S2', pass2.join(','))
    check('pass 2 does not re-check the companies pass 1 checked', second.mem.checked.length === 0, second.mem.checked.join(','))
    check('pass 2 counts pass 1’s spend against the same ceiling', r2.spend.spent_usd > r1.spend.spent_usd && r2.spend.limit_usd === MODES.BROAD.maxSpendUsd, `$${r2.spend.spent_usd}`)
    check('pass 2 is the second attempt and finishes the run', r2.cursor.attempts === 2 && isCursorComplete(r2.cursor) && r2.stopped === 'complete', JSON.stringify({ a: r2.cursor.attempts, s: r2.stopped }))
    check('the finished run is refused a third pass', isCursorComplete(r2.cursor))
    check('pass 2 still found and stored jobs of its own', second.mem.jobs.length > 0)
  }

  // ─── I. Company-first is secondary in a wide run ──────────────────────────
  console.log('run: company-first is the smaller lane')
  {
    // Nine explore rows the scout invented, one target the user chose. A wide
    // run must not spend itself re-reading the guesses.
    const rows: Record<string, unknown>[] = [ACME_ROW]
    for (let i = 0; i < 9; i++) rows.push({ id: `c-e${i}`, name: `Explore ${i}`, domain: null, careers_url: null, ats_type: null, ats_identifier: null, watch_status: 'suggested', watch_source: 'scout', watch_priority: 99, last_careers_check_at: null })
    const { store, mem, rank } = memStore({ watchlist: rows })
    const r = await runJobScout(
      { userId: USER, mode: 'EXHAUSTIVE', maxCompaniesFirst: 10, verify: false, rank: false, budget: { deadlineMs: 30_000 } },
      { store, rank, registry, fetcher, extractor, planner: async () => agentResult(PLAN, 'job_mission_planner'), session: async () => sessionResult(scouted(2)) }
    )
    check('the company the USER chose is always checked', mem.checked.includes('c-acme'))
    check('the scout’s own guesses take only a small slice of a wide run', r.stats.companies_selected.suggested <= 2 && r.stats.companies_selected.target === 1, JSON.stringify(r.stats.companies_selected))
    check('the run reports the share of discovery that came from the market', r.lanes.broad_market_share >= 0.5, JSON.stringify(r.lanes))
    check('the report says both numbers in words', r.notes.some((n) => n.includes('broad market')) && r.notes.some((n) => n.startsWith('spend:')), r.notes.join(' | '))
  }

  // ─── J. The mode reaches the ONLY executor the UI uses ────────────────────
  //
  // Every run started from the Jobs page is executed by
  // app/api/career/scout/worker. It used to build the orchestrator's argument
  // object by hand and omit `mode`, `maxSpendUsd` and `cursor` — so the run
  // the founder pressed for executed the LEGACY budget with no ceiling at all,
  // and the spend limit in the UI did nothing. There is no way to call a Next
  // route handler offline, so what is asserted here is the property that made
  // it possible: the executors share ONE mapping, and the worker uses it.
  console.log('worker: the run the founder asked for is the run that executes')
  {
    const workerSrc = readFileSync(new URL('../app/api/career/scout/worker/route.ts', import.meta.url), 'utf8')
    check('the worker maps the stored row through the shared toJobScoutParams', workerSrc.includes('toJobScoutParams(params'))
    check('the worker does not hand-roll the orchestrator’s arguments', !/runJobScout\(\s*\{/.test(workerSrc))
    check('the worker persists the cursor while the run is alive and at the end', workerSrc.includes('onCursor') && (workerSrc.match(/recordRunCursor\(/g) ?? []).length >= 2)
    check('the worker tells terminalStatusFor how the run stopped', /terminalStatusFor\(\{[\s\S]*?stopped:/.test(workerSrc))

    // And the mapping itself carries everything the run's shape depends on.
    const p = readScoutParams({ mode: 'QUICK', maxSpendUsd: 1, cursor: { v: 1, stages: ['plan'], strategies: ['S1'], spent_usd: 0.2, attempts: 1 } }, scoutCaps(false))
    const mapped = toJobScoutParams(p, { userId: USER, deadlineMs: 1000, onCursor: () => {} })
    check('a QUICK run with a $1 ceiling reaches the orchestrator as exactly that', mapped.mode === 'QUICK' && mapped.maxSpendUsd === 1 && mapped.cursor.strategies.join() === 'S1' && typeof mapped.onCursor === 'function', JSON.stringify({ mode: mapped.mode, spend: mapped.maxSpendUsd }))
    const effective = resolveRunBudget(mapped.mode ?? null, { maxSpendUsd: mapped.maxSpendUsd ?? null })
    check('and the budget it executes is the mode’s, with the caller’s ceiling', effective.mode === 'QUICK' && effective.maxSpendUsd === 1 && effective.maxFullFit === MODES.QUICK.maxFullFit, JSON.stringify({ mode: effective.mode, spend: effective.maxSpendUsd }))
  }

  // ─── K. The cursor is actually written to the run row ─────────────────────
  console.log('run row: the cursor is persisted and read back')
  {
    // A fake of the five-method port the durable-run state machine uses. No
    // Supabase, no keys: what is asserted is that the write lands where
    // readRunCursor looks.
    const row: Record<string, unknown> = { id: 'run-1', user_id: USER, status: 'running', params: { mode: 'BROAD', maxSpendUsd: 3 }, progress: { stage: 'job-first' }, stats: {} }
    const db = {
      async insertRun() { return { row: null, error: null } },
      async patchRun(_id: string, patch: Record<string, unknown>, guard?: Record<string, unknown>) {
        if (guard && 'status' in guard && guard.status !== row.status) return { rows: [], error: null }
        Object.assign(row, patch)
        return { rows: [row as never], error: null }
      },
      async getRun() { return { row: row as never, error: null } },
      async listRuns() { return { rows: [], error: null } },
      async countJobs() { return { counts: {} as never, error: null } },
    }
    const cursor = { ...emptyCursor(), stages: ['plan', 'sweep'], strategies: ['S1'], spent_usd: 1.25, elapsed_ms: 240_000, attempts: 1 }
    const w = await recordRunCursor('run-1', cursor as unknown as Record<string, unknown>, { db: db as never })
    check('the cursor is written onto the run row', w.ok && !w.notRunning, w.error ?? '')
    check('the run’s own parameters survive the write', (row.params as Record<string, unknown>).mode === 'BROAD' && (row.params as Record<string, unknown>).maxSpendUsd === 3)
    const readBack = readRunCursor(row)
    check('and a continuation reads back exactly where the run stopped', readBack.strategies.join() === 'S1' && readBack.spent_usd === 1.25 && readBack.elapsed_ms === 240_000, JSON.stringify(readBack.stages))
    check('the same cursor is mirrored into progress for the UI', readRunCursor({ progress: row.progress }).strategies.join() === 'S1')

    // A run somebody else closed must not be written to — except by the
    // finishing write, which races the status change it is part of.
    row.status = 'partial'
    const late = await recordRunCursor('run-1', { ...cursor, strategies: ['S1', 'S2'] } as unknown as Record<string, unknown>, { db: db as never })
    check('a run that is no longer running is not overwritten', !late.ok && late.notRunning)
    const forced = await recordRunCursor('run-1', { ...cursor, strategies: ['S1', 'S2'] } as unknown as Record<string, unknown>, { db: db as never, force: true })
    check('the finishing write still lands', forced.ok && readRunCursor(row).strategies.join() === 'S1,S2')

    // What the founder is offered on screen.
    const stoppedRun = (stopped: string, stages: string[]) =>
      ({ id: 'run-1', status: 'partial', stage: null, detail: null, counts: {}, events: [], started_at: null, heartbeat_at: null, completed_at: null, error: null, jobs: { total: 0, inserted: 0, verified_open: 0, likely_open: 0, unverified: 0, closed: 0, ranked: 0 }, partial: true, stale: false, stats: { discovery: { stopped, cursor: { v: 1, stages }, notes: ['BROAD: $4.00 ceiling', 'stopped: ' + stopped] } } }) as never
    check('a run stopped by its ceiling offers to be continued', runContinuation(stoppedRun('budget', ['plan'])).canContinue && (runContinuation(stoppedRun('budget', ['plan'])).note ?? '').includes('spend limit'))
    check('a run that ran out of time offers to be continued', runContinuation(stoppedRun('deadline', ['plan'])).canContinue)
    check('a saturated or finished run does NOT offer a second pass', !runContinuation(stoppedRun('saturated', ['plan', 'done'])).canContinue && !runContinuation(stoppedRun('complete', ['done'])).canContinue)
    check('a run with no discovery report is not offered as continuable', !runContinuation(stoppedRun('', [])).canContinue)
    check('the report’s own lines are what the screen shows', statsLines({ discovery: { notes: ['stopped: budget'] } }).some((l) => l === 'stopped: budget'))
  }

  // ─── L. The run's total clock, not just this invocation's ─────────────────
  console.log('run: the mode’s runtime is a real bound across passes')
  {
    check('a mode’s runtime is the WHOLE run’s, not one worker deadline', MODES.EXHAUSTIVE.maxRuntimeMs === 3_600_000 && MODES.QUICK.maxRuntimeMs === 300_000)
    // A continuation that has already used the mode's whole runtime starts
    // nothing new — otherwise "up to an hour" is a sentence no code reads and
    // a run can be continued forever.
    const spent = memStore({ watchlist: [ACME_ROW] })
    let sessions = 0
    let planners = 0
    const used = { ...emptyCursor(), stages: ['plan'], planned: PLAN.strategies, elapsed_ms: MODES.QUICK.maxRuntimeMs + 1, attempts: 1 }
    const r = await runJobScout(
      { userId: USER, mode: 'QUICK', verify: false, rank: false, budget: { deadlineMs: 30_000 }, cursor: used as ScoutCursor },
      { store: spent.store, rank: spent.rank, registry, fetcher, extractor, planner: async () => { planners++; return agentResult(PLAN, 'job_mission_planner') }, session: async () => { sessions++; return sessionResult(scouted(2)) } }
    )
    check('a run that has used its whole runtime starts no new work', sessions === 0 && planners === 0 && spent.mem.checked.length === 0, `${sessions} sessions · ${planners} planners · checked ${spent.mem.checked.join(',')}`)
    check('and it says which clock ran out', r.errors.some((e) => e.includes('minutes it was allowed')), r.errors.join(' | '))
    check('a legacy run is still bounded only by its own deadline', resolveRunBudget(null).maxRuntimeMs === 1_200_000)

    // The elapsed clock accumulates across passes, so the bound is real.
    const fresh = memStore({ watchlist: [] })
    const r2 = await runJobScout(
      { userId: USER, mode: 'BROAD', verify: false, rank: false, budget: { deadlineMs: 30_000 } },
      { store: fresh.store, rank: fresh.rank, registry, fetcher, extractor, planner: async () => agentResult(PLAN, 'job_mission_planner'), session: async () => sessionResult(scouted(2)) }
    )
    check('every run records how much of its runtime it used', r2.cursor.elapsed_ms >= 0 && r2.cursor.elapsed_ms <= 30_000, `${r2.cursor.elapsed_ms}ms`)
    check('the report says the pass number and the clock', r2.notes.some((n) => n.startsWith('pass ')), r2.notes.join(' | '))
  }

  console.log(failures === 0 ? '\nall mode/budget checks passed' : `\n${failures} check(s) FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
