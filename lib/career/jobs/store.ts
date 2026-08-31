// Persistence for jobs, sources, snapshots, feedback and run results.
//
// Migration 014 is applied by hand; until it is, every call here reports
// `migrationMissing` rather than throwing, the same way lib/scouting/persist.ts
// does. Migration 016 adds `scouting_run_jobs`, and every path that uses it
// falls back to `discovery_run_id` when the table is not there yet. Nothing in
// this file judges anything — it matches, upserts and reads.
//
// The company watchlist lives in lib/career/companies/watchlist.ts and is
// re-exported here, because that is where the rule "an agent's guess is never a
// user preference" is enforced and it belongs next to the intent model.

import { createServiceClient } from '@/lib/supabase/server'
import type { FeedbackReason, FeedbackVerdict, JobDisposition, JobOpportunity, VerificationStatus } from '../types'
import { isMissingSchema, type Db } from './db'
import type { NormalizedJob } from './normalize'
import { buildSnapshot } from './snapshot'
import type { VerifyResult } from './verify'

export { isMissingSchema } from './db'
export type { Db } from './db'
// One owner for "what did this run find?" — see lib/career/jobs/run-results.ts.
export { MAX_RUN_JOB_IDS, RUN_JOB_ID_URL_BYTES, runJobIds, runJobSummary } from './run-results'
export type { RunJobIds, RunJobSummary } from './run-results'
// One owner for "which stored rows still need an extraction?" — see
// lib/career/jobs/extraction-store.ts. Re-exported so callers keep one door.
export { MAX_EXTRACTION_POOL, applyExtraction, listExtractionCandidates, loadJobTexts } from './extraction-store'
export type { ExtractionCandidate, ExtractionCandidateOptions } from './extraction-store'
export {
  ensureCompany,
  isReinterpreted,
  listWatchlist,
  markCareersChecked,
  resolveStoredIntent,
  setUserCompanyIntent,
  toCompanyView,
  upsertWatch,
  INTENT_COLUMNS,
} from '../companies/watchlist'
export type {
  CareersCheck,
  EnsureCompanyInput,
  ListWatchlistOptions,
  StoredIntentRow,
  UpsertWatchInput,
  UpsertWatchResult,
  UserCompanyEdit,
  UserCompanyResult,
  WatchlistResult,
} from '../companies/watchlist'

import { ensureCompany } from '../companies/watchlist'
import { runJobIds } from './run-results'

// ─── Jobs ────────────────────────────────────────────────────────────────────

export interface UpsertJobsResult {
  inserted: number
  updated: number
  skippedClosed: number
  ids: string[]
  companyIds: Record<string, string>
  errors: string[]
  migrationMissing: boolean
  /** Rows that actually landed in `scouting_run_jobs` this call. */
  runJobs?: number
  /** Links offered — one per job touched. Higher than `runJobs` when a link already existed. */
  runJobsAttempted?: number
  /** Set when the run→job table is not there yet; the run still succeeds. */
  runJobsNote?: string | null
}

const JOB_COLUMNS: (keyof NormalizedJob)[] = [
  'company_name', 'title', 'role_family', 'description_text', 'description_html', 'location_raw', 'location_city',
  'location_state', 'location_country', 'location_tier', 'work_mode', 'employment_type', 'season_relevance', 'posted_at',
  'source_updated_at', 'deadline', 'canonical_url', 'apply_url', 'ats_type', 'ats_job_id', 'requisition_id', 'compensation',
  'min_qualifications', 'preferred_qualifications', 'graduation_eligibility', 'work_authorization', 'skills',
  'responsibilities', 'industry', 'company_size_stage', 'extraction_version', 'extraction_confidence', 'confidence', 'is_canonical',
]

/** Columns that only mean something when the incoming copy carries text. */
const DESCRIPTION_COLUMNS: (keyof NormalizedJob)[] = ['description_text', 'description_html']
/** Columns the Job Extractor fills; a copy without extraction has nothing to say about them. */
const EXTRACTED_COLUMNS: (keyof NormalizedJob)[] = [
  'deadline', 'compensation', 'min_qualifications', 'preferred_qualifications', 'graduation_eligibility',
  'work_authorization', 'skills', 'responsibilities', 'industry', 'extraction_version', 'extraction_confidence',
]
/**
 * Columns the heuristics compute for every copy but an extraction IMPROVES.
 *
 * They matter once discovery sweeps daily. A sweep re-lists a board and
 * re-derives these from the title alone; if it wrote them back it would undo
 * yesterday's extraction — "Summer 2027" learned from the body would revert to
 * 'unspecified', a role family read from the responsibilities would revert to
 * 'other'. So a thin copy leaves them alone whenever the stored row was
 * extracted. Nothing is lost: a re-listing has no new information about them.
 */
const MODEL_REFINED_COLUMNS: (keyof NormalizedJob)[] = ['role_family', 'employment_type', 'season_relevance', 'work_mode']

function jobRow(job: NormalizedJob): Record<string, unknown> {
  const row: Record<string, unknown> = {}
  for (const k of JOB_COLUMNS) row[k] = job[k]
  return row
}

/**
 * A literal string as a LIKE pattern: `%`, `_` and the escape character itself
 * become themselves. Exported so the test can prove it, since the previous
 * version silently did nothing.
 */
export function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, (m) => `\\${m}`)
}

async function findExistingJob(db: Db, userId: string, job: NormalizedJob, companyId: string | null): Promise<{ id: string; verification_status: VerificationStatus; description_text: string | null; extraction_version: string | null } | null> {
  const select = 'id, verification_status, description_text, extraction_version'
  if (job.ats_type && job.ats_job_id) {
    const { data } = await db.from('job_opportunities').select(select).eq('user_id', userId).eq('ats_type', job.ats_type).eq('ats_job_id', job.ats_job_id).limit(1).maybeSingle()
    if (data) return data as never
  }
  if (job.canonical_url) {
    const { data } = await db.from('job_opportunities').select(select).eq('user_id', userId).eq('canonical_url', job.canonical_url).limit(1).maybeSingle()
    if (data) return data as never
  }
  if (companyId) {
    const { data } = await db
      .from('job_opportunities')
      .select(`${select}, title, location_raw`)
      .eq('user_id', userId)
      .eq('company_id', companyId)
      // `%` and `_` are LIKE wildcards; a title containing them must match
      // itself, not everything. LIKE's escape character is the backslash, so
      // each one is prefixed with a real backslash — `'\\$&'` looked like an
      // escape and was not: `$&` expands to the match, leaving the title
      // unchanged and "Analyst_Intern 50%" matching other postings.
      .ilike('title', escapeLike(job.title))
      .limit(5)
    const hit = (data as { id: string; verification_status: VerificationStatus; description_text: string | null; extraction_version: string | null; location_raw: string | null }[] | null)?.find(
      (r) => (r.location_raw ?? '').toLowerCase() === (job.location_raw ?? '').toLowerCase()
    )
    if (hit) return hit
  }
  return null
}

/**
 * Record which jobs a run touched. `discovery_run_id` only ever named the run
 * that INSERTED a job, so a run that re-found ten postings looked like it found
 * nothing. One row per (run, job), `inserted` saying which it was.
 */
async function linkRunJobs(db: Db, userId: string, runId: string, touched: { job_id: string; inserted: boolean }[]): Promise<{ written: number; attempted: number; note: string | null; error: string | null }> {
  const attempted = touched.length
  if (attempted === 0) return { written: 0, attempted: 0, note: null, error: null }
  const rows = touched.map((t) => ({ run_id: runId, job_id: t.job_id, user_id: userId, inserted: t.inserted }))
  // `ignoreDuplicates` means a re-touched (or retried) link writes nothing, so
  // the count is asked for rather than assumed — otherwise a retry would report
  // rows that never landed.
  const { error, count } = await db.from('scouting_run_jobs').upsert(rows as never, { onConflict: 'run_id,job_id', ignoreDuplicates: true, count: 'exact' })
  if (!error) return { written: typeof count === 'number' ? count : attempted, attempted, note: null, error: null }
  if (isMissingSchema(error.message)) return { written: 0, attempted, note: 'run results fall back to discovery_run_id — apply migration 016', error: null }
  return { written: 0, attempted, note: null, error: `run jobs: ${error.message}` }
}

export async function upsertJobs(
  userId: string,
  jobs: NormalizedJob[],
  opts: { runId?: string | null; missionId?: string | null } = {},
  db: Db = createServiceClient()
): Promise<UpsertJobsResult> {
  const result: UpsertJobsResult = { inserted: 0, updated: 0, skippedClosed: 0, ids: [], companyIds: {}, errors: [], migrationMissing: false }
  const now = new Date().toISOString()
  const touched: { job_id: string; inserted: boolean }[] = []

  for (const job of jobs) {
    // Company first — a job with no company row still persists, just unlinked.
    let companyId: string | null = result.companyIds[job.company_key] ?? null
    if (!companyId) {
      // The board identity is the scout's to record (it knows the AtsBoardRef); here we only link.
      const c = await ensureCompany(userId, { name: job.company_name, domain: job.company_domain }, db)
      if (c.migrationMissing) return { ...result, migrationMissing: true, errors: [...result.errors, c.error ?? 'migration missing'] }
      if (c.error) result.errors.push(`company ${job.company_name}: ${c.error}`)
      companyId = c.id
      if (companyId) result.companyIds[job.company_key] = companyId
    }

    const existing = await findExistingJob(db, userId, job, companyId)
    const row = { ...jobRow(job), company_id: companyId, mission_id: opts.missionId ?? null, last_seen_at: now }

    let jobId: string
    if (existing) {
      // Re-seeing a job never changes its verification status — that is the
      // verifier's job — except when the new copy's text says it is closed.
      const update: Record<string, unknown> = job.verification_status === 'CLOSED'
        ? { ...row, verification_status: 'CLOSED', verification_note: job.verification_note, verification_method: job.verification_method }
        : { ...row }
      // A thinner copy must not erase a richer row: a SmartRecruiters/Workable
      // listing carries no description, and a re-listing carries no extraction.
      // Only overwrite what the incoming copy actually has.
      if (!job.description_text) for (const k of DESCRIPTION_COLUMNS) delete update[k]
      if (job.extraction_confidence == null) {
        for (const k of EXTRACTED_COLUMNS) delete update[k]
        // …and never let a re-listing walk back what an extraction learned.
        if (existing.extraction_version) for (const k of MODEL_REFINED_COLUMNS) delete update[k]
      }
      const { error } = await db.from('job_opportunities').update(update as never).eq('id', existing.id)
      if (error) {
        if (isMissingSchema(error.message)) return { ...result, migrationMissing: true, errors: [...result.errors, error.message] }
        result.errors.push(`update ${job.title}: ${error.message}`)
        continue
      }
      if (existing.verification_status === 'CLOSED') result.skippedClosed++
      else result.updated++
      jobId = existing.id
      touched.push({ job_id: jobId, inserted: false })
    } else {
      const { data, error } = await db
        .from('job_opportunities')
        .insert({ ...row, user_id: userId, first_seen_at: now, discovery_run_id: opts.runId ?? null, verification_status: job.verification_status, verification_note: job.verification_note, verification_method: job.verification_method, disposition: 'new' } as never)
        .select('id')
        .maybeSingle()
      if (error || !data) {
        const message = error?.message ?? 'insert returned no row'
        if (error && isMissingSchema(message)) return { ...result, migrationMissing: true, errors: [...result.errors, message] }
        result.errors.push(`insert ${job.title}: ${message}`)
        continue
      }
      result.inserted++
      jobId = (data as { id: string }).id
      touched.push({ job_id: jobId, inserted: true })
    }
    result.ids.push(jobId)

    // Every place we saw it. The unique index makes re-runs idempotent; the conflict is expected.
    for (const s of job.sources) {
      const { error } = await db
        .from('job_sources')
        .insert({ job_id: jobId, source_type: s.source_type, source_url: s.source_url, external_id: s.external_id, raw: s.raw, run_id: opts.runId ?? null } as never)
      if (error && !/duplicate key|unique/i.test(error.message)) result.errors.push(`source ${s.source_url}: ${error.message}`)
    }

    // Snapshot only when the description actually changed.
    const snap = buildSnapshot(job)
    const { data: last } = await db.from('job_snapshots').select('sha256').eq('job_id', jobId).order('captured_at', { ascending: false }).limit(1).maybeSingle()
    if ((last as { sha256: string | null } | null)?.sha256 !== snap.sha256) {
      const { error } = await db.from('job_snapshots').insert({ job_id: jobId, ...snap } as never)
      if (error) result.errors.push(`snapshot ${job.title}: ${error.message}`)
    }
  }

  if (opts.runId) {
    const linked = await linkRunJobs(db, userId, opts.runId, touched)
    result.runJobs = linked.written
    result.runJobsAttempted = linked.attempted
    result.runJobsNote = linked.note
    if (linked.error) result.errors.push(linked.error)
  }
  return result
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export interface ListJobsFilters {
  mission_id?: string | null
  status?: VerificationStatus[]
  disposition?: JobDisposition | JobDisposition[]
  tier?: number | number[]
  role_family?: string | string[]
  minFit?: number
  search?: string
  canonicalOnly?: boolean
  /**
   * One scout run's results. Everything that run touched — including postings
   * it re-found — and none of the inbox's narrowing: no freshness, no
   * disposition, no canonical-only unless the caller asks for them.
   */
  runId?: string | null
  limit?: number
  offset?: number
  sort?: 'fit' | 'recent' | 'deadline'
}

export type JobListRow = JobOpportunity & {
  fit: unknown[]
  applications: { id: string; state: string; current_package_id: string | null }[]
  feedback: { verdict: string; created_at: string }[]
  warm_paths: { count: number }[]
}

export interface ListJobsResult {
  jobs: JobListRow[]
  total: number | null
  error: string | null
  migrationMissing: boolean
  /** In a run view: jobs the run touched beyond `MAX_RUN_JOB_IDS`, not fetched. */
  truncated?: number
}

export async function listJobs(userId: string, filters: ListJobsFilters = {}, db: Db = createServiceClient()): Promise<ListJobsResult> {
  let runIds: string[] | null = null
  let truncated = 0
  if (filters.runId) {
    const link = await runJobIds(userId, filters.runId, db)
    truncated = link.truncated
    if (link.ids.length === 0) return { jobs: [], total: 0, error: link.error, migrationMissing: false, truncated }
    runIds = link.ids
  }

  let q = db
    .from('job_opportunities')
    .select('*, fit:job_fit_evaluations(*), applications(id, state, current_package_id), feedback:job_feedback(verdict, created_at), warm_paths(count)', { count: 'exact' })
    .eq('user_id', userId)
  if (runIds) q = q.in('id', runIds)
  // Outside a run view, the inbox shows canonical rows only. Inside one, the
  // question is "what did this run find?" — every default that narrows the
  // answer is off unless the caller set it.
  if (filters.canonicalOnly ?? !runIds) q = q.eq('is_canonical', true)
  if (filters.mission_id) q = q.eq('mission_id', filters.mission_id)
  if (filters.status?.length) q = q.in('verification_status', filters.status)
  if (filters.disposition) q = q.in('disposition', Array.isArray(filters.disposition) ? filters.disposition : [filters.disposition])
  if (filters.tier !== undefined) q = q.in('location_tier', Array.isArray(filters.tier) ? filters.tier : [filters.tier])
  if (filters.role_family) q = q.in('role_family', Array.isArray(filters.role_family) ? filters.role_family : [filters.role_family])
  if (filters.minFit !== undefined) q = q.gte('fit_overall', filters.minFit)
  if (filters.search) {
    const s = filters.search.replace(/[%,()]/g, ' ').trim()
    if (s) q = q.or(`title.ilike.%${s}%,company_name.ilike.%${s}%`)
  }
  const sort = filters.sort ?? 'fit'
  if (sort === 'fit') q = q.order('fit_overall', { ascending: false, nullsFirst: false }).order('last_seen_at', { ascending: false })
  else if (sort === 'deadline') q = q.order('deadline', { ascending: true, nullsFirst: false }).order('fit_overall', { ascending: false, nullsFirst: false })
  else q = q.order('first_seen_at', { ascending: false })
  const limit = Math.min(200, filters.limit ?? (runIds ? 200 : 50))
  const offset = filters.offset ?? 0
  q = q.range(offset, offset + limit - 1)

  const { data, error, count } = await q
  if (error) return { jobs: [], total: null, error: error.message, migrationMissing: isMissingSchema(error.message), truncated }
  // `total` is the count across pages, not the page — a run header must never
  // report a page size as what the run found.
  return { jobs: (data ?? []) as unknown as JobListRow[], total: count ?? null, error: null, migrationMissing: false, truncated }
}

export async function getJob(userId: string, id: string): Promise<{ job: Record<string, unknown> | null; error: string | null; migrationMissing: boolean }> {
  const db = createServiceClient()
  const { data, error } = await db
    .from('job_opportunities')
    .select('*, sources:job_sources(*), fit:job_fit_evaluations(*), evidence_map:job_evidence_maps(*), warm_paths(*), feedback:job_feedback(*), applications(*)')
    .eq('user_id', userId)
    .eq('id', id)
    .maybeSingle()
  if (error) return { job: null, error: error.message, migrationMissing: isMissingSchema(error.message) }
  if (!data) return { job: null, error: null, migrationMissing: false }
  const { data: snapshot } = await db.from('job_snapshots').select('*').eq('job_id', id).order('captured_at', { ascending: false }).limit(1).maybeSingle()
  return { job: { ...(data as Record<string, unknown>), latest_snapshot: snapshot ?? null }, error: null, migrationMissing: false }
}

// ─── Writes ──────────────────────────────────────────────────────────────────

export async function updateJobVerification(userId: string, id: string, result: VerifyResult, now = new Date()): Promise<{ error: string | null }> {
  const db = createServiceClient()
  const status: VerificationStatus = result.status === 'AMBIGUOUS' ? 'UNVERIFIED' : result.status
  const { error } = await db
    .from('job_opportunities')
    .update({ verification_status: status, last_verified_at: now.toISOString(), verification_note: result.note, verification_method: result.method } as never)
    .eq('user_id', userId)
    .eq('id', id)
  return { error: error?.message ?? null }
}

export async function setDisposition(userId: string, id: string, disposition: JobDisposition): Promise<{ error: string | null }> {
  const db = createServiceClient()
  const { error } = await db.from('job_opportunities').update({ disposition } as never).eq('user_id', userId).eq('id', id)
  return { error: error?.message ?? null }
}

export async function recordFeedback(userId: string, jobId: string, verdict: FeedbackVerdict, reasons: FeedbackReason[], note?: string | null): Promise<{ id: string | null; error: string | null }> {
  const db = createServiceClient()
  const { data, error } = await db.from('job_feedback').insert({ user_id: userId, job_id: jobId, verdict, reasons, note: note ?? null } as never).select('id').maybeSingle()
  if (error) return { id: null, error: error.message }
  // LOVE/INTERESTED implies saved; NOT_INTERESTED implies dismissed. MAYBE leaves it alone.
  const disposition: JobDisposition | null = verdict === 'NOT_INTERESTED' ? 'dismissed' : verdict === 'MAYBE' ? null : 'saved'
  if (disposition) await db.from('job_opportunities').update({ disposition } as never).eq('user_id', userId).eq('id', jobId)
  return { id: (data as { id: string } | null)?.id ?? null, error: null }
}
