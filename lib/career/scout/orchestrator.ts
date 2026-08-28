// The Job Scout orchestrator — one run of discovery, end to end.
//
//   mission + evidence → PLAN → seed watchlist → COMPANY-FIRST (code)
//   → JOB-FIRST (scout sessions) → resolve → EXTRACT → cluster → VERIFY → upsert
//
// Everything with judgment is an agent call; everything else is here, as
// code, and every agent call is traced against one scouting_runs row. The
// deadline is checked at every stage boundary and inside every loop: past it
// nothing new starts, but whatever was found is still clustered, verified as
// far as the budget allows, and persisted. A run that hits the wall must not
// throw away the jobs it already paid for.
//
// Every collaborator is injectable (JobScoutDeps) so the whole loop runs in
// memory under test with stub agents and a stub store. Production callers
// pass nothing and get the live modules.

import { runJobMissionPlanner, type JobMissionPlan, type JobMissionPlannerInput, type SearchStrategy } from '@/lib/agents/job-mission-planner'
import { runJobScoutSession, postingKey, type JobScoutSessionParams, type JobScoutSessionResult } from '@/lib/agents/job-scout/session'
import type { CompanyToCheck, FetchPageFn, LookupBoardFn } from '@/lib/agents/job-scout'
import type { AgentResult, ToolContext } from '@/lib/agents/runtime/types'
import { createServiceClient } from '@/lib/supabase/server'
import { loadEvidenceBank } from '../evidence/store'
import { renderExperienceSummaries, renderPreferences, renderSkills } from '../evidence/render'
import { renderFeedbackHints, type FeedbackRow } from '../fit/feedback'
import { clusterJobs } from '../jobs/dedupe'
import { isInternshipLike } from '../jobs/filters'
import { normalizeCompanyName, type NormalizedJob } from '../jobs/normalize'
import { listJobs, listWatchlist, updateJobVerification, upsertJobs, type JobListRow, type ListJobsFilters, type UpsertJobsResult } from '../jobs/store'
import type { VerifyResult } from '../jobs/verify'
import { verifyWithAgent, type VerifierFn } from '../jobs/verify-batch'
import { runIntelligenceBatch, type BatchResult } from '../intelligence/orchestrator'
import { ensureDefaultMission, getMission, renderMission } from '../missions/store'
import { DEFAULT_SCOUT_BUDGET, startCareerRun, type CareerBudget, type CareerRun } from '../runs'
import { setAnthropicDeadline } from '@/lib/providers/anthropic/client'
import { getPageFetcher } from '../sources/fetch'
import { getSourceRegistry } from '../sources/registry'
import type { PageFetcher, RawJobPosting, SourceRegistry } from '../sources/types'
import type { CareerMission, EvidenceBank, VerificationStatus, WatchStatus } from '../types'
import { checkCompanyForOpenings, liveCompanyFirstStore, runCompanyFirst, seedWatchlistFromPlan, type CompanyFirstStore, type WatchedCompany } from './company-first'
import { extractAndNormalize, type ExtractorFn, type RejectedJob } from './extract'
import { resolveScoutedPosting, type FetchBudget } from './resolve'
import { bump, emptyStats, noteQuery, type ScoutStats } from './stats'
import { createScoutTools } from './tools'

const ATS_SOURCES = new Set(['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable'])
const ACTIVE_WATCH: WatchStatus[] = ['target', 'watching', 'opening_available']
const MAX_SCOUT_COMPANY_CHECKS = 10
// Post-scout ranking: how many of this run's jobs get a fit number before the
// run returns, how many at once, and how much of the deadline must be left.
// Research is skipped here (it is the slow stage); the package flow runs it.
const MAX_RANK_JOBS = 12
const RANK_CONCURRENCY = 3
const RANK_DEADLINE_RESERVE_MS = 20_000
const RANK_MIN_WINDOW_MS = 30_000

/**
 * Which of this run's stored jobs get a fit number first. Store order is
 * arrival order — whichever board answered first — and a large run left the
 * mission-targeted rows past the cap. Deterministic preference, most
 * promising first: extracted this run (a thin heuristic row is a weaker
 * candidate for the evaluator), then confirmed open, then the target season,
 * then the closest tier (unknown last), then an internship-shaped title.
 * Ties keep store order, so the choice is stable across runs.
 */
export function rankCandidatePriority(job: NormalizedJob): number {
  const tier = job.location_tier ?? 4
  return (
    (job.extraction_version ? 10_000 : 0) +
    (job.verification_status === 'VERIFIED_OPEN' ? 1_000 : 0) +
    (job.season_relevance === 'summer_2027' ? 100 : 0) +
    (4 - tier) * 10 +
    (isInternshipLike(job) ? 1 : 0)
  )
}

/** The ids to rank, best first. Falls back to store order when ids and jobs do not line up (a partial upsert). */
export function selectJobsToRank(jobs: NormalizedJob[], ids: string[], max: number): string[] {
  if (ids.length !== jobs.length) return ids.slice(0, max)
  return jobs
    .map((job, i) => ({ id: ids[i], i, priority: rankCandidatePriority(job) }))
    .sort((a, b) => b.priority - a.priority || a.i - b.i)
    .slice(0, max)
    .map((x) => x.id)
}

// ─── Store + deps ────────────────────────────────────────────────────────────

export interface ScoutStore extends CompanyFirstStore {
  getMission(userId: string, missionId: string | null): Promise<{ mission: CareerMission | null; error: string | null; migrationMissing: boolean }>
  loadBank(userId: string): Promise<{ bank: EvidenceBank; migrationMissing: boolean; errors: string[] }>
  recentFeedback(userId: string, limit: number): Promise<FeedbackRow[]>
  startRun(params: Parameters<typeof startCareerRun>[0]): Promise<CareerRun>
  listWatchlist(userId: string): Promise<{ companies: Record<string, unknown>[]; error: string | null; migrationMissing: boolean }>
  listJobs(userId: string, filters: ListJobsFilters): Promise<{ jobs: JobListRow[]; error: string | null; migrationMissing: boolean }>
  upsertJobs(userId: string, jobs: NormalizedJob[], opts: { runId?: string | null; missionId?: string | null }): Promise<UpsertJobsResult>
  /**
   * Optional: upsertJobs deliberately leaves verification columns alone on a
   * re-seen row (that is the verifier's job), so a job listed on its ATS board
   * THIS run is refreshed to VERIFIED_OPEN here — otherwise a row that went
   * STALE would stay STALE while the board still shows it.
   */
  updateJobVerification?(userId: string, id: string, result: VerifyResult, now?: Date): Promise<{ error: string | null }>
}

export function liveScoutStore(): ScoutStore {
  return {
    ...liveCompanyFirstStore(),
    async getMission(userId, missionId) {
      if (missionId) {
        const m = await getMission(userId, missionId)
        return { mission: m, error: m ? null : 'mission not found', migrationMissing: false }
      }
      const r = await ensureDefaultMission(userId)
      return { mission: r.mission, error: r.error, migrationMissing: !!r.error && /014_career_os/.test(r.error) }
    },
    loadBank: (userId) => loadEvidenceBank(userId, { approvedOnly: true }),
    async recentFeedback(userId, limit) {
      const db = createServiceClient()
      const { data } = await db
        .from('job_feedback')
        .select('job_id, verdict, reasons, note, created_at, job:job_opportunities(role_family, industry, company_name, location_tier)')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit)
      type Row = { job_id: string; verdict: FeedbackRow['verdict']; reasons: string[]; note: string | null; created_at: string; job: { role_family: string | null; industry: string | null; company_name: string | null; location_tier: number | null } | null }
      return ((data ?? []) as unknown as Row[]).map((r) => ({
        job_id: r.job_id, verdict: r.verdict, reasons: r.reasons ?? [], note: r.note, created_at: r.created_at,
        role_family: r.job?.role_family ?? null, industry: r.job?.industry ?? null, company_name: r.job?.company_name ?? null, location_tier: r.job?.location_tier ?? null,
      }))
    },
    startRun: startCareerRun,
    listWatchlist,
    listJobs: (userId, filters) => listJobs(userId, filters),
    upsertJobs,
    updateJobVerification,
  }
}

export interface JobScoutDeps {
  planner?: (input: JobMissionPlannerInput, ctx: ToolContext) => Promise<AgentResult<JobMissionPlan>>
  session?: (params: JobScoutSessionParams, ctx: ToolContext) => Promise<JobScoutSessionResult>
  extractor?: ExtractorFn
  verifier?: VerifierFn
  lookupBoard?: LookupBoardFn
  fetchPage?: FetchPageFn
  registry?: SourceRegistry
  fetcher?: PageFetcher
  store?: ScoutStore
  /** Post-scout ranking. Defaults to the live intelligence batch; the offline test injects a stub. */
  rank?: (userId: string, jobIds: string[], opts: { concurrency: number; deadlineMs: number; skip: { research: true }; label: string }) => Promise<BatchResult>
}

export interface JobScoutParams {
  userId: string
  missionId?: string | null
  budget?: Partial<CareerBudget>
  maxStrategies?: number
  maxRoundsPerStrategy?: number
  maxCompaniesFirst?: number
  maxExtract?: number
  concurrency?: number
  verify?: boolean
  /** False turns off post-scout ranking (the eval measures ranking separately). Default on. */
  rank?: boolean
  onProgress?: (stage: string, detail: string) => void
  label?: string
}

export interface JobScoutResultJob {
  id?: string
  title: string
  company_name: string
  location_raw: string | null
  location_tier: number | null
  season_relevance: string
  employment_type: string
  verification_status: VerificationStatus
  canonical_url: string | null
  source_types: string[]
}

export interface JobScoutResult {
  runId: string | null
  mission: { id: string; name: string } | null
  plan: { role_families: string[]; strategies: { name: string; kind: string; priority: number }[]; seed_companies_count: number; adjacent_categories: string[] } | null
  stats: ScoutStats
  jobs: JobScoutResultJob[]
  rejected: RejectedJob[]
  errors: string[]
  costUsd: number
  latencyMs: number
  migrationMissing: boolean
}

export function scoutToolContext(userId: string, runId: string | null, budget: CareerBudget): ToolContext {
  return { user_id: userId, run_id: runId, budget: { maxCompanies: 0, maxPeoplePerCompany: 0, maxApolloCalls: 0, maxWebSearches: budget.maxWebSearches, maxAgentSteps: budget.maxAgentSteps } }
}

/**
 * Strategies built from the mission alone, used only when the planner fails.
 * Two surfaces: the keyless ATS boards (where a first-party posting is one hop
 * away) and the mission's own company types. No role inference — that is the
 * planner's judgment, and this is the deterministic floor beneath it.
 */
export function fallbackStrategies(mission: Pick<CareerMission, 'preferences' | 'season'>): SearchStrategy[] {
  const season = mission.season === 'summer_2027' ? 'Summer 2027' : mission.season.replace(/_/g, ' ')
  const tier1 = mission.preferences.geo_tiers.find((t) => t.tier === 1)?.locations ?? []
  const geo = tier1.length ? tier1 : ['United States']
  const types = mission.preferences.company_types.slice(0, 3)
  const boards: SearchStrategy = {
    name: 'fallback · public ATS boards',
    kind: 'job_first',
    rationale: 'deterministic fallback — the mission planner failed',
    queries: [
      `"${season}" internship site:job-boards.greenhouse.io`,
      `"${season}" intern site:jobs.lever.co`,
      `"${season}" internship site:jobs.ashbyhq.com`,
      `"${season}" engineering intern ${geo[0]}`,
    ],
    target_titles: ['Process Engineering Intern', 'Manufacturing Engineering Intern', 'Engineering Intern', 'Strategy Intern'],
    geo_focus: geo,
    priority: 0.5,
  }
  const byType: SearchStrategy = {
    name: 'fallback · mission company types',
    kind: 'job_first',
    rationale: 'deterministic fallback — the mission planner failed',
    queries: types.length
      ? types.map((t) => `${t} "${season}" internship ${geo[0]}`)
      : [`"${season}" internship ${geo[0]}`, `"${season}" intern ${geo[geo.length - 1]}`],
    target_titles: ['Intern'],
    geo_focus: geo,
    priority: 0.4,
  }
  return [boards, byType]
}

function toWatched(row: Record<string, unknown>): WatchedCompany {
  return {
    id: String(row.id), name: String(row.name), domain: (row.domain as string | null) ?? null, careers_url: (row.careers_url as string | null) ?? null,
    ats_type: (row.ats_type as string | null) ?? null, ats_identifier: (row.ats_identifier as string | null) ?? null,
    watch_status: (row.watch_status as WatchStatus | null) ?? null, watch_priority: (row.watch_priority as number | null) ?? null,
  }
}

// ─── The run ─────────────────────────────────────────────────────────────────

export async function runJobScout(params: JobScoutParams, deps: JobScoutDeps = {}): Promise<JobScoutResult> {
  const started = Date.now()
  const store = deps.store ?? liveScoutStore()
  const registry = deps.registry ?? getSourceRegistry()
  const fetcher = deps.fetcher ?? getPageFetcher()
  const budget: CareerBudget = { ...DEFAULT_SCOUT_BUDGET, ...(params.budget ?? {}) }
  const deadline = started + budget.deadlineMs
  // The API client stops retrying past this point too (see setAnthropicDeadline):
  // a run that has already given up must not sit inside a retry storm.
  setAnthropicDeadline(deadline)
  const stats = emptyStats()
  const errors: string[] = []
  let rejected: RejectedJob[] = []
  const progress = (stage: string, detail: string) => params.onProgress?.(stage, detail)
  const pastDeadline = (stage: string): boolean => {
    if (Date.now() <= deadline) return false
    if (!stats.deadline_hit) errors.push(`deadline reached before ${stage}`)
    stats.deadline_hit = true
    return true
  }
  const fail = (message: string, migrationMissing = false): JobScoutResult => ({
    runId: null, mission: null, plan: null, stats, jobs: [], rejected: [], errors: [...errors, message], costUsd: 0, latencyMs: Date.now() - started, migrationMissing,
  })

  // (a) Inputs.
  const m = await store.getMission(params.userId, params.missionId ?? null)
  if (m.migrationMissing) return fail('migration 014_career_os.sql has not been applied', true)
  if (!m.mission) return fail(m.error ?? 'no mission')
  const mission = m.mission
  const missionText = renderMission(mission)
  const bankRes = await store.loadBank(params.userId)
  if (bankRes.migrationMissing) return fail('migration 014_career_os.sql has not been applied', true)
  errors.push(...bankRes.errors)
  const watch = await store.listWatchlist(params.userId)
  if (watch.migrationMissing) return fail('migration 014_career_os.sql has not been applied', true)
  if (watch.error) errors.push(`watchlist: ${watch.error}`)
  const watchlist = watch.companies.map(toWatched)
  const feedback = await store.recentFeedback(params.userId, 30)

  // (b) The run row. Agent traces attach to it from here on.
  const run = await store.startRun({ userId: params.userId, kind: 'job_scout', label: params.label ?? `job scout · ${mission.name}`, mission: { name: mission.name, objective: mission.objective }, budget, careerMissionId: mission.id })
  const ctx = scoutToolContext(params.userId, run.runId, budget)
  const traced = async <T>(res: AgentResult<T>, refs: Record<string, unknown>) => {
    stats.model_calls++
    stats.web_searches += res.trace.web_searches
    await run.trace(res as AgentResult<unknown>, refs)
  }

  // (c) Plan.
  progress('plan', 'asking the mission planner')
  const planner = deps.planner ?? runJobMissionPlanner
  const planRes = await planner(
    { mission: missionText, evidenceSummaries: renderExperienceSummaries(bankRes.bank), skills: renderSkills(bankRes.bank), preferences: renderPreferences(bankRes.bank), watchlist: watchlist.map((w) => w.name), recentFeedback: renderFeedbackHints(feedback) },
    ctx
  )
  await traced(planRes, { mission_id: mission.id })
  const plan = planRes.output
  if (!plan) errors.push(`planner ${planRes.status}: ${planRes.error ?? 'no plan'} — company-first only`)
  else {
    for (const s of plan.strategies) for (const q of s.queries) noteQuery(stats, q)
    const seeded = await seedWatchlistFromPlan(params.userId, plan.seed_companies, watchlist.map((w) => w.name), { store })
    if (seeded.migrationMissing) return finish(run, 'failed', 'migration 014_career_os.sql has not been applied', true)
    errors.push(...seeded.errors)
    progress('plan', `${plan.strategies.length} strategies, ${plan.seed_companies.length} seeds (${seeded.added} new on the watchlist)`)
    if (seeded.added) {
      const again = await store.listWatchlist(params.userId)
      if (!again.error) watchlist.splice(0, watchlist.length, ...again.companies.map(toWatched))
    }
  }

  // (d) Company-first over the watchlist.
  const raws: RawJobPosting[] = []
  const atsListedUrls = new Set<string>()
  const rawByUrl = new Map<string, RawJobPosting>()
  const keepRaw = (p: RawJobPosting) => {
    raws.push(p)
    if (p.source_type && ATS_SOURCES.has(p.source_type)) atsListedUrls.add(p.canonical_url ?? p.source_url)
    bump(stats.sources_consulted, p.source_type)
  }
  const cfStore: CompanyFirstStore = store
  if (!pastDeadline('company-first')) {
    const targets = watchlist
      .filter((w) => w.watch_status && ACTIVE_WATCH.includes(w.watch_status))
      .sort((a, b) => (b.watch_priority ?? 0) - (a.watch_priority ?? 0))
    const cf = await runCompanyFirst(params.userId, targets, { concurrency: params.concurrency ?? 4, deadline, maxCompanies: params.maxCompaniesFirst ?? 25, onProgress: (d) => progress('company-first', d) }, { registry, fetcher, store: cfStore })
    stats.companies_checked += cf.checked
    stats.companies_with_openings += cf.withOpenings
    stats.postings_seen += cf.postings.length
    stats.postings_resolved += cf.postings.length
    for (const p of cf.postings) keepRaw(p)
    for (const c of cf.outcomes) noteQuery(stats, `lookup: ${c.name}`)
    errors.push(...cf.errors)
    if (cf.deadlineHit) pastDeadline('company-first (remaining companies)')
  }

  // (e) Job-first: one scout session per strategy, budgets shared.
  const fetchBudget: FetchBudget = { left: budget.maxPageFetches }
  const companiesToCheck: CompanyToCheck[] = []
  // A failed planner must not take job-first discovery down with it. The eval
  // saw exactly that: one schema-invalid plan, and a $4.71 run found nothing.
  // Without a plan the strategies are built deterministically from the mission —
  // fewer and blunter than a planned set, and labelled as such in the errors.
  const strategySource: SearchStrategy[] = plan ? plan.strategies : fallbackStrategies(mission)
  if (!plan && strategySource.length) errors.push(`job-first ran on ${strategySource.length} deterministic fallback strategies (planner failed)`)
  if (strategySource.length && !pastDeadline('job-first')) {
    const maxStrategies = params.maxStrategies ?? 3
    const strategies: SearchStrategy[] = [...strategySource].sort((a, b) => b.priority - a.priority).slice(0, maxStrategies)
    const existing = await store.listJobs(params.userId, { canonicalOnly: false, limit: 500, sort: 'recent' })
    if (existing.migrationMissing) return finish(run, 'failed', 'migration 014_career_os.sql has not been applied', true)
    const alreadyFound = new Set<string>()
    for (const j of existing.jobs) {
      if (j.canonical_url) alreadyFound.add(j.canonical_url)
      alreadyFound.add(postingKey(j))
    }
    for (const p of raws) alreadyFound.add(p.canonical_url ?? p.source_url)

    const tools = { lookupBoard: deps.lookupBoard, fetchPage: deps.fetchPage }
    const live = createScoutTools({ registry, fetcher, stats, rawByUrl })
    const perSessionLookups = Math.max(2, Math.floor(budget.maxAtsLookups / Math.max(1, strategies.length)))
    const perSessionFetches = Math.max(2, Math.floor(budget.maxPageFetches / 2 / Math.max(1, strategies.length)))
    const session = deps.session ?? runJobScoutSession

    for (const strategy of strategies) {
      if (pastDeadline(`strategy "${strategy.name}"`)) break
      progress('job-first', `strategy: ${strategy.name}`)
      let res: JobScoutSessionResult
      try {
        res = await session(
          {
            strategy, mission: missionText, alreadyFound: [...alreadyFound], maxRounds: params.maxRoundsPerStrategy ?? 2, targetCount: 12, deadline,
            tools: { lookupBoard: tools.lookupBoard ?? live.lookupBoard, fetchPage: tools.fetchPage ?? live.fetchPage, maxLookups: perSessionLookups, maxFetches: perSessionFetches },
            onRound: (h) => { noteQuery(stats, h.query_used); progress('job-first', `${strategy.name} r${h.round}: ${h.postings_kept} kept · ${h.diagnosis} → ${h.action}`) },
          },
          ctx
        )
      } catch (e) {
        errors.push(`strategy "${strategy.name}": ${e instanceof Error ? e.message : String(e)}`)
        continue
      }
      for (const r of res.agentResults) await traced(r, { strategy: strategy.name })
      for (const h of res.history) noteQuery(stats, h.query_used)
      errors.push(...res.errors)
      fetchBudget.left -= res.toolLog.filter((e) => e.tool === 'fetch_page').length
      for (const p of res.postings) {
        if (pastDeadline('resolving postings')) break
        const resolved = await resolveScoutedPosting(p, { registry, fetcher, stats, fetchBudget, companiesToCheck, rawByUrl })
        if (resolved.posting) {
          keepRaw(resolved.posting)
          alreadyFound.add(resolved.posting.canonical_url ?? resolved.posting.source_url)
          alreadyFound.add(postingKey(p))
        } else if (resolved.outcome === 'failed') errors.push(`resolve ${p.url}: ${resolved.note}`)
      }
      companiesToCheck.push(...res.companiesToCheck)
    }

    // Companies the scout flagged: watch them and check them, a bounded number per run.
    const known = new Set(watchlist.map((w) => normalizeCompanyName(w.name) ?? w.name.toLowerCase()))
    let checks = 0
    for (const c of companiesToCheck) {
      const key = normalizeCompanyName(c.name) ?? c.name.toLowerCase()
      if (known.has(key) || checks >= MAX_SCOUT_COMPANY_CHECKS || pastDeadline('scout company checks')) continue
      known.add(key)
      const w = await store.upsertWatch(params.userId, { name: c.name, domain: c.domain, watch_status: 'target', watch_source: 'scout', watch_note: c.why.slice(0, 300) })
      if (!w.id) { if (w.error) errors.push(`watch ${c.name}: ${w.error}`); continue }
      checks++
      const r = await checkCompanyForOpenings(params.userId, { id: w.id, name: c.name, domain: c.domain, careers_url: null, ats_type: null, ats_identifier: null }, {}, { registry, fetcher, store: cfStore })
      stats.companies_checked++
      if (r.postings.length) stats.companies_with_openings++
      stats.postings_seen += r.postings.length
      stats.postings_resolved += r.postings.length
      for (const p of r.postings) keepRaw(p)
      progress('company-first', `${c.name} (from scout): ${r.postings.length} openings`)
    }
  }

  // (f) Extract + normalize + hard constraints.
  progress('extract', `${raws.length} raw postings`)
  const ex = await extractAndNormalize(raws, { mission, ctx, run, maxExtract: params.maxExtract ?? 40, concurrency: params.concurrency ?? 4, deadline, stats, extractor: deps.extractor, onProgress: (d) => progress('extract', d) })
  rejected = ex.rejected
  errors.push(...ex.errors)
  if (ex.deadlineHit) pastDeadline('extraction (remaining postings)')

  // (g) Cluster.
  const clustered = clusterJobs(ex.jobs)
  stats.clusters = clustered.clusters.length
  stats.duplicates_removed = ex.jobs.length - clustered.merged.length
  const jobs = clustered.merged

  // (h) Verify. ATS-listed this run ⇒ open by construction; the rest go through the page.
  const now = new Date().toISOString()
  const listedThisRun = new Set<NormalizedJob>()
  for (const job of jobs) {
    const listed = job.sources.some((s) => ATS_SOURCES.has(s.source_type) && atsListedUrls.has(s.canonical_url ?? s.source_url))
    if (listed) {
      listedThisRun.add(job)
      job.verification_status = 'VERIFIED_OPEN'
      job.last_verified_at = now
      job.verification_method = 'ats_listing'
      job.verification_note = 'listed on the company ATS board this run'
    } else if (params.verify !== false && !job.canonical_url) {
      job.verification_note = 'aggregator lead without a first-party URL'
    } else if (params.verify !== false && fetchBudget.left > 0 && !pastDeadline('verification')) {
      fetchBudget.left--
      const v = await verifyWithAgent(job, { registry, fetcher, ctx, verifier: deps.verifier, run, onModelCall: () => stats.model_calls++ })
      job.verification_status = v.status === 'AMBIGUOUS' ? 'UNVERIFIED' : v.status
      job.last_verified_at = now
      job.verification_method = v.method
      job.verification_note = v.note
    }
    stats.verification[job.verification_status]++
  }

  // (i) Persist, stamping domains the watchlist already knows.
  const domainByName = new Map(watchlist.filter((w) => w.domain).map((w) => [normalizeCompanyName(w.name) ?? w.name.toLowerCase(), w.domain as string]))
  for (const job of jobs) {
    if (!job.company_domain) {
      const d = domainByName.get(normalizeCompanyName(job.company_name) ?? job.company_name.toLowerCase())
      if (d) { job.company_domain = d; job.company_key = `d:${d}` }
    }
  }
  const up = await store.upsertJobs(params.userId, jobs, { runId: run.runId, missionId: mission.id })
  if (up.migrationMissing) return finish(run, 'failed', 'migration 014_career_os.sql has not been applied', true)
  errors.push(...up.errors)
  stats.jobs_inserted = up.inserted
  stats.jobs_updated = up.updated
  const idFor = (i: number) => (up.ids.length === jobs.length ? up.ids[i] : undefined)

  // upsertJobs never touches verification on a re-seen row; a board listing
  // this run is the strongest open signal we have, so refresh those rows.
  // Only when some rows were updated (inserts already carry the status) and
  // only when ids line up one-to-one with jobs (a partial failure loses that).
  if (up.updated > 0 && up.ids.length === jobs.length && store.updateJobVerification) {
    // verification_method is free text in the schema; 'ats_listing' is what the insert path writes.
    const refresh: VerifyResult = { status: 'VERIFIED_OPEN', note: 'listed on the company ATS board this run', method: 'ats_listing' as unknown as VerifyResult['method'], closedSignals: [] }
    for (let i = 0; i < jobs.length; i++) {
      if (!listedThisRun.has(jobs[i])) continue
      const r = await store.updateJobVerification(params.userId, up.ids[i], refresh)
      if (r.error) errors.push(`refresh ${jobs[i].title}: ${r.error}`)
    }
  }

  // (j) Rank what was just stored, so the list the user gets back has fit
  // numbers on it. Stored evaluations at the current prompt version are reused
  // inside the batch, so only jobs without one cost anything. Bounded by count,
  // by concurrency and by what is left of the deadline; a batch that cannot
  // start is reported, never silently skipped.
  if (up.ids.length > 0 && params.rank !== false) {
    const window = deadline - Date.now() - RANK_DEADLINE_RESERVE_MS
    if (window < RANK_MIN_WINDOW_MS) {
      errors.push(`ranking skipped: ${Math.max(0, Math.round(window / 1000))}s left of the deadline`)
    } else {
      progress('rank', `${Math.min(MAX_RANK_JOBS, up.ids.length)} jobs`)
      const rank = deps.rank ?? runIntelligenceBatch
      try {
        const r = await rank(params.userId, selectJobsToRank(jobs, up.ids, MAX_RANK_JOBS), { concurrency: RANK_CONCURRENCY, deadlineMs: window, skip: { research: true }, label: `post-scout ranking · ${mission.name}` })
        stats.jobs_ranked = Object.values(r.results).filter((x) => x.fit !== null).length
        stats.rank_cost_usd = Number(r.costUsd.toFixed(4))
        if (r.skipped.length) errors.push(`ranking: ${r.skipped.length} job(s) not started before the deadline`)
        errors.push(...r.errors)
      } catch (e) {
        errors.push(`ranking: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  return finish(run, 'succeeded', null, false, jobs.map((j, i) => ({
    id: idFor(i), title: j.title, company_name: j.company_name, location_raw: j.location_raw, location_tier: j.location_tier, season_relevance: j.season_relevance,
    employment_type: j.employment_type, verification_status: j.verification_status, canonical_url: j.canonical_url, source_types: [...new Set(j.sources.map((s) => s.source_type))],
  })))

  async function finish(r: CareerRun, status: 'succeeded' | 'failed', error: string | null, migrationMissing: boolean, out: JobScoutResultJob[] = []): Promise<JobScoutResult> {
    // The deadline belongs to this run only; a later call in the same process
    // (a package build, an eval) must not inherit an expired one.
    setAnthropicDeadline(null)
    if (error) errors.push(error)
    // The ranking batch runs under its own run row; its cost is added here so the scout's number is what the whole call cost.
    stats.cost_usd = Number((r.costUsd() + stats.rank_cost_usd).toFixed(4))
    stats.latency_ms = Date.now() - started
    await r.finish(status, { ...stats }, error)
    return {
      runId: r.runId,
      mission: { id: mission.id, name: mission.name },
      plan: plan ? { role_families: plan.role_families.map((f) => f.name), strategies: plan.strategies.map((s) => ({ name: s.name, kind: s.kind, priority: s.priority })), seed_companies_count: plan.seed_companies.length, adjacent_categories: plan.adjacent_categories } : null,
      stats, jobs: out, rejected, errors, costUsd: stats.cost_usd, latencyMs: stats.latency_ms, migrationMissing,
    }
  }
}
