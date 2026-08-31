// Package persistence: application_packages, resume_patches (+changes),
// cover_letters, job_snapshots, and the profile the letter signs with.
//
// Every DB write the package pipeline makes lives here, so the same pipeline
// runs with none of them (the no-DB CLI and the evals inject nothing and get
// buffers back). Every call reports `migrationMissing` instead of throwing.

import { createServiceClient } from '@/lib/supabase/server'
import { isMissingSchema } from '../evidence/store'
import { buildSnapshot } from '../jobs/snapshot'
import type { ApplicantNameSource } from '../identity'
import type { VerifiedChange } from '../tailor/pipeline'
import type { ApplicationPackage, CoverLetter, JobOpportunity, JobSnapshot, ResumePatch, ResumePatchChange } from '../types'

export interface WriteResult {
  error: string | null
  migrationMissing: boolean
}

function fail(message: string): WriteResult {
  return { error: message, migrationMissing: isMissingSchema(message) }
}
const ok: WriteResult = { error: null, migrationMissing: false }

// ─── Packages ────────────────────────────────────────────────────────────────

export async function getPackage(userId: string, id: string): Promise<{ pkg: ApplicationPackage | null } & WriteResult> {
  const db = createServiceClient()
  const { data, error } = await db.from('application_packages').select('*').eq('user_id', userId).eq('id', id).maybeSingle()
  if (error) return { pkg: null, ...fail(error.message) }
  return { pkg: (data as ApplicationPackage | null) ?? null, ...ok }
}

export async function nextPackageVersion(userId: string, jobId: string): Promise<{ version: number } & WriteResult> {
  const db = createServiceClient()
  const { data, error } = await db.from('application_packages').select('version').eq('user_id', userId).eq('job_id', jobId).order('version', { ascending: false }).limit(1).maybeSingle()
  if (error) return { version: 1, ...fail(error.message) }
  return { version: ((data as { version: number } | null)?.version ?? 0) + 1, ...ok }
}

/** Earlier packages of this job that are not locked become superseded. The locked one was submitted; it is history. */
export async function supersedePackages(userId: string, jobId: string): Promise<WriteResult & { superseded: number }> {
  const db = createServiceClient()
  const { data, error } = await db
    .from('application_packages')
    .update({ status: 'superseded' } as never)
    .eq('user_id', userId)
    .eq('job_id', jobId)
    .neq('status', 'locked')
    .neq('status', 'superseded')
    .select('id')
  if (error) return { ...fail(error.message), superseded: 0 }
  return { ...ok, superseded: data?.length ?? 0 }
}

export async function insertPackage(row: { user_id: string; job_id: string; application_id: string | null; version: number; run_id: string | null; job_snapshot_id: string | null }): Promise<{ pkg: ApplicationPackage | null } & WriteResult> {
  const db = createServiceClient()
  const { data, error } = await db.from('application_packages').insert({ ...row, status: 'generating', stage: 'started' } as never).select('*').single()
  if (error) return { pkg: null, ...fail(error.message) }
  return { pkg: data as ApplicationPackage, ...ok }
}

export async function updatePackage(id: string, patch: Partial<ApplicationPackage>): Promise<WriteResult> {
  const db = createServiceClient()
  const { error } = await db.from('application_packages').update(patch as never).eq('id', id)
  return error ? fail(error.message) : ok
}

// ─── Snapshots ───────────────────────────────────────────────────────────────

/** The latest snapshot when its sha matches the job's current description; otherwise a fresh one. */
export async function ensureJobSnapshot(job: JobOpportunity, latest: JobSnapshot | null): Promise<{ id: string | null } & WriteResult> {
  const snap = buildSnapshot(job)
  if (latest && latest.sha256 === snap.sha256) return { id: latest.id, ...ok }
  const db = createServiceClient()
  const { data, error } = await db.from('job_snapshots').insert({ job_id: job.id, ...snap } as never).select('id').single()
  if (error) return { id: null, ...fail(error.message) }
  return { id: (data as { id: string }).id, ...ok }
}

// ─── Résumé patches ──────────────────────────────────────────────────────────

export interface PatchWithChanges {
  patch: ResumePatch
  changes: ResumePatchChange[]
}

/**
 * Postgres/PostgREST saying "that column is not there". Deliberately narrower
 * than `isMissingSchema` elsewhere: a MISSING TABLE must stay fatal, because
 * retrying the insert without a few fields would not help and would bury the
 * real problem.
 */
function isMissingColumn(message: string): boolean {
  return /column .* does not exist|could not find the '[^']+' column|schema cache/i.test(message)
}

export async function insertResumePatch(params: {
  userId: string
  jobId: string
  packageId: string
  baseDocumentId: string | null
  noChangeReason: string | null
  summary: string
  editDistance: number
  tailorVersion: string | null
  verifierVersion: string | null
  agentRunId: string | null
  changes: VerifiedChange[]
  /** Migration 018. Absent on a caller that has not been updated; the columns are nullable. */
  hiringArgument?: string | null
  roleThemes?: unknown[]
  lowValueBulletIds?: string[]
  meaningfulChanges?: number
  cosmeticChanges?: number
  coverageBefore?: number | null
  coverageAfter?: number | null
}): Promise<{ patch: PatchWithChanges | null } & WriteResult> {
  const db = createServiceClient()

  const base = {
    user_id: params.userId, job_id: params.jobId, package_id: params.packageId, base_resume_document_id: params.baseDocumentId,
    status: 'proposed', no_change_reason: params.noChangeReason, summary: params.summary || null,
    edit_distance: Math.round(params.editDistance * 10000) / 10000, tailor_version: params.tailorVersion,
    verifier_version: params.verifierVersion, agent_run_id: params.agentRunId,
  }
  const v2 = {
    hiring_argument: params.hiringArgument ?? null,
    role_themes: params.roleThemes ?? [],
    low_value_bullet_ids: params.lowValueBulletIds ?? [],
    meaningful_changes: params.meaningfulChanges ?? 0,
    cosmetic_changes: params.cosmeticChanges ?? 0,
    coverage_before: params.coverageBefore ?? null,
    coverage_after: params.coverageAfter ?? null,
  }

  // Migrations here are applied BY HAND, so there is always a window in which
  // the code knows about a column the database does not have. Losing a whole
  // generated package — minutes of work and real money — because migration 018
  // has not been pasted in yet would be the wrong trade every time. So: write
  // the full row, and if Postgres says the column does not exist, write the row
  // the pre-018 schema accepts and say so in `error`. The package survives; the
  // argument and the coverage numbers are what is missing, and they are visibly
  // missing rather than silently.
  let { data, error } = await db.from('resume_patches').insert({ ...base, ...v2 } as never).select('*').single()
  let degraded: string | null = null
  if (error && isMissingColumn(error.message)) {
    degraded = `resume_patches is pre-018 (${error.message}) — the patch was saved without its hiring argument, role themes or coverage. Apply supabase/migrations/018_tailoring_hiring_argument.sql.`
    ;({ data, error } = await db.from('resume_patches').insert(base as never).select('*').single())
  }
  if (error) return { patch: null, ...fail(error.message) }
  const patch = data as ResumePatch

  const rows = params.changes.map((c) => ({
    patch_id: patch.id,
    bullet_id: c.bullet_id,
    experience_id: c.experience_id,
    change_type: c.change_type,
    edit_level: c.edit_level,
    original_text: c.original_text,
    proposed_text: c.proposed_text,
    source_bullet_id: c.source_bullet_id,
    position: c.position,
    reason: c.reason,
    job_requirement: c.job_requirement,
    evidence_fact_ids: c.evidence_fact_ids,
    confidence: Math.round(Math.min(1, Math.max(0, c.confidence)) * 100) / 100,
    verification_result: c.verification_result,
    verification_notes: c.verification_notes,
    verification_clauses: c.verification_clauses,
    precheck_findings: c.precheck_findings,
    review_status: c.review_status,
    final_text: c.final_text,
  }))
  if (!rows.length) return { patch: { patch, changes: [] }, ...(degraded ? fail(degraded) : ok) }
  const { data: inserted, error: cErr } = await db.from('resume_patch_changes').insert(rows as never[]).select('*')
  if (cErr) return { patch: { patch, changes: [] }, ...fail(cErr.message) }
  return { patch: { patch, changes: (inserted ?? []) as ResumePatchChange[] }, ...(degraded ? fail(degraded) : ok) }
}

export async function loadResumePatch(userId: string, patchId: string): Promise<{ patch: PatchWithChanges | null } & WriteResult> {
  const db = createServiceClient()
  const { data, error } = await db.from('resume_patches').select('*').eq('user_id', userId).eq('id', patchId).maybeSingle()
  if (error) return { patch: null, ...fail(error.message) }
  if (!data) return { patch: null, ...ok }
  const { data: changes, error: cErr } = await db.from('resume_patch_changes').select('*').eq('patch_id', patchId).order('created_at', { ascending: true })
  if (cErr) return { patch: null, ...fail(cErr.message) }
  return { patch: { patch: data as ResumePatch, changes: (changes ?? []) as ResumePatchChange[] }, ...ok }
}

export async function updatePatchChange(id: string, patch: Partial<ResumePatchChange>): Promise<WriteResult> {
  const db = createServiceClient()
  const { error } = await db.from('resume_patch_changes').update(patch as never).eq('id', id)
  return error ? fail(error.message) : ok
}

export async function updateResumePatch(id: string, patch: Partial<ResumePatch>): Promise<WriteResult> {
  const db = createServiceClient()
  const { error } = await db.from('resume_patches').update(patch as never).eq('id', id)
  return error ? fail(error.message) : ok
}

// ─── Cover letters ───────────────────────────────────────────────────────────

export async function nextLetterVersion(userId: string, jobId: string): Promise<number> {
  const db = createServiceClient()
  const { data } = await db.from('cover_letters').select('version').eq('user_id', userId).eq('job_id', jobId).order('version', { ascending: false }).limit(1).maybeSingle()
  return ((data as { version: number } | null)?.version ?? 0) + 1
}

export async function insertCoverLetter(row: Omit<CoverLetter, 'id' | 'created_at' | 'updated_at' | 'edited_text'>): Promise<{ letter: CoverLetter | null } & WriteResult> {
  const db = createServiceClient()
  const { data, error } = await db.from('cover_letters').insert(row as never).select('*').single()
  if (error) return { letter: null, ...fail(error.message) }
  return { letter: data as CoverLetter, ...ok }
}

export async function getCoverLetter(userId: string, id: string): Promise<{ letter: CoverLetter | null } & WriteResult> {
  const db = createServiceClient()
  const { data, error } = await db.from('cover_letters').select('*').eq('user_id', userId).eq('id', id).maybeSingle()
  if (error) return { letter: null, ...fail(error.message) }
  return { letter: (data as CoverLetter | null) ?? null, ...ok }
}

export async function updateCoverLetter(id: string, patch: Partial<CoverLetter>): Promise<WriteResult> {
  const db = createServiceClient()
  const { error } = await db.from('cover_letters').update(patch as never).eq('id', id)
  return error ? fail(error.message) : ok
}

// ─── Profile ─────────────────────────────────────────────────────────────────

export interface LetterSigner {
  /** Resolved through lib/career/identity.ts — never the email local-part. */
  name: string
  /** Where the name came from; surfaced as a warning when it is the fallback. */
  nameSource?: ApplicantNameSource
  email: string
  phone: string
  linkedin: string | null
}

export async function loadProfile(userId: string): Promise<{ name: string | null; email: string | null; linkedin_url: string | null }> {
  const db = createServiceClient()
  const { data } = await db.from('profiles').select('name, email, linkedin_url').eq('id', userId).maybeSingle()
  const p = (data ?? {}) as { name?: string | null; email?: string | null; linkedin_url?: string | null }
  return { name: p.name ?? null, email: p.email ?? null, linkedin_url: p.linkedin_url ?? null }
}
