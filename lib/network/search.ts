// Deterministic search over the existing network.
//
// This is the cheap retrieval step: free, over all 897 contacts, ranked by
// Postgres. Nothing here judges anyone — it finds candidates and hands them to
// the agent that does.
//
// Query sanitization is not decoration. The text arriving here is written by a
// model, and `to_tsquery` raises on unbalanced syntax. `websearch_to_tsquery`
// never raises, so everything is normalized into websearch syntax before it
// reaches SQL.

import { createServiceClient } from '@/lib/supabase/server'

export interface NetworkSearchFilters {
  seniority?: string[]
  functions?: string[]
  regions?: string[]
  states?: string[]
  companyTypes?: string[]
  opportunityTypes?: string[]
  relationship?: string[]
  exclude?: string[]
}

export interface NetworkSearchParams extends NetworkSearchFilters {
  userId: string
  query?: string | null
  limit?: number
}

export interface NetworkCandidate {
  contact_id: string
  name: string
  title: string | null
  company: string | null
  email: string | null
  linkedin_url: string | null
  location: string | null
  seniority_band: string | null
  function_area: string | null
  geo_city: string | null
  geo_state: string | null
  geo_region: string | null
  industry: string | null
  sub_industry: string | null
  company_type: string | null
  technical_domains: string[] | null
  business_domains: string[] | null
  opportunity_types: string[] | null
  tags: string[] | null
  relevance: Record<string, number> | null
  relationship_status: string | null
  relationship_note: string | null
  evidence_level: string | null
  summary: string | null
  rank: number
}

export interface NetworkSearchResult {
  candidates: NetworkCandidate[]
  /** Matches before the limit — the agent needs to know when it over-broadened. */
  totalMatches: number
  /** The tsquery actually executed, for the run log. */
  effectiveQuery: string
  migrationMissing: boolean
  error: string | null
}

/**
 * Turn free text into websearch syntax.
 *
 * Terms are OR-ed, not AND-ed. A mission expands into a handful of related
 * concepts ("industrial consulting", "operations", "manufacturing
 * transformation") and requiring all of them returns nothing — the whole point
 * of the ranking is that partial matches are ordered rather than excluded.
 * Quoted phrases are preserved, because `"process engineering"` as a phrase is
 * a materially different search from the two words separately.
 */
export function toWebSearchQuery(raw: string | null | undefined): string {
  if (!raw?.trim()) return ''

  const phrases: string[] = []
  // Pull quoted phrases out first so their internal spaces survive tokenizing.
  const withoutPhrases = raw.replace(/"([^"]{2,60})"/g, (_m, phrase: string) => {
    const cleaned = phrase.replace(/[^A-Za-z0-9&\s-]/g, ' ').replace(/\s+/g, ' ').trim()
    if (cleaned) phrases.push(`"${cleaned}"`)
    return ' '
  })

  const words = withoutPhrases
    .replace(/[^A-Za-z0-9&\s-]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w.toLowerCase()))
    .slice(0, 24)

  return [...phrases, ...words].join(' or ')
}

/** Words that match everything and therefore rank nothing. */
const STOPWORDS = new Set([
  'and', 'or', 'the', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'at', 'by', 'with',
  'who', 'that', 'this', 'from', 'is', 'are', 'be', 'as', 'it', 'my', 'me', 'i',
  'people', 'person', 'someone', 'anyone', 'find', 'looking', 'want', 'need',
])

function isMissingSchema(message: string): boolean {
  return /relation .* does not exist|function .* does not exist|schema cache|could not find/i.test(message)
}

export async function searchNetwork(params: NetworkSearchParams): Promise<NetworkSearchResult> {
  const supabase = createServiceClient()
  const effectiveQuery = toWebSearchQuery(params.query)

  const nonEmpty = (a?: string[]) => (a && a.length > 0 ? a : null)

  const { data, error } = await supabase.rpc('search_contact_index', {
    p_user_id: params.userId,
    p_query: effectiveQuery || null,
    p_seniority: nonEmpty(params.seniority),
    p_functions: nonEmpty(params.functions),
    p_regions: nonEmpty(params.regions),
    p_states: nonEmpty(params.states),
    p_company_types: nonEmpty(params.companyTypes),
    p_opportunity_types: nonEmpty(params.opportunityTypes),
    p_relationship: nonEmpty(params.relationship),
    p_exclude: nonEmpty(params.exclude),
    p_limit: params.limit ?? 30,
  })

  if (error) {
    return {
      candidates: [],
      totalMatches: 0,
      effectiveQuery,
      migrationMissing: isMissingSchema(error.message),
      error: error.message,
    }
  }

  const rows = (data ?? []) as (NetworkCandidate & { total_matches: number })[]
  return {
    candidates: rows.map(({ total_matches: _drop, ...rest }) => rest),
    totalMatches: rows[0]?.total_matches ?? 0,
    effectiveQuery,
    migrationMissing: false,
    error: null,
  }
}
