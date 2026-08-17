// What is actually in the index.
//
// The retrieval agent is told this before it searches, for one reason: "0
// results" is ambiguous. Without the facets it cannot tell "my vocabulary was
// wrong" from "this network contains no consultants", and those call for
// opposite next actions — reformulate, or stop and report the gap.

import { createServiceClient } from '@/lib/supabase/server'

export interface NetworkFacets {
  indexed: number
  classified: number
  seniorityBands: string[]
  functionAreas: string[]
  regions: string[]
  opportunityTypes: string[]
  topIndustries: string[]
  relationshipCounts: Record<string, number>
  error: string | null
}

export function emptyFacets(): NetworkFacets {
  return {
    indexed: 0,
    classified: 0,
    seniorityBands: [],
    functionAreas: [],
    regions: [],
    opportunityTypes: [],
    topIndustries: [],
    relationshipCounts: {},
    error: null,
  }
}

/**
 * One paginated scan over a narrow projection. At the scale this runs at
 * (~900 rows, six small columns) counting in memory is cheaper than six
 * grouped round trips, and it keeps the whole thing in one query shape.
 */
export async function loadFacets(userId: string): Promise<NetworkFacets> {
  const supabase = createServiceClient()
  const out = emptyFacets()

  const bands = new Map<string, number>()
  const functions = new Map<string, number>()
  const regions = new Map<string, number>()
  const opportunities = new Map<string, number>()
  const industries = new Map<string, number>()

  const pageSize = 1000
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('contact_index')
      .select('seniority_band, function_area, geo_region, opportunity_types, industry, relationship_status, classified_at')
      .eq('user_id', userId)
      .range(from, from + pageSize - 1)

    if (error) {
      out.error = error.message
      return out
    }
    if (!data || data.length === 0) break

    for (const r of data) {
      out.indexed++
      if (r.classified_at) out.classified++
      const bump = (m: Map<string, number>, k: string | null) => {
        if (!k || k === 'unknown') return
        m.set(k, (m.get(k) ?? 0) + 1)
      }
      bump(bands, r.seniority_band)
      bump(functions, r.function_area)
      bump(regions, r.geo_region)
      bump(industries, r.industry)
      for (const o of (r.opportunity_types as string[] | null) ?? []) bump(opportunities, o)
      const rel = r.relationship_status ?? 'never_contacted'
      out.relationshipCounts[rel] = (out.relationshipCounts[rel] ?? 0) + 1
    }

    if (data.length < pageSize) break
  }

  const top = (m: Map<string, number>, n: number) =>
    Array.from(m.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, count]) => `${k} (${count})`)

  out.seniorityBands = top(bands, 12)
  out.functionAreas = top(functions, 14)
  out.regions = top(regions, 8)
  out.opportunityTypes = top(opportunities, 12)
  out.topIndustries = top(industries, 14)

  return out
}
