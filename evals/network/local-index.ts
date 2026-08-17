// An in-memory stand-in for `search_contact_index`.
//
// WHY THIS EXISTS, AND WHAT IT IS NOT
//
// Migrations in this repo are applied by hand in the Supabase SQL editor, so
// the retrieval agent cannot be measured against the real 897 contacts until a
// human has run 013. That would mean shipping this milestone unmeasured, which
// is the one thing the eval discipline here does not allow.
//
// So the eval injects this backend through the seam on `buildSearchTool`. What
// gets measured is everything that carries judgment — the classifier, the
// retrieval agent, its reformulation behaviour, the ranking, the sufficiency
// decision — over the real database contents. What is NOT measured is Postgres
// full-text search itself, which is an index lookup, not a decision.
//
// Ranking approximates ts_rank: weighted A/B/C bands, OR-ed terms, distinct
// term coverage. Postgres uses a snowball stemmer and this uses a crude suffix
// strip, so exact orderings will differ slightly. Every eval report says which
// backend produced its numbers.

import type { IndexRow } from '@/lib/network/indexer'
import type { NetworkCandidate, NetworkSearchParams, NetworkSearchResult } from '@/lib/network/search'
import { toWebSearchQuery } from '@/lib/network/search'

export interface Identity {
  name: string
  title: string | null
  email: string | null
  linkedin: string | null
  location: string | null
}

const WEIGHT = { headline: 1.0, tags: 0.4, body: 0.16 }

/** Crude stemming. Enough to make "engineering" and "engineer" the same term. */
function stem(word: string): string {
  let w = word.toLowerCase()
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3)
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2)
  else if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`
  else if (w.length > 3 && w.endsWith('es')) w = w.slice(0, -2)
  else if (w.length > 3 && w.endsWith('s')) w = w.slice(0, -1)
  return w
}

function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9&]+/g) ?? []).map(stem)
}

interface Indexed {
  row: IndexRow
  identity: Identity
  headline: Set<string>
  tags: Set<string>
  body: Set<string>
  /** Whole lowercased text, for quoted-phrase matching. */
  full: string
}

export class LocalNetworkIndex {
  private readonly docs: Indexed[]

  constructor(rows: IndexRow[], identities: Map<string, Identity>) {
    this.docs = rows.map((row) => ({
      row,
      identity: identities.get(row.contact_id) ?? { name: '', title: null, email: null, linkedin: null, location: null },
      headline: new Set(tokens(row.headline)),
      tags: new Set(tokens(row.tags_text)),
      body: new Set(tokens(row.body_text)),
      full: `${row.headline}\n${row.tags_text}\n${row.body_text}`.toLowerCase(),
    }))
  }

  get size(): number {
    return this.docs.length
  }

  /** Drop-in for `searchNetwork`. Same params, same result shape. */
  search = async (params: NetworkSearchParams): Promise<NetworkSearchResult> => {
    const effectiveQuery = toWebSearchQuery(params.query)
    const { terms, phrases } = parseWebSearch(effectiveQuery)

    const filtered = this.docs.filter((d) => passesFilters(d.row, params))

    const hasQuery = terms.length > 0 || phrases.length > 0
    const all = filtered
      .map((d) => ({ doc: d, rank: score(d, terms, phrases) }))
      .filter((s) => !hasQuery || s.rank > 0)

    // The relevance floor, mirroring `search_contact_index`. Without it an
    // eight-term OR query matched 599 of 897 contacts and the match count told
    // the agent nothing. Relative to the best match in the same query, because
    // raw scores are not comparable across queries of different lengths.
    const topRank = all.reduce((m, s) => Math.max(m, s.rank), 0)
    const scored = hasQuery ? all.filter((s) => s.rank >= 0.3 * topRank) : all

    scored.sort((a, b) => {
      if (b.rank !== a.rank) return b.rank - a.rank
      const ev = evidenceOrder(a.doc.row.evidence_level) - evidenceOrder(b.doc.row.evidence_level)
      if (ev !== 0) return ev
      return a.doc.identity.name.localeCompare(b.doc.identity.name)
    })

    const limit = Math.max(1, Math.min(params.limit ?? 30, 200))
    return {
      candidates: scored.slice(0, limit).map((s) => toCandidate(s.doc, s.rank)),
      totalMatches: scored.length,
      effectiveQuery,
      migrationMissing: false,
      error: null,
    }
  }
}

function evidenceOrder(level: string | null): number {
  return level === 'rich' ? 0 : level === 'moderate' ? 1 : 2
}

function parseWebSearch(query: string): { terms: string[]; phrases: string[] } {
  const phrases: string[] = []
  const rest = query.replace(/"([^"]+)"/g, (_m, p: string) => {
    phrases.push(p.toLowerCase().trim())
    return ' '
  })
  const terms = rest
    .split(/\s+or\s+|\s+/i)
    .map((t) => t.trim())
    .filter((t) => t && t.toLowerCase() !== 'or')
    .map(stem)
  return { terms: Array.from(new Set(terms)), phrases }
}

/**
 * Approximate ts_rank: each distinct matched term contributes its best band
 * weight, and the total is damped so twenty weak body hits never outrank one
 * title hit.
 */
function score(doc: Indexed, terms: string[], phrases: string[]): number {
  let total = 0
  for (const p of phrases) {
    if (doc.full.includes(p)) total += WEIGHT.headline
  }
  for (const t of terms) {
    if (doc.headline.has(t)) total += WEIGHT.headline
    else if (doc.tags.has(t)) total += WEIGHT.tags
    else if (doc.body.has(t)) total += WEIGHT.body
  }
  if (total === 0) return 0
  const denom = Math.max(1, terms.length + phrases.length)
  return total / (denom + total * 0.35)
}

function passesFilters(row: IndexRow, p: NetworkSearchParams): boolean {
  const has = (list: string[] | undefined, value: string | null) =>
    !list || list.length === 0 || (value !== null && list.includes(value))

  if (!has(p.seniority, row.seniority_band)) return false
  if (!has(p.functions, row.function_area)) return false
  if (!has(p.regions, row.geo_region)) return false
  if (!has(p.companyTypes, row.company_type)) return false
  if (!has(p.relationship, row.relationship_status)) return false
  if (p.states?.length) {
    const state = (row.geo_state ?? '').toLowerCase()
    if (!p.states.some((s) => s.toLowerCase() === state)) return false
  }
  if (p.opportunityTypes?.length) {
    if (!row.opportunity_types.some((o) => p.opportunityTypes!.includes(o))) return false
  }
  if (p.exclude?.length && p.exclude.includes(row.contact_id)) return false
  return true
}

function toCandidate(doc: Indexed, rank: number): NetworkCandidate {
  const r = doc.row
  return {
    contact_id: r.contact_id,
    name: doc.identity.name,
    title: doc.identity.title,
    company: r.company_name,
    email: doc.identity.email,
    linkedin_url: doc.identity.linkedin,
    location: doc.identity.location,
    seniority_band: r.seniority_band,
    function_area: r.function_area,
    geo_city: r.geo_city,
    geo_state: r.geo_state,
    geo_region: r.geo_region,
    industry: r.industry,
    sub_industry: r.sub_industry,
    company_type: r.company_type,
    technical_domains: r.technical_domains,
    business_domains: r.business_domains,
    opportunity_types: r.opportunity_types,
    tags: r.tags,
    relevance: r.relevance,
    relationship_status: r.relationship_status,
    relationship_note: r.relationship_note,
    evidence_level: r.evidence_level,
    summary: r.classification_note ?? r.body_text.slice(0, 240),
    rank,
  }
}
