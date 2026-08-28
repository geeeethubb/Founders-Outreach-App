// Fit: from the agent's components to a number, and to a row.
//
// The Fit Evaluator emits components; this is the only place a total is
// made (ADR-004). The feedback adjustment is added AFTER the weighted mean and
// the result is clamped, so an adjustment can move a job across a band but
// never below 0 or above 1 — and `weights_used` snapshots the weights, so a
// later change to the mission's weights explains a re-rank rather than
// silently rewriting history.

import { computeFitOverall, resolveFitWeights, fitBand, clamp01, type FitBand } from './dimensions'
import type { FitJudgment, FitWeights } from '../types'

export interface FitEvaluation {
  overall: number
  /** The weighted mean before feedback — what the agent's judgment alone says. */
  base_overall: number
  feedback_adjustment: number
  weights_used: FitWeights
  band: FitBand
}

export function evaluateFit(params: {
  judgment: FitJudgment
  weights: Partial<FitWeights> | null
  feedbackAdjustment?: number
}): FitEvaluation {
  const weights_used = resolveFitWeights(params.weights)
  const base = computeFitOverall(params.judgment.components, weights_used)
  const adj = typeof params.feedbackAdjustment === 'number' && Number.isFinite(params.feedbackAdjustment)
    ? params.feedbackAdjustment
    : 0
  const overall = clamp01(base + adj)
  return {
    overall: round4(overall),
    base_overall: round4(base),
    feedback_adjustment: round4(adj),
    weights_used,
    band: fitBand(overall),
  }
}

/** numeric(5,4) in the schema. Rounding here keeps the stored value equal to the computed one. */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

export interface FitEvaluationRow {
  user_id: string
  job_id: string
  mission_id: string | null
  components: FitJudgment['components']
  weights_used: FitWeights
  overall: number
  feedback_adjustment: number
  eligibility: FitJudgment['eligibility']
  eligibility_reasoning: string | null
  explanation: string | null
  uncertainties: string[]
  red_flags: string[]
  missing_qualifications: string[]
  confidence: number | null
  prompt_version: string | null
  agent_run_id: string | null
}

/** Shape a job_fit_evaluations insert. The orchestrator persists it. */
export function buildFitEvaluationRow(params: {
  userId: string
  jobId: string
  missionId: string | null
  judgment: FitJudgment
  evaluation: FitEvaluation
  promptVersion: string | null
  agentRunId: string | null
}): FitEvaluationRow {
  const j = params.judgment
  return {
    user_id: params.userId,
    job_id: params.jobId,
    mission_id: params.missionId,
    components: j.components,
    weights_used: params.evaluation.weights_used,
    overall: params.evaluation.overall,
    feedback_adjustment: params.evaluation.feedback_adjustment,
    eligibility: j.eligibility,
    eligibility_reasoning: j.eligibility_reasoning || null,
    explanation: j.explanation || null,
    uncertainties: j.uncertainties,
    red_flags: j.red_flags,
    missing_qualifications: j.missing_qualifications,
    // numeric(3,2)
    confidence: Math.round(clamp01(j.confidence) * 100) / 100,
    prompt_version: params.promptVersion,
    agent_run_id: params.agentRunId,
  }
}
