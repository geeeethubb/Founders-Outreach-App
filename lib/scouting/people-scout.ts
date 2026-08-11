// People Scout — DETERMINISTIC.
//
// Finding people inside a known company is API calls, pagination, filtering and
// dedupe. None of that is a judgment problem, so none of it is an agent
// (docs/ARCHITECTURE.md §1). The judgment already happened upstream: the
// Mission Strategist chose the title patterns, and Company Validation decided
// this company was worth spending credits on.
//
// Credit discipline: search returns obfuscated stubs and is cheap; enrichment
// resolves them to real people and is not. So we filter hard between the two.

import { apolloPeopleProvider, type PersonStub } from '@/lib/providers/apollo/people'
import { apolloStats, isCacheOnly } from '@/lib/providers/apollo/client'
import { stubPassesCheapFilter, newFilterStats, recordFilter, type FilterStats } from './filter'
import { personKey } from './dedupe'
import { mapWithConcurrency } from './concurrency'
import type { PersonCandidate } from '@/lib/providers/types'

export interface ScoutTarget {
  company_name: string
  domain: string | null
  /** Carried through so downstream steps keep the researched company context. */
  company_ref: string
}

export interface PeopleScoutParams {
  targets: ScoutTarget[]
  titlePatterns: string[]
  maxPerCompany: number
  /** Hard ceiling on enrichment — the only step that spends credits. */
  maxEnrich: number
  concurrency?: number
}

export interface PeopleScoutResult {
  people: (PersonCandidate & { company_ref: string })[]
  stubsFound: number
  stubsKept: number
  enriched: number
  creditsUsed: number
  filterStats: FilterStats
  /** Companies Apollo returned nothing for — surfaced, never hidden. */
  emptyCompanies: string[]
  errors: string[]
}

export async function scoutPeople(params: PeopleScoutParams): Promise<PeopleScoutResult> {
  const filterStats = newFilterStats()
  const emptyCompanies: string[] = []
  const errors: string[] = []
  const creditsBefore = apolloStats().enrichmentCredits

  // ─── Search (cheap) ────────────────────────────────────────────────────────
  const perCompany = await mapWithConcurrency(
    params.targets,
    params.concurrency ?? 3,
    async (target) => {
      const res = await apolloPeopleProvider.searchStubs({
        ...(target.domain ? { company_domains: [target.domain] } : { company_names: [target.company_name] }),
        title_patterns: params.titlePatterns,
        per_page: Math.max(10, params.maxPerCompany * 3),
      })

      if (res.error) {
        // One company failing does not stop the run (ARCHITECTURE §9).
        errors.push(`${target.company_name}: ${res.error.slice(0, 120)}`)
        return { target, stubs: [] as PersonStub[] }
      }
      if (res.items.length === 0) emptyCompanies.push(target.company_name)
      return { target, stubs: res.items }
    }
  )

  // ─── Cheap filter, then cap per company ────────────────────────────────────
  const selected: { stub: PersonStub; target: ScoutTarget }[] = []
  let stubsFound = 0

  for (const { target, stubs } of perCompany) {
    stubsFound += stubs.length
    let kept = 0
    for (const stub of stubs) {
      if (kept >= params.maxPerCompany) break
      const verdict = stubPassesCheapFilter(stub.title, stub.company_name ?? target.company_name)
      recordFilter(filterStats, verdict.keep, verdict.reason, verdict.detail)
      if (!verdict.keep) continue
      selected.push({ stub, target })
      kept++
    }
  }

  // ─── Enrich (spends credits) ───────────────────────────────────────────────
  const toEnrich = selected.slice(0, params.maxEnrich)
  const targetById = new Map(toEnrich.map((s) => [s.stub.apollo_id, s.target]))

  const enrichedRes = await apolloPeopleProvider.enrichMany(toEnrich.map((s) => s.stub.apollo_id))
  if (enrichedRes.error) errors.push(`enrichment: ${enrichedRes.error.slice(0, 160)}`)

  // Dedupe across companies: the same person can surface under two targets.
  const seen = new Set<string>()
  const people: (PersonCandidate & { company_ref: string })[] = []

  for (const person of enrichedRes.items) {
    const key = personKey(person)
    if (seen.has(key)) continue
    seen.add(key)

    const apolloId = (person.raw as { id?: string })?.id
    const target =
      (apolloId ? targetById.get(apolloId) : undefined) ??
      toEnrich.find((s) => s.target.company_name === person.company_name)?.target

    people.push({ ...person, company_ref: target?.company_ref ?? person.company_domain ?? person.company_name ?? '' })
  }

  return {
    people,
    stubsFound,
    stubsKept: selected.length,
    enriched: enrichedRes.items.length,
    creditsUsed: apolloStats().enrichmentCredits - creditsBefore,
    filterStats,
    emptyCompanies,
    errors: isCacheOnly() ? [...errors, 'APOLLO_CACHE_ONLY is on: no live Apollo calls were made'] : errors,
  }
}
