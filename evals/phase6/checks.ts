// Phase 6 additional checks: BAD rate, research coverage, fact grounding.
//
// These sit alongside the four Phase 3 deterministic checks, which are reused
// unchanged so the two phases stay directly comparable.

import type { CheckResult, ScoredProspect } from '../phase3/checks'
import type { CompanyDossier, PersonDossier } from '@/lib/research/types'

export const PHASE6_THRESHOLDS = {
  /** Nothing that a careful advisor would strike off should reach the top 20. */
  badRate: 0.1,
  /** Grounded company context available for the final list. */
  researchCoverage: 0.95,
  /** Every factual claim used in scoring must carry a source. */
  factGrounding: 1.0,
} as const

export interface ResearchedProspect extends ScoredProspect {
  companyDossier: CompanyDossier | null
  personDossier: PersonDossier | null
}

/**
 * BAD rate@20 — the share of the final list a careful advisor would strike off.
 *
 * Precision measures how much is actively good; this measures how much is
 * actively wrong. They move independently: a list can be 50% GOOD with 0% BAD
 * (lots of defensible maybes) or 50% GOOD with 30% BAD (erratic). The second is
 * far worse for trust, because every BAD entry teaches the founder to
 * second-guess the whole list.
 */
export function checkBadRate(
  prospects: ResearchedProspect[],
  profiles: { precision: { bad: number } }[]
): CheckResult {
  const bad = profiles.reduce((n, p) => n + p.precision.bad, 0)
  const value = prospects.length ? bad / prospects.length : 0
  return {
    name: 'BAD rate@20',
    value,
    threshold: PHASE6_THRESHOLDS.badRate,
    pass: value <= PHASE6_THRESHOLDS.badRate,
    detail: `${bad}/${prospects.length} judged BAD (lower is better)`,
    failures: [],
  }
}

/** ≥95% of the final top 20 must have grounded company context. */
export function checkResearchCoverage(prospects: ResearchedProspect[]): CheckResult {
  const failures: string[] = []
  let covered = 0

  for (const p of prospects) {
    const d = p.companyDossier
    if (d && !d.research_failed && d.what_they_do.trim().length > 0) covered++
    else failures.push(`${p.person.name} @ ${p.person.company_name}: ${d ? 'research failed' : 'no dossier'}`)
  }

  const value = prospects.length ? covered / prospects.length : 0
  const withPerson = prospects.filter((p) => p.personDossier && !p.personDossier.research_failed).length

  return {
    name: 'Research coverage',
    value,
    threshold: PHASE6_THRESHOLDS.researchCoverage,
    pass: value >= PHASE6_THRESHOLDS.researchCoverage,
    detail: `${covered}/${prospects.length} have grounded company context · ${withPerson}/${prospects.length} also have person research`,
    failures: failures.slice(0, 8),
  }
}

/**
 * 100% of FACT-typed claims must carry a source URL.
 *
 * This is true by construction — `validateClaims()` downgrades an unsourced
 * FACT to INFERENCE before it can ever reach scoring — so this check is a
 * regression guard on that invariant rather than a hopeful measurement.
 */
export function checkFactGrounding(prospects: ResearchedProspect[]): CheckResult {
  let facts = 0
  let sourced = 0
  const failures: string[] = []

  for (const p of prospects) {
    for (const dossier of [p.companyDossier, p.personDossier]) {
      if (!dossier) continue
      for (const claim of dossier.claims) {
        if (claim.type !== 'FACT') continue
        facts++
        if (claim.source_url) sourced++
        else failures.push(`${p.person.name}: unsourced FACT "${claim.claim.slice(0, 70)}"`)
      }
    }
  }

  // No facts at all is vacuously "grounded" but worth surfacing honestly.
  const value = facts > 0 ? sourced / facts : 1
  return {
    name: 'Fact grounding',
    value,
    threshold: PHASE6_THRESHOLDS.factGrounding,
    pass: value >= PHASE6_THRESHOLDS.factGrounding,
    detail: facts > 0
      ? `${sourced}/${facts} FACT claims carry a source URL`
      : 'no FACT claims produced (vacuously true — check research is working)',
    failures: failures.slice(0, 6),
  }
}
