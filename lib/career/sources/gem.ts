// Gem job boards — unauthenticated, documented, and Greenhouse-shaped.
//
//   GET https://api.gem.com/job_board/v0/{slug}/job_posts/
//
// THE TRAILING SLASH IS THE DOCUMENTED FORM — keep it. It is what
// docs/ATS_ENDPOINTS.md probed and what Gem documents, and a URL builder that
// "tidies" it away is betting on undocumented behaviour. (Re-probed 2026-08-31:
// the slugs tried also answer 200 WITHOUT the slash today, so this is a
// keep-to-the-contract rule, not a reproduced failure mode. Do not rely on the
// bare form.)
//
// Probed live 2026-08-31 against `fetch`: HTTP 200, 1.6 MB, 72 posts, each with
// `content` (HTML, ~12.5 k chars) AND `content_plain` (~8.8 k). Two corrections
// to what the schema note implies:
//
//   1. The response is a BARE ARRAY, not `{ jobs: [...] }` the way Greenhouse
//      wraps its list. Anything that reaches for `.jobs` gets `undefined` and
//      reports an empty board.
//   2. `id` is a STRING ("7536752003"), not Greenhouse's number, and the posted
//      date is `first_published_at`, not Greenhouse's `first_published`.
//
// Everything else lines up, so `normalizeGreenhouseJob` does the mapping and
// this file only supplies the two renamed fields and overrides the four
// Greenhouse-specific outputs (source type, canonical URL, ats type, and the
// plain-text description, which Gem hands over directly and better).
//
// Boundaries: public, unauthenticated, robots-checked. Nothing behind an access
// control (docs/CAREER_OS.md §5).

import { cached, cacheKey } from '@/lib/providers/cache'
import type { RawJobPosting } from './types'
import type {
  DiscoveryHealth,
  DiscoverySearchInput,
  DiscoverySearchResult,
  JobDiscoverySource,
} from './discovery-types'
import { fetchJson, internshipLike, listCacheBypassFromEnv, slugCandidates, utcDayKey, type JsonFetchResult } from './fetch'
import { normalizeGreenhouseJob, type GreenhouseJob } from './greenhouse'
import { getRobotsRules, isPathAllowed } from './robots'

const API = 'https://api.gem.com/job_board/v0'

/** The trailing slash is required. Do not "tidy" it away. */
export function gemJobPostsUrl(slug: string): string {
  return `${API}/${encodeURIComponent(slug)}/job_posts/`
}

export function gemBoardUrl(slug: string): string {
  return `https://jobs.gem.com/${encodeURIComponent(slug)}`
}

/** Greenhouse's job shape with Gem's two renames and its extra fields. */
export interface GemJobPost {
  id?: string | number
  internal_job_id?: string | number
  title?: string
  content?: string | null
  content_plain?: string | null
  absolute_url?: string
  location?: { name?: string | null } | null
  location_type?: string | null
  employment_type?: string | null
  departments?: { id?: string | number; name?: string }[]
  offices?: { id?: string | number; name?: string; location?: { name?: string | null } | null }[]
  requisition_id?: string | null
  created_at?: string | null
  first_published_at?: string | null
  updated_at?: string | null
  [k: string]: unknown
}

/**
 * Bridge Gem's post onto the Greenhouse job shape, then let the existing
 * normalizer do the work. `first_published_at` → `first_published` is the whole
 * of the translation; the id survives as a string because the normalizer calls
 * `String(job.id)` either way.
 */
function asGreenhouseJob(post: GemJobPost): GreenhouseJob {
  return {
    ...(post as Record<string, unknown>),
    id: post.id as unknown as number,
    title: post.title ?? '',
    first_published: post.first_published_at ?? post.created_at ?? undefined,
    updated_at: post.updated_at ?? undefined,
  } as GreenhouseJob
}

export function normalizeGemJobPost(post: GemJobPost, slug: string, now = new Date().toISOString()): RawJobPosting | null {
  const title = (post.title ?? '').trim()
  const id = post.id === undefined || post.id === null ? '' : String(post.id)
  if (!title || !id) return null

  const base = normalizeGreenhouseJob(
    asGreenhouseJob(post),
    { ats: 'other', identifier: slug, company_name: undefined, board_url: gemBoardUrl(slug) },
    now
  )
  const canonical = (post.absolute_url ?? '').trim() || `${gemBoardUrl(slug)}/${id}`
  // Gem publishes the plain text itself. Prefer it over re-deriving it from the
  // HTML: it is the employer's own rendering, and it costs nothing.
  const plain = (post.content_plain ?? '').trim()

  return {
    ...base,
    // `JobSourceType` has no `gem` member and this workstream does not own that
    // union; the honest generic plus `raw.gem` keeps the provenance. See `open_issues`.
    source_type: 'careers_page',
    source_url: canonical,
    canonical_url: canonical,
    apply_url: canonical,
    company_name: slug,
    description_text: plain || base.description_text,
    description_html: post.content ?? null,
    location_raw: post.location?.name?.trim() || base.location_raw,
    ats_type: 'other',
    external_id: id,
    ats_job_id: id,
    employment_type_hint: (post.employment_type ?? '').trim() || base.employment_type_hint,
    raw: {
      gem: {
        slug,
        id,
        internal_job_id: post.internal_job_id ?? null,
        location_type: post.location_type ?? null,
        employment_type: post.employment_type ?? null,
        offices: post.offices ?? [],
      },
      job_post: post as Record<string, unknown>,
    },
  }
}

export function gemSlugFromUrl(url: string | null | undefined): string | null {
  try {
    const u = new URL(url ?? '')
    const host = u.hostname.toLowerCase()
    if (host === 'jobs.gem.com') return u.pathname.split('/').filter(Boolean)[0] ?? null
    if (host === 'api.gem.com') {
      const parts = u.pathname.split('/').filter(Boolean) // job_board, v0, {slug}, job_posts
      return parts[0] === 'job_board' ? parts[2] ?? null : null
    }
    return null
  } catch {
    return null
  }
}

// ─── The source ──────────────────────────────────────────────────────────────

export type GemFetcher = <T>(url: string) => Promise<JsonFetchResult<T>>

export interface GemSourceOptions {
  fetcher?: GemFetcher
  /** Tests only. Product code always honours robots.txt. */
  skipRobots?: boolean
  bypassCache?: boolean
  maxSlugProbes?: number
}

interface BoardFetch {
  posts: GemJobPost[]
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

async function fetchBoard(slug: string, opts: GemSourceOptions): Promise<BoardFetch> {
  const url = gemJobPostsUrl(slug)
  if (await robotsBlocked(url, opts.skipRobots)) return { posts: [], status: 0, error: `robots.txt disallows ${url}` }
  type GemBody = GemJobPost[] | { job_posts?: GemJobPost[]; jobs?: GemJobPost[] }
  const run = async (): Promise<BoardFetch> => {
    // `search` must never throw for ANY fetcher (discovery-types rule 1).
    let res: JsonFetchResult<GemBody>
    try {
      res = await (opts.fetcher ?? fetchJson)<GemBody>(url)
    } catch (e) {
      return { posts: [], status: 0, error: e instanceof Error ? e.message : String(e) }
    }
    if (res.status === 404) return { posts: [], status: 404, note: `no Gem board "${slug}"` }
    if (res.status !== 200 || !res.data) return { posts: [], status: res.status, error: res.error ?? `http ${res.status}` }
    // A bare array is what the API returns today. The wrapped forms are
    // tolerated so a future envelope does not read as an empty board.
    const d = res.data
    const posts = Array.isArray(d) ? d : Array.isArray(d.job_posts) ? d.job_posts : Array.isArray(d.jobs) ? d.jobs : null
    if (!posts) {
      // An empty ARRAY is a healthy board with nothing open. A 200 that is
      // neither an array nor a recognized envelope is a schema change, and
      // returning [] silently would report a live board as empty forever —
      // exactly what this file's header was written to prevent.
      return { posts: [], status: 200, note: `Gem returned a 200 body that was neither an array nor a job_posts envelope for "${slug}" — the response shape may have changed` }
    }
    return { posts, status: 200 }
  }
  const key = cacheKey('gem-job-posts', { slug: slug.toLowerCase(), day: utcDayKey() })
  return cached(key, run, opts.bypassCache ?? listCacheBypassFromEnv(), (r) => !r.error)
}

async function resolveSlug(
  input: DiscoverySearchInput,
  opts: GemSourceOptions
): Promise<{ slug: string | null; probed: number; note?: string; board?: BoardFetch }> {
  const hinted = typeof input.extra?.gemSlug === 'string' ? input.extra.gemSlug : null
  const fromBoard = input.board ? gemSlugFromUrl(input.board.board_url) ?? input.board.identifier : null
  const explicit = hinted ?? fromBoard
  if (explicit) return { slug: String(explicit).trim(), probed: 0 }

  const fromUrl = gemSlugFromUrl(input.company?.careersUrl)
  if (fromUrl) return { slug: fromUrl, probed: 0 }

  if (!input.company?.name) return { slug: null, probed: 0, note: 'Gem needs a board or a company; neither was given' }
  const max = Math.max(0, opts.maxSlugProbes ?? 3)
  let probed = 0
  // The winning board comes back with the slug so `search` does not fetch it a
  // second time — a cache hit in production, a duplicate HTTP request whenever
  // the cache is bypassed, and an inflated `requests` count either way.
  for (const slug of slugCandidates(input.company.name, input.company.domain ?? null, max).slice(0, max)) {
    probed++
    const board = await fetchBoard(slug, opts)
    if (board.status === 200 && board.posts.length > 0) return { slug, probed, board }
  }
  return { slug: null, probed, note: `no Gem board found for ${input.company.name}` }
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

export function gemSource(opts: GemSourceOptions = {}): JobDiscoverySource {
  return {
    id: 'gem',
    name: 'Gem',
    sourceType: 'ats',
    capabilities: {
      paginates: false,
      supportsQuery: true,
      supportsLocation: true,
      supportsSince: true,
      givesDescription: true,
      givesCanonicalUrl: true,
    },
    costModel: { kind: 'free' },
    isConfigured: () => process.env.CAREER_DISABLE_GEM !== '1',
    async healthCheck(): Promise<DiscoveryHealth> {
      const board = await fetchBoard('fetch', opts)
      if (board.error) return { ok: false, detail: `Gem unreachable: ${board.error}` }
      return { ok: board.status === 200, detail: `Gem reachable — fetch returned ${board.posts.length} job posts` }
    },
    async search(input: DiscoverySearchInput, cursor?: string | null): Promise<DiscoverySearchResult> {
      if (cursor) {
        return { postings: [], nextCursor: null, exhausted: true, seen: 0, note: 'Gem lists a board in one call; no page after the first' }
      }
      const resolved = await resolveSlug(input, opts)
      if (!resolved.slug) {
        return { postings: [], nextCursor: null, exhausted: true, seen: 0, note: resolved.note, requests: resolved.probed }
      }
      const board = resolved.board ?? (await fetchBoard(resolved.slug, opts))
      const requests = resolved.board ? resolved.probed : resolved.probed + 1
      if (board.error) return { postings: [], nextCursor: null, exhausted: true, seen: 0, error: board.error, requests }
      if (board.status === 404) {
        return { postings: [], nextCursor: null, exhausted: true, seen: 0, note: board.note ?? `no Gem board "${resolved.slug}"`, requests }
      }
      const now = new Date().toISOString()
      const all = board.posts
        .map((p) => normalizeGemJobPost(p, resolved.slug as string, now))
        .filter((p): p is RawJobPosting => p !== null)
      const kept = all.filter((p) => matchesInput(p, input))
      const limited = input.limit && input.limit > 0 ? kept.slice(0, input.limit) : kept
      return {
        postings: limited,
        nextCursor: null,
        exhausted: true,
        seen: board.posts.length,
        requests,
        costUsd: 0,
        ...(board.note ? { note: board.note } : {}),
      }
    },
  }
}
