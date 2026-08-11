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
import { normalizeCompanyName } from '@/lib/providers/apollo/normalize'
import { rankStubsByTitle, type CompanyArchetype } from './titles'
import { stubPassesCheapFilter, newFilterStats, recordFilter, type FilterStats } from './filter'
import { personKey } from './dedupe'
import { mapWithConcurrency } from './concurrency'
import type { PersonCandidate } from '@/lib/providers/types'

export interface ScoutTarget {
  company_name: string
  domain: string | null
  /** Carried through so downstream steps keep the researched company context. */
  company_ref: string
  /**
   * Titles chosen from THIS company's research. A founder is right at a
   * 12-person startup and wrong at a 90,000-person manufacturer, so a single
   * global title list cannot serve both.
   */
  titles: string[]
  /** Drives which seniority tier counts as appropriate here. */
  archetype: CompanyArchetype
}

export interface PeopleScoutParams {
  targets: ScoutTarget[]
  /** Fallback only, for targets that carry no titles of their own. */
  titlePatterns: string[]
  maxPerCompany: number
  /**
   * Mission geography, passed to Apollo as person_locations.
   *
   * Without it a US-scoped mission returned a Dow plant supervisor in Ho Chi
   * Minh City: the COMPANY is global, so scoping the search to the company says
   * nothing about where its people sit.
   */
  locations?: string[]
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
  /** Companies where no predicted title matched — a title-prediction miss. */
  titleMisses: string[]
  /**
   * Every person Apollo surfaced per company, as "Name — Title".
   * The Best-Person eval needs the alternatives we DIDN'T pick, so that "was
   * this the right person?" is judged against what was actually available.
   */
  candidatePool: Record<string, string[]>
  errors: string[]
}

/**
 * Reject rows whose employer is not the company we asked about.
 *
 * Only a domain-scoped Apollo query is safe. A name-scoped one matched
 * "Operon" — a 3-person industrial AI startup — to a 412-person Polish music
 * publisher of the same name, and every downstream stage would have treated
 * those people as the real target. Names collide; domains do not.
 */
function guardIdentity(stubs: PersonStub[], target: ScoutTarget, errors: string[]): PersonStub[] {
  if (target.domain) return stubs // domain-scoped: Apollo already guaranteed it

  const want = normalizeCompanyName(target.company_name)
  if (!want) return stubs

  const kept = stubs.filter((s) => {
    const got = normalizeCompanyName(s.company_name)
    return got !== null && (got === want || got.includes(want) || want.includes(got))
  })

  if (kept.length < stubs.length) {
    errors.push(
      `${target.company_name}: dropped ${stubs.length - kept.length} of ${stubs.length} people whose employer name did not match (no domain to scope the search)`
    )
  }
  return kept
}

export async function scoutPeople(params: PeopleScoutParams): Promise<PeopleScoutResult> {
  const filterStats = newFilterStats()
  const emptyCompanies: string[] = []
  const titleMisses: string[] = []
  const errors: string[] = []
  const creditsBefore = apolloStats().enrichmentCredits

  // ─── Search (cheap) ────────────────────────────────────────────────────────
  // Two passes per company. The title-filtered pass is what we want; the
  // unfiltered fallback exists because a company can be real and staffed while
  // none of the predicted titles happen to exist there — that is a prediction
  // miss, not an empty company, and losing the company to it is unrecoverable.
  const perCompany = await mapWithConcurrency(
    params.targets,
    params.concurrency ?? 3,
    async (target) => {
      const scope = target.domain
        ? { company_domains: [target.domain] }
        : { company_names: [target.company_name] }
      const titles = target.titles.length ? target.titles : params.titlePatterns
      const perPage = Math.max(10, params.maxPerCompany * 3)

      const geo = params.locations?.length ? { locations: params.locations } : {}

      const titled = await apolloPeopleProvider.searchStubs({ ...scope, ...geo, title_patterns: titles, per_page: perPage })
      if (titled.error) {
        // One company failing does not stop the run (ARCHITECTURE §9).
        errors.push(`${target.company_name}: ${titled.error.slice(0, 120)}`)
        return { target, stubs: [] as PersonStub[], usedFallbackSearch: false }
      }

      if (titled.items.length > 0) {
        return { target, stubs: guardIdentity(titled.items, target, errors), usedFallbackSearch: false }
      }

      const untitled = await apolloPeopleProvider.searchStubs({ ...scope, ...geo, per_page: perPage })
      if (untitled.error) {
        errors.push(`${target.company_name} (fallback): ${untitled.error.slice(0, 120)}`)
        return { target, stubs: [] as PersonStub[], usedFallbackSearch: true }
      }
      if (untitled.items.length === 0) emptyCompanies.push(target.company_name)
      titleMisses.push(target.company_name)

      return { target, stubs: guardIdentity(untitled.items, target, errors), usedFallbackSearch: true }
    }
  )

  // ─── Cheap filter, then cap per company ────────────────────────────────────
  const selected: { stub: PersonStub; target: ScoutTarget }[] = []
  const candidatePool: Record<string, string[]> = {}
  let stubsFound = 0

  for (const { target, stubs } of perCompany) {
    stubsFound += stubs.length
    candidatePool[target.company_ref] = stubs
      .map((s) => `${s.first_name ?? '?'} — ${s.title ?? 'unknown title'}`)
      .slice(0, 25)

    // Order by fit BEFORE capping. Apollo returns matches in an order of its
    // own, so taking the first N that survive the filter means the person we
    // contact was chosen by Apollo's sort rather than by how well their role
    // matches what this company's research said to look for.
    const ordered = rankStubsByTitle(stubs, (s) => s.title, target.titles, target.archetype)

    let kept = 0
    for (const stub of ordered) {
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
    titleMisses,
    candidatePool,
    errors: isCacheOnly() ? [...errors, 'APOLLO_CACHE_ONLY is on: no live Apollo calls were made'] : errors,
  }
}
