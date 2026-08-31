// Personio — a public XML feed carrying the whole description, and the one
// source in this group that will punish you for asking twice.
//
//   GET https://{tenant}.jobs.personio.de/xml?language=en    (also .com)
//
// Probed live 2026-08-31. Two things the probe corrected:
//
//   1. THE 429 IS NOT ALWAYS A RATE LIMIT. A tenant that does not exist answers
//      `HTTP 307 → Location: https://personio.com`, and personio.com sits
//      behind a Vercel checkpoint that returns `HTTP 429 text/html`. Follow the
//      redirect and "no such tenant" is indistinguishable from "you are being
//      throttled" — which is exactly the confusion that produced the note in
//      docs/ATS_ENDPOINTS.md about 429s after ~5 probes. So this adapter uses
//      `redirect: 'manual'`: a 3xx off the tenant host is NO SUCH BOARD, and a
//      429 from the tenant host itself is the real rate limit.
//   2. Detect by CONTENT-TYPE as well as status. The feed is `text/xml`;
//      anything `text/html` is a checkpoint or a marketing page, never a board.
//
// Because the real limit is real, every request to this source passes through
// an explicit gate: a minimum interval between calls, and on a genuine 429 an
// exponential back-off that REFUSES the next call rather than retrying into the
// wall. The clock is injectable so the offline suite can prove the spacing
// without sleeping (`scripts/test-career-ats-feeds.ts`).
//
// Boundaries: public, unauthenticated, robots-checked. No login, no CAPTCHA
// (docs/CAREER_OS.md §5).

import { cached, cacheKey } from '@/lib/providers/cache'
import type { RawJobPosting } from './types'
import type {
  DiscoveryHealth,
  DiscoverySearchInput,
  DiscoverySearchResult,
  JobDiscoverySource,
} from './discovery-types'
import { internshipLike, listCacheBypassFromEnv, utcDayKey } from './fetch'
import { decodeEntities, htmlToText } from './html'
import { CAREER_BOT_USER_AGENT, getRobotsRules, isPathAllowed } from './robots'

/** Minimum gap between two requests to Personio, whatever the tenant. */
export const PERSONIO_MIN_GAP_MS = 4_000
/** First back-off after a genuine 429. Doubles, capped. */
export const PERSONIO_BACKOFF_START_MS = 30_000
export const PERSONIO_BACKOFF_MAX_MS = 10 * 60_000
/** A call that would have to wait longer than this gives up instead of stalling the run. */
export const PERSONIO_MAX_WAIT_MS = 30_000

export type PersonioTld = 'de' | 'com'

export function personioFeedUrl(tenant: string, tld: PersonioTld = 'de', language = 'en'): string {
  return `https://${encodeURIComponent(tenant)}.jobs.personio.${tld}/xml?language=${encodeURIComponent(language)}`
}

export function personioBoardUrl(tenant: string, tld: PersonioTld = 'de'): string {
  return `https://${encodeURIComponent(tenant)}.jobs.personio.${tld}`
}

// ─── The throttle ────────────────────────────────────────────────────────────

export interface PersonioClock {
  now(): number
  sleep(ms: number): Promise<void>
}

export const realClock: PersonioClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
}

interface Gate {
  nextAllowedAt: number
  backoffMs: number
}

const gate: Gate = { nextAllowedAt: 0, backoffMs: 0 }

/** Test seam. */
export function resetPersonioThrottle(): void {
  gate.nextAllowedAt = 0
  gate.backoffMs = 0
}

export function personioThrottleState(): { nextAllowedAt: number; backoffMs: number } {
  return { ...gate }
}

/**
 * Wait out the gap, then reserve the next slot. Returns the milliseconds
 * actually waited, or null when the wait would exceed `maxWaitMs` — in which
 * case the caller reports "rate limited" and moves on instead of holding a run
 * open behind one source.
 */
export async function personioGate(
  clock: PersonioClock,
  minGapMs = PERSONIO_MIN_GAP_MS,
  maxWaitMs = PERSONIO_MAX_WAIT_MS
): Promise<number | null> {
  const now = clock.now()
  const wait = Math.max(0, gate.nextAllowedAt - now)
  if (wait > maxWaitMs) return null
  gate.nextAllowedAt = Math.max(now, gate.nextAllowedAt) + minGapMs
  if (wait > 0) await clock.sleep(wait)
  return wait
}

/** Record a genuine 429: double the back-off and refuse until it elapses. */
export function personioBackoff(clock: PersonioClock): number {
  gate.backoffMs = gate.backoffMs === 0 ? PERSONIO_BACKOFF_START_MS : Math.min(gate.backoffMs * 2, PERSONIO_BACKOFF_MAX_MS)
  gate.nextAllowedAt = clock.now() + gate.backoffMs
  return gate.backoffMs
}

function clearBackoff(): void {
  gate.backoffMs = 0
}

// ─── Fetching ────────────────────────────────────────────────────────────────

export interface PersonioResponse {
  status: number
  body: string
  contentType: string
  /** Set when the tenant host answered a 3xx. Its value is the Location header. */
  redirectTo?: string | null
  error?: string
}

export type PersonioFetcher = (url: string) => Promise<PersonioResponse>

/**
 * `redirect: 'manual'` on purpose — see the header comment. Following the
 * redirect turns "no such tenant" into a 429 from a completely different host.
 */
export const defaultPersonioFetcher: PersonioFetcher = async (url) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': CAREER_BOT_USER_AGENT, Accept: 'application/xml,text/xml;q=0.9,*/*;q=0.5' },
      redirect: 'manual',
      signal: controller.signal,
    })
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
    if (res.status >= 300 && res.status < 400) {
      return { status: res.status, body: '', contentType, redirectTo: res.headers.get('location') }
    }
    return { status: res.status, body: await res.text(), contentType }
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError'
    return { status: 0, body: '', contentType: '', error: aborted ? 'timeout' : e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(timer)
  }
}

// ─── The XML parser ──────────────────────────────────────────────────────────
//
// `<workzag-jobs><position>…</position>…</workzag-jobs>`, descriptions in CDATA.
// A regex reader is enough and adds no dependency — but the order of operations
// matters: `<name>` is BOTH the job title and the heading of every description
// section, and `<office>` appears both at the top level and inside
// `<additionalOffices>`. So the nested blocks are lifted out FIRST and the
// scalar fields are read from what remains. Reading them in the other order
// silently titles every job after its first description heading.

export interface PersonioDescriptionSection {
  name: string
  html: string
}

export interface PersonioPosition {
  id: string | null
  name: string | null
  subcompany: string | null
  office: string | null
  additionalOffices: string[]
  department: string | null
  recruitingCategory: string | null
  employmentType: string | null
  seniority: string | null
  schedule: string | null
  yearsOfExperience: string | null
  occupation: string | null
  occupationCategory: string | null
  createdAt: string | null
  descriptions: PersonioDescriptionSection[]
}

function stripCdata(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
}

function block(xml: string, tag: string): { inner: string; rest: string } {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i')
  const m = re.exec(xml)
  if (!m) return { inner: '', rest: xml }
  return { inner: m[1], rest: xml.slice(0, m.index) + xml.slice(m.index + m[0].length) }
}

/** First `<tag>…</tag>`, CDATA unwrapped, entities decoded, trimmed. Null when absent or empty. */
export function personioTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i')
  const m = re.exec(xml)
  if (!m) return null
  const value = decodeEntities(stripCdata(m[1])).trim()
  return value || null
}

function allTags(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi')
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    const value = decodeEntities(stripCdata(m[1])).trim()
    if (value) out.push(value)
  }
  return out
}

export function parsePersonioPosition(xml: string): PersonioPosition {
  const lifted = block(xml, 'jobDescriptions')
  const offices = block(lifted.rest, 'additionalOffices')
  const scalars = offices.rest

  const descriptions: PersonioDescriptionSection[] = []
  const sectionRe = /<jobDescription>([\s\S]*?)<\/jobDescription>/gi
  let s: RegExpExecArray | null
  while ((s = sectionRe.exec(lifted.inner))) {
    const section = s[1]
    const name = personioTag(section, 'name') ?? ''
    // `value` holds CDATA HTML; keep it as HTML and let the caller flatten it.
    const valueRe = /<value(?:\s[^>]*)?>([\s\S]*?)<\/value>/i.exec(section)
    const html = valueRe ? stripCdata(valueRe[1]).trim() : ''
    if (name || html) descriptions.push({ name, html })
  }

  return {
    id: personioTag(scalars, 'id'),
    name: personioTag(scalars, 'name'),
    subcompany: personioTag(scalars, 'subcompany'),
    office: personioTag(scalars, 'office'),
    additionalOffices: allTags(offices.inner, 'office'),
    department: personioTag(scalars, 'department'),
    recruitingCategory: personioTag(scalars, 'recruitingCategory'),
    employmentType: personioTag(scalars, 'employmentType'),
    seniority: personioTag(scalars, 'seniority'),
    schedule: personioTag(scalars, 'schedule'),
    yearsOfExperience: personioTag(scalars, 'yearsOfExperience'),
    occupation: personioTag(scalars, 'occupation'),
    occupationCategory: personioTag(scalars, 'occupationCategory'),
    createdAt: personioTag(scalars, 'createdAt'),
    descriptions,
  }
}

export function parsePersonioXml(xml: string): PersonioPosition[] {
  const out: PersonioPosition[] = []
  const re = /<position>([\s\S]*?)<\/position>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) out.push(parsePersonioPosition(m[1]))
  return out
}

// ─── Normalizing ─────────────────────────────────────────────────────────────

/** Sections joined with their headings kept — they are the structure of the JD. */
export function personioDescriptionHtml(position: PersonioPosition): string | null {
  const parts = position.descriptions
    .map((d) => (d.name ? `<h3>${d.name}</h3>\n${d.html}` : d.html))
    .filter((p) => p.trim())
  return parts.length > 0 ? parts.join('\n') : null
}

export function personioLocation(position: PersonioPosition): string | null {
  const all = [position.office, ...position.additionalOffices].map((o) => (o ?? '').trim()).filter(Boolean)
  return all.length > 0 ? Array.from(new Set(all)).join(' · ') : null
}

export function personioDateToIso(value: string | null): string | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

export function normalizePersonioPosition(
  position: PersonioPosition,
  tenant: string,
  tld: PersonioTld = 'de',
  now = new Date().toISOString()
): RawJobPosting | null {
  const title = (position.name ?? '').trim()
  if (!title || !position.id) return null
  const html = personioDescriptionHtml(position)
  // CONSTRUCTED, not returned: the XML carries no URL at all. `/job/{id}` is
  // Personio's public pattern, and it is why `givesCanonicalUrl` is false here.
  //
  // Verified live 2026-08-31 on a SECOND tenant, because the first one proved
  // nothing: `personio.jobs.personio.de/job/1834171` answers 307 → personio.com
  // (that tenant's whole HTML board 307s — Personio moved its own careers site,
  // while its XML feed still serves 200). On a normal tenant the pattern holds:
  // `jobleads.jobs.personio.de/xml?language=en` → 200, 12 positions, and
  // `jobleads.jobs.personio.de/job/2730769` → 200, 109 KB, <title> matching that
  // position's `<name>`. So `apply_url` is kept — a link that resolves on a live
  // board is worth more to the founder than no link at all — and every consumer
  // can tell it was built rather than returned via `raw.personio.url_constructed`.
  const url = `${personioBoardUrl(tenant, tld)}/job/${position.id}`
  const hint = [position.employmentType, position.seniority].map((v) => (v ?? '').trim()).filter(Boolean).join(' · ')

  return {
    // `JobSourceType` has no `personio` member and this workstream does not own
    // that union; provenance lives in `raw.personio`. See `open_issues`.
    source_type: 'careers_page',
    source_url: url,
    external_id: position.id,
    company_name: (position.subcompany ?? '').trim() || tenant,
    company_domain: null,
    title,
    location_raw: personioLocation(position),
    description_text: html ? htmlToText(html) : null,
    description_html: html,
    department: (position.department ?? '').trim() || (position.recruitingCategory ?? '').trim() || null,
    posted_at: personioDateToIso(position.createdAt),
    updated_at: null,
    apply_url: url,
    canonical_url: url,
    ats_type: 'other',
    ats_job_id: position.id,
    requisition_id: null,
    employment_type_hint: hint || null,
    raw: {
      personio: {
        tenant,
        tld,
        id: position.id,
        subcompany: position.subcompany,
        offices: [position.office, ...position.additionalOffices].filter(Boolean),
        recruiting_category: position.recruitingCategory,
        employment_type: position.employmentType,
        seniority: position.seniority,
        schedule: position.schedule,
        years_of_experience: position.yearsOfExperience,
        occupation: position.occupation,
        occupation_category: position.occupationCategory,
        url_constructed: true,
      },
      sections: position.descriptions.map((d) => d.name),
    },
    retrieved_at: now,
  }
}

export function personioTenantFromUrl(url: string | null | undefined): { tenant: string; tld: PersonioTld } | null {
  try {
    const host = new URL(url ?? '').hostname.toLowerCase()
    const m = /^([a-z0-9][a-z0-9-]*)\.jobs\.personio\.(de|com)$/.exec(host)
    return m ? { tenant: m[1], tld: m[2] as PersonioTld } : null
  } catch {
    return null
  }
}

// ─── The source ──────────────────────────────────────────────────────────────

export interface PersonioSourceOptions {
  fetcher?: PersonioFetcher
  clock?: PersonioClock
  /** Tests only. Product code always honours robots.txt. */
  skipRobots?: boolean
  bypassCache?: boolean
  minGapMs?: number
  maxWaitMs?: number
}

export interface PersonioFeedResult {
  positions: PersonioPosition[]
  status: number
  error?: string
  note?: string
  requests: number
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

export async function fetchPersonioFeed(
  tenant: string,
  tld: PersonioTld,
  opts: PersonioSourceOptions
): Promise<PersonioFeedResult> {
  const url = personioFeedUrl(tenant, tld)
  if (await robotsBlocked(url, opts.skipRobots)) {
    return { positions: [], status: 0, error: `robots.txt disallows ${url}`, requests: 0 }
  }
  const clock = opts.clock ?? realClock
  const run = async (): Promise<PersonioFeedResult> => {
    const waited = await personioGate(clock, opts.minGapMs ?? PERSONIO_MIN_GAP_MS, opts.maxWaitMs ?? PERSONIO_MAX_WAIT_MS)
    if (waited === null) {
      return { positions: [], status: 429, error: `Personio is backing off (${gate.backoffMs} ms); skipped "${tenant}"`, requests: 0 }
    }
    // `search` must never throw for ANY fetcher (discovery-types rule 1).
    let res: PersonioResponse
    try {
      res = await (opts.fetcher ?? defaultPersonioFetcher)(url)
    } catch (e) {
      return { positions: [], status: 0, error: e instanceof Error ? e.message : String(e), requests: 1 }
    }

    // A 3xx off the tenant host is "no such board" — NOT a rate limit.
    if (res.status >= 300 && res.status < 400) {
      return { positions: [], status: 404, note: `no Personio board "${tenant}" (redirected to ${res.redirectTo ?? 'personio.com'})`, requests: 1 }
    }
    if (res.status === 429) {
      const backoff = personioBackoff(clock)
      return { positions: [], status: 429, error: `Personio rate-limited this run; backing off ${backoff} ms`, requests: 1 }
    }
    if (res.status === 404) return { positions: [], status: 404, note: `no Personio board "${tenant}"`, requests: 1 }
    if (res.status !== 200) return { positions: [], status: res.status, error: res.error ?? `http ${res.status}`, requests: 1 }
    // Detect by content-type as well: an HTML body from this URL is a
    // checkpoint or a marketing page, never a feed.
    if (res.contentType.includes('html') || !/<workzag-jobs|<position>/i.test(res.body)) {
      return { positions: [], status: 200, error: `Personio returned ${res.contentType || 'an unknown type'} rather than the XML feed`, requests: 1 }
    }
    clearBackoff()
    return { positions: parsePersonioXml(res.body), status: 200, requests: 1 }
  }
  const key = cacheKey('personio-feed', { tenant: tenant.toLowerCase(), tld, day: utcDayKey() })
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
    const hay = `${posting.title} ${posting.department ?? ''} ${posting.description_text ?? ''}`.toLowerCase()
    if (!terms.some((t) => hay.includes(t.toLowerCase()))) return false
  }
  return true
}

/**
 * No slug guessing here, unlike Recruitee and Gem. Every miss costs a request
 * against the one source that rate-limits, so a tenant must be NAMED — by a
 * board, a `personio.` careers URL, or `extra.personioTenant`.
 */
function resolveTenant(input: DiscoverySearchInput): { tenant: string; tld: PersonioTld } | null {
  const hinted = typeof input.extra?.personioTenant === 'string' ? input.extra.personioTenant : null
  const hintedTld = input.extra?.personioTld === 'com' ? 'com' : 'de'
  if (hinted) return { tenant: hinted.trim().toLowerCase(), tld: hintedTld as PersonioTld }
  if (input.board) {
    const fromUrl = personioTenantFromUrl(input.board.board_url)
    if (fromUrl) return fromUrl
    // A board whose URL is a Personio host the strict regex could not parse —
    // `jobs.personio.de/tenant`, a trailing path, a stray port — still names its
    // tenant in the identifier. That is worth reading; a BARE identifier is not.
    //
    // Deliberately narrow: `AtsBoardRef` has no family field, so `{ats:'other',
    // identifier:'acme'}` from any other ATS is indistinguishable from a Personio
    // board. Accepting those would fire a request at `acme.jobs.personio.de` for
    // boards that were never Personio's — against the one source that rate-limits,
    // where a wasted request costs the 4 s gap and can arm a 30 s back-off for the
    // whole run. So the host must say Personio before the identifier is trusted.
    const host = ((): string => {
      try {
        return new URL(input.board.board_url ?? '').hostname.toLowerCase()
      } catch {
        return ''
      }
    })()
    const onPersonio = /(^|\.)personio\.(de|com)$/.test(host)
    if (onPersonio && input.board.identifier) {
      const id = String(input.board.identifier).trim().toLowerCase()
      const tld: PersonioTld = host.endsWith('.com') ? 'com' : 'de'
      if (/^[a-z0-9][a-z0-9-]*$/.test(id)) return { tenant: id, tld }
    }
  }
  const fromCompany = personioTenantFromUrl(input.company?.careersUrl)
  if (fromCompany) return fromCompany
  return null
}

export function personioSource(opts: PersonioSourceOptions = {}): JobDiscoverySource {
  return {
    id: 'personio',
    name: 'Personio',
    sourceType: 'ats',
    capabilities: {
      paginates: false,
      supportsQuery: true,
      supportsLocation: true,
      supportsSince: true,
      // The whole description arrives in the feed — the reason to build this.
      givesDescription: true,
      // The feed carries NO url. `/job/{id}` is constructed, so this is false.
      givesCanonicalUrl: false,
    },
    costModel: { kind: 'free' },
    isConfigured: () => process.env.CAREER_DISABLE_PERSONIO !== '1',
    async healthCheck(): Promise<DiscoveryHealth> {
      // Personio's own board, the tenant confirmed live on 2026-08-31.
      const res = await fetchPersonioFeed('personio', 'de', opts)
      if (res.error) return { ok: false, detail: `Personio unreachable: ${res.error}` }
      return { ok: res.status === 200, detail: `Personio reachable — personio returned ${res.positions.length} positions` }
    },
    async search(input: DiscoverySearchInput, cursor?: string | null): Promise<DiscoverySearchResult> {
      if (cursor) {
        return { postings: [], nextCursor: null, exhausted: true, seen: 0, note: 'Personio lists a board in one call; no page after the first' }
      }
      const resolved = resolveTenant(input)
      if (!resolved) {
        return {
          postings: [],
          nextCursor: null,
          exhausted: true,
          seen: 0,
          note: 'Personio needs a named tenant (board, personio. careers URL, or extra.personioTenant) — it is rate-limited, so slugs are never guessed',
        }
      }
      const res = await fetchPersonioFeed(resolved.tenant, resolved.tld, opts)
      if (res.error) {
        return { postings: [], nextCursor: null, exhausted: true, seen: 0, error: res.error, requests: res.requests }
      }
      if (res.status === 404) {
        return { postings: [], nextCursor: null, exhausted: true, seen: 0, note: res.note, requests: res.requests }
      }
      const now = new Date().toISOString()
      const all = res.positions
        .map((p) => normalizePersonioPosition(p, resolved.tenant, resolved.tld, now))
        .filter((p): p is RawJobPosting => p !== null)
      const kept = all.filter((p) => matchesInput(p, input))
      const limited = input.limit && input.limit > 0 ? kept.slice(0, input.limit) : kept
      return {
        postings: limited,
        nextCursor: null,
        exhausted: true,
        seen: res.positions.length,
        requests: res.requests,
        costUsd: 0,
      }
    },
  }
}
