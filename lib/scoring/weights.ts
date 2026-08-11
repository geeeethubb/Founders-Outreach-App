// Default scoring weights and per-mission resolution.
//
// These are DEFAULTS, not permanent rules. Missions may override any subset.
// See docs/PRODUCT.md §5.

import { SCORING_DIMENSIONS, type ScoringDimension, type ScoringWeights } from './types'

/** Sums to 1.0. */
export const DEFAULT_WEIGHTS: ScoringWeights = {
  opportunity_fit: 0.25,
  decision_making_power: 0.2,
  user_differentiation: 0.2,
  probability_of_response: 0.15,
  company_attractiveness: 0.1,
  timing_trigger: 0.1,
}

/**
 * Merge a mission's partial override onto the defaults and renormalize.
 *
 * Renormalizing means a founder can set "opportunity_fit: 0.5" without also
 * rebalancing the other five by hand — the rest keep their relative proportions
 * and the total still sums to 1.0. Weight editing should not be arithmetic
 * homework.
 *
 * Negative and non-finite values are dropped rather than clamped: they signal a
 * malformed override, and silently coercing them to 0 would hide the bug.
 */
export function resolveWeights(
  override?: Partial<ScoringWeights> | null
): ScoringWeights {
  if (!override) return { ...DEFAULT_WEIGHTS }

  const merged = {} as ScoringWeights
  for (const dim of SCORING_DIMENSIONS) {
    const value = override[dim]
    merged[dim] =
      typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? value
        : DEFAULT_WEIGHTS[dim]
  }

  return normalizeWeights(merged)
}

/** Scale weights so they sum to 1.0. Falls back to defaults if the total is 0. */
export function normalizeWeights(weights: ScoringWeights): ScoringWeights {
  const total = SCORING_DIMENSIONS.reduce((sum, d) => sum + weights[d], 0)
  if (total <= 0) return { ...DEFAULT_WEIGHTS }

  const normalized = {} as ScoringWeights
  for (const dim of SCORING_DIMENSIONS) {
    normalized[dim] = weights[dim] / total
  }
  return normalized
}

/** True when every dimension is present, finite, and non-negative. */
export function isValidWeights(value: unknown): value is ScoringWeights {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return SCORING_DIMENSIONS.every((dim: ScoringDimension) => {
    const v = record[dim]
    return typeof v === 'number' && Number.isFinite(v) && v >= 0
  })
}
