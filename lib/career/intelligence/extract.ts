// Extraction backfill for jobs that were persisted before the extractor ran.
//
// The scout persists everything it found even when its deadline arrives before
// extraction — the first live CLI run stored 17 VERIFIED_OPEN rows and
// extracted none of them. Without this, such a row would never gain its
// qualifications, eligibility window or work-authorization text, and the fit
// evaluator and the tailor would work from a description excerpt alone.
//
// The merge goes through buildNormalizedJob so the SAME rules apply as in the
// scout: an extraction overrides heuristics only where it is more specific,
// and a title naming another season still wins.

import { runJobExtractor, jobExtractorPrompt } from '@/lib/agents/job-extractor'
import type { ToolContext } from '@/lib/agents/runtime/types'
import { createServiceClient } from '@/lib/supabase/server'
import { buildNormalizedJob } from '../jobs/normalize'
import type { RawJobPosting } from '../sources/types'
import type { CareerMission, JobOpportunity, JobSourceType } from '../types'
import type { CareerRun } from '../runs'

const MIN_TEXT = 200

/** Columns the backfill may write. Everything else on the row is the scout's. */
const BACKFILL_COLUMNS = [
  'employment_type', 'season_relevance', 'work_mode', 'role_family',
  'location_city', 'location_state', 'location_country', 'location_tier',
  'deadline', 'compensation', 'min_qualifications', 'preferred_qualifications', 'graduation_eligibility',
  'work_authorization', 'skills', 'responsibilities', 'industry', 'extraction_version', 'extraction_confidence',
] as const

export function needsExtraction(job: Pick<JobOpportunity, 'extraction_confidence' | 'description_text'>): boolean {
  return job.extraction_confidence == null && (job.description_text ?? '').length >= MIN_TEXT
}

/** A stored row, viewed as the posting it came from, so normalize.ts can re-run. */
function rawFromJob(job: JobOpportunity): RawJobPosting {
  const sourceType: JobSourceType =
    job.ats_type && ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable'].includes(job.ats_type)
      ? (job.ats_type as JobSourceType)
      : job.canonical_url
        ? 'careers_page'
        : 'manual'
  return {
    source_type: sourceType,
    source_url: job.canonical_url ?? job.apply_url ?? '',
    external_id: job.ats_job_id,
    company_name: job.company_name,
    company_domain: null,
    title: job.title,
    location_raw: job.location_raw,
    description_text: job.description_text,
    description_html: job.description_html,
    department: null,
    posted_at: job.posted_at,
    updated_at: job.source_updated_at,
    apply_url: job.apply_url,
    canonical_url: job.canonical_url,
    ats_type: job.ats_type as RawJobPosting['ats_type'],
    ats_job_id: job.ats_job_id,
    requisition_id: job.requisition_id,
    employment_type_hint: null,
    raw: {},
    retrieved_at: job.last_seen_at,
  }
}

export interface EnsureExtractedResult {
  job: JobOpportunity
  extracted: boolean
  closedByText: boolean
  costUsd: number
  error: string | null
}

export async function ensureExtracted(params: {
  userId: string
  job: JobOpportunity
  mission: Pick<CareerMission, 'preferences'>
  ctx: ToolContext
  run?: Pick<CareerRun, 'trace'> | null
  /** In-memory only — no write. */
  noDb?: boolean
}): Promise<EnsureExtractedResult> {
  const { job } = params
  if (!needsExtraction(job)) return { job, extracted: false, closedByText: false, costUsd: 0, error: null }

  const res = await runJobExtractor(
    {
      title: job.title,
      company: job.company_name,
      location_raw: job.location_raw,
      text: job.description_text ?? '',
      source_hint: job.ats_type ?? null,
    },
    params.ctx
  )
  if (params.run) await params.run.trace(res as never, { job_id: job.id, stage: 'extraction_backfill' })
  if (!res.output) return { job, extracted: false, closedByText: false, costUsd: res.trace.cost_usd, error: `extractor ${res.status}: ${res.error ?? 'no output'}` }

  const normalized = buildNormalizedJob(rawFromJob(job), res.output, { geo_tiers: params.mission.preferences.geo_tiers })
  const patch: Record<string, unknown> = {}
  for (const col of BACKFILL_COLUMNS) patch[col] = (normalized as unknown as Record<string, unknown>)[col] ?? null
  patch.extraction_version = jobExtractorPrompt.version
  patch.extraction_confidence = res.output.confidence
  const closedByText = res.output.appears_closed === true
  if (closedByText) {
    patch.verification_status = 'CLOSED'
    patch.verification_note = 'the posting text says the role is closed or filled'
    patch.verification_method = 'extractor'
    patch.last_verified_at = new Date().toISOString()
  }

  const updated = { ...job, ...patch } as JobOpportunity
  if (params.noDb) return { job: updated, extracted: true, closedByText, costUsd: res.trace.cost_usd, error: null }

  const supabase = createServiceClient()
  const { error } = await supabase.from('job_opportunities').update(patch as never).eq('id', job.id).eq('user_id', params.userId)
  return { job: updated, extracted: true, closedByText, costUsd: res.trace.cost_usd, error: error ? `extraction backfill write: ${error.message}` : null }
}
