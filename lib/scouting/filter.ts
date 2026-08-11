// Deterministic pre-filtering.
//
// Apollo's keyword search is lexical, so a query for "manufacturing" happily
// returns job boards, staffing agencies and recruiting marketplaces whose
// descriptions merely CONTAIN the word. Discarding those in code is far cheaper
// and more reliable than paying a model to notice, and it protects the scoring
// budget for candidates that are genuinely in scope.
//
// This runs BEFORE any LLM sees a candidate. See docs/ARCHITECTURE.md §1.

import type { CompanyCandidate, PersonCandidate } from '@/lib/providers/types'
import { assessSeniority, IC_TITLE, type SeniorityAssessment } from './seniority'

// ─── Company filters ─────────────────────────────────────────────────────────

/**
 * Businesses that match industrial keywords lexically but can never host the
 * opportunity: they staff, list, or recruit FOR industry rather than doing it.
 */
const EXCLUDED_COMPANY_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\b(staffing|recruit(ing|ment)?|talent acquisition|headhunt|placement agency|manpower|temp agency)\b/i, reason: 'staffing/recruiting agency' },
  { pattern: /\b(job board|job search|careers? site|empleos|trabajos|vagas|jobbörse|job portal)\b/i, reason: 'job board' },
  { pattern: /\b(outsourcing|bpo|offshore development|staff augmentation)\b/i, reason: 'outsourcing/BPO' },
  { pattern: /\b(freelance marketplace|gig platform)\b/i, reason: 'gig marketplace' },
  { pattern: /\b(trade show|expo|conference organizer|trade association|chamber of commerce)\b/i, reason: 'events/association' },
  { pattern: /\b(directory|listings?|classifieds)\b/i, reason: 'directory/listings' },
]

/** Name-level tells that survive even when a description is missing. */
const EXCLUDED_NAME_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\b(staffing|recruiters?|recruiting|talent|hcm|hr solutions)\b/i, reason: 'staffing/recruiting agency' },
  { pattern: /\b(empleos|trabajos|jobs?|career[s]?|hiring)\b/i, reason: 'job board' },
  { pattern: /\b(university|college|school district|academy)\b/i, reason: 'educational institution' },
  { pattern: /\b(hospital|medical cent(er|re)|health system|clinic)\b/i, reason: 'healthcare provider' },
  { pattern: /\b(government|municipal|city of|county of|department of)\b/i, reason: 'government body' },
]

/**
 * People who are themselves still in training.
 *
 * They cannot create a role, sponsor a project, or make a referral that carries
 * weight — which is the entire test. A "Research Assistant, Masters Student"
 * reached a published top-20 because IC_TITLE happens to contain "associate" and
 * "intern" but not "student" or "research assistant".
 *
 * Deliberately narrow and phrase-anchored. A bare /\bassistant\b/ would reject
 * "Assistant Director of Manufacturing", who is a perfectly good target.
 */
const TRAINEE_TITLE =
  /\b(student|phd candidate|doctoral candidate|undergraduate|research assistant|teaching assistant|graduate assistant|trainee|apprentice|co-?op)\b/i

export type CompanyRejectReason =
  | 'excluded_business_type'
  | 'no_domain'
  | 'too_small'
  | 'too_large'
  | 'geography'
  | 'off_domain'
  | null

export interface CompanyFilterResult {
  keep: boolean
  reason: CompanyRejectReason
  detail: string | null
}

export interface CompanyFilterOptions {
  minEmployees?: number
  maxEmployees?: number
  /** Lowercased country substrings to allow. Empty = allow all. */
  allowedCountries?: string[]
  requireDomain?: boolean
  /**
   * Lowercased substrings; the company must match at least one across its name,
   * description, industry or keywords.
   *
   * Apollo's keyword tags are lexical, so some keyword spaces are extremely
   * noisy: "operations consulting" returns golf-club, hospitality and mortgage
   * advisories alongside industrial ones, and "manufacturing consulting"
   * returns real-estate and lighting firms. A required-domain check is a cheap
   * deterministic way to demand actual evidence of the target domain rather
   * than trusting the provider's tag. Empty = no requirement.
   */
  requiredDomainTerms?: string[]
}

export function filterCompany(
  company: CompanyCandidate,
  opts: CompanyFilterOptions = {}
): CompanyFilterResult {
  const {
    minEmployees,
    maxEmployees,
    allowedCountries = [],
    requireDomain = true,
    requiredDomainTerms = [],
  } = opts

  const haystack = `${company.name} ${company.description ?? ''} ${company.industry ?? ''} ${company.sub_industries.join(' ')}`

  for (const { pattern, reason } of EXCLUDED_COMPANY_PATTERNS) {
    if (pattern.test(haystack)) {
      return { keep: false, reason: 'excluded_business_type', detail: reason }
    }
  }
  for (const { pattern, reason } of EXCLUDED_NAME_PATTERNS) {
    if (pattern.test(company.name)) {
      return { keep: false, reason: 'excluded_business_type', detail: reason }
    }
  }

  if (requireDomain && !company.domain) {
    return { keep: false, reason: 'no_domain', detail: 'no resolvable domain — cannot dedupe or research' }
  }

  if (company.employee_count != null) {
    if (minEmployees != null && company.employee_count < minEmployees) {
      return { keep: false, reason: 'too_small', detail: `${company.employee_count} employees` }
    }
    if (maxEmployees != null && company.employee_count > maxEmployees) {
      return { keep: false, reason: 'too_large', detail: `${company.employee_count} employees` }
    }
  }

  if (allowedCountries.length > 0 && company.country) {
    const country = company.country.toLowerCase()
    if (!allowedCountries.some((c) => country.includes(c))) {
      return { keep: false, reason: 'geography', detail: company.country }
    }
  }

  if (requiredDomainTerms.length > 0) {
    const lower = haystack.toLowerCase()
    if (!requiredDomainTerms.some((term) => lower.includes(term))) {
      return {
        keep: false,
        reason: 'off_domain',
        detail: 'no evidence of the target domain in name, description, industry or keywords',
      }
    }
  }

  return { keep: true, reason: null, detail: null }
}

// ─── Person filters ──────────────────────────────────────────────────────────

/**
 * Functions that can NEVER host or sponsor a technical project, no matter what
 * adjective precedes them. "Technical Recruiter" is still a recruiter.
 *
 * These are deliberately NOT overridable — an earlier version let the
 * RELEVANT_OVERRIDE term "technical" rescue "Technical Recruiter", which is
 * exactly the person we must exclude.
 */
const HARD_EXCLUDED_FUNCTION = new RegExp(
  [
    '\\b(recruit(er|ing|ment)|talent acquisition|talent partner|hr business partner|human resources|people ops|people operations)\\b',
    '\\b(legal|general counsel|attorney|paralegal)\\b',
    '\\b(accounting|accounts payable|accounts receivable|payroll|bookkeep|controller|treasurer)\\b',
    '\\b(customer support|help desk|call cent|receptionist)\\b',
    '\\b(janitorial|security guard|custodian)\\b',
  ].join('|'),
  'i'
)

/**
 * Functions that are usually irrelevant but can be rescued when the title also
 * carries genuine technical or operational ownership — a "VP of AI Solutions
 * Engineering" sitting in a commercial org is still worth contacting.
 */
const SOFT_EXCLUDED_FUNCTION = new RegExp(
  [
    '\\b(sales|account executive|account manager|business development|bdr|sdr)\\b',
    '\\b(marketing|brand|communications|public relations|social media|content)\\b',
    '\\b(facilities|maintenance technician)\\b',
    '\\b(compliance officer)\\b',
  ].join('|'),
  'i'
)

/**
 * Strong ownership signals only. Deliberately excludes bare adjectives like
 * "technical", which are too weak to rescue an excluded function.
 */
const RELEVANT_OVERRIDE =
  /\b(engineering|manufacturing|operations|product|technology|r&d|research|innovation|ai|artificial intelligence|machine learning|data science|automation|process|quality|supply chain|digital|transformation|strategy|sustainability|solutions architect|solutions engineering|chemical|materials|energy)\b/i

export type PersonRejectReason =
  | 'irrelevant_function'
  | 'seniority'
  | 'missing_identity'
  | 'no_company'
  | null

export interface PersonFilterResult {
  keep: boolean
  reason: PersonRejectReason
  detail: string | null
  seniority: SeniorityAssessment
}

export function filterPerson(
  person: PersonCandidate,
  companyEmployeeCount: number | null
): PersonFilterResult {
  const seniority = assessSeniority(person.seniority, person.title, companyEmployeeCount)
  const title = person.title ?? ''

  if (!person.name || !person.title) {
    return { keep: false, reason: 'missing_identity', detail: 'no name or title', seniority }
  }
  if (!person.company_name) {
    return { keep: false, reason: 'no_company', detail: 'no company relation', seniority }
  }

  if (HARD_EXCLUDED_FUNCTION.test(title)) {
    return { keep: false, reason: 'irrelevant_function', detail: 'recruiting/HR/legal/finance/support function', seniority }
  }

  if (SOFT_EXCLUDED_FUNCTION.test(title) && !RELEVANT_OVERRIDE.test(title)) {
    return { keep: false, reason: 'irrelevant_function', detail: 'commercial function with no technical ownership', seniority }
  }

  if (seniority.verdict === 'too_junior' || seniority.verdict === 'too_senior') {
    return { keep: false, reason: 'seniority', detail: seniority.reason, seniority }
  }

  return { keep: true, reason: null, detail: null, seniority }
}

// ─── Cheap stub filter (Phase 6) ─────────────────────────────────────────────

/**
 * Free pre-enrichment filter, applied to obfuscated search stubs.
 *
 * A stub carries only a title and a company name — but that is enough to
 * discard the two largest categories of waste before spending a lead credit:
 * non-technical functions, and companies that can never host the opportunity.
 *
 * Deliberately CONSERVATIVE. A false negative here costs a good prospect
 * permanently and invisibly, while a false positive only costs one credit and
 * gets caught by the researched company filter downstream. When in doubt, keep.
 */
export function stubPassesCheapFilter(
  title: string | null,
  companyName: string | null
): { keep: boolean; reason: string | null; detail: string | null } {
  const t = title ?? ''

  if (!t.trim()) return { keep: false, reason: 'missing_identity', detail: 'no title' }

  // Checked before everything else: no seniority override can rescue someone who
  // is still in training, because the question is whether they could act on this.
  if (TRAINEE_TITLE.test(t)) {
    return { keep: false, reason: 'seniority', detail: `student/trainee title "${t}"` }
  }

  if (HARD_EXCLUDED_FUNCTION.test(t)) {
    return { keep: false, reason: 'irrelevant_function', detail: 'recruiting/HR/legal/finance/support' }
  }
  if (SOFT_EXCLUDED_FUNCTION.test(t) && !RELEVANT_OVERRIDE.test(t)) {
    return { keep: false, reason: 'irrelevant_function', detail: 'commercial function, no technical ownership' }
  }

  // Obvious individual-contributor titles cannot sponsor or refer.
  if (IC_TITLE.test(t) && !/\b(head|director|vp|vice president|chief|founder|owner|partner|principal|president)\b/i.test(t)) {
    return { keep: false, reason: 'seniority', detail: `IC title "${t}"` }
  }

  if (companyName) {
    for (const { pattern, reason } of EXCLUDED_NAME_PATTERNS) {
      if (pattern.test(companyName)) {
        return { keep: false, reason: 'excluded_business_type', detail: reason }
      }
    }
  }

  return { keep: true, reason: null, detail: null }
}

// ─── Diagnostics ─────────────────────────────────────────────────────────────

export interface FilterStats {
  seen: number
  kept: number
  rejected: Record<string, number>
}

export function newFilterStats(): FilterStats {
  return { seen: 0, kept: 0, rejected: {} }
}

export function recordFilter(stats: FilterStats, keep: boolean, reason: string | null, detail?: string | null): void {
  stats.seen++
  if (keep) {
    stats.kept++
    return
  }
  const key = detail ? `${reason}:${detail}` : (reason ?? 'unknown')
  stats.rejected[key] = (stats.rejected[key] ?? 0) + 1
}
