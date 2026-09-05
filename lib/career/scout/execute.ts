// The Job Scout as ONE LEG of a durable run.
//
// What the shared worker (lib/runs/worker.ts) hands to `runJobScout`, and how
// the orchestrator's answer is read back as a leg outcome: finished, partial
// with work left (→ the next leg resumes from the cursor), failed, cancelled.
// The mapping from the stored row to the orchestrator's parameters is
// `toJobScoutParams` — one function, shared with the CLI, so a field added to
// the run's parameters cannot reach one executor and not another.

import { attachCareerRun } from '@/lib/career/runs'
import { scoutError } from '@/lib/runs/errors'
import type { LegExecutor, LegInput, LegOutcome } from '@/lib/runs/worker'
import { liveScoutStore, runJobScout, type ScoutStore } from './orchestrator'
import { readScoutParams, scoutCaps, toJobScoutParams, type ScoutCursor } from './run-dispatch'
import { jobLegContinuation, terminalStatusFor } from './run-record'
import { resolveRunBudget } from '@/lib/career/discovery/modes'

export const jobScoutExecutor: LegExecutor = {
  kind: 'job_scout',
  async execute(input: LegInput): Promise<LegOutcome> {
    const params = readScoutParams(input.params, scoutCaps())
    // One run row, not two: the scout's CareerRun attaches to the row the
    // enqueue step created, fenced on this leg's worker id. It writes cost_usd
    // and agent_calls; the terminal status is the kernel's.
    const store: ScoutStore = { ...liveScoutStore(), startRun: (p) => attachCareerRun({ ...p, runId: input.runId, workerId: input.workerId }) }
    // The leg's clock is the ambient run context's; the orchestrator opens a
    // nested context that ends no later than it.
    const deadlineMs = Math.max(0, input.ctx.clock.hardDeadlineAt - Date.now())
    const result = await runJobScout(
      toJobScoutParams(params, {
        userId: input.userId,
        deadlineMs,
        onProgress: input.onProgress,
        onCursor: (c: ScoutCursor) => input.onCursor(c as unknown as Record<string, unknown>),
      }),
      { store }
    )

    const status = terminalStatusFor({
      migrationMissing: result.migrationMissing,
      deadlineHit: result.stats.deadline_hit,
      errors: result.errors,
      partial: result.partial,
      stopped: result.stopped,
    })
    const cursor = result.cursor as unknown as Record<string, unknown>
    const stats = { ...result.stats, jobs: result.jobs.length, rejected: result.rejected.length }

    if (result.migrationMissing) {
      return { status: 'failed', continuable: false, cursor, stats, errors: result.errors, error: scoutError('SCHEMA_MIGRATION', 'Apply supabase/migrations/014_career_os.sql first', { runId: input.runId, retryable: false }) }
    }
    if (result.stopped === 'failed' || status === 'failed') {
      return { status: 'failed', continuable: false, cursor, stats, errors: result.errors, error: scoutError('INTERNAL', result.errors[result.errors.length - 1] ?? 'the run could not start', { runId: input.runId, retryable: false }) }
    }
    if (input.shouldStop()) return { status: 'cancelled', continuable: false, cursor, stats, errors: result.errors }

    // Only the CLOCK makes a leg continuable by itself. A run stopped by its
    // spend ceiling stops: raising the ceiling is the founder's decision
    // ("Continue this run" with a new maxSpendUsd), not the worker's.
    // The rule is pure (run-record.ts) and bounded by the mode's own runtime.
    const runtimeMs = resolveRunBudget(params.mode, { maxSpendUsd: params.maxSpendUsd }).maxRuntimeMs
    const cont = jobLegContinuation({ status, stopped: result.stopped, cursor: result.cursor, runtimeMs })
    // The ledger's own sentence names the ceiling; a lane's "stopped at its
    // deadline" line must not stand in for it (the live QUICK run's row did).
    const budgetSentence = result.errors.find((e) => /spend ceiling|ceiling reached/i.test(e)) ?? result.errors.find((e) => /budget/i.test(e)) ?? 'the run reached its spend ceiling'
    return {
      status,
      continuable: cont.continuable,
      cursor,
      stats,
      errors: result.errors,
      error:
        status !== 'partial' || cont.continuable
          ? null
          : result.stopped === 'budget'
            ? scoutError('RUN_DEADLINE', budgetSentence, { runId: input.runId, retryable: true, remedy: 'Raise the spend limit and continue the run; everything found is saved.' })
            : cont.reason
              ? scoutError('RUN_DEADLINE', cont.reason, { runId: input.runId, retryable: true, remedy: 'Continue the run from its cursor when you want more; everything found is saved.' })
              : null,
    }
  },
}
