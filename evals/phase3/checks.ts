// Automated eval checks with the Phase 3 pass thresholds.
//
// All four are DETERMINISTIC — no model involved. They measure whether the
// scouting pipeline produced structurally sound output, independent of whether
// the picks were good (that is the judge's job, in judge.ts).

import type { PersonCandidate, CompanyCandidate } from '@/lib/providers/types'
import { countResidualDuplicates } from '@/lib/scouting/dedupe'
import { assessSeniority } from '@/lib/scouting/seniority'
import type { ScoutScore } from '@/lib/scouting/score'

export const THRESHOLDS = {
  dataCompleteness: 0.95,
  duplicateRate: 0.02,
  seniorityCalibration: 0.8,
  resumeGrounding: 1.0,
  avgPrecisionAt20: 0.75,
  minProfilePrecisionAt20: 0.65,
} as const

export interface CheckResult {
  name: string
  value: number
  threshold: number
  pass: boolean
  detail: string
  failures: string[]
}

export interface ScoredProspect {
  candidateId: string
  person: PersonCandidate
  company: CompanyCandidate | null
  score: ScoutScore
}

// ─── 1. Data completeness ────────────────────────────────────────────────────

/**
 * Required: name, title, company, Apollo id, company relationship.
 * LinkedIn and email are TRACKED but never fail a prospect — Apollo does not
 * always expose them at this stage, and dropping otherwise-strong people for a
 * provider gap would distort the funnel.
 */
export function checkDataCompleteness(prospects: ScoredProspect[]): CheckResult {
  const failures: string[] = []
  let complete = 0

  for (const p of prospects) {
    const missing: string[] = []
    if (!p.person.name?.trim()) missing.push('name')
    if (!p.person.title?.trim()) missing.push('title')
    if (!p.person.company_name?.trim()) missing.push('company')
    if (!p.person.provenance.external_id) missing.push('apollo_id')
    // "Company relationship" = we can tie the person to a resolvable company.
    if (!p.person.company_domain && !p.company?.domain) missing.push('company_relationship')

    if (missing.length === 0) complete++
    else failures.push(`${p.person.name || p.candidateId}: missing ${missing.join(', ')}`)
  }

  const value = prospects.length ? complete / prospects.length : 0
  const withLinkedIn = prospects.filter((p) => p.person.linkedin_url).length
  const withEmail = prospects.filter((p) => p.person.email_status !== 'unavailable').length

  return {
    name: 'Data completeness',
    value,
    threshold: THRESHOLDS.dataCompleteness,
    pass: value >= THRESHOLDS.dataCompleteness,
    detail: `${complete}/${prospects.length} complete · LinkedIn ${withLinkedIn}/${prospects.length} (tracked, not required) · contactable ${withEmail}/${prospects.length}`,
    failures: failures.slice(0, 10),
  }
}

// ─── 2. Duplicate rate ───────────────────────────────────────────────────────

export function checkDuplicateRate(prospects: ScoredProspect[]): CheckResult {
  const people = prospects.map((p) => p.person)
  const duplicates = countResidualDuplicates(people)
  const value = people.length ? duplicates / people.length : 0

  return {
    name: 'Duplicate rate',
    value,
    threshold: THRESHOLDS.duplicateRate,
    pass: value < THRESHOLDS.duplicateRate,
    detail: `${duplicates}/${people.length} residual duplicates (cross-checked on LinkedIn URL and name+company)`,
    failures: [],
  }
}

// ─── 3. Seniority calibration ────────────────────────────────────────────────

/**
 * Appropriate != maximum. `assessSeniority` treats a C-suite exec at a
 * 40,000-person corporation as TOO SENIOR, because they will not answer a cold
 * student email. See lib/scouting/seniority.ts.
 */
export function checkSeniorityCalibration(prospects: ScoredProspect[]): CheckResult {
  const failures: string[] = []
  let appropriate = 0

  for (const p of prospects) {
    const employees = p.company?.employee_count ?? null
    const a = assessSeniority(p.person.seniority, p.person.title, employees)
    if (a.verdict === 'appropriate') appropriate++
    else {
      failures.push(
        `${p.person.name} (${p.person.title} @ ${p.person.company_name}, ~${employees ?? '?'} emp): ${a.verdict} — ${a.reason}`
      )
    }
  }

  const value = prospects.length ? appropriate / prospects.length : 0
  return {
    name: 'Seniority calibration',
    value,
    threshold: THRESHOLDS.seniorityCalibration,
    pass: value >= THRESHOLDS.seniorityCalibration,
    detail: `${appropriate}/${prospects.length} in a strategically appropriate band for their company size`,
    failures: failures.slice(0, 10),
  }
}

// ─── 4. Resume grounding ─────────────────────────────────────────────────────

/**
 * 100% of "why I fit them" explanations must reference a real resume item id.
 * The scorer already drops unknown ids into `ungrounded_ids`; a non-empty
 * `ungrounded_ids` means the model invented an experience, which is a hard fail.
 */
export function checkResumeGrounding(prospects: ScoredProspect[]): CheckResult {
  const failures: string[] = []
  let grounded = 0

  for (const p of prospects) {
    const { resume_item_ids, ungrounded_ids, why_i_fit_them } = p.score

    if (ungrounded_ids.length > 0) {
      failures.push(`${p.person.name}: cited non-existent resume ids [${ungrounded_ids.join(', ')}]`)
      continue
    }
    if (resume_item_ids.length === 0) {
      failures.push(`${p.person.name}: "why I fit them" cites no resume item`)
      continue
    }
    if (!why_i_fit_them.trim()) {
      failures.push(`${p.person.name}: empty "why I fit them"`)
      continue
    }
    grounded++
  }

  const value = prospects.length ? grounded / prospects.length : 0
  return {
    name: 'Resume grounding',
    value,
    threshold: THRESHOLDS.resumeGrounding,
    pass: value >= THRESHOLDS.resumeGrounding,
    detail: `${grounded}/${prospects.length} explanations cite only real resume items`,
    failures: failures.slice(0, 10),
  }
}

// ─── Precision@20 ────────────────────────────────────────────────────────────

export interface PrecisionResult {
  profileId: string
  good: number
  maybe: number
  bad: number
  judged: number
  precision: number
  pass: boolean
}

export function computePrecisionAt20(
  profileId: string,
  verdicts: ('GOOD' | 'MAYBE' | 'BAD')[]
): PrecisionResult {
  const good = verdicts.filter((v) => v === 'GOOD').length
  const maybe = verdicts.filter((v) => v === 'MAYBE').length
  const bad = verdicts.filter((v) => v === 'BAD').length
  // Denominator is 20 by definition, not the number judged: a profile that
  // could only produce 14 prospects has genuinely underperformed at @20.
  const precision = good / 20
  return {
    profileId,
    good,
    maybe,
    bad,
    judged: verdicts.length,
    precision,
    pass: precision >= THRESHOLDS.minProfilePrecisionAt20,
  }
}

export function runAllChecks(prospects: ScoredProspect[]): CheckResult[] {
  return [
    checkDataCompleteness(prospects),
    checkDuplicateRate(prospects),
    checkSeniorityCalibration(prospects),
    checkResumeGrounding(prospects),
  ]
}
