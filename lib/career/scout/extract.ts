// Raw postings → normalized jobs, with the Job Extractor where the text earns
// it and the mission's hard constraints applied by code afterwards.
//
// Extraction is the one per-posting model call in discovery, so it is
// rationed: internship-looking titles first, then season hints, then the
// longest descriptions, and only postings with enough text to extract from.
// The rest are normalized heuristically — a missing extraction is a thinner
// row, not a dropped job. Rejections carry the constraint's label so the run
// can say WHICH rule excluded what.
//
// Two entry points, and the difference between them is the whole point:
//
//   extractAndNormalize  in-flight: raw postings a stage just gathered, some
//                        extracted (up to the run's budget), ALL normalized and
//                        returned for storage.
//   extractPending       after the fact: rows already STORED without an
//                        extraction, ranked by deterministic relevance and
//                        filled in, bounded by its own budget.
//
// The second exists because inventory and extraction must not be the same
// number. A sweep lists hundreds of postings for free and stores them thin;
// this spends dozens of model calls on the best of them, whenever the founder
// (or the cron) is willing to pay for it.

import { mapWithConcurrency } from '@/lib/scouting/concurrency'
import { jobExtractorPrompt, runJobExtractor, type JobExtraction } from '@/lib/agents/job-extractor'
import type { AgentResult, ToolContext } from '@/lib/agents/runtime/types'
import { isClockOutcome } from '@/lib/runs/errors'
import type { CareerMission, ExtractedJobFields } from '../types'
import { evaluateConstraint, isInternshipLike } from '../jobs/filters'
import { buildNormalizedJob, type NormalizeOptions, type NormalizedJob } from '../jobs/normalize'
import { byRelevance, extractionPatch, jobRelevance } from '../jobs/relevance'
import type { ExtractionCandidate } from '../jobs/extraction-store'
import { applyExtraction, listExtractionCandidates, loadJobTexts } from '../jobs/extraction-store'
import { internshipLike } from '../sources/fetch'
import type { RawJobPosting } from '../sources/types'
import type { CareerRun } from '../runs'
import { directionTerms } from './direction'
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
  let unreadByClock = 0

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
      else if (isClockOutcome(res)) {
        // The run's clock, not the posting: it stays stored thin, and the
        // next pass reads it. Counted once below, never as a per-posting error.
        deadlineHit = true
        unreadByClock++
      } else errors.push(`extract ${raw.company_name} / ${raw.title}: ${res.error ?? res.status}`)
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
  if (unreadByClock > 0) errors.push(`extraction: ${unreadByClock} posting(s) not read before the run's clock ran out — stored thin, read on the next pass`)
  return { jobs, rejected, extracted: extractions.size, extractionCost, errors, deadlineHit }
}

// ─── Deferred extraction ─────────────────────────────────────────────────────

/** The database surface a deferred pass needs. Injectable so the test runs in memory. */
export interface PendingExtractionStore {
  listExtractionCandidates(
    userId: string,
    opts: { limit?: number; order?: 'recent' | 'oldest'; includeExtracted?: boolean }
  ): Promise<{ rows: ExtractionCandidate[]; error: string | null; migrationMissing: boolean }>
  loadJobTexts(userId: string, ids: string[]): Promise<{ texts: Map<string, string | null>; error: string | null }>
  applyExtraction(userId: string, id: string, patch: Record<string, unknown>): Promise<{ error: string | null; migrationMissing: boolean }>
}

export function livePendingExtractionStore(): PendingExtractionStore {
  return {
    listExtractionCandidates: (userId, opts) => listExtractionCandidates(userId, opts),
    loadJobTexts: (userId, ids) => loadJobTexts(userId, ids),
    applyExtraction: (userId, id, patch) => applyExtraction(userId, id, patch),
  }
}

/** How many extractions one deferred pass runs when the caller does not say. */
export const DEFAULT_PENDING_EXTRACT_LIMIT = 25
/** Rows ranked per selected row, so a pool of too-short rows cannot starve the pass. */
export const PENDING_POOL_FACTOR = 8

export interface ExtractPendingOptions {
  /** Extractions to run. This is the money; nothing else here costs anything. */
  limit?: number
  /**
   * 'relevance' (default) spends the budget on the best rows in the pool.
   * 'recent'/'oldest' take the pool in store order — for a backfill that must
   * terminate rather than one that must be selective.
   */
  order?: 'relevance' | 'recent' | 'oldest'
  /** The stated direction, so "speaks the language of what I'm looking for" counts. */
  direction?: string | null
  /** Geo tiers, used only when an extraction CHANGES the location. */
  mission?: NormalizeOptions
  ctx: ToolContext
  run?: Pick<CareerRun, 'trace'> | null
  concurrency?: number
  /** Unix ms; no new extraction starts past it. Everything already written stays written. */
  deadline?: number
  stats?: ScoutStats
  extractor?: ExtractorFn
  store?: PendingExtractionStore
  /** Rows to rank. Defaults to limit × PENDING_POOL_FACTOR, capped by the store. */
  poolLimit?: number
  onProgress?: (detail: string) => void
}

export interface ExtractPendingRow {
  id: string
  title: string
  company_name: string
  relevance: number
  outcome: 'extracted' | 'failed' | 'too_short'
}

export interface ExtractPendingResult {
  /** Rows in the pool that were eligible at all. */
  candidates: number
  /** Rows this pass chose to spend an extraction on. */
  selected: number
  extracted: number
  failed: number
  /** Shortlisted rows whose text turned out to be too thin to extract from. */
  tooShort: number
  costUsd: number
  errors: string[]
  deadlineHit: boolean
  migrationMissing: boolean
  rows: ExtractPendingRow[]
}

const EMPTY_PENDING: ExtractPendingResult = {
  candidates: 0, selected: 0, extracted: 0, failed: 0, tooShort: 0, costUsd: 0, errors: [], deadlineHit: false, migrationMissing: false, rows: [],
}

/**
 * Fill in the highest-relevance rows that were stored WITHOUT an extraction.
 *
 * The order of operations is what keeps it cheap: rank on the columns the pool
 * query already returned (no descriptions), then load the text for the chosen
 * few, then extract. A pool of five hundred rows costs one query; the model
 * only ever sees `limit` of them.
 *
 * Each row is written the moment it is extracted, so a pass that hits its
 * deadline keeps everything it paid for — the same rule the scout's batch tail
 * follows.
 */
export async function extractPending(userId: string, opts: ExtractPendingOptions): Promise<ExtractPendingResult> {
  const store = opts.store ?? livePendingExtractionStore()
  const extractor = opts.extractor ?? runJobExtractor
  const limit = Math.max(0, Math.floor(opts.limit ?? DEFAULT_PENDING_EXTRACT_LIMIT))
  if (limit === 0) return { ...EMPTY_PENDING }
  const order = opts.order ?? 'relevance'
  const errors: string[] = []

  const pool = await store.listExtractionCandidates(userId, {
    limit: opts.poolLimit ?? limit * PENDING_POOL_FACTOR,
    order: order === 'oldest' ? 'oldest' : 'recent',
  })
  if (pool.migrationMissing) return { ...EMPTY_PENDING, migrationMissing: true, errors: [pool.error ?? 'migration missing'] }
  if (pool.error) errors.push(`extraction candidates: ${pool.error}`)
  if (pool.rows.length === 0) return { ...EMPTY_PENDING, errors }

  const terms = directionTerms(opts.direction)
  const ranked = order === 'relevance' ? byRelevance(pool.rows, terms) : pool.rows
  // Over-select: some shortlisted rows will turn out to have too little text,
  // and a pass that discovered that after committing its budget would
  // under-spend it.
  const shortlist = ranked.slice(0, Math.min(ranked.length, limit * 2))
  const loaded = await store.loadJobTexts(userId, shortlist.map((r) => r.id))
  if (loaded.error) errors.push(`job texts: ${loaded.error}`)

  const rows: ExtractPendingRow[] = []
  const chosen: { row: ExtractionCandidate; text: string; relevance: number }[] = []
  let tooShort = 0
  for (const row of shortlist) {
    if (chosen.length >= limit) break
    const relevance = jobRelevance(row, terms)
    const text = loaded.texts.get(row.id) ?? ''
    if (text.length < MIN_EXTRACT_CHARS) {
      tooShort++
      rows.push({ id: row.id, title: row.title, company_name: row.company_name, relevance, outcome: 'too_short' })
      continue
    }
    chosen.push({ row, text, relevance })
  }

  let costUsd = 0
  let extracted = 0
  let failed = 0
  let deadlineHit = false

  await mapWithConcurrency(chosen, opts.concurrency ?? 4, async ({ row, text, relevance }) => {
    if (opts.deadline && Date.now() > opts.deadline) {
      deadlineHit = true
      return
    }
    const label = { id: row.id, title: row.title, company_name: row.company_name, relevance }
    try {
      const res = await extractor(
        { title: row.title, company: row.company_name, location_raw: row.location_raw, text, source_hint: null },
        opts.ctx
      )
      costUsd += res.trace.cost_usd
      if (opts.stats) opts.stats.model_calls++
      await opts.run?.trace(res, { job_id: row.id, title: row.title, company: row.company_name })
      if (!res.output) {
        failed++
        if (isClockOutcome(res)) deadlineHit = true
        else errors.push(`extract ${row.company_name} / ${row.title}: ${res.error ?? res.status}`)
        rows.push({ ...label, outcome: 'failed' })
        return
      }
      const patch = extractionPatch(row, res.output, jobExtractorPrompt.version, opts.mission)
      const w = await store.applyExtraction(userId, row.id, patch)
      if (w.error) {
        failed++
        errors.push(`write ${row.title}: ${w.error}`)
        rows.push({ ...label, outcome: 'failed' })
        return
      }
      extracted++
      if (opts.stats) opts.stats.jobs_extracted++
      rows.push({ ...label, outcome: 'extracted' })
      opts.onProgress?.(`${row.company_name} / ${row.title}: extracted (relevance ${relevance})`)
    } catch (e) {
      failed++
      errors.push(`extract ${row.company_name} / ${row.title}: ${e instanceof Error ? e.message : String(e)}`)
      rows.push({ ...label, outcome: 'failed' })
    }
  })

  return {
    candidates: pool.rows.length,
    selected: chosen.length,
    extracted,
    failed,
    tooShort,
    costUsd: Number(costUsd.toFixed(4)),
    errors,
    deadlineHit,
    migrationMissing: false,
    rows,
  }
}
