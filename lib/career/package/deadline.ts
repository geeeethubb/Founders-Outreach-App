// One clock for the whole of package generation.
//
// WHY THIS EXISTS. A Rondo Energy package sat at `status='generating'`,
// `stage='intelligence'`, `cost_usd=$0` for over a day. Nothing was looping: the
// process that owned it died, and nothing else in the system had any opinion
// about that. `DEFAULT_PACKAGE_BUDGET.deadlineMs` was already 280 s, but only
// the scout orchestrator ever read it — the single-job package path never did.
// So generation had no deadline, and the worst case was five serial agents at
// eight steps and 120 s per step: roughly eighty minutes before anything would
// even consider stopping.
//
// The rule this module enforces: THE APPLICATION DECIDES WHEN TO STOP, and it
// decides from one absolute instant fixed at the start. Not a per-stage timer —
// five stages with five-minute timeouts is a twenty-five-minute pipeline.
//
// Every stage asks `remaining()`. A stage that cannot fit in what is left is
// SKIPPED, not attempted and abandoned: research is enrichment, and a mediocre
// package in four minutes beats a perfect one that never arrives.

/** The hard end-to-end SLA. Nothing may push a package past this. */
export const GENERATION_DEADLINE_MS = 5 * 60 * 1000

/**
 * Stop starting optional work with less than this left, and go finalise.
 * Finalisation is document rendering plus database writes; if it does not get
 * its slice, the deadline is met by producing nothing, which is the one outcome
 * worse than a shallow package.
 */
export const FINALIZE_RESERVE_MS = 45 * 1000

/**
 * Per-stage ceilings, as a share of the whole. These BOUND a stage; they do not
 * entitle it — a stage still stops early when the absolute deadline is nearer
 * than its own share. Ordered as the pipeline runs them.
 *
 * The shares are deliberately smaller than the wall they add up to: research is
 * the least essential and the most likely to hang, so it gets a hard ceiling
 * well under what would be "fair", and tailoring — the part that produces the
 * thing the founder actually submits — gets the largest slice.
 */
export const STAGE_BUDGET_MS = {
  /** Load the job, the mission and the evidence bank. */
  initialize: 15_000,
  /** Extraction + company research. Enrichment; the first thing to be cut. */
  research: 105_000,
  /** Fit evaluation, evidence matching, warm paths. */
  analysis: 40_000,
  /** The tailor and one verifier call per changed bullet. */
  tailoring: 95_000,
  /** Document render, cover letter, QA, persistence. */
  finalize: 45_000,
} as const

export type GenerationStage = keyof typeof STAGE_BUDGET_MS

export interface DeadlineOptions {
  /** Total budget. Tests pass a few seconds to exercise the timeout paths. */
  totalMs?: number
  /** Injected clock. Tests pass a fake; production passes nothing. */
  now?: () => number
  /** Reserve kept for finalisation. */
  reserveMs?: number
}

/**
 * The shared clock. Constructed once per generation and threaded down; every
 * expensive operation asks it how much time is left rather than assuming.
 */
export class GenerationDeadline {
  readonly startedAt: number
  readonly totalMs: number
  readonly deadlineAt: number
  readonly reserveMs: number
  private readonly clock: () => number

  constructor(opts: DeadlineOptions = {}) {
    this.clock = opts.now ?? (() => Date.now())
    this.totalMs = opts.totalMs ?? GENERATION_DEADLINE_MS
    this.reserveMs = Math.min(opts.reserveMs ?? FINALIZE_RESERVE_MS, Math.floor(this.totalMs / 2))
    this.startedAt = this.clock()
    this.deadlineAt = this.startedAt + this.totalMs
  }

  now(): number {
    return this.clock()
  }

  elapsedMs(): number {
    return this.clock() - this.startedAt
  }

  /** Milliseconds until the hard deadline. Never negative. */
  remainingMs(): number {
    return Math.max(0, this.deadlineAt - this.clock())
  }

  /** The hard deadline has passed. Finalise now, whatever state things are in. */
  expired(): boolean {
    return this.remainingMs() <= 0
  }

  /**
   * Time left for work that is not finalisation. Once this hits zero the
   * pipeline stops starting optional stages even though the wall is not yet up.
   */
  remainingBeforeReserveMs(): number {
    return Math.max(0, this.remainingMs() - this.reserveMs)
  }

  /**
   * How long a stage may take: the smaller of its own ceiling and what is
   * actually left, minus the finalisation reserve for non-final stages.
   */
  budgetFor(stage: GenerationStage): number {
    const ceiling = STAGE_BUDGET_MS[stage]
    const available = stage === 'finalize' ? this.remainingMs() : this.remainingBeforeReserveMs()
    return Math.max(0, Math.min(ceiling, available))
  }

  /**
   * Is there enough time to be worth STARTING this stage? A stage begun with
   * two seconds left spends money and produces nothing usable.
   *
   * `minimumMs` is what the caller says it needs to be useful — a research
   * stage that cannot finish one search should not make the request at all.
   */
  canStart(stage: GenerationStage, minimumMs = 5_000): boolean {
    return this.budgetFor(stage) >= minimumMs
  }

  /** For logs and the `metrics` column. */
  snapshot(): { startedAt: number; deadlineAt: number; elapsedMs: number; remainingMs: number } {
    return { startedAt: this.startedAt, deadlineAt: this.deadlineAt, elapsedMs: this.elapsedMs(), remainingMs: this.remainingMs() }
  }
}

// ─── Bounding one operation ──────────────────────────────────────────────────

export class DeadlineExceededError extends Error {
  readonly stage: string
  readonly waitedMs: number
  constructor(stage: string, waitedMs: number) {
    super(`${stage} exceeded its ${Math.round(waitedMs / 1000)}s budget`)
    this.name = 'DeadlineExceededError'
    this.stage = stage
    this.waitedMs = waitedMs
  }
}

/**
 * Run `fn` with a hard ceiling, and hand it an AbortSignal so a well-behaved
 * caller can stop early.
 *
 * The honest caveat, stated because it decides the whole design: this bounds
 * how long the PIPELINE waits, not how long `fn` keeps running. A promise that
 * never settles is not cancellable in JavaScript, and an `await` cannot be
 * abandoned. That is exactly why the deadline is enforced at every level
 * INCLUDING the database row — the reaper is what makes the guarantee true when
 * the process itself is the thing that is stuck.
 *
 * `onTimeout` decides the shape of the failure: research passes a fallback so a
 * dead search degrades to "no research"; tailoring passes none, so a timeout
 * propagates and the package finalises without a patch rather than silently
 * shipping the master as if it had been tailored.
 */
export async function withDeadline<T>(
  stage: string,
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>,
  opts: { onTimeout?: () => T } = {}
): Promise<T> {
  if (ms <= 0) {
    if (opts.onTimeout) return opts.onTimeout()
    throw new DeadlineExceededError(stage, 0)
  }
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new DeadlineExceededError(stage, ms))
    }, ms)
  })
  try {
    return await Promise.race([fn(controller.signal), timeout])
  } catch (e) {
    if (e instanceof DeadlineExceededError && opts.onTimeout) return opts.onTimeout()
    throw e
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * `withDeadline` that returns a result instead of throwing — for optional work,
 * where "it took too long" is an answer rather than an error.
 */
export async function tryWithDeadline<T>(
  stage: string,
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; timedOut: boolean; error: string }> {
  try {
    return { ok: true, value: await withDeadline(stage, ms, fn) }
  } catch (e) {
    if (e instanceof DeadlineExceededError) return { ok: false, timedOut: true, error: e.message }
    return { ok: false, timedOut: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ─── Retries, bounded by the same clock ──────────────────────────────────────

/** One retry is the default. A second attempt that starts too late is not a retry, it is a hang. */
export const MAX_ATTEMPTS = 2

/**
 * Never retry OPTIONAL work with less than this left. Distinct from "does
 * another attempt fit": a second research call technically fits in twenty
 * seconds, and spending them on enrichment rather than on producing the
 * document is still the wrong trade. Required work uses the fit test alone.
 */
export const OPTIONAL_RETRY_FLOOR_MS = 60_000

/**
 * Retry `fn` at most `attempts` times, and only while the deadline leaves room
 * for another attempt to finish. Without the second condition a retry policy
 * becomes a way to blow through the budget politely.
 */
export async function retryWithin<T>(
  stage: string,
  deadline: GenerationDeadline,
  perAttemptMs: number,
  fn: (signal: AbortSignal, attempt: number) => Promise<T>,
  opts: { attempts?: number; minRemainingMs?: number; optional?: boolean } = {}
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? MAX_ATTEMPTS)
  const minRemaining = opts.minRemainingMs ?? (opts.optional ? OPTIONAL_RETRY_FLOOR_MS : perAttemptMs)
  let last: unknown = null
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1 && deadline.remainingMs() < minRemaining) break
    try {
      return await withDeadline(`${stage} (attempt ${attempt})`, Math.min(perAttemptMs, deadline.remainingMs()), (s) => fn(s, attempt))
    } catch (e) {
      last = e
    }
  }
  throw last instanceof Error ? last : new Error(`${stage} failed after ${attempts} attempt(s)`)
}

// ─── Logging ─────────────────────────────────────────────────────────────────

export interface GenerationMetrics {
  llmCalls: number
  researchQueries: number
  stages: { stage: string; ms: number; ok: boolean; detail?: string }[]
}

export function emptyMetrics(): GenerationMetrics {
  return { llmCalls: 0, researchQueries: 0, stages: [] }
}

/**
 * One structured line per stage, so "why did this take 4m18s?" is answerable
 * from the log instead of from a guess.
 */
export function logStage(
  packageId: string,
  stage: string,
  deadline: GenerationDeadline,
  metrics: GenerationMetrics,
  detail = ''
): string {
  const line =
    `[package-generation] id=${packageId} stage=${stage} ` +
    `elapsed=${Math.round(deadline.elapsedMs() / 1000)}s remaining=${Math.round(deadline.remainingMs() / 1000)}s ` +
    `searches=${metrics.researchQueries} llmCalls=${metrics.llmCalls}` +
    (detail ? ` detail=${JSON.stringify(detail)}` : '')
  console.log(line)
  return line
}
