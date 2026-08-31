// What a run says about ITSELF: how big it was allowed to be, what it spent,
// which lane found the jobs, why it stopped, and where to pick it up.
//
// Split out of orchestrator.ts, which is the shape of the run and not the
// shape of its report. Everything here is pure — it is handed the numbers the
// run accumulated and returns the object the API, the UI and the CLI read —
// so "why did this run stop and what did it cost per posting?" is answerable
// in a test with no store, no clock and no agents.
//
// The one judgement encoded here is the STOPPING REASON, and it is worth
// stating plainly:
//
//   budget      the ceiling was reached. Resumable: raise it or continue.
//   deadline    the invocation ran out of clock, or the run's total runtime
//               did. Resumable: another pass continues from the cursor.
//   saturated   the sources stopped producing anything new. NOT resumable —
//               this is the good ending of an exhaustive run, and a cursor
//               that invited a continuation here would sell the founder a
//               second pass over a market that is already exhausted.
//   complete    every stage ran to the end.

import type { CostMetrics, SpendSummary, YieldSample } from '../discovery/budget'
import { summarizeYield } from '../discovery/budget'
import { summarizeBudget, type RunBudget } from '../discovery/modes'
import type { ScoutCursor } from './run-dispatch'

/** Why the run stopped. `deadline` and `budget` are the resumable ones. */
export type ScoutStopReason = 'complete' | 'deadline' | 'budget' | 'saturated'

/** What a run reports about its own size, spend and shape, on top of JobScoutResult. */
export interface JobScoutRunReport {
  /** The budget this run actually executed, after mode and overrides. */
  budget: RunBudget
  spend: SpendSummary
  cost: CostMetrics
  /** Where to resume. `stages: ['done']` means there is nothing left to do. */
  cursor: ScoutCursor
  stopped: ScoutStopReason
  /** Postings discovered per lane, and what share came from broad market search. */
  lanes: { broad_market: number; company_first: number; broad_market_share: number }
  /** Marginal unique yield per job-first strategy, in execution order. */
  yields: YieldSample[]
  /** Human lines for the report: budget, lanes, stopping reason. */
  notes: string[]
}

export interface RunReportInput {
  budget: RunBudget
  cursor: ScoutCursor
  spend: SpendSummary
  cost: CostMetrics
  lanes: { broad_market: number; company_first: number }
  yields: YieldSample[]
  /** Every stage ran to the end and nothing stopped it early. */
  everyStageRan: boolean
  deadlineHit: boolean
  /** The ledger's refusal, verbatim, or null. */
  budgetStopped: string | null
  /** The saturation reason, verbatim, or null. */
  saturationStopped: string | null
}

/**
 * Why the run stopped, in priority order.
 *
 * Money first: a run that hit its ceiling and then also ran out of clock
 * stopped because of the ceiling, and telling the founder "it ran out of time"
 * would send them to raise the wrong thing.
 */
export function stopReasonOf(i: Pick<RunReportInput, 'everyStageRan' | 'deadlineHit' | 'budgetStopped' | 'saturationStopped'>): ScoutStopReason {
  if (i.budgetStopped) return 'budget'
  if (i.deadlineHit) return 'deadline'
  if (i.saturationStopped) return 'saturated'
  return i.everyStageRan ? 'complete' : 'deadline'
}

/**
 * Is there anything left for another pass to do?
 *
 * A saturated run is FINISHED, not partial: every remaining strategy was
 * deliberately skipped because the last ones added nothing new, so a
 * continuation would pay to re-read a market this run has already exhausted.
 * A run stopped by the clock or by money has work left, and its cursor says
 * where.
 */
export function isRunFinished(stopped: ScoutStopReason): boolean {
  return stopped === 'complete' || stopped === 'saturated'
}

export function buildRunReport(i: RunReportInput): JobScoutRunReport {
  const stopped = stopReasonOf(i)
  const total = i.lanes.broad_market + i.lanes.company_first
  const y = summarizeYield(i.yields)
  const share = total > 0 ? i.lanes.broad_market / total : 0
  return {
    budget: i.budget,
    spend: i.spend,
    cost: i.cost,
    cursor: { ...i.cursor, pages: { ...i.cursor.pages } },
    stopped,
    lanes: { ...i.lanes, broad_market_share: Number(share.toFixed(4)) },
    yields: i.yields,
    notes: [
      summarizeBudget(i.budget),
      `discovery lanes: ${i.lanes.broad_market} broad market · ${i.lanes.company_first} company-first (${Math.round(share * 100)}% broad)`,
      `job-first yield: ${y.unique} new of ${y.seen} seen over ${y.pages} strateg${y.pages === 1 ? 'y' : 'ies'}`,
      `spend: $${i.spend.spent_usd.toFixed(4)}${Number.isFinite(i.budget.maxSpendUsd) ? ` of $${i.budget.maxSpendUsd.toFixed(2)}` : ' (no ceiling)'}` +
        (i.cost.cost_per_unique_posting !== null ? ` · $${i.cost.cost_per_unique_posting.toFixed(4)} per unique posting` : ''),
      `stopped: ${stopped}${i.budgetStopped ? ` — ${i.budgetStopped}` : i.saturationStopped ? ` — ${i.saturationStopped}` : ''}`,
      `pass ${Math.max(1, i.cursor.attempts)} · ${Math.round(i.cursor.elapsed_ms / 1000)}s of the ${Math.round(i.budget.maxRuntimeMs / 60_000)} min this run may take`,
    ],
  }
}
