// Raw Apollo payloads -> provider-neutral candidate shapes.
//
// Keeping normalization in one place is what lets the scouting pipeline stay
// provider-agnostic: adding PitchBook means writing another normalizer, not
// touching the pipeline.

import type { CompanyCandidate, PersonCandidate, Provenance } from '../types'

export interface RawApolloOrg {
  id?: string
  name?: string
  primary_domain?: string
  website_url?: string
  linkedin_url?: string
  industry?: string
  keywords?: string[]
  estimated_num_employees?: number
  founded_year?: number
  city?: string
  state?: string
  country?: string
  short_description?: string
  seo_description?: string
  [k: string]: unknown
}

export interface RawApolloPerson {
  id?: string
  name?: string
  first_name?: string
  last_name?: string
  title?: string
  seniority?: string
  linkedin_url?: string
  email?: string
  email_status?: string
  city?: string
  state?: string
  country?: string
  departments?: string[]
  subdepartments?: string[]
  organization?: RawApolloOrg
  organization_id?: string
  [k: string]: unknown
}

/** Strip protocol, www, path and case so the same company always keys alike. */
export function normalizeDomain(raw?: string | null): string | null {
  if (!raw) return null
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .split('?')[0]
  return cleaned && cleaned.includes('.') ? cleaned : null
}

/** Fallback dedupe key when no domain is known. */
export function normalizeCompanyName(raw?: string | null): string | null {
  if (!raw) return null
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[‘’'`]/g, '')
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|gmbh|sa|ag|plc|bv|nv|pte|pty|holdings|group)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  return cleaned || null
}

function joinLocation(...parts: (string | undefined | null)[]): string | null {
  const joined = parts.filter(Boolean).join(', ')
  return joined || null
}

function provenance(externalId: string | undefined, query: unknown): Provenance {
  return {
    provider_id: 'apollo',
    external_id: externalId,
    query_ref: (query ?? {}) as Record<string, unknown>,
    retrieved_at: new Date().toISOString(),
  }
}

export function normalizeOrg(raw: RawApolloOrg, query: unknown): CompanyCandidate {
  const domain = normalizeDomain(raw.primary_domain ?? raw.website_url)
  return {
    name: raw.name ?? '',
    domain,
    description: raw.short_description ?? raw.seo_description ?? null,
    industry: raw.industry ?? null,
    sub_industries: Array.isArray(raw.keywords) ? raw.keywords.slice(0, 25) : [],
    employee_count: typeof raw.estimated_num_employees === 'number' ? raw.estimated_num_employees : null,
    employee_range: null,
    stage: null,
    founded_year: typeof raw.founded_year === 'number' ? raw.founded_year : null,
    hq_location: joinLocation(raw.city, raw.state, raw.country),
    country: raw.country ?? null,
    website_url: raw.website_url ?? (domain ? `https://${domain}` : null),
    linkedin_url: raw.linkedin_url ?? null,
    raw: raw as Record<string, unknown>,
    provenance: provenance(raw.id, query),
  }
}

/**
 * Apollo's `email_status` is 'verified' | 'likely' | 'guessed' | 'unavailable'
 * | null. We collapse it to our three-value contract. A person with no
 * deliverable address still surfaces (LinkedIn-only) rather than vanishing —
 * see docs/PIPELINE.md stage 4.
 */
function emailStatus(raw: RawApolloPerson): PersonCandidate['email_status'] {
  const status = (raw.email_status ?? '').toLowerCase()
  if (raw.email && status === 'verified') return 'verified'
  if (raw.email || status === 'likely' || status === 'guessed') return 'guessed'
  return 'unavailable'
}

export function normalizePerson(raw: RawApolloPerson, query: unknown): PersonCandidate {
  const org = raw.organization ?? {}
  const name =
    raw.name ?? [raw.first_name, raw.last_name].filter(Boolean).join(' ').trim() ?? ''

  return {
    name,
    first_name: raw.first_name ?? null,
    last_name: raw.last_name ?? null,
    title: raw.title ?? null,
    seniority: raw.seniority ?? null,
    department: raw.departments?.[0] ?? raw.subdepartments?.[0] ?? null,
    email: raw.email ?? null,
    email_status: emailStatus(raw),
    linkedin_url: raw.linkedin_url ?? null,
    location: joinLocation(raw.city, raw.state, raw.country),
    company_name: org.name ?? null,
    company_domain: normalizeDomain(org.primary_domain ?? org.website_url),
    raw: raw as Record<string, unknown>,
    provenance: provenance(raw.id, query),
  }
}

/** The organization embedded in an enriched person, as a company candidate. */
export function orgFromPerson(raw: RawApolloPerson, query: unknown): CompanyCandidate | null {
  const org = raw.organization
  if (!org?.name) return null
  return normalizeOrg(org, query)
}
