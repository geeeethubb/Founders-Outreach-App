// Pure scoring arithmetic. No I/O, no model calls, no database.
//
// This file is the concrete form of docs/ARCHITECTURE.md ADR-004: the model
// judges components, code computes the result. Because components are stored,
// re-ranking under new weights is a pure recomputation — no model spend.
//
// Everything here is deterministic and unit-testable without mocking anything.

import { SCORING_DIMENSIONS, type AgentScoreOutput, type ScoreComponent, type ScoreResult, type ScoringWeights } from './types'
import { resolveWeights } from './weights'

/** Clamp to the valid 0–1 score range. Non-finite input becomes 0. */
export function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/**
 * Weighted sum of component scores.
 *
 * Missing dimensions are excluded from BOTH the numerator and the denominator
 * rather than treated as 0. A dimension the agent could not judge should not
 * drag the score down — that would conflate "no evidence" with "bad", which is
 * exactly the distinction `confidence` exists to carry.
 */
export function computeOverallScore(
  components: ScoreComponent[],
  weights: ScoringWeights
): number {
  let weightedSum = 0
  let totalWeight = 0

  for (const dim of SCORING_DIMENSIONS) {
    const component = components.find((c) => c.dimension === dim)
    if (!component) continue
    const weight = weights[dim]
    weightedSum += clampScore(component.score) * weight
    totalWeight += weight
  }

  if (totalWeight <= 0) return 0
  return clampScore(weightedSum / totalWeight)
}

/**
 * Turn a ranking agent's output into a stored score.
 *
 * `weights_used` is snapshotted onto the result so the score stays explainable
 * even after the mission's weights change.
 */
export function buildScoreResult(
  agentOutput: AgentScoreOutput,
  missionWeights?: Partial<ScoringWeights> | null
): ScoreResult {
  const weights = resolveWeights(missionWeights)
  const components = agentOutput.components.map((c) => ({
    ...c,
    score: clampScore(c.score),
  }))

  return {
    components,
    weights_used: weights,
    overall_score: computeOverallScore(components, weights),
    confidence: clampScore(agentOutput.confidence),
    summary: agentOutput.summary,
  }
}

/**
 * Rank subjects highest-first.
 *
 * Ties break on confidence, so that between two equally-scored prospects the
 * better-evidenced one wins. A high score on thin evidence is a legitimate
 * output, but it should not outrank an equally high score that is actually
 * supported.
 */
export function rankByScore<T extends { overall_score: number; confidence: number }>(
  items: T[]
): T[] {
  return [...items].sort((a, b) => {
    if (b.overall_score !== a.overall_score) return b.overall_score - a.overall_score
    return b.confidence - a.confidence
  })
}

/**
 * Apply a mission's minimum-score gate.
 *
 * `minConfidence` defaults to 0 — a low-confidence score is not automatically
 * disqualifying, it just loses ties. Missions that want to be strict can raise it.
 */
export function applyThreshold<T extends { overall_score: number; confidence: number }>(
  items: T[],
  minScore: number,
  minConfidence = 0
): T[] {
  return items.filter(
    (i) => i.overall_score >= minScore && i.confidence >= minConfidence
  )
}

/**
 * Recompute stored scores under different weights.
 *
 * This is the payoff of ADR-004: changing a mission's weights re-ranks the whole
 * funnel instantly, with zero model calls, because the judged components were
 * persisted separately from the arithmetic.
 */
export function reweight(
  results: ScoreResult[],
  newWeights: Partial<ScoringWeights> | null
): ScoreResult[] {
  const weights = resolveWeights(newWeights)
  return results.map((r) => ({
    ...r,
    weights_used: weights,
    overall_score: computeOverallScore(r.components, weights),
  }))
}
