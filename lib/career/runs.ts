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
