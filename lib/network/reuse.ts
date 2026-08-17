// "Do we already own this?" — asked before any external call spends anything.
//
// Apollo's search step is cheap and its enrichment step is not. 635 of the 897
// stored contacts already carry an `apollo_id`, and every one of them was paid
// for once. Enriching them again is buying the same row twice.
//
// This module is the lookup index that makes the check free: one query at the
// start of a run, then constant-time membership tests.
//
// Matching order is strongest-identifier-first and is the SAME order used by
// lib/scouting/persist.ts and lib/outreach/store.ts. Three copies of "who is
// this person" that disagree is how duplicate contacts appear.

import { createServiceClient } from '@/lib/supabase/server'
import type { PersonCandidate } from '@/lib/providers/types'
import { normalizeCompany } from './normalize'

export interface OwnedPerson {
  contactId: string
  apolloId: string | null
  name: string
  title: string | null
  company: string | null
  email: string | null
  linkedinUrl: string | null
  location: string | null
  seniority: string | null
  department: string | null
  emailStatus: string | null
  status: string | null
}

export interface OwnedIndex {
  byApolloId: Map<string, OwnedPerson>
  byLinkedIn: Map<string, OwnedPerson>
  byEmail: Map<string, OwnedPerson>
  byNameCompany: Map<string, OwnedPerson>
  size: number
  error: string | null
}

/**
 * Normalize a LinkedIn URL to a comparable key.
 *
 * Query string first, THEN the trailing slash. Doing it the other way round —
 * which an earlier version of the scouting dedupe did — leaves
 * `/in/jane-doe/?utm=x` and `/in/jane-doe` as two different keys for one person.
 */
export function normalizeLinkedIn(url: string | null | undefined): string | null {
  if (!url?.trim()) return null
  let u = url.trim().toLowerCase()
  u = u.replace(/^https?:\/\//, '').replace(/^www\./, '')
  u = u.split('?')[0].split('#')[0]
  u = u.replace(/\/+$/, '')
  return u || null
}

export function nameCompanyKey(name: string | null, company: string | null): string | null {
  const n = (name ?? '').toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim()
  const c = normalizeCompany(company)
  if (!n || !c) return null
  return `${n}@@${c}`
}

export async function loadOwnedIndex(userId: string): Promise<OwnedIndex> {
  const supabase = createServiceClient()
  const index: OwnedIndex = {
    byApolloId: new Map(),
    byLinkedIn: new Map(),
    byEmail: new Map(),
    byNameCompany: new Map(),
    size: 0,
    error: null,
  }

  const pageSize = 1000
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('contacts')
      .select('id,apollo_id,name,role,company,email,linkedin_url,location,seniority,department,email_status,status')
      .eq('user_id', userId)
      .range(from, from + pageSize - 1)
    if (error) {
      index.error = error.message
      break
    }
    if (!data || data.length === 0) break

    for (const row of data) {
      const person: OwnedPerson = {
        contactId: row.id,
        apolloId: row.apollo_id ?? null,
        name: row.name,
        title: row.role ?? null,
        company: row.company ?? null,
        email: row.email ?? null,
        linkedinUrl: row.linkedin_url ?? null,
        location: row.location ?? null,
        seniority: row.seniority ?? null,
        department: row.department ?? null,
        emailStatus: row.email_status ?? null,
        status: row.status ?? null,
      }
      index.size++
      if (person.apolloId) index.byApolloId.set(person.apolloId, person)
      const li = normalizeLinkedIn(person.linkedinUrl)
      if (li) index.byLinkedIn.set(li, person)
      if (person.email) index.byEmail.set(person.email.toLowerCase().trim(), person)
      const nk = nameCompanyKey(person.name, person.company)
      if (nk) index.byNameCompany.set(nk, person)
    }

    if (data.length < pageSize) break
  }

  return index
}

export interface MatchProbe {
  apolloId?: string | null
  linkedinUrl?: string | null
  email?: string | null
  name?: string | null
  company?: string | null
}

export type MatchStrength = 'apollo_id' | 'linkedin' | 'email' | 'name_company' | null

export interface MatchResult {
  person: OwnedPerson | null
  matchedBy: MatchStrength
}

/** Strongest identifier first. A name+company match is the last resort, never the first. */
export function findOwned(index: OwnedIndex, probe: MatchProbe): MatchResult {
  if (probe.apolloId) {
    const hit = index.byApolloId.get(probe.apolloId)
    if (hit) return { person: hit, matchedBy: 'apollo_id' }
  }
  const li = normalizeLinkedIn(probe.linkedinUrl)
  if (li) {
    const hit = index.byLinkedIn.get(li)
    if (hit) return { person: hit, matchedBy: 'linkedin' }
  }
  if (probe.email) {
    const hit = index.byEmail.get(probe.email.toLowerCase().trim())
    if (hit) return { person: hit, matchedBy: 'email' }
  }
  const nk = nameCompanyKey(probe.name ?? null, probe.company ?? null)
  if (nk) {
    const hit = index.byNameCompany.get(nk)
    if (hit) return { person: hit, matchedBy: 'name_company' }
  }
  return { person: null, matchedBy: null }
}

/**
 * Rebuild a stored contact into the provider shape the pipeline expects, so a
 * reused person flows through research, ranking and drafting exactly like a
 * freshly enriched one.
 *
 * `provenance.provider_id` says `database` rather than `apollo`, which is what
 * lets the funnel report "reused" separately from "purchased".
 */
export function ownedToCandidate(p: OwnedPerson, companyRef: string): PersonCandidate & { company_ref: string } {
  const parts = p.name.trim().split(/\s+/)
  const emailStatus: PersonCandidate['email_status'] =
    p.emailStatus === 'verified' || p.emailStatus === 'guessed'
      ? p.emailStatus
      : p.email
        ? 'guessed'
        : 'unavailable'

  return {
    name: p.name,
    first_name: parts[0] ?? null,
    last_name: parts.length > 1 ? parts[parts.length - 1] : null,
    title: p.title,
    seniority: p.seniority,
    department: p.department,
    email: p.email,
    email_status: emailStatus,
    linkedin_url: p.linkedinUrl,
    location: p.location,
    company_name: p.company,
    company_domain: null,
    raw: { source: 'contact_index', contact_id: p.contactId },
    provenance: {
      provider_id: 'database',
      external_id: p.apolloId ?? undefined,
      query_ref: { reused: true },
      retrieved_at: new Date().toISOString(),
    },
    company_ref: companyRef,
  }
}

export interface ReuseStats {
  probed: number
  reused: number
  purchased: number
  byMatch: Record<string, number>
}

export function newReuseStats(): ReuseStats {
  return { probed: 0, reused: 0, purchased: 0, byMatch: {} }
}

export function recordReuse(stats: ReuseStats, matchedBy: MatchStrength): void {
  stats.probed++
  if (matchedBy) {
    stats.reused++
    stats.byMatch[matchedBy] = (stats.byMatch[matchedBy] ?? 0) + 1
  } else {
    stats.purchased++
  }
}
