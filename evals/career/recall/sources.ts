// The stubbed source registry the recall suite runs discovery over.
//
// No network, no key, no spend — and no fake interface either. Every stub is a
// real `JobDiscoverySource` (lib/career/sources/discovery-types.ts): it pages by
// cursor, reports `seen` before filtering, reports `exhausted`, and never
// throws. The Simplify surface is not stubbed at all — it is the PRODUCT's own
// `simplifySource()` with its cache primed from the fixture, so the suite
// measures the shipped paging, season and internship logic rather than a
// convenient copy of it.
//
// WHAT IS CONFIGURED IS THE POINT. `RECALL_CONFIGURED_PLATFORMS` mirrors the
// adapters that actually exist in lib/career/sources/registry.ts. Phenom is
// registered and reported UNCONFIGURED, because no Phenom adapter exists — and
// two of the benchmark's Merck co-ops are only visible there. That is not a
// gap in the fixture; it is the gap, made countable. When an adapter lands, its
// platform joins the list and those entries move into the recall denominator
// without any other change.
//
// AND THE MIRROR IS CHECKED, because a hand-maintained mirror of another file
// is a lie waiting for someone to edit that file. `configuredPlatformDrift()`
// reads the ids `getSourceRegistry()` actually ships and compares them to the
// constant; the eval fails on any difference, in either direction. The two
// failures it exists to stop are opposite and both silent:
//
//   an adapter disappears from the product   → the constant still claims it,
//                                              the suite still measures it,
//                                              and recall stays at 100 %
//   an adapter ships and nobody updates here → its benchmark entries stay out
//                                              of the denominator forever, so
//                                              new coverage is never scored
//
// The denominator has a floor of its own for the same reason (see
// `MIN_REACHABLE_SHARE` and the targets in scripts/career-eval-recall.ts):
// shrinking the reachable set is the one edit that makes a coverage collapse
// read as 100 % recall, so the size of the set is itself a target.

import type { AtsType, JobSourceType } from '@/lib/career/types'
import type { RawJobPosting } from '@/lib/career/sources/types'
import type {
  DiscoveryHealth,
  DiscoveryRegistry,
  DiscoverySearchInput,
  DiscoverySearchResult,
  DiscoverySourceClass,
  DiscoverySourceType,
  JobDiscoverySource,
  UnconfiguredSource,
} from '@/lib/career/sources/discovery-types'
import { sourceClassOf } from '@/lib/career/sources/discovery-types'
import { internshipLike } from '@/lib/career/sources/fetch'
import { discoveryRegistry } from '@/lib/career/sources/registry'
import { primeSimplifyCache, simplifySource, type SimplifyListing } from '@/lib/career/sources/simplify'
import { loadRecallCorpus, type FixtureBoard, type FixturePosting } from './corpus'

/** Postings one `search` call returns. Small on purpose — the paging loop is under test. */
export const RECALL_PAGE_SIZE = 20

/**
 * Platforms an adapter exists for today, mirroring `lib/career/sources/registry.ts`.
 * Adding a platform here is the ONLY edit needed when a wave-2 adapter ships —
 * and `configuredPlatformDrift()` fails the suite until that edit is made.
 */
export const RECALL_CONFIGURED_PLATFORMS = [
  'greenhouse',
  'lever',
  'ashby',
  'smartrecruiters',
  'workable',
  'workday',
] as const

/**
 * The smallest share of the benchmark a configured source may be able to reach
 * before the gated recall number stops meaning anything.
 *
 * Without this, `RECALL_CONFIGURED_PLATFORMS` is a dial that turns any coverage
 * collapse into a pass: drop 'workday' and 34 of the 44 entries leave the
 * denominator, the remaining 8 are still found, and the headline reads 100 %.
 * The reachable SET is therefore a target beside the ratio computed over it.
 */
export const MIN_REACHABLE_SHARE = 0.9

/** The corpus may not be gutted to make the reachable share easy. */
export const MIN_BENCHMARK_ENTRIES = 40

export interface PlatformDrift {
  /** ATS adapter ids the product ships, whether or not this environment enabled them. */
  shipped: string[]
  /** Shipped, but switched off here by a `CAREER_DISABLE_*` env var. Reported, not failed. */
  disabledByEnv: string[]
  /** What this file claims those are. */
  claimed: string[]
  /** Shipped by the product, absent from the constant — new coverage nothing scores. */
  missingFromEval: string[]
  /** Claimed here, gone from the product — coverage the eval still credits itself for. */
  missingFromProduct: string[]
  inSync: boolean
}

/**
 * Compare the constant against the shipped registry. Read-only and offline: it
 * reads `discoveryRegistry().all()`, which constructs the wrappers and touches
 * no network.
 *
 * It deliberately reads `.all()` rather than the enabled subset. Every adapter
 * carries a `CAREER_DISABLE_*` switch, and an operator flipping one locally is
 * not the same event as an adapter leaving the codebase — failing the suite for
 * a local switch would teach the founder to ignore this target. Disabled ids are
 * named in `disabledByEnv` instead.
 */
export function configuredPlatformDrift(claimed: readonly string[] = RECALL_CONFIGURED_PLATFORMS): PlatformDrift {
  const atsSources = discoveryRegistry()
    .all()
    .filter((s) => s.sourceType === 'ats')
  const shipped = atsSources.map((s) => s.id).sort()
  const disabledByEnv = atsSources.filter((s) => !s.isConfigured()).map((s) => s.id).sort()
  const claimedSet = new Set(claimed)
  const shippedSet = new Set(shipped)
  const missingFromEval = shipped.filter((id) => !claimedSet.has(id))
  const missingFromProduct = [...claimed].filter((id) => !shippedSet.has(id)).sort()
  return {
    shipped,
    disabledByEnv,
    claimed: [...claimed],
    missingFromEval,
    missingFromProduct,
    inSync: missingFromEval.length === 0 && missingFromProduct.length === 0,
  }
}

/** Why a platform in the corpus has no source. Printed verbatim in the report. */
export const UNADAPTED_REASONS: Record<string, string> = {
  phenom:
    'no Phenom adapter exists — docs/ATS_ENDPOINTS.md lists it under "Build second" (POST /widgets, ddoKey in the body)',
  oracle:
    'no Oracle Recruiting adapter exists — docs/ATS_ENDPOINTS.md ranks it first for this founder (limit/offset go inside the finder string)',
  taleo: 'no Taleo adapter exists — needs the tz: GMT-04:00 header, and ~50 % of tenants fail',
  icims: 'no iCIMS adapter exists — sitemap.xml plus JSON-LD, but tenant subdomains are unguessable',
}

const PLATFORM_SOURCE_TYPE: Record<string, JobSourceType> = {
  greenhouse: 'greenhouse',
  lever: 'lever',
  ashby: 'ashby',
  smartrecruiters: 'smartrecruiters',
  workable: 'workable',
  workday: 'workday',
}

const PLATFORM_ATS: Record<string, AtsType> = {
  greenhouse: 'greenhouse',
  lever: 'lever',
  ashby: 'ashby',
  smartrecruiters: 'smartrecruiters',
  workable: 'workable',
  workday: 'workday',
}

export function toRawFixturePosting(board: FixtureBoard, posting: FixturePosting, retrievedAt: string): RawJobPosting {
  const sourceType: JobSourceType = PLATFORM_SOURCE_TYPE[board.platform] ?? 'careers_page'
  const ats: AtsType | null = PLATFORM_ATS[board.platform] ?? 'other'
  return {
    source_type: sourceType,
    source_url: posting.url,
    external_id: posting.external_id,
    company_name: board.company,
    company_domain: board.company_domain,
    title: posting.title.trim(),
    location_raw: posting.location_raw,
    // The recorded listing carries no description. That is the truth of these
    // endpoints (docs/ATS_ENDPOINTS.md "the description needs a second call"),
    // and inventing one would make every downstream number optimistic.
    description_text: null,
    description_html: null,
    department: null,
    posted_at: posting.posted_at,
    updated_at: posting.posted_at,
    apply_url: posting.url,
    canonical_url: posting.url,
    ats_type: ats,
    ats_job_id: posting.external_id,
    requisition_id: null,
    employment_type_hint: null,
    raw: {
      recall_fixture: {
        platform: board.platform,
        board_key: board.board_key,
        board_url: board.board_url,
        board_total_reported: board.board_total_reported,
        posted_raw: posting.posted_raw,
      },
    },
    retrieved_at: retrievedAt,
  }
}

export interface FixtureSourceOptions {
  configured?: boolean
  unconfiguredReason?: string
}

/**
 * One platform's boards, presented as a pull feed.
 *
 * The cursor is a flat offset across every board of the platform, in fixture
 * order. Flat rather than per-board on purpose: a per-board cursor would let a
 * caller that stops early always drain board #1 completely, which is exactly
 * the shape of the bug the audit found (one employer filling the quota before
 * any other surface is tried).
 */
export function fixturePlatformSource(platform: string, boards: FixtureBoard[], retrievedAt: string, opts: FixtureSourceOptions = {}): JobDiscoverySource {
  const configured = opts.configured !== false
  const flat: { board: FixtureBoard; posting: FixturePosting }[] = []
  for (const board of boards) for (const posting of board.postings) flat.push({ board, posting })

  return {
    id: `ats:${platform}`,
    name: `${platform} boards (recorded 2026-08-31)`,
    sourceType: 'ats' as DiscoverySourceType,
    capabilities: {
      paginates: true,
      supportsQuery: false,
      supportsLocation: false,
      supportsSince: false,
      givesDescription: false,
      givesCanonicalUrl: true,
    },
    costModel: { kind: 'free' },
    isConfigured: () => configured,
    async healthCheck(): Promise<DiscoveryHealth> {
      if (!configured) return { ok: false, detail: opts.unconfiguredReason ?? 'not configured' }
      return { ok: flat.length > 0, detail: `${boards.length} boards, ${flat.length} recorded postings` }
    },
    async search(input: DiscoverySearchInput, cursor?: string | null): Promise<DiscoverySearchResult> {
      if (!configured) {
        return { postings: [], nextCursor: null, exhausted: true, seen: 0, error: opts.unconfiguredReason ?? 'not configured' }
      }
      // The shipped pre-filter, imported rather than reimplemented: every real
      // adapter runs `internshipLike` on the title when `internshipsOnly` is
      // set (lib/career/sources/fetch.ts `applyListOptions`). A private regex
      // here would have made precision a measurement of the eval's own taste.
      // It is a SOURCE-LEVEL filter, and the precision report says how many
      // labelled negatives it removed before the pipeline ever saw them.
      const matching = input.internshipsOnly === true ? flat.filter((r) => internshipLike(r.posting.title, null)) : flat
      const parsed = Number.parseInt(cursor ?? '0', 10)
      const start = Number.isFinite(parsed) && parsed > 0 ? parsed : 0
      const size = Math.max(1, Math.min(input.limit ?? RECALL_PAGE_SIZE, RECALL_PAGE_SIZE))
      const slice = matching.slice(start, start + size)
      const next = start + size
      const exhausted = next >= matching.length
      return {
        postings: slice.map((r) => toRawFixturePosting(r.board, r.posting, retrievedAt)),
        nextCursor: exhausted ? null : String(next),
        exhausted,
        // Per CALL, not per input. `recordPage` SUMS `seen` across pages, so a
        // source that reports the whole matching set on every page multiplies
        // itself: nine pages of a 167-posting board would print "1503 seen ·
        // 167 unique" and read as massive cross-source overlap that never
        // happened. (The shipped Simplify source does report the whole set,
        // which is why its row still shows seen far above unique — that is its
        // number, left visible rather than papered over here.)
        seen: slice.length,
        requests: 1,
      }
    },
  }
}

/**
 * The paid-provider slot. Registered so the coverage table names it and says
 * which env var would turn it on — "Set X to enable" beats a source that is
 * simply absent (CLAUDE.md principle 8).
 */
export function paidProviderSource(envVar: string, entriesAvailable: number): JobDiscoverySource {
  const configured = !!process.env[envVar] && entriesAvailable > 0
  return {
    id: 'paid:jobs-api',
    name: 'paid job-data provider (slot)',
    sourceType: 'search' as DiscoverySourceType,
    capabilities: {
      paginates: true,
      supportsQuery: true,
      supportsLocation: true,
      supportsSince: true,
      givesDescription: true,
      givesCanonicalUrl: false,
    },
    costModel: { kind: 'per_request', unitCostUsd: 0.01, envVar },
    isConfigured: () => configured,
    async healthCheck(): Promise<DiscoveryHealth> {
      return configured
        ? { ok: true, detail: `${entriesAvailable} recorded results` }
        : { ok: false, detail: `no provider configured — set ${envVar} and record results in paid-provider.json` }
    },
    async search(): Promise<DiscoverySearchResult> {
      return {
        postings: [],
        nextCursor: null,
        exhausted: true,
        seen: 0,
        note: configured ? 'no recorded results' : `unconfigured — set ${envVar}`,
      }
    },
  }
}

export interface RecallRegistryOptions {
  /** Platforms treated as having an adapter. Defaults to `RECALL_CONFIGURED_PLATFORMS`. */
  platforms?: readonly string[]
  /** Season the Simplify surface keeps. Null keeps every term. */
  season?: string | null
}

export interface RecallRegistry {
  registry: DiscoveryRegistry
  /** Platforms present in the corpus that no configured source can read. */
  unadaptedPlatforms: string[]
  /** Source ids that ran, in registration order. */
  configuredIds: string[]
}

export function recallRegistry(opts: RecallRegistryOptions = {}): RecallRegistry {
  const corpus = loadRecallCorpus()
  const enabled = new Set(opts.platforms ?? RECALL_CONFIGURED_PLATFORMS)
  const retrievedAt = `${corpus.boards.generated_at}T00:00:00.000Z`

  const byPlatform = new Map<string, FixtureBoard[]>()
  for (const board of corpus.boards.boards) {
    const list = byPlatform.get(board.platform) ?? []
    list.push(board)
    byPlatform.set(board.platform, list)
  }

  const sources: JobDiscoverySource[] = []
  const unadaptedPlatforms: string[] = []
  for (const [platform, boards] of byPlatform) {
    const configured = enabled.has(platform)
    if (!configured) unadaptedPlatforms.push(platform)
    sources.push(
      fixturePlatformSource(platform, boards, retrievedAt, {
        configured,
        unconfiguredReason: UNADAPTED_REASONS[platform] ?? `no ${platform} adapter exists`,
      })
    )
  }

  // The product's own feed source, over the fixture corpus.
  primeSimplifyCache(corpus.simplify as SimplifyListing[])
  sources.push(simplifySource({ season: opts.season === undefined ? 'Summer 2027' : opts.season }))
  sources.push(paidProviderSource(corpus.paid.env_var, corpus.paid.entries.length))

  const registry: DiscoveryRegistry = {
    all: () => [...sources],
    configured: () => sources.filter((s) => s.isConfigured()),
    unconfigured: (): UnconfiguredSource[] =>
      sources
        .filter((s) => !s.isConfigured())
        .map((s) => ({
          id: s.id,
          name: s.name,
          sourceType: s.sourceType,
          envVar: s.costModel.envVar ?? null,
          reason: s.costModel.envVar
            ? `set ${s.costModel.envVar} to enable`
            : UNADAPTED_REASONS[s.id.replace(/^ats:/, '')] ?? 'no adapter',
        })),
    byId: (id) => sources.find((s) => s.id === id) ?? null,
    byType: (t) => sources.filter((s) => s.sourceType === t),
    byClass: (cls: DiscoverySourceClass) => sources.filter((s) => sourceClassOf(s.sourceType) === cls),
    describe: () =>
      sources.map((s) => {
        const cls = sourceClassOf(s.sourceType)
        const state = s.isConfigured() ? 'configured' : 'UNCONFIGURED'
        return `${s.id} [${s.sourceType}/${cls}] ${state} — ${s.name}`
      }),
  }

  return { registry, unadaptedPlatforms, configuredIds: registry.configured().map((s) => s.id) }
}
