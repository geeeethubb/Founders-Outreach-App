// Teamtailor — a public JSON Feed with the full description AND a schema.org
// JobPosting stapled to every item.
//
//   GET https://{tenant}.teamtailor.com/jobs.json[?page=N]
//
// Probed live 2026-08-31 (`career`: 13 items; `oatly`: 19 items, page 2 empty).
// Content-type is `application/feed+json`; the envelope is JSON Feed 1.1 —
// `{version, title, home_page_url, feed_url, items[]}` — and each item carries
// `id`, `title`, `url`, `content_html`, `date_published`, plus a non-standard
// `_jobposting` block holding `datePosted`, sometimes `validThrough`, a
// `hiringOrganization`, an `identifier` and a `jobLocation[]` of PostalAddress.
//
// THIS ENDPOINT IS UNDOCUMENTED. Teamtailor owes nobody schema stability here,
// so every field is read through a guard and a row whose shape surprises us is
// SKIPPED and counted, never thrown (principle 9 — and a thrown parse error in
// one of nineteen rows would cost the other eighteen).
//
// Two things the probe settled that a schema note would not:
//   · `validThrough` is present on some tenants and absent on others — it is
//     per posting, not per tenant, so it cannot be relied on for freshness.
//   · A tenant that does not exist answers HTTP 404 with an EMPTY BODY. That is
//     "no such board", and it must not read as a parse failure.
//
// Boundaries: public, unauthenticated, robots-checked (docs/CAREER_OS.md §5).

import { cached, cacheKey } from '@/lib/providers/cache'
import type { RawJobPosting } from './types'
import type {
  DiscoveryHealth,
  DiscoverySearchInput,
  DiscoverySearchResult,
  JobDiscoverySource,
} from './discovery-types'
import { fetchJson, internshipLike, listCacheBypassFromEnv, utcDayKey, type JsonFetchResult } from './fetch'
import { htmlToText } from './html'
import { getRobotsRules, isPathAllowed } from './robots'

/**
 * Pages past this are not requested, however many the tenant claims.
 *
 * Reaching it while the feed is STILL SERVING ROWS is a coverage gap, and this
 * source reports it as an error rather than a quiet `exhausted` — coverage.ts
 * grants `completed` only to a source that finished with no errors, and a
 * truncated board that reads as complete is a gap behind a checkmark.
 */
export const TEAMTAILOR_MAX_PAGES = 20

export function teamtailorFeedUrl(tenant: string, page = 1): string {
  const base = `https://${encodeURIComponent(tenant)}.teamtailor.com/jobs.json`
  return page > 1 ? `${base}?page=${page}` : base
}

export function teamtailorBoardUrl(tenant: string): string {
  return `https://${encodeURIComponent(tenant)}.teamtailor.com/jobs`
}

// ─── The feed shape, all optional on purpose ─────────────────────────────────

export interface TeamtailorAddress {
  '@type'?: string
  streetAddress?: string | null
  addressLocality?: string | null
  addressRegion?: string | null
  addressCountry?: string | null
  postalCode?: string | null
}

export interface TeamtailorJobPosting {
  '@type'?: string
  title?: string
  description?: string
  datePosted?: string
  validThrough?: string
  employmentType?: string
  hiringOrganization?: { name?: string; sameAs?: string } | null
  identifier?: { name?: string; value?: string | number } | null
  jobLocation?: { '@type'?: string; address?: TeamtailorAddress | null }[] | null
  baseSalary?: unknown
}

export interface TeamtailorItem {
  id?: string
  title?: string
  url?: string
  content_html?: string
  date_published?: string
  _jobposting?: TeamtailorJobPosting | null
}

export interface TeamtailorFeed {
  version?: string
  title?: string
  home_page_url?: string
  feed_url?: string
  items?: unknown
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** ISO or null. The feed stamps `2026-08-26T00:00:00+02:00`; offsets are kept, not assumed UTC. */
export function teamtailorDateToIso(value: unknown): string | null {
  const s = str(value)
  if (!s) return null
  const ms = Date.parse(s)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/** `Locality, Region, Country` from the first PostalAddress that has any of them. */
export function teamtailorLocation(jp: TeamtailorJobPosting | null | undefined): string | null {
  const places = Array.isArray(jp?.jobLocation) ? jp?.jobLocation ?? [] : []
  for (const place of places) {
    const a = place && typeof place === 'object' ? place.address : null
    if (!a || typeof a !== 'object') continue
    const parts = [a.addressLocality, a.addressRegion, a.addressCountry].map((p) => str(p)).filter((p): p is string => !!p)
    if (parts.length > 0) return parts.join(', ')
  }
  return null
}

/**
 * The numeric id in the posting URL (`/jobs/8124573-group-financial-controller`)
 * is what identifies a Teamtailor job everywhere else. `_jobposting.identifier.value`
 * is the same number; the feed item's `id` is a UUID for the FEED ENTRY, which
 * is stable but not the job's public id. Prefer the number, fall back to the UUID.
 */
export function teamtailorJobId(item: TeamtailorItem): string | null {
  const ident = item._jobposting?.identifier?.value
  if (typeof ident === 'number' && Number.isFinite(ident)) return String(ident)
  const identStr = str(ident)
  if (identStr) return identStr
  const fromUrl = /\/jobs\/(\d+)/.exec(str(item.url) ?? '')
  if (fromUrl) return fromUrl[1]
  return str(item.id)
}

/** Null when the row is not usable. The caller counts those; it does not throw. */
export function normalizeTeamtailorItem(
  item: unknown,
  tenant: string,
  feedTitle: string | null,
  now = new Date().toISOString()
): RawJobPosting | null {
  if (!item || typeof item !== 'object') return null
  const row = item as TeamtailorItem
  const jp = row._jobposting && typeof row._jobposting === 'object' ? row._jobposting : null
  const title = str(row.title) ?? str(jp?.title)
  const url = str(row.url)
  if (!title || !url) return null

  const html = str(row.content_html) ?? str(jp?.description)
  const posted = teamtailorDateToIso(jp?.datePosted) ?? teamtailorDateToIso(row.date_published)
  const id = teamtailorJobId(row)

  return {
    // `JobSourceType` has no `teamtailor` member and this workstream does not
    // own that union; provenance lives in `raw.teamtailor`. See `open_issues`.
    source_type: 'careers_page',
    source_url: url,
    external_id: id,
    company_name: str(jp?.hiringOrganization?.name) ?? feedTitle ?? tenant,
    company_domain: null,
    title,
    location_raw: teamtailorLocation(jp),
    description_text: html ? htmlToText(html) : null,
    description_html: html,
    department: null,
    posted_at: posted,
    updated_at: null,
    apply_url: url,
    canonical_url: url,
    ats_type: 'other',
    ats_job_id: id,
    requisition_id: null,
    employment_type_hint: str(jp?.employmentType),
    raw: {
      teamtailor: {
        tenant,
        feed_item_id: str(row.id),
        job_id: id,
        // Per posting, not per tenant. Present on `oatly`, absent on `career`.
        valid_through: teamtailorDateToIso(jp?.validThrough),
        hiring_organization: str(jp?.hiringOrganization?.name),
        job_location: Array.isArray(jp?.jobLocation) ? jp?.jobLocation ?? [] : [],
        base_salary: jp?.baseSalary ?? null,
      },
      item: row as unknown as Record<string, unknown>,
    },
    retrieved_at: now,
  }
}

export function teamtailorTenantFromUrl(url: string | null | undefined): string | null {
  try {
    const host = new URL(url ?? '').hostname.toLowerCase()
    const m = /^([a-z0-9][a-z0-9-]*)\.teamtailor\.com$/.exec(host)
    return m ? m[1] : null
  } catch {
    return null
  }
}

// ─── The source ──────────────────────────────────────────────────────────────

export type TeamtailorFetcher = <T>(url: string) => Promise<JsonFetchResult<T>>

export interface TeamtailorSourceOptions {
  fetcher?: TeamtailorFetcher
  /** Tests only. Product code always honours robots.txt. */
  skipRobots?: boolean
  bypassCache?: boolean
}

export interface TeamtailorPage {
  items: unknown[]
  feedTitle: string | null
  status: number
  /** Rows the feed returned that this parser could not use. Reported, never hidden. */
  skipped: number
  error?: string
  note?: string
}

async function robotsBlocked(url: string, skip: boolean | undefined): Promise<boolean> {
  if (skip) return false
  try {
    const u = new URL(url)
    const rules = await getRobotsRules(u.origin)
    return !isPathAllowed(rules, u.pathname + u.search)
  } catch {
    return false
  }
}

export async function fetchTeamtailorPage(tenant: string, page: number, opts: TeamtailorSourceOptions): Promise<TeamtailorPage> {
  const url = teamtailorFeedUrl(tenant, page)
  if (await robotsBlocked(url, opts.skipRobots)) {
    return { items: [], feedTitle: null, status: 0, skipped: 0, error: `robots.txt disallows ${url}` }
  }
  const run = async (): Promise<TeamtailorPage> => {
    // `search` must never throw for ANY fetcher (discovery-types rule 1).
    let res: JsonFetchResult<TeamtailorFeed>
    try {
      res = await (opts.fetcher ?? fetchJson)<TeamtailorFeed>(url)
    } catch (e) {
      return { items: [], feedTitle: null, status: 0, skipped: 0, error: e instanceof Error ? e.message : String(e) }
    }
    // An empty body with a 404 is how a missing tenant answers.
    if (res.status === 404) return { items: [], feedTitle: null, status: 404, skipped: 0, note: `no Teamtailor board "${tenant}"` }
    if (res.status !== 200 || !res.data || typeof res.data !== 'object') {
      return { items: [], feedTitle: null, status: res.status, skipped: 0, error: res.error ?? `http ${res.status}` }
    }
    const feed = res.data
    // An undocumented feed is allowed to stop being a list. That is an empty
    // page with a note, not an exception.
    if (!Array.isArray(feed.items)) {
      return { items: [], feedTitle: str(feed.title), status: 200, skipped: 0, note: `Teamtailor feed for "${tenant}" had no items array` }
    }
    return { items: feed.items, feedTitle: str(feed.title), status: 200, skipped: 0 }
  }
  const key = cacheKey('teamtailor-feed', { tenant: tenant.toLowerCase(), page, day: utcDayKey() })
  return cached(key, run, opts.bypassCache ?? listCacheBypassFromEnv(), (r) => !r.error)
}

function matchesInput(posting: RawJobPosting, input: DiscoverySearchInput): boolean {
  if (input.internshipsOnly && !internshipLike(posting.title, posting.employment_type_hint)) return false
  if (input.location) {
    const want = input.location.toLowerCase()
    if (!(posting.location_raw ?? '').toLowerCase().includes(want)) return false
  }
  if (input.since) {
    const cutoff = Date.parse(input.since)
    const stamp = Date.parse(posting.posted_at ?? '')
    if (Number.isFinite(cutoff) && Number.isFinite(stamp) && stamp < cutoff) return false
  }
  const terms = [...(input.titleTerms ?? []), ...(input.query ? [input.query] : [])].map((t) => t.trim()).filter(Boolean)
  if (terms.length > 0) {
    const hay = `${posting.title} ${posting.description_text ?? ''}`.toLowerCase()
    if (!terms.some((t) => hay.includes(t.toLowerCase()))) return false
  }
  return true
}

function resolveTenant(input: DiscoverySearchInput): string | null {
  const hinted = typeof input.extra?.teamtailorTenant === 'string' ? input.extra.teamtailorTenant : null
  if (hinted) return hinted.trim().toLowerCase()
  if (input.board) {
    const fromUrl = teamtailorTenantFromUrl(input.board.board_url)
    if (fromUrl) return fromUrl
    if (input.board.identifier) return String(input.board.identifier).trim().toLowerCase()
  }
  const fromCompany = teamtailorTenantFromUrl(input.company?.careersUrl)
  if (fromCompany) return fromCompany
  return null
}

export function teamtailorSource(opts: TeamtailorSourceOptions = {}): JobDiscoverySource {
  return {
    id: 'teamtailor',
    name: 'Teamtailor',
    sourceType: 'ats',
    capabilities: {
      // `?page=N`, and an empty `items` array is the end.
      paginates: true,
      supportsQuery: true,
      supportsLocation: true,
      supportsSince: true,
      givesDescription: true,
      givesCanonicalUrl: true,
    },
    costModel: { kind: 'free' },
    isConfigured: () => process.env.CAREER_DISABLE_TEAMTAILOR !== '1',
    async healthCheck(): Promise<DiscoveryHealth> {
      const page = await fetchTeamtailorPage('career', 1, opts)
      if (page.error) return { ok: false, detail: `Teamtailor unreachable: ${page.error}` }
      return { ok: page.status === 200, detail: `Teamtailor reachable — career returned ${page.items.length} items` }
    },
    async search(input: DiscoverySearchInput, cursor?: string | null): Promise<DiscoverySearchResult> {
      const tenant = resolveTenant(input)
      if (!tenant) {
        return { postings: [], nextCursor: null, exhausted: true, seen: 0, note: 'Teamtailor needs a board or a company careers URL; neither named a tenant' }
      }
      const parsedCursor = Number.parseInt(cursor ?? '1', 10)
      const page = Number.isFinite(parsedCursor) && parsedCursor > 0 ? parsedCursor : 1
      if (page > TEAMTAILOR_MAX_PAGES) {
        return { postings: [], nextCursor: null, exhausted: true, seen: 0, note: `stopped at the ${TEAMTAILOR_MAX_PAGES}-page cap for "${tenant}"` }
      }

      const res = await fetchTeamtailorPage(tenant, page, opts)
      if (res.error) return { postings: [], nextCursor: null, exhausted: true, seen: 0, error: res.error, requests: 1 }
      if (res.status === 404) {
        return { postings: [], nextCursor: null, exhausted: true, seen: 0, note: res.note ?? `no Teamtailor board "${tenant}"`, requests: 1 }
      }

      const now = new Date().toISOString()
      let skipped = 0
      const all: RawJobPosting[] = []
      for (const item of res.items) {
        const posting = normalizeTeamtailorItem(item, tenant, res.feedTitle, now)
        if (posting) all.push(posting)
        else skipped++
      }
      const kept = all.filter((p) => matchesInput(p, input))
      const limited = input.limit && input.limit > 0 ? kept.slice(0, input.limit) : kept

      // An empty page is the only end-of-feed signal this feed gives: `oatly`
      // served 19 items on page 1 and an empty `items` on page 2 and on page 99.
      const endOfFeed = res.items.length === 0
      // …but the cap can also stop us, and stopping early while the feed still
      // had rows is a GAP. Reporting `exhausted` with no error would let
      // coverage.ts mark this source `completed` (it requires exhausted AND no
      // errors), i.e. hide the gap behind a checkmark — the one thing
      // discovery-types.ts forbids. So the cap-with-items case is an error,
      // and the postings this page did find are still returned alongside it.
      const truncated = !endOfFeed && page >= TEAMTAILOR_MAX_PAGES
      const exhausted = endOfFeed || truncated
      const notes: string[] = []
      if (res.note) notes.push(res.note)
      if (skipped > 0) notes.push(`${skipped} row(s) skipped — unrecognized shape`)
      if (truncated) {
        notes.push(`stopped at the ${TEAMTAILOR_MAX_PAGES}-page cap for "${tenant}" — the feed still had items, so this board is NOT fully read`)
      }

      return {
        postings: limited,
        nextCursor: exhausted ? null : String(page + 1),
        exhausted,
        seen: res.items.length,
        requests: 1,
        costUsd: 0,
        ...(truncated
          ? { error: `Teamtailor "${tenant}" truncated at the ${TEAMTAILOR_MAX_PAGES}-page cap with a full page — coverage is incomplete` }
          : {}),
        ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
      }
    },
  }
}
