// Oracle Recruiting Cloud (ORC / "Fusion Candidate Experience") as a pull feed.
//
// This is the single biggest recall unlock in Job Discovery V2. Large
// industrial employers — the ones a chemical engineer actually needs — run
// Oracle Fusion, and before this file every one of them answered "no public
// board detected". Measured live on 2026-08-31:
//
//   eeho.fa.us2.oraclecloud.com  (Oracle)    1 active site of 6,   2,135 reqs
//   hcwp.fa.us2.oraclecloud.com  (Coherent) 22 active sites of 23 — ONE
//                                            employer's regional boards, not 22
//                                            employers; 267 reqs on the US board
//                                            → "Process Engineer", "Sr. EHS
//                                              Engineer", "Manufacturing
//                                              Technician / Coating Department"
//
// Three endpoints, all unauthenticated GETs, all confirmed live:
//
//   SITES   GET /hcmRestApi/resources/latest/recruitingCESites?onlyData=true&limit=25
//   LIST    GET /hcmRestApi/resources/latest/recruitingCEJobRequisitions
//               ?onlyData=true&expand=requisitionList.secondaryLocations
//               &finder=findReqs;siteNumber={site},limit=25,offset=0,sortBy=POSTING_DATES_DESC
//   DETAIL  GET /hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails
//               ?expand=all&onlyData=true&finder=ById;Id="{Id}",siteNumber={site}
//
// FOUR THINGS THAT COST AN AFTERNOON IF YOU GUESS THEM
//
//  1. `limit` and `offset` live INSIDE the finder string, comma-separated,
//     after `findReqs`. As top-level query params they are ignored and every
//     page returns the same first 25 rows. `buildFinder` is the only place
//     that string is assembled, and the offline suite asserts on it.
//
//  2. SITE DISCOVERY IS PUBLIC, and it is the reason this adapter is different
//     from every other ATS: `recruitingCESites` enumerates a tenant's career
//     sites before you list a single job. It also enumerates the tenant's
//     INACTIVE reference copies — Oracle's own tenant publishes six sites of
//     which five are named things like "Oracle Modern FOR REFERENCE ONLY" and
//     "Baseline DO NOT UPDATE". Filter `StatusCode === 'ORA_ACTIVE'` or every
//     crawl reads Oracle's scratch data.
//
//  3. The list carries no description. `ExternalDescriptionStr` is absent from
//     the list rows entirely and `ShortDescriptionStr` is a 255-char teaser, so
//     a real description needs the detail call — one request per posting. That
//     is why `withDescriptions` defaults to FALSE: a listing sweep of Coherent
//     is 11 requests, and 11 + 267 is not the same operation.
//
//  4. `keyword` in the finder RANKS AND NARROWS but does not FILTER. On
//     Coherent, `keyword=intern` took 267 → 100 and the top rows were
//     "Sr. EHS Engineer" and "Facilities Operator". It is exposed as
//     `input.query` and is never used to decide what an internship is; the
//     title gate does that.
//
// IDENTITY. A board is a HOST plus a SITE CODE and neither is derivable from
// the other — Coherent's 22 sites all live on one host. `ats_identifier` is
// therefore `{host}|{siteNumber}`, e.g. `hcwp.fa.us2.oraclecloud.com|CX_1`.
// `formatOracleIdentifier` / `parseOracleIdentifier` are the only two places
// that format is known.
//
// THE EMPLOYER IS THE HOST, NOT THE SITE, AND NEVER THE SUBDOMAIN. A Fusion
// host is an opaque pod code (`hcwp` = Coherent, `eeho` = Oracle), unlike a
// Workday or Taleo tenant token — so it is never a company name. The host's
// site names are, and they are free: `oracleEmployerName` reduces
// "Coherent Corp. US" / "Coherent UK" / "Coherent Corp. Japan" to ONE employer,
// "Coherent", so a single company does not enter the pipeline as 22 (the
// deduper buckets strictly within `company_key` and could never re-join them).
// The site's own name survives as the board label in `raw.oracle.siteName`.
//
// Boundaries: public unauthenticated GETs to endpoints the employer's own
// careers page calls from the browser. No login, no CAPTCHA, robots.txt
// honoured (these hosts serve no robots.txt today — an absent robots.txt is
// not a prohibition, see robots.ts). One request per second per host.

import { cached, cacheKey } from '@/lib/providers/cache'
import type { RawJobPosting } from './types'
import type { AtsBoardRef } from './types'
import { internshipLike, listCacheBypassFromEnv, utcDayKey } from './fetch'
import { getRobotsRules, isPathAllowed, CAREER_BOT_USER_AGENT } from './robots'
import { htmlToText } from './html'
import {
  emptyDiscoveryResult,
  type DiscoveryHealth,
  type DiscoverySearchInput,
  type DiscoverySearchResult,
  type JobDiscoverySource,
} from './discovery-types'

/** Oracle honours larger values, but 25 is what the career sites themselves ask for. */
export const ORACLE_PAGE_SIZE = 25
/** Requests one `search` call will spend before handing a cursor back. */
export const ORACLE_MAX_REQUESTS_PER_CALL = 4
/** Sites are enumerated a page at a time; a tenant with more than this is pathological. */
export const ORACLE_SITES_PAGE_SIZE = 25
export const ORACLE_MAX_SITE_PAGES = 4
const MIN_GAP_MS = 1000
const DEFAULT_TIMEOUT_MS = 20_000

/** Oracle's own tenant. Used only by `healthCheck` as a stable public reference. */
export const ORACLE_HEALTH_HOST = 'eeho.fa.us2.oraclecloud.com'

// ─── Identity ────────────────────────────────────────────────────────────────

export interface OracleBoardId {
  /** The full Fusion host, e.g. `hcwp.fa.us2.oraclecloud.com`. */
  host: string
  /** The career site code, e.g. `CX_1`. */
  siteNumber: string
}

const HOST_RE = /^[a-z0-9][a-z0-9.-]*\.oraclecloud\.com$/
const SITE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function isOracleHost(host: string): boolean {
  return HOST_RE.test(host.toLowerCase())
}

/** `{host}|{siteNumber}` — the documented `ats_identifier` format for this ATS. */
export function formatOracleIdentifier(id: OracleBoardId): string {
  return `${id.host.toLowerCase()}|${id.siteNumber}`
}

export function parseOracleIdentifier(identifier: string): OracleBoardId | null {
  const parts = (identifier ?? '').split('|')
  if (parts.length !== 2) return null
  const host = parts[0].trim().toLowerCase()
  const siteNumber = parts[1].trim()
  if (!isOracleHost(host) || !SITE_RE.test(siteNumber)) return null
  return { host, siteNumber }
}

export function oracleBoardUrl(id: OracleBoardId): string {
  return `https://${id.host}/hcmUI/CandidateExperience/en/sites/${id.siteNumber}`
}

/** The page a candidate would open. Confirmed HTTP 200 on hcwp/CX_1/2011324. */
export function oraclePostingUrl(id: OracleBoardId, requisitionId: string): string {
  return `${oracleBoardUrl(id)}/job/${requisitionId}`
}

export function oracleSitesUrl(host: string, limit = ORACLE_SITES_PAGE_SIZE, offset = 0): string {
  return `https://${host}/hcmRestApi/resources/latest/recruitingCESites?onlyData=true&limit=${limit}&offset=${offset}`
}

export interface OracleFinderOptions {
  siteNumber: string
  limit: number
  offset: number
  sortBy?: string
  /** Free-text. Oracle ranks and narrows by it; it is NOT a filter. */
  keyword?: string | null
}

/**
 * The finder string, and the one trap worth a test of its own: `limit` and
 * `offset` are FINDER arguments, not query params. Written as
 * `?finder=findReqs;siteNumber=X&limit=25&offset=25` the API happily returns
 * the same first page forever.
 */
export function buildFinder(opts: OracleFinderOptions): string {
  const parts = [`siteNumber=${opts.siteNumber}`]
  if (opts.keyword && opts.keyword.trim()) parts.push(`keyword=${encodeURIComponent(opts.keyword.trim())}`)
  parts.push(`limit=${opts.limit}`)
  parts.push(`offset=${opts.offset}`)
  parts.push(`sortBy=${opts.sortBy ?? 'POSTING_DATES_DESC'}`)
  return `findReqs;${parts.join(',')}`
}

export function oracleListUrl(host: string, opts: OracleFinderOptions): string {
  const finder = buildFinder(opts)
  return (
    `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions` +
    `?onlyData=true&expand=requisitionList.secondaryLocations&finder=${finder}`
  )
}

export function oracleDetailUrl(id: OracleBoardId, requisitionId: string): string {
  // The Id is quoted inside the finder. Unquoted, Oracle answers with an empty
  // item list rather than an error.
  return (
    `https://${id.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails` +
    `?expand=all&onlyData=true&finder=ById;Id="${requisitionId}",siteNumber=${id.siteNumber}`
  )
}

/**
 * Recognize an Oracle Fusion careers URL and pull the board identity out of it.
 * Pure, no network — the Simplify feed hands over 47 of these URLs for free and
 * this is how a tenant gets adopted.
 */
export function matchOracleUrl(url: string): { board: AtsBoardRef; jobId: string | null } | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const host = u.hostname.toLowerCase()
  if (!isOracleHost(host)) return null
  const segments = u.pathname.split('/').filter(Boolean)
  const sitesAt = segments.indexOf('sites')
  let siteNumber = sitesAt >= 0 ? segments[sitesAt + 1] ?? null : null
  if (!siteNumber) siteNumber = u.searchParams.get('siteNumber')
  if (!siteNumber) {
    // A bare host still identifies a tenant worth discovering sites on. Say so
    // with an empty site rather than pretending we did not recognise it.
    return { board: { ats: 'other', identifier: `${host}|`, board_url: `https://${host}` }, jobId: null }
  }
  if (!SITE_RE.test(siteNumber)) return null
  const id = { host, siteNumber }
  const jobAt = segments.indexOf('job')
  const jobId = jobAt >= 0 ? segments[jobAt + 1] ?? null : null
  return {
    board: { ats: 'other', identifier: formatOracleIdentifier(id), board_url: oracleBoardUrl(id) },
    jobId: jobId && /^[0-9A-Za-z_-]+$/.test(jobId) ? jobId : null,
  }
}

// ─── Payload shapes ──────────────────────────────────────────────────────────

export interface OracleSite {
  SiteId?: number
  SiteName?: string
  SiteCode?: string
  SiteNumber?: string
  /** `ORA_ACTIVE` or `ORA_INACTIVE`. Only the first is a real career site. */
  StatusCode?: string
  Language?: string
  [k: string]: unknown
}

export interface OracleSitesResponse {
  items?: OracleSite[]
  count?: number
  hasMore?: boolean
  [k: string]: unknown
}

export interface OracleSecondaryLocation {
  Name?: string
  CountryCode?: string
  [k: string]: unknown
}

export interface OracleRequisition {
  Id?: string
  Title?: string
  PostedDate?: string | null
  PostingEndDate?: string | null
  PrimaryLocation?: string | null
  PrimaryLocationCountry?: string | null
  WorkerType?: string | null
  JobFamily?: string | null
  JobFunction?: string | null
  JobType?: string | null
  ContractType?: string | null
  Category?: string | null
  Organization?: string | null
  Department?: string | null
  WorkplaceType?: string | null
  WorkplaceTypeCode?: string | null
  ShortDescriptionStr?: string | null
  ExternalDescriptionStr?: string | null
  ExternalQualificationsStr?: string | null
  ExternalResponsibilitiesStr?: string | null
  ExternalPostedStartDate?: string | null
  RequisitionId?: string | number | null
  secondaryLocations?: OracleSecondaryLocation[] | null
  [k: string]: unknown
}

export interface OracleSearchItem {
  TotalJobsCount?: number
  Offset?: number
  Limit?: number
  SiteNumber?: string
  requisitionList?: OracleRequisition[]
  [k: string]: unknown
}

export interface OracleListResponse {
  items?: OracleSearchItem[]
  [k: string]: unknown
}

export interface OracleDetailResponse {
  items?: OracleRequisition[]
  [k: string]: unknown
}

/** The one filter that keeps Oracle's own scratch sites out of every crawl. */
export function activeOracleSites(sites: OracleSite[] | undefined): OracleSite[] {
  return (Array.isArray(sites) ? sites : []).filter((s) => s?.StatusCode === 'ORA_ACTIVE' && !!s.SiteNumber)
}

/**
 * ONE EMPLOYER PER HOST.
 *
 * A Fusion host's active sites are that employer's REGIONAL PORTALS, not
 * different employers: Coherent publishes 22 of them — "Coherent Corp. US",
 * "Coherent UK", "Coherent Corp. Japan", … — and stamping each posting with its
 * own site name enters one company into the pipeline as up to 22, which the
 * deduper can never re-join (it buckets strictly within `company_key`).
 *
 * So the site name stays the BOARD label (kept in `raw.oracle.siteName`) and
 * the employer identity is the name shared across the host's sites: the most
 * common leading word, extended while a majority of sites still agree.
 * A plain longest-common-prefix is not enough — Coherent's 22 include
 * "II-VI Aerospace & Defense | Coherent", which shares no prefix at all and
 * would collapse the answer to the empty string.
 */
export function oracleEmployerName(sites: OracleSite[]): string | null {
  const names = sites
    .map((s) => (typeof s?.SiteName === 'string' ? s.SiteName.trim() : ''))
    .filter((n) => n.length > 0)
  if (names.length === 0) return null
  if (names.length === 1) return cleanEmployerName(names[0])

  const tokenized = names.map((n) => ({ name: n, tokens: n.split(/\s+/).filter(Boolean) }))
  const majority = Math.floor(names.length / 2) + 1
  const prefix: string[] = []
  for (let depth = 0; depth < 6; depth++) {
    const counts = new Map<string, { token: string; n: number }>()
    for (const entry of tokenized) {
      if (!prefixMatches(entry.tokens, prefix)) continue
      const token = entry.tokens[depth]
      if (!token) continue
      const key = token.toLowerCase()
      const seen = counts.get(key)
      if (seen) seen.n++
      else counts.set(key, { token, n: 1 })
    }
    let best: { token: string; n: number } | null = null
    for (const c of counts.values()) if (!best || c.n > best.n) best = c
    // "A majority of this host's sites start this way" is the whole test. On
    // Coherent 21 of 22 begin "Coherent" (yes) and only 10 continue "Corp."
    // (no), which is exactly where the employer name ends.
    if (!best || best.n < majority) break
    prefix.push(best.token)
  }
  if (prefix.length === 0) return null
  // "Careers US" / "Careers EMEA" agree on a word that names no employer. One
  // generic token is not an identity; better to have none and fall back to the
  // host than to file postings under a company called "Careers".
  if (prefix.length === 1 && GENERIC_SITE_WORDS.has(prefix[0].toLowerCase().replace(/[^a-z]/g, ''))) return null
  return cleanEmployerName(prefix.join(' '))
}

const GENERIC_SITE_WORDS = new Set([
  'careers', 'career', 'jobs', 'job', 'external', 'internal', 'candidate', 'experience',
  'recruiting', 'recruitment', 'opportunities', 'vacancies', 'site', 'sites', 'portal', 'hiring', 'talent',
])

function prefixMatches(tokens: string[], prefix: string[]): boolean {
  return prefix.every((p, i) => (tokens[i] ?? '').toLowerCase() === p.toLowerCase())
}

/** Trailing punctuation and a dangling connector are noise, not identity. */
function cleanEmployerName(name: string): string {
  return name
    .replace(/\s*[|,;:/-]\s*$/, '')
    .replace(/\s+(and|&|of|the)$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

// ─── Fetching ────────────────────────────────────────────────────────────────

export interface OracleFetchResult {
  status: number
  contentType: string
  body: string
  error?: string
}

/** Test seam: the offline suite hands the parser recorded fixtures. */
export type OracleFetcher = (url: string) => Promise<OracleFetchResult>

const lastHit = new Map<string, number>()

async function throttle(origin: string, gapMs: number): Promise<void> {
  const now = Date.now()
  const prev = lastHit.get(origin) ?? 0
  const wait = prev + gapMs - now
  lastHit.set(origin, Math.max(now, prev + gapMs))
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
}

/** Robots gate for one Fusion host. An absent robots.txt is not a prohibition. */
export async function oracleAllowed(host: string, path: string): Promise<{ allowed: boolean; reason?: string }> {
  if (process.env.CAREER_SKIP_ROBOTS === '1') return { allowed: true }
  const origin = `https://${host}`
  const rules = await getRobotsRules(origin)
  if (!isPathAllowed(rules, path)) return { allowed: false, reason: `robots.txt disallows ${path}` }
  await throttle(origin, Math.max(MIN_GAP_MS, rules.crawlDelayMs ?? 0))
  return { allowed: true }
}

const liveFetcher: OracleFetcher = async (url) => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { status: 0, contentType: '', body: '', error: 'invalid url' }
  }
  const gate = await oracleAllowed(parsed.hostname, parsed.pathname)
  if (!gate.allowed) return { status: 0, contentType: '', body: '', error: gate.reason }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': CAREER_BOT_USER_AGENT, Accept: 'application/json' },
      redirect: 'follow',
      signal: controller.signal,
    })
    return {
      status: res.status,
      // Oracle answers `application/vnd.oracle.adf.resourcecollection+json`, not
      // `application/json`, so never test this string for equality.
      contentType: (res.headers.get('content-type') ?? '').toLowerCase(),
      body: await res.text(),
    }
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    return { status: 0, contentType: '', body: '', error: aborted ? 'timeout' : err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
}

export interface OracleJsonResult<T> {
  data: T | null
  error?: string
}

/**
 * One GET, parsed, cached per URL per UTC day. Never throws: a dead host, a
 * 404 and an HTML error page all come back as `error`.
 */
export async function oracleGetJson<T>(url: string, fetcher: OracleFetcher, bypass = false): Promise<OracleJsonResult<T>> {
  return cached<OracleJsonResult<T>>(
    cacheKey('oracle-orc', { url, day: utcDayKey() }),
    async () => {
      const res = await fetcher(url)
      if (res.error) return { data: null, error: res.error }
      if (res.status < 200 || res.status >= 300) return { data: null, error: `http ${res.status}` }
      // Fusion serves an Apache HTML 404 page for a wrong path, with a 200 in
      // some proxy configurations. Content-type is the honest signal.
      if (res.contentType && !res.contentType.includes('json')) {
        return { data: null, error: `expected JSON, got ${res.contentType}` }
      }
      try {
        return { data: JSON.parse(res.body) as T }
      } catch (e) {
        return { data: null, error: `response was not JSON: ${e instanceof Error ? e.message : String(e)}` }
      }
    },
    bypass,
    (r) => !r.error
  )
}

// ─── Site discovery: the part no other ATS gives away ────────────────────────

export interface OracleSitesResult {
  sites: OracleSite[]
  error?: string
  requests: number
}

/**
 * Every ACTIVE career site a tenant publishes, in the order the tenant lists
 * them. One request per 25 sites. Coherent returns 22 active of 23; Oracle
 * returns 1 active of 6.
 */
export async function oracleActiveSites(host: string, fetcher: OracleFetcher, bypass = false): Promise<OracleSitesResult> {
  const out: OracleSite[] = []
  let requests = 0
  for (let page = 0; page < ORACLE_MAX_SITE_PAGES; page++) {
    const url = oracleSitesUrl(host, ORACLE_SITES_PAGE_SIZE, page * ORACLE_SITES_PAGE_SIZE)
    const res = await oracleGetJson<OracleSitesResponse>(url, fetcher, bypass)
    requests++
    if (res.error) return { sites: out, error: page === 0 ? res.error : undefined, requests }
    const items = Array.isArray(res.data?.items) ? (res.data?.items as OracleSite[]) : []
    out.push(...activeOracleSites(items))
    if (!res.data?.hasMore || items.length === 0) break
  }
  return { sites: out, requests }
}

/**
 * Active sites as boards, ready for the watchlist.
 *
 * Every board on a host carries the SAME `company_name` — the employer identity
 * resolved from the host's site names — because these are one employer's
 * regional portals. `siteNames` returns the per-board label alongside, for
 * display; it is deliberately not the company name.
 */
export async function discoverOracleBoards(
  host: string,
  fetcher?: OracleFetcher
): Promise<{ boards: AtsBoardRef[]; employer: string | null; siteNames: Record<string, string>; error?: string }> {
  const res = await oracleActiveSites(host, fetcher ?? liveFetcher, listCacheBypassFromEnv())
  const employer = oracleEmployerName(res.sites)
  const siteNames: Record<string, string> = {}
  const boards = res.sites.map((s) => {
    const id = { host: host.toLowerCase(), siteNumber: String(s.SiteNumber) }
    const label = (s.SiteName ?? '').trim()
    if (label) siteNames[id.siteNumber] = label
    return {
      ats: 'other' as const,
      identifier: formatOracleIdentifier(id),
      company_name: employer ?? (label || undefined),
      board_url: oracleBoardUrl(id),
    }
  })
  return { boards, employer, siteNames, error: res.error }
}

// ─── Normalizing ─────────────────────────────────────────────────────────────

/** `2026-08-31` → ISO. A full ISO stamp (the detail's `ExternalPostedStartDate`) passes through. */
export function oracleDate(value: string | null | undefined): string | null {
  if (!value) return null
  const s = String(value).trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T00:00:00Z`).toISOString()
  const t = Date.parse(s)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

/**
 * `secondaryLocations` is Oracle's field to reshape and `search` may never
 * throw (discovery-types.ts, rule 1), so the shape is checked rather than
 * trusted: an object where an array was expected degrades to "no secondary
 * locations", not to a TypeError that ends a twenty-board sweep.
 */
export function oracleSecondaryLocations(req: OracleRequisition): OracleSecondaryLocation[] {
  return Array.isArray(req.secondaryLocations) ? req.secondaryLocations : []
}

export function oracleLocations(req: OracleRequisition): string | null {
  const parts: string[] = []
  const primary = typeof req.PrimaryLocation === 'string' ? req.PrimaryLocation.trim() : ''
  if (primary) parts.push(primary)
  for (const s of oracleSecondaryLocations(req)) {
    const name = (s?.Name ?? '').trim()
    if (name && !parts.includes(name)) parts.push(name)
  }
  return parts.length ? parts.join(' · ') : null
}

/**
 * The description, when a detail call has been made. Oracle splits it across
 * three HTML fields and a careers page renders all three, so all three are kept.
 */
export function oracleDescriptionHtml(req: OracleRequisition): string | null {
  const parts = [req.ExternalDescriptionStr, req.ExternalResponsibilitiesStr, req.ExternalQualificationsStr]
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean)
  return parts.length ? parts.join('\n') : null
}

export interface OracleNormalizeContext {
  id: OracleBoardId
  /** ONE employer per host. See `oracleEmployerName`. */
  companyName?: string | null
  /** This site's own label ("Coherent UK"). Board metadata, never the employer. */
  siteName?: string | null
  now?: string
}

export function normalizeOracleRequisition(req: OracleRequisition, ctx: OracleNormalizeContext): RawJobPosting | null {
  const externalId = req.Id != null ? String(req.Id) : null
  const title = (req.Title ?? '').trim()
  if (!externalId || !title) return null
  const now = ctx.now ?? new Date().toISOString()
  const url = oraclePostingUrl(ctx.id, externalId)
  const html = oracleDescriptionHtml(req)
  const short = (req.ShortDescriptionStr ?? '').trim()

  return {
    // JobSourceType has no `oracle` member and this adapter must not widen a
    // shared enum it does not own; `careers_page` is what the rest of the code
    // already assigns to Fusion hosts (see simplify.ts `atsFromUrl`).
    source_type: 'careers_page',
    source_url: url,
    external_id: externalId,
    // A Fusion host is an opaque POD CODE — `hcwp` is Coherent, `eeho` is
    // Oracle — so the subdomain is never a company name. The employer comes
    // from the caller or from `oracleEmployerName`; when neither is available
    // the full host is recorded, which reads as the address it is rather than
    // inventing an employer literally named "hcwp".
    company_name: (ctx.companyName ?? '').trim() || (ctx.siteName ?? '').trim() || ctx.id.host,
    company_domain: null,
    title,
    location_raw: oracleLocations(req),
    // Without a detail call the only text is a 255-char teaser. It is kept as
    // text but never as `description_html`, so nothing downstream mistakes a
    // teaser for a description it can cite.
    description_text: html ? htmlToText(html) : short || null,
    description_html: html,
    department: (req.JobFamily ?? req.Category ?? req.Organization ?? req.Department ?? null) || null,
    posted_at: oracleDate(req.PostedDate ?? req.ExternalPostedStartDate),
    updated_at: null,
    apply_url: url,
    canonical_url: url,
    ats_type: 'other',
    ats_job_id: externalId,
    requisition_id: req.RequisitionId != null ? String(req.RequisitionId) : null,
    employment_type_hint: (req.WorkerType ?? req.JobType ?? req.ContractType ?? null) || null,
    raw: {
      oracle: {
        host: ctx.id.host,
        siteNumber: ctx.id.siteNumber,
        /** The board label — "Coherent UK" — kept apart from the employer name. */
        siteName: (ctx.siteName ?? '').trim() || null,
        WorkplaceType: req.WorkplaceType ?? req.WorkplaceTypeCode ?? null,
        WorkerType: req.WorkerType ?? null,
        JobFamily: req.JobFamily ?? null,
        PrimaryLocation: req.PrimaryLocation ?? null,
        secondaryLocations: oracleSecondaryLocations(req).map((s) => s?.Name).filter(Boolean),
        ShortDescriptionStr: short || null,
        hasFullDescription: !!html,
      },
      requisition: req as Record<string, unknown>,
    },
    retrieved_at: now,
  }
}

// ─── Cursor: `{siteNumber}@{offset}` ─────────────────────────────────────────

export interface OracleCursor {
  siteNumber: string
  offset: number
}

export function formatOracleCursor(c: OracleCursor): string {
  return `${c.siteNumber}@${c.offset}`
}

export function parseOracleCursor(cursor: string | null | undefined): OracleCursor | null {
  if (!cursor) return null
  const at = cursor.lastIndexOf('@')
  if (at <= 0) return null
  const siteNumber = cursor.slice(0, at)
  const offset = Number.parseInt(cursor.slice(at + 1), 10)
  if (!SITE_RE.test(siteNumber) || !Number.isFinite(offset) || offset < 0) return null
  return { siteNumber, offset }
}

// ─── Addressing ──────────────────────────────────────────────────────────────

export interface OracleTarget {
  host: string
  /** Null when only a host is known — the source will discover the sites. */
  siteNumber: string | null
  companyName: string | null
}

/**
 * Where this call is pointed. A board identifier wins; then an explicit
 * `extra.host`; then any oraclecloud.com URL the caller happens to have.
 */
export function resolveOracleTarget(input: DiscoverySearchInput, fallbackHost?: string | null): OracleTarget | null {
  const named = (input.board?.company_name ?? input.company?.name ?? null) || null

  const identifier = input.board?.identifier ?? null
  if (identifier) {
    const parsed = parseOracleIdentifier(identifier)
    if (parsed) return { host: parsed.host, siteNumber: parsed.siteNumber, companyName: named }
    // `host|` — a tenant with no site chosen yet.
    const [maybeHost, rest] = identifier.split('|')
    if (rest === '' && isOracleHost((maybeHost ?? '').toLowerCase())) {
      return { host: maybeHost.toLowerCase(), siteNumber: null, companyName: named }
    }
  }

  const extraHost = typeof input.extra?.oracleHost === 'string' ? input.extra.oracleHost : null
  if (extraHost && isOracleHost(extraHost.toLowerCase())) {
    const extraSite = typeof input.extra?.oracleSite === 'string' ? input.extra.oracleSite : null
    return { host: extraHost.toLowerCase(), siteNumber: extraSite && SITE_RE.test(extraSite) ? extraSite : null, companyName: named }
  }

  for (const candidate of [input.board?.board_url, input.company?.careersUrl]) {
    if (!candidate) continue
    const m = matchOracleUrl(candidate)
    if (!m) continue
    const parsed = parseOracleIdentifier(m.board.identifier)
    if (parsed) return { host: parsed.host, siteNumber: parsed.siteNumber, companyName: named }
    const host = m.board.identifier.split('|')[0]
    if (isOracleHost(host)) return { host, siteNumber: null, companyName: named }
  }

  if (fallbackHost && isOracleHost(fallbackHost.toLowerCase())) {
    return { host: fallbackHost.toLowerCase(), siteNumber: null, companyName: named }
  }
  return null
}

// ─── The source ──────────────────────────────────────────────────────────────

export interface OracleOrcSourceOptions {
  fetcher?: OracleFetcher
  /**
   * Fetch the detail call per posting so descriptions arrive with the listing.
   * FALSE by default: it is one extra request per posting, and a listing sweep
   * of a 267-posting board would go from 11 requests to 278.
   */
  withDescriptions?: boolean
  /** Used when no board or URL addresses a host. Mainly for a single-tenant run. */
  host?: string | null
  /** Host `healthCheck` probes. Defaults to Oracle's own public tenant. */
  healthHost?: string
  bypassCache?: boolean
  now?: () => string
}

function matchesLocation(posting: RawJobPosting, location: string | null | undefined): boolean {
  if (!location) return true
  return (posting.location_raw ?? '').toLowerCase().includes(location.toLowerCase())
}

function matchesTerms(posting: RawJobPosting, terms: string[]): boolean {
  if (terms.length === 0) return true
  const hay = `${posting.title} ${posting.department ?? ''}`.toLowerCase()
  return terms.some((t) => t.trim() && hay.includes(t.trim().toLowerCase()))
}

export function oracleOrcSource(opts: OracleOrcSourceOptions = {}): JobDiscoverySource {
  const fetcher = opts.fetcher ?? liveFetcher
  const bypass = opts.bypassCache ?? listCacheBypassFromEnv()
  const withDescriptionsDefault = opts.withDescriptions === true
  const nowFn = opts.now ?? (() => new Date().toISOString())

  return {
    id: 'oracle-orc',
    name: 'Oracle Recruiting Cloud (Fusion)',
    sourceType: 'ats',
    capabilities: {
      paginates: true,
      // `keyword` in the finder narrows the result set (267 → 100 on Coherent).
      // It ranks; it does not filter. See the header note.
      supportsQuery: true,
      // Honoured client-side against PrimaryLocation + secondaryLocations.
      supportsLocation: true,
      // POSTING_DATES_DESC lets the pager stop as soon as it crosses the cutoff.
      supportsSince: true,
      givesDescription: withDescriptionsDefault,
      givesCanonicalUrl: true,
    },
    costModel: { kind: 'free' },
    isConfigured: () => true,

    async healthCheck(): Promise<DiscoveryHealth> {
      const host = opts.healthHost ?? opts.host ?? ORACLE_HEALTH_HOST
      const res = await oracleActiveSites(host, fetcher, bypass)
      if (res.error) return { ok: false, detail: `${host}: ${res.error}` }
      return {
        ok: res.sites.length > 0,
        detail: `${host}: ${res.sites.length} active career site(s)`,
      }
    },

    async search(input: DiscoverySearchInput, cursor?: string | null): Promise<DiscoverySearchResult> {
      const target = resolveOracleTarget(input, opts.host)
      if (!target) {
        return emptyDiscoveryResult(
          'Oracle ORC is addressed by a board — ats_identifier "{host}|{siteNumber}" or any *.oraclecloud.com careers URL'
        )
      }

      const withDescriptions =
        typeof input.extra?.withDescriptions === 'boolean' ? input.extra.withDescriptions : withDescriptionsDefault
      const now = nowFn()
      let requests = 0

      // Which sites to walk. A named site is walked alone; a bare host has its
      // ACTIVE sites enumerated first — the inactive reference copies are how a
      // crawl ends up reading "Oracle Modern FOR REFERENCE ONLY".
      let siteNumbers: string[]
      let siteNames = new Map<string, string>()
      let siteNote = ''
      let employer: string | null = (target.companyName ?? '').trim() || null
      if (target.siteNumber) {
        siteNumbers = [target.siteNumber]
        if (!employer) {
          // ONE day-cached request buys the employer its real name. Without it
          // a board addressed by identifier alone — which is exactly how the
          // Fusion URLs harvested from the Simplify corpus arrive, with no
          // company attached — would file every posting under a pod code.
          const named = await oracleActiveSites(target.host, fetcher, bypass)
          requests += named.requests
          if (named.sites.length) {
            siteNames = new Map(named.sites.map((s) => [String(s.SiteNumber), (s.SiteName ?? '').trim()]))
            employer = oracleEmployerName(named.sites)
          }
          // A failed lookup is not fatal: normalization falls back to the site
          // label, then to the host. Nothing is invented.
        }
      } else {
        const discovered = await oracleActiveSites(target.host, fetcher, bypass)
        requests += discovered.requests
        if (discovered.error) {
          return { postings: [], nextCursor: null, exhausted: true, seen: 0, requests, error: `site discovery failed: ${discovered.error}` }
        }
        if (!discovered.sites.length) {
          return { postings: [], nextCursor: null, exhausted: true, seen: 0, requests, note: `${target.host} publishes no ORA_ACTIVE career site` }
        }
        siteNumbers = discovered.sites.map((s) => String(s.SiteNumber))
        siteNames = new Map(discovered.sites.map((s) => [String(s.SiteNumber), (s.SiteName ?? '').trim()]))
        employer = employer ?? oracleEmployerName(discovered.sites)
        // "22 active sites" is 22 REGIONAL BOARDS OF ONE EMPLOYER, and the note
        // has to say so — read as 22 companies it overstates the crawl by 21.
        siteNote = `${siteNumbers.length} active site(s) on ${target.host}${employer ? ` — regional boards of ${employer}` : ''}`
      }

      const parsed = parseOracleCursor(cursor)
      let siteIndex = parsed ? siteNumbers.indexOf(parsed.siteNumber) : 0
      if (siteIndex < 0) siteIndex = 0
      let offset = parsed && siteNumbers[siteIndex] === parsed.siteNumber ? parsed.offset : 0

      const want = input.limit && input.limit > 0 ? input.limit : ORACLE_PAGE_SIZE
      const pageSize = Math.min(Math.max(want, 1), ORACLE_PAGE_SIZE)
      const terms = [...(input.titleTerms ?? [])]
      const sinceMs = input.since ? Date.parse(input.since) : NaN
      const cutoff = Number.isFinite(sinceMs) ? sinceMs : null

      const postings: RawJobPosting[] = []
      const errors: string[] = []
      let seen = 0
      let totalOnSite: number | null = null
      let lastTotal: number | null = null
      let crossedCutoff = false
      let listRequests = 0

      while (siteIndex < siteNumbers.length && listRequests < ORACLE_MAX_REQUESTS_PER_CALL) {
        const siteNumber = siteNumbers[siteIndex]
        const id: OracleBoardId = { host: target.host, siteNumber }
        const url = oracleListUrl(target.host, {
          siteNumber,
          limit: pageSize,
          offset,
          keyword: input.query ?? null,
        })
        const res = await oracleGetJson<OracleListResponse>(url, fetcher, bypass)
        requests++
        listRequests++
        if (res.error) {
          // One bad site does not end the sweep, and whatever earlier pages
          // produced is kept — principle 9. Move to the next site and say so.
          errors.push(`${siteNumber}: ${res.error}`)
          siteIndex++
          offset = 0
          totalOnSite = null
          crossedCutoff = false
          continue
        }
        const items = Array.isArray(res.data?.items) ? (res.data?.items as OracleSearchItem[]) : []
        const item = items[0]
        const rows = Array.isArray(item?.requisitionList) ? (item?.requisitionList as OracleRequisition[]) : []
        totalOnSite = typeof item?.TotalJobsCount === 'number' ? item.TotalJobsCount : totalOnSite
        if (totalOnSite !== null) lastTotal = totalOnSite
        seen += rows.length

        const siteName = siteNames.get(siteNumber) ?? null
        for (const row of rows) {
          const posting = normalizeOracleRequisition(row, { id, companyName: employer, siteName, now })
          if (!posting) continue
          if (cutoff !== null && posting.posted_at) {
            const t = Date.parse(posting.posted_at)
            // POSTING_DATES_DESC: once a row is older than the cutoff every
            // later row on this site is too.
            if (Number.isFinite(t) && t < cutoff) {
              crossedCutoff = true
              continue
            }
          }
          if (input.internshipsOnly && !internshipLike(posting.title, posting.employment_type_hint)) continue
          if (!matchesTerms(posting, terms)) continue
          if (!matchesLocation(posting, input.location)) continue
          postings.push(posting)
        }

        // A MISSING `TotalJobsCount` MUST NOT READ AS "FINISHED". With the count
        // treated as 0, a full page satisfied `offset + rows >= total` and the
        // source declared itself exhausted after one request — a silent claim
        // of complete coverage over a partial read. A full page means there is
        // probably more; only a stated total can end a site early.
        const siteDone =
          crossedCutoff ||
          rows.length < pageSize ||
          (totalOnSite !== null && offset + rows.length >= totalOnSite)
        if (siteDone) {
          siteIndex++
          offset = 0
          totalOnSite = null
          crossedCutoff = false
        } else {
          offset += rows.length
        }
        if (postings.length >= want) break
      }

      if (withDescriptions && postings.length) {
        for (const posting of postings) {
          if (posting.description_html || !posting.external_id) continue
          const site = String((posting.raw.oracle as { siteNumber?: string } | undefined)?.siteNumber ?? '')
          if (!SITE_RE.test(site)) continue
          const id: OracleBoardId = { host: target.host, siteNumber: site }
          const res = await oracleGetJson<OracleDetailResponse>(oracleDetailUrl(id, posting.external_id), fetcher, bypass)
          requests++
          const detail = Array.isArray(res.data?.items) ? (res.data?.items as OracleRequisition[])[0] : undefined
          if (!detail) continue
          const html = oracleDescriptionHtml(detail)
          if (html) {
            posting.description_html = html
            posting.description_text = htmlToText(html)
          }
          posting.posted_at = posting.posted_at ?? oracleDate(detail.ExternalPostedStartDate)
          posting.requisition_id = posting.requisition_id ?? (detail.RequisitionId != null ? String(detail.RequisitionId) : null)
          posting.raw = { ...posting.raw, detail: detail as Record<string, unknown> }
        }
      }

      const exhausted = siteIndex >= siteNumbers.length
      const nextCursor = exhausted ? null : formatOracleCursor({ siteNumber: siteNumbers[siteIndex], offset })
      const noteParts = [siteNote, lastTotal !== null ? `${lastTotal} requisitions on the site just read` : ''].filter(Boolean)
      return {
        postings,
        nextCursor,
        exhausted,
        seen,
        note: noteParts.length ? noteParts.join('; ') : undefined,
        error: errors.length ? errors.join('; ') : undefined,
        requests,
      }
    },
  }
}
