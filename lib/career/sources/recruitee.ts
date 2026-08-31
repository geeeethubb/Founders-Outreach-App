// Recruitee — one unauthenticated GET returns the whole board, descriptions included.
//
//   GET https://{tenant}.recruitee.com/api/offers/   → { offers: [ … ] }
//
// Probed live 2026-08-31 against `vandebron`: HTTP 200, 12 offers, 56 fields
// each, `description` averaging ~8.7 k characters of HTML, plus structured
// `city` / `state_name` / `country_code`, three independent work-mode booleans
// (`remote`, `hybrid`, `on_site`) and a `salary` object. A tenant that does not
// exist answers a clean `404 {"error":"Not Found"}` — that is "no such board",
// not a failure, and it must never colour a run's error list
// (docs/ATS_ENDPOINTS.md; principle 9).
//
// This is the shape the founder's search was missing: `givesDescription: true`
// is TRUE here, so a posting from this source needs no second fetch before
// extraction, unlike Workday or SmartRecruiters.
//
// Boundaries: public, unauthenticated, robots-checked. No login, no CAPTCHA,
// nothing behind an access control (docs/CAREER_OS.md §5).

import { cached, cacheKey } from '@/lib/providers/cache'
import type { RawJobPosting } from './types'
import type {
  DiscoveryHealth,
  DiscoverySearchInput,
  DiscoverySearchResult,
  JobDiscoverySource,
} from './discovery-types'
import { fetchJson, internshipLike, listCacheBypassFromEnv, slugCandidates, utcDayKey, type JsonFetchResult } from './fetch'
import { htmlToText } from './html'
import { getRobotsRules, isPathAllowed } from './robots'

/** The one endpoint. The trailing slash is how the API is documented; it works either way. */
export function recruiteeOffersUrl(tenant: string): string {
  return `https://${encodeURIComponent(tenant)}.recruitee.com/api/offers/`
}

export function recruiteeBoardUrl(tenant: string): string {
  return `https://${encodeURIComponent(tenant)}.recruitee.com`
}

/**
 * The fields this adapter reads. The payload carries 56; the rest are stored
 * verbatim in `raw` rather than typed, because an unread field that changes
 * shape must not be able to break a parse.
 */
export interface RecruiteeOffer {
  id?: number | string
  slug?: string
  title?: string
  description?: string | null
  requirements?: string | null
  status?: string
  department?: string | null
  category_code?: string | null
  employment_type_code?: string | null
  experience_code?: string | null
  education_code?: string | null
  company_name?: string | null
  city?: string | null
  state_name?: string | null
  state_code?: string | null
  country?: string | null
  country_code?: string | null
  location?: string | null
  remote?: boolean | null
  hybrid?: boolean | null
  on_site?: boolean | null
  published_at?: string | null
  created_at?: string | null
  updated_at?: string | null
  close_at?: string | null
  careers_url?: string | null
  careers_apply_url?: string | null
  salary?: { min?: number | null; max?: number | null; currency?: string | null; period?: string | null } | null
  tags?: unknown[]
  [k: string]: unknown
}

export interface RecruiteeOffersResponse {
  offers?: RecruiteeOffer[]
  error?: string
}

/**
 * Recruitee stamps `"2026-08-14 08:23:10 UTC"` — a space where ISO wants a `T`
 * and a trailing zone name. `Date.parse` is permitted to reject that, so it is
 * rewritten rather than trusted; an unparseable stamp becomes null, never a
 * wrong date.
 */
export function recruiteeDateToIso(value: string | null | undefined): string | null {
  const s = (value ?? '').trim()
  if (!s) return null
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}( UTC)?$/.test(s)
    ? `${s.slice(0, 10)}T${s.slice(11, 19)}Z`
    : s
  const ms = Date.parse(normalized)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/** `city, state, country`, skipping the blanks. Falls back to the flat `location` string. */
export function recruiteeLocation(offer: RecruiteeOffer): string | null {
  const parts = [offer.city, offer.state_name, offer.country].map((p) => (p ?? '').trim()).filter(Boolean)
  if (parts.length > 0) return parts.join(', ')
  const flat = (offer.location ?? '').trim()
  return flat || null
}

/** The three booleans are independent; the first one set wins, in that order. */
export function recruiteeWorkMode(offer: RecruiteeOffer): 'remote' | 'hybrid' | 'onsite' | null {
  if (offer.remote === true) return 'remote'
  if (offer.hybrid === true) return 'hybrid'
  if (offer.on_site === true) return 'onsite'
  return null
}

/**
 * `description` is the body; `requirements` is a second HTML block that is
 * empty on most tenants and substantial on a few. Dropping it would lose real
 * requirement text, so both are joined when both are present.
 */
function descriptionHtml(offer: RecruiteeOffer): string | null {
  const desc = (offer.description ?? '').trim()
  const req = (offer.requirements ?? '').trim()
  if (desc && req) return `${desc}\n${req}`
  return desc || req || null
}

export function normalizeRecruiteeOffer(
  offer: RecruiteeOffer,
  tenant: string,
  now = new Date().toISOString()
): RawJobPosting | null {
  const title = (offer.title ?? '').trim()
  if (!title) return null
  const id = offer.id === undefined || offer.id === null ? null : String(offer.id)
  const html = descriptionHtml(offer)
  // `careers_url` is the tenant's own domain (werkenbij.vandebron.nl/o/…) when
  // one is configured, which is a better canonical than the recruitee.com host.
  const canonical =
    (offer.careers_url ?? '').trim() ||
    (offer.slug ? `${recruiteeBoardUrl(tenant)}/o/${offer.slug}` : recruiteeBoardUrl(tenant))
  const mode = recruiteeWorkMode(offer)

  return {
    // `JobSourceType` has no `recruitee` member and this workstream does not own
    // that union, so the honest generic is used and the platform is recorded in
    // `raw.recruitee` and `ats_type: 'other'`. See `open_issues`.
    source_type: 'careers_page',
    source_url: canonical,
    external_id: id,
    company_name: (offer.company_name ?? '').trim() || tenant,
    company_domain: null,
    title,
    location_raw: recruiteeLocation(offer),
    description_text: html ? htmlToText(html) : null,
    description_html: html,
    department: (offer.department ?? '').trim() || (offer.category_code ?? '').trim() || null,
    posted_at: recruiteeDateToIso(offer.published_at) ?? recruiteeDateToIso(offer.created_at),
    updated_at: recruiteeDateToIso(offer.updated_at),
    apply_url: (offer.careers_apply_url ?? '').trim() || canonical,
    canonical_url: canonical,
    ats_type: 'other',
    ats_job_id: id,
    requisition_id: null,
    employment_type_hint: (offer.employment_type_code ?? '').trim() || null,
    raw: {
      recruitee: {
        tenant,
        id,
        slug: offer.slug ?? null,
        status: offer.status ?? null,
        work_mode: mode,
        country_code: offer.country_code ?? null,
        state_code: offer.state_code ?? null,
        salary: offer.salary ?? null,
        experience_code: offer.experience_code ?? null,
        education_code: offer.education_code ?? null,
        close_at: recruiteeDateToIso(offer.close_at),
      },
      offer: offer as Record<string, unknown>,
    },
    retrieved_at: now,
  }
}

/** A Recruitee offer is live only while `status` says so. */
export function isPublished(offer: RecruiteeOffer): boolean {
  const status = (offer.status ?? '').toLowerCase()
  return status === '' || status === 'published'
}

// ─── Tenant resolution ───────────────────────────────────────────────────────

export function recruiteeTenantFromUrl(url: string | null | undefined): string | null {
  try {
    const host = new URL(url ?? '').hostname.toLowerCase()
    const m = /^([a-z0-9][a-z0-9-]*)\.recruitee\.com$/.exec(host)
    return m ? m[1] : null
  } catch {
    return null
  }
}

// ─── The source ──────────────────────────────────────────────────────────────

export type RecruiteeFetcher = <T>(url: string) => Promise<JsonFetchResult<T>>

export interface RecruiteeSourceOptions {
  fetcher?: RecruiteeFetcher
  /** Tests only. Product code always honours robots.txt. */
  skipRobots?: boolean
  bypassCache?: boolean
  /** How many slug guesses a company (rather than a board) may cost. */
  maxSlugProbes?: number
}

interface BoardFetch {
  offers: RecruiteeOffer[]
  status: number
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

async function fetchBoard(tenant: string, opts: RecruiteeSourceOptions): Promise<BoardFetch> {
  const url = recruiteeOffersUrl(tenant)
  if (await robotsBlocked(url, opts.skipRobots)) {
    return { offers: [], status: 0, error: `robots.txt disallows ${url}` }
  }
  const run = async (): Promise<BoardFetch> => {
    // `fetchJson` never rejects, but `search` must never throw for ANY fetcher
    // (discovery-types rule 1), so the contract is enforced here, not assumed.
    let res: JsonFetchResult<RecruiteeOffersResponse>
    try {
      res = await (opts.fetcher ?? fetchJson)<RecruiteeOffersResponse>(url)
    } catch (e) {
      return { offers: [], status: 0, error: e instanceof Error ? e.message : String(e) }
    }
    // A missing tenant is a clean 404. It is an ANSWER, not an error.
    if (res.status === 404) return { offers: [], status: 404, note: `no Recruitee board "${tenant}"` }
    if (res.status !== 200 || !res.data) {
      return { offers: [], status: res.status, error: res.error ?? `http ${res.status}` }
    }
    // A board with nothing open answers `{"offers":[]}` — an empty ARRAY, and
    // that is a healthy empty board. A 200 whose body has no `offers` array at
    // all is a different animal: a schema change, or a page that is not the API
    // at all. Returning [] with no note there would report a live board as
    // permanently empty and never say why (principle 11).
    if (!Array.isArray(res.data.offers)) {
      return {
        offers: [],
        status: 200,
        note: `Recruitee returned a 200 body with no offers array for "${tenant}" — the response shape may have changed`,
      }
    }
    return { offers: res.data.offers, status: 200 }
  }
  const key = cacheKey('recruitee-offers', { tenant: tenant.toLowerCase(), day: utcDayKey() })
  return cached(key, run, opts.bypassCache ?? listCacheBypassFromEnv(), (r) => !r.error)
}

async function resolveTenant(
  input: DiscoverySearchInput,
  opts: RecruiteeSourceOptions
): Promise<{ tenant: string | null; probed: number; note?: string; board?: BoardFetch }> {
  const hinted = typeof input.extra?.recruiteeTenant === 'string' ? input.extra.recruiteeTenant : null
  // A board_url is more specific than an identifier: the identifier may be a
  // slug some other ATS minted, the host never is.
  const fromBoard = input.board ? recruiteeTenantFromUrl(input.board.board_url) ?? input.board.identifier : null
  const explicit = hinted ?? fromBoard
  if (explicit) return { tenant: String(explicit).trim().toLowerCase(), probed: 0 }

  const fromUrl = recruiteeTenantFromUrl(input.company?.careersUrl)
  if (fromUrl) return { tenant: fromUrl, probed: 0 }

  if (!input.company?.name) return { tenant: null, probed: 0, note: 'Recruitee needs a board or a company; neither was given' }

  // Guessing costs requests, so it is bounded hard. Each miss is a cheap 404.
  // The board that WINS the guess is handed back with the slug: fetching it a
  // second time in `search` is a cache hit in production but a real duplicate
  // request whenever the cache is bypassed, and it inflated `requests` either way.
  const max = Math.max(0, opts.maxSlugProbes ?? 3)
  const candidates = slugCandidates(input.company.name, input.company.domain ?? null, max)
  let probed = 0
  for (const slug of candidates.slice(0, max)) {
    probed++
    const board = await fetchBoard(slug, opts)
    if (board.status === 200 && board.offers.length > 0) return { tenant: slug, probed, board }
  }
  return { tenant: null, probed, note: `no Recruitee board found for ${input.company.name}` }
}

function matchesInput(posting: RawJobPosting, input: DiscoverySearchInput): boolean {
  if (input.internshipsOnly && !internshipLike(posting.title, posting.employment_type_hint)) return false
  if (input.location) {
    const want = input.location.toLowerCase()
    if (!(posting.location_raw ?? '').toLowerCase().includes(want)) return false
  }
  if (input.since) {
    const cutoff = Date.parse(input.since)
    const stamp = Date.parse(posting.updated_at ?? posting.posted_at ?? '')
    if (Number.isFinite(cutoff) && Number.isFinite(stamp) && stamp < cutoff) return false
  }
  const terms = [...(input.titleTerms ?? []), ...(input.query ? [input.query] : [])].map((t) => t.trim()).filter(Boolean)
  if (terms.length > 0) {
    const hay = `${posting.title} ${posting.department ?? ''} ${posting.description_text ?? ''}`.toLowerCase()
    if (!terms.some((t) => hay.includes(t.toLowerCase()))) return false
  }
  return true
}

export function recruiteeSource(opts: RecruiteeSourceOptions = {}): JobDiscoverySource {
  return {
    id: 'recruitee',
    name: 'Recruitee',
    sourceType: 'ats',
    capabilities: {
      // The whole board arrives in one call; there is no second page to ask for.
      paginates: false,
      supportsQuery: true,
      supportsLocation: true,
      supportsSince: true,
      // The reason this source is worth building: no per-posting fetch.
      givesDescription: true,
      givesCanonicalUrl: true,
    },
    costModel: { kind: 'free' },
    isConfigured: () => process.env.CAREER_DISABLE_RECRUITEE !== '1',
    async healthCheck(): Promise<DiscoveryHealth> {
      // The reference tenant from docs/ATS_ENDPOINTS.md, probed live.
      const board = await fetchBoard('vandebron', opts)
      if (board.error) return { ok: false, detail: `Recruitee unreachable: ${board.error}` }
      return { ok: board.status === 200, detail: `Recruitee reachable — vandebron returned ${board.offers.length} offers` }
    },
    async search(input: DiscoverySearchInput, cursor?: string | null): Promise<DiscoverySearchResult> {
      if (cursor) {
        return { postings: [], nextCursor: null, exhausted: true, seen: 0, note: 'Recruitee lists a board in one call; no page after the first' }
      }
      const resolved = await resolveTenant(input, opts)
      if (!resolved.tenant) {
        return { postings: [], nextCursor: null, exhausted: true, seen: 0, note: resolved.note, requests: resolved.probed }
      }
      // Reuse the board the slug guess already paid for; only fetch when the
      // tenant came from a board, a hint or a URL and nothing has been read yet.
      const board = resolved.board ?? (await fetchBoard(resolved.tenant, opts))
      const requests = resolved.board ? resolved.probed : resolved.probed + 1
      if (board.error) {
        return { postings: [], nextCursor: null, exhausted: true, seen: 0, error: board.error, requests }
      }
      if (board.status === 404) {
        return { postings: [], nextCursor: null, exhausted: true, seen: 0, note: board.note ?? `no Recruitee board "${resolved.tenant}"`, requests }
      }
      const now = new Date().toISOString()
      const all = board.offers
        .filter(isPublished)
        .map((o) => normalizeRecruiteeOffer(o, resolved.tenant as string, now))
        .filter((p): p is RawJobPosting => p !== null)
      const kept = all.filter((p) => matchesInput(p, input))
      const limited = input.limit && input.limit > 0 ? kept.slice(0, input.limit) : kept
      return {
        postings: limited,
        nextCursor: null,
        exhausted: true,
        // `seen` is what the board held, before this call filtered anything.
        seen: board.offers.length,
        requests,
        costUsd: 0,
        ...(board.note ? { note: board.note } : {}),
      }
    },
  }
}
