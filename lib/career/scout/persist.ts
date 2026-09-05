// One checkpointed batch of a scout run: extract → cluster → verify → persist.
//
// A run used to do this ONCE, at the very end. Everything the run had paid
// for — page fetches, extractor calls, verification — lived in memory until
// the last line, so a run that hit its deadline, threw, or was killed by a
// serverless timeout stored nothing. This module is that tail, callable after
// company-first and after every job-first strategy, so what a run has found is
// already in the database before the next stage starts.
//
// Dedupe stays correct across batches: clustering runs WITHIN the batch, and
// `upsertJobs` matches an incoming job against what is already stored (ATS id,
// canonical URL, then company + title + location), so the same posting seen by
// two strategies updates one row rather than inserting a second.
//
// Pure orchestration over injected collaborators — no database access of its
// own, nothing here judges anything.

import type { ToolContext } from '@/lib/agents/runtime/types'
import { clusterJobs } from '../jobs/dedupe'
import type { NormalizedJob } from '../jobs/normalize'
import type { UpsertJobsResult } from '../jobs/store'
import type { VerifyResult } from '../jobs/verify'
import { verifyWithAgent, type VerifierFn } from '../jobs/verify-batch'
import type { CareerRun } from '../runs'
import { getSourceRegistry } from '../sources/registry'
import type { PageFetcher, RawJobPosting, SourceRegistry } from '../sources/types'
import type { CareerMission } from '../types'
import { extractAndNormalize, type ExtractorFn, type RejectedJob } from './extract'
import type { FetchBudget } from './resolve'
import type { ScoutStats } from './stats'

/**
 * The source types whose LISTING this run is itself proof of an open role.
 *
 * Derived from the registry rather than written out. It was a literal, and the
 * literal drifted the moment a sixth adapter landed: every posting Workday
 * listed was stored UNVERIFIED — "we could not confirm it" — while the board
 * had just handed it to us. An adapter that can list a board is by definition
 * one whose listing is proof, so ask the registry rather than remember.
 *
 * Computed once per process, because the adapter set does not change inside one.
 */
let atsSourceTypes: Set<string> | null = null
export function atsListingSources(): Set<string> {
  if (!atsSourceTypes) atsSourceTypes = new Set(getSourceRegistry().adapters().map((a) => a.source_type as string))
  return atsSourceTypes
}

/** True when a posting arrived from an adapter that had just listed it on a board. */
export function isAtsListingSource(sourceType: string): boolean {
  return atsListingSources().has(sourceType)
}

/** The persistence a batch needs. `ScoutStore` satisfies it structurally. */
export interface BatchStore {
  upsertJobs(userId: string, jobs: NormalizedJob[], opts: { runId?: string | null; missionId?: string | null }): Promise<UpsertJobsResult>
  updateJobVerification?(userId: string, id: string, result: VerifyResult, now?: Date): Promise<{ error: string | null }>
}

export interface BatchContext {
  userId: string
  mission: CareerMission
  ctx: ToolContext
  run: Pick<CareerRun, 'trace' | 'runId'>
  store: BatchStore
  stats: ScoutStats
  registry: SourceRegistry
  fetcher: PageFetcher
  extractor?: ExtractorFn
  verifier?: VerifierFn
  /** Unix ms. Nothing new starts past it; whatever is in hand still persists. */
  deadline: number
  concurrency: number
  verify: boolean
  fetchBudget: FetchBudget
  /** URLs an ATS board listed THIS run — open by construction. Shared across batches. */
  atsListedUrls: Set<string>
  /** Domain the watchlist already knows for a company name, if any. */
  domainFor: (companyName: string) => string | null
  /** The run's own deadline bookkeeping; returns true when the run is past it. */
  pastDeadline: (stage: string) => boolean
  onProgress?: (detail: string) => void
}

export interface BatchOutcome {
  /** The jobs this batch stored, in the order the store saw them. */
  jobs: NormalizedJob[]
  /** Stored ids, one per job, or `undefined` where the store returned a partial mapping. */
  ids: (string | undefined)[]
  rejected: RejectedJob[]
  errors: string[]
  migrationMissing: boolean
  extracted: number
  /** How many of this batch's jobs carry a verification verdict other than UNVERIFIED. */
  verified: number
  inserted: number
  updated: number
  /** True when the run's clock kept some of this batch's postings unread; they are stored thin for the next pass. */
  deadlineHit: boolean
}

const EMPTY: BatchOutcome = { jobs: [], ids: [], rejected: [], errors: [], migrationMissing: false, extracted: 0, verified: 0, inserted: 0, updated: 0, deadlineHit: false }

/**
 * Extract, cluster, verify and persist one batch of raw postings.
 *
 * `extractBudget.left` is the run-wide extraction allowance, decremented here,
 * so N batches cost what one batch used to — the cap is on the run, not on the
 * call. Past the deadline nothing new is extracted or verified, but everything
 * already gathered is still normalized, clustered and STORED: that is the whole
 * point of checkpointing.
 */
export async function persistBatch(raws: RawJobPosting[], batch: BatchContext, extractBudget: { left: number }): Promise<BatchOutcome> {
  if (raws.length === 0) return { ...EMPTY }
  const errors: string[] = []

  // (a) Extract + normalize + hard constraints.
  const ex = await extractAndNormalize(raws, {
    mission: batch.mission,
    ctx: batch.ctx,
    run: batch.run,
    maxExtract: Math.max(0, extractBudget.left),
    concurrency: batch.concurrency,
    deadline: batch.deadline,
    stats: batch.stats,
    extractor: batch.extractor,
    onProgress: batch.onProgress,
  })
  extractBudget.left = Math.max(0, extractBudget.left - ex.extracted)
  errors.push(...ex.errors)
  if (ex.deadlineHit) batch.pastDeadline('extraction (remaining postings)')

  // (b) Cluster within the batch. Across batches the store's find-existing
  //     match is the dedupe — a second sighting updates the row it matched.
  const clustered = clusterJobs(ex.jobs)
  batch.stats.clusters += clustered.clusters.length
  batch.stats.duplicates_removed += ex.jobs.length - clustered.merged.length
  const jobs = clustered.merged

  // (c) Verify. ATS-listed this run ⇒ open by construction; the rest go through the page.
  const now = new Date().toISOString()
  const listedThisRun = new Set<NormalizedJob>()
  let verified = 0
  for (const job of jobs) {
    const listed = job.sources.some((s) => isAtsListingSource(s.source_type) && batch.atsListedUrls.has(s.canonical_url ?? s.source_url))
    if (listed) {
      listedThisRun.add(job)
      job.verification_status = 'VERIFIED_OPEN'
      job.last_verified_at = now
      job.verification_method = 'ats_listing'
      job.verification_note = 'listed on the company ATS board this run'
    } else if (batch.verify && !job.canonical_url) {
      job.verification_note = 'aggregator lead without a first-party URL'
    } else if (batch.verify && batch.fetchBudget.left > 0 && !batch.pastDeadline('verification')) {
      batch.fetchBudget.left--
      const v = await verifyWithAgent(job, { registry: batch.registry, fetcher: batch.fetcher, ctx: batch.ctx, verifier: batch.verifier, run: batch.run, onModelCall: () => batch.stats.model_calls++ })
      job.verification_status = v.status === 'AMBIGUOUS' ? 'UNVERIFIED' : v.status
      job.last_verified_at = now
      job.verification_method = v.method
      job.verification_note = v.note
    }
    batch.stats.verification[job.verification_status]++
    if (job.verification_status !== 'UNVERIFIED') verified++
  }

  // (d) Persist, stamping domains the watchlist already knows.
  for (const job of jobs) {
    if (job.company_domain) continue
    const d = batch.domainFor(job.company_name)
    if (d) {
      job.company_domain = d
      job.company_key = `d:${d}`
    }
  }
  const up = await batch.store.upsertJobs(batch.userId, jobs, { runId: batch.run.runId, missionId: batch.mission.id })
  if (up.migrationMissing) return { ...EMPTY, rejected: ex.rejected, errors: [...errors, ...up.errors], migrationMissing: true }
  errors.push(...up.errors)
  batch.stats.jobs_inserted += up.inserted
  batch.stats.jobs_updated += up.updated
  const aligned = up.ids.length === jobs.length
  const ids: (string | undefined)[] = jobs.map((_, i) => (aligned ? up.ids[i] : undefined))

  // upsertJobs never touches verification on a re-seen row — that is the
  // verifier's job — so a row this run saw ON ITS ATS BOARD is refreshed here.
  // Otherwise a job that had gone STALE would stay STALE while the board still
  // lists it. Only when ids line up; a partial upsert loses the mapping.
  if (up.updated > 0 && aligned && batch.store.updateJobVerification) {
    // verification_method is free text in the schema; 'ats_listing' is what the insert path writes.
    const refresh: VerifyResult = { status: 'VERIFIED_OPEN', note: 'listed on the company ATS board this run', method: 'ats_listing' as unknown as VerifyResult['method'], closedSignals: [] }
    for (let i = 0; i < jobs.length; i++) {
      const id = ids[i]
      if (!id || !listedThisRun.has(jobs[i])) continue
      const r = await batch.store.updateJobVerification(batch.userId, id, refresh)
      if (r.error) errors.push(`refresh ${jobs[i].title}: ${r.error}`)
    }
  }

  return { jobs, ids, rejected: ex.rejected, errors, migrationMissing: false, extracted: ex.extracted, verified, inserted: up.inserted, updated: up.updated, deadlineHit: ex.deadlineHit }
}
