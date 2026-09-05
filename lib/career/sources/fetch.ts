// The page fetcher: robots-aware, rate-limited, size-capped, cached.
//
// This is the only path by which Career OS reads an arbitrary public page, so
// the manners live here once rather than in every caller. Excluded platforms
// (LinkedIn, Indeed, Glassdoor, Handshake) are refused before any request —
// docs/CAREER_OS.md §5 treats those as manual-entry sources, not surfaces.

import { cached, cacheKey } from '@/lib/providers/cache'
import { ambientTimeoutMs } from '@/lib/runs/context'
import type { FetchedPage, PageFetcher } from './types'
import { extractLinks, extractTitle, htmlToText } from './html'
import { CAREER_BOT_USER_AGENT, getRobotsRules, isPathAllowed } from './robots'

/**
 * How long a request may take: its own ceiling, or what the ambient run has
 * left before its finalisation reserve — whichever is smaller (see
 * lib/runs/context.ts). Every network call in this file sizes itself from
 * this, so a multi-probe ATS detection that begins near the run's deadline
 * collapses into immediate refusals instead of a chain of fifteen-second waits
 * that outlives the function.
 */
export const boundedTimeoutMs = ambientTimeoutMs

export const EXCLUDED_HOSTS = ['linkedin.com', 'indeed.com', 'glassdoor.com', 'handshake.com', 'joinhandshake.com']

const DEFAULT_TIMEOUT_MS = 12_000
const DEFAULT_MAX_BYTES = 1_500_000
const MIN_GAP_PER_ORIGIN_MS = 1000
const TEXT_CAP = 40_000

export function isExcludedHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return EXCLUDED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
  } catch {
    return false
  }
}

const lastHit = new Map<string, number>()

/** Wait until at least `gapMs` has passed since the last request to this origin. */
async function throttle(origin: string, gapMs: number): Promise<void> {
  const now = Date.now()
  const prev = lastHit.get(origin) ?? 0
  const wait = prev + gapMs - now
  lastHit.set(origin, Math.max(now, prev + gapMs))
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10)
}

function failed(url: string, error: string, status = 0, robots = false): FetchedPage {
  return { url, final_url: url, status, text: '', title: null, links: [], robots_blocked: robots, error, retrieved_at: new Date().toISOString() }
}

/** Read a body up to maxBytes; abort the request beyond it rather than buffering a 40MB PDF. */
async function readCapped(res: Response, maxBytes: number, controller: AbortController): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(await res.arrayBuffer()), truncated: false }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      total += value.length
      if (total > maxBytes) {
        truncated = true
        controller.abort()
        break
      }
    }
  }
  const out = new Uint8Array(Math.min(total, maxBytes))
  let off = 0
  for (const c of chunks) {
    const take = Math.min(c.length, out.length - off)
    if (take <= 0) break
    out.set(c.subarray(0, take), off)
    off += take
  }
  return { bytes: out, truncated }
}

export interface PageFetcherOptions {
  /** Skip the disk cache for this fetcher's requests. */
  bypassCache?: boolean
  /** Skip robots.txt (tests only — never set in product code). */
  skipRobots?: boolean
  minGapMs?: number
}

export function createPageFetcher(options: PageFetcherOptions = {}): PageFetcher {
  return {
    async fetch(url, opts = {}) {
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        return failed(url, 'invalid url')
      }
      if (!/^https?:$/.test(parsed.protocol)) return failed(url, 'unsupported protocol')
      if (isExcludedHost(url)) return failed(url, 'platform excluded by policy', 0, true)

      return cached<FetchedPage>(
        cacheKey('page', { url, day: utcDay() }),
        () => fetchOnce(parsed, opts, options),
        options.bypassCache ?? false,
        (page) => !page.error && page.status >= 200 && page.status < 300
      )
    },
  }
}

async function fetchOnce(
  parsed: URL,
  opts: { maxBytes?: number; timeoutMs?: number },
  options: PageFetcherOptions
): Promise<FetchedPage> {
  const url = parsed.toString()
  const origin = parsed.origin

  // Nothing starts inside the run's reserve — including the robots lookup and
  // the per-origin throttle wait, which can be ten seconds on their own.
  if (boundedTimeoutMs(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) === 0) return failed(url, 'run deadline: not started')

  if (!options.skipRobots) {
    const rules = await getRobotsRules(origin)
    if (!isPathAllowed(rules, parsed.pathname + parsed.search)) {
      return failed(url, 'disallowed by robots.txt', 0, true)
    }
    await throttle(origin, Math.max(options.minGapMs ?? MIN_GAP_PER_ORIGIN_MS, rules.crawlDelayMs ?? 0))
  } else {
    await throttle(origin, options.minGapMs ?? MIN_GAP_PER_ORIGIN_MS)
  }

  const timeoutMs = boundedTimeoutMs(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  if (timeoutMs === 0) return failed(url, 'run deadline: not started')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': CAREER_BOT_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5',
        'Accept-Language': 'en-US,en;q=0.8',
      },
      redirect: 'follow',
      signal: controller.signal,
    })
    const finalUrl = res.url || url
    // A redirect into an excluded platform is still a fetch of that platform.
    if (isExcludedHost(finalUrl)) {
      controller.abort()
      return failed(url, 'platform excluded by policy', 0, true)
    }
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
    const isHtml = contentType.includes('html') || contentType.includes('xml') || contentType === ''
    const isText = contentType.startsWith('text/')

    if (!isHtml && !isText) {
      // A PDF or image is not a careers page. Say so instead of decoding garbage.
      controller.abort()
      return {
        url, final_url: finalUrl, status: res.status, text: '', title: null, links: [], robots_blocked: false,
        error: res.ok ? undefined : `http ${res.status}`,
        retrieved_at: new Date().toISOString(),
      }
    }

    const { bytes, truncated } = await readCapped(res, maxBytes, controller)
    const body = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    const page: FetchedPage = {
      url,
      final_url: finalUrl,
      status: res.status,
      text: isHtml ? htmlToText(body, TEXT_CAP) : body.replace(/\s+/g, ' ').trim().slice(0, TEXT_CAP),
      title: isHtml ? extractTitle(body) : null,
      links: isHtml ? extractLinks(body, finalUrl).map((l) => l.url) : [],
      robots_blocked: false,
      retrieved_at: new Date().toISOString(),
    }
    if (!res.ok) page.error = `http ${res.status}`
    else if (truncated) page.error = undefined
    return page
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const aborted = err instanceof Error && err.name === 'AbortError'
    return failed(url, aborted ? 'timeout or size limit exceeded' : message)
  } finally {
    clearTimeout(timer)
  }
}

let defaultFetcher: PageFetcher | null = null

export function getPageFetcher(): PageFetcher {
  if (!defaultFetcher) defaultFetcher = createPageFetcher()
  return defaultFetcher
}

// ─── JSON fetching for the ATS adapters ──────────────────────────────────────

export interface JsonFetchResult<T> {
  status: number
  data: T | null
  error?: string
}

/**
 * One HTTP call returning parsed JSON. `status` is 0 on a network failure or
 * timeout so adapters can tell "the board said 404" from "we never reached it".
 */
export async function fetchJson<T>(
  url: string,
  init: { method?: 'GET' | 'POST'; body?: unknown; timeoutMs?: number } = {}
): Promise<JsonFetchResult<T>> {
  const timeoutMs = boundedTimeoutMs(init.timeoutMs ?? 15_000)
  if (timeoutMs === 0) return { status: 0, data: null, error: 'run deadline: not started' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        'User-Agent': CAREER_BOT_USER_AGENT,
        Accept: 'application/json',
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
      redirect: 'follow',
    })
    const text = await res.text()
    if (!res.ok) return { status: res.status, data: null, error: `http ${res.status}` }
    try {
      return { status: res.status, data: JSON.parse(text) as T }
    } catch {
      return { status: res.status, data: null, error: 'response was not JSON' }
    }
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    return { status: 0, data: null, error: aborted ? 'timeout' : err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
}

// ─── Shared adapter helpers ──────────────────────────────────────────────────
//
// These live here rather than in registry.ts because every adapter needs them
// and the registry imports the adapters — a helper module the registry also
// owned would be a circular import.

const INTERNSHIP_RE = /\b(intern|interns|internship|internships|co-?op|co op|summer analyst)\b/i

/** The cheap pre-filter for `internshipsOnly`: title or source hint says internship. */
export function internshipLike(title: string, hint: string | null | undefined): boolean {
  return INTERNSHIP_RE.test(title) || (!!hint && INTERNSHIP_RE.test(hint))
}

export function applyListOptions(
  postings: import('./types').RawJobPosting[],
  options: import('./types').ListPostingsOptions | undefined
): import('./types').RawJobPosting[] {
  let out = postings
  if (options?.internshipsOnly) out = out.filter((p) => internshipLike(p.title, p.employment_type_hint))
  if (options?.limit && options.limit > 0) out = out.slice(0, options.limit)
  return out
}

/**
 * Board-slug guesses from a company's name and domain, most likely first.
 * "Anduril Industries" / anduril.com → anduril, andurilindustries, anduril-industries.
 * Bounded so detectBoard never sprays requests.
 */
export function slugCandidates(companyName: string, domain?: string | null, max = 4): string[] {
  const out: string[] = []
  const push = (s: string | null | undefined) => {
    const v = (s ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '')
    if (v && v.length >= 2 && !out.includes(v)) out.push(v)
  }
  if (domain) {
    const host = domain.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]
    const parts = host.split('.')
    // "anduril.com" → anduril; "jobs.anduril.co.uk" → anduril.
    const label = parts.length >= 3 && /^(co|com|org|net)$/.test(parts[parts.length - 2]) ? parts[parts.length - 3] : parts[parts.length - 2] ?? parts[0]
    push(label)
  }
  const words = companyName
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company|the|holdings|group|technologies|labs)\b/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  push(words.join(''))
  push(words.join('-'))
  push(words[0])
  return out.slice(0, max)
}

export function utcDayKey(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Read-through cache for a board listing: per (ats, identifier, UTC day); never caches a failed listing. */
export function cachedListing(
  ats: string,
  identifier: string,
  bypass: boolean,
  fetcher: () => Promise<import('./types').ListPostingsResult>
): Promise<import('./types').ListPostingsResult> {
  return cached(cacheKey('ats-list', { ats, identifier: identifier.toLowerCase(), day: utcDayKey() }), fetcher, bypass, (r) => !r.error)
}

/** Env switch: LIST_CACHE_BYPASS=1 refetches every board. Adapters also accept it per call. */
export function listCacheBypassFromEnv(): boolean {
  return process.env.CAREER_SOURCE_CACHE_BYPASS === '1'
}
