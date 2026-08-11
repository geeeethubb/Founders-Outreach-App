// Phase 6 scouting pipeline — research-before-enrichment.
//
// ─── WHY THE ORDER CHANGED ─────────────────────────────────────────────────
// Phase 3 enriched ~140 Apollo people per profile BEFORE knowing whether their
// companies were worth anything, then discovered at scoring time that many were
// golf-club advisories and hospitality consultancies. Enrichment is the only
// hard-currency step (one lead credit per person, and the account ran dry), so
// spending it on candidates that were never viable is the expensive mistake.
//
// The new order spends cheap signal first and buys credits last:
//
//   DISCOVER              Apollo people search — obfuscated stubs, no credits
//   CHEAP FILTER          deterministic, on stub title + company name — free
//   COMPANY RESEARCH      one grounded web call per unique company
//   PRELIMINARY RELEVANCE the researcher's own mission-relevance verdict
//   SHORTLIST             keep people only at companies that survived
//   APOLLO ENRICHMENT     credits spent ONLY here, on the shortlist
//   PERSON RESEARCH       grounded web call per shortlisted person
//   FINAL SCORE           scoring now reasons over evidence, not keywords
//
// Stubs carry a company NAME (not a domain), which is enough to research a
// company by name. That is what makes research-before-enrichment possible at
// all — see `stubCompanyCandidate`.

import type { CompanyCandidate, PersonCandidate } from '@/lib/providers/types'
import { apolloPeopleProvider, type PersonStub } from '@/lib/providers/apollo/people'
import { normalizeCompanyName } from '@/lib/providers/apollo/normalize'
import { researchCompany } from '@/lib/research/company'
import { researchPerson } from '@/lib/research/person'
import type { CompanyDossier, PersonDossier } from '@/lib/research/types'
import { companyKey, dedupePeople } from './dedupe'
import { mapWithConcurrency } from './concurrency'
import {
  filterCompany,
  filterPerson,
  newFilterStats,
  recordFilter,
  stubPassesCheapFilter,
  type CompanyFilterOptions,
  type FilterStats,
} from './filter'
import type { ScoutQuery } from './pipeline'
import { collectStubs, allocateBudget, newDiagnostics as newBaseDiagnostics } from './pipeline'

export interface ScoutV2Options {
  /** Unique companies researched per profile. The main web-cost knob. */
  maxCompaniesToResearch: number
  /** Apollo enrichment cap — the credit budget, spent only on the shortlist. */
  maxPeopleToEnrich: number
  /** People given a person-research call. Applied after enrichment. */
  maxPeopleToResearch: number
  companyFilter: CompanyFilterOptions
  /** Concurrency for the research calls, which are latency-bound. */
  researchConcurrency: number
}

export const DEFAULT_SCOUT_V2_OPTIONS: ScoutV2Options = {
  maxCompaniesToResearch: Number(process.env.MAX_COMPANIES_TO_RESEARCH ?? 130),
  maxPeopleToEnrich: 140,
  maxPeopleToResearch: 60,
  companyFilter: { requireDomain: false, allowedCountries: [] },
  // Each grounded call is a real web search plus reasoning — 20-40s of mostly
  // waiting. At concurrency 6 a 90-company profile took ~30 minutes, which is
  // too slow to iterate on. These calls are latency-bound, not compute-bound,
  // so raising this is close to free; retries with backoff absorb any 429s.
  researchConcurrency: Number(process.env.RESEARCH_CONCURRENCY ?? 14),
}

export interface ScoutV2Diagnostics {
  queriesRun: number
  stubsFound: number
  stubsUnique: number
  stubsAfterCheapFilter: number
  stubFilterStats: FilterStats
  companiesSeen: number
  companiesResearched: number
  companiesMissionRelevant: number
  companiesRejectedByResearch: number
  companiesResearchFailed: number
  shortlistedStubs: number
  peopleEnriched: number
  peopleEnrichmentMissing: number
  peopleAfterFilter: number
  peopleAfterDedupe: number
  peopleResearched: number
  personFilterStats: FilterStats
  companyFilterStats: FilterStats
}

export function newV2Diagnostics(): ScoutV2Diagnostics {
  return {
    queriesRun: 0,
    stubsFound: 0,
    stubsUnique: 0,
    stubsAfterCheapFilter: 0,
    stubFilterStats: newFilterStats(),
    companiesSeen: 0,
    companiesResearched: 0,
    companiesMissionRelevant: 0,
    companiesRejectedByResearch: 0,
    companiesResearchFailed: 0,
    shortlistedStubs: 0,
    peopleEnriched: 0,
    peopleEnrichmentMissing: 0,
    peopleAfterFilter: 0,
    peopleAfterDedupe: 0,
    peopleResearched: 0,
    personFilterStats: newFilterStats(),
    companyFilterStats: newFilterStats(),
  }
}

export interface ScoutV2Usage {
  web_searches: number
  research_llm_calls: number
  research_tokens_in: number
  research_tokens_out: number
}

export interface ScoutV2Result {
  people: PersonCandidate[]
  companiesByKey: Map<string, CompanyCandidate>
  companyDossiers: Map<string, CompanyDossier>
  personDossiers: Map<string, PersonDossier>
  diagnostics: ScoutV2Diagnostics
  usage: ScoutV2Usage
}

/**
 * A minimal company candidate built from a stub's company name alone.
 *
 * Stubs are obfuscated and carry no domain, so this is deliberately thin — it
 * exists purely to give the research agent something to search for before any
 * credit is spent. The dossier that comes back is what carries the real signal.
 */
function stubCompanyCandidate(name: string): CompanyCandidate {
  return {
    name,
    domain: null,
    description: null,
    industry: null,
    sub_industries: [],
    employee_count: null,
    employee_range: null,
    stage: null,
    founded_year: null,
    hq_location: null,
    country: null,
    website_url: null,
    linkedin_url: null,
    raw: {},
    provenance: { provider_id: 'apollo', retrieved_at: new Date().toISOString() },
  }
}

function stubCompanyKey(name: string): string {
  return `n:${normalizeCompanyName(name) ?? name.toLowerCase()}`
}

function personKeyOf(person: PersonCandidate): string {
  return person.provenance.external_id
    ? `a:${person.provenance.external_id}`
    : `n:${person.name.toLowerCase()}|${(person.company_name ?? '').toLowerCase()}`
}

/** Company payload embedded in an enriched person record. */
function companyFromPerson(person: PersonCandidate): CompanyCandidate | null {
  const org = person.raw?.organization as Record<string, unknown> | undefined
  if (!org?.name) return null
  return {
    name: String(org.name),
    domain: person.company_domain,
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

export async function scoutProfileV2(
  queries: ScoutQuery[],
  opts: ScoutV2Options = DEFAULT_SCOUT_V2_OPTIONS
): Promise<ScoutV2Result> {
  const diagnostics = newV2Diagnostics()
  const usage: ScoutV2Usage = {
    web_searches: 0, research_llm_calls: 0, research_tokens_in: 0, research_tokens_out: 0,
  }

  // ── 1. DISCOVER — obfuscated stubs, no credits ──
  const base = newBaseDiagnostics()
  const stubGroups = await collectStubs(queries, base)
  diagnostics.queriesRun = base.queriesRun
  diagnostics.stubsFound = base.stubsFound
  diagnostics.stubsUnique = base.stubsUnique

  // ── 2. CHEAP FILTER — free, on stub title + company name ──
  const survivingGroups: PersonStub[][] = []
  for (const group of stubGroups) {
    const kept: PersonStub[] = []
    for (const stub of group) {
      const verdict = stubPassesCheapFilter(stub.title, stub.company_name)
      recordFilter(diagnostics.stubFilterStats, verdict.keep, verdict.reason, verdict.detail)
      if (verdict.keep) kept.push(stub)
    }
    survivingGroups.push(kept)
  }
  diagnostics.stubsAfterCheapFilter = survivingGroups.reduce((n, g) => n + g.length, 0)

  // Allocate by query priority so the strongest queries get the deepest coverage.
  const ordered = allocateBudget(survivingGroups, opts.maxPeopleToEnrich * 2)

  // ── 3. COMPANY RESEARCH — one grounded web call per unique company ──
  const companyNames: string[] = []
  const seenCompany = new Set<string>()
  for (const stub of ordered) {
    if (!stub.company_name) continue
    const key = stubCompanyKey(stub.company_name)
    if (seenCompany.has(key)) continue
    seenCompany.add(key)
    companyNames.push(stub.company_name)
  }
  diagnostics.companiesSeen = companyNames.length

  const toResearch = companyNames.slice(0, opts.maxCompaniesToResearch)
  const companyDossiers = new Map<string, CompanyDossier>()

  const dossierResults = await mapWithConcurrency(toResearch, opts.researchConcurrency, (name) =>
    researchCompany(stubCompanyCandidate(name))
  )
  for (let i = 0; i < dossierResults.length; i++) {
    const { dossier, usage: u } = dossierResults[i]
    companyDossiers.set(stubCompanyKey(toResearch[i]), dossier)
    usage.web_searches += u.web_searches
    usage.research_llm_calls += u.llm_calls
    usage.research_tokens_in += u.tokens_in
    usage.research_tokens_out += u.tokens_out
  }
  diagnostics.companiesResearched = companyDossiers.size

  // ── 4. PRELIMINARY RELEVANCE — the researcher's own verdict ──
  // This is where DOMAIN DRIFT dies: a golf-club advisory that matched
  // "operations consulting" is rejected here, before a credit is spent on it.
  const relevantCompanyKeys = new Set<string>()
  for (const [key, dossier] of companyDossiers) {
    if (dossier.research_failed) {
      diagnostics.companiesResearchFailed++
      // Research failure is not evidence of irrelevance — keep, and let scoring
      // discount for missing coverage rather than silently dropping the company.
      relevantCompanyKeys.add(key)
      continue
    }
    if (dossier.mission_relevant) {
      relevantCompanyKeys.add(key)
      diagnostics.companiesMissionRelevant++
    } else {
      diagnostics.companiesRejectedByResearch++
    }
  }

  // ── 5. SHORTLIST — people only at companies that survived ──
  const shortlist = ordered.filter((stub) => {
    if (!stub.company_name) return false
    const key = stubCompanyKey(stub.company_name)
    // Companies beyond the research cap were never evaluated; exclude them
    // rather than enriching on no evidence.
    return companyDossiers.has(key) && relevantCompanyKeys.has(key)
  })
  diagnostics.shortlistedStubs = shortlist.length

  // ── 6. APOLLO ENRICHMENT — the only credit-spending step ──
  const toEnrich = shortlist.slice(0, opts.maxPeopleToEnrich)
  const enriched = await apolloPeopleProvider.enrichMany(toEnrich.map((s) => s.apollo_id))
  diagnostics.peopleEnriched = enriched.items.length
  diagnostics.peopleEnrichmentMissing = Math.max(0, toEnrich.length - enriched.items.length)

  // ── 7. FILTER + DEDUPE on full records ──
  const companiesByKey = new Map<string, CompanyCandidate>()
  const kept: PersonCandidate[] = []

  for (const person of enriched.items) {
    const company = companyFromPerson(person)
    if (company) {
      const verdict = filterCompany(company, opts.companyFilter)
      recordFilter(diagnostics.companyFilterStats, verdict.keep, verdict.reason, verdict.detail)
      if (!verdict.keep) continue
      companiesByKey.set(companyKey(company), company)
    }

    const pv = filterPerson(person, company?.employee_count ?? null)
    recordFilter(diagnostics.personFilterStats, pv.keep, pv.reason, pv.detail)
    if (pv.keep) kept.push(person)
  }
  diagnostics.peopleAfterFilter = kept.length

  const { unique } = dedupePeople(kept)
  diagnostics.peopleAfterDedupe = unique.length

  // Re-key company dossiers by the enriched company key so scoring can join on
  // either identity (stub name key or domain key).
  for (const person of unique) {
    const company = companyFromPerson(person)
    if (!company) continue
    const nameKey = stubCompanyKey(company.name)
    const dossier = companyDossiers.get(nameKey)
    if (dossier) companyDossiers.set(companyKey(company), dossier)
  }

  // ── 8. PERSON RESEARCH — on the surviving shortlist only ──
  const personDossiers = new Map<string, PersonDossier>()
  const researchTargets = unique.slice(0, opts.maxPeopleToResearch)

  const personResults = await mapWithConcurrency(researchTargets, opts.researchConcurrency, (person) => {
    const company = companyFromPerson(person)
    const dossier = company ? companyDossiers.get(companyKey(company)) ?? null : null
    return researchPerson(person, dossier)
  })
  for (let i = 0; i < personResults.length; i++) {
    const { dossier, usage: u } = personResults[i]
    personDossiers.set(personKeyOf(researchTargets[i]), dossier)
    usage.web_searches += u.web_searches
    usage.research_llm_calls += u.llm_calls
    usage.research_tokens_in += u.tokens_in
    usage.research_tokens_out += u.tokens_out
  }
  diagnostics.peopleResearched = personDossiers.size

  return { people: unique, companiesByKey, companyDossiers, personDossiers, diagnostics, usage }
}

export { personKeyOf, stubCompanyKey, companyFromPerson }
