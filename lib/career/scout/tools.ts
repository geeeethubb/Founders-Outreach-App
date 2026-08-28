// The real implementations of the Job Scout's two injected tools.
//
// The agent sees `lookup_ats_board` and `fetch_page`; what runs underneath is
// lib/career/sources — ATS detection, adapter listings, the robots-aware page
// fetcher. Nothing here judges anything. The per-session caps live in the tool
// wrappers (buildScoutTools); this file only turns a request into a result and
// records what it cost against the run's stats.

import type { FetchPageFn, FetchPageResult, LookupBoardFn, LookupBoardResult } from '@/lib/agents/job-scout/tools'
import { FETCH_TEXT_CAP } from '@/lib/agents/job-scout/tools'
import { detectAtsForCompany } from '../sources/detect'
import { getPageFetcher } from '../sources/fetch'
import { getSourceRegistry } from '../sources/registry'
import type { PageFetcher, RawJobPosting, SourceRegistry } from '../sources/types'
import { bump, noteQuery, type ScoutStats } from './stats'

export const LOOKUP_POSTING_LIMIT = 40
export const FETCH_LINK_CAP = 120

export interface ScoutToolDeps {
  registry?: SourceRegistry
  fetcher?: PageFetcher
  stats?: ScoutStats
  bypassCache?: boolean
  /** Every raw posting a lookup returned, keyed by URL, so the orchestrator can resolve without refetching. */
  rawByUrl?: Map<string, RawJobPosting>
}

export function toBoardSummary(p: RawJobPosting): LookupBoardResult['postings'][number] {
  return {
    title: p.title,
    location: p.location_raw,
    url: p.canonical_url ?? p.source_url,
    external_id: p.ats_job_id ?? p.external_id,
    posted_at: p.posted_at,
    hint: p.employment_type_hint,
  }
}

export function createLookupBoard(deps: ScoutToolDeps = {}): LookupBoardFn {
  const registry = deps.registry ?? getSourceRegistry()
  const fetcher = deps.fetcher ?? getPageFetcher()
  return async (input) => {
    deps.stats && noteQuery(deps.stats, `lookup: ${input.company_name}`)
    const detection = await detectAtsForCompany(
      { companyName: input.company_name, domain: input.domain ?? null, careersUrl: input.careers_url ?? null },
      { registry, fetcher, bypassCache: deps.bypassCache }
    )
    if (deps.stats) deps.stats.companies_checked++
    if (!detection.board) {
      return {
        found: false,
        ats: null,
        board_url: detection.careers_url,
        postings: [],
        total_on_board: 0,
        note: `no public board detected (${detection.method}; tried: ${detection.attempts.slice(0, 4).join('; ') || 'nothing'})`,
      }
    }
    const adapter = registry.byId(detection.board.ats)
    if (!adapter) {
      return {
        found: true,
        ats: detection.board.ats,
        board_url: detection.board.board_url ?? null,
        postings: [],
        total_on_board: 0,
        note: `board is on ${detection.board.ats}, which has no keyless listing API here — treat the board URL as the careers page`,
      }
    }
    const listing = await adapter.listPostings(detection.board, { internshipsOnly: input.internships_only !== false, limit: LOOKUP_POSTING_LIMIT })
    if (deps.stats) {
      bump(deps.stats.sources_consulted, adapter.source_type, listing.postings.length)
      if (listing.postings.length) deps.stats.companies_with_openings++
    }
    for (const p of listing.postings) deps.rawByUrl?.set(p.canonical_url ?? p.source_url, p)
    return {
      found: true,
      ats: detection.board.ats,
      board_url: listing.board_url ?? detection.board.board_url ?? null,
      postings: listing.postings.map(toBoardSummary),
      total_on_board: listing.total_on_board,
      note: listing.error ? `listing failed: ${listing.error}` : listing.note ?? `${listing.postings.length} matching postings of ${listing.total_on_board} on the board`,
    }
  }
}

export function toFetchPageResult(page: Awaited<ReturnType<PageFetcher['fetch']>>): FetchPageResult {
  const ok = page.status >= 200 && page.status < 300 && !page.robots_blocked && !page.error
  const note = page.robots_blocked
    ? 'blocked by robots/policy'
    : page.error
      ? `fetch failed: ${page.error}`
      : ok
        ? 'ok'
        : `http ${page.status}`
  return {
    ok,
    status: page.status,
    title: page.title,
    text: page.text.slice(0, FETCH_TEXT_CAP),
    links: page.links.filter((l) => /^https?:\/\//i.test(l)).slice(0, FETCH_LINK_CAP),
    note,
  }
}

export function createFetchPage(deps: ScoutToolDeps = {}): FetchPageFn {
  const fetcher = deps.fetcher ?? getPageFetcher()
  return async (url) => {
    const page = await fetcher.fetch(url)
    if (deps.stats) bump(deps.stats.sources_consulted, 'page_fetch')
    return toFetchPageResult(page)
  }
}

export function createScoutTools(deps: ScoutToolDeps = {}): { lookupBoard: LookupBoardFn; fetchPage: FetchPageFn } {
  return { lookupBoard: createLookupBoard(deps), fetchPage: createFetchPage(deps) }
}
