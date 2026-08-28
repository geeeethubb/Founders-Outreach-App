// Fit dimensions, default weights, and the arithmetic.
//
// ADR-004 applied to jobs: the Fit Evaluator emits a 0–1 judgment per
// dimension with an explanation and evidence; everything numeric happens here.
// Weights live on career_missions.fit_weights and are editable; changing them
// re-ranks instantly with no model call because components are stored.
//
// ELIGIBILITY IS NOT A WEIGHT. A job the user cannot apply to is flagged, not
// down-weighted, and STRETCH is a first-class verdict — a missing preferred
// qualification is not disqualification (docs/CAREER_OS.md §6).

import { FIT_DIMENSIONS, type FitComponent, type FitDimension, type FitWeights } from '../types'

export const FIT_DIMENSION_LABELS: Record<FitDimension, string> = {
  role_fit: 'Role fit',
  learning_upside: 'Learning upside',
  ownership: 'Ownership',
  company_quality: 'Company quality',
  mission_interest_fit: 'Mission / interest fit',
  location_fit: 'Location fit',
  career_optionality: 'Career optionality',
  people_mentorship: 'People / mentorship',
  differentiation: 'Differentiation',
  application_urgency: 'Application urgency',
}

export const FIT_DIMENSION_QUESTIONS: Record<FitDimension, string> = {
  role_fit: "Does the user's existing background map to the actual work described — not to the title?",
  learning_upside: 'How much new capability or exposure would this role provide, given what the user already knows?',
  ownership: 'How likely are interns here to receive meaningful responsibility rather than shadowing?',
  company_quality: 'How strong is the company on trajectory, technical quality and reputation among people who know the field — where evidence exists? Prestige is not quality.',
  mission_interest_fit: "How well does the company's mission and problem space match the user's stated interests and preferences?",
  location_fit: "How well does the location match the mission's geographic tiers and work-mode preferences?",
  career_optionality: 'Does this role open more doors than it closes over the next several years?',
  people_mentorship: 'Is there evidence of strong colleagues and real mentorship for interns?',
  differentiation: "Does the user's specific background give them a distinctive angle for THIS role, versus a generically qualified applicant?",
  application_urgency: 'How time-sensitive is applying — deadline, rolling review, posting age, competitiveness?',
}

/** Sums to 1.0. Defaults, not rules — missions override any subset. */
export const DEFAULT_FIT_WEIGHTS: FitWeights = {
  role_fit: 0.16,
  learning_upside: 0.14,
  ownership: 0.10,
  company_quality: 0.10,
  mission_interest_fit: 0.12,
  location_fit: 0.12,
  career_optionality: 0.08,
  people_mentorship: 0.06,
  differentiation: 0.08,
  application_urgency: 0.04,
}

export function clamp01(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0
  return Math.min(1, Math.max(0, v))
}

/**
 * Merge a mission's partial override onto the defaults and renormalize, so a
 * user can set one dimension without rebalancing nine others by hand.
 * Negative and non-finite values are dropped (they signal a malformed
 * override), never clamped.
 */
export function resolveFitWeights(override?: Partial<FitWeights> | null): FitWeights {
  const merged = {} as FitWeights
  for (const dim of FIT_DIMENSIONS) {
    const v = override?.[dim]
    merged[dim] = typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : DEFAULT_FIT_WEIGHTS[dim]
  }
  return normalizeFitWeights(merged)
}

export function normalizeFitWeights(weights: FitWeights): FitWeights {
  const total = FIT_DIMENSIONS.reduce((s, d) => s + weights[d], 0)
  if (total <= 0) return { ...DEFAULT_FIT_WEIGHTS }
  const out = {} as FitWeights
  for (const d of FIT_DIMENSIONS) out[d] = weights[d] / total
  return out
}

/**
 * Weighted mean over the dimensions actually judged. A dimension the agent
 * could not judge is excluded from numerator AND denominator — "no evidence"
 * must not read as "bad"; that is what `confidence` carries.
 */
export function computeFitOverall(components: FitComponent[], weights: FitWeights): number {
  let sum = 0
  let total = 0
  for (const dim of FIT_DIMENSIONS) {
    const c = components.find((x) => x.dimension === dim)
    if (!c) continue
    sum += clamp01(c.score) * weights[dim]
    total += weights[dim]
  }
  return total > 0 ? clamp01(sum / total) : 0
}

/** Recompute stored evaluations under new weights. Zero model calls. */
export function reweightFit<T extends { components: FitComponent[] }>(
  rows: T[],
  weights: Partial<FitWeights> | null
): (T & { overall: number; weights_used: FitWeights })[] {
  const w = resolveFitWeights(weights)
  return rows.map((r) => ({ ...r, weights_used: w, overall: computeFitOverall(r.components, w) }))
}

export type FitBand = 'STRONG' | 'GOOD' | 'MAYBE' | 'WEAK'

/** Bands derive from the number in code, so equal scores always read the same. */
export function fitBand(overall: number): FitBand {
  if (overall >= 0.75) return 'STRONG'
  if (overall >= 0.62) return 'GOOD'
  if (overall >= 0.48) return 'MAYBE'
  return 'WEAK'
}

export function isFitWeights(value: unknown): value is Partial<FitWeights> {
  if (!value || typeof value !== 'object') return false
  return Object.entries(value as Record<string, unknown>).every(
    ([k, v]) => FIT_DIMENSIONS.includes(k as FitDimension) && typeof v === 'number' && Number.isFinite(v) && v >= 0
  )
}
