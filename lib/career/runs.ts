// Run bookkeeping for Career OS.
//
// Job-scout, verification, package and evidence-import runs reuse
// `scouting_runs` (migration 011) with the `kind` column from migration 014,
// so `agent_runs.run_id` attaches traces to them exactly as it does for
// outreach runs. One observability table, not two.

import { recordAgentRun, startScoutingRun, updateScoutingRun } from '@/lib/agents/runtime/persist'
import type { AgentResult } from '@/lib/agents/runtime/types'
import { createServiceClient } from '@/lib/supabase/server'

export type CareerRunKind = 'job_scout' | 'job_verify' | 'package' | 'evidence_import'

export interface CareerRun {
  runId: string | null
  migrationMissing: boolean
  /** Records an agent result against this run; never throws. */
  trace: (result: AgentResult<unknown>, refs?: Record<string, unknown>) => Promise<string | null>
  /** Accumulated cost across every traced agent, for the run's stats. */
  costUsd: () => number
  agentCalls: () => number
  finish: (status: 'succeeded' | 'failed' | 'cancelled', stats: Record<string, unknown>, error?: string | null) => Promise<void>
}

export async function startCareerRun(params: {
  userId: string
  kind: CareerRunKind
  label: string
  mission: unknown
  budget?: unknown
  careerMissionId?: string | null
}): Promise<CareerRun> {
  const started = await startScoutingRun({
    userId: params.userId,
    label: params.label,
    mission: params.mission,
    budget: params.budget ?? {},
  })

  let cost = 0
  let calls = 0

  if (started.runId) {
    // Stamp kind + mission link. A database predating migration 014 lacks the
    // columns; the run still exists, it is just not distinguishable by kind.
    const supabase = createServiceClient()
    await supabase
      .from('scouting_runs')
      .update({ kind: params.kind, career_mission_id: params.careerMissionId ?? null } as never)
      .eq('id', started.runId)
  }

  return {
    runId: started.runId,
    migrationMissing: started.migrationMissing,
    async trace(result, refs = {}) {
      cost += result.trace.cost_usd
      calls += 1
      const rec = await recordAgentRun(params.userId, started.runId, result, { inputRefs: refs })
      return rec.agentRunId
    },
    costUsd: () => cost,
    agentCalls: () => calls,
    async finish(status, stats, error = null) {
      if (!started.runId) return
      await updateScoutingRun(started.runId, {
        status,
        stats: { ...stats, cost_usd: Number(cost.toFixed(4)), agent_calls: calls },
        error,
        completed: true,
      })
    },
  }
}

/**
 * The same CareerRun, bound to a run row that ALREADY EXISTS.
 *
 * A durable scout is enqueued by one request and executed by another
 * (app/api/career/scout/worker), so the row is created before the work starts.
 * If the worker called `startCareerRun` it would open a SECOND row and the
 * traces, the cost and the stats would land on a run the browser is not
 * watching. Attaching keeps one row per run — which is the whole point of
 * having a row.
 *
 * `finish` here deliberately does NOT write the run's status. The durable
 * vocabulary has an outcome this one cannot express — 'partial', a run that
 * produced real jobs and then ran out of time — and `finishScoutRun` is what
 * decides it, guarded on the run still being active. If this wrote
 * 'succeeded' first, that guard would find a terminal row and the worker's
 * real verdict (and its stats) would be silently dropped. So this records what
 * the run COST — stats, cost_usd, agent_calls, any error — and leaves the
 * status to the one caller that owns it. `finishScoutRun` merges onto these
 * stats, so a durable run's stats have the same shape as a legacy one's.
 *
 * `ownsStatus: true` restores the old behaviour for a caller that has no
 * finishScoutRun after it.
 */
export async function attachCareerRun(params: {
  userId: string
  runId: string
  kind: CareerRunKind
  label?: string
  mission?: unknown
  budget?: unknown
  careerMissionId?: string | null
  /** Write the terminal status from `finish` too. Default false — see above. */
  ownsStatus?: boolean
}): Promise<CareerRun> {
  let cost = 0
  let calls = 0

  // Best effort: a database predating migration 014 lacks `kind`, and the run
  // still exists — it is just not distinguishable by kind. Never fatal.
  const supabase = createServiceClient()
  await supabase
    .from('scouting_runs')
    .update({
      kind: params.kind,
      ...(params.careerMissionId !== undefined ? { career_mission_id: params.careerMissionId } : {}),
      ...(params.label !== undefined ? { label: params.label } : {}),
      ...(params.mission !== undefined ? { mission: params.mission } : {}),
      ...(params.budget !== undefined ? { budget: params.budget } : {}),
    } as never)
    .eq('id', params.runId)

  return {
    runId: params.runId,
    migrationMissing: false,
    async trace(result, refs = {}) {
      cost += result.trace.cost_usd
      calls += 1
      const rec = await recordAgentRun(params.userId, params.runId, result, { inputRefs: refs })
      return rec.agentRunId
    },
    costUsd: () => cost,
    agentCalls: () => calls,
    async finish(status, stats, error = null) {
      const owns = params.ownsStatus === true
      await updateScoutingRun(params.runId, {
        ...(owns ? { status, completed: true } : {}),
        stats: { ...stats, cost_usd: Number(cost.toFixed(4)), agent_calls: calls },
        error,
      })
    },
  }
}

/** Per-run budgets for Career OS agents. Every loop is bounded (ADR-016). */
export interface CareerBudget {
  maxWebSearches: number
  maxAgentSteps: number
  maxPageFetches: number
  maxAtsLookups: number
  /** Wall-clock ceiling in ms; orchestrators stop starting new work past it. */
  deadlineMs: number
}

export const DEFAULT_SCOUT_BUDGET: CareerBudget = {
  maxWebSearches: 5,
  maxAgentSteps: 8,
  maxPageFetches: 40,
  maxAtsLookups: 60,
  deadlineMs: 270_000,
}

export const DEFAULT_PACKAGE_BUDGET: CareerBudget = {
  maxWebSearches: 6,
  maxAgentSteps: 8,
  maxPageFetches: 10,
  maxAtsLookups: 5,
  deadlineMs: 280_000,
}
