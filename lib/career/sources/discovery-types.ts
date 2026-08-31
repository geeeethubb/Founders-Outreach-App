// The generalized discovery surface: `JobDiscoverySource`.
//
// `JobSourceAdapter` (./types) is an ATS: it is addressed by a BOARD, it lists
// that board, and it fetches one posting by id. That interface is correct for
// what it models and the six adapters that implement it stay exactly as they
// are.
//
// It cannot model the surfaces V2 needs. A SERP provider has no board. An
// aggregator feed has no company. A search API is paginated, costs money per
// request, and answers a QUERY. Expressing those as "an ATS with a fake board"
// would leak paging, cost and credential handling into every call site.
//
// So there are two classes of surface, and one interface over both:
//
//   PULL FEEDS    enumerate cheaply and exhaustively — ATS boards, public
//                 feeds, curated lists. Ask for everything; stop when the
//                 source says `exhausted`.
//   SEARCH SOURCES are queried with terms and pay per request — SERP, job
//                 APIs, the model's own web search. Ask a question; page
//                 until the marginal yield stops paying.
//
// The orchestrator must not care which produced a posting. It asks a source to
// `search(input, cursor)` and gets back postings, a cursor, and — this is the
// part that makes coverage measurable — `seen`, `exhausted`, and any `error`.
//
// Three rules every implementation obeys:
//   1. `search` NEVER throws. A dead endpoint, a bad key, a rate limit and a
//      timeout all come back as an `error` field, with whatever postings the
//      call managed to collect (principle 9: failures surface, they do not
//      halt — and a partial page is not thrown away to make a type tidier).
//   2. `isConfigured()` is a pure env check with no network. An unconfigured
//      source is SKIPPED and named, never fatal (principle 8).
//   3. Cost is declared, not guessed. `costModel` is what the coverage ledger
//      multiplies by request count to tell the founder what a run spent where.
//
// Types only. The wrapper and the registry live in ./registry.ts.

import type { RawJobPosting, AtsBoardRef } from './types'

export type DiscoverySourceType = 'ats' | 'feed' | 'search' | 'aggregator' | 'company'

/**
 * Which of the two classes a source belongs to. Derived from `sourceType`, so
 * a source never has to declare it twice.
 */
export type DiscoverySourceClass = 'pull' | 'search'

export const PULL_SOURCE_TYPES: DiscoverySourceType[] = ['ats', 'feed', 'company']
export const SEARCH_SOURCE_TYPES: DiscoverySourceType[] = ['search', 'aggregator']

export function sourceClassOf(sourceType: DiscoverySourceType): DiscoverySourceClass {
  return SEARCH_SOURCE_TYPES.includes(sourceType) ? 'search' : 'pull'
}

/**
 * What a source can actually do, so the query planner asks for what it will
 * get. A planner that sends a location filter to a source with
 * `supportsLocation: false` has silently searched the whole country; one that
 * pages a source with `paginates: false` loops forever on page 1.
 */
export interface DiscoveryCapabilities {
  /** More than one page is reachable via `nextCursor`. */
  paginates: boolean
  /** `input.query` / `input.titleTerms` change the result set. */
  supportsQuery: boolean
  /** `input.location` / `input.remote` change the result set. */
  supportsLocation: boolean
  /** `input.since` limits results to postings updated after a date. */
  supportsSince: boolean
  /** Postings arrive with `description_text` — no separate fetch needed. */
  givesDescription: boolean
  /** Postings arrive with a first-party `canonical_url`, not just a redirect. */
  givesCanonicalUrl: boolean
}

export type DiscoveryCostKind = 'free' | 'per_request' | 'per_credit'

/**
 * `envVar` is the credential this source needs. It is on the cost model rather
 * than the source because it is the same fact: a source that costs money has a
 * key, and the registry reports exactly that string when the key is absent —
 * "Set SERPAPI_KEY to enable" beats "source unavailable".
 */
export interface DiscoveryCostModel {
  kind: DiscoveryCostKind
  /** Dollars per request (per_request) or per credit consumed (per_credit). */
  unitCostUsd?: number
  /** The env var that configures this source. Free sources have none. */
  envVar?: string
  /** Credits a single `search` call consumes, when that is not 1. */
  creditsPerRequest?: number
}

/** What the orchestrator asks for. Every field is optional; sources ignore what they cannot honour. */
export interface DiscoverySearchInput {
  /** Free-text query for search sources. Pull feeds ignore it. */
  query?: string | null
  /** Title terms to match, when the source filters titles rather than full text. */
  titleTerms?: string[]
  location?: string | null
  remote?: boolean
  /** ISO date. Only postings created/updated at or after this. */
  since?: string | null
  /** Soft cap on postings returned by THIS call. A source may return fewer. */
  limit?: number
  /** Keep only postings whose title/metadata suggests an internship. */
  internshipsOnly?: boolean
  /** Addresses a pull feed that is keyed by board — the ATS wrapper needs this. */
  board?: AtsBoardRef | null
  /** Addresses a company-keyed source when no board is known yet. */
  company?: { name: string; domain?: string | null; careersUrl?: string | null } | null
  /** Free-form per-source hints. Never load-bearing. */
  extra?: Record<string, unknown>
}

/**
 * `seen` is what the SOURCE returned before this call's own filtering, and it
 * is the number the coverage table prints. "217 seen · 192 unique" is only
 * meaningful because `seen` counts the source's answer and `unique` counts
 * what survived dedupe — if `seen` were already filtered, the two columns
 * would say the same thing and the run would look narrower than it was.
 */
export interface DiscoverySearchResult {
  postings: RawJobPosting[]
  /** Opaque, source-defined. Pass it back verbatim to continue. */
  nextCursor: string | null
  /** True when this source has nothing further for this input. */
  exhausted: boolean
  /** Postings the source returned, before this call filtered any. */
  seen: number
  /** Human-readable explanation of an expected outcome ("board empty"). */
  note?: string
  /**
   * Set when the call did not complete. The run continues either way.
   *
   * `postings` MAY hold a partial result — an adapter that paginated four
   * pages and lost the fifth returns the four it has alongside the error, and
   * that is the required behaviour, not a lapse (principle 9: surface the
   * failure, keep what was paid for). What an `error` forfeits is the CLAIM OF
   * COVERAGE: `coverage.ts` refuses `completed` to any source with an error,
   * so a gap is never hidden behind a checkmark.
   */
  error?: string
  /** Actual cost of this call, when the source can report it. */
  costUsd?: number
  /** Requests this call made, when it made more than one. */
  requests?: number
}

export interface DiscoveryHealth {
  ok: boolean
  detail: string
}

/**
 * One discovery surface. Pull feed or search source — the caller cannot tell,
 * and must not need to.
 */
export interface JobDiscoverySource {
  readonly id: string
  readonly name: string
  readonly sourceType: DiscoverySourceType
  readonly capabilities: DiscoveryCapabilities
  readonly costModel: DiscoveryCostModel
  /** Pure env check. No network, never throws. */
  isConfigured(): boolean
  /** May touch the network. Never throws — an unreachable source reports `ok: false`. */
  healthCheck(): Promise<DiscoveryHealth>
  /** Never throws. See rule 1 above. */
  search(input: DiscoverySearchInput, cursor?: string | null): Promise<DiscoverySearchResult>
}

/** A source the registry knows about but cannot use, and the one thing to do about it. */
export interface UnconfiguredSource {
  id: string
  name: string
  sourceType: DiscoverySourceType
  /** The env var to set. Null when the source is unavailable for another reason. */
  envVar: string | null
  reason: string
}

export interface DiscoveryRegistry {
  /** Every registered source, configured or not. */
  all(): JobDiscoverySource[]
  /** Only the sources that can actually run. */
  configured(): JobDiscoverySource[]
  /** The rest, each with the env var it needs. Never throws for a missing key. */
  unconfigured(): UnconfiguredSource[]
  byId(id: string): JobDiscoverySource | null
  byType(sourceType: DiscoverySourceType): JobDiscoverySource[]
  byClass(cls: DiscoverySourceClass): JobDiscoverySource[]
  /** One line per source, for the run report and `--sources`. */
  describe(): string[]
}

/** Cost of one call against a declared model, when the source did not report its own. */
export function estimateCallCostUsd(costModel: DiscoveryCostModel, requests = 1): number {
  if (costModel.kind === 'free') return 0
  const unit = costModel.unitCostUsd ?? 0
  const credits = costModel.kind === 'per_credit' ? costModel.creditsPerRequest ?? 1 : 1
  return unit * credits * requests
}

/** An empty, successful, exhausted result — the shape a source returns when it has nothing. */
export function emptyDiscoveryResult(note?: string): DiscoverySearchResult {
  return { postings: [], nextCursor: null, exhausted: true, seen: 0, ...(note ? { note } : {}) }
}

/** A call that produced nothing at all. Use it only when there is no partial result to keep. */
export function failedDiscoveryResult(error: string): DiscoverySearchResult {
  return { postings: [], nextCursor: null, exhausted: true, seen: 0, error }
}
