// Apollo CompanyProvider — organization search + enrichment.
//
// Apollo's search endpoint returns SPARSE orgs (id, name, domain only).
// Employee count, industry, location and keywords require organizations/enrich,
// so `searchOrganizations` optionally hydrates results. Hydration is what makes
// deterministic filtering possible, so it is on by default for scouting.

import type {
  CompanyCandidate,
  CompanyProvider,
  OrgSearchQuery,
  ProviderCapabilities,
  ProviderResult,
} from '../types'
import { apolloAvailable, apolloRequest } from './client'
import { normalizeDomain, normalizeOrg, type RawApolloOrg } from './normalize'

const CAPABILITIES: ProviderCapabilities = {
  organization_search: true,
  people_search: true,
  person_enrichment: true,
  web_research: false,
}

interface OrgSearchResponse {
  organizations?: RawApolloOrg[]
  accounts?: RawApolloOrg[]
  pagination?: { total_entries?: number; total_pages?: number }
}

interface OrgEnrichResponse {
  organization?: RawApolloOrg
}

/** Apollo-native employee bucket strings, e.g. "51,200". */
function employeeRanges(query: OrgSearchQuery): string[] | undefined {
  if (query.employee_min == null && query.employee_max == null) return undefined
  const min = query.employee_min ?? 1
  const max = query.employee_max ?? 1000000
  return [`${min},${max}`]
}

export function buildOrgSearchBody(query: OrgSearchQuery): Record<string, unknown> {
  const body: Record<string, unknown> = {
    page: query.page ?? 1,
    per_page: Math.min(query.per_page ?? 25, 100),
  }
  if (query.keywords?.length) body.q_organization_keyword_tags = query.keywords
  if (query.locations?.length) body.organization_locations = query.locations
  const ranges = employeeRanges(query)
  if (ranges) body.organization_num_employees_ranges = ranges
  return body
}

/**
 * Fetch full company detail by domain. Cached — the same company is enriched
 * once per eval run no matter how many searches surfaced it.
 */
export async function enrichOrganization(
  domain: string
): Promise<CompanyCandidate | null> {
  const normalized = normalizeDomain(domain)
  if (!normalized) return null

  const res = await apolloRequest<OrgEnrichResponse>(
    `organizations/enrich?domain=${encodeURIComponent(normalized)}`,
    null,
    { method: 'GET', namespace: 'org_enrich' }
  )
  if (!res.ok || !res.data?.organization) return null
  return normalizeOrg(res.data.organization, { enrich_domain: normalized })
}

export class ApolloCompanyProvider implements CompanyProvider {
  readonly id = 'apollo'
  readonly capabilities = CAPABILITIES

  isAvailable(): boolean {
    return apolloAvailable()
  }

  async searchOrganizations(query: OrgSearchQuery): Promise<ProviderResult<CompanyCandidate>> {
    if (!this.isAvailable()) {
      return { items: [], error: 'APOLLO_API_KEY is not set' }
    }

    const body = buildOrgSearchBody(query)
    const res = await apolloRequest<OrgSearchResponse>('mixed_companies/search', body, {
      namespace: 'org_search',
    })

    if (!res.ok || !res.data) {
      return { items: [], error: res.error ?? 'Apollo organization search failed' }
    }

    const raw = [...(res.data.organizations ?? []), ...(res.data.accounts ?? [])]
    const items = raw.map((o) => normalizeOrg(o, body))

    return {
      items,
      total_available: res.data.pagination?.total_entries,
      next_cursor:
        (res.data.pagination?.total_pages ?? 0) > (query.page ?? 1)
          ? String((query.page ?? 1) + 1)
          : null,
    }
  }

  /**
   * Search then hydrate. Sparse search rows cannot be filtered on size,
   * industry or geography, so scouting always wants the hydrated form.
   */
  async searchAndHydrate(
    query: OrgSearchQuery,
    maxHydrate = 50
  ): Promise<ProviderResult<CompanyCandidate>> {
    const found = await this.searchOrganizations(query)
    if (found.error || found.items.length === 0) return found

    const hydrated: CompanyCandidate[] = []
    for (const candidate of found.items.slice(0, maxHydrate)) {
      if (!candidate.domain) {
        hydrated.push(candidate)
        continue
      }
      const full = await enrichOrganization(candidate.domain)
      // Preserve the discovery query on the hydrated record.
      hydrated.push(full ? { ...full, provenance: candidate.provenance } : candidate)
    }

    return { ...found, items: hydrated }
  }
}

export const apolloCompanyProvider = new ApolloCompanyProvider()
