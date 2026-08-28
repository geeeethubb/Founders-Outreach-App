// Resolve what the scout SAW into a posting we can store.
//
// The agent hands back URLs it actually retrieved (validated in the session).
// A URL is not a job: an ATS posting URL resolves to the adapter's canonical
// record, a board URL is a company to check, an aggregator page is a lead
// that must be followed to the first-party posting before it is canonical,
// and anything else is a page we read once and keep as a web_search copy.
// Every branch is deterministic and bounded by the run's page-fetch budget.

import type { CompanyToCheck, ScoutedPosting } from '@/lib/agents/job-scout'
import { isExcludedHost } from '../sources/fetch'
import { matchAnyAtsUrl, toBoardRef } from '../sources/registry'
import type { FetchedPage, PageFetcher, RawJobPosting, SourceRegistry } from '../sources/types'
import { bump, type ScoutStats } from './stats'

/** A shared, mutable fetch allowance so resolution and verification draw from one pool. */
export interface FetchBudget {
  left: number
}

export interface ResolveDeps {
  registry: SourceRegistry
  fetcher: PageFetcher
  stats: ScoutStats
  fetchBudget: FetchBudget
  /** Board URLs the scout submitted as postings become companies to check. */
  companiesToCheck: CompanyToCheck[]
  /** Postings already listed by a lookup this run, keyed by URL — no second fetch. */
  rawByUrl?: Map<string, RawJobPosting>
}

export type ResolveOutcome =
  | 'ats_fetched'
  | 'ats_listed'
  | 'board_url'
  | 'other_ats_page'
  | 'aggregator_followed'
  | 'aggregator_lead'
  | 'page'
  | 'excluded'
  | 'budget'
  | 'failed'

export interface ResolveResult {
  posting: RawJobPosting | null
  outcome: ResolveOutcome
  note: string
}

function pageRaw(p: ScoutedPosting, page: FetchedPage, source: RawJobPosting['source_type'], ats: RawJobPosting['ats_type']): RawJobPosting {
  return {
    source_type: source,
    source_url: p.url,
    external_id: null,
    company_name: p.company_name,
    company_domain: p.company_domain,
    title: p.title,
    location_raw: p.location,
    description_text: page.text || null,
    description_html: null,
    department: null,
    posted_at: null,
    updated_at: null,
    apply_url: page.final_url || p.url,
    canonical_url: page.final_url || p.url,
    ats_type: ats,
    ats_job_id: null,
    requisition_id: null,
    employment_type_hint: p.season_hint,
    raw: { scouted: { source_kind: p.source_kind, ats_hint: p.ats_hint, why_relevant: p.why_relevant }, page_title: page.title, status: page.status },
    retrieved_at: page.retrieved_at,
  }
}

/** A lead we could not follow: stored UNVERIFIED with no canonical URL so it shows as a lead, never as a job we vouch for. */
function leadRaw(p: ScoutedPosting, note: string): RawJobPosting {
  return {
    source_type: 'aggregator',
    source_url: p.url,
    external_id: null,
    company_name: p.company_name,
    company_domain: p.company_domain,
    title: p.title,
    location_raw: p.location,
    description_text: null,
    description_html: null,
    department: null,
    posted_at: null,
    updated_at: null,
    apply_url: null,
    canonical_url: null,
    ats_type: null,
    ats_job_id: null,
    requisition_id: null,
    employment_type_hint: p.season_hint,
    raw: { scouted: { source_kind: p.source_kind, why_relevant: p.why_relevant }, note },
    retrieved_at: new Date().toISOString(),
  }
}

async function fetchWithin(deps: ResolveDeps, url: string): Promise<FetchedPage | null> {
  if (deps.fetchBudget.left <= 0) return null
  deps.fetchBudget.left--
  bump(deps.stats.sources_consulted, 'page_fetch')
  return deps.fetcher.fetch(url)
}

async function resolveAtsUrl(p: ScoutedPosting, url: string, deps: ResolveDeps): Promise<ResolveResult | null> {
  const listed = deps.rawByUrl?.get(url)
  if (listed) return { posting: listed, outcome: 'ats_listed', note: 'listed by a board lookup this run' }

  const m = deps.registry.matchUrl(url)
  if (m) {
    if (!m.match.jobId) {
      deps.companiesToCheck.push({ name: p.company_name, domain: p.company_domain, why: `scout submitted the ${m.adapter.id} board URL as a posting` })
      return { posting: null, outcome: 'board_url', note: 'board URL, not a posting — company queued for a company-first check' }
    }
    const res = await m.adapter.fetchPosting({ ...m.match.board, company_name: m.match.board.company_name ?? p.company_name }, m.match.jobId)
    if (res.posting) return { posting: res.posting, outcome: 'ats_fetched', note: res.note }
    return { posting: null, outcome: 'failed', note: `${m.adapter.id}: ${res.status} — ${res.note}` }
  }

  const other = matchAnyAtsUrl(url)
  if (other && other.ats === 'other') {
    const page = await fetchWithin(deps, url)
    if (!page) return { posting: null, outcome: 'budget', note: 'page-fetch budget exhausted' }
    if (page.robots_blocked || page.error || page.status < 200 || page.status >= 300) {
      return { posting: null, outcome: 'failed', note: `${other.family} page: ${page.error ?? `http ${page.status}`}` }
    }
    const raw = pageRaw(p, page, 'careers_page', 'other')
    raw.canonical_url = p.url
    raw.raw.board = toBoardRef(other, p.company_name)
    return { posting: raw, outcome: 'other_ats_page', note: `${other.family} posting page read` }
  }
  return null
}

function isAtsLike(url: string): boolean {
  return matchAnyAtsUrl(url) !== null
}

export async function resolveScoutedPosting(p: ScoutedPosting, deps: ResolveDeps): Promise<ResolveResult> {
  deps.stats.postings_seen++
  if (isExcludedHost(p.url)) return record(deps, { posting: null, outcome: 'excluded', note: 'platform excluded by policy' })

  const direct = await resolveAtsUrl(p, p.url, deps)
  if (direct) return record(deps, direct)

  if (p.source_kind === 'aggregator') {
    // Aggregators are leads. Read the page once, look for the first-party link, resolve THAT.
    const page = await fetchWithin(deps, p.url)
    if (!page) return record(deps, { posting: leadRaw(p, 'budget exhausted before the lead could be followed'), outcome: 'aggregator_lead', note: 'kept as a lead' })
    if (!page.robots_blocked && !page.error) {
      const candidate = page.links.find((l) => !isExcludedHost(l) && isAtsLike(l))
      if (candidate) {
        const followed = await resolveAtsUrl(p, candidate, deps)
        if (followed?.posting) return record(deps, { ...followed, outcome: 'aggregator_followed', note: `followed to ${candidate}` })
      }
    }
    return record(deps, { posting: leadRaw(p, page.error ?? 'no first-party link found on the aggregator page'), outcome: 'aggregator_lead', note: 'kept as a lead' })
  }

  const page = await fetchWithin(deps, p.url)
  if (!page) return record(deps, { posting: null, outcome: 'budget', note: 'page-fetch budget exhausted' })
  if (page.robots_blocked || page.error || page.status < 200 || page.status >= 300) {
    return record(deps, { posting: null, outcome: 'failed', note: `page: ${page.error ?? `http ${page.status}`}` })
  }
  const source: RawJobPosting['source_type'] = p.source_kind === 'careers_page' ? 'careers_page' : 'web_search'
  return record(deps, { posting: pageRaw(p, page, source, null), outcome: 'page', note: `${source} page read` })
}

function record(deps: ResolveDeps, r: ResolveResult): ResolveResult {
  bump(deps.stats.sources_consulted, `resolve:${r.outcome}`)
  // The posting's own source_type is counted once, by the orchestrator when it keeps the posting.
  if (r.posting) deps.stats.postings_resolved++
  return r
}
