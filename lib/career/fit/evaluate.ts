// Fit: from the agent's components to a number, and to a row.
//
// The Fit Evaluator emits components; this is the only place a total is
// made (ADR-004). The feedback adjustment is added AFTER the weighted mean and
// the result is clamped, so an adjustment can move a job across a band but
// never below 0 or above 1 — and `weights_used` snapshots the weights, so a
// later change to the mission's weights explains a re-rank rather than
// silently rewriting history.

import { computeFitOverall, resolveFitWeights, fitBand, clamp01, type FitBand } from './dimensions'
import type { Eligibility, FitComponent, FitJudgment, FitWeights } from '../types'

export interface FitEvaluation {
  overall: number
  /** The weighted mean before gates and feedback — what the agent's judgment alone says. */
  base_overall: number
  feedback_adjustment: number
  weights_used: FitWeights
  band: FitBand
  /** The gates that scaled the number down: 'NOT_QUALIFIED' and/or hard-constraint labels. Empty when none applied. */
  gates: string[]
}

// ─── Gates ───────────────────────────────────────────────────────────────────
// The weighted mean measures how good a job WOULD be. It says nothing about
// whether the person can have it. The fit eval planted a Summer 2026 posting
// that scored 0.70 on the ten dimensions — excellent role, right company,
// right city — and ranked fourth of twenty-four while being NOT_QUALIFIED
// and out of season. Ranking is code (ADR-004), so this is where the verdict
// and the mission's hard constraints bite: each gate multiplies the mean, so
// gated jobs keep their relative order but sit below everything ungated.

/** A NOT_QUALIFIED verdict halves the score. */
export const NOT_QUALIFIED_FACTOR = 0.5
/** Each failed hard constraint (wrong season, not an internship, outside the country) takes 40%. */
export const HARD_CONSTRAINT_FACTOR = 0.6
/**
 * And the number can never leave the WEAK band. A hard constraint is the
 * mission's own exclusion rule — discovery discards these outright, and the
 * only way one reaches ranking is a manual add. The factor alone was not
 * enough: the Summer 2026 decoy scored 0.72 on the dimensions, and on a run
 * where the evaluator called it QUALIFIED (it says NOT_QUALIFIED on others —
 * season is not in its list of hard requirements) 0.72 × 0.6 still outranked
 * a real STRETCH posting. A job the mission rules out is at most WEAK.
 */
export const HARD_CONSTRAINT_CAP = 0.3
/**
 * Below this, role_fit scales the whole number down in proportion. The
 * discovery eval's top 20 held eight software and aerospace internships the
 * evaluator had scored 0.12–0.25 on role_fit — its judgment was right — that
 * a 0.9 location and a 0.7 company lifted to the same 0.49 as a process
 * engineering role. The wrong kind of work in the right city is still the
 * wrong kind of work; a continuous scale keeps a 0.30 and a 0.15 apart.
 */
export const ROLE_FIT_FLOOR = 0.35

export function fitGates(eligibility: Eligibility, hardConstraintFailures: string[] = [], components: FitComponent[] = []): { factor: number; cap: number; gates: string[] } {
  const gates: string[] = []
  let factor = 1
  let cap = 1
  if (eligibility === 'NOT_QUALIFIED') {
    gates.push('NOT_QUALIFIED')
    factor *= NOT_QUALIFIED_FACTOR
  }
  for (const label of hardConstraintFailures) {
    gates.push(label)
    factor *= HARD_CONSTRAINT_FACTOR
    cap = HARD_CONSTRAINT_CAP
  }
  const roleFit = components.find((c) => c.dimension === 'role_fit')
  if (roleFit && roleFit.score < ROLE_FIT_FLOOR) {
    gates.push(`role_fit ${roleFit.score.toFixed(2)} < ${ROLE_FIT_FLOOR}`)
    factor *= Math.max(0, roleFit.score) / ROLE_FIT_FLOOR
  }
  return { factor, cap, gates }
}

export function evaluateFit(params: {
  judgment: FitJudgment
  weights: Partial<FitWeights> | null
  feedbackAdjustment?: number
  /** Labels of the mission's hard constraints this job fails (applyHardConstraints). Discovery rejects these; a manual add or an eval still ranks them. */
  hardConstraintFailures?: string[]
}): FitEvaluation {
  const weights_used = resolveFitWeights(params.weights)
  const base = computeFitOverall(params.judgment.components, weights_used)
  const adj = typeof params.feedbackAdjustment === 'number' && Number.isFinite(params.feedbackAdjustment)
    ? params.feedbackAdjustment
    : 0
  const gate = fitGates(params.judgment.eligibility, params.hardConstraintFailures ?? [], params.judgment.components)
  const overall = Math.min(gate.cap, clamp01(base * gate.factor + adj))
  return {
    overall: round4(overall),
    base_overall: round4(base),
    feedback_adjustment: round4(adj),
    weights_used,
    band: fitBand(overall),
    gates: gate.gates,
  }
}

/**
 * job_fit_evaluations has no column for the gates, and the UI already renders
 * red_flags. So the reason a number was capped travels there, prefixed so it
 * can be told from the evaluator's own flags — and so a re-persist replaces
 * the previous gate entries instead of stacking them.
 */
export const GATE_FLAG_PREFIX = 'capped: '

export function redFlagsWithGates(redFlags: string[], gates: string[]): string[] {
  const own = redFlags.filter((f) => !f.startsWith(GATE_FLAG_PREFIX))
  const out = [...own]
  for (const g of gates) {
    const flag = `${GATE_FLAG_PREFIX}${g}`
    if (!out.includes(flag)) out.push(flag)
  }
  return out
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
    red_flags: redFlagsWithGates(j.red_flags, params.evaluation.gates),
    missing_qualifications: j.missing_qualifications,
    // numeric(3,2)
    confidence: Math.round(clamp01(j.confidence) * 100) / 100,
    prompt_version: params.promptVersion,
    agent_run_id: params.agentRunId,
  }
}
