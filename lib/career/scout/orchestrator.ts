// The Job Scout orchestrator — one run of discovery, end to end.
//
//   mission + evidence → PLAN → seed watchlist → COMPANY-FIRST (code)
//   → JOB-FIRST (scout sessions) → resolve → [flush: EXTRACT → cluster →
//   VERIFY → upsert] after every stage → RANK
//
// Everything with judgment is an agent call; everything else is here, as code,
// and every agent call is traced against one scouting_runs row. The two stages
// themselves live in ./stages.ts, the batch tail in ./persist.ts and the store
// in ./store.ts; this file is the shape of the run.
//
// Three rules shape it:
//
//   1. The company list is ONE INPUT to scouting, not the search universe, and
//      it is not all the same kind of thing. A Target is the user saying "I
//      want to work here"; an Explore row is the scout's own earlier guess.
//      `selectCompaniesToCheck` checks the user's choices first and rotates a
//      bounded sample of guesses, so a hundred old suggestions cannot starve
//      fresh discovery. Nothing an agent writes is ever more than `suggested`
//      (migration 016, ADR-039).
//
//   2. Whose choice a row was is read from `watch_source`, never from
//      `watch_status` alone (`toWatched` → `resolveStoredIntent`). Migration
//      016 is applied by hand; until it is, the table still holds 163 "targets"
//      an agent wrote, and a run that trusted the column would tell the planner
//      its own earlier guesses were the user's preferences.
//
//   3. A run that dies must not lose what it paid for. The batch tail
//      (persist.ts) runs after company-first and after EVERY job-first
//      strategy, so extracted, verified jobs are in the database before the
//      next stage starts. The deadline is checked at every stage boundary and
//      inside every loop: past it nothing new starts, whatever is in hand is
//      still persisted, and `stats.deadline_hit` / `result.partial` tell the
//      caller to finish the run as partial rather than succeeded.
//
// Every collaborator is injectable (JobScoutDeps) so the whole loop runs in
// memory under test with stub agents and a stub store. Production callers pass
// nothing and get the live modules.

import { runJobMissionPlanner, type SearchStrategy } from '@/lib/agents/job-mission-planner'
import type { AgentResult, ToolContext } from '@/lib/agents/runtime/types'
import { renderPreferences, renderSkills } from '../evidence/render'
import { getRelevantPersonalEvidence, renderRelevantEvidence } from '../evidence/retrieval'
import { renderFeedbackHints } from '../fit/feedback'
import { normalizeCompanyName, type NormalizedJob } from '../jobs/normalize'
import { sweepWatchlist, SWEEP_MAX_COMPANIES, type SweepResult, type SweepStore } from '../jobs/sweep'
import { runIntelligenceBatch } from '../intelligence/orchestrator'
import { renderMission, sanitizeDirection } from '../missions/store'
import { DEFAULT_SCOUT_BUDGET, type CareerBudget, type CareerRun } from '../runs'
import { setAnthropicDeadline } from '@/lib/providers/anthropic/client'
import { getPageFetcher } from '../sources/fetch'
import { getSourceRegistry } from '../sources/registry'
import type { RawJobPosting } from '../sources/types'
import type { CareerMission, VerificationStatus } from '../types'
import { seedWatchlistFromPlan } from './company-first'
import { fallbackStrategies, selectJobsToRank } from './direction'
import { extractPending, type PendingExtractionStore, type RejectedJob } from './extract'
import { isAtsListingSource, persistBatch, type BatchContext } from './persist'
import type { FetchBudget } from './resolve'
import { runCompanyFirstStage, runJobFirstStage, type StageRun } from './stages'
import { bump, emptyStats, noteQuery } from './stats'
import { buildPlannerWatchlist, liveScoutStore, toWatched, type ScoutedWatchCompany, type ScoutStore } from './store'
import type { JobScoutDeps, JobScoutParams, JobScoutResult, JobScoutResultJob, ScoutProgressCounts, ScoutRunStats } from './types'

// These were part of this module's surface before it was split. Re-exported so
// every existing import path keeps working.
export { directionMatches, directionPhrases, directionTerms, fallbackStrategies, rankCandidatePriority, selectJobsToRank } from './direction'
export { buildPlannerWatchlist, liveScoutStore, toWatched, type ScoutedWatchCompany, type ScoutStore } from './store'
export { MAX_SCOUT_COMPANY_CHECKS } from './stages'
export type { CompaniesSelected, JobScoutDeps, JobScoutParams, JobScoutResult, JobScoutResultJob, ScoutProgressCounts, ScoutRunStats } from './types'

/**
 * The share of the run's wall clock company-first may spend. The watchlist is
 * an input to discovery, not the whole of it: a long list of companies used to
 * be able to eat an entire run, and a run that only re-checks known companies
 * can never surface anything new. What is left is the job-first floor, and the
 * run says so in `stats.job_first_reserve_ms` when the cap bites.
 */
const COMPANY_FIRST_TIME_SHARE = 0.55
/**
 * The share of the run's wall clock the free sweep may spend before anything
 * costs money. It runs FIRST for one reason: a run should decide what to pay
 * for after it has seen the inventory, not before. A quarter of the clock is
 * enough for ~190 boards at concurrency 6, and whatever it does not use is
 * handed straight back to discovery.
 */
const SWEEP_TIME_SHARE = 0.25
// Post-scout ranking: how many of this run's jobs get a fit number before the
// run returns, how many at once, and how much of the deadline must be left.
// Research is skipped here (it is the slow stage); the package flow runs it.
const MAX_RANK_JOBS = 12
const RANK_CONCURRENCY = 3
const RANK_DEADLINE_RESERVE_MS = 20_000
const RANK_MIN_WINDOW_MS = 30_000

/**
 * The wide, cheap half of a run, and the paid pass over what it found.
 *
 * These are additions to `JobScoutParams` rather than edits to it, so every
 * existing caller keeps compiling and keeps its behaviour unchanged: both are
 * off until a caller asks, and deferred extraction additionally has to say how
 * much of itself to buy.
 */
export interface JobScoutSweepParams {
  /**
   * Sweep the whole watchlist before any model call.
   *
   * Opt-in, because the sweep's cost is WALL CLOCK and not every caller has
   * it: a Vercel worker with 280 seconds cannot afford both a 190-board sweep
   * and web discovery, while a CLI run with twenty minutes should always do
   * both. The callers that can afford it (the sweep CLI, POST
   * /api/career/sweep, the daily cron, `career:scout` locally) turn it on.
   */
  sweep?: boolean
  /** Companies the sweep may visit. Default: all of them. */
  maxSweepCompanies?: number
  /**
   * Extractions to run over the best UNEXTRACTED stored rows after discovery.
   * Off (0) unless asked for, and never more than the run's unspent in-flight
   * extraction budget — a run cannot exceed its own cap by taking this door.
   */
  deferredExtract?: number
}

export interface JobScoutSweepDeps {
  /** The pending-extraction surface. Required for `deferredExtract` under test. */
  pendingStore?: PendingExtractionStore
}

export function scoutToolContext(userId: string, runId: string | null, budget: CareerBudget): ToolContext {
  return { user_id: userId, run_id: runId, budget: { maxCompanies: 0, maxPeoplePerCompany: 0, maxApolloCalls: 0, maxWebSearches: budget.maxWebSearches, maxAgentSteps: budget.maxAgentSteps } }
}

// ─── The run ─────────────────────────────────────────────────────────────────

export async function runJobScout(params: JobScoutParams & JobScoutSweepParams, deps: JobScoutDeps & JobScoutSweepDeps = {}): Promise<JobScoutResult> {
  const started = Date.now()
  const store = deps.store ?? liveScoutStore()
  const registry = deps.registry ?? getSourceRegistry()
  const fetcher = deps.fetcher ?? getPageFetcher()
  const budget: CareerBudget = { ...DEFAULT_SCOUT_BUDGET, ...(params.budget ?? {}) }
  const deadline = started + budget.deadlineMs
  // The API client stops retrying past this point too (see setAnthropicDeadline):
  // a run that has already given up must not sit inside a retry storm.
  setAnthropicDeadline(deadline)
  const stats: ScoutRunStats = { ...emptyStats(), companies_selected: { target: 0, watching: 0, suggested: 0, skipped: 0 }, job_first_reserve_ms: 0 }
  const errors: string[] = []
  const rejected: RejectedJob[] = []
  const counts: ScoutProgressCounts = { discovered: 0, companies_checked: 0, jobs_extracted: 0, jobs: 0, inserted: 0, verified_open: 0, likely_open: 0, closed: 0, ranked: 0, rejected: 0 }
  let postingsFound = 0
  const progress = (stage: string, detail: string) => {
    // Derived counters are read from the stats they mirror, so they can only
    // ever move forward — a UI reading these never sees a number go backwards.
    counts.companies_checked = stats.companies_checked
    counts.discovered = postingsFound
    counts.jobs_extracted = stats.jobs_extracted
    counts.ranked = stats.jobs_ranked
    counts.rejected = rejected.length
    params.onProgress?.(stage, detail, { ...counts })
  }
  const pastDeadline = (stage: string): boolean => {
    if (Date.now() <= deadline) return false
    if (!stats.deadline_hit) errors.push(`deadline reached before ${stage}`)
    stats.deadline_hit = true
    return true
  }
  const fail = (message: string, migrationMissing = false): JobScoutResult => ({
    runId: null, mission: null, plan: null, stats, jobs: [], rejected: [], errors: [...errors, message], costUsd: 0, latencyMs: Date.now() - started, migrationMissing, partial: stats.deadline_hit,
  })

  // (a) Inputs.
  const m = await store.getMission(params.userId, params.missionId ?? null)
  if (m.migrationMissing) return fail('migration 014_career_os.sql has not been applied', true)
  if (!m.mission) return fail(m.error ?? 'no mission')
  // A CLI --direction replaces the stored direction for this run only: a new
  // object, so the stored mission row and the caller's object are untouched.
  const mission: CareerMission = params.directionOverride !== undefined
    ? { ...m.mission, preferences: { ...m.mission.preferences, direction: sanitizeDirection(params.directionOverride) } }
    : m.mission
  const missionText = renderMission(mission)
  const direction = sanitizeDirection(mission.preferences.direction)
  const bankRes = await store.loadBank(params.userId)
  if (bankRes.migrationMissing) return fail('migration 014_career_os.sql has not been applied', true)
  errors.push(...bankRes.errors)
  const watch = await store.listWatchlist(params.userId)
  if (watch.migrationMissing) return fail('migration 014_career_os.sql has not been applied', true)
  if (watch.error) errors.push(`watchlist: ${watch.error}`)
  // toWatched resolves intent from watch_source, so an agent's `target` is read
  // as the suggestion it is — before migration 016 as well as after it.
  const watchlist = watch.companies.map(toWatched)
  const feedback = await store.recentFeedback(params.userId, 30)
  // Companies the user rejected: never scouted, but the planner must know not
  // to propose them again. A store that cannot answer simply says nothing.
  let ignoredCompanies: ScoutedWatchCompany[] = []
  if (store.listIgnoredCompanies) {
    const ig = await store.listIgnoredCompanies(params.userId)
    if (ig.error) errors.push(`ignored companies: ${ig.error}`)
    ignoredCompanies = ig.companies.map(toWatched)
  }

  // (b) The run row. Agent traces attach to it from here on.
  const run = await store.startRun({ userId: params.userId, kind: 'job_scout', label: params.label ?? `job scout · ${mission.name}`, mission: { name: mission.name, objective: mission.objective }, budget, careerMissionId: mission.id })
  const ctx = scoutToolContext(params.userId, run.runId, budget)
  const traced = async (res: AgentResult<unknown>, refs: Record<string, unknown>) => {
    stats.model_calls++
    stats.web_searches += res.trace.web_searches
    await run.trace(res, refs)
  }

  // (c) Plan. The company list is one input, and the planner is told whose
  // choice each part of it was.
  progress('plan', direction ? `planning from your direction: ${direction.slice(0, 100)}${direction.length > 100 ? '…' : ''}` : 'planning from the evidence (no direction stated)')
  progress('plan', 'asking the mission planner')
  const planner = deps.planner ?? runJobMissionPlanner
  const planRes = await planner(
    {
      mission: missionText,
      evidenceSummaries: renderRelevantEvidence(getRelevantPersonalEvidence({ bank: bankRes.bank, mission: missionText, target: { kind: 'generic' }, maxExperiences: 8, maxFacts: 16 }), { style: 'compact' }),
      skills: renderSkills(bankRes.bank),
      preferences: renderPreferences(bankRes.bank),
      watchlist: buildPlannerWatchlist(watchlist, ignoredCompanies, feedback),
      recentFeedback: renderFeedbackHints(feedback),
    },
    ctx
  )
  await traced(planRes as AgentResult<unknown>, { mission_id: mission.id })
  const plan = planRes.output
  if (!plan) errors.push(`planner ${planRes.status}: ${planRes.error ?? 'no plan'} — company-first only`)
  else {
    for (const s of plan.strategies) for (const q of s.queries) noteQuery(stats, q)
    // Seeds are EXPLORATION CANDIDATES. seedWatchlistFromPlan writes them as
    // suggestions with a planner origin — never as targets; only the user
    // promotes a company (ADR-039).
    const seeded = await seedWatchlistFromPlan(params.userId, plan.seed_companies, [...watchlist.map((w) => w.name), ...ignoredCompanies.map((c) => c.name)], { store })
    if (seeded.migrationMissing) return finish(run, 'failed', 'migration 014_career_os.sql has not been applied', true)
    errors.push(...seeded.errors)
    progress('plan', `${plan.strategies.length} strategies, ${plan.seed_companies.length} seeds (${seeded.added} new to explore)`)
    if (seeded.added) {
      const again = await store.listWatchlist(params.userId)
      if (!again.error) watchlist.splice(0, watchlist.length, ...again.companies.map(toWatched))
    }
  }

  // The batch tail, shared by every flush point below.
  const fetchBudget: FetchBudget = { left: budget.maxPageFetches }
  const atsListedUrls = new Set<string>()
  const extractBudget = { left: params.maxExtract ?? 40 }
  const persistedJobs: NormalizedJob[] = []
  const idByJob = new Map<NormalizedJob, string>()
  // Stored ROWS, not sightings: a posting two stages both found is one row.
  const persistedIds = new Set<string>()
  const statusById = new Map<string, VerificationStatus>()
  const statusWithoutId: VerificationStatus[] = []
  let insertedRows = 0
  const batch: BatchContext = {
    userId: params.userId, mission, ctx, run, store, stats, registry, fetcher,
    extractor: deps.extractor, verifier: deps.verifier,
    deadline, concurrency: params.concurrency ?? 4, verify: params.verify !== false,
    fetchBudget, atsListedUrls,
    domainFor: (name) => {
      const key = normalizeCompanyName(name) ?? name.toLowerCase()
      return watchlist.find((w) => w.domain && (normalizeCompanyName(w.name) ?? w.name.toLowerCase()) === key)?.domain ?? null
    },
    pastDeadline,
    onProgress: (d) => progress('extract', d),
  }

  const pending: RawJobPosting[] = []
  const keepRaw = (p: RawJobPosting) => {
    pending.push(p)
    postingsFound++
    if (p.source_type && isAtsListingSource(p.source_type)) atsListedUrls.add(p.canonical_url ?? p.source_url)
    bump(stats.sources_consulted, p.source_type)
  }

  /**
   * Checkpoint: everything gathered since the last flush is extracted,
   * clustered, verified and STORED before the next stage starts. Returns false
   * only when the schema is missing, which is fatal for the run.
   */
  const flush = async (label: string): Promise<boolean> => {
    if (pending.length === 0) return true
    const raws = pending.splice(0, pending.length)
    progress('extract', `${raws.length} raw postings from ${label}`)
    const out = await persistBatch(raws, batch, extractBudget)
    rejected.push(...out.rejected)
    errors.push(...out.errors)
    if (out.migrationMissing) return false
    for (let i = 0; i < out.jobs.length; i++) {
      const job = out.jobs[i]
      persistedJobs.push(job)
      const id = out.ids[i]
      if (id) {
        idByJob.set(job, id)
        persistedIds.add(id)
        // Keyed by stored id, so the same posting seen twice is one row with
        // one verdict rather than two sightings counted twice.
        statusById.set(id, job.verification_status)
      } else statusWithoutId.push(job.verification_status)
    }
    insertedRows += out.inserted
    countStored()
    progress('persist', `${label}: ${out.inserted} new, ${out.updated} updated (${persistedJobs.length} this run)`)
    return true
  }

  /** Recompute the stored-row counts from the distinct rows this run holds. */
  function countStored(): void {
    counts.jobs = persistedIds.size + statusWithoutId.length
    counts.inserted = insertedRows
    let open = 0
    let likely = 0
    let closed = 0
    for (const s of [...statusById.values(), ...statusWithoutId]) {
      if (s === 'VERIFIED_OPEN') open++
      else if (s === 'LIKELY_OPEN') likely++
      else if (s === 'CLOSED') closed++
    }
    counts.verified_open = open
    counts.likely_open = likely
    counts.closed = closed
  }

  // Everything the two stages share with this run.
  const stageRun: StageRun = {
    userId: params.userId, ctx, store, registry, fetcher, stats, errors,
    deadline, concurrency: params.concurrency ?? 4,
    progress, keepRaw, flush, pastDeadline, traced,
  }

  // (c2) SWEEP — the free, wide pass, and it goes FIRST.
  //
  //      Every company on the watchlist with a resolvable board, listed through
  //      the registry and stored with the extracted columns null. No model call
  //      is reachable from here (lib/career/jobs/sweep.ts pins the extraction
  //      budget to zero and verification off), so it costs the run nothing but
  //      wall clock, and it decides what the rest of the run is choosing FROM.
  //
  //      It does not narrow company-first. Re-listing a board the sweep just
  //      read is free — the adapters cache a listing per board per day — and
  //      the store matches the second sighting to the row the sweep inserted.
  //      What company-first still owns is the run's account of the user's own
  //      choices (`companies_selected`), which is a different question from
  //      "what is on the market today".
  const sweepJobs: SweepResult['jobs'] = []
  if (params.sweep === true && !pastDeadline('sweep')) {
    progress('sweep', 'listing every resolvable board on the watchlist (no model calls)')
    try {
      // Its OWN stats object. The two passes see the same postings — the sweep
      // lists a board, company-first re-lists it from cache — so sharing one
      // record would count every rejection and every verdict twice and quietly
      // double the funnel the founder reads.
      const sweepStats = emptyStats()
      const sw = await sweepWatchlist(
        params.userId,
        {
          mission,
          limit: params.maxSweepCompanies ?? SWEEP_MAX_COMPANIES,
          deadline: Math.min(deadline, started + Math.floor(budget.deadlineMs * SWEEP_TIME_SHARE)),
          runId: run.runId,
          ctx,
          stats: sweepStats,
          onProgress: (stage, detail) => progress(stage, detail),
        },
        { store: store as SweepStore, registry, fetcher }
      )
      if (sw.migrationMissing) return finish(run, 'failed', 'migration 014_career_os.sql has not been applied', true)
      errors.push(...sw.errors)
      // The sweep persisted through the same `upsertJobs`, so its rows belong
      // to this run's counts exactly as a stage's do. Merged by hand, once, so
      // it is obvious which numbers a sweep contributes.
      stats.companies_checked += sw.checked
      stats.companies_with_openings += sw.withOpenings
      stats.postings_seen += sw.postingsListed
      stats.postings_resolved += sw.postingsListed
      stats.jobs_inserted += sw.inserted
      stats.jobs_updated += sw.updated
      bump(stats.sources_consulted, 'sweep:postings', sw.postingsListed)
      bump(stats.sources_consulted, 'sweep:boards', sw.withBoard)
      // Prefixed so they are visible without colliding with the stages' own
      // counts for the same rule — nothing a sweep discards is hidden.
      for (const [reason, n] of Object.entries(sw.rejected)) bump(stats.jobs_rejected, `sweep:${reason}`, n)
      postingsFound += sw.postingsListed
      insertedRows += sw.inserted
      for (const j of sw.jobs) {
        sweepJobs.push(j)
        persistedIds.add(j.id)
        statusById.set(j.id, j.verification_status as VerificationStatus)
      }
      countStored()
      progress('sweep', `${sw.checked} companies · ${sw.postingsListed} postings · ${sw.inserted} new, ${sw.updated} updated${sw.remaining ? ` · ${sw.remaining} companies left for the next sweep` : ''}`)
    } catch (e) {
      // A sweep is an optimisation, never a precondition: a run whose sweep
      // throws still does everything it did before the sweep existed.
      errors.push(`sweep: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // (d) Company-first, by INTENT: every Target, then Watching, then a rotating
  //     least-recently-checked sample of Explore. The watchlist is an input to
  //     the run, never its ceiling — hence both the explore cap inside
  //     selectCompaniesToCheck and the wall-clock floor kept for job-first.
  const cfReserveMs = Math.max(0, budget.deadlineMs - Math.floor(budget.deadlineMs * COMPANY_FIRST_TIME_SHARE))
  stats.job_first_reserve_ms = cfReserveMs
  if (!pastDeadline('company-first')) {
    const cf = await runCompanyFirstStage(stageRun, {
      watchlist,
      budget: params.maxCompaniesFirst ?? 25,
      reserveMs: cfReserveMs,
      stageDeadline: Math.min(deadline, started + budget.deadlineMs - cfReserveMs),
    })
    stats.companies_selected = { ...cf.selection.counts, skipped: cf.selection.skipped }
    if (!cf.ok) return finish(run, 'failed', 'migration 014_career_os.sql has not been applied', true)
  }

  // (e) Job-first: one scout session per strategy, budgets shared, persisted
  //     after each one.
  //
  // A failed planner must not take job-first discovery down with it. The eval
  // saw exactly that: one schema-invalid plan, and a $4.71 run found nothing.
  // Without a plan the strategies are built deterministically from the mission —
  // fewer and blunter than a planned set, and labelled as such in the errors.
  const strategySource: SearchStrategy[] = plan ? plan.strategies : fallbackStrategies(mission)
  if (!plan && strategySource.length) errors.push(`job-first ran on ${strategySource.length} deterministic fallback strategies (planner failed)`)
  if (strategySource.length && !pastDeadline('job-first')) {
    const jf = await runJobFirstStage(stageRun, {
      missionText,
      strategies: strategySource,
      maxStrategies: params.maxStrategies ?? 3,
      maxRounds: params.maxRoundsPerStrategy ?? 2,
      maxAtsLookups: budget.maxAtsLookups,
      maxPageFetches: budget.maxPageFetches,
      fetchBudget,
      known: new Set([...watchlist, ...ignoredCompanies].map((w) => normalizeCompanyName(w.name) ?? w.name.toLowerCase())),
      persistedJobs,
      session: deps.session,
      lookupBoard: deps.lookupBoard,
      fetchPage: deps.fetchPage,
    })
    if (!jf.ok) return finish(run, 'failed', 'migration 014_career_os.sql has not been applied', true)
  }

  // (f) Anything still in hand — a deadline can cut a stage between keepRaw and
  //     its flush. Nothing this run paid for is discarded.
  if (!(await flush('final'))) return finish(run, 'failed', 'migration 014_career_os.sql has not been applied', true)

  // (f2) DEFERRED EXTRACTION — the paid pass over what the free one found.
  //
  //      The sweep stores postings thin, on purpose. This is where a bounded
  //      number of them get read properly, chosen by deterministic relevance
  //      rather than by which board answered first. It can never exceed the
  //      run's own extraction cap: it spends what in-flight extraction did not.
  //      Off unless the caller asks for it and injects (or is in production
  //      with) a pending-extraction store.
  const deferred = Math.min(params.deferredExtract ?? 0, Math.max(0, extractBudget.left))
  if (deferred > 0 && !pastDeadline('deferred extraction')) {
    progress('extract', `filling in the ${deferred} highest-relevance postings stored without an extraction`)
    const ep = await extractPending(params.userId, {
      limit: deferred,
      order: 'relevance',
      direction: mission.preferences.direction,
      mission: { geo_tiers: mission.preferences.geo_tiers },
      ctx,
      run,
      concurrency: params.concurrency ?? 4,
      deadline,
      stats,
      extractor: deps.extractor,
      store: deps.pendingStore,
      onProgress: (d) => progress('extract', d),
    })
    extractBudget.left = Math.max(0, extractBudget.left - ep.extracted)
    errors.push(...ep.errors)
    if (ep.migrationMissing) return finish(run, 'failed', 'migration 014_career_os.sql has not been applied', true)
    progress('extract', `deferred: ${ep.extracted} of ${ep.candidates} pending rows extracted ($${ep.costUsd.toFixed(4)})`)
  }

  // (g) Rank what was just stored, so the list the user gets back has fit
  // numbers on it. Stored evaluations at the current prompt version are reused
  // inside the batch, so only jobs without one cost anything. Bounded by count,
  // by concurrency and by what is left of the deadline; a batch that cannot
  // start is reported, never silently skipped.
  // One entry per STORED row. Two stages can see the same posting — the store
  // matched the second sighting to the first row — so it is ranked and
  // reported once, under the id the store gave it.
  const rankJobs: NormalizedJob[] = []
  const rankIds: string[] = []
  const resultJobs: JobScoutResultJob[] = []
  const seenIds = new Set<string>()
  for (const job of persistedJobs) {
    const id = idByJob.get(job)
    if (id) {
      if (seenIds.has(id)) continue
      seenIds.add(id)
      rankJobs.push(job)
      rankIds.push(id)
    }
    resultJobs.push({
      id, title: job.title, company_name: job.company_name, location_raw: job.location_raw, location_tier: job.location_tier, season_relevance: job.season_relevance,
      employment_type: job.employment_type, verification_status: job.verification_status, canonical_url: job.canonical_url, source_types: [...new Set(job.sources.map((s) => s.source_type))],
    })
  }
  // The sweep's rows are this run's too. They arrive already ordered by
  // relevance, and any the stages re-found are dropped by id — a posting the
  // sweep listed and company-first re-listed is one row, reported once.
  const sweepOnly: string[] = []
  for (const j of sweepJobs) {
    if (seenIds.has(j.id)) continue
    seenIds.add(j.id)
    sweepOnly.push(j.id)
    resultJobs.push({
      id: j.id, title: j.title, company_name: j.company_name, location_raw: j.location_raw, location_tier: j.location_tier,
      season_relevance: j.season_relevance, employment_type: j.employment_type, verification_status: j.verification_status as VerificationStatus,
      canonical_url: j.canonical_url, source_types: j.source_types,
    })
  }
  if ((rankIds.length > 0 || sweepOnly.length > 0) && params.rank !== false) {
    const window = deadline - Date.now() - RANK_DEADLINE_RESERVE_MS
    if (params.directionOverride !== undefined) {
      // Fit rows are persisted under the stored mission's id and reused at the
      // same prompt version; judging them against a direction that was never
      // saved would pollute every later run. Say so rather than rank quietly
      // against the wrong direction.
      const skip = 'ranking skipped: --direction is not applied to fit (fit rows are stored against the saved mission — save the direction on the Jobs page to rank against it)'
      errors.push(skip)
      progress('rank', skip)
    } else if (window < RANK_MIN_WINDOW_MS) {
      errors.push(`ranking skipped: ${Math.max(0, Math.round(window / 1000))}s left of the deadline`)
    } else {
      // The stages' rows are chosen by `selectJobsToRank` (which can see the
      // whole NormalizedJob); the sweep's are already relevance-ordered and top
      // up whatever room is left. A run whose inventory came entirely from the
      // sweep still ranks the best of it.
      const toRank = selectJobsToRank(rankJobs, rankIds, MAX_RANK_JOBS, mission.preferences.direction)
      for (const id of sweepOnly) {
        if (toRank.length >= MAX_RANK_JOBS) break
        toRank.push(id)
      }
      progress('rank', `${toRank.length} jobs`)
      const rank = deps.rank ?? runIntelligenceBatch
      try {
        const r = await rank(params.userId, toRank, { concurrency: RANK_CONCURRENCY, deadlineMs: window, skip: { research: true }, label: `post-scout ranking · ${mission.name}` })
        stats.jobs_ranked = Object.values(r.results).filter((x) => x.fit !== null).length
        stats.rank_cost_usd = Number(r.costUsd.toFixed(4))
        if (r.skipped.length) errors.push(`ranking: ${r.skipped.length} job(s) not started before the deadline`)
        errors.push(...r.errors)
      } catch (e) {
        errors.push(`ranking: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  return finish(run, 'succeeded', null, false, resultJobs)

  async function finish(r: CareerRun, status: 'succeeded' | 'failed', error: string | null, migrationMissing: boolean, out: JobScoutResultJob[] = []): Promise<JobScoutResult> {
    // The deadline belongs to this run only; a later call in the same process
    // (a package build, an eval) must not inherit an expired one.
    setAnthropicDeadline(null)
    if (error) errors.push(error)
    // The ranking batch runs under its own run row; its cost is added here so the scout's number is what the whole call cost.
    stats.cost_usd = Number((r.costUsd() + stats.rank_cost_usd).toFixed(4))
    stats.latency_ms = Date.now() - started
    progress('done', `${out.length} jobs · ${stats.jobs_inserted} new`)
    await r.finish(status, { ...stats }, error)
    return {
      runId: r.runId,
      mission: { id: mission.id, name: mission.name },
      plan: plan ? { role_families: plan.role_families.map((f) => f.name), strategies: plan.strategies.map((s) => ({ name: s.name, kind: s.kind, priority: s.priority })), seed_companies_count: plan.seed_companies.length, adjacent_categories: plan.adjacent_categories } : null,
      stats, jobs: out, rejected, errors, costUsd: stats.cost_usd, latencyMs: stats.latency_ms, migrationMissing,
      // A run that ran out of clock still succeeded at what it managed; the
      // caller records it as `partial` so nobody reads it as a full sweep.
      partial: stats.deadline_hit && status === 'succeeded',
    }
  }
}
