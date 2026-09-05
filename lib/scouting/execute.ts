// The People Scout as ONE LEG of a durable run.
//
// What the shared worker (lib/runs/worker.ts) hands to `runScouting`, and how
// the orchestrator's answer is read back as a leg outcome. The "who you are"
// side is loaded here from the Evidence Bank — retrieved summaries only, never
// the full résumé (ADR-005) — exactly as the synchronous route used to do it.

import { loadEvidenceBank } from '@/lib/career/evidence/store'
import { backgroundForOutreach, toScoutItems } from '@/lib/outreach/background'
import { scoutError } from '@/lib/runs/errors'
import type { LegExecutor, LegInput, LegOutcome } from '@/lib/runs/worker'
import { readCheckpoint, type PeopleScoutCheckpoint, type PeopleScoutResult } from './checkpoint'
import { runScouting } from './orchestrator'
import { readPeopleScoutParams } from './run-params'

export const peopleScoutExecutor: LegExecutor = {
  kind: 'outreach',
  async execute(input: LegInput): Promise<LegOutcome> {
    const p = readPeopleScoutParams(input.params)
    const { checkpoint, note } = readCheckpoint(input.checkpoint)
    const errors: string[] = note ? [note] : []

    // The Evidence Bank is the source; the fixture is the fallback for an
    // empty bank, and the result says which one was used so the page can show it.
    let bankWarning: string | null = null
    const bankRes = await loadEvidenceBank(input.userId, { approvedOnly: true }).catch((e) => {
      bankWarning = `Evidence Bank unavailable: ${e instanceof Error ? e.message : String(e)}`
      return null
    })
    if (bankRes?.migrationMissing) bankWarning = 'migration 014_career_os.sql has not been applied — using the fixture background'
    const background = backgroundForOutreach(bankRes?.bank ?? null, { mission: p.goal, maxExperiences: 12, maxFacts: 24 })
    const backgroundItems = toScoutItems(background.items)

    const result = await runScouting({
      userId: input.userId,
      label: p.label,
      mission: { goal: p.goal, timeframe: p.timeframe, geography: p.geography, constraints: p.constraints },
      backgroundItems,
      budget: { maxCompanies: 12, maxPeoplePerCompany: 5, maxApolloCalls: 60, maxWebSearches: 4, maxAgentSteps: 6 },
      segmentCount: p.segmentCount,
      companiesPerSegment: p.companiesPerSegment,
      maxProspects: p.maxProspects,
      maxDeepResearch: p.maxDeepResearch,
      researchPerCompany: p.researchPerCompany,
      maxDiscoveryRounds: p.maxDiscoveryRounds,
      maxRescoutRounds: p.maxRescoutRounds,
      concurrency: p.concurrency,
      searchMode: p.searchMode,
      internalTarget: p.internalTarget,
      maxInternalSearches: p.maxInternalSearches,
      runId: input.runId,
      workerId: input.workerId,
      checkpoint,
      background: { source: background.source, items: backgroundItems.length, warning: bankWarning },
      onProgress: input.onProgress,
      onCheckpoint: (cp: PeopleScoutCheckpoint) => input.onCheckpoint(cp as unknown as Record<string, unknown>),
      onResult: (r: PeopleScoutResult) => input.onResult(r as unknown as Record<string, unknown>),
      shouldStop: input.shouldStop,
    })

    const allErrors = [...errors, ...result.errors]
    const stats = {
      funnel: result.funnel,
      usage: { costUsd: result.usage.costUsd, apolloCredits: result.usage.apollo.enrichmentCredits, webSearches: result.usage.anthropic.webSearches, modelCalls: result.usage.anthropic.calls },
      stopped: result.stopped,
      stages: result.checkpoint.stages,
      cost_usd: Number(result.usage.costUsd.toFixed(4)),
    }
    const checkpointOut = result.checkpoint as unknown as Record<string, unknown>
    const resultOut = result.payload as unknown as Record<string, unknown>

    if (result.stopped === 'failed') {
      const last = allErrors[allErrors.length - 1] ?? 'the run failed'
      return { status: 'failed', continuable: false, checkpoint: checkpointOut, result: resultOut, stats, errors: allErrors, error: scoutError('INTERNAL', last, { runId: input.runId, stage: result.checkpoint.stages[result.checkpoint.stages.length - 1] ?? null, retryable: false }) }
    }
    if (result.stopped === 'cancelled' || input.shouldStop()) {
      return { status: 'cancelled', continuable: false, checkpoint: checkpointOut, result: resultOut, stats, errors: allErrors }
    }
    if (result.stopped === 'deadline') {
      return { status: 'partial', continuable: true, checkpoint: checkpointOut, result: resultOut, stats, errors: allErrors }
    }
    return { status: 'succeeded', continuable: false, checkpoint: checkpointOut, result: resultOut, stats, errors: allErrors }
  },
}
