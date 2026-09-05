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
//
// EVERY REQUEST IS BOUNDED. Node's fetch has no timeout of its own worth the
// name (undici waits 300 s for headers — exactly one hosted invocation), and a
// single hung Apollo call used to hold the serialising throttle chain, so every
// later Apollo request in the process queued behind it. Each request now
// carries an AbortController whose fuse is the smaller of the provider ceiling
// and what the run has left before its finalisation reserve; the abort covers
// the body read as well as the connection; and a retry is refused when the
// clock has no room for it. Diagnostics carry the endpoint, status, attempt and
// latency — never the key.

import { cached, cacheGet, cacheKey } from '../cache'
import { currentRunClock, runUsageSlot } from '@/lib/runs/context'
import { sleepWithin } from '@/lib/runs/deadline'
import type { ScoutErrorCode } from '@/lib/runs/errors'
import { scoutLog } from '@/lib/runs/log'

const BASE = 'https://api.apollo.io/api/v1'

/** How long ONE Apollo request may take, at most. Apollo answers in well under this or not at all. */
export const APOLLO_REQUEST_TIMEOUT_MS = Number(process.env.APOLLO_TIMEOUT_MS ?? 20_000)
/** Below this much run time left, a request is not started. */
export const APOLLO_MIN_ATTEMPT_MS = 3_000
const MAX_ATTEMPTS = 3

export interface ApolloCallStats {
  calls: number
  cachedCalls: number
  byEndpoint: Record<string, number>
  /** Enrichment consumes Apollo credits; search generally does not. */
  enrichmentCredits: number
  errors: number
  /** Attempts that timed out or were aborted by the run's clock. */
  timeouts: number
  retries: number
}

function emptyStats(): ApolloCallStats {
  return { calls: 0, cachedCalls: 0, byEndpoint: {}, enrichmentCredits: 0, errors: 0, timeouts: 0, retries: 0 }
}

/**
 * Stats are PER RUN inside a run context and process-wide otherwise — the same
 * rule as the Anthropic client, for the same reason: on a warm instance the
 * process-wide counter would keep climbing across every request until it hit
 * the call budget for a run that had made no calls at all.
 */
let processStats = emptyStats()
let processCacheOnlySkips = 0

function currentStats(): ApolloCallStats {
  return runUsageSlot<ApolloCallStats>('apollo', emptyStats) ?? processStats
}

export function apolloStats(): ApolloCallStats {
  const s = currentStats()
  return { ...s, byEndpoint: { ...s.byEndpoint } }
}

export function resetApolloStats(): void {
  const slot = runUsageSlot<ApolloCallStats>('apollo', emptyStats)
  if (slot) Object.assign(slot, emptyStats())
  else processStats = emptyStats()
  processCacheOnlySkips = 0
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
// Serialized with a minimum gap. Apollo rate-limits per minute AND per key, so
// the gap is process-wide on purpose: two runs on one instance share the key.
// What must never happen is one hung request holding the chain — and it cannot,
// because every request on the chain is aborted at its own fuse.

const MIN_GAP_MS = Number(process.env.APOLLO_MIN_GAP_MS ?? 220)
let lastCallAt = 0
let chain: Promise<unknown> = Promise.resolve()

async function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    const wait = Math.max(0, lastCallAt + MIN_GAP_MS - Date.now())
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
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
  /** Stable classification of `error`. */
  errorCode?: ScoutErrorCode
  /** How many attempts were made. */
  attempts?: number
}

/** Retryable: transient conditions only. 4xx other than 408/429 will never succeed. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500
}

/** The fetch used for every request. Replaceable in tests (a fetch that never resolves). */
let fetchImpl: typeof fetch = (...args) => fetch(...args)

export function __setApolloFetchForTests(f: typeof fetch | null): void {
  fetchImpl = f ?? ((...args) => fetch(...args))
}

/**
 * The timeout THIS attempt gets: the provider ceiling, or what the run has
 * left before its reserve — whichever is smaller. Zero means "do not start".
 */
export function apolloAttemptTimeoutMs(ceilingMs = APOLLO_REQUEST_TIMEOUT_MS): number {
  const clock = currentRunClock()
  return clock ? clock.attemptTimeoutMs(ceilingMs, APOLLO_MIN_ATTEMPT_MS) : ceilingMs
}

/**
 * One bounded HTTP exchange: connect, headers AND body under one fuse.
 * Never throws for a network fault — the error comes back classified.
 */
async function exchange(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<{ status: number; text: string; timedOut: boolean; networkError: string | null; latencyMs: number }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = Date.now()
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal })
    // The body read is under the same fuse: a slow-drip body is a hang too.
    const text = await res.text()
    return { status: res.status, text, timedOut: false, networkError: null, latencyMs: Date.now() - startedAt }
  } catch (e) {
    const aborted = (e instanceof Error && e.name === 'AbortError') || controller.signal.aborted
    return { status: 0, text: '', timedOut: aborted, networkError: aborted ? null : e instanceof Error ? e.message : String(e), latencyMs: Date.now() - startedAt }
  } finally {
    clearTimeout(timer)
  }
}

async function request<T>(
  endpoint: string,
  body: Record<string, unknown> | null,
  method: 'POST' | 'GET' = 'POST',
  maxAttempts = MAX_ATTEMPTS
): Promise<ApolloResponse<T>> {
  const stats = currentStats()
  if (stats.calls >= callBudget) throw new ApolloBudgetExceeded(callBudget)

  stats.calls++
  stats.byEndpoint[endpoint] = (stats.byEndpoint[endpoint] ?? 0) + 1

  const url = `${BASE}/${endpoint}`
  const fail = (status: number, code: ScoutErrorCode, message: string, attempts: number): ApolloResponse<T> => {
    stats.errors++
    scoutLog({ event: 'provider_failed', provider: 'apollo', operation: endpoint, attempt: attempts, http_status: status || null, error_code: code, error: message.slice(0, 200) }, 'warn')
    return { ok: false, status, data: null, error: message, errorCode: code, attempts }
  }

  let lastError = ''
  let lastCode: ScoutErrorCode = 'PROVIDER_ERROR'
  let lastStatus = 0

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const clock = currentRunClock()
    if (attempt > 1) {
      stats.retries++
      // Exponential backoff with jitter, so a burst of 429s doesn't resynchronize.
      const base = Math.min(8000, 500 * Math.pow(2, attempt - 1))
      const slept = await sleepWithin(clock, Math.round(base * (0.5 + Math.random() * 0.5)), APOLLO_MIN_ATTEMPT_MS)
      if (!slept) return fail(lastStatus, 'RUN_DEADLINE', `Apollo: run deadline passed before retry ${attempt} — ${lastError.slice(0, 160)}`, attempt - 1)
    }

    const timeout = apolloAttemptTimeoutMs()
    if (timeout === 0) {
      return fail(lastStatus, 'RUN_DEADLINE', `Apollo: not started — ${Math.round((clock?.remainingForWorkMs() ?? 0) / 1000)}s left in the run is not enough for ${endpoint}` + (lastError ? ` (previous: ${lastError.slice(0, 120)})` : ''), attempt - 1)
    }

    const x = await throttled(() =>
      exchange(
        url,
        {
          method,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache',
            'X-Api-Key': apiKey(),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
        timeout
      )
    )

    if (x.timedOut) {
      stats.timeouts++
      lastError = `Apollo ${endpoint} timed out after ${Math.round(timeout / 1000)}s`
      lastCode = 'PROVIDER_TIMEOUT'
      lastStatus = 0
      scoutLog({ event: attempt < maxAttempts ? 'provider_retry' : 'provider_error', provider: 'apollo', operation: endpoint, attempt, latency_ms: x.latencyMs, timeout_ms: timeout, error_code: lastCode, error: lastError }, 'warn')
      // A timeout that consumed the run's window is the run's deadline, not Apollo's fault.
      if (clock && clock.inReserve()) return fail(0, 'RUN_DEADLINE', `${lastError} (the run's clock ran out)`, attempt)
      continue
    }
    if (x.networkError) {
      lastError = `Apollo ${endpoint}: ${x.networkError}`
      lastCode = 'PROVIDER_TIMEOUT'
      lastStatus = 0
      scoutLog({ event: attempt < maxAttempts ? 'provider_retry' : 'provider_error', provider: 'apollo', operation: endpoint, attempt, latency_ms: x.latencyMs, error_code: lastCode, error: lastError.slice(0, 200) }, 'warn')
      continue
    }

    if (x.status < 200 || x.status >= 300) {
      lastError = `Apollo ${x.status}: ${x.text.slice(0, 200)}`
      lastStatus = x.status
      lastCode = x.status === 429 ? 'PROVIDER_RATE_LIMIT' : x.status === 401 || x.status === 403 ? 'AUTHENTICATION' : x.status >= 500 ? 'PROVIDER_ERROR' : 'PROVIDER_ERROR'
      const retryable = isRetryableStatus(x.status)
      scoutLog({ event: retryable && attempt < maxAttempts ? 'provider_retry' : 'provider_error', provider: 'apollo', operation: endpoint, attempt, http_status: x.status, latency_ms: x.latencyMs, error_code: lastCode, error: lastError.slice(0, 200) }, 'warn')
      if (retryable) continue
      // Deterministic 4xx (422 "insufficient credits", 401, 403, 404): never retried.
      return fail(x.status, lastCode, lastError, attempt)
    }

    try {
      const data = JSON.parse(x.text) as T
      scoutLog({ event: 'provider_ok', provider: 'apollo', operation: endpoint, attempt, http_status: x.status, latency_ms: x.latencyMs, timeout_ms: timeout })
      return { ok: true, status: x.status, data, attempts: attempt }
    } catch {
      // Invalid JSON on a 2xx is not transient — asking again returns the same body.
      return fail(x.status, 'PROVIDER_INVALID_RESPONSE', 'Apollo returned invalid JSON', attempt)
    }
  }

  return fail(lastStatus, lastCode, lastError || 'Apollo: exhausted retries', maxAttempts)
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

export function cacheOnlySkipCount(): number {
  return processCacheOnlySkips
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
  const stats = currentStats()

  if (isCacheOnly()) {
    const hit = cacheGet<ApolloResponse<T>>(key)
    if (hit) {
      stats.cachedCalls++
      return hit
    }
    processCacheOnlySkips++
    return { ok: false, status: 0, data: null, error: 'APOLLO_CACHE_ONLY: no cached response', errorCode: 'CONFIGURATION' }
  }

  let wasCached = true
  const result = await cached<ApolloResponse<T>>(
    key,
    async () => {
      wasCached = false
      if (credits > 0) stats.enrichmentCredits += credits
      return request<T>(endpoint, body, method)
    },
    bypassCache,
    // ADR-015: never cache a failure. A cached 422 "insufficient credits" turns
    // a temporary account state into a permanent one — the same request keeps
    // failing from disk long after the credits are topped up, and nothing in the
    // logs explains why.
    (r) => r.ok
  )

  if (wasCached) stats.cachedCalls++
  return result
}
