// Raw postings → normalized jobs, with the Job Extractor where the text earns
// it and the mission's hard constraints applied by code afterwards.
//
// Extraction is the one per-posting model call in discovery, so it is
// rationed: internship-looking titles first, then season hints, then the
// longest descriptions, and only postings with enough text to extract from.
// The rest are normalized heuristically — a missing extraction is a thinner
// row, not a dropped job. Rejections carry the constraint's label so the run
// can say WHICH rule excluded what.

import { mapWithConcurrency } from '@/lib/scouting/concurrency'
import { jobExtractorPrompt, runJobExtractor, type JobExtraction } from '@/lib/agents/job-extractor'
import type { AgentResult, ToolContext } from '@/lib/agents/runtime/types'
import type { CareerMission, ExtractedJobFields } from '../types'
import { evaluateConstraint, isInternshipLike } from '../jobs/filters'
import { buildNormalizedJob, type NormalizedJob } from '../jobs/normalize'
import { internshipLike } from '../sources/fetch'
import type { RawJobPosting } from '../sources/types'
import type { CareerRun } from '../runs'
import { bump, type ScoutStats } from './stats'

export const MIN_EXTRACT_CHARS = 200

export type ExtractorFn = (input: Parameters<typeof runJobExtractor>[0], ctx: ToolContext) => Promise<AgentResult<JobExtraction>>

export interface ExtractOptions {
  mission: Pick<CareerMission, 'hard_constraints' | 'preferences'>
  ctx: ToolContext
  run?: Pick<CareerRun, 'trace'> | null
  maxExtract?: number
  concurrency?: number
  /** Unix ms; extraction stops starting new calls past it. */
  deadline?: number
  stats?: ScoutStats
  extractor?: ExtractorFn
  onProgress?: (detail: string) => void
}

export interface RejectedJob {
  reason: string
  title: string
  company: string
  detail: string
}

export interface ExtractResult {
  jobs: NormalizedJob[]
  rejected: RejectedJob[]
  extracted: number
  extractionCost: number
  errors: string[]
  deadlineHit: boolean
}

function seasonHinted(raw: RawJobPosting): boolean {
  return /\b(summer|20\d\d)\b/i.test(`${raw.title} ${raw.employment_type_hint ?? ''}`)
}

/** Extraction priority: internship-like titles, then season hints, then the most text. */
export function orderForExtraction(raws: RawJobPosting[]): RawJobPosting[] {
  const score = (r: RawJobPosting) =>
    (internshipLike(r.title, r.employment_type_hint) ? 2_000_000 : 0) + (seasonHinted(r) ? 1_000_000 : 0) + Math.min(999_999, (r.description_text ?? '').length)
  return [...raws].sort((a, b) => score(b) - score(a))
}

/**
 * Constraint failures the pipeline deliberately forgives at discovery time:
 * an unspecified season is not a different season, and an internship-titled
 * posting whose type the heuristics could not classify is still an internship.
 */
export function constraintRejections(job: NormalizedJob, constraints: CareerMission['hard_constraints']): { label: string; reason: string }[] {
  const out: { label: string; reason: string }[] = []
  for (const c of constraints) {
    const r = evaluateConstraint(job, c)
    if (r.pass) continue
    const dim = c.dimension
    if ((dim === 'season' || dim === 'season_relevance') && (job.season_relevance === 'unspecified' || job.season_relevance === 'unknown')) continue
    if (dim === 'employment_type' && job.employment_type === 'unknown' && isInternshipLike(job)) continue
    out.push({ label: c.label, reason: r.reason })
  }
  return out
}

export async function extractAndNormalize(raws: RawJobPosting[], opts: ExtractOptions): Promise<ExtractResult> {
  const extractor = opts.extractor ?? runJobExtractor
  const maxExtract = opts.maxExtract ?? 40
  const ordered = orderForExtraction(raws)
  const extractable = ordered.filter((r) => (r.description_text ?? '').length >= MIN_EXTRACT_CHARS).slice(0, maxExtract)
  const extractions = new Map<RawJobPosting, ExtractedJobFields | null>()
  const errors: string[] = []
  let extractionCost = 0
  let deadlineHit = false

  await mapWithConcurrency(extractable, opts.concurrency ?? 4, async (raw) => {
    if (opts.deadline && Date.now() > opts.deadline) {
      deadlineHit = true
      return
    }
    try {
      const res = await extractor(
        { title: raw.title, company: raw.company_name, location_raw: raw.location_raw, text: raw.description_text ?? '', source_hint: raw.employment_type_hint },
        opts.ctx
      )
      extractionCost += res.trace.cost_usd
      if (opts.stats) opts.stats.model_calls++
      await opts.run?.trace(res, { title: raw.title, company: raw.company_name, source_url: raw.source_url })
      if (res.output) extractions.set(raw, res.output)
      else errors.push(`extract ${raw.company_name} / ${raw.title}: ${res.error ?? res.status}`)
      opts.onProgress?.(`${raw.company_name} / ${raw.title}: ${res.output ? 'extracted' : `failed (${res.status})`}`)
    } catch (e) {
      errors.push(`extract ${raw.company_name} / ${raw.title}: ${e instanceof Error ? e.message : String(e)}`)
    }
  })

  const jobs: NormalizedJob[] = []
  const rejected: RejectedJob[] = []
  for (const raw of ordered) {
    const extraction = extractions.get(raw) ?? null
    const job = buildNormalizedJob(raw, extraction, { geo_tiers: opts.mission.preferences.geo_tiers })
    if (extraction) job.extraction_version = jobExtractorPrompt.version
    if (job.sources.every((s) => s.source_type === 'aggregator')) {
      // buildNormalizedJob falls back to source_url; a lead we never followed
      // must not claim the aggregator page as its canonical posting.
      job.canonical_url = null
      job.apply_url = null
    }
    if (job.verification_status === 'CLOSED') {
      rejected.push({ reason: 'appears_closed', title: job.title, company: job.company_name, detail: job.verification_note ?? 'closed' })
      opts.stats && bump(opts.stats.jobs_rejected, 'appears_closed')
      continue
    }
    const failures = constraintRejections(job, opts.mission.hard_constraints)
    if (failures.length) {
      for (const f of failures) opts.stats && bump(opts.stats.jobs_rejected, f.label)
      rejected.push({ reason: failures.map((f) => f.label).join(' + '), title: job.title, company: job.company_name, detail: failures.map((f) => f.reason).join('; ') })
      continue
    }
    jobs.push(job)
  }
  if (opts.stats) opts.stats.jobs_extracted += extractions.size
  return { jobs, rejected, extracted: extractions.size, extractionCost, errors, deadlineHit }
}
