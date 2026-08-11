// Content-addressed disk cache for provider responses.
//
// Provider calls cost credits. During eval iteration the same searches run many
// times while only scoring/filtering logic changes, so caching keeps repeated
// runs free and makes iterations reproducible — the same inputs yield the same
// candidate set, which is what lets us attribute a metric change to a code
// change rather than to Apollo returning different rows.
//
// Cache lives on disk (gitignored), not in memory: eval runs are separate
// processes.

import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

const CACHE_ROOT = process.env.PROVIDER_CACHE_DIR || path.join(process.cwd(), '.provider-cache')

export interface CacheStats {
  hits: number
  misses: number
  writes: number
}

const stats: CacheStats = { hits: 0, misses: 0, writes: 0 }

export function cacheStats(): CacheStats {
  return { ...stats }
}

export function resetCacheStats(): void {
  stats.hits = 0
  stats.misses = 0
  stats.writes = 0
}

/**
 * Deterministic serialization: object keys sorted at every depth so two
 * equivalent payloads always produce the same string.
 *
 * Do NOT use `JSON.stringify(value, sortedKeys)` for this — the array form of
 * the second argument is a property ALLOWLIST applied recursively, which
 * silently strips every nested field and collapses distinct payloads onto one
 * key. That bug made all nine people-search queries share a cache entry.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

/** Stable key from a namespace + arbitrary request payload. */
export function cacheKey(namespace: string, payload: unknown): string {
  const hash = crypto.createHash('sha256').update(stableStringify(payload)).digest('hex').slice(0, 32)
  return `${namespace}__${hash}`
}

function pathFor(key: string): string {
  const [ns] = key.split('__')
  return path.join(CACHE_ROOT, ns, `${key}.json`)
}

export function cacheGet<T>(key: string): T | null {
  const file = pathFor(key)
  try {
    if (!fs.existsSync(file)) {
      stats.misses++
      return null
    }
    const raw = fs.readFileSync(file, 'utf8')
    stats.hits++
    return JSON.parse(raw) as T
  } catch {
    stats.misses++
    return null
  }
}

export function cacheSet<T>(key: string, value: T): void {
  const file = pathFor(key)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(value), 'utf8')
    stats.writes++
  } catch {
    // A cache write failure must never break a run — it only costs credits.
  }
}

/** Read-through cache wrapper. `bypass` forces a fresh fetch. */
export async function cached<T>(
  key: string,
  fetcher: () => Promise<T>,
  bypass = false
): Promise<T> {
  if (!bypass) {
    const hit = cacheGet<T>(key)
    if (hit !== null) return hit
  }
  const value = await fetcher()
  cacheSet(key, value)
  return value
}
