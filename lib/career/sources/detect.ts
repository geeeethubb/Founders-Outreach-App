// ATS detection for one company: URL → slug guesses → careers-page scan →
// Workday tenant probe.
//
// Cheapest signal first. A known careers URL costs nothing; slug probing costs
// a few JSON requests per adapter; the page scan costs real page fetches; the
// Workday tenant probe costs a robots.txt read per pod and therefore runs LAST
// and only when a careers page has actually said "Workday". Probing five pods
// for every company on a 188-company watchlist would be both slow and rude.
//
// Results are cached because a company changes its ATS about once a decade.
// The negative result is the expensive one to recompute and the dangerous one
// to keep: a company that adopts a board next month must become discoverable,
// so "no board" carries a timestamp and expires on its own schedule, well
// inside the window that holds a found board.

import { cached, cacheKey } from '@/lib/providers/cache'
import type { AtsBoardRef, PageFetcher, SourceRegistry } from './types'
import { getSourceRegistry, matchAnyAtsUrl, toBoardRef } from './registry'
import { atsFamilyHints, scanCareersPage } from './careers'
import { getPageFetcher } from './fetch'
import { probeWorkdayTenant } from './workday'

// Kept to exactly these four because lib/career/scout/company-first.ts mirrors
// the union as a literal type. A Workday tenant probe reports 'careers_scan' —
// the careers page is what identified the vendor — and sets `tenant_probed`.
export type DetectMethod = 'url' | 'slug' | 'careers_scan' | 'none'

/** A found board is re-checked about monthly; the cache key rotates on this. */
export const DETECT_TTL_MS = 28 * 24 * 3600 * 1000
/** A "no board found" is retried this often, so a new board is discoverable within a week. */
export const NEGATIVE_TTL_MS = 7 * 24 * 3600 * 1000

export interface AtsDetection {
  board: AtsBoardRef | null
  careers_url: string | null
  method: DetectMethod
  /** What was tried, in order, for "why did it not find X?". */
  attempts: string[]
  hints: string[]
  /** ATS families the careers page mentioned, even ones we could not resolve. */
  families: string[]
  /** False when a 'none' came from a blocked/unreachable scan rather than a real absence. */
  cacheable: boolean
  /** True when the board came from probing Workday pods after a page hint. */
  tenant_probed: boolean
  /** When this detection was computed. Drives negative expiry. */
  detected_at: string
}

export interface DetectAtsInput {
  companyName: string
  domain?: string | null
  careersUrl?: string | null
}

export interface DetectAtsDeps {
  registry?: SourceRegistry
  fetcher?: PageFetcher
  bypassCache?: boolean
  /** Skip slug probing (the scout may already know the board is not on an adapted ATS). */
  skipSlugProbe?: boolean
  /** Skip the Workday tenant probe even when the page hints at one. */
  skipTenantProbe?: boolean
  now?: () => number
}

function ttlBucket(now: number): string {
  return String(Math.floor(now / DETECT_TTL_MS))
}

/** A cached 'none' older than NEGATIVE_TTL_MS must be recomputed. */
export function negativeExpired(detection: AtsDetection, now = Date.now()): boolean {
  if (detection.method !== 'none') return false
  const at = Date.parse(detection.detected_at ?? '')
  if (!Number.isFinite(at)) return true
  return now - at >= NEGATIVE_TTL_MS
}

export async function detectAtsForCompany(input: DetectAtsInput, deps: DetectAtsDeps = {}): Promise<AtsDetection> {
  const registry = deps.registry ?? getSourceRegistry()
  const fetcher = deps.fetcher ?? getPageFetcher()
  const now = deps.now ?? Date.now
  const key = cacheKey('ats-detect', {
    name: input.companyName.trim().toLowerCase(),
    domain: (input.domain ?? '').toLowerCase(),
    careers: input.careersUrl ?? '',
    ttl: ttlBucket(now()),
  })
  const run = () => detectUncached(input, registry, fetcher, deps, now)
  // A found board is stable. A genuine "none" is cached too — re-probing five
  // ATSes every run for a company on Workday is the waste this exists to stop.
  // A "none" because the scan was blocked or never reached a page is a failure,
  // and a failure is never cached.
  const shouldCache = (r: AtsDetection) => r.method !== 'none' || r.cacheable

  const hit = await cached<AtsDetection>(key, run, deps.bypassCache ?? false, shouldCache)
  if (!deps.bypassCache && negativeExpired(hit, now())) {
    return cached<AtsDetection>(key, run, true, shouldCache)
  }
  return hit
}

async function detectUncached(
  input: DetectAtsInput,
  registry: SourceRegistry,
  fetcher: PageFetcher,
  deps: DetectAtsDeps,
  now: () => number
): Promise<AtsDetection> {
  const attempts: string[] = []
  const at = () => new Date(now()).toISOString()

  if (input.careersUrl) {
    const m = matchAnyAtsUrl(input.careersUrl)
    attempts.push(`url: ${input.careersUrl} → ${m ? `${m.family}/${m.identifier}` : 'not an ATS url'}`)
    if (m) {
      let board = toBoardRef(m, input.companyName)
      // A Workday deep link names a site that may be private or stale; the
      // tenant's own robots.txt names the sites it publishes. One cached read.
      if (m.ats === 'workday') {
        const adapter = registry.byId('workday')
        const fixed = await adapter?.detectBoard({ companyName: input.companyName, domain: input.domain, careersUrl: input.careersUrl })
        if (fixed) {
          if (fixed.identifier !== board.identifier) attempts.push(`workday site from robots.txt: ${board.identifier} → ${fixed.identifier}`)
          board = fixed
        }
      }
      return { board, careers_url: board.board_url ?? input.careersUrl, method: 'url', attempts, hints: [], families: [m.family], cacheable: true, tenant_probed: false, detected_at: at() }
    }
  }

  if (!deps.skipSlugProbe) {
    for (const adapter of registry.adapters()) {
      const board = await adapter.detectBoard({ companyName: input.companyName, domain: input.domain, careersUrl: input.careersUrl })
      attempts.push(`slug probe ${adapter.id}: ${board ? `found ${board.identifier}` : 'no board'}`)
      if (board) {
        return {
          board: { ...board, company_name: board.company_name ?? input.companyName },
          careers_url: board.board_url ?? input.careersUrl ?? null,
          method: 'slug', attempts, hints: [], families: [adapter.id], cacheable: true, tenant_probed: false, detected_at: at(),
        }
      }
    }
  }

  const scan = await scanCareersPage({ companyName: input.companyName, domain: input.domain, careersUrl: input.careersUrl }, fetcher)
  attempts.push(`careers scan: ${scan.error ?? `${scan.careers_url} (${scan.boards.length} boards, ${scan.posting_links.length} posting links)`}`)
  const families = atsFamilyHints(scan.fetched)
  if (families.length) attempts.push(`page mentions: ${families.join(', ')}`)
  const board = scan.boards[0] ?? null
  if (board) {
    return { board, careers_url: scan.careers_url ?? input.careersUrl ?? null, method: 'careers_scan', attempts, hints: scan.hints, families, cacheable: true, tenant_probed: false, detected_at: at() }
  }

  // Last resort, and only on evidence: the careers page named Workday but did
  // not hand us a usable tenant URL (a JS-rendered link, or plain prose).
  if (!deps.skipTenantProbe && families.includes('workday')) {
    const probed = await probeWorkdayTenant({ companyName: input.companyName, domain: input.domain })
    attempts.push(`workday tenant probe: ${probed ? `found ${probed.board.identifier} (sites: ${probed.sites.join(', ')})` : 'no tenant on wd1–wd12'}`)
    if (probed) {
      return { board: probed.board, careers_url: probed.board.board_url ?? scan.careers_url ?? null, method: 'careers_scan', attempts, hints: scan.hints, families, cacheable: true, tenant_probed: true, detected_at: at() }
    }
  }

  return {
    board: null,
    careers_url: scan.careers_url ?? input.careersUrl ?? null,
    method: 'none',
    attempts,
    hints: scan.hints,
    families,
    cacheable: !!scan.fetched && !scan.error ? true : /^no careers page found/.test(scan.error ?? ''),
    tenant_probed: !deps.skipTenantProbe && families.includes('workday'),
    detected_at: at(),
  }
}
