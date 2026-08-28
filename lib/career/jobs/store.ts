// Persistence for jobs, sources, snapshots, feedback and the company watchlist.
//
// Migration 014 is applied by hand; until it is, every call here reports
// `migrationMissing` rather than throwing, the same way lib/scouting/persist.ts
// does. Nothing in this file judges anything — it matches, upserts and reads.

import { createServiceClient } from '@/lib/supabase/server'
import { normalizeCompanyName, normalizeDomain } from '@/lib/providers/apollo/normalize'
import type { AtsType, FeedbackReason, FeedbackVerdict, JobDisposition, JobOpportunity, VerificationStatus, WatchStatus } from '../types'
import type { NormalizedJob } from './normalize'
import { buildSnapshot } from './snapshot'
import type { VerifyResult } from './verify'

export function isMissingSchema(message: string): boolean {
  return /relation .* does not exist|column .* does not exist|schema cache|could not find/i.test(message)
}

type Db = ReturnType<typeof createServiceClient>

// ─── Companies ───────────────────────────────────────────────────────────────

export interface EnsureCompanyInput {
  name: string
  domain?: string | null
  careers_url?: string | null
  ats?: { ats_type: AtsType; ats_identifier: string } | null
  company_type?: string | null
  website_url?: string | null
}

const WATCH_RANK: Record<WatchStatus, number> = { ignored: 0, watching: 1, target: 2, opening_available: 3 }

/**
 * Find-or-create a company by domain, else normalized name — the same keys
 * lib/scouting/persist.ts uses, so a job's company is the outreach's company.
 * Never downgrades watch_status: a scout seeing an opening must not demote a
 * user-marked target.
 */
export async function ensureCompany(userId: string, input: EnsureCompanyInput, db: Db = createServiceClient()): Promise<{ id: string | null; created: boolean; error: string | null; migrationMissing: boolean }> {
  const domain = normalizeDomain(input.domain)
  const normalizedName = normalizeCompanyName(input.name)
  const query = domain
    ? db.from('companies').select('id, watch_status, careers_url, ats_type, ats_identifier').eq('user_id', userId).eq('domain', domain)
    : db.from('companies').select('id, watch_status, careers_url, ats_type, ats_identifier').eq('user_id', userId).eq('normalized_name', normalizedName)
  const { data: existing, error: readErr } = await query.limit(1).maybeSingle()
  if (readErr) return { id: null, created: false, error: readErr.message, migrationMissing: isMissingSchema(readErr.message) }

  const patch: Record<string, unknown> = {}
  if (input.careers_url) patch.careers_url = input.careers_url
  if (input.ats) {
    patch.ats_type = input.ats.ats_type
    patch.ats_identifier = input.ats.ats_identifier
  }
  if (input.company_type) patch.company_type = input.company_type

  if (existing) {
    const row = existing as { id: string; careers_url: string | null; ats_type: string | null }
    // Keep a careers URL the user set; fill only blanks unless we found an ATS board.
    if (row.careers_url && !input.ats) delete patch.careers_url
    if (Object.keys(patch).length) {
      const { error } = await db.from('companies').update(patch as never).eq('id', row.id)
      if (error && !isMissingSchema(error.message)) return { id: row.id, created: false, error: error.message, migrationMissing: false }
    }
    return { id: row.id, created: false, error: null, migrationMissing: false }
  }

  const { data: created, error } = await db
    .from('companies')
    .insert({
      user_id: userId,
      name: input.name,
      domain,
      normalized_name: domain ? null : normalizedName,
      website_url: input.website_url ?? (domain ? `https://${domain}` : null),
      status: 'discovered',
      ...patch,
    } as never)
    .select('id')
    .maybeSingle()
  if (error) return { id: null, created: false, error: error.message, migrationMissing: isMissingSchema(error.message) }
  return { id: (created as { id: string } | null)?.id ?? null, created: true, error: null, migrationMissing: false }
}

/** Raise (never lower) a company's watch status. */
export async function raiseWatchStatus(companyId: string, status: WatchStatus, current: WatchStatus | null, db: Db = createServiceClient()): Promise<void> {
  if (current && WATCH_RANK[current] >= WATCH_RANK[status]) return
  await db.from('companies').update({ watch_status: status } as never).eq('id', companyId)
}

// ─── Jobs ────────────────────────────────────────────────────────────────────

export interface UpsertJobsResult {
  inserted: number
  updated: number
  skippedClosed: number
  ids: string[]
  companyIds: Record<string, string>
  errors: string[]
  migrationMissing: boolean
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

function jobRow(job: NormalizedJob): Record<string, unknown> {
  const row: Record<string, unknown> = {}
  for (const k of JOB_COLUMNS) row[k] = job[k]
  return row
}

async function findExistingJob(db: Db, userId: string, job: NormalizedJob, companyId: string | null): Promise<{ id: string; verification_status: VerificationStatus; description_text: string | null } | null> {
  const select = 'id, verification_status, description_text'
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
      // `%` and `_` are LIKE wildcards; a title containing them must match itself, not everything.
      .ilike('title', job.title.replace(/[\%_]/g, '\$&'))
      .limit(5)
    const hit = (data as { id: string; verification_status: VerificationStatus; description_text: string | null; location_raw: string | null }[] | null)?.find(
      (r) => (r.location_raw ?? '').toLowerCase() === (job.location_raw ?? '').toLowerCase()
    )
    if (hit) return hit
  }
  return null
}

export async function upsertJobs(userId: string, jobs: NormalizedJob[], opts: { runId?: string | null; missionId?: string | null } = {}): Promise<UpsertJobsResult> {
  const db = createServiceClient()
  const result: UpsertJobsResult = { inserted: 0, updated: 0, skippedClosed: 0, ids: [], companyIds: {}, errors: [], migrationMissing: false }
  const now = new Date().toISOString()

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
      if (job.extraction_confidence == null) for (const k of EXTRACTED_COLUMNS) delete update[k]
      const { error } = await db.from('job_opportunities').update(update as never).eq('id', existing.id)
      if (error) {
        if (isMissingSchema(error.message)) return { ...result, migrationMissing: true, errors: [...result.errors, error.message] }
        result.errors.push(`update ${job.title}: ${error.message}`)
        continue
      }
      if (existing.verification_status === 'CLOSED') result.skippedClosed++
      else result.updated++
      jobId = existing.id
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
  limit?: number
  offset?: number
  sort?: 'fit' | 'recent' | 'deadline'
}

export type JobListRow = JobOpportunity & {
  fit: unknown[]
  applications: { id: string; state: string }[]
  warm_paths: { count: number }[]
}

export async function listJobs(userId: string, filters: ListJobsFilters = {}): Promise<{ jobs: JobListRow[]; total: number | null; error: string | null; migrationMissing: boolean }> {
  const db = createServiceClient()
  let q = db
    .from('job_opportunities')
    .select('*, fit:job_fit_evaluations(*), applications(id, state), warm_paths(count)', { count: 'exact' })
    .eq('user_id', userId)
  if (filters.canonicalOnly ?? true) q = q.eq('is_canonical', true)
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
  const limit = Math.min(200, filters.limit ?? 50)
  const offset = filters.offset ?? 0
  q = q.range(offset, offset + limit - 1)

  const { data, error, count } = await q
  if (error) return { jobs: [], total: null, error: error.message, migrationMissing: isMissingSchema(error.message) }
  return { jobs: (data ?? []) as unknown as JobListRow[], total: count ?? null, error: null, migrationMissing: false }
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

// ─── Watchlist ───────────────────────────────────────────────────────────────

export async function listWatchlist(userId: string): Promise<{ companies: Record<string, unknown>[]; error: string | null; migrationMissing: boolean }> {
  const db = createServiceClient()
  const { data, error } = await db
    .from('companies')
    .select('id, name, domain, website_url, careers_url, ats_type, ats_identifier, watch_status, watch_priority, watch_note, watch_source, last_careers_check_at, careers_check_note, company_type, industry_tags, jobs:job_opportunities(count)')
    .eq('user_id', userId)
    .not('watch_status', 'is', null)
    .neq('watch_status', 'ignored')
    .order('watch_priority', { ascending: false, nullsFirst: false })
    .order('name', { ascending: true })
  if (error) return { companies: [], error: error.message, migrationMissing: isMissingSchema(error.message) }
  return { companies: (data ?? []) as Record<string, unknown>[], error: null, migrationMissing: false }
}

export interface UpsertWatchInput {
  name: string
  domain?: string | null
  careers_url?: string | null
  watch_status: WatchStatus
  watch_priority?: number | null
  watch_note?: string | null
  watch_source: 'planner' | 'user' | 'scout'
  ats?: { ats_type: AtsType; ats_identifier: string } | null
  company_type?: string | null
}

export async function upsertWatch(userId: string, input: UpsertWatchInput): Promise<{ id: string | null; error: string | null; migrationMissing: boolean }> {
  const db = createServiceClient()
  const c = await ensureCompany(userId, { name: input.name, domain: input.domain, careers_url: input.careers_url, ats: input.ats, company_type: input.company_type }, db)
  if (!c.id) return { id: null, error: c.error, migrationMissing: c.migrationMissing }
  const { data: cur } = await db.from('companies').select('watch_status, watch_source').eq('id', c.id).maybeSingle()
  const current = (cur as { watch_status: WatchStatus | null; watch_source: string | null } | null) ?? null
  // The user's own marking outranks the planner's and the scout's; those may only raise.
  const userOwned = current?.watch_source === 'user' && input.watch_source !== 'user'
  const status = userOwned && current?.watch_status ? (WATCH_RANK[input.watch_status] > WATCH_RANK[current.watch_status] ? input.watch_status : current.watch_status) : input.watch_status
  const patch: Record<string, unknown> = { watch_status: status, watch_source: userOwned ? 'user' : input.watch_source }
  if (input.watch_priority !== undefined) patch.watch_priority = input.watch_priority
  if (input.watch_note !== undefined) patch.watch_note = input.watch_note
  const { error } = await db.from('companies').update(patch as never).eq('id', c.id)
  if (error) return { id: c.id, error: error.message, migrationMissing: isMissingSchema(error.message) }
  return { id: c.id, error: null, migrationMissing: false }
}

export async function markCareersChecked(companyId: string, check: { status?: WatchStatus | null; note: string; openings: number }, now = new Date()): Promise<{ error: string | null }> {
  const db = createServiceClient()
  const patch: Record<string, unknown> = { last_careers_check_at: now.toISOString(), careers_check_note: `${check.note} (${check.openings} matching openings)` }
  if (check.status) {
    const { data } = await db.from('companies').select('watch_status').eq('id', companyId).maybeSingle()
    const current = (data as { watch_status: WatchStatus | null } | null)?.watch_status ?? null
    if (!current || WATCH_RANK[check.status] >= WATCH_RANK[current] || (current === 'opening_available' && check.openings === 0 && check.status === 'watching')) {
      patch.watch_status = check.status
    }
  }
  const { error } = await db.from('companies').update(patch as never).eq('id', companyId)
  return { error: error?.message ?? null }
}
