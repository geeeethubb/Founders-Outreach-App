// Deterministic deduplication for companies and people.
//
// Dedupe is pure code — see docs/ARCHITECTURE.md §1. Providers overlap, a
// company surfaces from several search queries, and the same person appears
// under multiple title filters. The eval threshold is <2% duplicates in final
// ranked output, so this has to be reliable rather than approximately right.

import type { CompanyCandidate, PersonCandidate } from '@/lib/providers/types'
import { normalizeCompanyName, normalizeDomain } from '@/lib/providers/apollo/normalize'

/** Domain first, normalized name as fallback. Mirrors the DB unique indexes. */
export function companyKey(c: Pick<CompanyCandidate, 'domain' | 'name'>): string {
  const domain = normalizeDomain(c.domain)
  if (domain) return `d:${domain}`
  return `n:${normalizeCompanyName(c.name) ?? c.name.toLowerCase()}`
}

/**
 * Apollo id is authoritative when present. Otherwise fall back to
 * LinkedIn URL, then email, then name+company — in decreasing confidence.
 */
export function personKey(p: PersonCandidate): string {
  const apolloId = p.provenance.external_id
  if (apolloId) return `a:${apolloId}`
  if (p.linkedin_url) return `l:${normalizeLinkedIn(p.linkedin_url)}`
  if (p.email) return `e:${p.email.toLowerCase().trim()}`
  const name = p.name.toLowerCase().replace(/[^a-z ]/g, '').trim()
  const company = normalizeCompanyName(p.company_name) ?? ''
  return `nc:${name}|${company}`
}

export function normalizeLinkedIn(url: string): string {
  // Order matters: strip the query string BEFORE the trailing slash. Doing it
  // the other way leaves ".../janedoe/" for a URL that carries both, so the same
  // profile produces two keys and a duplicate slips through.
  return url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('?')[0]
    .split('#')[0]
    .replace(/\/+$/, '')
}

export interface DedupeResult<T> {
  unique: T[]
  duplicatesRemoved: number
}

function dedupeBy<T>(items: T[], keyOf: (item: T) => string, merge?: (a: T, b: T) => T): DedupeResult<T> {
  const map = new Map<string, T>()
  let duplicatesRemoved = 0

  for (const item of items) {
    const key = keyOf(item)
    const existing = map.get(key)
    if (!existing) {
      map.set(key, item)
      continue
    }
    duplicatesRemoved++
    if (merge) map.set(key, merge(existing, item))
  }

  return { unique: Array.from(map.values()), duplicatesRemoved }
}

/** Keep the richer record when the same company arrives twice. */
export function dedupeCompanies(items: CompanyCandidate[]): DedupeResult<CompanyCandidate> {
  return dedupeBy(items, companyKey, (a, b) => (completeness(b) > completeness(a) ? b : a))
}

function completeness(c: CompanyCandidate): number {
  let score = 0
  if (c.domain) score++
  if (c.employee_count != null) score++
  if (c.industry) score++
  if (c.hq_location) score++
  if (c.description) score++
  if (c.founded_year != null) score++
  if (c.sub_industries.length) score++
  return score
}

export function dedupePeople(items: PersonCandidate[]): DedupeResult<PersonCandidate> {
  return dedupeBy(items, personKey, (a, b) => (b.linkedin_url && !a.linkedin_url ? b : a))
}

/**
 * Cross-key duplicate detection for the eval's <2% threshold.
 *
 * The primary pass keys on Apollo id, so the SAME human held under two Apollo
 * ids would slip through. This second pass catches that via LinkedIn URL and
 * name+company, which is the realistic residual duplicate mode.
 */
export function countResidualDuplicates(people: PersonCandidate[]): number {
  const seenLinkedIn = new Set<string>()
  const seenNameCompany = new Set<string>()
  let duplicates = 0

  for (const p of people) {
    let isDuplicate = false

    if (p.linkedin_url) {
      const key = normalizeLinkedIn(p.linkedin_url)
      if (seenLinkedIn.has(key)) isDuplicate = true
      seenLinkedIn.add(key)
    }

    const nameKey = `${p.name.toLowerCase().replace(/[^a-z ]/g, '').trim()}|${normalizeCompanyName(p.company_name) ?? ''}`
    if (nameKey.length > 2) {
      if (seenNameCompany.has(nameKey)) isDuplicate = true
      seenNameCompany.add(nameKey)
    }

    if (isDuplicate) duplicates++
  }

  return duplicates
}
