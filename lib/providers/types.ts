// Provider abstractions for company, people, and web-research data.
//
// Business logic depends on these INTERFACES, never on a concrete provider.
// See docs/ARCHITECTURE.md §4. Scaffolding only — implementations land in Phase 3.

// ─── Common ──────────────────────────────────────────────────────────────────

/** Where a piece of data came from. Preserved for every discovered entity. */
export interface Provenance {
  provider_id: string          // 'apollo' | 'pitchbook' | 'web'
  external_id?: string         // the provider's own id, when it has one
  query_ref?: Record<string, unknown>  // the query that surfaced this
  retrieved_at: string         // ISO timestamp
}

/**
 * Uniform provider return. Providers never throw for expected conditions —
 * an empty result with `error` set is how "unavailable" and "no matches" are
 * reported, so a failing provider degrades a run instead of halting it.
 * See docs/ARCHITECTURE.md §6.
 */
export interface ProviderResult<T> {
  items: T[]
  total_available?: number     // provider-reported total, when known
  next_cursor?: string | null  // pagination handled by deterministic code
  credits_used?: number        // for per-run budget enforcement
  error?: string
}

export interface ProviderCapabilities {
  organization_search: boolean
  people_search: boolean
  person_enrichment: boolean
  web_research: boolean
}

// ─── Companies ───────────────────────────────────────────────────────────────

export interface OrgSearchQuery {
  keywords?: string[]
  industries?: string[]
  employee_min?: number
  employee_max?: number
  locations?: string[]
  countries?: string[]
  stages?: string[]
  founded_after?: number
  founded_before?: number
  page?: number
  per_page?: number
}

export interface CompanyCandidate {
  name: string
  domain: string | null
  description: string | null
  industry: string | null
  sub_industries: string[]
  employee_count: number | null
  employee_range: string | null
  stage: string | null
  founded_year: number | null
  hq_location: string | null
  country: string | null
  website_url: string | null
  linkedin_url: string | null
  raw: Record<string, unknown>
  provenance: Provenance
}

export interface CompanyProvider {
  readonly id: string
  readonly capabilities: ProviderCapabilities
  /** False when credentials or feature flags are missing. Checked before use. */
  isAvailable(): boolean
  searchOrganizations(query: OrgSearchQuery): Promise<ProviderResult<CompanyCandidate>>
}

// ─── People ──────────────────────────────────────────────────────────────────

export interface PeopleSearchQuery {
  company_domains?: string[]
  company_names?: string[]
  title_patterns?: string[]
  seniorities?: string[]
  departments?: string[]
  locations?: string[]
  page?: number
  per_page?: number
}

export interface PersonRef {
  linkedin_url?: string
  email?: string
  name?: string
  company_domain?: string
}

/**
 * `email_status` is deliberately explicit: Apollo does not always have a
 * deliverable address, and a prospect without one should surface as
 * LinkedIn-only rather than silently vanishing from the funnel.
 */
export interface PersonCandidate {
  name: string
  first_name: string | null
  last_name: string | null
  title: string | null
  seniority: string | null
  department: string | null
  email: string | null
  email_status: 'verified' | 'guessed' | 'unavailable'
  linkedin_url: string | null
  location: string | null
  company_name: string | null
  company_domain: string | null
  raw: Record<string, unknown>
  provenance: Provenance
}

export interface PeopleProvider {
  readonly id: string
  readonly capabilities: ProviderCapabilities
  isAvailable(): boolean
  searchPeople(query: PeopleSearchQuery): Promise<ProviderResult<PersonCandidate>>
  enrichPerson(ref: PersonRef): Promise<ProviderResult<PersonCandidate>>
}

// ─── Web research ────────────────────────────────────────────────────────────

export interface WebResearchQuery {
  query: string
  context?: string             // what we're trying to establish, to focus results
  max_results?: number
  recency_days?: number        // bias toward recent developments
}

/**
 * A web finding ALWAYS carries a source URL. This is what makes
 * `research_facts.fact_requires_source` satisfiable — a FACT with no source
 * cannot be persisted. See docs/ARCHITECTURE.md ADR-006.
 */
export interface WebFinding {
  claim: string
  source_url: string
  source_title: string | null
  published_at: string | null
  snippet: string | null
  provenance: Provenance
}

export interface WebResearchProvider {
  readonly id: string
  readonly capabilities: ProviderCapabilities
  isAvailable(): boolean
  research(query: WebResearchQuery): Promise<ProviderResult<WebFinding>>
}
