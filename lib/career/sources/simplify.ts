// The SimplifyJobs / Pitt CSC Summer 2027 internship list, as a pull feed.
//
// One HTTP GET returns the whole corpus — 14,964 records, ~11 MB, refreshed
// daily — so this source is free, has no rate limit worth speaking of, and
// needs no key. It is cached in memory for the life of a run because paging
// through it is slicing an array, not fetching again.
//
// WHAT IT IS AND IS NOT (measured 2026-08-31, docs/JOB_SOURCE_MATRIX.md):
// 2,284 listings are active, 775 of those are Summer 2027, and their categories
// are AI/ML/Data 281 · Software 242 · Quant 115 · Product 72 · Hardware 63.
// Exactly FIVE have a chemical / process / materials / manufacturing title. So
// for a software candidate this is a firehose and for a chemical engineer it is
// a trickle — it earns its place because it is free, fresh, and because its
// `url` is the EMPLOYER'S OWN ATS LINK. Those URLs are how the app discovers
// Workday, Oracle Fusion, iCIMS and Greenhouse tenants it did not know about,
// which is worth more here than the postings themselves.
//
// Boundaries: a public GitHub file read over HTTPS. No login, no scraping of
// any platform, nothing behind an access control. The repo declares no licence,
// so this reads it for personal search and redistributes nothing.

import type { AtsType, JobSourceType } from '../types'
import { normalizeDomain } from '@/lib/providers/apollo/normalize'
import type { RawJobPosting } from './types'
import type {
  DiscoveryHealth,
  DiscoverySearchInput,
  DiscoverySearchResult,
  JobDiscoverySource,
} from './discovery-types'

export const SIMPLIFY_URL =
  'https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json'

/** How many records one `search` call returns. The corpus is local after the first fetch. */
export const SIMPLIFY_PAGE_SIZE = 200

/** Give up on the download rather than hold a run open. The file is ~11 MB. */
const FETCH_TIMEOUT_MS = 45_000

/** Re-download at most this often within one process. The upstream file changes daily. */
const CACHE_TTL_MS = 30 * 60 * 1000

/**
 * One record, exactly as the file has it. Every field is present on every
 * record in the corpus, but this stays defensive: an upstream schema change
 * must degrade to "skip that row", never throw.
 */
export interface SimplifyListing {
  source?: string
  category?: string
  company_name?: string
  id?: string
  title?: string
  active?: boolean
  terms?: string[]
  date_updated?: number
  date_posted?: number
  url?: string
  locations?: string[]
  company_url?: string
  is_visible?: boolean
  sponsorship?: string
  degrees?: string[]
}

// ─── Fetching, once ──────────────────────────────────────────────────────────

let cache: { at: number; rows: SimplifyListing[] } | null = null

/** Test seam: hand the parser a corpus instead of the network. */
export function primeSimplifyCache(rows: SimplifyListing[], at = Date.now()): void {
  cache = { at, rows }
}

export function clearSimplifyCache(): void {
  cache = null
}

export type SimplifyFetcher = (url: string) => Promise<{ ok: boolean; status: number; body: string; error?: string }>

const defaultFetcher: SimplifyFetcher = async (url) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    const body = await res.text()
    return { ok: res.ok, status: res.status, body }
  } catch (e) {
    return { ok: false, status: 0, body: '', error: e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(timer)
  }
}

export async function loadSimplifyCorpus(
  opts: { fetcher?: SimplifyFetcher; now?: number; force?: boolean } = {}
): Promise<{ rows: SimplifyListing[]; error: string | null; cached: boolean }> {
  const now = opts.now ?? Date.now()
  if (!opts.force && cache && now - cache.at < CACHE_TTL_MS) return { rows: cache.rows, error: null, cached: true }

  const res = await (opts.fetcher ?? defaultFetcher)(SIMPLIFY_URL)
  if (!res.ok) return { rows: cache?.rows ?? [], error: res.error ?? `http ${res.status}`, cached: !!cache }
  let parsed: unknown
  try {
    parsed = JSON.parse(res.body)
  } catch (e) {
    return { rows: cache?.rows ?? [], error: `malformed JSON: ${e instanceof Error ? e.message : String(e)}`, cached: !!cache }
  }
  if (!Array.isArray(parsed)) return { rows: cache?.rows ?? [], error: 'expected a JSON array', cached: !!cache }
  const rows = parsed as SimplifyListing[]
  cache = { at: now, rows }
  return { rows, error: null, cached: false }
}

// ─── Selecting ───────────────────────────────────────────────────────────────

/**
 * Open right now. `active: false` is the file's own closed marker (12,680 of
 * 14,964 records), and `is_visible: false` is a second, rarer one. A row that
 * is either is not a live opening.
 */
export function isOpen(row: SimplifyListing): boolean {
  return row.active === true && row.is_visible !== false
}

/** The season is stated, not inferred — `terms: ["Summer 2027"]`. */
export function matchesSeason(row: SimplifyListing, season: string | null | undefined): boolean {
  if (!season) return true
  const want = season.replace(/_/g, ' ').toLowerCase()
  return (row.terms ?? []).some((t) => t.toLowerCase() === want)
}

const INTERN_TITLE = /\b(intern|internship|co-?op)\b/i

export function looksLikeInternship(row: SimplifyListing): boolean {
  // The corpus is an internship list, so a row qualifies by membership; the
  // title check only catches the occasional new-grad posting that slips in.
  return INTERN_TITLE.test(row.title ?? '') || (row.terms ?? []).length > 0
}

function matchesTerms(row: SimplifyListing, terms: string[]): boolean {
  if (terms.length === 0) return true
  const hay = `${row.title ?? ''} ${row.company_name ?? ''} ${row.category ?? ''}`.toLowerCase()
  return terms.some((t) => t.trim() && hay.includes(t.trim().toLowerCase()))
}

function matchesLocation(row: SimplifyListing, location: string | null | undefined): boolean {
  if (!location) return true
  const want = location.toLowerCase()
  return (row.locations ?? []).some((l) => l.toLowerCase().includes(want))
}

function postedAfter(row: SimplifyListing, since: string | null | undefined): boolean {
  if (!since) return true
  const cutoff = Date.parse(since)
  if (!Number.isFinite(cutoff)) return true
  const stamp = (row.date_updated ?? row.date_posted ?? 0) * 1000
  return stamp >= cutoff
}

// ─── Normalizing ─────────────────────────────────────────────────────────────

/** Host → the ATS family that owns it. The reason this feed is worth reading. */
export function atsFromUrl(url: string | undefined): { ats: AtsType | null; sourceType: JobSourceType } {
  const host = (() => {
    try {
      return new URL(url ?? '').hostname.toLowerCase()
    } catch {
      return ''
    }
  })()
  if (!host) return { ats: null, sourceType: 'aggregator' }
  if (host.includes('greenhouse.io')) return { ats: 'greenhouse', sourceType: 'greenhouse' }
  if (host.includes('lever.co')) return { ats: 'lever', sourceType: 'lever' }
  if (host.includes('ashbyhq.com')) return { ats: 'ashby', sourceType: 'ashby' }
  if (host.includes('smartrecruiters.com')) return { ats: 'smartrecruiters', sourceType: 'smartrecruiters' }
  if (host.includes('workable.com')) return { ats: 'workable', sourceType: 'workable' }
  if (host.includes('myworkdayjobs.com')) return { ats: 'workday', sourceType: 'workday' }
  // Recognised but unadapted (Oracle Fusion, iCIMS, Taleo…). Record it as a
  // careers page so the URL is kept and the tenant can be adopted later.
  if (/oraclecloud\.com|icims\.com|taleo\.net|successfactors|jobvite\.com|recruitee\.com|personio\./.test(host)) {
    return { ats: 'other', sourceType: 'careers_page' }
  }
  return { ats: null, sourceType: 'careers_page' }
}

export function toRawPosting(row: SimplifyListing): RawJobPosting | null {
  const title = (row.title ?? '').trim()
  const company = (row.company_name ?? '').trim()
  const url = (row.url ?? '').trim()
  if (!title || !company || !url) return null

  const { ats, sourceType } = atsFromUrl(url)
  const posted = row.date_posted ? new Date(row.date_posted * 1000).toISOString() : null
  const updated = row.date_updated ? new Date(row.date_updated * 1000).toISOString() : null

  return {
    source_type: sourceType,
    source_url: url,
    external_id: row.id ?? null,
    company_name: company,
    company_domain: normalizeDomain(hostOf(url)) ?? null,
    title,
    // The feed carries no description. That is expected and fine: the row is
    // stored unextracted and the description is fetched later, only for the
    // postings that earn it (docs/JOB_DISCOVERY_V2_AUDIT.md §10).
    location_raw: (row.locations ?? []).join(' · ') || null,
    description_text: null,
    description_html: null,
    department: row.category ?? null,
    posted_at: posted,
    updated_at: updated,
    apply_url: url,
    canonical_url: url,
    ats_type: ats,
    ats_job_id: null,
    requisition_id: null,
    employment_type_hint: 'Internship',
    raw: {
      simplify: {
        id: row.id ?? null,
        category: row.category ?? null,
        terms: row.terms ?? [],
        sponsorship: row.sponsorship ?? null,
        degrees: row.degrees ?? [],
        company_url: row.company_url ?? null,
        active: row.active ?? null,
      },
    },
    retrieved_at: new Date().toISOString(),
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

// ─── The source ──────────────────────────────────────────────────────────────

export interface SimplifySourceOptions {
  fetcher?: SimplifyFetcher
  /** Which season to keep. Null keeps every term. */
  season?: string | null
  now?: () => number
}

export function simplifySource(opts: SimplifySourceOptions = {}): JobDiscoverySource {
  const season = opts.season === undefined ? 'Summer 2027' : opts.season
  return {
    id: 'simplify',
    name: 'Simplify / Pitt CSC Summer 2027 list',
    sourceType: 'feed',
    capabilities: {
      paginates: true,
      supportsQuery: true,
      supportsLocation: true,
      supportsSince: true,
      // No description in the feed, but the URL is the employer's own.
      givesDescription: false,
      givesCanonicalUrl: true,
    },
    costModel: { kind: 'free' },
    isConfigured: () => true,
    async healthCheck(): Promise<DiscoveryHealth> {
      const { rows, error } = await loadSimplifyCorpus({ fetcher: opts.fetcher, now: opts.now?.() })
      if (error) return { ok: false, detail: `could not read the list: ${error}` }
      const open = rows.filter(isOpen).length
      return { ok: rows.length > 0, detail: `${rows.length} listings, ${open} open` }
    },
    async search(input: DiscoverySearchInput, cursor?: string | null): Promise<DiscoverySearchResult> {
      const { rows, error } = await loadSimplifyCorpus({ fetcher: opts.fetcher, now: opts.now?.() })
      if (error && rows.length === 0) {
        return { postings: [], nextCursor: null, exhausted: true, seen: 0, error }
      }

      const terms = [...(input.titleTerms ?? []), ...(input.query ? [input.query] : [])]
      const matching = rows.filter(
        (r) =>
          isOpen(r) &&
          matchesSeason(r, season) &&
          (input.internshipsOnly === false || looksLikeInternship(r)) &&
          matchesTerms(r, terms) &&
          matchesLocation(r, input.location) &&
          postedAfter(r, input.since)
      )

      const offset = Number.parseInt(cursor ?? '0', 10)
      const start = Number.isFinite(offset) && offset > 0 ? offset : 0
      const size = Math.max(1, Math.min(input.limit ?? SIMPLIFY_PAGE_SIZE, SIMPLIFY_PAGE_SIZE))
      const slice = matching.slice(start, start + size)
      const postings = slice.map(toRawPosting).filter((p): p is RawJobPosting => p !== null)
      const next = start + size
      const exhausted = next >= matching.length

      return {
        postings,
        nextCursor: exhausted ? null : String(next),
        exhausted,
        // `seen` is what the source offered for this input, before paging.
        seen: matching.length,
        note: error ? `served from cache (${error})` : undefined,
        requests: 1,
      }
    },
  }
}
