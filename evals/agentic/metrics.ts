// Metric computation for the agentic scouting eval — DETERMINISTIC.
//
// The judge supplies verdicts; every number below is arithmetic over those
// verdicts. Same split as the scorer: the model judges, the code computes.

import type { JudgeVerdict, SimpleVerdict } from './judge'
import type { DiscoveryRoundHistory } from '@/lib/agents/market-discovery'

export interface Thresholds {
  avgPrecision: number
  minProfilePrecision: number
  maxBadRate: number
  minDiscoveryPrecision: number
  minRejectionAccuracy: number
  minSearchRecovery: number
  minBestPersonHitRate: number
}

/** From the phase brief. NOT to be weakened to make a run pass. */
export const THRESHOLDS: Thresholds = {
  avgPrecision: 0.75,
  minProfilePrecision: 0.65,
  maxBadRate: 0.10,
  minDiscoveryPrecision: 0.80,
  minRejectionAccuracy: 0.90,
  minSearchRecovery: 0.80,
  minBestPersonHitRate: 0.70,
}

export interface PrecisionResult {
  n: number
  /** Both GOOD tiers combined — the Precision@20 numerator. */
  good: number
  goodHighEvidence: number
  goodRoleBased: number
  maybe: number
  bad: number
  /** GOOD / n. MAYBE counts as neither a hit nor a miss. */
  precision: number
  badRate: number
}

export function computePrecision(verdicts: JudgeVerdict[]): PrecisionResult {
  const n = verdicts.length
  // Both GOOD tiers count as GOOD. The split is reported separately so the list
  // can be read for how much of it rests on role fit alone, but a strong target
  // whom the internet happens to be quiet about is still a strong target.
  const goodHighEvidence = verdicts.filter((v) => v === 'GOOD_HIGH_EVIDENCE').length
  const goodRoleBased = verdicts.filter((v) => v === 'GOOD_ROLE_BASED').length
  const good = goodHighEvidence + goodRoleBased
  const maybe = verdicts.filter((v) => v === 'MAYBE').length
  const bad = verdicts.filter((v) => v === 'BAD').length
  return {
    n,
    good,
    goodHighEvidence,
    goodRoleBased,
    maybe,
    bad,
    precision: n > 0 ? good / n : 0,
    badRate: n > 0 ? bad / n : 0,
  }
}

/**
 * Company-level precision, used for both Market Discovery Precision and
 * Company Rejection Accuracy. MAYBE counts as half.
 *
 * Half-credit is the honest treatment here: a marginal company is neither the
 * clean win that GOOD implies nor the wasted credit that BAD implies, and
 * scoring it as either would misstate the funnel it feeds.
 */
export function computeCompanyRate(verdicts: SimpleVerdict[]): { n: number; rate: number; good: number; maybe: number; bad: number } {
  const n = verdicts.length
  const good = verdicts.filter((v) => v === 'GOOD').length
  const maybe = verdicts.filter((v) => v === 'MAYBE').length
  const bad = verdicts.filter((v) => v === 'BAD').length
  return { n, good, maybe, bad, rate: n > 0 ? (good + maybe * 0.5) / n : 0 }
}

// ─── Search recovery ─────────────────────────────────────────────────────────

export type RecoveryOutcome = 'recovered' | 'correctly_terminated' | 'failed' | 'not_applicable'

export interface RecoveryCase {
  segment: string
  rounds: number
  outcome: RecoveryOutcome
  detail: string
}

const UNHEALTHY = new Set([
  'DOMAIN_DRIFT',
  'SEARCH_TERM_AMBIGUITY',
  'LOW_SUPPLY',
  'WRONG_COMPANY_ARCHETYPE',
  'GEOGRAPHIC_OVERCONSTRAINT',
  'TITLE_MISMATCH',
])

const TERMINATIONS = new Set(['REJECT_HYPOTHESIS', 'REQUEST_NEW_HYPOTHESIS'])

/**
 * Did the agent recover from a bad search space, or correctly give up on it?
 *
 * A case only counts when a round actually diagnosed something unhealthy —
 * segments that were fine from the start are `not_applicable` and are excluded
 * from the denominator, so a run of easy segments cannot inflate the rate.
 *
 * Recovery means a LATER round produced companies after the bad diagnosis.
 * Correct termination means the agent killed the hypothesis instead of grinding.
 * Anything else — kept searching, kept finding nothing, ran out of rounds — is
 * a failure.
 */
export function classifyRecovery(history: { segment: string; rounds: DiscoveryRoundHistory[] }[]): RecoveryCase[] {
  const cases: RecoveryCase[] = []

  for (const { segment, rounds } of history) {
    const firstBad = rounds.findIndex((r) => UNHEALTHY.has(r.diagnosis))
    if (firstBad === -1) {
      cases.push({ segment, rounds: rounds.length, outcome: 'not_applicable', detail: 'no unhealthy diagnosis' })
      continue
    }

    const bad = rounds[firstBad]
    const after = rounds.slice(firstBad + 1)
    const keptAfter = after.reduce((s, r) => s + r.companies_kept, 0)

    if (keptAfter > 0) {
      cases.push({
        segment,
        rounds: rounds.length,
        outcome: 'recovered',
        detail: `${bad.diagnosis} at round ${bad.round} -> ${bad.action} -> ${keptAfter} companies in later rounds`,
      })
      continue
    }

    // Terminating on the bad round itself, or on any later round, is correct.
    const terminated = rounds.slice(firstBad).some((r) => TERMINATIONS.has(r.action))
    if (terminated) {
      cases.push({
        segment,
        rounds: rounds.length,
        outcome: 'correctly_terminated',
        detail: `${bad.diagnosis} -> hypothesis abandoned rather than ground through`,
      })
      continue
    }

    cases.push({
      segment,
      rounds: rounds.length,
      outcome: 'failed',
      detail: `${bad.diagnosis} at round ${bad.round}, action ${bad.action}, but no companies recovered and no termination`,
    })
  }

  return cases
}

export function recoveryRate(cases: RecoveryCase[]): { applicable: number; succeeded: number; rate: number } {
  const applicable = cases.filter((c) => c.outcome !== 'not_applicable')
  const succeeded = applicable.filter((c) => c.outcome === 'recovered' || c.outcome === 'correctly_terminated')
  return {
    applicable: applicable.length,
    succeeded: succeeded.length,
    rate: applicable.length > 0 ? succeeded.length / applicable.length : 1,
  }
}

// ─── Efficiency ──────────────────────────────────────────────────────────────

export interface EfficiencyResult {
  apolloSearchCalls: number
  enrichmentCredits: number
  peopleEnriched: number
  goodProspects: number
  enrichmentsPerGoodProspect: number
  webSearches: number
  modelCalls: number
  anthropicCostUsd: number
  costPerGoodProspect: number
}

export function computeEfficiency(input: {
  apolloSearchCalls: number
  enrichmentCredits: number
  peopleEnriched: number
  goodProspects: number
  webSearches: number
  modelCalls: number
  anthropicCostUsd: number
}): EfficiencyResult {
  const { goodProspects } = input
  return {
    ...input,
    enrichmentsPerGoodProspect: goodProspects > 0 ? input.enrichmentCredits / goodProspects : Infinity,
    costPerGoodProspect: goodProspects > 0 ? input.anthropicCostUsd / goodProspects : Infinity,
  }
}

export function pct(n: number): string {
  return Number.isFinite(n) ? `${(n * 100).toFixed(0)}%` : 'n/a'
}

/**
 * Average a rate across profiles, skipping those with an empty denominator.
 *
 * A profile that rejected no companies has no rejection accuracy — it is not
 * 0%. Averaging the zero in dragged the aggregate below threshold and would
 * have sent an iteration chasing a failure that did not exist. Returns NaN when
 * nothing is measurable, which `pct` renders as "n/a".
 */
export function averageWhereMeasured(samples: { n: number; rate: number }[]): { value: number; profiles: number } {
  const measured = samples.filter((s) => s.n > 0)
  if (measured.length === 0) return { value: NaN, profiles: 0 }
  return {
    value: measured.reduce((s, x) => s + x.rate, 0) / measured.length,
    profiles: measured.length,
  }
}
