// Oracle Taleo career sections as a pull feed.
//
// Taleo is the previous generation of Oracle recruiting and it is still where a
// great many industrial employers, national labs and hospital systems post.
// Everything below was confirmed live on 2026-08-31 against cu, massanf, tgh,
// teletech, aarcorp, baesystems, lbl, kp, weyerhaeuser and jacobs.
//
//   POST https://{tenant}.taleo.net/careersection/rest/jobboard/searchjobs
//        ?lang=en&portal={portalId}
//   →    { requisitionList: [{ jobId, contestNo, column[], linkedColumn,
//                              locationsColumns }],
//          pagingData: { currentPageNo, pageSize, totalCount },
//          careerSectionUnAvailable }
//
// FIVE THINGS, EACH MEASURED, EACH ONE FATAL IF GUESSED
//
//  1. THE `tz` HEADER IS THE WHOLE TRICK. The identical request without
//     `tz: GMT-04:00` returns HTTP 500 `An Error Occurred in TEE`; with it,
//     HTTP 200 and 712 requisitions. The CSRF-token dance every guide on the
//     internet describes is unnecessary — no token, no cookie, no session.
//
//  2. `fieldData.fields` MUST BE AN OBJECT. The array-of-{fieldName,value}
//     form that reads more natural returns HTTP 400 `An Error Occurred in TEE`.
//
//  3. `column` IS POSITIONAL AND TENANT-CONFIGURED. `linkedColumn` names the
//     index of the title and `locationsColumns` names the location indices.
//     Berkeley Lab (`lbl`) is the proof that indices must never be hardcoded:
//     its `linkedColumn` is 1 and column 0 is the contest number, so an adapter
//     that assumed 0 would file every Berkeley Lab posting under the job title
//     "107409". BAE Systems returns a single column and no locations at all.
//
//  4. LOCATION IS DOUBLE-ENCODED. The location cell is a STRING containing a
//     JSON array: `'["Massachusetts-Boston"]'`. Parse the row, then parse the
//     cell.
//
//  5. ~50% OF TENANTS FAIL, AND THE FAILURES LOOK LIKE SUCCESSES. Three
//     distinct modes, all observed:
//       · HTTP 200, `application/json`, `careerSectionUnAvailable: true` and a
//         NULL requisitionList — kp, weyerhaeuser, and any wrong portal id.
//       · HTTP 302 → HTTP 200 `text/html`
//         (jacobs.taleo.net/error_pages/zone_maintenance_503.html) — a 200 that
//         is an error page. DETECT BY CONTENT-TYPE, NOT STATUS.
//       · HTTP 500 `text/plain` — a missing `tz`, i.e. a bug in the caller.
//     All three come back as a clean `error` on the result. None throws.
//
// `portalId` IS DISCOVERABLE and is load-bearing: teletech returns
// `careerSectionUnAvailable` under the common default portal 101430233 and 115
// requisitions under its own 160131726. It is emitted into the careers page's
// inline JavaScript (`logoutServletURL: '/...jss?portal=160131726'`), which is
// why discovery reads the RAW HTML rather than going through PageFetcher —
// PageFetcher strips <script> before returning text, so the id is not in what
// it hands back. Everything else about the manners is the same: robots.txt is
// honoured, one request per second per host, responses cached per UTC day.
//
// Detail is an HTML page at `.../careersection/{section}/jobdetail.ftl?job=
// {contestNo}` and it is keyed on **contestNo**, never jobId. `/rest/jobboard/
// getJob` does not exist.
//
// IDENTITY: `{tenant}|{section}|{portalId}`. The last two are discoverable and
// may be blank — `taleo.net|` addressing is not enough, but `cu||` is, and the
// adapter fills in `2` and `101430233` from the careers page.
//
// Boundaries: public unauthenticated endpoints the career section's own
// browser code calls. No login, no CAPTCHA, nothing behind an access control.

import { cached, cacheKey } from '@/lib/providers/cache'
import type { AtsBoardRef, RawJobPosting } from './types'
import { internshipLike, listCacheBypassFromEnv, utcDayKey } from './fetch'
import { CAREER_BOT_USER_AGENT, getRobotsRules, isPathAllowed } from './robots'
import {
  emptyDiscoveryResult,
  type DiscoveryHealth,
  type DiscoverySearchInput,
  type DiscoverySearchResult,
  type JobDiscoverySource,
} from './discovery-types'

/**
 * The one load-bearing header. Any valid offset works; this is the value the
 * career sections' own pages send. Without it: HTTP 500 "An Error Occurred in
 * TEE".
 */
export const TALEO_TZ = 'GMT-04:00'

/** Taleo fixes its own page size (25 observed everywhere) and reports it back. */
export const TALEO_PAGE_SIZE = 25
/** Pages one `search` call will read before handing back a cursor. */
export const TALEO_MAX_PAGES_PER_CALL = 2
/** The portal id shared by a large fraction of tenants. Tried only as a fallback. */
export const TALEO_DEFAULT_PORTAL = '101430233'
/** Career-section paths that carry the portal id, most common first. */
export const TALEO_DISCOVERY_PATHS = [
  '/careersection/jobsearch.ftl',
  '/careersection/2/jobsearch.ftl',
  '/careersection/ex/jobsearch.ftl',
  '/careersection/external/jobsearch.ftl',
]
const MIN_GAP_MS = 1000
const DEFAULT_TIMEOUT_MS = 20_000
const TENANT_RE = /^[a-z0-9][a-z0-9-]*$/
const SECTION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

// ─── Identity ────────────────────────────────────────────────────────────────

export interface TaleoBoardId {
  tenant: string
  /** Career-section name in the URL path (`2`, `ex`, `external`). Discoverable. */
  section: string | null
  /** The `portal` query parameter. Discoverable. */
  portalId: string | null
}

export function formatTaleoIdentifier(id: TaleoBoardId): string {
  return `${id.tenant.toLowerCase()}|${id.section ?? ''}|${id.portalId ?? ''}`
}

export function parseTaleoIdentifier(identifier: string): TaleoBoardId | null {
  const parts = (identifier ?? '').split('|')
  if (parts.length < 1 || parts.length > 3) return null
  const tenant = (parts[0] ?? '').trim().toLowerCase()
  if (!TENANT_RE.test(tenant)) return null
  const section = (parts[1] ?? '').trim()
  const portalId = (parts[2] ?? '').trim()
  return {
    tenant,
    section: section && SECTION_RE.test(section) ? section : null,
    portalId: /^\d+$/.test(portalId) ? portalId : null,
  }
}

export function taleoOrigin(tenant: string): string {
  return `https://${tenant}.taleo.net`
}

export function taleoSearchUrl(tenant: string, portalId: string, lang = 'en'): string {
  return `${taleoOrigin(tenant)}/careersection/rest/jobboard/searchjobs?lang=${encodeURIComponent(lang)}&portal=${encodeURIComponent(portalId)}`
}

export function taleoBoardUrl(id: TaleoBoardId): string {
  return `${taleoOrigin(id.tenant)}/careersection/${id.section ?? '2'}/jobsearch.ftl`
}

/** Keyed on contestNo. `jobId` here produces a 404 page — they are different ids. */
export function taleoDetailUrl(id: TaleoBoardId, contestNo: string): string {
  return `${taleoOrigin(id.tenant)}/careersection/${id.section ?? '2'}/jobdetail.ftl?job=${encodeURIComponent(contestNo)}`
}

/** Recognize a Taleo URL and pull out tenant, section and portal when present. Pure. */
export function matchTaleoUrl(url: string): { board: AtsBoardRef; jobId: string | null } | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const m = /^([a-z0-9][a-z0-9-]*)\.taleo\.net$/.exec(u.hostname.toLowerCase())
  if (!m) return null
  const segments = u.pathname.split('/').filter(Boolean)
  const at = segments.indexOf('careersection')
  const next = at >= 0 ? segments[at + 1] ?? '' : ''
  const section = next && !next.endsWith('.ftl') && next !== 'rest' && SECTION_RE.test(next) ? next : null
  const portal = u.searchParams.get('portal')
  const id: TaleoBoardId = { tenant: m[1], section, portalId: portal && /^\d+$/.test(portal) ? portal : null }
  return {
    board: { ats: 'other', identifier: formatTaleoIdentifier(id), board_url: taleoBoardUrl(id) },
    jobId: u.searchParams.get('job'),
  }
}

// ─── The request body ────────────────────────────────────────────────────────

export interface TaleoSearchBody {
  multilineEnabled: boolean
  sortingSelection: { sortBySelectionParam: string; ascendingSortingOrder: string }
  /** `fields` is an OBJECT. The array form returns HTTP 400. */
  fieldData: { fields: Record<string, string>; valid: boolean }
  filterSelectionParam: { searchFilterSelections: unknown[] }
  advancedSearchFiltersSelectionParam: { searchFilterSelections: unknown[] }
  pageNo: number
}

export interface TaleoQuery {
  keyword?: string | null
  location?: string | null
  pageNo?: number
}

/**
 * The search body. `KEYWORD` is a real server-side filter, not a ranking hint —
 * on `cu` it took 712 requisitions down to 3 — so it is safe to pass a query
 * through. `sortBySelectionParam: '3'` is the career sections' own default
 * (most recent first).
 */
export function buildTaleoSearchBody(q: TaleoQuery = {}): TaleoSearchBody {
  return {
    multilineEnabled: false,
    sortingSelection: { sortBySelectionParam: '3', ascendingSortingOrder: 'false' },
    fieldData: { fields: { KEYWORD: q.keyword ?? '', LOCATION: q.location ?? '' }, valid: true },
    filterSelectionParam: { searchFilterSelections: [] },
    advancedSearchFiltersSelectionParam: { searchFilterSelections: [] },
    pageNo: q.pageNo && q.pageNo > 0 ? q.pageNo : 1,
  }
}

/** The headers a Taleo search needs. Exported so a test can assert `tz` is present. */
export function taleoSearchHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': CAREER_BOT_USER_AGENT,
    tz: TALEO_TZ,
  }
}

// ─── Payload shapes ──────────────────────────────────────────────────────────

export interface TaleoRequisitionRow {
  jobId?: string
  contestNo?: string
  /** Positional and tenant-configured. Resolve with `resolveTaleoColumns`. */
  column?: string[]
  /** Index of the title column. */
  linkedColumn?: number
  /** Indices of the location columns. */
  locationsColumns?: number[]
  hotJob?: boolean
  [k: string]: unknown
}

export interface TaleoPagingData {
  currentPageNo?: number
  pageSize?: number
  totalCount?: number
}

export interface TaleoSearchResponse {
  requisitionList?: TaleoRequisitionRow[] | null
  pagingData?: TaleoPagingData | null
  careerSectionUnAvailable?: boolean
  [k: string]: unknown
}

// ─── Positional columns ──────────────────────────────────────────────────────

export interface TaleoColumnMap {
  titleIndex: number
  locationIndexes: number[]
  dateIndex: number | null
}

/** "Aug 31, 2026" and friends. A job title must never be mistaken for a date. */
export function looksLikeTaleoDate(value: string | undefined): boolean {
  if (!value) return false
  const s = value.trim()
  if (s.length > 32 || !/\d{4}/.test(s)) return false
  if (!/^[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}$|^\d{1,4}[-/]\d{1,2}[-/]\d{1,4}$/.test(s)) return false
  return Number.isFinite(Date.parse(s))
}

/**
 * Which cell is what, read from the row's own hints. NEVER hardcode: `lbl`
 * puts the contest number at 0 and the title at 1, `cu` puts the title at 0,
 * and `baesystems` returns a title and nothing else.
 */
export function resolveTaleoColumns(row: TaleoRequisitionRow): TaleoColumnMap {
  const columns = row.column ?? []
  const linked = typeof row.linkedColumn === 'number' ? row.linkedColumn : 0
  const titleIndex = linked >= 0 && linked < columns.length ? linked : 0
  const locationIndexes = (row.locationsColumns ?? []).filter((i) => typeof i === 'number' && i >= 0 && i < columns.length && i !== titleIndex)
  let dateIndex: number | null = null
  for (let i = 0; i < columns.length; i++) {
    if (i === titleIndex || locationIndexes.includes(i)) continue
    if (looksLikeTaleoDate(columns[i])) {
      dateIndex = i
      break
    }
  }
  return { titleIndex, locationIndexes, dateIndex }
}

/**
 * A location cell is a STRING holding a JSON array. Double-parse, and fall back
 * to the raw string for tenants that send a plain value.
 */
export function parseTaleoLocations(cell: string | undefined): string[] {
  const s = (cell ?? '').trim()
  if (!s) return []
  if (s.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(s)
      if (Array.isArray(parsed)) return parsed.map((v) => String(v).trim()).filter(Boolean)
    } catch {
      /* fall through to the raw string */
    }
  }
  return [s]
}

export function taleoDate(value: string | undefined): string | null {
  if (!looksLikeTaleoDate(value)) return null
  const t = Date.parse((value as string).trim())
  if (!Number.isFinite(t)) return null
  // Taleo prints a calendar day with no timezone; anchor it at UTC midnight so
  // two runs in different zones do not disagree about the posting date.
  const d = new Date(t)
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString()
}

export interface TaleoNormalizeContext {
  id: TaleoBoardId
  companyName?: string | null
  now?: string
}

export function normalizeTaleoRow(row: TaleoRequisitionRow, ctx: TaleoNormalizeContext): RawJobPosting | null {
  const columns = row.column ?? []
  const map = resolveTaleoColumns(row)
  const title = (columns[map.titleIndex] ?? '').trim()
  const contestNo = (row.contestNo ?? '').trim()
  if (!title || !contestNo) return null
  const now = ctx.now ?? new Date().toISOString()
  const url = taleoDetailUrl(ctx.id, contestNo)
  const locations = map.locationIndexes.flatMap((i) => parseTaleoLocations(columns[i]))

  return {
    // JobSourceType has no `taleo` member and this adapter does not widen an
    // enum it does not own. `careers_page` is what the rest of the codebase
    // already assigns to taleo.net hosts (simplify.ts `atsFromUrl`).
    source_type: 'careers_page',
    source_url: url,
    // contestNo, not jobId: it is what addresses the detail page.
    external_id: contestNo,
    company_name: (ctx.companyName ?? '').trim() || ctx.id.tenant,
    company_domain: null,
    title,
    location_raw: locations.length ? locations.join(' · ') : null,
    // The search response carries no description at all; it is on the HTML
    // detail page, one request per posting.
    description_text: null,
    description_html: null,
    department: null,
    posted_at: map.dateIndex !== null ? taleoDate(columns[map.dateIndex]) : null,
    updated_at: null,
    apply_url: url,
    canonical_url: url,
    ats_type: 'other',
    ats_job_id: (row.jobId ?? '').trim() || contestNo,
    requisition_id: contestNo,
    employment_type_hint: null,
    raw: {
      taleo: {
        tenant: ctx.id.tenant,
        section: ctx.id.section,
        portalId: ctx.id.portalId,
        jobId: row.jobId ?? null,
        contestNo,
        columns,
        columnMap: map,
        hotJob: row.hotJob ?? null,
      },
    },
    retrieved_at: now,
  }
}

// ─── Fetching ────────────────────────────────────────────────────────────────

export interface TaleoRequest {
  url: string
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: string
}

export interface TaleoFetchResult {
  status: number
  contentType: string
  body: string
  /** After redirects. `jacobs` lands on an /error_pages/ URL with HTTP 200. */
  finalUrl?: string
  error?: string
}

/** Test seam: the offline suite records the request and replays a fixture. */
export type TaleoFetcher = (req: TaleoRequest) => Promise<TaleoFetchResult>

const lastHit = new Map<string, number>()

async function throttle(origin: string, gapMs: number): Promise<void> {
  const now = Date.now()
  const prev = lastHit.get(origin) ?? 0
  const wait = prev + gapMs - now
  lastHit.set(origin, Math.max(now, prev + gapMs))
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
}

export async function taleoAllowed(tenant: string, path: string): Promise<{ allowed: boolean; reason?: string }> {
  if (process.env.CAREER_SKIP_ROBOTS === '1') return { allowed: true }
  const origin = taleoOrigin(tenant)
  const rules = await getRobotsRules(origin)
  if (!isPathAllowed(rules, path)) return { allowed: false, reason: `robots.txt disallows ${path}` }
  await throttle(origin, Math.max(MIN_GAP_MS, rules.crawlDelayMs ?? 0))
  return { allowed: true }
}

const liveFetcher: TaleoFetcher = async (req) => {
  let parsed: URL
  try {
    parsed = new URL(req.url)
  } catch {
    return { status: 0, contentType: '', body: '', error: 'invalid url' }
  }
  const tenant = parsed.hostname.split('.')[0]
  const gate = await taleoAllowed(tenant, parsed.pathname)
  if (!gate.allowed) return { status: 0, contentType: '', body: '', error: gate.reason }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      redirect: 'follow',
      signal: controller.signal,
    })
    return {
      status: res.status,
      contentType: (res.headers.get('content-type') ?? '').toLowerCase(),
      body: await res.text(),
      finalUrl: res.url || req.url,
    }
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    return { status: 0, contentType: '', body: '', error: aborted ? 'timeout' : err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
}

// ─── Classifying the answer ──────────────────────────────────────────────────

export type TaleoOutcomeKind = 'ok' | 'html_error_page' | 'section_unavailable' | 'transport_error' | 'bad_json'

export interface TaleoOutcome {
  kind: TaleoOutcomeKind
  data: TaleoSearchResponse | null
  /** Present for everything but `ok`. Already phrased for a coverage report. */
  error?: string
}

/**
 * The single place that decides whether Taleo actually answered. Status alone
 * is not enough and never was: `jacobs` 302-redirects to an error page that
 * returns HTTP 200 `text/html`, and a wrong portal id returns HTTP 200
 * `application/json` with a null list.
 */
export function classifyTaleoResponse(res: TaleoFetchResult): TaleoOutcome {
  if (res.error) return { kind: 'transport_error', data: null, error: res.error }
  const ct = (res.contentType ?? '').toLowerCase()
  // A 500 is the caller's own bug, not a broken tenant, and it has exactly one
  // usual cause. Say so before the generic content-type branch, or the fix
  // reads as "this employer is unavailable".
  if (res.status >= 500) {
    return { kind: 'transport_error', data: null, error: `http ${res.status} — a 500 here almost always means the ${'`tz`'} header was missing` }
  }
  if (ct && !ct.includes('json')) {
    const where = res.finalUrl && res.finalUrl !== '' ? ` (${res.finalUrl})` : ''
    return {
      kind: 'html_error_page',
      data: null,
      error: `Taleo answered ${res.status} ${ct || 'unknown content-type'} instead of JSON${where} — career section unavailable`,
    }
  }
  if (res.status < 200 || res.status >= 300) {
    return { kind: 'transport_error', data: null, error: `http ${res.status}` }
  }
  let data: TaleoSearchResponse
  try {
    data = JSON.parse(res.body) as TaleoSearchResponse
  } catch (e) {
    return { kind: 'bad_json', data: null, error: `response was not JSON: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (data.careerSectionUnAvailable === true || data.requisitionList == null) {
    return { kind: 'section_unavailable', data, error: 'Taleo reports this career section unavailable (usually a wrong or retired portal id)' }
  }
  return { kind: 'ok', data }
}

// ─── Portal discovery ────────────────────────────────────────────────────────

export interface TaleoPortalDiscovery {
  portalId: string | null
  section: string | null
  requests: number
  error?: string
}

const PORTAL_PATTERNS = [/portal=(\d{4,})/, /portalNo:\s*'(\d{4,})'/, /"portalNo"\s*:\s*"?(\d{4,})"?/]

/** Pull the portal id out of raw careers-page HTML. Pure. */
export function extractTaleoPortal(html: string): string | null {
  for (const re of PORTAL_PATTERNS) {
    const m = re.exec(html)
    if (m) return m[1]
  }
  return null
}

/** `https://cu.taleo.net/careersection/2/moresearch.ftl?lang=en` → `2`. Pure. */
export function extractTaleoSection(url: string | undefined): string | null {
  if (!url) return null
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean)
    const at = segments.indexOf('careersection')
    const next = at >= 0 ? segments[at + 1] ?? '' : ''
    return next && !next.endsWith('.ftl') && SECTION_RE.test(next) ? next : null
  } catch {
    return null
  }
}

/**
 * Find a tenant's portal id (and career-section name) from its own careers
 * page. Load-bearing: teletech is unavailable under the common default portal
 * and returns 115 requisitions under its own. Bounded to the paths above and
 * cached per UTC day.
 */
export async function discoverTaleoPortal(tenant: string, fetcher?: TaleoFetcher, bypass = false): Promise<TaleoPortalDiscovery> {
  const fetch_ = fetcher ?? liveFetcher
  return cached<TaleoPortalDiscovery>(
    cacheKey('taleo-portal', { tenant, day: utcDayKey() }),
    async () => {
      let requests = 0
      let lastError: string | undefined
      for (const path of TALEO_DISCOVERY_PATHS) {
        const res = await fetch_({
          url: `${taleoOrigin(tenant)}${path}`,
          method: 'GET',
          headers: { 'User-Agent': CAREER_BOT_USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
        })
        requests++
        if (res.error) {
          lastError = res.error
          continue
        }
        if (res.status < 200 || res.status >= 300) {
          lastError = `http ${res.status}`
          continue
        }
        const portalId = extractTaleoPortal(res.body)
        if (portalId) return { portalId, section: extractTaleoSection(res.finalUrl) ?? extractTaleoSection(`${taleoOrigin(tenant)}${path}`), requests }
        lastError = 'no portal id on the page'
      }
      return { portalId: null, section: null, requests, error: lastError ?? 'no portal id found' }
    },
    bypass,
    (r) => !!r.portalId
  )
}

// ─── One search page ─────────────────────────────────────────────────────────

export interface TaleoPageResult extends TaleoOutcome {
  rows: TaleoRequisitionRow[]
  paging: TaleoPagingData
}

export async function taleoSearchPage(
  id: TaleoBoardId,
  query: TaleoQuery,
  fetcher: TaleoFetcher,
  bypass = false
): Promise<TaleoPageResult> {
  if (!id.portalId) return { kind: 'transport_error', data: null, error: 'no portal id', rows: [], paging: {} }
  const url = taleoSearchUrl(id.tenant, id.portalId)
  const body = buildTaleoSearchBody(query)
  const outcome = await cached<TaleoOutcome>(
    cacheKey('taleo-search', { url, body, day: utcDayKey() }),
    async () =>
      classifyTaleoResponse(
        await fetcher({ url, method: 'POST', headers: taleoSearchHeaders(), body: JSON.stringify(body) })
      ),
    bypass,
    (r) => r.kind === 'ok'
  )
  return {
    ...outcome,
    rows: outcome.data?.requisitionList ?? [],
    paging: outcome.data?.pagingData ?? {},
  }
}

// ─── Addressing ──────────────────────────────────────────────────────────────

export function resolveTaleoTarget(input: DiscoverySearchInput, fallbackTenant?: string | null): (TaleoBoardId & { companyName: string | null }) | null {
  const named = (input.board?.company_name ?? input.company?.name ?? null) || null

  const identifier = input.board?.identifier ?? null
  if (identifier) {
    const parsed = parseTaleoIdentifier(identifier)
    if (parsed) return { ...parsed, companyName: named }
  }
  const extraTenant = typeof input.extra?.taleoTenant === 'string' ? input.extra.taleoTenant.toLowerCase() : null
  if (extraTenant && TENANT_RE.test(extraTenant)) {
    const portal = typeof input.extra?.taleoPortal === 'string' ? input.extra.taleoPortal : null
    const section = typeof input.extra?.taleoSection === 'string' ? input.extra.taleoSection : null
    return {
      tenant: extraTenant,
      section: section && SECTION_RE.test(section) ? section : null,
      portalId: portal && /^\d+$/.test(portal) ? portal : null,
      companyName: named,
    }
  }
  for (const candidate of [input.board?.board_url, input.company?.careersUrl]) {
    if (!candidate) continue
    const m = matchTaleoUrl(candidate)
    if (!m) continue
    const parsed = parseTaleoIdentifier(m.board.identifier)
    if (parsed) return { ...parsed, companyName: named }
  }
  if (fallbackTenant && TENANT_RE.test(fallbackTenant.toLowerCase())) {
    return { tenant: fallbackTenant.toLowerCase(), section: null, portalId: null, companyName: named }
  }
  return null
}

// ─── The source ──────────────────────────────────────────────────────────────

export interface TaleoSourceOptions {
  fetcher?: TaleoFetcher
  /** Used when nothing in the input addresses a tenant. */
  tenant?: string | null
  /** Tenant `healthCheck` probes. Defaults to a known-good public career section. */
  healthTenant?: string
  bypassCache?: boolean
  now?: () => string
}

export function taleoSource(opts: TaleoSourceOptions = {}): JobDiscoverySource {
  const fetcher = opts.fetcher ?? liveFetcher
  const bypass = opts.bypassCache ?? listCacheBypassFromEnv()
  const nowFn = opts.now ?? (() => new Date().toISOString())

  /** Fill in whatever the identifier did not carry. Never throws. */
  async function complete(id: TaleoBoardId): Promise<{ id: TaleoBoardId; requests: number; error?: string }> {
    if (id.portalId && id.section) return { id, requests: 0 }
    const found = await discoverTaleoPortal(id.tenant, fetcher, bypass)
    const merged: TaleoBoardId = {
      tenant: id.tenant,
      section: id.section ?? found.section,
      portalId: id.portalId ?? found.portalId,
    }
    if (!merged.portalId) {
      // The common default is worth ONE try before giving up: it works on cu,
      // massanf, tgh, aarcorp, baesystems and lbl.
      merged.portalId = TALEO_DEFAULT_PORTAL
      return { id: merged, requests: found.requests, error: found.error }
    }
    return { id: merged, requests: found.requests }
  }

  return {
    id: 'taleo',
    name: 'Oracle Taleo career sections',
    sourceType: 'ats',
    capabilities: {
      paginates: true,
      // KEYWORD is a genuine server-side filter (712 → 3 on cu), not a ranking hint.
      supportsQuery: true,
      supportsLocation: true,
      // Taleo prints a posting date per row but offers no server-side cutoff;
      // the pager stops once the sorted list crosses it. PER TENANT, though:
      // a career section that configures no date column (baesystems does not)
      // cannot be filtered, and the result then says the cutoff went unapplied
      // rather than pretending it did.
      supportsSince: true,
      givesDescription: false,
      givesCanonicalUrl: true,
    },
    costModel: { kind: 'free' },
    isConfigured: () => true,

    async healthCheck(): Promise<DiscoveryHealth> {
      const tenant = opts.healthTenant ?? opts.tenant ?? 'cu'
      const completed = await complete({ tenant, section: null, portalId: null })
      const page = await taleoSearchPage(completed.id, { pageNo: 1 }, fetcher, bypass)
      if (page.kind !== 'ok') return { ok: false, detail: `${tenant}: ${page.error ?? page.kind}` }
      return { ok: true, detail: `${tenant}: ${page.paging.totalCount ?? page.rows.length} requisitions on portal ${completed.id.portalId}` }
    },

    async search(input: DiscoverySearchInput, cursor?: string | null): Promise<DiscoverySearchResult> {
      const target = resolveTaleoTarget(input, opts.tenant)
      if (!target) {
        return emptyDiscoveryResult(
          'Taleo is addressed by a board — ats_identifier "{tenant}|{section}|{portalId}" or any *.taleo.net careers URL'
        )
      }

      let requests = 0
      const completed = await complete({ tenant: target.tenant, section: target.section, portalId: target.portalId })
      requests += completed.requests
      const id = completed.id
      const now = nowFn()

      const startPage = Math.max(1, Number.parseInt(cursor ?? '1', 10) || 1)
      const want = input.limit && input.limit > 0 ? input.limit : TALEO_PAGE_SIZE
      const keyword = [input.query ?? '', ...(input.titleTerms ?? [])].map((s) => s.trim()).filter(Boolean)[0] ?? ''
      const sinceMs = input.since ? Date.parse(input.since) : NaN
      const cutoff = Number.isFinite(sinceMs) ? sinceMs : null

      const postings: RawJobPosting[] = []
      let seen = 0
      let pageNo = startPage
      let totalCount: number | null = null
      let error: string | undefined
      let crossedCutoff = false
      // Whether this career section prints a posting date at all. `baesystems`
      // configures ONE column — the title — so `since` has nothing to compare
      // against. The result has to say so; a capability that silently
      // over-promises is how a caller loses postings it thinks it filtered.
      let sawDate = false

      for (let i = 0; i < TALEO_MAX_PAGES_PER_CALL; i++) {
        const page = await taleoSearchPage(id, { keyword, location: input.location ?? '', pageNo }, fetcher, bypass)
        requests++
        if (page.kind !== 'ok') {
          // Every failure mode — the HTML error page with its HTTP 200, the
          // unavailable career section, the transport error — arrives here as a
          // clean error with whatever earlier pages produced (principle 9).
          error = page.error ?? page.kind
          break
        }
        seen += page.rows.length
        totalCount = typeof page.paging.totalCount === 'number' ? page.paging.totalCount : totalCount
        for (const row of page.rows) {
          const posting = normalizeTaleoRow(row, { id, companyName: target.companyName, now })
          if (!posting) continue
          if (posting.posted_at) sawDate = true
          if (cutoff !== null && posting.posted_at) {
            const t = Date.parse(posting.posted_at)
            if (Number.isFinite(t) && t < cutoff) {
              crossedCutoff = true
              continue
            }
          }
          if (input.internshipsOnly && !internshipLike(posting.title, posting.employment_type_hint)) continue
          postings.push(posting)
        }
        const pageSize = page.paging.pageSize ?? TALEO_PAGE_SIZE
        const readSoFar = pageNo * pageSize
        pageNo++
        if (crossedCutoff || page.rows.length === 0 || (totalCount !== null && readSoFar >= totalCount)) break
        if (postings.length >= want) break
      }

      const pageSize = TALEO_PAGE_SIZE
      const exhausted =
        !!error || crossedCutoff || (totalCount !== null ? (pageNo - 1) * pageSize >= totalCount : true)

      const notes: string[] = []
      if (totalCount !== null) notes.push(`${totalCount} requisitions on ${id.tenant} portal ${id.portalId}`)
      // Said out loud, not swallowed: `supportsSince` is true of the ATS, and
      // false of a career section that publishes no date column.
      if (cutoff !== null && !sawDate && seen > 0) {
        notes.push(`${id.tenant} publishes no posting date on this career section — the "since" cutoff was NOT applied`)
      }

      return {
        postings,
        nextCursor: exhausted ? null : String(pageNo),
        exhausted,
        seen,
        note: notes.length ? notes.join('; ') : undefined,
        error,
        requests,
      }
    },
  }
}
