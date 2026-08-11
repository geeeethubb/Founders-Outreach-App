// Apollo HTTP client: auth, retry, rate limiting, caching, call accounting.
//
// Credentials come ONLY from the environment (APOLLO_API_KEY) and never leave
// the server. See docs/ARCHITECTURE.md §8.
//
// Endpoint notes discovered during the Phase 3 audit (see docs/PHASE_3_EVAL.md):
//   - mixed_people/search is DEPRECATED -> mixed_people/api_search
//   - api_search returns OBFUSCATED rows (last_name_obfuscated, has_email flags).
//     Full data requires enrichment via people/bulk_match, which costs credits.
//   - mixed_companies/search returns sparse orgs (id/name/domain only);
//     employee count, industry and location require organizations/enrich.

import { cached, cacheGet, cacheKey } from '../cache'

const BASE = 'https://api.apollo.io/api/v1'

export interface ApolloCallStats {
  calls: number
  cachedCalls: number
  byEndpoint: Record<string, number>
  /** Enrichment consumes Apollo credits; search generally does not. */
  enrichmentCredits: number
  errors: number
}

const stats: ApolloCallStats = {
  calls: 0,
  cachedCalls: 0,
  byEndpoint: {},
  enrichmentCredits: 0,
  errors: 0,
}

export function apolloStats(): ApolloCallStats {
  return { ...stats, byEndpoint: { ...stats.byEndpoint } }
}

export function resetApolloStats(): void {
  stats.calls = 0
  stats.cachedCalls = 0
  stats.byEndpoint = {}
  stats.enrichmentCredits = 0
  stats.errors = 0
  cacheOnlySkips = 0
}

// ─── Run budget ──────────────────────────────────────────────────────────────
// A hard ceiling so a bug can never produce an uncontrolled API loop.

let callBudget = Number(process.env.APOLLO_MAX_CALLS_PER_RUN ?? 400)

export function setApolloBudget(n: number): void {
  callBudget = n
}

export class ApolloBudgetExceeded extends Error {
  constructor(limit: number) {
    super(`Apollo call budget exceeded (${limit} live calls). Raise APOLLO_MAX_CALLS_PER_RUN or use the cache.`)
    this.name = 'ApolloBudgetExceeded'
  }
}

// ─── Rate limiting ───────────────────────────────────────────────────────────
// Serialized with a minimum gap. Apollo rate-limits per minute; sequential
// calls with a small delay stay well clear and keep failures interpretable.

const MIN_GAP_MS = Number(process.env.APOLLO_MIN_GAP_MS ?? 220)
let lastCallAt = 0
let chain: Promise<unknown> = Promise.resolve()

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    const wait = Math.max(0, lastCallAt + MIN_GAP_MS - Date.now())
    if (wait > 0) await sleep(wait)
    lastCallAt = Date.now()
    return fn()
  }
  const next = chain.then(run, run)
  chain = next.catch(() => undefined)
  return next
}

// ─── Core request ────────────────────────────────────────────────────────────

export function apolloAvailable(): boolean {
  return Boolean(process.env.APOLLO_API_KEY)
}

function apiKey(): string {
  const key = process.env.APOLLO_API_KEY
  if (!key) throw new Error('APOLLO_API_KEY is not set')
  return key
}

export interface ApolloResponse<T> {
  ok: boolean
  status: number
  data: T | null
  error?: string
}

/** Retryable: transient conditions only. 4xx other than 429 will never succeed. */
function isRetryable(status: number): boolean {
  return status === 429 || status === 408 || status >= 500
}

async function request<T>(
  endpoint: string,
  body: Record<string, unknown> | null,
  method: 'POST' | 'GET' = 'POST',
  maxAttempts = 3
): Promise<ApolloResponse<T>> {
  if (stats.calls >= callBudget) throw new ApolloBudgetExceeded(callBudget)

  stats.calls++
  stats.byEndpoint[endpoint] = (stats.byEndpoint[endpoint] ?? 0) + 1

  let lastError = ''
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      // Exponential backoff with jitter, so a burst of 429s doesn't resynchronize.
      const base = Math.min(8000, 500 * Math.pow(2, attempt))
      await sleep(Math.round(base * (0.5 + Math.random() * 0.5)))
    }

    try {
      const res = await throttled(() =>
        fetch(`${BASE}/${endpoint}`, {
          method,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache',
            'X-Api-Key': apiKey(),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        })
      )

      const text = await res.text()

      if (!res.ok) {
        lastError = `Apollo ${res.status}: ${text.slice(0, 200)}`
        if (isRetryable(res.status)) continue
        stats.errors++
        return { ok: false, status: res.status, data: null, error: lastError }
      }

      try {
        return { ok: true, status: res.status, data: JSON.parse(text) as T }
      } catch {
        lastError = 'Apollo returned invalid JSON'
        stats.errors++
        return { ok: false, status: res.status, data: null, error: lastError }
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : 'Network error'
      // Network faults are transient by nature — keep retrying.
    }
  }

  stats.errors++
  return { ok: false, status: 0, data: null, error: lastError }
}

// ─── Cache-only mode ─────────────────────────────────────────────────────────
// APOLLO_CACHE_ONLY=true serves exclusively from the disk cache and never makes
// a live call. This exists because Apollo lead credits are a hard, exhaustible
// resource: once spent, eval iteration would stop entirely. Replaying a frozen
// candidate pool also makes iterations properly comparable — a metric change is
// attributable to a code change rather than to Apollo returning different rows.

export function isCacheOnly(): boolean {
  return process.env.APOLLO_CACHE_ONLY === 'true'
}

/** Live calls skipped because of cache-only mode — reported in diagnostics. */
let cacheOnlySkips = 0

export function cacheOnlySkipCount(): number {
  return cacheOnlySkips
}

/**
 * Cached request. `namespace` scopes the cache key so a params change in one
 * endpoint never collides with another.
 */
export async function apolloRequest<T>(
  endpoint: string,
  body: Record<string, unknown> | null,
  opts: { method?: 'POST' | 'GET'; namespace?: string; bypassCache?: boolean; credits?: number } = {}
): Promise<ApolloResponse<T>> {
  const { method = 'POST', namespace = endpoint.replace(/\W+/g, '_'), bypassCache = false, credits = 0 } = opts
  const key = cacheKey(namespace, { endpoint, body, method })

  if (isCacheOnly()) {
    const hit = cacheGet<ApolloResponse<T>>(key)
    if (hit) {
      stats.cachedCalls++
      return hit
    }
    cacheOnlySkips++
    return { ok: false, status: 0, data: null, error: 'APOLLO_CACHE_ONLY: no cached response' }
  }

  let wasCached = true
  const result = await cached<ApolloResponse<T>>(
    key,
    async () => {
      wasCached = false
      if (credits > 0) stats.enrichmentCredits += credits
      return request<T>(endpoint, body, method)
    },
    bypassCache
  )

  if (wasCached) stats.cachedCalls++
  return result
}
