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

import { runJobMissionPlanner, type JobMissionPlan, type SearchStrategy } from '@/lib/agents/job-mission-planner'
import type { AgentResult, ToolContext } from '@/lib/agents/runtime/types'
import { renderPreferences, renderSkills } from '../evidence/render'
import { getRelevantPersonalEvidence, renderRelevantEvidence } from '../evidence/retrieval'
import { renderFeedbackHints } from '../fit/feedback'
import { normalizeCompanyName, type NormalizedJob } from '../jobs/normalize'
import { SWEEP_MAX_COMPANIES, type SweepResult } from '../jobs/sweep'
import { runIntelligenceBatch } from '../intelligence/orchestrator'
import { renderMission, sanitizeDirection } from '../missions/store'
import { DEFAULT_SCOUT_BUDGET, type CareerBudget, type CareerRun } from '../runs'
import { setAnthropicDeadline } from '@/lib/providers/anthropic/client'
import { getPageFetcher } from '../sources/fetch'
import { getSourceRegistry } from '../sources/registry'
import type { RawJobPosting } from '../sources/types'
import type { CareerMission, VerificationStatus } from '../types'
import { createSpendLedger, STAGE_COST_ESTIMATE_USD, type YieldSample } from '../discovery/budget'
import { resolveRunBudget, type RunMode } from '../discovery/modes'
import { emptyCursor, sanitizeCursor, type ScoutCursor } from './run-dispatch'
import { buildRunReport, isRunFinished, stopReasonOf, type JobScoutRunReport, type ScoutStopReason } from './run-report'
import { collectRunJobs, runRankStage, RANK_DEADLINE_RESERVE_MS } from './rank-stage'
import { seedWatchlistFromPlan } from './company-first'
import { fallbackStrategies } from './direction'
import { extractPending, type PendingExtractionStore, type RejectedJob } from './extract'
import { isAtsListingSource, persistBatch, type BatchContext } from './persist'
import type { FetchBudget } from './resolve'
import { runCompanyFirstStage, runJobFirstStage, runSweepStage, type DiscoveryLane, type StageRun } from './stages'
import { bump, emptyStats, noteQuery } from './stats'
import { buildPlannerWatchlist, liveScoutStore, toWatched, type ScoutedWatchCompany, type ScoutStore } from './store'
import type { JobScoutDeps, JobScoutParams, JobScoutResult, JobScoutResultJob, ScoutProgressCounts, ScoutRunStats } from './types'

// These were part of this module's surface before it was split. Re-exported so
// every existing import path keeps working.
export { directionMatches, directionPhrases, directionTerms, fallbackStrategies, rankCandidatePriority, selectJobsToRank } from './direction'
export { buildPlannerWatchlist, liveScoutStore, toWatched, type ScoutedWatchCompany, type ScoutStore } from './store'
export { MAX_SCOUT_COMPANY_CHECKS } from './stages'
export type { CompaniesSelected, JobScoutDeps, JobScoutParams, JobScoutResult, JobScoutResultJob, ScoutProgressCounts, ScoutRunStats } from './types'
export { buildRunReport, isRunFinished, stopReasonOf, type JobScoutRunReport, type ScoutStopReason } from './run-report'

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

/**
 * How big this run is, as ONE choice — and where a previous invocation of it
 * stopped.
 *
 * Every field is optional, and a caller that passes none of them gets exactly
 * the behaviour this orchestrator had before run modes existed (LEGACY_BUDGET:
 * no spend ceiling, no saturation stopping, the old per-stage numbers). That
 * is deliberate: the CLI, the eval and the offline suites must not change
 * behaviour on the day a mode is added.
 */
export interface JobScoutModeParams {
  /** QUICK · BROAD · EXHAUSTIVE. Omitted means "the legacy numbers". */
  mode?: RunMode
  /** A hard ceiling in dollars. Overrides the mode's own. */
  maxSpendUsd?: number
  /** Where the last invocation of this run stopped. Omitted means "start at the beginning". */
  cursor?: ScoutCursor | null
  /**
   * Called whenever the cursor moves, so the caller can persist it on the run
   * row DURING the run rather than only at the end — a worker that is killed
   * between stages must still leave a resumable cursor behind.
   */
  onCursor?: (cursor: ScoutCursor) => void
}

export type JobScoutRunResult = JobScoutResult & JobScoutRunReport

export function scoutToolContext(userId: string, runId: string | null, budget: CareerBudget): ToolContext {
  return { user_id: userId, run_id: runId, budget: { maxCompanies: 0, maxPeoplePerCompany: 0, maxApolloCalls: 0, maxWebSearches: budget.maxWebSearches, maxAgentSteps: budget.maxAgentSteps } }
}

// ─── The run ─────────────────────────────────────────────────────────────────

export async function runJobScout(
  params: JobScoutParams & JobScoutSweepParams & JobScoutModeParams,
  deps: JobScoutDeps & JobScoutSweepDeps = {}
): Promise<JobScoutRunResult> {
  const started = Date.now()
  const store = deps.store ?? liveScoutStore()
  const registry = deps.registry ?? getSourceRegistry()
  const fetcher = deps.fetcher ?? getPageFetcher()
  const budget: CareerBudget = { ...DEFAULT_SCOUT_BUDGET, ...(params.budget ?? {}) }

  // ── How big is this run, and where did the last invocation stop? ──
  //
  // The mode is the only knob a user turns; everything below reads its budget
  // rather than a constant. A caller that named no mode gets LEGACY_BUDGET,
  // which has no spend ceiling — a ceiling nobody asked for could truncate the
  // founder's twenty-minute CLI run, so one only exists when a mode or an
  // explicit maxSpendUsd says so.
  const runBudget = resolveRunBudget(params.mode ?? null, {
    maxSpendUsd: params.maxSpendUsd ?? null,
    maxExtract: params.maxExtract ?? null,
    maxStrategies: params.maxStrategies ?? null,
    maxRoundsPerStrategy: params.maxRoundsPerStrategy ?? null,
    maxCompanyFirst: params.maxCompaniesFirst ?? null,
  })
  const cursor: ScoutCursor = params.cursor ? sanitizeCursor(params.cursor) : emptyCursor()
  cursor.attempts += 1

  // ── Two clocks, and the smaller one wins ──
  //
  // `budget.deadlineMs` is what THIS invocation has (280s on Vercel, 1200s
  // locally). `runBudget.maxRuntimeMs` is what the whole run may take across
  // however many invocations — an hour for EXHAUSTIVE — and the cursor
  // carries how much of it earlier passes already used. Without this second
  // clock the mode's runtime was a sentence in the UI that no code read, and
  // a run could be continued forever.
  //
  // It applies only to a run that NAMED a mode: a legacy caller's clock is
  // exactly the deadline it passed, as it has always been.
  const openingElapsedMs = cursor.elapsed_ms
  const runtimeLeftMs = params.mode ? Math.max(0, runBudget.maxRuntimeMs - openingElapsedMs) : budget.deadlineMs
  const windowMs = Math.max(0, Math.min(budget.deadlineMs, runtimeLeftMs))
  const deadline = started + windowMs
  const doneStages = new Set(cursor.stages)
  const checkedCompanies = new Set(cursor.companies)
  const doneStrategies = new Set(cursor.strategies)
  // What earlier invocations of this run already spent. Held separately from
  // `cursor.spent_usd`, which is REWRITTEN below with the ledger's running
  // total — adding a total to itself would double-count every stage and let a
  // run refuse work it could afford (or, worse, believe it was under a ceiling
  // it had passed).
  const openingUsd = cursor.spent_usd
  const ledger = createSpendLedger({ limitUsd: runBudget.maxSpendUsd, openingUsd })
  const lanes: Record<DiscoveryLane, number> = { broad_market: 0, company_first: 0 }
  let stageYields: YieldSample[] = []
  let budgetStopped: string | null = null
  let saturationStopped: string | null = null
  /** The ledger follows the run's own trace, so it prices nothing itself. */
  const syncSpend = (stage: string) => {
    ledger.syncTotal(openingUsd + runCost(), { stage })
    cursor.spent_usd = ledger.spent()
  }
  const noteCursor = (patch: Partial<ScoutCursor> = {}) => {
    Object.assign(cursor, patch)
    cursor.stages = [...doneStages]
    cursor.companies = [...checkedCompanies].slice(-3000)
    cursor.strategies = [...doneStrategies]
    cursor.elapsed_ms = openingElapsedMs + (Date.now() - started)
    cursor.updated_at = new Date().toISOString()
    params.onCursor?.({ ...cursor, pages: { ...cursor.pages } })
  }
  // The API client stops retrying past this point too (see setAnthropicDeadline):
  // a run that has already given up must not sit inside a retry storm.
  setAnthropicDeadline(deadline)
  const stats: ScoutRunStats = { ...emptyStats(), companies_selected: { target: 0, watching: 0, suggested: 0, skipped: 0 }, job_first_reserve_ms: 0 }
  const errors: string[] = []
  // Set at stage (b). Everything before it is free, so an unset run costs $0.
  let runRef: CareerRun | null = null
  const runCost = (): number => (runRef ? runRef.costUsd() : 0) + stats.rank_cost_usd
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
    // `runtimeLeftMs <= 0` is checked in its own right, not left to the clock:
    // a run continued after its whole runtime is used has a zero-length
    // window, and "is now past a deadline equal to now" is a millisecond race
    // that let a stage slip through.
    if (runtimeLeftMs > 0 && Date.now() <= deadline) return false
    if (!stats.deadline_hit) {
      // Which clock ran out matters to the founder: one is "give it another
      // pass", the other is "this run has had its hour".
      errors.push(
        runtimeLeftMs <= 0
          ? `the run has used all ${Math.round(runBudget.maxRuntimeMs / 60_000)} minutes it was allowed, so ${stage} was not started`
          : `deadline reached before ${stage}`
      )
    }
    stats.deadline_hit = true
    return true
  }
  /**
   * How this run stopped, and everything a report needs to say why.
   *
   * A run stopped by money or by the clock has work left and its cursor says
   * where. A SATURATED run does not: every remaining strategy was deliberately
   * skipped because the last ones added nothing new, so the cursor is marked
   * done and the run is finished — while `stopped` still says saturation, so
   * nobody reads it as a full sweep of a market that was simply exhausted
   * early. (`isRunFinished` in run-report.ts is the one place that decides.)
   */
  const report = (everyStageRan: boolean): JobScoutRunReport => {
    const stopped: ScoutStopReason = stopReasonOf({ everyStageRan, deadlineHit: stats.deadline_hit, budgetStopped, saturationStopped })
    if (isRunFinished(stopped)) doneStages.add('done')
    cursor.stages = [...doneStages]
    cursor.companies = [...checkedCompanies].slice(-3000)
    cursor.strategies = [...doneStrategies]
    cursor.spent_usd = ledger.spent()
    cursor.elapsed_ms = openingElapsedMs + (Date.now() - started)
    cursor.updated_at = new Date().toISOString()
    return buildRunReport({
      budget: runBudget,
      cursor,
      spend: ledger.summary(),
      cost: ledger.metrics({ uniquePostings: postingsFound, storedJobs: counts.jobs, rankedJobs: stats.jobs_ranked }),
      lanes: { ...lanes },
      yields: stageYields,
      everyStageRan,
      deadlineHit: stats.deadline_hit,
      budgetStopped,
      saturationStopped,
    })
  }
  const fail = (message: string, migrationMissing = false): JobScoutRunResult => ({
    runId: null, mission: null, plan: null, stats, jobs: [], rejected: [], errors: [...errors, message], costUsd: 0, latencyMs: Date.now() - started, migrationMissing, partial: stats.deadline_hit,
    ...report(false),
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
  runRef = run
  const ctx = scoutToolContext(params.userId, run.runId, budget)
  const traced = async (res: AgentResult<unknown>, refs: Record<string, unknown>) => {
    stats.model_calls++
    stats.web_searches += res.trace.web_searches
    await run.trace(res, refs)
    // Every agent call is priced by the runtime, so the ledger follows the
    // trace rather than guessing: what a run REPORTS having spent is always
    // what it actually spent, and only what it DARES to start next uses an
    // estimate.
    syncSpend((refs.stage as string) ?? 'agents')
  }

  // (c) Plan. The company list is one input, and the planner is told whose
  // choice each part of it was.
  //
  // A CONTINUATION does not re-plan. The plan is the run's most expensive
  // single call, it is deterministic work from the same inputs, and paying for
  // it once per worker invocation would be the most expensive possible way to
  // resume — so the cursor carries the strategies and this stage is skipped.
  let plan: JobMissionPlan | null = null
  let resumedStrategies: SearchStrategy[] | null = null
  if (doneStages.has('plan') && cursor.planned && cursor.planned.length > 0) {
    resumedStrategies = cursor.planned
    progress('plan', `resuming: ${resumedStrategies.length} strategies from the plan this run already paid for`)
  } else {
    const allowedToPlan = ledger.canSpend(STAGE_COST_ESTIMATE_USD.plan, { stage: 'the mission planner' })
    if (!allowedToPlan.ok) {
      budgetStopped = allowedToPlan.reason
      errors.push(`planning skipped: ${allowedToPlan.reason}`)
      progress('plan', `skipped: ${allowedToPlan.reason}`)
    } else {
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
      await traced(planRes as AgentResult<unknown>, { mission_id: mission.id, stage: 'plan' })
      plan = planRes.output
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
        // Written to the cursor NOW, before any discovery: a worker killed
        // mid-run must never make the next one pay for this again.
        doneStages.add('plan')
        noteCursor({ planned: plan.strategies })
      }
    }
  }

  // The batch tail, shared by every flush point below.
  const fetchBudget: FetchBudget = { left: budget.maxPageFetches }
  const atsListedUrls = new Set<string>()
  // The mode's number, with an explicit params.maxExtract still winning (it is
  // applied inside resolveRunBudget), so a caller that passes its own number
  // keeps exactly that number.
  const extractBudget = { left: runBudget.maxExtract }
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
  const keepRaw = (p: RawJobPosting, lane: DiscoveryLane = 'company_first') => {
    pending.push(p)
    postingsFound++
    lanes[lane]++
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
    // The ceiling reaches inside the batch too. Extraction is a model call per
    // posting and it is where a long run's money actually goes, so what is
    // affordable is recomputed at every checkpoint — a run stops READING
    // postings at its ceiling, but never stops STORING them.
    const affordable = ledger.affordable(STAGE_COST_ESTIMATE_USD.extract)
    if (affordable < extractBudget.left) {
      if (affordable === 0 && extractBudget.left > 0 && !budgetStopped) {
        budgetStopped = ledger.canSpend(STAGE_COST_ESTIMATE_USD.extract, { stage: 'extraction' }).reason
        errors.push(`extraction stopped: ${budgetStopped} — postings are still stored, just not read`)
      }
      extractBudget.left = affordable
    }
    const out = await persistBatch(raws, batch, extractBudget)
    syncSpend('extract')
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
  //
  //      A mode turns it on by itself (every mode sweeps — it is free), while
  //      a caller that named no mode keeps the old opt-in. A continuation
  //      skips it: the boards were listed on the first pass and re-listing
  //      them would spend the new invocation's clock on work already done.
  const sweepJobs: SweepResult['jobs'] = []
  const doSweep = params.sweep ?? runBudget.sweep
  if (doSweep && doneStages.has('sweep')) progress('sweep', 'resuming: the watchlist was already swept on an earlier pass')
  if (doSweep && !doneStages.has('sweep') && !pastDeadline('sweep')) {
    const sw = await runSweepStage(stageRun, {
      mission,
      limit: params.maxSweepCompanies ?? SWEEP_MAX_COMPANIES,
      stageDeadline: Math.min(deadline, started + Math.floor(budget.deadlineMs * SWEEP_TIME_SHARE)),
      runId: run.runId,
    })
    if (!sw.ok) return finish(run, 'failed', 'migration 014_career_os.sql has not been applied', true)
    postingsFound += sw.postings
    // The sweep reads the WATCHLIST, so its yield is company-first however
    // free it was. Counting it as market discovery would flatter exactly the
    // number this run is supposed to be honest about.
    lanes.company_first += sw.postings
    insertedRows += sw.inserted
    for (const j of sw.jobs) {
      sweepJobs.push(j)
      persistedIds.add(j.id)
      statusById.set(j.id, j.verification_status as VerificationStatus)
    }
    countStored()
    // Only a sweep that reached every company is finished for good; one that
    // left companies behind stays open so the next pass picks them up.
    if (sw.complete) doneStages.add('sweep')
    noteCursor()
  }

  // (d) Company-first, by INTENT: every Target, then Watching, then a rotating
  //     least-recently-checked sample of Explore. The watchlist is an input to
  //     the run, never its ceiling — hence both the explore cap inside
  //     selectCompaniesToCheck and the wall-clock floor kept for job-first.
  //
  //     In BROAD and EXHAUSTIVE this lane is deliberately SECONDARY: Targets
  //     are still checked first and Watching regularly, but `exploreShare`
  //     falls to 15 % / 10 % (from 40 %), so the scout's own accumulated
  //     guesses take a small slice of a wide run and the rest of the clock
  //     goes to the market. `lanes.broad_market_share` reports whether that
  //     actually happened.
  const cfTimeShare = runBudget.companyFirstTimeShare ?? COMPANY_FIRST_TIME_SHARE
  const cfReserveMs = Math.max(0, budget.deadlineMs - Math.floor(budget.deadlineMs * cfTimeShare))
  stats.job_first_reserve_ms = cfReserveMs
  if (doneStages.has('company-first')) progress('company-first', 'resuming: every company on the list was checked on an earlier pass')
  else if (!pastDeadline('company-first')) {
    const cf = await runCompanyFirstStage(stageRun, {
      watchlist,
      budget: runBudget.maxCompanyFirst,
      reserveMs: cfReserveMs,
      stageDeadline: Math.min(deadline, started + budget.deadlineMs - cfReserveMs),
      exploreShare: runBudget.exploreShare,
      skip: checkedCompanies,
      onChecked: (id) => checkedCompanies.add(id),
    })
    stats.companies_selected = { ...cf.selection.counts, skipped: cf.selection.skipped }
    if (cf.complete) doneStages.add('company-first')
    noteCursor()
    if (!cf.ok) return finish(run, 'failed', 'migration 014_career_os.sql has not been applied', true)
  }

  // (e) Job-first: one scout session per strategy, budgets shared, persisted
  //     after each one.
  //
  // A failed planner must not take job-first discovery down with it. The eval
  // saw exactly that: one schema-invalid plan, and a $4.71 run found nothing.
  // Without a plan the strategies are built deterministically from the mission —
  // fewer and blunter than a planned set, and labelled as such in the errors.
  //
  // This is also where a run STOPS BEING A COUNTER. A strategy no longer aims
  // at twelve postings; it aims at the mode's number, and the loop ends when
  // the strategies are exhausted, the deadline arrives, the spend ceiling is
  // reached, or marginal unique yield collapses (`saturated`). Whichever it
  // was is recorded, and everything not executed stays in the cursor.
  const strategySource: SearchStrategy[] = resumedStrategies ?? (plan ? plan.strategies : fallbackStrategies(mission))
  if (!plan && !resumedStrategies && strategySource.length) errors.push(`job-first ran on ${strategySource.length} deterministic fallback strategies (planner failed)`)
  if (doneStages.has('job-first')) progress('job-first', 'resuming: every strategy was executed on an earlier pass')
  else if (strategySource.length && !pastDeadline('job-first')) {
    const jf = await runJobFirstStage(stageRun, {
      missionText,
      strategies: strategySource,
      maxStrategies: runBudget.maxStrategies,
      maxRounds: runBudget.maxRoundsPerStrategy,
      maxAtsLookups: budget.maxAtsLookups,
      maxPageFetches: budget.maxPageFetches,
      fetchBudget,
      known: new Set([...watchlist, ...ignoredCompanies].map((w) => normalizeCompanyName(w.name) ?? w.name.toLowerCase())),
      persistedJobs,
      session: deps.session,
      lookupBoard: deps.lookupBoard,
      fetchPage: deps.fetchPage,
      targetCount: runBudget.maxPostingsPerStrategy,
      // Saturation stopping is a MODE's behaviour. A legacy caller keeps
      // executing exactly the strategies it asked for.
      saturation: params.mode ? runBudget.saturation : undefined,
      maxScoutCompanyChecks: runBudget.maxScoutCompanyChecks,
      skipStrategies: doneStrategies,
      onStrategyDone: (name) => {
        doneStrategies.add(name)
        noteCursor()
      },
      canStart: ({ strategy }) => {
        const c = ledger.canSpend(STAGE_COST_ESTIMATE_USD.strategy, { stage: `strategy "${strategy}"` })
        if (!c.ok) budgetStopped = c.reason
        return { ok: c.ok, reason: c.reason }
      },
    })
    stageYields = jf.yields
    if (jf.stopReason && !budgetStopped) saturationStopped = jf.stopReason
    if (jf.complete) doneStages.add('job-first')
    syncSpend('job-first')
    noteCursor()
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
  //      The spend ceiling reaches it through `extractBudget.left`, which the
  //      flush above already clamped to what is affordable.
  const deferred = Math.min(params.deferredExtract ?? 0, Math.max(0, extractBudget.left), ledger.affordable(STAGE_COST_ESTIMATE_USD.extract))
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
    syncSpend('deferred extraction')
    if (ep.migrationMissing) return finish(run, 'failed', 'migration 014_career_os.sql has not been applied', true)
    progress('extract', `deferred: ${ep.extracted} of ${ep.candidates} pending rows extracted ($${ep.costUsd.toFixed(4)})`)
  }

  // (g) Rank what was just stored, so the list the user gets back has fit
  //     numbers on it.
  //
  //     Both halves live in ./rank-stage.ts: which distinct STORED ROWS this
  //     run touched, and how many of them may be judged. HOW MANY is the
  //     mode's `maxFullFit`, capped by what the ceiling can still buy —
  //     twelve was the audit's second binding limit, and a run could discover
  //     four hundred postings and still judge twelve of them.
  const collected = collectRunJobs({ persistedJobs, idByJob, sweepJobs })
  const resultJobs = collected.resultJobs
  if (params.rank !== false) {
    const affordable = ledger.affordable(STAGE_COST_ESTIMATE_USD.rank)
    const ranked = await runRankStage({
      userId: params.userId,
      mission,
      jobs: collected,
      maxFullFit: runBudget.maxFullFit,
      affordable,
      refusalReason: affordable === 0 ? ledger.canSpend(STAGE_COST_ESTIMATE_USD.rank, { stage: 'ranking' }).reason : null,
      windowMs: deadline - Date.now() - RANK_DEADLINE_RESERVE_MS,
      directionOverridden: params.directionOverride !== undefined,
      rank: deps.rank ?? runIntelligenceBatch,
      progress,
    })
    stats.jobs_ranked = ranked.ranked
    stats.rank_cost_usd = ranked.costUsd
    errors.push(...ranked.errors)
    // Discovery is allowed to eat the whole ceiling — but then the run must
    // SAY that ranking did not happen, rather than returning an unranked list
    // that looks like a ranked one.
    if (ranked.budgetStopped) budgetStopped = budgetStopped ?? ranked.budgetStopped
    if (!ranked.skipped) doneStages.add('rank')
  }

  // Every stage is behind us. Whether the run is FINISHED is `report`'s call —
  // a run that stopped because the market saturated is finished too, and only
  // a finished run's cursor says 'done', which is what stops a follow-up
  // invocation from re-running work there is no point repeating.
  return finish(run, 'succeeded', null, false, resultJobs)

  async function finish(r: CareerRun, status: 'succeeded' | 'failed', error: string | null, migrationMissing: boolean, out: JobScoutResultJob[] = []): Promise<JobScoutRunResult> {
    // The deadline belongs to this run only; a later call in the same process
    // (a package build, an eval) must not inherit an expired one.
    setAnthropicDeadline(null)
    if (error) errors.push(error)
    // The ranking batch runs under its own run row; its cost is added here so the scout's number is what the whole call cost.
    stats.cost_usd = Number((r.costUsd() + stats.rank_cost_usd).toFixed(4))
    stats.latency_ms = Date.now() - started
    syncSpend('final')
    const rep = report(status === 'succeeded' && !stats.deadline_hit && !budgetStopped && !saturationStopped)
    // The report's own lines belong in the run's stats: this is what "why did
    // the run stop, and what did each lane and each stage cost?" is answered
    // from, in the UI and in the CLI, without re-deriving anything.
    const statsOut = { ...stats, discovery: { mode: rep.budget.mode, stopped: rep.stopped, lanes: rep.lanes, spend: rep.spend, cost: rep.cost, notes: rep.notes, cursor: rep.cursor } }
    progress('done', `${out.length} jobs · ${stats.jobs_inserted} new`)
    await r.finish(status, statsOut, error)
    noteCursor()
    return {
      runId: r.runId,
      mission: { id: mission.id, name: mission.name },
      plan: plan ? { role_families: plan.role_families.map((f) => f.name), strategies: plan.strategies.map((s) => ({ name: s.name, kind: s.kind, priority: s.priority })), seed_companies_count: plan.seed_companies.length, adjacent_categories: plan.adjacent_categories } : null,
      stats, jobs: out, rejected, errors, costUsd: stats.cost_usd, latencyMs: stats.latency_ms, migrationMissing,
      // A run that ran out of clock or of money still succeeded at what it
      // managed; the caller records it as `partial` so nobody reads it as a
      // full sweep, and its cursor says where to continue from. A SATURATED
      // run is not partial — there was nothing left worth finding, which is
      // the intended good ending of a wide run (isRunFinished).
      partial: !isRunFinished(rep.stopped) && status === 'succeeded',
      ...rep,
    }
  }
}
