// Scoring contracts.
//
// The model judges COMPONENTS; code computes the overall score.
// See docs/ARCHITECTURE.md ADR-004 — this is the highest-leverage boundary in
// the system, because it makes re-weighting instant, free, and testable.

export type ScoringDimension =
  | 'opportunity_fit'
  | 'decision_making_power'
  | 'user_differentiation'
  | 'probability_of_response'
  | 'company_attractiveness'
  | 'timing_trigger'

export const SCORING_DIMENSIONS: ScoringDimension[] = [
  'opportunity_fit',
  'decision_making_power',
  'user_differentiation',
  'probability_of_response',
  'company_attractiveness',
  'timing_trigger',
]

export const DIMENSION_LABELS: Record<ScoringDimension, string> = {
  opportunity_fit: 'Opportunity Fit',
  decision_making_power: 'Decision-Making Power',
  user_differentiation: 'User Differentiation',
  probability_of_response: 'Probability of Response',
  company_attractiveness: 'Company Attractiveness',
  timing_trigger: 'Timing / Trigger',
}

export const DIMENSION_QUESTIONS: Record<ScoringDimension, string> = {
  opportunity_fit: 'Does the kind of opportunity the user wants plausibly exist here?',
  decision_making_power: 'Can this person actually create or influence it?',
  user_differentiation: 'Is the user unusually interesting to them, versus generically qualified?',
  probability_of_response: 'Realistically, will they reply?',
  company_attractiveness: "Is this somewhere worth spending the user's one shot?",
  timing_trigger: 'Is there a reason this lands now rather than any other week?',
}

/** Weights sum to 1.0. Per-mission overrides live on `missions.scoring_weights`. */
export type ScoringWeights = Record<ScoringDimension, number>

/**
 * One judged dimension. `explanation` is mandatory and must be specific —
 * "good fit" is a failure. `evidence` references research facts or provider data.
 */
export interface ScoreComponent {
  dimension: ScoringDimension
  score: number          // 0–1, from the agent
  explanation: string
  evidence: string[]
}

/**
 * A computed score. `weights_used` is a SNAPSHOT, not a reference: mission
 * weights can change, and a stored score must stay explainable as of when it
 * was computed. See docs/DATA_MODEL.md — `scores`.
 */
export interface ScoreResult {
  components: ScoreComponent[]
  weights_used: ScoringWeights
  overall_score: number  // 0–1, computed by lib/scoring/compute.ts
  confidence: number     // 0–1, how much evidence backs this at all
  summary: string
}

/** What the ranking agent returns, before code computes the overall score. */
export interface AgentScoreOutput {
  subject_id: string
  components: ScoreComponent[]
  confidence: number
  summary: string
}
