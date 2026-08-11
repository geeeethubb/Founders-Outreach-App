// Apollo PeopleProvider — people search + bulk enrichment.
//
// CRITICAL ENTITLEMENT BEHAVIOR (see docs/PHASE_3_EVAL.md §Known limitations):
// `mixed_people/api_search` returns OBFUSCATED rows — `last_name_obfuscated`
// ("Ke***r"), boolean `has_email` flags, no LinkedIn URL, no seniority, no
// location. Those rows are only useful as identifiers.
//
// Full records require `people/bulk_match`, which resolves an Apollo person id
// to complete data (name, seniority, LinkedIn, city, org with employee count).
// Enrichment consumes credits, so it runs ONCE per person, after deterministic
// pre-filtering has already discarded candidates we would never contact.

import type {
  PeopleProvider,
  PeopleSearchQuery,
  PersonCandidate,
  PersonRef,
  ProviderCapabilities,
  ProviderResult,
} from '../types'
import { apolloAvailable, apolloRequest } from './client'
import { cacheGet, cacheKey, cacheSet } from '../cache'
import { normalizePerson, type RawApolloPerson } from './normalize'

const CAPABILITIES: ProviderCapabilities = {
  organization_search: true,
  people_search: true,
  person_enrichment: true,
  web_research: false,
}

/** Stable per-person cache key, independent of which batch resolved them. */
export function personCacheKey(apolloId: string): string {
  return cacheKey('person_enriched', { id: apolloId })
}

/** Apollo caps bulk_match at 10 records per request. */
const BULK_MATCH_SIZE = 10

interface PeopleSearchResponse {
  people?: RawApolloPerson[]
  total_entries?: number
  pagination?: { total_entries?: number }
}

interface BulkMatchResponse {
  matches?: (RawApolloPerson | null)[]
}

interface MatchResponse {
  person?: RawApolloPerson
}

/**
 * A search-result stub. Deliberately NOT a PersonCandidate — these rows are
 * obfuscated and must not be mistaken for usable prospect data. The type makes
 * that impossible to get wrong.
 */
export interface PersonStub {
  apollo_id: string
  first_name: string | null
  title: string | null
  company_name: string | null
  has_email: boolean
  query_ref: Record<string, unknown>
}

function truthy(v: unknown): boolean {
  return v === true || v === 'true' || v === 'Yes' || v === 'yes'
}

/**
 * Extra org-level filters carried alongside the neutral PeopleSearchQuery.
 *
 * `org_keywords` is the key one: applying Apollo's keyword tags at the PEOPLE
 * layer filters by company context without the name-matching junk that breaks
 * company-first search, because the title filter already anchors the query to a
 * real operating company. See lib/scouting/pipeline.ts for the full finding.
 */
export interface PeopleSearchOrgFilters {
  org_keywords?: string[]
  employee_min?: number
  employee_max?: number
}

export function buildPeopleSearchBody(
  query: PeopleSearchQuery & Partial<PeopleSearchOrgFilters>
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    page: query.page ?? 1,
    per_page: Math.min(query.per_page ?? 25, 100),
  }
  if (query.title_patterns?.length) body.person_titles = query.title_patterns
  if (query.seniorities?.length) body.person_seniorities = query.seniorities
  if (query.departments?.length) body.person_departments = query.departments
  if (query.locations?.length) body.person_locations = query.locations
  if (query.company_domains?.length) body.q_organization_domains_list = query.company_domains
  if (query.company_names?.length) body.q_organization_name = query.company_names.join(' ')
  if (query.org_keywords?.length) body.q_organization_keyword_tags = query.org_keywords
  if (query.employee_min != null || query.employee_max != null) {
    body.organization_num_employees_ranges = [
      `${query.employee_min ?? 1},${query.employee_max ?? 1000000}`,
    ]
  }
  return body
}

export class ApolloPeopleProvider implements PeopleProvider {
  readonly id = 'apollo'
  readonly capabilities = CAPABILITIES

  isAvailable(): boolean {
    return apolloAvailable()
  }

  /** Obfuscated identifier rows. Feed these to `enrichMany`. */
  async searchStubs(
    query: PeopleSearchQuery & Partial<PeopleSearchOrgFilters>
  ): Promise<ProviderResult<PersonStub>> {
    if (!this.isAvailable()) return { items: [], error: 'APOLLO_API_KEY is not set' }

    const body = buildPeopleSearchBody(query)
    const res = await apolloRequest<PeopleSearchResponse>('mixed_people/api_search', body, {
      namespace: 'people_search',
    })

    if (!res.ok || !res.data) {
      return { items: [], error: res.error ?? 'Apollo people search failed' }
    }

    const items: PersonStub[] = (res.data.people ?? [])
      .filter((p) => p.id)
      .map((p) => ({
        apollo_id: p.id as string,
        first_name: p.first_name ?? null,
        title: p.title ?? null,
        company_name: (p.organization as { name?: string } | undefined)?.name ?? null,
        has_email: truthy(p.has_email),
        query_ref: body,
      }))

    return {
      items,
      total_available: res.data.total_entries ?? res.data.pagination?.total_entries,
    }
  }

  /**
   * Resolve Apollo ids to full records.
   *
   * Enriched people are indexed INDIVIDUALLY by Apollo id, not only as part of
   * their bulk_match batch. Batch-keyed caching alone is useless the moment the
   * pipeline changes which people it selects: the same person in a different
   * batch is a cache miss and costs another credit. Since credits are the hard
   * currency here, a per-person index is what makes the cache actually reusable
   * across pipeline changes.
   */
  async enrichMany(apolloIds: string[]): Promise<ProviderResult<PersonCandidate>> {
    const unique = Array.from(new Set(apolloIds.filter(Boolean)))
    const items: PersonCandidate[] = []
    const missing: string[] = []

    // Serve anyone we have already resolved, whatever batch they arrived in.
    for (const id of unique) {
      const hit = cacheGet<RawApolloPerson>(personCacheKey(id))
      if (hit) items.push(normalizePerson(hit, { person_index: true }))
      else missing.push(id)
    }

    if (missing.length === 0) return { items, credits_used: 0 }
    if (!this.isAvailable()) return { items, error: 'APOLLO_API_KEY is not set' }

    let credits = 0
    const batchErrors: string[] = []

    for (let i = 0; i < missing.length; i += BULK_MATCH_SIZE) {
      const batch = missing.slice(i, i + BULK_MATCH_SIZE)
      const res = await apolloRequest<BulkMatchResponse>(
        'people/bulk_match',
        { details: batch.map((id) => ({ id })) },
        { namespace: 'people_bulk_match', credits: batch.length }
      )

      if (!res.ok || !res.data) {
        // A failed batch degrades the run but must never be silent: "0 enriched"
        // with no reason is exactly the diagnostic hole ARCHITECTURE §9 forbids.
        // Credit exhaustion looks identical to a network fault from the outside,
        // and the difference decides whether retrying is even sensible.
        batchErrors.push(res.error ?? `bulk_match failed with status ${res.status}`)
        continue
      }

      credits += batch.length
      for (const match of res.data.matches ?? []) {
        // Apollo returns nulls for ids it cannot resolve — skip, don't fabricate.
        if (!match?.id || !match.name) continue
        cacheSet(personCacheKey(match.id), match)
        items.push(normalizePerson(match, { bulk_match: true }))
      }
    }

    return {
      items,
      credits_used: credits,
      ...(batchErrors.length
        ? {
            error: `${batchErrors.length} of ${Math.ceil(missing.length / BULK_MATCH_SIZE)} enrichment batches failed — ${batchErrors[0].slice(0, 160)}`,
          }
        : {}),
    }
  }

  async searchPeople(query: PeopleSearchQuery): Promise<ProviderResult<PersonCandidate>> {
    const stubs = await this.searchStubs(query)
    if (stubs.error) return { items: [], error: stubs.error }
    return this.enrichMany(stubs.items.map((s) => s.apollo_id))
  }

  async enrichPerson(ref: PersonRef): Promise<ProviderResult<PersonCandidate>> {
    if (!this.isAvailable()) return { items: [], error: 'APOLLO_API_KEY is not set' }

    const body: Record<string, unknown> = {}
    if (ref.linkedin_url) body.linkedin_url = ref.linkedin_url
    if (ref.email) body.email = ref.email
    if (ref.name) body.name = ref.name
    if (ref.company_domain) body.domain = ref.company_domain
    if (Object.keys(body).length === 0) {
      return { items: [], error: 'enrichPerson requires at least one identifier' }
    }

    const res = await apolloRequest<MatchResponse>('people/match', body, {
      namespace: 'people_match',
      credits: 1,
    })
    if (!res.ok || !res.data?.person) {
      return { items: [], error: res.error ?? 'No match' }
    }
    return { items: [normalizePerson(res.data.person, body)], credits_used: 1 }
  }
}

export const apolloPeopleProvider = new ApolloPeopleProvider()
