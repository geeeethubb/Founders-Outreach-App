// When a discovery run STOPS — the two reasons that are not the clock.
//
//   1. MONEY.      A spend ceiling that is actually enforced: every paid stage
//                  asks before it starts, the run records what each stage and
//                  each source cost, and when the ceiling is reached nothing
//                  new is started. The run finishes cleanly as `partial` with
//                  a reason, and it never silently exceeds its configured
//                  maximum.
//
//   2. SATURATION. A source is done when it stops producing anything NEW —
//                  not when a counter reaches twelve. `saturated()` reads the
//                  marginal unique yield of the last few pages and says so.
//
// Both are pure: no clock beyond what the caller passes, no database, no
// network, no model. The orchestrator owns the decisions; this file owns the
// arithmetic behind them, which is exactly the split ADR-004 asks for — the
// model judges, the code computes.

import type { SaturationPolicy } from './modes'

// ─── 1. Spend ────────────────────────────────────────────────────────────────

/** One paid thing that happened. `usd` is what it actually cost, not an estimate. */
export interface SpendRecord {
  /** The run stage that spent it: 'plan', 'job-first', 'extract', 'rank', … */
  stage: string
  /** Where it went: an agent, a source id, a provider. */
  source: string
  /** Model role or id when a model was called, else null. Never hardcode an id — pass what the runtime used. */
  model?: string | null
  usd: number
  /** How many units this bought (postings extracted, jobs ranked, pages fetched). */
  units?: number
}

export interface SpendSummary {
  limit_usd: number
  spent_usd: number
  remaining_usd: number
  by_stage: Record<string, number>
  by_source: Record<string, number>
  by_model: Record<string, number>
  entries: number
  /** True when the ceiling has been reached and no new paid work may start. */
  stopped: boolean
  stop_reason: string | null
}

export interface SpendCheck {
  ok: boolean
  /** Why not, in words the run can put in `errors` verbatim. Null when ok. */
  reason: string | null
  remaining_usd: number
}

export interface CostMetrics {
  spend_usd: number
  unique_postings: number
  /** The number this whole workstream exists to move. Null when nothing was found. */
  cost_per_unique_posting: number | null
  cost_per_stored_job: number | null
  cost_per_ranked_job: number | null
}

/**
 * Rough per-unit costs, used ONLY to ask "can I afford to start this?".
 *
 * They are deliberately a little pessimistic: a pre-check that under-estimates
 * lets a stage start and then blow through the ceiling, which is the one
 * outcome this module exists to prevent. Real cost is recorded afterwards from
 * the run's own trace (`syncTotal`), so an estimate being wrong changes what a
 * run DARES to start, never what it reports having spent.
 */
export const STAGE_COST_ESTIMATE_USD = {
  /** One mission-planner call. */
  plan: 0.2,
  /** One job-first strategy session (several agent rounds). */
  strategy: 0.4,
  /** One posting read properly by the extractor. */
  extract: 0.015,
  /** One ambiguous page sent to the verifier. */
  verify: 0.005,
  /** One full fit evaluation. */
  rank: 0.04,
} as const

export interface SpendLedgerOptions {
  /** The ceiling in dollars. Infinity means no ceiling was configured. */
  limitUsd: number
  /** Already spent by earlier invocations of the SAME run (a resumed cursor). */
  openingUsd?: number
  /**
   * Held back from the ceiling so a run always has room to finish cleanly —
   * persisting, one last verification pass. Default $0.
   */
  reserveUsd?: number
}

export interface SpendLedger {
  /** Record real, already-incurred cost. */
  record(entry: SpendRecord): void
  /**
   * Record the DELTA between a running total (the CareerRun's own cost) and
   * what this ledger has already seen. The scout's spend happens inside agents
   * that do their own accounting, so the ledger follows the trace rather than
   * trying to price each call itself.
   */
  syncTotal(totalUsd: number, meta: { stage: string; source?: string; model?: string | null }): void
  spent(): number
  remaining(): number
  /** May a stage costing about `estimateUsd` start? Never latches on a refusal. */
  canSpend(estimateUsd: number, meta?: { stage?: string }): SpendCheck
  /** How many units of `unitUsd` are still affordable. 0 when the ceiling is reached. */
  affordable(unitUsd: number): number
  /** True once the ceiling (minus the reserve) has been reached. */
  stopped(): boolean
  /** The reason the last refusal gave, for `errors` and the run report. */
  stopReason(): string | null
  summary(): SpendSummary
  metrics(counts: { uniquePostings: number; storedJobs?: number; rankedJobs?: number }): CostMetrics
}

function bumpRecord(record: Record<string, number>, key: string, by: number): void {
  record[key] = Number(((record[key] ?? 0) + by).toFixed(6))
}

export function createSpendLedger(opts: SpendLedgerOptions): SpendLedger {
  const limit = Number.isFinite(opts.limitUsd) ? Math.max(0, opts.limitUsd) : Number.POSITIVE_INFINITY
  const reserve = Math.max(0, opts.reserveUsd ?? 0)
  const byStage: Record<string, number> = {}
  const bySource: Record<string, number> = {}
  const byModel: Record<string, number> = {}
  let spent = Math.max(0, opts.openingUsd ?? 0)
  let entries = 0
  /**
   * What the ledger has already accounted for from a running total.
   *
   * It starts at the opening balance, not at zero: a resumed run's caller
   * passes `openingUsd + thisInvocation`, and a ledger that had not counted
   * the opening balance as "already seen" would add it a second time on the
   * first sync.
   */
  let syncedTotal = Math.max(0, opts.openingUsd ?? 0)
  let reason: string | null = null

  if (spent > 0) {
    // An opening balance from an earlier invocation is real spend, attributed
    // so the report can say the run cost more than this invocation did.
    bumpRecord(byStage, 'earlier invocations', spent)
    bumpRecord(bySource, 'earlier invocations', spent)
    entries++
  }

  const usable = () => (Number.isFinite(limit) ? Math.max(0, limit - reserve) : Number.POSITIVE_INFINITY)
  const remaining = () => Math.max(0, usable() - spent)

  const refuse = (what: string, estimateUsd: number): SpendCheck => {
    reason =
      `spend ceiling reached: $${spent.toFixed(4)} of $${limit.toFixed(2)}` +
      (reserve > 0 ? ` (with $${reserve.toFixed(2)} held back)` : '') +
      ` — ${what} (about $${estimateUsd.toFixed(3)}) was not started`
    return { ok: false, reason, remaining_usd: Number(remaining().toFixed(4)) }
  }

  const recordEntry = (entry: SpendRecord): void => {
    const usd = Number.isFinite(entry.usd) ? Math.max(0, entry.usd) : 0
    if (usd === 0 && (entry.units ?? 0) === 0) return
    spent += usd
    entries++
    bumpRecord(byStage, entry.stage, usd)
    bumpRecord(bySource, entry.source, usd)
    if (entry.model) bumpRecord(byModel, entry.model, usd)
  }

  return {
    record: recordEntry,
    syncTotal(totalUsd, meta) {
      const total = Number.isFinite(totalUsd) ? Math.max(0, totalUsd) : 0
      const delta = total - syncedTotal
      syncedTotal = total
      if (delta <= 0) return
      recordEntry({ stage: meta.stage, source: meta.source ?? 'agents', model: meta.model ?? null, usd: delta })
    },
    spent: () => Number(spent.toFixed(6)),
    remaining: () => Number(remaining().toFixed(6)),
    canSpend(estimateUsd, meta = {}) {
      const est = Number.isFinite(estimateUsd) ? Math.max(0, estimateUsd) : 0
      if (!Number.isFinite(limit)) return { ok: true, reason: null, remaining_usd: Number.POSITIVE_INFINITY }
      if (spent + est > usable()) return refuse(meta.stage ?? 'the next paid stage', est)
      return { ok: true, reason: null, remaining_usd: Number(remaining().toFixed(4)) }
    },
    affordable(unitUsd) {
      if (!Number.isFinite(limit)) return Number.MAX_SAFE_INTEGER
      const unit = Number.isFinite(unitUsd) && unitUsd > 0 ? unitUsd : 0
      if (unit === 0) return Number.MAX_SAFE_INTEGER
      return Math.max(0, Math.floor(remaining() / unit))
    },
    stopped: () => Number.isFinite(limit) && remaining() <= 0,
    stopReason: () => reason,
    summary() {
      return {
        limit_usd: Number.isFinite(limit) ? Number(limit.toFixed(4)) : Number.POSITIVE_INFINITY,
        spent_usd: Number(spent.toFixed(4)),
        remaining_usd: Number.isFinite(limit) ? Number(remaining().toFixed(4)) : Number.POSITIVE_INFINITY,
        by_stage: { ...byStage },
        by_source: { ...bySource },
        by_model: { ...byModel },
        entries,
        stopped: Number.isFinite(limit) && remaining() <= 0,
        stop_reason: reason,
      }
    },
    metrics(counts) {
      const per = (n: number | undefined) => (n && n > 0 ? Number((spent / n).toFixed(4)) : null)
      return {
        spend_usd: Number(spent.toFixed(4)),
        unique_postings: counts.uniquePostings,
        cost_per_unique_posting: per(counts.uniquePostings),
        cost_per_stored_job: per(counts.storedJobs),
        cost_per_ranked_job: per(counts.rankedJobs),
      }
    },
  }
}

// ─── 2. Saturation ───────────────────────────────────────────────────────────

/** One page, one round, one strategy: how much it returned and how much was new. */
export interface YieldSample {
  /** Postings this page returned. */
  seen: number
  /** Of those, how many this run had not seen before. */
  unique: number
  /** What produced it, for the reason line. */
  label?: string
}

export interface SaturationResult {
  saturated: boolean
  /** Why, in words a run can surface verbatim. Null when it should keep going. */
  reason: string | null
  /** Marginal unique yield of the most recent sample, or null when there is none. */
  ratio: number | null
}

export const DEFAULT_SATURATION: SaturationPolicy = { minYieldRatio: 0.1, lowYieldStreak: 2, minSamples: 2 }

/** New-unique share of one page. An empty page is 0, never NaN. */
export function yieldRatio(sample: YieldSample): number {
  if (!sample || sample.seen <= 0) return 0
  return Math.max(0, Math.min(1, sample.unique / sample.seen))
}

/**
 * Has this source/strategy stopped being worth continuing?
 *
 * The rule is about the MARGIN, not the total. A page that adds fewer than
 * `minYieldRatio` new postings, `lowYieldStreak` times in a row, is a source
 * repeating itself — continuing costs money and returns duplicates. A page
 * that is still productive never stops the loop, however many pages came
 * before it: this is what replaces `targetCount: 12`.
 *
 * Empty pages are treated as exhaustion rather than low yield, because that is
 * what they are, and the reason line says so.
 *
 * Pure and total: no clock, no I/O, and an empty history is never saturated.
 */
export function saturated(history: YieldSample[], opts: Partial<SaturationPolicy> = {}): SaturationResult {
  const policy: SaturationPolicy = { ...DEFAULT_SATURATION, ...opts }
  const streak = Math.max(1, Math.floor(policy.lowYieldStreak))
  const minSamples = Math.max(1, Math.floor(policy.minSamples))
  const samples = Array.isArray(history) ? history.filter((s) => s && Number.isFinite(s.seen) && Number.isFinite(s.unique)) : []
  const last = samples.length ? samples[samples.length - 1] : null
  const ratio = last ? yieldRatio(last) : null

  if (samples.length < Math.max(minSamples, streak)) return { saturated: false, reason: null, ratio }

  const tail = samples.slice(-streak)

  if (tail.every((s) => s.seen === 0)) {
    return {
      saturated: true,
      reason: `exhausted: ${streak} consecutive empty page${streak === 1 ? '' : 's'}${last?.label ? ` from ${last.label}` : ''}`,
      ratio,
    }
  }

  if (tail.every((s) => yieldRatio(s) < policy.minYieldRatio)) {
    const pct = Math.round(policy.minYieldRatio * 100)
    const seenTotal = tail.reduce((a, s) => a + s.seen, 0)
    const uniqueTotal = tail.reduce((a, s) => a + s.unique, 0)
    return {
      saturated: true,
      reason:
        `saturated: the last ${streak} page${streak === 1 ? '' : 's'} added ${uniqueTotal} new of ${seenTotal} ` +
        `(under ${pct}% each)${last?.label ? ` — ${last.label}` : ''}`,
      ratio,
    }
  }

  return { saturated: false, reason: null, ratio }
}

/** Running totals for the report: how much of what a lane saw was actually new. */
export function summarizeYield(history: YieldSample[]): { seen: number; unique: number; ratio: number; pages: number } {
  const seen = history.reduce((a, s) => a + Math.max(0, s.seen), 0)
  const unique = history.reduce((a, s) => a + Math.max(0, s.unique), 0)
  return { seen, unique, ratio: seen > 0 ? Number((unique / seen).toFixed(4)) : 0, pages: history.length }
}
