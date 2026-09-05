// One absolute clock per run invocation.
//
// Not a collection of unrelated timeouts. A hosted worker is killed at a fixed
// instant whatever it is doing, so the only honest budget is the time between
// now and that instant — minus what finalising needs (the cursor, the stats,
// the terminal status, the partial result). Every provider call, every retry
// sleep and every "should this stage start?" question is answered from this one
// object, so nothing a run starts can outlive the run.
//
// Pure. The clock is injectable so a test can move four minutes in no time.

export interface RunClockOptions {
  /** Absolute epoch ms the invocation must be finished by. */
  hardDeadlineAt: number
  /** Time kept back for finalisation. No expensive work starts inside it. */
  finalizeReserveMs?: number
  /** Injected clock for tests. */
  now?: () => number
  startedAt?: number
  /** Below this, an attempt is not worth starting. Tests pass a few hundred ms. */
  minAttemptMs?: number
}

/** Kept back for the finishing writes: cursor, checkpoint, stats, status, result. */
export const DEFAULT_FINALIZE_RESERVE_MS = 20_000

/** Below this, a provider attempt is not worth starting: it would spend money and be cut off. */
export const MIN_ATTEMPT_MS = 8_000

export class RunClock {
  readonly hardDeadlineAt: number
  readonly finalizeReserveMs: number
  readonly startedAt: number
  readonly minAttemptMs: number
  private readonly clock: () => number

  constructor(opts: RunClockOptions) {
    this.clock = opts.now ?? (() => Date.now())
    this.hardDeadlineAt = opts.hardDeadlineAt
    this.minAttemptMs = opts.minAttemptMs ?? MIN_ATTEMPT_MS
    this.startedAt = opts.startedAt ?? this.clock()
    const total = Math.max(0, this.hardDeadlineAt - this.startedAt)
    // Never reserve more than half the window: a two-second budget in a test
    // still needs somewhere to do work.
    this.finalizeReserveMs = Math.min(opts.finalizeReserveMs ?? DEFAULT_FINALIZE_RESERVE_MS, Math.floor(total / 2))
  }

  /** A clock that runs for `budgetMs` from now. */
  static forBudget(budgetMs: number, opts: Omit<RunClockOptions, 'hardDeadlineAt'> = {}): RunClock {
    const now = opts.now ?? (() => Date.now())
    const startedAt = opts.startedAt ?? now()
    return new RunClock({ ...opts, now, startedAt, hardDeadlineAt: startedAt + Math.max(0, budgetMs) })
  }

  now(): number {
    return this.clock()
  }

  elapsedMs(): number {
    return Math.max(0, this.clock() - this.startedAt)
  }

  /** Until the hard deadline. Never negative. */
  remainingMs(): number {
    return Math.max(0, this.hardDeadlineAt - this.clock())
  }

  /** Until the reserve begins: what expensive work may still use. Never negative. */
  remainingForWorkMs(): number {
    return Math.max(0, this.remainingMs() - this.finalizeReserveMs)
  }

  /** The hard deadline has passed. Finalise now, whatever state things are in. */
  expired(): boolean {
    return this.remainingMs() <= 0
  }

  /** Inside the finalisation reserve: stop starting work. */
  inReserve(): boolean {
    return this.remainingForWorkMs() <= 0
  }

  /**
   * How long ONE attempt at a provider call may take: the provider's own
   * ceiling, or what is left before the reserve — whichever is smaller. Zero
   * means "do not start": there is not enough time for the attempt to be worth
   * the money.
   */
  attemptTimeoutMs(ceilingMs: number, minMs = this.minAttemptMs): number {
    const left = this.remainingForWorkMs()
    if (left < minMs) return 0
    return Math.max(0, Math.min(ceilingMs, left))
  }

  /**
   * Is there enough time to START something that needs `minMs`? The question a
   * stage asks before it begins, and a retry loop asks before it sleeps.
   */
  canStart(minMs: number): boolean {
    return this.remainingForWorkMs() >= minMs
  }

  /** How long a backoff may sleep without eating the next attempt. */
  boundedSleepMs(wantMs: number, nextAttemptMinMs = this.minAttemptMs): number {
    const left = this.remainingForWorkMs() - nextAttemptMinMs
    if (left <= 0) return -1
    return Math.min(wantMs, left)
  }

  snapshot(): { started_at: string; hard_deadline_at: string; elapsed_ms: number; remaining_ms: number; remaining_for_work_ms: number; reserve_ms: number } {
    return {
      started_at: new Date(this.startedAt).toISOString(),
      hard_deadline_at: new Date(this.hardDeadlineAt).toISOString(),
      elapsed_ms: this.elapsedMs(),
      remaining_ms: this.remainingMs(),
      remaining_for_work_ms: this.remainingForWorkMs(),
      reserve_ms: this.finalizeReserveMs,
    }
  }
}

/**
 * Wait, but never past the clock. Resolves false when the sleep was refused or
 * cut short because the run would have nothing left to do afterwards.
 */
export async function sleepWithin(clock: RunClock | null, wantMs: number, nextAttemptMinMs?: number): Promise<boolean> {
  if (!clock) {
    await new Promise((r) => setTimeout(r, wantMs))
    return true
  }
  const ms = clock.boundedSleepMs(wantMs, nextAttemptMinMs ?? clock.minAttemptMs)
  if (ms < 0) return false
  if (ms > 0) await new Promise((r) => setTimeout(r, ms))
  return true
}

/**
 * The invocation budget this process is running under.
 *
 * `SCOUT_INVOCATION_BUDGET_MS` overrides everything (a local run that wants to
 * behave like a hosted one, or a test). Otherwise: Vercel's function ceiling
 * minus a safety margin, or the generous local budget.
 */
export function invocationBudgetMs(env: Record<string, string | undefined> = process.env): number {
  const override = Number(env.SCOUT_INVOCATION_BUDGET_MS)
  if (Number.isFinite(override) && override > 0) return Math.floor(override)
  return env.VERCEL ? VERCEL_INVOCATION_BUDGET_MS : LOCAL_INVOCATION_BUDGET_MS
}

/** Vercel kills the function at maxDuration (300s); this is what a worker may plan on. */
export const VERCEL_INVOCATION_BUDGET_MS = 280_000
/** A local worker has no platform ceiling; twenty minutes matches the CLI. */
export const LOCAL_INVOCATION_BUDGET_MS = 1_200_000
