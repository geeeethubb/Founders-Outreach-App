// Workday (myworkdayjobs.com) — the public CXS API every Workday careers site
// calls from the browser. Keyless, JSON, no login.
//
// This adapter exists because Workday is where the large employers are. Before
// it, Illumina, 3M, Chevron, GlobalFoundries, Intel, Micron, Amgen, Applied
// Materials and Argonne all answered "no public board detected" and yielded
// zero postings — the registry recognised the URL family but nothing could list
// it.
//
// Verified live (Aug 2026), against intel/wd1/External, micron/wd1/External,
// amat/wd1/External, amgen/wd1/Careers, 3m/wd1/Search, chevron/wd5/University,
// globalfoundries/wd1/External, illumina/wd1/illumina-careers,
// argonne/wd1/Argonne_Careers:
//
//   POST https://<tenant>.<pod>.myworkdayjobs.com/wday/cxs/<tenant>/<site>/jobs
//        {"appliedFacets":{},"limit":20,"offset":0,"searchText":""}
//     → { total, jobPostings: [{ title, externalPath, locationsText, postedOn,
//                                bulletFields }], facets: [...] }
//     → 404 on an unknown <site>, 422 on an unknown <tenant>, 400 when limit > 20
//   GET  …/wday/cxs/<tenant>/<site><externalPath>   → { jobPostingInfo: {...} }
//     → 404 when the requisition is gone (the freshness primitive)
//   Public page: https://<tenant>.<pod>.myworkdayjobs.com/en-US/<site><externalPath>
//
// Three measured facts drive the design:
//
//  1. `limit` is capped at 20. 21 returns HTTP 400. Everything paginates.
//  2. `searchText` is a fuzzy relevance query, NOT a filter, and its recall is
//     not trustworthy: "intern" narrowed Intel 611→372 but left Micron at
//     2780/2780, and "internship" returned 0 at Argonne. Never filter with it.
//  3. `facets` in the SAME first response carry a per-tenant `workerSubType` /
//     `jobFamilyGroup` value whose descriptor reads "Intern", "Interns",
//     "Intern / Student", "Student / Intern (Fixed Term)"… Applying that id via
//     `appliedFacets` is an exact, server-side internship filter, and it turns
//     Micron's 2780-posting board into 95 requisitions in five requests.
//
// So: one probe request reads the facet catalogue, and internship listing is a
// facet query. A tenant with no intern facet (Argonne) falls back to paging the
// board and filtering titles, under a page budget, and says so in `note`.
//
// Listings carry no description — Workday puts it behind a per-posting detail
// call. That is deliberate: one call per posting would be hundreds of requests
// per board. `fetchPosting` returns the full description when someone actually
// wants one.

import type {
  AtsBoardRef, JobSourceAdapter, ListPostingsOptions, ListPostingsResult,
  PostingFetchResult, RawJobPosting, UrlMatch,
} from './types'
import { applyListOptions, cachedListing, fetchJson, internshipLike, listCacheBypassFromEnv, slugCandidates } from './fetch'
import { getRobotsRules, isPathAllowed } from './robots'
import { htmlToText } from './html'

/** Workday refuses limit > 20 with HTTP 400. Measured, not assumed. */
export const WORKDAY_PAGE_SIZE = 20
/** Pages we will read when no intern facet exists and titles must be scanned. */
export const WORKDAY_MAX_SCAN_PAGES = 15
/**
 * Ranking hints for that scan, in order. Not filters — see the note in
 * `collectWorkdayPostings`. They exist so a page budget spent on a 5000-posting
 * board reads the rows most likely to be internships first.
 */
export const WORKDAY_SCAN_QUERIES = ['intern', 'co-op']
/** Pods seen on the founder's own watchlist, most common first. */
export const WORKDAY_PODS = ['wd1', 'wd5', 'wd3', 'wd2', 'wd12']
const MIN_GAP_MS = 1000

// ─── Identity: `tenant/pod/site` ─────────────────────────────────────────────
//
// A Workday board needs all three parts to address — the tenant names the
// customer, the pod names the datacentre the tenant lives on (wd1, wd5, wd12…),
// and the site names one of several public career sites that tenant publishes
// (Intel has "External"; Illumina has "illumina-careers",
// "illumina-universityrecruiting" and "illumina-earlycareers-europe"). None of
// the three is derivable from the others, so `ats_identifier` carries all three
// separated by "/": `intel/wd1/External`.

export interface WorkdayBoardId {
  tenant: string
  pod: string
  site: string
}

export function formatWorkdayIdentifier(id: WorkdayBoardId): string {
  return `${id.tenant}/${id.pod}/${id.site}`
}

export function parseWorkdayIdentifier(identifier: string): WorkdayBoardId | null {
  const parts = (identifier ?? '').split('/').filter(Boolean)
  if (parts.length !== 3) return null
  const [tenant, pod, site] = parts
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(tenant)) return null
  if (!/^wd\d+$/i.test(pod)) return null
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(site)) return null
  return { tenant: tenant.toLowerCase(), pod: pod.toLowerCase(), site }
}

export function workdayOrigin(id: WorkdayBoardId): string {
  return `https://${id.tenant}.${id.pod}.myworkdayjobs.com`
}

export function workdayBoardUrl(id: WorkdayBoardId): string {
  return `${workdayOrigin(id)}/en-US/${id.site}`
}

export function workdayApiUrl(id: WorkdayBoardId): string {
  return `${workdayOrigin(id)}/wday/cxs/${id.tenant}/${id.site}/jobs`
}

/** `/job/US-Oregon/Foo_JR1` → the public page a candidate would open. */
export function workdayPostingUrl(id: WorkdayBoardId, externalPath: string): string {
  const p = externalPath.startsWith('/') ? externalPath : `/${externalPath}`
  return `${workdayOrigin(id)}/en-US/${id.site}${p}`
}

export function workdayDetailUrl(id: WorkdayBoardId, externalPath: string): string {
  const p = externalPath.startsWith('/') ? externalPath : `/${externalPath}`
  return `${workdayOrigin(id)}/wday/cxs/${id.tenant}/${id.site}${p}`
}

function boardRef(id: WorkdayBoardId, companyName?: string): AtsBoardRef {
  return { ats: 'workday', identifier: formatWorkdayIdentifier(id), company_name: companyName, board_url: workdayBoardUrl(id) }
}

const LOCALE_RE = /^[a-z]{2}(-[A-Za-z]{2})?$/

export function matchWorkdayUrl(url: string): UrlMatch | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const host = /^([a-z0-9][a-z0-9-]*)\.(wd\d+)\.myworkdayjobs\.com$/.exec(u.hostname.toLowerCase())
  if (!host) return null
  const segments = u.pathname.split('/').filter(Boolean)
  // The CXS API path carries tenant and site itself: /wday/cxs/<tenant>/<site>/…
  if (segments[0] === 'wday' && segments[1] === 'cxs' && segments[3]) {
    const id = { tenant: segments[2].toLowerCase(), pod: host[2], site: segments[3] }
    const rest = segments.slice(4)
    const jobId = rest[0] === 'job' ? `/${rest.join('/')}` : null
    return { board: boardRef(id), jobId }
  }
  // Public path: /[locale/]<site>[/job/<location>/<slug>]
  let i = 0
  if (segments[i] && LOCALE_RE.test(segments[i])) i++
  const site = segments[i]
  if (!site) return null
  const rest = segments.slice(i + 1)
  const jobId = rest[0] === 'job' ? `/${rest.join('/')}` : null
  return { board: boardRef({ tenant: host[1], pod: host[2], site }), jobId }
}

// ─── Listing payloads ────────────────────────────────────────────────────────

export interface WorkdayJobPosting {
  title: string
  externalPath: string
  locationsText?: string | null
  postedOn?: string | null
  bulletFields?: string[] | null
  [k: string]: unknown
}

export interface WorkdayFacetValue {
  descriptor?: string
  id?: string
  count?: number
}

export interface WorkdayFacet {
  facetParameter?: string
  descriptor?: string
  values?: WorkdayFacetValue[]
}

export interface WorkdayJobsResponse {
  total?: number
  jobPostings?: WorkdayJobPosting[]
  facets?: WorkdayFacet[]
}

/**
 * `postedOn` is a relative English phrase, not a date: "Posted Today",
 * "Posted 4 Days Ago", "Posted 30+ Days Ago". The bounded forms resolve to a
 * real date; "30+" resolves to nothing, because dating it 30 days back would
 * make a year-old requisition look a month old. An unknown date is null.
 */
export function parseWorkdayPostedOn(postedOn: string | null | undefined, now = new Date()): string | null {
  if (!postedOn) return null
  const s = postedOn.trim().toLowerCase()
  if (/\+/.test(s)) return null
  const back = (days: number): string => new Date(now.getTime() - days * 86_400_000).toISOString()
  if (/\btoday\b/.test(s)) return back(0)
  if (/\byesterday\b/.test(s)) return back(1)
  const m = /\b(\d+)\+?\s*(day|week|month|year)s?\b/.exec(s)
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  const per: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 }
  return back(n * per[m[2]])
}

/**
 * `bulletFields` is a display list, not an id field: Intel prefixes promoted
 * roles with "Spotlight Job", so bulletFields[0] is sometimes a badge. The
 * requisition id is the entry that carries digits.
 */
export function requisitionFromBullets(bullets: string[] | null | undefined): string | null {
  for (const b of [...(bullets ?? [])].reverse()) {
    if (typeof b === 'string' && /\d{3,}/.test(b)) return b.trim()
  }
  return null
}

export function normalizeWorkdayPosting(
  job: WorkdayJobPosting,
  board: AtsBoardRef,
  opts: { now?: string; employmentHint?: string | null; descriptionHtml?: string | null } = {}
): RawJobPosting {
  const id = parseWorkdayIdentifier(board.identifier)
  const now = opts.now ?? new Date().toISOString()
  const path = job.externalPath ?? ''
  const canonical = id ? workdayPostingUrl(id, path) : path
  const html = opts.descriptionHtml ?? null
  return {
    source_type: 'workday',
    source_url: canonical,
    external_id: path || null,
    company_name: board.company_name ?? id?.tenant ?? board.identifier,
    company_domain: null,
    title: (job.title ?? '').trim(),
    location_raw: job.locationsText?.trim() || null,
    description_text: html ? htmlToText(html) : null,
    description_html: html,
    department: null,
    posted_at: parseWorkdayPostedOn(job.postedOn, new Date(now)),
    updated_at: null,
    apply_url: canonical,
    canonical_url: canonical,
    ats_type: 'workday',
    // The externalPath addresses both the public page and the detail API, so it
    // is the id worth keeping. The requisition id is display-only on Workday.
    ats_job_id: path || null,
    requisition_id: requisitionFromBullets(job.bulletFields),
    employment_type_hint: opts.employmentHint ?? null,
    raw: job as Record<string, unknown>,
    retrieved_at: now,
  }
}

// ─── Facets: the internship filter ───────────────────────────────────────────

const INTERN_FACET_RE = /\b(intern|interns|internship|student|co-?op|trainee|apprentice)\b/i
/** Preference order: worker type is what the role IS; job family is where it sits. */
const FACET_PARAMS = ['workerSubType', 'workerType', 'employmentType', 'jobType', 'jobFamilyGroup']

export interface WorkdayInternFacet {
  parameter: string
  ids: string[]
  descriptors: string[]
  count: number
}

export function pickInternFacet(facets: WorkdayFacet[] | undefined): WorkdayInternFacet | null {
  for (const param of FACET_PARAMS) {
    const facet = (facets ?? []).find((f) => f.facetParameter === param)
    if (!facet) continue
    const hits = (facet.values ?? []).filter((v) => v.id && v.descriptor && INTERN_FACET_RE.test(v.descriptor))
    if (!hits.length) continue
    return {
      parameter: param,
      ids: hits.map((v) => v.id as string),
      descriptors: hits.map((v) => v.descriptor as string),
      count: hits.reduce((n, v) => n + (v.count ?? 0), 0),
    }
  }
  return null
}

// ─── Manners ─────────────────────────────────────────────────────────────────
//
// fetchJson does not throttle or read robots.txt — the other adapters talk to
// vendor API hosts. A Workday board is the employer's own public careers host
// with real robots.txt rules (Chevron disallows /ExternalCareerSite_Private/,
// Argonne disallows /EDU_PRIVATE/), so this adapter checks them itself and
// keeps one request per second per host.

const lastHit = new Map<string, number>()

async function throttle(origin: string, gapMs: number): Promise<void> {
  const now = Date.now()
  const prev = lastHit.get(origin) ?? 0
  const wait = prev + gapMs - now
  lastHit.set(origin, Math.max(now, prev + gapMs))
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
}

/** Robots gate for one board: both the site path and the API path must be allowed. */
export async function workdayAllowed(id: WorkdayBoardId): Promise<{ allowed: boolean; reason?: string }> {
  if (process.env.CAREER_SKIP_ROBOTS === '1') return { allowed: true }
  const origin = workdayOrigin(id)
  const rules = await getRobotsRules(origin)
  if (!isPathAllowed(rules, `/${id.site}/`)) return { allowed: false, reason: `robots.txt disallows /${id.site}/` }
  const apiPath = `/wday/cxs/${id.tenant}/${id.site}/jobs`
  if (!isPathAllowed(rules, apiPath)) return { allowed: false, reason: `robots.txt disallows ${apiPath}` }
  await throttle(origin, Math.max(MIN_GAP_MS, rules.crawlDelayMs ?? 0))
  return { allowed: true }
}

export interface WorkdayQuery {
  appliedFacets: Record<string, string[]>
  limit: number
  offset: number
  searchText: string
}

export interface WorkdayPageResult {
  status: number
  data: WorkdayJobsResponse | null
  error?: string
}

/** One page of the CXS API. Injected in tests so the paging loop runs offline. */
export type WorkdayPageFn = (query: WorkdayQuery) => Promise<WorkdayPageResult>

function livePageFn(id: WorkdayBoardId): WorkdayPageFn {
  return async (body) => {
    const gate = await workdayAllowed(id)
    if (!gate.allowed) return { status: 0, data: null, error: gate.reason }
    return fetchJson<WorkdayJobsResponse>(workdayApiUrl(id), { method: 'POST', body })
  }
}

function listError(id: WorkdayBoardId, status: number, error: string | undefined): ListPostingsResult {
  const board_url = workdayBoardUrl(id)
  if (status === 404) return { postings: [], total_on_board: 0, board_url, error: 'board not found', note: `no Workday site "${id.site}" on tenant "${id.tenant}"` }
  if (status === 422) return { postings: [], total_on_board: 0, board_url, error: 'tenant not found', note: `no Workday tenant "${id.tenant}" on ${id.pod}` }
  return { postings: [], total_on_board: 0, board_url, error: error ?? `http ${status}`, note: `Workday listing failed (${error ?? status})` }
}

export interface CollectOptions {
  internshipsOnly: boolean
  want: number
  page: WorkdayPageFn
}

export async function collectWorkdayPostings(id: WorkdayBoardId, board: AtsBoardRef, opts: CollectOptions): Promise<ListPostingsResult> {
  const { internshipsOnly, want, page: postJobs } = opts
  const board_url = workdayBoardUrl(id)
  // One probe request: the board total and the facet catalogue in the same body.
  const probe = await postJobs({ appliedFacets: {}, limit: 1, offset: 0, searchText: '' })
  if (!probe.data || probe.status !== 200) return listError(id, probe.status, probe.error)

  const total = probe.data.total ?? 0
  const facet = internshipsOnly ? pickInternFacet(probe.data.facets) : null
  const appliedFacets: Record<string, string[]> = facet ? { [facet.parameter]: facet.ids } : {}
  const hint = facet ? facet.descriptors.join(' / ') : null
  // With a facet the server has already filtered, so every row counts and the
  // budget is just "enough pages for `want`". Without one we are scanning
  // titles and must stop somewhere.
  const maxPages = facet ? Math.ceil(Math.max(want, 1) / WORKDAY_PAGE_SIZE) : WORKDAY_MAX_SCAN_PAGES
  // With a facet the server has already filtered, so one unordered sweep is
  // exactly right. Without one we are reading titles off a board that may be
  // thousands long, and the page budget will only ever see the first few
  // hundred — so the ordering matters. searchText is useless as a FILTER (it
  // returned all 2780 of Micron's postings for "intern") but it does rank, and
  // that ranking is free recall: 3M's single intern-titled requisition out of
  // 648 is invisible in the first 300 unordered rows and lands on page one
  // under searchText "intern". The title gate below is what actually decides.
  const queries = facet || !internshipsOnly ? [''] : WORKDAY_SCAN_QUERIES

  const out: RawJobPosting[] = []
  const now = new Date().toISOString()
  const seen = new Set<string>()
  let scanned = 0
  let pages = 0
  let truncated = false

  outer: for (const searchText of queries) {
    for (let page = 0; pages < maxPages; page++) {
      const res = await postJobs({ appliedFacets, limit: WORKDAY_PAGE_SIZE, offset: page * WORKDAY_PAGE_SIZE, searchText })
      if (!res.data || res.status !== 200) {
        if (pages === 0) return listError(id, res.status, res.error)
        truncated = true
        break outer
      }
      pages++
      const rows = res.data.jobPostings ?? []
      if (!rows.length) break
      scanned += rows.length
      for (const row of rows) {
        if (!row?.title || !row.externalPath || seen.has(row.externalPath)) continue
        seen.add(row.externalPath)
        if (!facet && internshipsOnly && !internshipLike(row.title, null)) continue
        out.push(normalizeWorkdayPosting(row, board, { now, employmentHint: hint }))
      }
      if (out.length >= want) break outer
      if (rows.length < WORKDAY_PAGE_SIZE) break
      if (pages >= maxPages) truncated = true
    }
  }

  const how = internshipsOnly
    ? facet
      ? `${facet.parameter}=${facet.descriptors.join('/')} (${facet.count} on the board)`
      : `no intern facet on this tenant — scanned ${scanned} titles over ${pages} page(s) ranked by ${WORKDAY_SCAN_QUERIES.map((q) => `"${q}"`).join(' + ')}`
    : `${scanned} scanned over ${pages} page(s)`
  return {
    postings: out,
    total_on_board: total,
    board_url,
    note: `${out.length} of ${total} postings via ${how}${truncated ? '; page budget reached, list is partial' : ''}`,
  }
}

export const workdayAdapter: JobSourceAdapter = {
  id: 'workday',
  source_type: 'workday',
  isAvailable: () => process.env.CAREER_DISABLE_WORKDAY !== '1',
  matchUrl: matchWorkdayUrl,

  async detectBoard({ companyName, domain, careersUrl }) {
    // Never brute-force pods from a name alone — that is five requests per
    // company for a guess. A Workday URL we were handed is free; anything else
    // waits for a careers page to say "Workday" (see detect.ts).
    if (careersUrl) {
      const m = matchWorkdayUrl(careersUrl)
      if (m) {
        const id = parseWorkdayIdentifier(m.board.identifier)
        if (id) {
          const sites = await workdaySites(id.tenant, id.pod)
          // Trust a site the tenant actually publishes over one lifted from a
          // deep link that may name a locale or a stale path.
          const site = sites.includes(id.site) ? id.site : (await chooseWorkdaySite(id.tenant, id.pod, sites)) ?? id.site
          return boardRef({ ...id, site }, companyName)
        }
      }
    }
    void domain
    return null
  },

  async listPostings(board, options?: ListPostingsOptions) {
    const id = parseWorkdayIdentifier(board.identifier)
    if (!id) {
      return { postings: [], total_on_board: 0, board_url: board.board_url ?? null, error: 'bad identifier', note: `Workday identifier must be "tenant/pod/site", got "${board.identifier}"` }
    }
    const internshipsOnly = options?.internshipsOnly === true
    const want = options?.limit && options.limit > 0 ? options.limit : 200
    const full = await cachedListing(
      'workday',
      `${board.identifier}|${internshipsOnly ? 'interns' : 'all'}|${want}`,
      listCacheBypassFromEnv(),
      () => collectWorkdayPostings(id, board, { internshipsOnly, want, page: livePageFn(id) })
    )
    return { ...full, postings: applyListOptions(full.postings, options) }
  },

  async fetchPosting(board, externalId): Promise<PostingFetchResult> {
    const id = parseWorkdayIdentifier(board.identifier)
    if (!id) return { status: 'error', posting: null, note: `bad Workday identifier "${board.identifier}"`, error: 'bad identifier' }

    let path = externalId
    if (!path.startsWith('/')) {
      // A bare requisition id: Workday's own search resolves it in one request.
      const found = await livePageFn(id)({ appliedFacets: {}, limit: WORKDAY_PAGE_SIZE, offset: 0, searchText: externalId })
      if (!found.data) return { status: 'error', posting: null, note: `Workday search failed: ${found.error ?? found.status}`, error: found.error }
      const hit = (found.data.jobPostings ?? []).find((j) => j.externalPath?.includes(externalId))
      if (!hit) return { status: 'not_found', posting: null, note: `no Workday posting matching "${externalId}"` }
      path = hit.externalPath
    }

    const gate = await workdayAllowed(id)
    if (!gate.allowed) return { status: 'error', posting: null, note: gate.reason ?? 'blocked by robots.txt', error: gate.reason }
    const res = await fetchJson<{ jobPostingInfo?: Record<string, unknown> }>(workdayDetailUrl(id, path))
    if (res.status === 404) return { status: 'not_found', posting: null, note: 'Workday returned 404 for this requisition' }
    const info = res.data?.jobPostingInfo
    if (!info || res.status !== 200) return { status: 'error', posting: null, note: `Workday request failed: ${res.error ?? res.status}`, error: res.error }

    const posting = normalizeWorkdayPosting(
      {
        title: String(info.title ?? ''),
        externalPath: path,
        locationsText: typeof info.location === 'string' ? info.location : null,
        postedOn: typeof info.postedOn === 'string' ? info.postedOn : null,
        bulletFields: typeof info.jobReqId === 'string' ? [info.jobReqId] : null,
      },
      board,
      { employmentHint: typeof info.timeType === 'string' ? info.timeType : null, descriptionHtml: typeof info.jobDescription === 'string' ? info.jobDescription : null }
    )
    // The detail carries a real date; the listing's relative phrase does not.
    if (typeof info.startDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(info.startDate)) {
      posting.posted_at = new Date(`${info.startDate.slice(0, 10)}T00:00:00Z`).toISOString()
    }
    posting.raw = { ...posting.raw, jobPostingInfo: info }
    const posted = info.posted
    if (posted === false) return { status: 'closed', posting, note: 'Workday reports this requisition as no longer posted' }
    return { status: 'open', posting, note: 'present on the Workday board' }
  },
}

// ─── Tenant / site resolution ────────────────────────────────────────────────
//
// A Workday host publishes its own site list in robots.txt:
//
//   Sitemap: https://intel.wd1.myworkdayjobs.com/External/siteMap.xml
//   User-agent: *
//   Allow: /External/
//   Disallow: /refreshFacet/
//
// So one small, explicitly-public file answers both "does this tenant exist on
// this pod?" (a wrong tenant answers HTTP 422, giving no Allow rules) and
// "which sites may we read?" — no site-name guessing, and the sites we use are
// exactly the ones the employer asked crawlers to read. getRobotsRules already
// caches per origin per day, so this costs one request per tenant per day.

/** Public site names this tenant publishes, in the order robots.txt lists them. */
export async function workdaySites(tenant: string, pod: string): Promise<string[]> {
  const rules = await getRobotsRules(`https://${tenant}.${pod}.myworkdayjobs.com`)
  const out: string[] = []
  for (const allow of rules.allow) {
    const site = allow.split('/').filter(Boolean)[0]
    if (!site || site === 'wday' || out.includes(site)) continue
    if (!isPathAllowed(rules, `/${site}/`)) continue
    out.push(site)
  }
  return out
}

/**
 * Offline tiebreak, used only when nothing may touch the network. It reads the
 * site NAME, which is a guess — see `chooseWorkdaySite` for the measured answer.
 */
const EARLY_CAREER_RE = /(student|univ|campus|early|intern|grad)/i

export function preferredWorkdaySite(sites: string[]): string | null {
  if (!sites.length) return null
  return sites.find((s) => EARLY_CAREER_RE.test(s)) ?? sites[0]
}

export interface WorkdaySiteScore {
  site: string
  total: number
  /** Postings under the tenant's intern facet, or null when it has no such facet. */
  internCount: number | null
}

/** Sites are probed at most this many per tenant — one tiny request each. */
export const WORKDAY_MAX_SITES_SCORED = 4

export async function scoreWorkdaySites(
  tenant: string,
  pod: string,
  sites: string[],
  page?: (id: WorkdayBoardId) => WorkdayPageFn
): Promise<WorkdaySiteScore[]> {
  const mk = page ?? livePageFn
  const out: WorkdaySiteScore[] = []
  for (const site of sites.slice(0, WORKDAY_MAX_SITES_SCORED)) {
    const id = { tenant, pod, site }
    const res = await mk(id)({ appliedFacets: {}, limit: 1, offset: 0, searchText: '' })
    if (!res.data || res.status !== 200) continue
    const facet = pickInternFacet(res.data.facets)
    out.push({ site, total: res.data.total ?? 0, internCount: facet ? facet.count : null })
  }
  return out
}

/**
 * Which of a tenant's public sites to list.
 *
 * Guessing by name is wrong, and Illumina is the proof: it publishes
 * illumina-careers (150 postings) and illumina-universityrecruiting (zero), and
 * the name-based guess picks the empty one. So ask each site how many postings
 * it has — one request apiece — and take the one with the most internships,
 * falling back to the most postings. An empty site never wins over a populated
 * one, whatever it is called.
 */
export async function chooseWorkdaySite(
  tenant: string,
  pod: string,
  sites: string[],
  page?: (id: WorkdayBoardId) => WorkdayPageFn
): Promise<string | null> {
  if (sites.length <= 1) return sites[0] ?? null
  const scored = await scoreWorkdaySites(tenant, pod, sites, page)
  if (!scored.length) return preferredWorkdaySite(sites)
  const populated = scored.filter((s) => s.total > 0)
  const pool = populated.length ? populated : scored
  pool.sort((a, b) => (b.internCount ?? 0) - (a.internCount ?? 0) || b.total - a.total)
  return pool[0].site
}

export interface WorkdayProbeOptions {
  pods?: string[]
  /** Slug candidates to try; defaults to slugCandidates(name, domain). */
  slugs?: string[]
  maxProbes?: number
}

/**
 * Find a company's Workday tenant. Deliberately gated: `detect.ts` calls this
 * only once a careers page has said "Workday", because probing five pods for
 * every company on the watchlist is both slow and rude.
 */
export async function probeWorkdayTenant(
  input: { companyName: string; domain?: string | null },
  options: WorkdayProbeOptions = {}
): Promise<{ board: AtsBoardRef; sites: string[] } | null> {
  const pods = options.pods ?? WORKDAY_PODS
  const slugs = options.slugs ?? slugCandidates(input.companyName, input.domain)
  const budget = options.maxProbes ?? 8
  let probes = 0
  for (const slug of slugs) {
    for (const pod of pods) {
      if (probes >= budget) return null
      probes++
      const sites = await workdaySites(slug, pod)
      if (!sites.length) continue
      const site = await chooseWorkdaySite(slug, pod, sites)
      if (!site) continue
      return { board: boardRef({ tenant: slug, pod, site }, input.companyName), sites }
    }
  }
  return null
}
