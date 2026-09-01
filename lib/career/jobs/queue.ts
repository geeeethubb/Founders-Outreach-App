// The queue: the handful of postings worth doing something about today.
//
// Discovery answers "what exists". The inbox answers "what is on-direction".
// Neither answers the question that actually ends in an application — WHICH ONE
// DO I DO NEXT — because that question is subtractive. A posting you dismissed,
// one the company closed, one you already applied to, and one the evaluator
// scored at 9% are all irrelevant to it, however interesting they are on a
// browsing screen.
//
// So this file ranks what is left and, just as importantly, COUNTS what it took
// away. A queue that silently narrows 312 postings to 6 is indistinguishable
// from a broken query; one that says "6 to do — 4 applied, 11 dismissed, 30
// closed, 22 below fit" can be trusted, and can be argued with.
//
// Pure: rows in, rows out. No database, and no clock either — `now` arrives in
// the options, so the same fixtures rank the same way on any day (see the note
// on `QueueOptions.now` for what happens when a caller omits it).

import { fitBand, type FitBand } from '../fit/dimensions'
import { APPLICATION_STATES, type ApplicationState, type Eligibility, type JobDisposition, type VerificationStatus } from '../types'
import { scoreRelevance, type InboxRelevance, type InboxRelevanceJob, type RelevanceContext } from './inbox-relevance'

// ─── The rule ────────────────────────────────────────────────────────────────
//
//   score = fit + freshness
//
// FIT LEADS, and by a wide margin. `fit_overall` is the Fit Evaluator's
// judgment against the whole evidence bank, recomputed from stored components
// under the mission's own weights (ADR-004). Nothing arithmetic in this file has
// any business overturning it.
//
// FRESHNESS IS A TIEBREAK, capped at +0.06 — under half the narrowest fit band
// (GOOD spans 0.62–0.75). It reorders two postings the evaluator scored within
// six points of each other, which is exactly the case where "and this one went
// up yesterday" is the deciding fact. It can never lift a MAYBE over a STRONG.
// Note what is deliberately NOT a term here: the deadline. `application_urgency`
// is already one of the ten fit dimensions, so a deadline term would count the
// same clock twice, in a file that is not allowed to outvote the evaluator.
//
// AN UNSCORED POSTING IS UNKNOWN, NOT BAD. Sorting nulls last is how the inbox
// used to bury half the inventory beneath roles already scored at 2%
// (lib/career/jobs/inbox-relevance.ts, `bestFirstKey`). Dropping them is worse
// still. So a row with no evaluation is ranked at a PRIOR just above the
// WEAK/MAYBE line: it outranks everything the evaluator actually read and
// rejected, and — by arithmetic, not by hope — it can never outrank a scored
// GOOD or STRONG job:
//
//   unscoredFloor + unscoredRelevanceSpan + freshnessMax
//     = 0.49 + 0.06 + 0.06 = 0.61  <  0.62, the GOOD floor in `fitBand`
//
// Where the caller supplies read-time relevance, it spreads unscored rows across
// that 0.06 span so the on-direction unknowns lead the off-direction ones. It is
// a separate scale from fit and is never mixed with one.

export const QUEUE_TERMS = {
  /** Where a posting with no fit evaluation starts: just above `fitBand`'s WEAK/MAYBE line. */
  unscoredFloor: 0.49,
  /** How far read-time relevance may move an unscored posting inside the prior. */
  unscoredRelevanceSpan: 0.06,
  /** The most freshness can ever be worth. Half the narrowest fit band, on purpose. */
  freshnessMax: 0.06,
  /** Freshness decays linearly to nothing across this window. */
  freshWindowDays: 30,
  /** The fit at or above which a SCORED posting stays in the queue — `fitBand`'s MAYBE floor. */
  minFit: 0.48,
} as const

/**
 * How sure we have to be that the posting is open, in the inbox's own
 * vocabulary. Kept in step with the `FRESHNESS` map in
 * app/api/career/jobs/route.ts by hand — a route must not be an import target
 * for lib code, and duplicating four literals beats inverting that dependency.
 */
const OPEN_STATUSES: Record<QueueFreshness, VerificationStatus[]> = {
  verified: ['VERIFIED_OPEN'],
  likely: ['VERIFIED_OPEN', 'LIKELY_OPEN'],
  open: ['VERIFIED_OPEN', 'LIKELY_OPEN', 'UNVERIFIED'],
}

export type QueueFreshness = 'verified' | 'likely' | 'open'

/** The first state that means "you already sent it". Everything from here on is history, not a to-do. */
const APPLIED_INDEX = APPLICATION_STATES.indexOf('APPLIED')

// ─── What the queue reads ────────────────────────────────────────────────────

/**
 * Every column the queue reads, and no invented ones: these are
 * `job_opportunities` columns from migration 014, plus the application state
 * that lives on the embedded `applications` row.
 *
 * Numbers arrive as `number | string` because `fit_overall` is a Postgres
 * `numeric`, and the route already coerces it defensively (`Number(overall)`);
 * a ranking that silently treats "0.81" as NaN would be a nasty way to find out.
 */
export interface QueueJob {
  id: string
  title: string
  company_name?: string | null
  verification_status?: VerificationStatus | string | null
  disposition?: JobDisposition | string | null
  fit_overall?: number | string | null
  fit_eligibility?: Eligibility | string | null
  posted_at?: string | null
  first_seen_at?: string | null

  /** As `JobCard` carries it (app/api/career/jobs/route.ts). */
  application_state?: ApplicationState | string | null
  /** As `JobListRow` carries it (lib/career/jobs/store.ts). Either shape answers "have I applied?". */
  applications?: { state?: string | null }[] | null

  /** Read-time relevance the caller already computed. Cheaper than recomputing, and guaranteed to agree with the screen. */
  relevance?: InboxRelevance | null

  // The rest are here only so `scoreRelevance` can run when a caller passes a
  // RelevanceContext instead of a precomputed band. Same columns the census reads.
  role_family?: string | null
  industry?: string | null
  skills?: string[] | null
  location_raw?: string | null
  location_tier?: number | null
  employment_type?: string | null
  season_relevance?: string | null
  extraction_version?: string | null
}

export interface QueueOptions {
  /**
   * The clock. The CALLER supplies it — `bestOpportunities(jobs, { now: new Date() })`.
   *
   * Omit it and freshness is switched off entirely: every `ageDays` is null,
   * every freshness bonus is 0, and the ranking is fit alone. That is the honest
   * degradation. A `new Date()` default would put a hidden clock inside a
   * function whose whole contract is that it is a pure function of its inputs.
   */
  now?: Date | string | number | null
  /** How sure we must be the posting is open. Default `open` — everything not known closed. */
  freshness?: QueueFreshness
  /** The fit below which a SCORED posting leaves the queue. Default `QUEUE_TERMS.minFit`. */
  minFit?: number
  /** Score direction-relevance here for rows that do not carry it. Null/omitted = no relevance signal. */
  relevanceContext?: RelevanceContext | null
}

/** Why a posting is where it is. Everything the UI needs to explain a position without recomputing it. */
export interface QueueRanking {
  /** 1-based position in `jobs`. */
  rank: number
  /** The number it was sorted by: `fitValue + freshness`. */
  score: number
  /** The evaluator's fit, or the prior a null was ranked at. */
  fitValue: number
  /** False when `fitValue` is the prior — the difference between "scored 55%" and "nobody has scored it". */
  scored: boolean
  /** Only ever set for a real evaluation; a prior has no band. */
  band: FitBand | null
  /** The freshness bonus actually applied, 0…`QUEUE_TERMS.freshnessMax`. */
  freshness: number
  /** Days since `posted_at` (else `first_seen_at`). Null when unknown or when no clock was supplied. */
  ageDays: number | null
  /** Which date `ageDays` was measured from, for the reason line. */
  ageBasis: 'posted' | 'first seen' | null
  relevance: InboxRelevance | null
  /** Short and human — what the queue would say under the title. */
  reasons: string[]
}

export type RankedJob<T extends QueueJob = QueueJob> = T & { ranking: QueueRanking }

/**
 * What the queue took away, one bucket per posting.
 *
 * `closed` means "not open by the standard you asked for": under the default
 * (`open`) that is CLOSED, STALE and ERROR; under `verified` it also covers the
 * postings nobody has re-checked since discovery.
 */
export interface QueueExclusions {
  closed: number
  dismissed: number
  applied: number
  lowFit: number
}

export interface QueueResult<T extends QueueJob = QueueJob> {
  jobs: RankedJob<T>[]
  excluded: QueueExclusions
}

// ─── Reading a row ───────────────────────────────────────────────────────────

/** Clamped 0–1, or null. A `numeric` may arrive as a string; anything unparseable is "unscored", never 0. */
export function fitValueOf(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.min(1, Math.max(0, n))
}

/** The most advanced application state on the row, whichever shape the caller carries it in. */
export function applicationStateOf(job: QueueJob): string | null {
  const states = [job.application_state, ...(job.applications ?? []).map((a) => a?.state)].filter(
    (s): s is string => typeof s === 'string' && s.length > 0
  )
  if (states.length === 0) return null
  return states.reduce((best, s) =>
    APPLICATION_STATES.indexOf(s as ApplicationState) > APPLICATION_STATES.indexOf(best as ApplicationState) ? s : best
  )
}

/**
 * Has this been sent? APPLIED and everything past it.
 *
 * READY_TO_APPLY deliberately stays in the queue — a package already built and
 * waiting is the most actionable row the founder owns, and hiding it would make
 * one-click generation produce work nobody is shown.
 */
export function alreadyApplied(state: string | null): boolean {
  if (!state) return false
  const i = APPLICATION_STATES.indexOf(state as ApplicationState)
  return i >= 0 && i >= APPLIED_INDEX
}

function millisOf(now: QueueOptions['now']): number | null {
  if (now === null || now === undefined) return null
  const t = now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.parse(now)
  return Number.isFinite(t) ? t : null
}

/**
 * How old the posting is, from the board's own date when it gave one and from
 * when we first saw it otherwise — a board that publishes no `posted_at` must
 * not look infinitely old, and `first_seen_at` is an honest lower bound on how
 * long the thing has been in front of the founder.
 *
 * A future-dated posting (bad board data) clamps to 0 days rather than earning
 * a bonus nothing else can reach.
 */
export function ageOf(job: QueueJob, nowMs: number | null): { days: number | null; basis: 'posted' | 'first seen' | null } {
  if (nowMs === null) return { days: null, basis: null }
  const candidates: [string | null | undefined, 'posted' | 'first seen'][] = [
    [job.posted_at, 'posted'],
    [job.first_seen_at, 'first seen'],
  ]
  for (const [raw, basis] of candidates) {
    if (!raw) continue
    const t = Date.parse(raw)
    if (!Number.isFinite(t)) continue
    return { days: Math.max(0, (nowMs - t) / 86_400_000), basis }
  }
  return { days: null, basis: null }
}

/** Linear decay to nothing across the window. Unknown age earns nothing — unknown is not fresh. */
export function freshnessBonus(ageDays: number | null): number {
  if (ageDays === null) return 0
  const remaining = 1 - ageDays / QUEUE_TERMS.freshWindowDays
  return QUEUE_TERMS.freshnessMax * Math.min(1, Math.max(0, remaining))
}

function relevanceOf(job: QueueJob, ctx: RelevanceContext | null): InboxRelevance | null {
  if (job.relevance) return job.relevance
  if (!ctx) return null
  // Built explicitly rather than spread: `InboxRelevanceJob` deliberately cannot
  // see `company_name` or `description_text`, and the queue must not be the path
  // that smuggles them in — see the type's own note.
  const input: InboxRelevanceJob = {
    title: job.title,
    location_raw: job.location_raw ?? null,
    location_tier: job.location_tier ?? null,
    role_family: job.role_family ?? null,
    industry: job.industry ?? null,
    skills: job.skills ?? null,
    employment_type: job.employment_type ?? null,
    season_relevance: job.season_relevance ?? null,
    extraction_version: job.extraction_version ?? null,
    fit_overall: fitValueOf(job.fit_overall),
  }
  return scoreRelevance(input, ctx)
}

const pct = (n: number) => `${Math.round(n * 100)}%`

function reasonsFor(r: Omit<QueueRanking, 'rank' | 'reasons'>, job: QueueJob): string[] {
  const out: string[] = []
  if (r.scored && r.band) out.push(`fit ${pct(r.fitValue)} — ${r.band.toLowerCase()}`)
  else out.push('no fit evaluation yet — ranked as a maybe, not as a no')
  if (r.ageDays !== null && r.ageBasis) {
    const d = Math.round(r.ageDays)
    out.push(d === 0 ? `${r.ageBasis} today` : `${r.ageBasis} ${d} day${d === 1 ? '' : 's'} ago`)
  }
  // Eligibility is a flag, not a rank input (docs/CAREER_OS.md §6): a posting the
  // founder may not be eligible for is SHOWN and labelled, never demoted.
  if (job.fit_eligibility === 'NOT_QUALIFIED') out.push('not qualified on the stated requirements — read it before spending a package')
  else if (job.fit_eligibility === 'STRETCH') out.push('a stretch')
  if (job.verification_status === 'UNVERIFIED') out.push('not re-checked since discovery')
  return out
}

// ─── The queue ───────────────────────────────────────────────────────────────

/**
 * The postings worth acting on, best first, with a count of everything removed.
 *
 * Exclusion is a PARTITION: every removed posting increments exactly one
 * counter, so the returned `jobs.length` plus the four counts always equals the
 * number of rows handed in, and the founder-facing sentence cannot overclaim.
 * Where a posting qualifies for two buckets the precedence is who decided —
 * you (applied, then dismissed), then the world (closed), then the model
 * (lowFit) — because "you already applied" explains a missing row better than
 * "the posting later closed".
 */
export function bestOpportunities<T extends QueueJob>(jobs: T[], opts: QueueOptions = {}): QueueResult<T> {
  const nowMs = millisOf(opts.now)
  const open = OPEN_STATUSES[opts.freshness ?? 'open']
  const minFit = typeof opts.minFit === 'number' && Number.isFinite(opts.minFit) ? opts.minFit : QUEUE_TERMS.minFit
  const ctx = opts.relevanceContext ?? null

  const excluded: QueueExclusions = { closed: 0, dismissed: 0, applied: 0, lowFit: 0 }
  const kept: { job: T; ranking: Omit<QueueRanking, 'rank'>; index: number }[] = []

  jobs.forEach((job, index) => {
    if (alreadyApplied(applicationStateOf(job))) return void excluded.applied++
    if (job.disposition === 'dismissed') return void excluded.dismissed++
    if (!open.includes((job.verification_status ?? 'UNVERIFIED') as VerificationStatus)) return void excluded.closed++

    const fit = fitValueOf(job.fit_overall)
    if (fit !== null && fit < minFit) return void excluded.lowFit++

    const relevance = relevanceOf(job, ctx)
    const { days, basis } = ageOf(job, nowMs)
    const freshness = freshnessBonus(days)
    // An unscored row sits inside the prior, positioned by relevance where there
    // is any. The span is small enough that the whole prior — plus the largest
    // possible freshness bonus — stays under the GOOD floor.
    const fitValue = fit ?? QUEUE_TERMS.unscoredFloor + QUEUE_TERMS.unscoredRelevanceSpan * (relevance?.score ?? 0)
    const base: Omit<QueueRanking, 'rank' | 'reasons'> = {
      score: fitValue + freshness,
      fitValue,
      scored: fit !== null,
      band: fit === null ? null : fitBand(fit),
      freshness,
      ageDays: days,
      ageBasis: basis,
      relevance,
    }
    kept.push({ job, index, ranking: { ...base, reasons: reasonsFor(base, job) } })
  })

  // Stable and total: score, then direction relevance, then the newer posting,
  // then input order. Two identical rows always come back in the order given.
  const AGE_LAST = Number.MAX_SAFE_INTEGER
  kept.sort(
    (a, b) =>
      b.ranking.score - a.ranking.score ||
      (b.ranking.relevance?.score ?? 0) - (a.ranking.relevance?.score ?? 0) ||
      (a.ranking.ageDays ?? AGE_LAST) - (b.ranking.ageDays ?? AGE_LAST) ||
      a.index - b.index
  )

  return {
    jobs: kept.map((k, i) => ({ ...k.job, ranking: { ...k.ranking, rank: i + 1 } })),
    excluded,
  }
}

/**
 * "6 to do — 4 applied, 11 dismissed, 30 closed, 22 below fit."
 *
 * The same promise `relevanceHeadline` makes one screen over: the sentence
 * always names what is missing and why, so a short queue reads as a decision
 * rather than as a bug.
 */
export function queueHeadline(result: QueueResult): string {
  const head = `${result.jobs.length} to do`
  const parts: string[] = []
  const { applied, dismissed, closed, lowFit } = result.excluded
  if (applied) parts.push(`${applied} applied`)
  if (dismissed) parts.push(`${dismissed} dismissed`)
  if (closed) parts.push(`${closed} closed`)
  if (lowFit) parts.push(`${lowFit} below fit`)
  return parts.length ? `${head} — ${parts.join(', ')}` : head
}
