// Seniority normalization and STRATEGIC calibration.
//
// The product rule (docs/PRODUCT.md §5): appropriate seniority is NOT maximum
// seniority. A Director who owns the relevant initiative outranks a CEO who
// does not, and a C-suite exec at a 40,000-person corporation is effectively
// unreachable for a cold student email — while the CEO of a 25-person startup
// answers their own inbox.
//
// So appropriateness is a function of (seniority, company size), not seniority
// alone. This file encodes that as deterministic code because it is a rule, not
// a judgment call.

export type Seniority =
  | 'owner'
  | 'founder'
  | 'c_suite'
  | 'partner'
  | 'vp'
  | 'head'
  | 'director'
  | 'manager'
  | 'senior'
  | 'entry'
  | 'intern'
  | 'unknown'

export type SeniorityVerdict = 'appropriate' | 'too_senior' | 'too_junior' | 'unknown'

export type CompanySizeBand = 'micro' | 'small' | 'mid' | 'large' | 'enterprise' | 'unknown'

const KNOWN: Seniority[] = [
  'owner', 'founder', 'c_suite', 'partner', 'vp', 'head',
  'director', 'manager', 'senior', 'entry', 'intern',
]

export function normalizeSeniority(raw: string | null | undefined): Seniority {
  const v = (raw ?? '').toLowerCase().trim().replace(/[\s-]+/g, '_')
  return (KNOWN as string[]).includes(v) ? (v as Seniority) : 'unknown'
}

export function sizeBand(employeeCount: number | null | undefined): CompanySizeBand {
  if (employeeCount == null || employeeCount <= 0) return 'unknown'
  if (employeeCount < 50) return 'micro'
  if (employeeCount < 200) return 'small'
  if (employeeCount < 2000) return 'mid'
  if (employeeCount < 10000) return 'large'
  return 'enterprise'
}

/**
 * Titles that read as senior-manager-and-relevant. The mission explicitly
 * allows "highly relevant Senior Managers", so a plain `manager` seniority is
 * rescued when the title carries real scope.
 */
const STRONG_MANAGER_TITLE =
  /\b(senior|sr\.?|principal|lead|global|group|plant|site|program)\b.*\bmanager\b|\bmanager\b.*\b(operations|manufacturing|innovation|digital|ai|automation|process|r&d|strategy|transformation)\b/i

/**
 * Titles that indicate an individual contributor or a non-decision role even
 * when Apollo reports a senior-sounding band.
 */
const IC_TITLE = /\b(engineer|scientist|analyst|specialist|associate|consultant|developer|researcher|technician|intern)\b/i

const SIZE_RULES: Record<CompanySizeBand, { appropriate: Seniority[]; tooSenior: Seniority[] }> = {
  // Founder-led and tiny: the top of the company is the right door.
  micro: {
    appropriate: ['owner', 'founder', 'c_suite', 'partner', 'vp', 'head', 'director'],
    tooSenior: [],
  },
  small: {
    appropriate: ['owner', 'founder', 'c_suite', 'partner', 'vp', 'head', 'director'],
    tooSenior: [],
  },
  // Mid-size: leadership is still reachable, but the CEO is getting busy.
  mid: {
    appropriate: ['founder', 'partner', 'vp', 'head', 'director'],
    tooSenior: [],
  },
  // Large: a VP still owns real scope; the C-suite does not read cold student mail.
  large: {
    appropriate: ['partner', 'vp', 'head', 'director'],
    tooSenior: ['c_suite', 'owner'],
  },
  // Enterprise: Directors and Heads are the operative decision layer.
  enterprise: {
    appropriate: ['partner', 'head', 'director', 'vp'],
    tooSenior: ['c_suite', 'owner'],
  },
  unknown: {
    appropriate: ['owner', 'founder', 'c_suite', 'partner', 'vp', 'head', 'director'],
    tooSenior: [],
  },
}

const TOO_JUNIOR: Seniority[] = ['senior', 'entry', 'intern']

export interface SeniorityAssessment {
  seniority: Seniority
  band: CompanySizeBand
  verdict: SeniorityVerdict
  reason: string
}

export function assessSeniority(
  rawSeniority: string | null | undefined,
  title: string | null | undefined,
  employeeCount: number | null | undefined
): SeniorityAssessment {
  const seniority = normalizeSeniority(rawSeniority)
  const band = sizeBand(employeeCount)
  const rules = SIZE_RULES[band]
  const t = title ?? ''

  if (seniority === 'unknown') {
    return { seniority, band, verdict: 'unknown', reason: 'Apollo did not report a seniority band' }
  }

  if (TOO_JUNIOR.includes(seniority)) {
    return {
      seniority,
      band,
      verdict: 'too_junior',
      reason: `"${seniority}" has no authority to create or sponsor an opportunity`,
    }
  }

  if (seniority === 'manager') {
    if (STRONG_MANAGER_TITLE.test(t) && !IC_TITLE.test(t)) {
      return {
        seniority,
        band,
        verdict: 'appropriate',
        reason: 'Senior/functional manager with relevant scope — allowed by the mission',
      }
    }
    return { seniority, band, verdict: 'too_junior', reason: 'Line manager without clear scope' }
  }

  if (rules.tooSenior.includes(seniority)) {
    return {
      seniority,
      band,
      verdict: 'too_senior',
      reason: `${seniority} at a ${band} company (~${employeeCount} employees) is not realistically reachable by cold outreach`,
    }
  }

  if (rules.appropriate.includes(seniority)) {
    // Guard against Apollo mislabeling an IC with a senior band.
    if (IC_TITLE.test(t) && !/\b(head|director|vp|vice president|chief|founder|partner|principal)\b/i.test(t)) {
      return { seniority, band, verdict: 'too_junior', reason: `Title "${t}" reads as an individual contributor` }
    }
    return { seniority, band, verdict: 'appropriate', reason: `${seniority} at a ${band} company owns relevant scope` }
  }

  return { seniority, band, verdict: 'unknown', reason: 'No rule matched' }
}
