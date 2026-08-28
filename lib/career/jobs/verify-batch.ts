// Batch freshness verification, and the one agent hop it allows.
//
// verifyJob (lib/career/jobs/verify.ts) is deterministic and answers the
// clear cases itself. Only AMBIGUOUS — a 200 page that does not obviously
// carry the title — reaches the Job Verifier, and its verdict maps down to a
// status a human could have reached by reading the page: OPEN ⇒ LIKELY_OPEN
// (a model's reading is never VERIFIED), CLOSED ⇒ CLOSED, UNCLEAR ⇒ UNVERIFIED.
//
// The batch side is what keeps a saved list honest: saved and tracked jobs
// are re-checked, a job nothing could confirm inside the staleness window is
// STALE, and a tracked job that closes before the user applied moves its
// application to CLOSED — by the system, with a note, never past APPLIED.

import { runJobVerifier, type JobVerification, type JobVerifierInput } from '@/lib/agents/job-verifier'
import type { AgentResult, ToolContext } from '@/lib/agents/runtime/types'
import { mapWithConcurrency } from '@/lib/scouting/concurrency'
import { createServiceClient } from '@/lib/supabase/server'
import { PRE_APPLICATION_STATES } from '../applications/states'
import { transitionApplication } from '../applications/store'
import type { CareerRun } from '../runs'
import { getPageFetcher } from '../sources/fetch'
import { getSourceRegistry } from '../sources/registry'
import type { PageFetcher, SourceRegistry } from '../sources/types'
import { VERIFICATION_STATUSES, type ApplicationState, type VerificationStatus } from '../types'
import { isMissingSchema, updateJobVerification } from './store'
import { applyStaleness, verifyJob, type VerifyResult } from './verify'

export type VerifierFn = (input: JobVerifierInput, ctx: ToolContext) => Promise<AgentResult<JobVerification>>

export interface VerifyAgentDeps {
  registry: SourceRegistry
  fetcher: PageFetcher
  ctx: ToolContext
  verifier?: VerifierFn
  run?: Pick<CareerRun, 'trace'> | null
  onModelCall?: (result: AgentResult<JobVerification>) => void
}

type VerifiableJob = Parameters<typeof verifyJob>[0]

/** Deterministic verification first; the agent only on AMBIGUOUS. Never returns AMBIGUOUS. */
export async function verifyWithAgent(job: VerifiableJob, deps: VerifyAgentDeps): Promise<VerifyResult> {
  const result = await verifyJob(job, { registry: deps.registry, fetcher: deps.fetcher })
  if (result.status !== 'AMBIGUOUS') return result
  const url = job.canonical_url ?? job.apply_url ?? ''
  const verifier = deps.verifier ?? runJobVerifier
  try {
    const res = await verifier({ title: job.title, company: job.company_name ?? '', url, page_text: result.pageText ?? '', fetched_status: 200 }, deps.ctx)
    deps.onModelCall?.(res)
    await deps.run?.trace(res, { url, title: job.title })
    if (!res.output) return { ...result, status: 'UNVERIFIED', note: `${result.note}; verifier ${res.status}: ${res.error ?? 'no output'}`, method: 'page' }
    const v = res.output
    const status: VerificationStatus = v.verdict === 'OPEN' ? 'LIKELY_OPEN' : v.verdict === 'CLOSED' ? 'CLOSED' : 'UNVERIFIED'
    return { ...result, status, note: `verifier: ${v.verdict} — ${v.reasoning.slice(0, 200)}`, method: 'page', closedSignals: v.closed_signals }
  } catch (e) {
    return { ...result, status: 'UNVERIFIED', note: `${result.note}; verifier failed: ${e instanceof Error ? e.message : String(e)}`, method: 'page' }
  }
}

// ─── Batch ───────────────────────────────────────────────────────────────────

export type VerifyScope = 'saved' | 'tracked' | 'stale' | 'all' | 'ids'

export interface VerifiableRow {
  id: string
  title: string
  company_name: string
  ats_type: string | null
  ats_job_id: string | null
  canonical_url: string | null
  apply_url: string | null
  verification_status: VerificationStatus
  last_verified_at: string | null
}

export interface VerifyStore {
  listCandidates(userId: string, scope: VerifyScope, opts: { ids?: string[]; limit: number; staleDays: number; now: Date }): Promise<{ jobs: VerifiableRow[]; error: string | null; migrationMissing: boolean }>
  updateJobVerification(userId: string, id: string, result: VerifyResult, now?: Date): Promise<{ error: string | null }>
  applicationsForJobs(userId: string, jobIds: string[]): Promise<{ id: string; job_id: string; state: ApplicationState }[]>
  transitionApplication(userId: string, applicationId: string, to: ApplicationState, opts: { actor: 'system'; note: string }): Promise<{ ok: boolean; error: string | null }>
}

const ROW_SELECT = 'id, title, company_name, ats_type, ats_job_id, canonical_url, apply_url, verification_status, last_verified_at'

export function liveVerifyStore(): VerifyStore {
  return {
    async listCandidates(userId, scope, opts) {
      const db = createServiceClient()
      const staleBefore = new Date(opts.now.getTime() - opts.staleDays * 24 * 3600 * 1000).toISOString()
      let q = db.from('job_opportunities').select(scope === 'tracked' ? `${ROW_SELECT}, applications!inner(id)` : ROW_SELECT).eq('user_id', userId)
      if (scope === 'ids') q = q.in('id', opts.ids ?? [])
      // Closed rows are done and dismissed rows are the user's "no": neither earns a fetch.
      else q = q.neq('verification_status', 'CLOSED').neq('disposition', 'dismissed')
      if (scope === 'saved') q = q.eq('disposition', 'saved')
      if (scope === 'stale') q = q.or(`last_verified_at.is.null,last_verified_at.lt.${staleBefore}`)
      q = q.order('last_verified_at', { ascending: true, nullsFirst: true }).limit(opts.limit)
      const { data, error } = await q
      if (error) return { jobs: [], error: error.message, migrationMissing: isMissingSchema(error.message) }
      return { jobs: (data ?? []) as unknown as VerifiableRow[], error: null, migrationMissing: false }
    },
    updateJobVerification,
    async applicationsForJobs(userId, jobIds) {
      if (!jobIds.length) return []
      const db = createServiceClient()
      const { data } = await db.from('applications').select('id, job_id, state').eq('user_id', userId).in('job_id', jobIds)
      return ((data ?? []) as { id: string; job_id: string; state: ApplicationState }[])
    },
    transitionApplication: (userId, id, to, opts) => transitionApplication(userId, id, to, opts).then((r) => ({ ok: r.ok, error: r.error })),
  }
}

export interface VerifyJobsOptions {
  scope: VerifyScope
  ids?: string[]
  limit?: number
  staleDays?: number
  concurrency?: number
  ctx: ToolContext
  run?: Pick<CareerRun, 'trace'> | null
  onProgress?: (detail: string) => void
  registry?: SourceRegistry
  fetcher?: PageFetcher
  verifier?: VerifierFn
  store?: VerifyStore
  now?: Date
}

export interface VerifyJobsResult {
  checked: number
  outcomes: Record<VerificationStatus, number>
  changed: { id: string; title: string; company: string; from: VerificationStatus; to: VerificationStatus; note: string }[]
  results: { id: string; status: VerificationStatus; note: string; last_verified_at: string }[]
  applicationsClosed: { application_id: string; job_id: string; from: ApplicationState }[]
  errors: string[]
  migrationMissing: boolean
}

export async function verifyJobs(userId: string, opts: VerifyJobsOptions): Promise<VerifyJobsResult> {
  const store = opts.store ?? liveVerifyStore()
  const registry = opts.registry ?? getSourceRegistry()
  const fetcher = opts.fetcher ?? getPageFetcher()
  const now = opts.now ?? new Date()
  const staleDays = opts.staleDays ?? 14
  const outcomes = {} as Record<VerificationStatus, number>
  for (const s of VERIFICATION_STATUSES) outcomes[s] = 0
  const result: VerifyJobsResult = { checked: 0, outcomes, changed: [], results: [], applicationsClosed: [], errors: [], migrationMissing: false }

  const list = await store.listCandidates(userId, opts.scope, { ids: opts.ids, limit: opts.limit ?? 50, staleDays, now })
  if (list.migrationMissing) return { ...result, migrationMissing: true, errors: [list.error ?? 'migration missing'] }
  if (list.error) return { ...result, errors: [list.error] }

  await mapWithConcurrency(list.jobs, opts.concurrency ?? 4, async (job) => {
    try {
      const verified = await verifyWithAgent(job, { registry, fetcher, ctx: opts.ctx, verifier: opts.verifier, run: opts.run })
      // Nothing confirmed it and the window has passed: say STALE, not "still open".
      const confirmed = verified.status === 'VERIFIED_OPEN' || verified.status === 'LIKELY_OPEN' || verified.status === 'CLOSED'
      const stale = applyStaleness(job, now, staleDays) === 'STALE'
      const final: VerifyResult = !confirmed && stale
        ? { ...verified, status: 'STALE', note: `unconfirmed for over ${staleDays} days (${verified.note})` }
        : verified
      const status = final.status === 'AMBIGUOUS' ? 'UNVERIFIED' : final.status
      const { error } = await store.updateJobVerification(userId, job.id, final, now)
      if (error) {
        result.errors.push(`${job.title}: ${error}`)
        return
      }
      result.checked++
      outcomes[status]++
      result.results.push({ id: job.id, status, note: final.note, last_verified_at: now.toISOString() })
      if (status !== job.verification_status) result.changed.push({ id: job.id, title: job.title, company: job.company_name, from: job.verification_status, to: status, note: final.note })
      opts.onProgress?.(`${job.company_name} / ${job.title}: ${job.verification_status} → ${status}`)
    } catch (e) {
      result.errors.push(`${job.title}: ${e instanceof Error ? e.message : String(e)}`)
    }
  })

  const closedIds = result.changed.filter((c) => c.to === 'CLOSED').map((c) => c.id)
  if (closedIds.length) {
    const closed = await markClosedApplications(userId, closedIds, store)
    result.applicationsClosed = closed.closed
    result.errors.push(...closed.errors)
  }
  return result
}

/** Tracked, not-yet-applied applications whose posting closed move to CLOSED. APPLIED and later are never touched. */
export async function markClosedApplications(
  userId: string,
  closedJobIds: string[],
  store: Pick<VerifyStore, 'applicationsForJobs' | 'transitionApplication'> = liveVerifyStore()
): Promise<{ closed: { application_id: string; job_id: string; from: ApplicationState }[]; errors: string[] }> {
  const closed: { application_id: string; job_id: string; from: ApplicationState }[] = []
  const errors: string[] = []
  const apps = await store.applicationsForJobs(userId, closedJobIds)
  for (const app of apps) {
    if (!PRE_APPLICATION_STATES.includes(app.state)) continue
    const r = await store.transitionApplication(userId, app.id, 'CLOSED', { actor: 'system', note: 'posting closed' })
    if (r.ok) closed.push({ application_id: app.id, job_id: app.job_id, from: app.state })
    else errors.push(`application ${app.id}: ${r.error ?? 'could not close'}`)
  }
  return { closed, errors }
}
