// The scouting pipeline: Apollo -> filter -> dedupe -> candidate pool.
//
// Everything here is DETERMINISTIC. Scoring (the only judgment step) happens
// afterwards in lib/scouting/score.ts. Keeping them separate lets an eval
// iteration re-score a frozen candidate pool without touching Apollo.
//
// ─── PEOPLE-FIRST BY DESIGN (iteration 1 finding) ──────────────────────────
// Apollo's company search matches keyword tags against company NAMES, so
// company-first discovery returned magazines, conferences and certification
// bodies rather than operating companies. People-first inverts this: the title
// filter anchors each query to a real operating company, and the enriched
// person record embeds a RICHER org payload than company search returns
// (industry, employee count, keywords, description) — so company data comes
// back for free, with no separate search or enrichment call.
//
// The CompanyProvider interface remains and is still exercised
// (`enrichOrganization` backfills gaps), so adding PitchBook later does not
// require touching this pipeline.

import type { CompanyCandidate, PersonCandidate, PeopleSearchQuery } from '@/lib/providers/types'
import { apolloPeopleProvider, type PersonStub } from '@/lib/providers/apollo/people'
import { enrichOrganization } from '@/lib/providers/apollo/organizations'
import { normalizeDomain } from '@/lib/providers/apollo/normalize'
import { dedupeCompanies, dedupePeople, companyKey } from './dedupe'
import {
  filterCompany,
  filterPerson,
  newFilterStats,
  recordFilter,
  type CompanyFilterOptions,
  type FilterStats,
} from './filter'

/** Mirrors evals/phase3/mission.ts PeopleQuerySpec without importing eval code. */
export interface ScoutQuery {
  titles: string[]
  seniorities: string[]
  orgKeywords?: string[]
  employeeMin?: number
  employeeMax?: number
  locations?: string[]
  pages?: number
}

export interface ScoutOptions {
  /** Hard cap on people enriched per profile — the real credit budget knob. */
  maxPeopleToEnrich: number
  /** Cap on organizations/enrich calls per profile (description hydration). */
  maxCompaniesToHydrate: number
  companyFilter: CompanyFilterOptions
}

export const DEFAULT_SCOUT_OPTIONS: ScoutOptions = {
  maxPeopleToEnrich: 140,
  maxCompaniesToHydrate: 140,
  companyFilter: { requireDomain: false, allowedCountries: [] },
}

export interface ScoutDiagnostics {
  queriesRun: number
  stubsFound: number
  stubsUnique: number
  peopleEnriched: number
  peopleAfterFilter: number
  peopleAfterDedupe: number
  companiesDerived: number
  companiesHydrated: number
  companiesHydrationRejected: number
  companiesAfterFilter: number
  personFilterStats: FilterStats
  companyFilterStats: FilterStats
}

export interface ScoutResult {
  companies: CompanyCandidate[]
  companiesByKey: Map<string, CompanyCandidate>
  people: PersonCandidate[]
  diagnostics: ScoutDiagnostics
}

export function newDiagnostics(): ScoutDiagnostics {
  return {
    queriesRun: 0,
    stubsFound: 0,
    stubsUnique: 0,
    peopleEnriched: 0,
    peopleAfterFilter: 0,
    peopleAfterDedupe: 0,
    companiesDerived: 0,
    companiesHydrated: 0,
    companiesHydrationRejected: 0,
    companiesAfterFilter: 0,
    personFilterStats: newFilterStats(),
    companyFilterStats: newFilterStats(),
  }
}

function toSearchQuery(spec: ScoutQuery, page: number): PeopleSearchQuery & Record<string, unknown> {
  return {
    title_patterns: spec.titles,
    seniorities: spec.seniorities,
    locations: spec.locations,
    page,
    per_page: 25,
    // Passed through to the Apollo body builder as org-level context.
    org_keywords: spec.orgKeywords,
    employee_min: spec.employeeMin,
    employee_max: spec.employeeMax,
  } as PeopleSearchQuery & Record<string, unknown>
}

/** Stage 1: collect obfuscated identifier stubs across all queries. */
export async function collectStubs(
  queries: ScoutQuery[],
  diag: ScoutDiagnostics
): Promise<PersonStub[]> {
  const seen = new Set<string>()
  const stubs: PersonStub[] = []

  for (const spec of queries) {
    const pages = spec.pages ?? 1
    for (let page = 1; page <= pages; page++) {
      diag.queriesRun++
      const result = await apolloPeopleProvider.searchStubs(toSearchQuery(spec, page))
      diag.stubsFound += result.items.length
      for (const stub of result.items) {
        if (seen.has(stub.apollo_id)) continue
        seen.add(stub.apollo_id)
        stubs.push(stub)
      }
      // No more pages available — stop paging this query early.
      if (result.items.length === 0) break
    }
  }

  diag.stubsUnique = stubs.length
  return stubs
}

/** Company payload embedded in an enriched person record. */
function companyFromPerson(person: PersonCandidate): CompanyCandidate | null {
  const org = person.raw?.organization as Record<string, unknown> | undefined
  if (!org?.name) return null

  const domain = normalizeDomain(
    (org.primary_domain as string) ?? (org.website_url as string) ?? person.company_domain ?? undefined
  )

  return {
    name: String(org.name),
    domain,
    description: (org.short_description as string) ?? (org.seo_description as string) ?? null,
    industry: (org.industry as string) ?? null,
    sub_industries: Array.isArray(org.keywords) ? (org.keywords as string[]).slice(0, 25) : [],
    employee_count: typeof org.estimated_num_employees === 'number' ? org.estimated_num_employees : null,
    employee_range: null,
    stage: null,
    founded_year: typeof org.founded_year === 'number' ? org.founded_year : null,
    hq_location: [org.city, org.state, org.country].filter(Boolean).join(', ') || null,
    country: (org.country as string) ?? null,
    website_url: (org.website_url as string) ?? null,
    linkedin_url: (org.linkedin_url as string) ?? null,
    raw: org,
    provenance: {
      provider_id: 'apollo',
      external_id: org.id as string | undefined,
      retrieved_at: new Date().toISOString(),
    },
  }
}

/**
 * Fill in company descriptions.
 *
 * ITERATION 1 FINDING: the `organization` payload embedded in
 * `people/bulk_match` carries NO description at all — 0/140 companies had one.
 * Both the scorer and the judge were therefore reasoning from company name plus
 * keywords, which is why the judge kept rejecting otherwise-good prospects as
 * "too generic to show a clear niche". `organizations/enrich` does return a
 * real description, so this call is what makes domain discrimination possible.
 *
 * Guarded by a name match: Apollo occasionally resolves a domain to a different
 * company with a similar name (atomicindustries.com is a Montana laser-cutting
 * shop, not the AI tool-and-die startup). Injecting the wrong description would
 * be worse than having none.
 */
async function hydrateDescriptions(
  companies: CompanyCandidate[],
  limit: number
): Promise<{ companies: CompanyCandidate[]; hydrated: number; rejected: number }> {
  let hydrated = 0
  let rejected = 0
  const out: CompanyCandidate[] = []

  for (const company of companies) {
    const needsDescription = !company.description || company.description.length < 80
    if (!needsDescription || !company.domain || hydrated + rejected >= limit) {
      out.push(company)
      continue
    }

    const full = await enrichOrganization(company.domain)
    if (!full) {
      out.push(company)
      continue
    }

    if (!namesMatch(company.name, full.name)) {
      rejected++
      out.push(company)
      continue
    }

    hydrated++
    out.push({
      ...company,
      description: full.description ?? company.description,
      industry: company.industry ?? full.industry,
      employee_count: company.employee_count ?? full.employee_count,
      founded_year: company.founded_year ?? full.founded_year,
      hq_location: company.hq_location ?? full.hq_location,
      sub_industries: full.sub_industries.length ? full.sub_industries : company.sub_industries,
    })
  }

  return { companies: out, hydrated, rejected }
}

function namesMatch(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return false
  return x === y || x.includes(y) || y.includes(x)
}

/** Full deterministic scout for one search profile. */
export async function scoutProfile(
  queries: ScoutQuery[],
  opts: ScoutOptions = DEFAULT_SCOUT_OPTIONS
): Promise<ScoutResult> {
  const diagnostics = newDiagnostics()

  const stubs = await collectStubs(queries, diagnostics)
  const enriched = await apolloPeopleProvider.enrichMany(
    stubs.slice(0, opts.maxPeopleToEnrich).map((s) => s.apollo_id)
  )
  diagnostics.peopleEnriched = enriched.items.length

  // Derive companies first — the person filter needs employee count for
  // size-aware seniority calibration.
  const derivedCompanies: CompanyCandidate[] = []
  for (const person of enriched.items) {
    const company = companyFromPerson(person)
    if (company) derivedCompanies.push(company)
  }
  const deduped = dedupeCompanies(derivedCompanies)
  diagnostics.companiesDerived = deduped.unique.length

  // Filter BEFORE hydrating. The junk-company rules key on name, industry and
  // keywords — all present without enrichment — so filtering first avoids
  // spending an organizations/enrich call on every staffing agency and
  // university we were going to discard anyway.
  const survivingCompanies: CompanyCandidate[] = []
  const rejectedCompanyKeys = new Set<string>()
  for (const company of deduped.unique) {
    const verdict = filterCompany(company, opts.companyFilter)
    recordFilter(diagnostics.companyFilterStats, verdict.keep, verdict.reason, verdict.detail)
    if (verdict.keep) survivingCompanies.push(company)
    else rejectedCompanyKeys.add(companyKey(company))
  }

  const keptPeople: PersonCandidate[] = []
  for (const person of enriched.items) {
    const company = companyFromPerson(person)
    const key = company ? companyKey(company) : null

    // A person at a company we rejected (staffing agency, university, ...) is
    // rejected with them — the company decision governs.
    if (key && rejectedCompanyKeys.has(key)) {
      recordFilter(diagnostics.personFilterStats, false, 'no_company', 'company rejected by filter')
      continue
    }

    const verdict = filterPerson(person, company?.employee_count ?? null)
    recordFilter(diagnostics.personFilterStats, verdict.keep, verdict.reason, verdict.detail)
    if (verdict.keep) keptPeople.push(person)
  }
  diagnostics.peopleAfterFilter = keptPeople.length

  const { unique: uniquePeople } = dedupePeople(keptPeople)
  diagnostics.peopleAfterDedupe = uniquePeople.length

  // Hydrate only companies that still have a surviving person — descriptions
  // exist to help the scorer, and a company with no candidate is never scored.
  const neededKeys = new Set<string>()
  for (const person of uniquePeople) {
    const company = companyFromPerson(person)
    if (company) neededKeys.add(companyKey(company))
  }
  const toHydrate = survivingCompanies.filter((c) => neededKeys.has(companyKey(c)))

  const hydration = await hydrateDescriptions(toHydrate, opts.maxCompaniesToHydrate)
  diagnostics.companiesHydrated = hydration.hydrated
  diagnostics.companiesHydrationRejected = hydration.rejected
  diagnostics.companiesAfterFilter = hydration.companies.length

  const companiesByKey = new Map<string, CompanyCandidate>()
  for (const c of hydration.companies) companiesByKey.set(companyKey(c), c)

  return { companies: hydration.companies, companiesByKey, people: uniquePeople, diagnostics }
}
