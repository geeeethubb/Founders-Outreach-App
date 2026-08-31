// The scout run's contract: what a caller passes in, what it gets back, and
// the live counts it is told along the way.
//
// Split out of orchestrator.ts so that file is the run itself. Every name here
// is re-exported from './orchestrator', so existing import paths keep working.
//
// Types only — no behaviour, no I/O.

import type { JobMissionPlan, JobMissionPlannerInput } from '@/lib/agents/job-mission-planner'
import type { JobScoutSessionParams, JobScoutSessionResult } from '@/lib/agents/job-scout/session'
import type { FetchPageFn, LookupBoardFn } from '@/lib/agents/job-scout'
import type { AgentResult, ToolContext } from '@/lib/agents/runtime/types'
import type { BatchResult } from '../intelligence/orchestrator'
import type { VerifierFn } from '../jobs/verify-batch'
import type { CareerBudget } from '../runs'
import type { PageFetcher, SourceRegistry } from '../sources/types'
import type { VerificationStatus } from '../types'
import type { ExtractorFn, RejectedJob } from './extract'
import type { ScoutStats } from './stats'
import type { ScoutStore } from './store'

/** Every collaborator a run uses, so the whole loop runs in memory under test. */
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

/**
 * Live counts, emitted with every progress line. These are what a UI shows
 * instead of a fake timer.
 *
 * Every key is the name that number already has where it is READ — `discovered`
 * and `rejected` in run-copy.ts, `jobs` / `inserted` / `verified_open` /
 * `likely_open` / `closed` / `ranked` in run-view.ts, `companies_checked` and
 * `jobs_extracted` in the run's own stats. One name per number, so the run
 * monitor never has to guess which count it is looking at. They matter most on
 * a pre-016 database, where `scouting_run_jobs` does not exist and these are
 * the only live numbers the endpoint can answer with.
 *
 * The cumulative ones only ever go up. The verdict counts (`verified_open`,
 * `likely_open`, `closed`) are DISTINCT STORED ROWS by their current verdict,
 * not sightings — a posting two stages both found is one row — so a row
 * re-verified in a later batch moves between those keys.
 */
export type ScoutProgressCounts = {
  /** Raw postings gathered, before extraction. */
  discovered: number
  companies_checked: number
  jobs_extracted: number
  /** Distinct rows this run stored. */
  jobs: number
  /** Of those, rows that did not exist before. */
  inserted: number
  verified_open: number
  likely_open: number
  closed: number
  ranked: number
  rejected: number
  // A type alias, not an interface, so it satisfies `Record<string, number>`
  // for callers (the durable worker) that store progress as a plain payload.
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
  /**
   * Replaces mission.preferences.direction IN MEMORY for this run only (the CLI's
   * --direction). Never persisted; the stored mission is not touched. It reaches
   * the planner, evidence retrieval and the fallback strategies; post-scout
   * ranking is SKIPPED (with an error line) because fit rows persist against
   * the stored mission and would otherwise be judged against a direction that
   * was never saved.
   */
  directionOverride?: string | null
  /**
   * `counts` is optional so callers written against the old two-argument shape
   * still compile; what is actually passed is a `ScoutProgressCounts`.
   */
  onProgress?: (stage: string, detail: string, counts?: Record<string, number>) => void
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

/** How the run's company-first budget was spent, by whose choice each company was. */
export interface CompaniesSelected {
  target: number
  watching: number
  suggested: number
  /** Eligible companies this run did not reach — they rotate in next time. */
  skipped: number
}

export interface ScoutRunStats extends ScoutStats {
  companies_selected: CompaniesSelected
  /** Wall-clock ms held back from company-first so job-first discovery always runs. */
  job_first_reserve_ms: number
}

export interface JobScoutResult {
  runId: string | null
  mission: { id: string; name: string } | null
  plan: { role_families: string[]; strategies: { name: string; kind: string; priority: number }[]; seed_companies_count: number; adjacent_categories: string[] } | null
  stats: ScoutRunStats
  jobs: JobScoutResultJob[]
  rejected: RejectedJob[]
  errors: string[]
  costUsd: number
  latencyMs: number
  migrationMissing: boolean
  /**
   * True when the run stopped at its deadline with work left. Everything found
   * is persisted; the caller should record the run as `partial`, not
   * `succeeded`.
   */
  partial: boolean
}
