// Application persistence and transitions.
//
// The route calls `transitionApplication`; this file decides whether the move
// is legal (states.ts), writes the event, and performs the ONE side effect that
// carries weight: reaching APPLIED locks the application and freezes the
// package that was submitted. Nothing here generates documents.

import { createServiceClient } from '@/lib/supabase/server'
import type { Application, ApplicationState, InterviewEntry } from '../types'
import { canTransition, isLockedState, outcomeForTransition } from './states'

function isMissingSchema(message: string): boolean {
  return /relation .* does not exist|column .* does not exist|schema cache|could not find/i.test(message)
}

export interface ApplicationWithJob extends Application {
  job?: {
    id: string
    title: string
    company_name: string
    location_raw: string | null
    canonical_url: string | null
    apply_url: string | null
    verification_status: string
    deadline: string | null
    fit_overall: number | null
  } | null
  package?: {
    id: string
    version: number
    status: string
    resume_filename: string | null
    cover_filename: string | null
    resume_pdf_path: string | null
    cover_pdf_path: string | null
  } | null
}

const JOB_SELECT = 'job:job_opportunities(id,title,company_name,location_raw,canonical_url,apply_url,verification_status,deadline,fit_overall)'

export async function listApplications(
  userId: string,
  opts: { states?: ApplicationState[] } = {}
): Promise<{ applications: ApplicationWithJob[]; migrationMissing: boolean; error: string | null }> {
  const supabase = createServiceClient()
  let q = supabase.from('applications').select(`*, ${JOB_SELECT}`).eq('user_id', userId).order('updated_at', { ascending: false })
  if (opts.states?.length) q = q.in('state', opts.states)
  const { data, error } = await q
  if (error) return { applications: [], migrationMissing: isMissingSchema(error.message), error: error.message }

  const rows = (data ?? []) as ApplicationWithJob[]
  // Packages are looked up separately: applications.current_package_id has no
  // FK on purpose (the package row is created after the application), so
  // PostgREST cannot embed it.
  const packageIds = rows.map((r) => r.submitted_package_id ?? r.current_package_id).filter((x): x is string => Boolean(x))
  if (packageIds.length) {
    const { data: pkgs } = await supabase
      .from('application_packages')
      .select('id,version,status,resume_filename,cover_filename,resume_pdf_path,cover_pdf_path')
      .in('id', packageIds)
    const byId = new Map((pkgs ?? []).map((p) => [p.id as string, p]))
    for (const r of rows) {
      const id = r.submitted_package_id ?? r.current_package_id
      r.package = id ? ((byId.get(id) as ApplicationWithJob['package']) ?? null) : null
    }
  }
  return { applications: rows, migrationMissing: false, error: null }
}

export async function getApplication(userId: string, id: string): Promise<ApplicationWithJob | null> {
  const supabase = createServiceClient()
  const { data } = await supabase.from('applications').select(`*, ${JOB_SELECT}`).eq('user_id', userId).eq('id', id).maybeSingle()
  return (data as ApplicationWithJob | null) ?? null
}

export async function getApplicationForJob(userId: string, jobId: string): Promise<Application | null> {
  const supabase = createServiceClient()
  const { data } = await supabase.from('applications').select('*').eq('user_id', userId).eq('job_id', jobId).maybeSingle()
  return (data as Application | null) ?? null
}

/**
 * One application per (user, job). Created in `initialState` (default SAVED)
 * when none exists; returns the existing row otherwise, untouched.
 */
export async function ensureApplication(
  userId: string,
  jobId: string,
  opts: { initialState?: ApplicationState; companyId?: string | null; jobSnapshotId?: string | null } = {}
): Promise<{ application: Application | null; created: boolean; error: string | null; migrationMissing: boolean }> {
  const existing = await getApplicationForJob(userId, jobId)
  if (existing) return { application: existing, created: false, error: null, migrationMissing: false }

  const supabase = createServiceClient()
  const state = opts.initialState ?? 'SAVED'
  const { data, error } = await supabase
    .from('applications')
    .insert({
      user_id: userId,
      job_id: jobId,
      company_id: opts.companyId ?? null,
      state,
      job_snapshot_id: opts.jobSnapshotId ?? null,
    } as never)
    .select('*')
    .single()
  if (error) return { application: null, created: false, error: error.message, migrationMissing: isMissingSchema(error.message) }

  await supabase.from('application_events').insert({
    application_id: (data as Application).id,
    from_state: null,
    to_state: state,
    actor: 'user',
    detail: { created: true },
  } as never)
  return { application: data as Application, created: true, error: null, migrationMissing: false }
}

export interface TransitionResult {
  ok: boolean
  application: Application | null
  error: string | null
  /** Set when the move was rejected by the transition table. */
  illegal?: boolean
}

export async function transitionApplication(
  userId: string,
  applicationId: string,
  to: ApplicationState,
  opts: { actor?: 'user' | 'system' | 'agent'; detail?: Record<string, unknown>; note?: string | null } = {}
): Promise<TransitionResult> {
  const supabase = createServiceClient()
  const { data: current, error: readErr } = await supabase
    .from('applications')
    .select('*')
    .eq('user_id', userId)
    .eq('id', applicationId)
    .maybeSingle()
  if (readErr) return { ok: false, application: null, error: readErr.message }
  if (!current) return { ok: false, application: null, error: 'application not found' }

  const app = current as Application
  if (app.state === to) return { ok: true, application: app, error: null }
  if (!canTransition(app.state, to)) {
    return { ok: false, application: app, error: `cannot move from ${app.state} to ${to}`, illegal: true }
  }

  const patch: Record<string, unknown> = { state: to }
  const outcome = outcomeForTransition(app.state, to)
  if (outcome) {
    patch.outcome = outcome
    patch.outcome_at = new Date().toISOString()
    if (opts.note) patch.outcome_note = opts.note
  }

  // ─── The lock ───
  // Reaching APPLIED freezes what was submitted. The current package becomes
  // the submitted package, its status becomes `locked`, and its document paths
  // are copied onto the application so they survive any later regeneration.
  if (to === 'APPLIED' && !app.locked) {
    patch.applied_at = new Date().toISOString()
    patch.locked = true
    if (app.current_package_id) {
      patch.submitted_package_id = app.current_package_id
      const { data: pkg } = await supabase
        .from('application_packages')
        .select('id,resume_pdf_path,cover_pdf_path,resume_docx_path,cover_docx_path,job_snapshot_id')
        .eq('id', app.current_package_id)
        .maybeSingle()
      if (pkg) {
        patch.submitted_resume_path = pkg.resume_pdf_path ?? pkg.resume_docx_path ?? null
        patch.submitted_cover_letter_path = pkg.cover_pdf_path ?? pkg.cover_docx_path ?? null
        if (!app.job_snapshot_id && pkg.job_snapshot_id) patch.job_snapshot_id = pkg.job_snapshot_id
        await supabase.from('application_packages').update({ status: 'locked' } as never).eq('id', pkg.id)
      }
    }
  } else if (isLockedState(to) && !app.locked) {
    patch.locked = true
  }

  const { data: updated, error } = await supabase
    .from('applications')
    .update(patch as never)
    .eq('id', applicationId)
    .eq('user_id', userId)
    .select('*')
    .single()
  if (error) return { ok: false, application: app, error: error.message }

  await supabase.from('application_events').insert({
    application_id: applicationId,
    from_state: app.state,
    to_state: to,
    actor: opts.actor ?? 'user',
    detail: { ...(opts.detail ?? {}), ...(opts.note ? { note: opts.note } : {}) },
  } as never)

  return { ok: true, application: updated as Application, error: null }
}

export async function updateApplicationDetails(
  userId: string,
  applicationId: string,
  patch: { notes?: string | null; interviews?: InterviewEntry[]; contacts_used?: string[]; outcome_note?: string | null; current_package_id?: string | null }
): Promise<{ ok: boolean; error: string | null }> {
  const supabase = createServiceClient()
  const safe: Record<string, unknown> = {}
  if (patch.notes !== undefined) safe.notes = patch.notes
  if (patch.outcome_note !== undefined) safe.outcome_note = patch.outcome_note
  if (Array.isArray(patch.contacts_used)) safe.contacts_used = patch.contacts_used
  if (Array.isArray(patch.interviews)) {
    safe.interviews = patch.interviews
      .filter((i) => i && typeof i === 'object' && typeof i.stage === 'string')
      .map((i) => ({ stage: i.stage, at: i.at ?? null, notes: i.notes ?? null }))
  }
  if (patch.current_package_id !== undefined) safe.current_package_id = patch.current_package_id
  if (Object.keys(safe).length === 0) return { ok: true, error: null }
  const { error } = await supabase.from('applications').update(safe as never).eq('id', applicationId).eq('user_id', userId)
  return { ok: !error, error: error?.message ?? null }
}

export async function listApplicationEvents(applicationId: string): Promise<{ from_state: string | null; to_state: string; actor: string; detail: Record<string, unknown> | null; created_at: string }[]> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from('application_events')
    .select('from_state,to_state,actor,detail,created_at')
    .eq('application_id', applicationId)
    .order('created_at', { ascending: true })
  return (data ?? []) as never[]
}
