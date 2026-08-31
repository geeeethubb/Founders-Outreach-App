// Tenant discovery: turning somebody else's job list into our board watchlist.
//
// THE PROBLEM THIS SOLVES. Discovery is only as wide as the set of boards it
// knows to ask. The watchlist has been hand-curated and planner-invented, and
// docs/JOB_DISCOVERY_V2_AUDIT.md measured what that costs: 284 postings from 34
// companies, 107 of them (38 %) from a single Workday tenant, and every large
// industrial employer the founder actually needs — Merck, DuPont, Corning,
// ExxonMobil, 3M, Illumina, Marathon — answering "no public board detected".
//
// THE OBSERVATION. A job URL is a board address. `boards.greenhouse.io/acme/…`
// says the Greenhouse token is `acme`; `acme.wd5.myworkdayjobs.com/en-US/Ext/…`
// says the Workday board is `acme/wd5/Ext`. So any feed that carries employer
// links is also a free tenant directory. Walking the Simplify corpus once
// yields hundreds of boards nobody typed in (docs/ATS_ENDPOINTS.md §"Rules for
// the implementer", rule 3: tenant discovery is the real cost, not the fetch).
//
// WHAT THIS FILE IS. A pure function. No network, no database, no env. It maps
// `RawJobPosting[]` → deduplicated board references. Probing, adopting and
// storing them are somebody else's job, deliberately: this stays testable
// against a fixture and cheap enough to run on every batch of postings that
// passes through the pipeline, from any source.
//
// It extends `atsFromUrl` in ./simplify, which answers the coarse question
// ("which of the six adapted families is this?"). This answers the fine one:
// which family, which tenant, which site, and — when the URL cannot say — what
// a later probe still has to resolve. A host we cannot name is REPORTED, never
// dropped; an unrecognised host that shows up two hundred times is the next
// adapter to write, and that signal only exists if it survives.

import type { AtsType } from '../types'
import type { AtsBoardRef, RawJobPosting } from './types'
import { atsFromUrl } from './simplify'
import { matchWorkdayUrl, parseWorkdayIdentifier, workdayBoardUrl } from './workday'

/**
 * ATS families addressable from a URL. Wider than `AtsType` on purpose:
 * `AtsType` is "families with a listing adapter", this is "families we can
 * recognise", and the gap between the two is the roadmap.
 */
export type TenantAtsFamily =
  | 'workday'
  | 'oracle_fusion'
  | 'icims'
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'smartrecruiters'
  | 'workable'
  | 'recruitee'
  | 'personio'
  | 'teamtailor'
  | 'gem'
  | 'taleo'
  | 'successfactors'
  | 'bamboohr'
  | 'rippling'
  | 'breezy'
  | 'jobvite'
  | 'eightfold'
  | 'avature'
  | 'paylocity'
  | 'adp'
  | 'dayforce'

/** Which `AtsType` a family maps to, for the six with a listing adapter. */
const ADAPTED: Partial<Record<TenantAtsFamily, AtsType>> = {
  greenhouse: 'greenhouse',
  lever: 'lever',
  ashby: 'ashby',
  smartrecruiters: 'smartrecruiters',
  workable: 'workable',
  workday: 'workday',
}

/**
 * Dayforce is recognised and then explicitly refused. docs/ATS_ENDPOINTS.md
 * §"Do not attempt": Cloudflare rejects non-browser POSTs before routing, and
 * its robots.txt reserves rights over `ai-input`. Naming it here is the point —
 * it keeps a Dayforce host out of the "unrecognised, go write an adapter" pile.
 */
const OFF_LIMITS: TenantAtsFamily[] = ['dayforce']

/** Hosts that are job lists, not employer boards. Reporting them as "unknown ATS" is noise. */
const AGGREGATOR_HOSTS = [
  'linkedin.com',
  'indeed.com',
  'glassdoor.com',
  'ziprecruiter.com',
  'handshake.com',
  'joinhandshake.com',
  'simplify.jobs',
  'google.com',
  'monster.com',
  'dice.com',
  'builtin.com',
  'wellfound.com',
  'angel.co',
  'levels.fyi',
  'jobright.ai',
  'untapped.io',
  'ripplematch.com',
  'wayup.com',
]

export function isAggregatorHost(host: string): boolean {
  const h = host.toLowerCase()
  return AGGREGATOR_HOSTS.some((a) => h === a || h.endsWith(`.${a}`))
}

/** One board, as far as a URL can describe it. */
export interface TenantMatch {
  ats: TenantAtsFamily
  /**
   * The string a listing adapter is addressed by:
   *   workday        `tenant/wdN/site`
   *   oracle_fusion  `host|siteNumber`
   *   everything else  the tenant slug / board token
   * Null when the URL names the host but not the board — see `needs`.
   */
  identifier: string | null
  host: string
  /** The public board URL, rebuilt from the parts. */
  boardUrl: string
  /** What a later probe must still resolve. Null when `identifier` is complete. */
  needs: string | null
}

// ─── Host → family, with the board part pulled out of the URL ────────────────

function segments(u: URL): string[] {
  return u.pathname.split('/').filter(Boolean)
}

/** First path segment that is not a known routing prefix. */
function firstSegment(u: URL, skip: string[] = []): string | null {
  const segs = segments(u)
  for (const s of segs) {
    if (skip.includes(s.toLowerCase())) continue
    return s
  }
  return null
}

const LOCALE_RE = /^[a-z]{2}(-[A-Za-z]{2})?$/i

/**
 * Labels that are never a board, on any family.
 *
 * A vendor's own site lives on the same domain as its customers' boards:
 * `www.greenhouse.io/pricing` and `boards.greenhouse.io/acme` differ only in
 * the parts this file reads. Without this set the first one is a Greenhouse
 * board whose token is `www`, marked `listable: true`, and handed to the real
 * adapter to fetch. The live Simplify corpus happens to contain no such link —
 * but this function is cheap on purpose so it can run on ANY batch of postings,
 * including careers-page scrapes and SERP results, where a link to a vendor's
 * marketing page is completely ordinary.
 *
 * Rejecting one is not a loss: the host is still reported, with `needs` saying
 * what a probe would have to resolve. A false negative costs a probe. A false
 * positive costs a fetch against somebody else's marketing site.
 */
const RESERVED_LABELS = new Set([
  'www',
  'app',
  'apps',
  'api',
  'my',
  'platform',
  'about',
  'pricing',
  'customers',
  'resources',
  'blog',
  'jobs',
  'job',
  'careers',
  'career',
  'company',
  'contact',
  'login',
  'signin',
  'sign-in',
  'signup',
  'demo',
  'partners',
  'solutions',
  'products',
  'product',
  'features',
  'support',
  'help',
  'docs',
  'documentation',
  'legal',
  'privacy',
  'terms',
  'status',
  'home',
  'index',
  'search',
  'static',
  'assets',
])

function isReservedLabel(s: string | null | undefined): boolean {
  return !!s && RESERVED_LABELS.has(s.trim().toLowerCase())
}

/** A reserved label is reported as "not resolved", never returned as a token. */
function boardToken(s: string | null | undefined): string | null {
  const t = (s ?? '').trim()
  return t && !isReservedLabel(t) ? t : null
}

/**
 * Oracle Fusion recruiting. 47 hits in the Simplify corpus, and the family the
 * large industrial employers run (docs/JOB_SOURCE_MATRIX.md §"Oracle Fusion").
 *
 * The listing endpoint needs a `siteNumber`, which the candidate-experience URL
 * carries as `/sites/{CX_N}/…`. When a URL is only the host, the identifier is
 * withheld rather than guessed: `recruitingCESites` on that host is public and
 * resolves it in one request (ATS_ENDPOINTS.md), so a null here is an instruction,
 * not a loss.
 */
function oracleFusion(u: URL, host: string): TenantMatch {
  const segs = segments(u)
  const i = segs.findIndex((s) => s.toLowerCase() === 'sites')
  const site = i >= 0 ? segs[i + 1] ?? null : null
  return {
    ats: 'oracle_fusion',
    identifier: site ? `${host}|${site}` : null,
    host,
    boardUrl: site ? `https://${host}/hcmUI/CandidateExperience/en/sites/${site}` : `https://${host}`,
    needs: site ? null : 'siteNumber — resolve with the public recruitingCESites endpoint on this host',
  }
}

/**
 * Greenhouse. Four shapes in the wild: `boards.greenhouse.io/{token}`,
 * `job-boards.greenhouse.io/{token}`, the EU mirrors, and the API host
 * `boards-api.greenhouse.io/v1/boards/{token}/jobs`.
 */
function greenhouse(u: URL, host: string): TenantMatch {
  const segs = segments(u)
  let token: string | null = null
  if (segs[0] === 'v1' && segs[1] === 'boards') token = boardToken(segs[2])
  else if (/^(job-)?boards(-api)?(\.eu)?\.greenhouse\.io$/.test(host) || host === 'my.greenhouse.io') {
    token = boardToken(firstSegment(u, ['embed', 'jobs']))
  } else {
    // The fallback: a `{token}.greenhouse.io` style host. `www.greenhouse.io`
    // is the VENDOR's own site, not a customer named "www".
    const sub = host.split('.')[0]
    token = sub && sub !== 'greenhouse' ? boardToken(sub) : null
  }
  return {
    ats: 'greenhouse',
    identifier: token,
    host,
    boardUrl: token ? `https://job-boards.greenhouse.io/${token}` : `https://${host}`,
    needs: token ? null : 'board token',
  }
}

/**
 * SAP SuccessFactors, where the subdomain is usually NOT the company.
 *
 * `career5.successfactors.eu` and `performancemanager4.successfactors.eu` are
 * shared SAP pods serving hundreds of employers; the company is in the query
 * string (`?company=Acme`). Reading the first label as a tenant there produces
 * an identifier naming SAP's infrastructure, marked complete, which is worse
 * than admitting the URL did not say. A dedicated rmk domain
 * (`acme.jobs2web.com`, `careers.acme.com` style rmk hosts) does carry it, and
 * ATS_ENDPOINTS.md keys the `sitemal.xml` feed — the typo is theirs — on that
 * host, not on this label.
 */
const SF_SHARED_POD = /^(careers?\d*|performancemanager\d*|pmlogin\d*|jobs2web|hcm\d*|apps?\d*)$/i

function successFactors(u: URL, host: string): TenantMatch {
  const company = (u.searchParams.get('company') ?? '').trim() || null
  const first = host.split('.')[0] ?? ''
  const rmk = SF_SHARED_POD.test(first) ? null : boardToken(first)
  const identifier = company ?? rmk
  return {
    ats: 'successfactors',
    identifier,
    host,
    boardUrl: `https://${host}`,
    needs: identifier ? null : 'company parameter or rmk domain — this host is a shared SAP pod',
  }
}

/** Subdomain-keyed families: `{tenant}.example.com`. */
function fromSubdomain(
  ats: TenantAtsFamily,
  host: string,
  boardUrl: (tenant: string) => string,
  reserved: string[] = []
): TenantMatch {
  const sub = host.split('.')[0]
  const tenant = sub && !reserved.includes(sub.toLowerCase()) ? boardToken(sub) : null
  return {
    ats,
    identifier: tenant,
    host,
    boardUrl: tenant ? boardUrl(tenant) : `https://${host}`,
    needs: tenant ? null : 'tenant slug',
  }
}

/** Path-keyed families: `{host}/{tenant}/…`. */
function fromPath(
  ats: TenantAtsFamily,
  u: URL,
  host: string,
  boardUrl: (tenant: string) => string,
  skip: string[] = []
): TenantMatch {
  const tenant = boardToken(firstSegment(u, skip))
  return {
    ats,
    identifier: tenant,
    host,
    boardUrl: tenant ? boardUrl(tenant) : `https://${host}`,
    needs: tenant ? null : 'board slug',
  }
}

/**
 * The one public entry point for "what board is this URL on?".
 *
 * Pure, total, and never throws — a malformed URL returns null, which the
 * caller reports as unusable rather than treating as a board.
 */
export function atsFamilyFromUrl(url: string | null | undefined): TenantMatch | null {
  let u: URL
  try {
    u = new URL(String(url ?? ''))
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  const host = u.hostname.toLowerCase()
  if (!host) return null

  // Workday's SECOND host family, and it is not small: `wdN.myworkdaysite.com`
  // carries the tenant and site in the PATH
  // (`/en-US/recruiting/{tenant}/{site}/job/…`) instead of the subdomain, so
  // `matchWorkdayUrl` — which keys on `{tenant}.wdN.myworkdayjobs.com` — does
  // not see it. Measured on the live Simplify corpus (2026-08-31): 148 postings
  // across wd1/wd3/wd5 landed in the "unrecognised host" pile purely because of
  // this. Same tenant, same site, same CXS API; only the URL shape differs, so
  // it normalises to the SAME `tenant/wdN/site` identifier the adapter lists.
  if (/^(wd\d+)\.myworkdaysite\.com$/.test(host)) {
    const pod = /^(wd\d+)\./.exec(host)![1]
    const segs = segments(u)
    let i = 0
    if (segs[i] && LOCALE_RE.test(segs[i])) i++
    if (segs[i]?.toLowerCase() === 'recruiting' || segs[i]?.toLowerCase() === 'wday') {
      // /wday/cxs/{tenant}/{site}/… and /recruiting/{tenant}/{site}/…
      if (segs[i].toLowerCase() === 'wday') i += 2
      else i += 1
    }
    const tenant = segs[i]?.toLowerCase() ?? null
    const site = segs[i + 1] ?? null
    if (tenant && site) {
      const id = { tenant, pod, site }
      return { ats: 'workday', identifier: `${tenant}/${pod}/${site}`, host, boardUrl: workdayBoardUrl(id), needs: null }
    }
    return { ats: 'workday', identifier: null, host, boardUrl: `https://${host}`, needs: 'tenant and site' }
  }

  // Workday's primary host family, and through the adapter's own matcher rather
  // than a second regex — `tenant/wdN/site` is the identifier
  // `workdayAdapter.listPostings` parses, and two implementations of that
  // format would drift.
  const wd = matchWorkdayUrl(u.toString())
  if (wd) {
    const id = parseWorkdayIdentifier(wd.board.identifier)
    return {
      ats: 'workday',
      identifier: wd.board.identifier,
      host,
      boardUrl: id ? workdayBoardUrl(id) : `https://${host}`,
      needs: null,
    }
  }

  if (/(^|\.)fa\.[a-z0-9-]+\.oraclecloud\.com$/.test(host) || /(^|\.)oraclecloud\.com$/.test(host)) {
    return oracleFusion(u, host)
  }
  if (/(^|\.)icims\.com$/.test(host)) {
    // The tenant IS the subdomain, `careers-` prefix and all — `careers-sig`
    // and `sig` are different hosts and only one of them answers.
    const sub = boardToken(host.slice(0, host.length - '.icims.com'.length))
    return {
      ats: 'icims',
      identifier: sub || null,
      host,
      boardUrl: `https://${host}/jobs/search`,
      needs: sub ? null : 'tenant subdomain',
    }
  }
  if (/(^|\.)greenhouse\.io$/.test(host)) return greenhouse(u, host)
  if (/(^|\.)lever\.co$/.test(host)) {
    return fromPath('lever', u, host, (t) => `https://jobs.lever.co/${t}`, ['v0', 'postings'])
  }
  if (/(^|\.)ashbyhq\.com$/.test(host)) {
    return fromPath('ashby', u, host, (t) => `https://jobs.ashbyhq.com/${t}`, ['posting-api', 'job-board'])
  }
  if (/(^|\.)smartrecruiters\.com$/.test(host)) {
    // SmartRecruiters company ids are case-sensitive CamelCase ("BoschGroup") —
    // never lowercased on the way through.
    return fromPath('smartrecruiters', u, host, (t) => `https://jobs.smartrecruiters.com/${t}`, ['v1', 'companies'])
  }
  if (/(^|\.)workable\.com$/.test(host)) {
    if (host === 'apply.workable.com' || host === 'www.workable.com' || host === 'jobs.workable.com') {
      return fromPath('workable', u, host, (t) => `https://apply.workable.com/${t}/`, ['j'])
    }
    return fromSubdomain('workable', host, (t) => `https://apply.workable.com/${t}/`, ['www', 'api', 'apply'])
  }
  if (/(^|\.)recruitee\.com$/.test(host)) {
    return fromSubdomain('recruitee', host, (t) => `https://${t}.recruitee.com`, ['www', 'jobs', 'api'])
  }
  if (/(^|\.)personio\.(de|com)$/.test(host)) {
    return fromSubdomain('personio', host, (t) => `https://${t}.jobs.personio.de`, ['www', 'jobs', 'api'])
  }
  if (/(^|\.)teamtailor\.com$/.test(host)) {
    return fromSubdomain('teamtailor', host, (t) => `https://${t}.teamtailor.com`, ['www', 'api'])
  }
  if (/(^|\.)gem\.com$/.test(host)) {
    // `jobs.gem.com/{slug}` and `api.gem.com/job_board/v0/{slug}/job_posts/`.
    return fromPath('gem', u, host, (t) => `https://jobs.gem.com/${t}`, ['job_board', 'v0'])
  }
  if (/(^|\.)taleo\.net$/.test(host)) {
    // `tbe.taleo.net` is Taleo Business Edition's SHARED host — the employer is
    // in `?org=`, not in the subdomain — so it is not a tenant either.
    return fromSubdomain('taleo', host, (t) => `https://${t}.taleo.net/careersection/`, ['tbe', 'hire'])
  }
  if (/(^|\.)(successfactors|sapsf)\.(com|eu)$/.test(host) || /(^|\.)jobs2web\.com$/.test(host)) {
    return successFactors(u, host)
  }
  if (/(^|\.)bamboohr\.com$/.test(host)) {
    return fromSubdomain('bamboohr', host, (t) => `https://${t}.bamboohr.com/careers`, ['www'])
  }
  if (/(^|\.)rippling\.com$/.test(host)) {
    // The documented API host buries the slug six segments deep
    // (`api.rippling.com/platform/api/ats/v1/board/{slug}/jobs`, ATS_ENDPOINTS.md),
    // so the first path segment is `platform` — infrastructure, not a board.
    const segs = segments(u)
    const i = segs.findIndex((s) => s.toLowerCase() === 'board')
    const slug = i >= 0 ? boardToken(segs[i + 1]) : boardToken(firstSegment(u))
    return {
      ats: 'rippling',
      identifier: slug,
      host,
      boardUrl: slug ? `https://ats.rippling.com/${slug}` : `https://${host}`,
      needs: slug ? null : 'board slug',
    }
  }
  if (/(^|\.)breezy\.hr$/.test(host)) {
    return fromSubdomain('breezy', host, (t) => `https://${t}.breezy.hr`, ['www', 'app', 'api'])
  }
  if (/(^|\.)jobvite\.com$/.test(host)) {
    return fromPath('jobvite', u, host, (t) => `https://jobs.jobvite.com/${t}`, [])
  }
  if (/(^|\.)eightfold\.ai$/.test(host)) {
    return fromSubdomain('eightfold', host, (t) => `https://${t}.eightfold.ai/careers`, ['www', 'app'])
  }
  if (/(^|\.)avature\.net$/.test(host)) {
    return fromSubdomain('avature', host, (t) => `https://${t}.avature.net`, ['www'])
  }
  if (/(^|\.)paylocity\.com$/.test(host)) {
    // recruiting.paylocity.com/recruiting/jobs/All/{uuid}/{Company}
    const segs = segments(u)
    const uuid = segs.find((s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) ?? null
    return {
      ats: 'paylocity',
      identifier: uuid,
      host,
      boardUrl: uuid ? `https://recruiting.paylocity.com/recruiting/jobs/All/${uuid}` : `https://${host}`,
      needs: uuid ? null : 'careers-page UUID',
    }
  }
  if (/(^|\.)adp\.com$/.test(host)) {
    const cid = u.searchParams.get('cid')
    return {
      ats: 'adp',
      identifier: cid,
      host,
      boardUrl: cid
        ? `https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=${cid}`
        : `https://${host}`,
      needs: cid ? null : 'the cid UUID from the careers-page link',
    }
  }
  if (/(^|\.)dayforcehcm\.com$/.test(host) || /(^|\.)dayforce\.com$/.test(host)) {
    return {
      ats: 'dayforce',
      identifier: null,
      host,
      boardUrl: `https://${host}`,
      needs: 'nothing — Dayforce is off-limits (ATS_ENDPOINTS.md §Do not attempt)',
    }
  }

  // Last resort: whatever the coarse simplify mapping already knows. It only
  // ever names the six adapted families, so this is a safety net for a host
  // pattern added there and not yet here — never the primary path.
  const coarse = atsFromUrl(u.toString())
  if (coarse.ats && coarse.ats !== 'other') {
    const fam = coarse.ats as TenantAtsFamily
    return { ats: fam, identifier: null, host, boardUrl: `https://${host}`, needs: 'board slug' }
  }
  return null
}

// ─── Walking a batch of postings ─────────────────────────────────────────────

/** A deduplicated board reference, and what it would take to use it. */
export interface DiscoveredTenant {
  ats: TenantAtsFamily | 'unknown'
  identifier: string | null
  host: string
  companyName: string | null
  sampleUrl: string
  boardUrl: string
  /** How many postings pointed at this board. The ranking signal. */
  postings: number
  /** True when a listing adapter exists for this family AND the identifier is complete. */
  listable: boolean
  /** What a probe must still resolve. Null when nothing is missing. */
  needs: string | null
  /** False for families we have decided not to touch (Dayforce). */
  probeAllowed: boolean
}

export interface TenantDiscoveryOptions {
  /** Read `apply_url` and `source_url` as well as `canonical_url`. Default true. */
  includeApplyUrls?: boolean
  /** Report hosts no family claims. Default true. */
  includeUnrecognized?: boolean
  /** Leave job aggregators out of the unrecognised pile. Default true. */
  dropAggregatorHosts?: boolean
}

export interface TenantDiscoveryResult {
  /** Recognised boards, most-referenced first. */
  tenants: DiscoveredTenant[]
  /** Hosts no family claims — reported, because an unnamed host seen 200 times is the next adapter. */
  unrecognized: DiscoveredTenant[]
  /** Board count per family, for the run report. */
  byFamily: Record<string, number>
  postingsScanned: number
  urlsExamined: number
  /** URLs that would not parse at all. */
  unusable: number
}

function urlsOf(p: RawJobPosting, includeApply: boolean): string[] {
  const raw = includeApply
    ? [p.canonical_url, p.apply_url, p.source_url]
    : [p.canonical_url]
  const out: string[] = []
  for (const u of raw) {
    const s = (u ?? '').trim()
    if (s && !out.includes(s)) out.push(s)
  }
  return out
}

/**
 * Every board referenced by a batch of postings, deduplicated.
 *
 * Pure: no network, no database, no env. Call it on anything that produced
 * `RawJobPosting`s — the Simplify feed, a SERP page, an ATS listing — and the
 * boards fall out for free.
 *
 * Dedupe is case-insensitive on `family + (identifier ?? host)`, because a
 * Workday site linked as `/External` in one row and `/external` in another is
 * one board; the first spelling seen is the one kept, since that is the one a
 * live URL used.
 */
export function discoverTenantsFromPostings(
  postings: readonly RawJobPosting[],
  opts: TenantDiscoveryOptions = {}
): TenantDiscoveryResult {
  const includeApply = opts.includeApplyUrls !== false
  const includeUnrecognized = opts.includeUnrecognized !== false
  const dropAggregators = opts.dropAggregatorHosts !== false

  const found = new Map<string, DiscoveredTenant>()
  let urlsExamined = 0
  let unusable = 0

  for (const p of postings ?? []) {
    if (!p) continue
    const company = (p.company_name ?? '').trim() || null
    // One posting counts once per board, however many of its three URLs
    // point there — otherwise a canonical/apply pair triples every count.
    const seenHere = new Set<string>()
    for (const url of urlsOf(p, includeApply)) {
      urlsExamined++
      const match = atsFamilyFromUrl(url)
      let entry: DiscoveredTenant
      if (match) {
        entry = {
          ats: match.ats,
          identifier: match.identifier,
          host: match.host,
          companyName: company,
          sampleUrl: url,
          boardUrl: match.boardUrl,
          postings: 0,
          listable: !!match.identifier && !!ADAPTED[match.ats],
          needs: match.needs,
          probeAllowed: !OFF_LIMITS.includes(match.ats),
        }
      } else {
        let host: string
        try {
          host = new URL(url).hostname.toLowerCase()
        } catch {
          unusable++
          continue
        }
        if (!host) {
          unusable++
          continue
        }
        if (!includeUnrecognized) continue
        if (dropAggregators && isAggregatorHost(host)) continue
        entry = {
          ats: 'unknown',
          identifier: null,
          host,
          companyName: company,
          sampleUrl: url,
          boardUrl: `https://${host}`,
          postings: 0,
          listable: false,
          needs: 'ATS family — probe the careers page to identify it',
          probeAllowed: true,
        }
      }

      const key = `${entry.ats}|${(entry.identifier ?? entry.host).toLowerCase()}`
      if (seenHere.has(key)) continue
      seenHere.add(key)
      const prev = found.get(key)
      if (prev) {
        prev.postings++
        // Keep the richest description of the board we have seen: a company
        // name and a resolved identifier both beat a null.
        if (!prev.companyName && company) prev.companyName = company
        if (!prev.identifier && entry.identifier) {
          prev.identifier = entry.identifier
          prev.boardUrl = entry.boardUrl
          prev.needs = entry.needs
          prev.listable = entry.listable
        }
      } else {
        entry.postings = 1
        found.set(key, entry)
      }
    }
  }

  const all = [...found.values()].sort(
    (a, b) => b.postings - a.postings || a.host.localeCompare(b.host) || (a.identifier ?? '').localeCompare(b.identifier ?? '')
  )
  const tenants = all.filter((t) => t.ats !== 'unknown')
  const unrecognized = all.filter((t) => t.ats === 'unknown')

  const byFamily: Record<string, number> = {}
  for (const t of all) byFamily[t.ats] = (byFamily[t.ats] ?? 0) + 1

  return {
    tenants,
    unrecognized,
    byFamily,
    postingsScanned: postings?.length ?? 0,
    urlsExamined,
    unusable,
  }
}

/**
 * A discovered tenant as an `AtsBoardRef`, so the watchlist and the six
 * adapters can take it without knowing where it came from.
 *
 * Unadapted families come back as `ats: 'other'` rather than being dropped —
 * that is exactly how the registry already records an iCIMS or Oracle board
 * (see `matchAnyAtsUrl` in ./registry), and it keeps the canonical URL for the
 * day the adapter lands. A tenant with no identifier has nothing to address and
 * returns null.
 */
export function toAtsBoardRef(t: DiscoveredTenant): AtsBoardRef | null {
  if (!t.identifier || t.ats === 'unknown') return null
  return {
    ats: ADAPTED[t.ats] ?? 'other',
    identifier: t.identifier,
    company_name: t.companyName ?? undefined,
    board_url: t.boardUrl,
  }
}

/** One line per family, for the run report. */
export function summarizeTenants(result: TenantDiscoveryResult): string[] {
  const lines = Object.entries(result.byFamily)
    .sort((a, b) => b[1] - a[1])
    .map(([family, n]) => {
      const boards = result.tenants.concat(result.unrecognized).filter((t) => t.ats === family)
      const listable = boards.filter((t) => t.listable).length
      const blocked = boards.filter((t) => !t.probeAllowed).length
      const parts = [`${n} board${n === 1 ? '' : 's'}`]
      if (listable) parts.push(`${listable} listable today`)
      if (blocked) parts.push(`${blocked} off-limits`)
      return `${family.padEnd(16)} ${parts.join(' · ')}`
    })
  return lines
}
