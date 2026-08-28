// ATS detection for one company: URL → slug guesses → careers-page scan.
//
// Cheapest signal first. A known careers URL costs nothing; slug probing costs
// a few JSON requests per adapter; the page scan costs real page fetches.
// Results are cached for a week because a company changes its ATS about once
// a decade and the negative result ("no board found") is the expensive one.

import { cached, cacheKey } from '@/lib/providers/cache'
import type { AtsBoardRef, PageFetcher, SourceRegistry } from './types'
import { getSourceRegistry, matchAnyAtsUrl, toBoardRef } from './registry'
import { scanCareersPage } from './careers'
import { getPageFetcher } from './fetch'

export type DetectMethod = 'url' | 'slug' | 'careers_scan' | 'none'

export interface AtsDetection {
  board: AtsBoardRef | null
  careers_url: string | null
  method: DetectMethod
  /** What was tried, in order, for "why did it not find X?". */
  attempts: string[]
  hints: string[]
  /** False when a 'none' came from a blocked/unreachable scan rather than a real absence. */
  cacheable: boolean
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
}

function weekBucket(now = new Date()): string {
  const ms = now.getTime()
  return String(Math.floor(ms / (7 * 24 * 3600 * 1000)))
}

export async function detectAtsForCompany(input: DetectAtsInput, deps: DetectAtsDeps = {}): Promise<AtsDetection> {
  const registry = deps.registry ?? getSourceRegistry()
  const fetcher = deps.fetcher ?? getPageFetcher()
  const key = cacheKey('ats-detect', {
    name: input.companyName.trim().toLowerCase(),
    domain: (input.domain ?? '').toLowerCase(),
    careers: input.careersUrl ?? '',
    week: weekBucket(),
  })
  return cached<AtsDetection>(
    key,
    () => detectUncached(input, registry, fetcher, deps.skipSlugProbe ?? false),
    deps.bypassCache ?? false,
    // A found board is stable for a week. A genuine "none" is cached too —
    // re-probing five ATSes every run for a company on Workday is the waste
    // this exists to stop. A "none" because the scan was blocked or never
    // reached a page is a failure, and a failure is never cached.
    (r) => r.method !== 'none' || r.cacheable
  )
}

async function detectUncached(input: DetectAtsInput, registry: SourceRegistry, fetcher: PageFetcher, skipSlugProbe: boolean): Promise<AtsDetection> {
  const attempts: string[] = []

  if (input.careersUrl) {
    const m = matchAnyAtsUrl(input.careersUrl)
    attempts.push(`url: ${input.careersUrl} → ${m ? `${m.family}/${m.identifier}` : 'not an ATS url'}`)
    if (m) return { board: toBoardRef(m, input.companyName), careers_url: input.careersUrl, method: 'url', attempts, hints: [], cacheable: true }
  }

  if (!skipSlugProbe) {
    for (const adapter of registry.adapters()) {
      const board = await adapter.detectBoard({ companyName: input.companyName, domain: input.domain, careersUrl: input.careersUrl })
      attempts.push(`slug probe ${adapter.id}: ${board ? `found ${board.identifier}` : 'no board'}`)
      if (board) return { board: { ...board, company_name: board.company_name ?? input.companyName }, careers_url: board.board_url ?? input.careersUrl ?? null, method: 'slug', attempts, hints: [], cacheable: true }
    }
  }

  const scan = await scanCareersPage({ companyName: input.companyName, domain: input.domain, careersUrl: input.careersUrl }, fetcher)
  attempts.push(`careers scan: ${scan.error ?? `${scan.careers_url} (${scan.boards.length} boards, ${scan.posting_links.length} posting links)`}`)
  const board = scan.boards[0] ?? null
  return {
    board,
    careers_url: scan.careers_url ?? input.careersUrl ?? null,
    method: board ? 'careers_scan' : 'none',
    attempts,
    hints: scan.hints,
    cacheable: !!board || (!!scan.fetched && !scan.error) || /^no careers page found/.test(scan.error ?? ''),
  }
}
