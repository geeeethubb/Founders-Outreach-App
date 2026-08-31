// Coverage: what each surface was actually asked, and what it actually gave.
//
// The audit's finding was not "the scout is slow". It was: **a $4 run finished
// and nobody could say whether it had searched anything.** `sources_consulted`
// counted postings per source type and stopped there — it could not tell a
// source that returned 200 postings of which 8 were new from a source that was
// never called, because both show up as a number or an absence.
//
// So every call against a `JobDiscoverySource` is recorded as a PAGE, and the
// ledger answers four different questions per source, which the old counter
// collapsed into one:
//
//   seen      what the source said it had          → was it asked at all?
//   unique    distinct postings from that source   → is it repeating itself?
//   newToDb   of those, rows we did not have       → is it still paying?
//   pages     calls made                            → did we stop too early?
//
// plus `exhausted` (the source has nothing left), `errors` (surfaced, never
// swallowed — principle 9) and `costUsd`.
//
// The arithmetic that matters is the overlap. Two sources that both return the
// same Greenhouse posting have `seen` 1 each and contribute ONE unique job to
// the run. Run-level `unique` is therefore always ≤ the sum of per-source
// `unique`, and the gap between them is the cross-source duplicate rate — a
// number worth reading, because it says how independent the portfolio is.
//
// Pure: no I/O, no clock, no database. The orchestrator records; this counts.

import type { RawJobPosting } from '../sources/types'
import type { DiscoverySearchResult, DiscoverySourceType, JobDiscoverySource } from '../sources/discovery-types'
import { estimateCallCostUsd } from '../sources/discovery-types'
import { companyKeyFor, normalizeTitle } from '../jobs/normalize'

/** One surface's coverage in a run. Plain JSON — this is persisted on the run row. */
export interface SourceCoverage {
  sourceId: string
  name: string
  sourceType: DiscoverySourceType
  /** Postings the source reported, before dedupe. */
  seen: number
  /** Distinct postings from THIS source. */
  unique: number
  /** Of this source's distinct postings, those not already in the database. */
  newToDb: number
  /** Calls made against this source. */
  pages: number
  /** The source said it had nothing further. */
  exhausted: boolean
  errors: string[]
  costUsd: number
  notes: string[]
  /** Asked, finished cleanly, nothing left. This is the "✓ completed" in the report. */
  completed: boolean
}

export interface CoverageTotals {
  /** Sum of every source's `seen`. */
  seen: number
  /** Distinct postings ACROSS sources — overlaps counted once. */
  unique: number
  /** Distinct postings that were new to the database. */
  newToDb: number
  pages: number
  costUsd: number
  sources: number
  sourcesAsked: number
  sourcesCompleted: number
  sourcesWithErrors: number
  /** Sum of per-source `unique` minus run-level `unique`: postings ≥2 sources both found. */
  crossSourceDuplicates: number
  errors: string[]
}

/** A posting as the ledger sees it: an identity, and whether the database already had it. */
export interface CoveragePosting {
  key: string
  newToDb?: boolean
}

/** One call against one source. */
export interface CoveragePage {
  sourceId: string
  /** Only needed the first time a source is recorded. */
  name?: string
  sourceType?: DiscoverySourceType
  /** What the source reported. Defaults to `postings.length`. */
  seen?: number
  postings: CoveragePosting[]
  exhausted?: boolean
  error?: string | null
  note?: string | null
  costUsd?: number
  /** Calls this page represents, when a source batched more than one. Default 1. */
  requests?: number
}

/**
 * The accumulator. `keys` are per-source and run-level identity sets; they are
 * `Set`s, so a ledger is NOT itself JSON — call `coverageRows`/`coverageTotals`
 * to get the persistable shape.
 */
export interface CoverageLedger {
  sources: Record<string, SourceCoverage>
  order: string[]
  /** Distinct posting keys seen anywhere in the run. */
  keys: Set<string>
  /** Distinct posting keys that were new to the database. */
  newKeys: Set<string>
  keysBySource: Record<string, Set<string>>
}

export function emptyCoverageLedger(): CoverageLedger {
  return { sources: {}, order: [], keys: new Set(), newKeys: new Set(), keysBySource: {} }
}

function ensure(ledger: CoverageLedger, sourceId: string, name?: string, sourceType?: DiscoverySourceType): SourceCoverage {
  let row = ledger.sources[sourceId]
  if (!row) {
    row = {
      sourceId,
      name: name ?? sourceId,
      sourceType: sourceType ?? 'feed',
      seen: 0,
      unique: 0,
      newToDb: 0,
      pages: 0,
      exhausted: false,
      errors: [],
      costUsd: 0,
      notes: [],
      completed: false,
    }
    ledger.sources[sourceId] = row
    ledger.order.push(sourceId)
    ledger.keysBySource[sourceId] = new Set()
  }
  if (name && row.name === sourceId) row.name = name
  if (sourceType) row.sourceType = sourceType
  return row
}

/**
 * Register a source BEFORE it is called, so a surface that was asked and
 * returned nothing is distinguishable from one that was never asked. That
 * distinction is the whole point of the table.
 */
export function noteSource(ledger: CoverageLedger, source: Pick<JobDiscoverySource, 'id' | 'name' | 'sourceType'>): SourceCoverage {
  return ensure(ledger, source.id, source.name, source.sourceType)
}

/** Record one call. Idempotent per posting key WITHIN a source, so a re-listed board does not inflate `unique`. */
export function recordPage(ledger: CoverageLedger, page: CoveragePage): SourceCoverage {
  const row = ensure(ledger, page.sourceId, page.name, page.sourceType)
  const postings = page.postings ?? []
  row.pages += Math.max(1, page.requests ?? 1)
  row.seen += Math.max(0, page.seen ?? postings.length)
  row.costUsd += page.costUsd ?? 0
  if (page.error) row.errors.push(page.error)
  if (page.note) row.notes.push(page.note)
  if (page.exhausted) row.exhausted = true

  const mine = ledger.keysBySource[page.sourceId]
  for (const p of postings) {
    const key = (p.key ?? '').trim()
    if (!key) continue
    if (!mine.has(key)) {
      mine.add(key)
      row.unique += 1
      if (p.newToDb) row.newToDb += 1
    }
    ledger.keys.add(key)
    if (p.newToDb) ledger.newKeys.add(key)
  }
  // "Completed" is a promise about coverage, so it requires a clean finish:
  // a source that errored on page 3 and then reported exhausted has NOT been
  // fully read, and saying otherwise would hide a gap behind a checkmark.
  row.completed = row.exhausted && row.errors.length === 0 && row.pages > 0
  return row
}

/** Record a `DiscoverySearchResult` directly, deriving keys from the postings. */
export function recordSearchResult(
  ledger: CoverageLedger,
  source: Pick<JobDiscoverySource, 'id' | 'name' | 'sourceType' | 'costModel'>,
  result: DiscoverySearchResult,
  opts: { isNewToDb?: (posting: RawJobPosting) => boolean } = {}
): SourceCoverage {
  const postings = (result.postings ?? []).map((p) => ({
    key: postingKey(p),
    newToDb: opts.isNewToDb ? opts.isNewToDb(p) : false,
  }))
  return recordPage(ledger, {
    sourceId: source.id,
    name: source.name,
    sourceType: source.sourceType,
    seen: result.seen,
    postings,
    exhausted: result.exhausted,
    error: result.error ?? null,
    note: result.note ?? null,
    costUsd: result.costUsd ?? estimateCallCostUsd(source.costModel, result.requests ?? 1),
    requests: result.requests ?? 1,
  })
}

/** Per-source rows in the order the sources were first registered. */
export function coverageRows(ledger: CoverageLedger): SourceCoverage[] {
  return ledger.order.map((id) => ({ ...ledger.sources[id], errors: [...ledger.sources[id].errors], notes: [...ledger.sources[id].notes] }))
}

export function coverageTotals(ledger: CoverageLedger): CoverageTotals {
  const rows = ledger.order.map((id) => ledger.sources[id])
  const sumUnique = rows.reduce((a, r) => a + r.unique, 0)
  return {
    seen: rows.reduce((a, r) => a + r.seen, 0),
    unique: ledger.keys.size,
    newToDb: ledger.newKeys.size,
    pages: rows.reduce((a, r) => a + r.pages, 0),
    costUsd: rows.reduce((a, r) => a + r.costUsd, 0),
    sources: rows.length,
    sourcesAsked: rows.filter((r) => r.pages > 0).length,
    sourcesCompleted: rows.filter((r) => r.completed).length,
    sourcesWithErrors: rows.filter((r) => r.errors.length > 0).length,
    crossSourceDuplicates: Math.max(0, sumUnique - ledger.keys.size),
    errors: rows.flatMap((r) => r.errors.map((e) => `${r.name}: ${e}`)),
  }
}

/**
 * The identity of one raw posting, for dedupe inside the ledger only.
 *
 * URL first, because two sources that hand back the same canonical URL are
 * unambiguously the same job. Company + normalized title is the fallback, and
 * it is deliberately coarse: over-merging within a single company inflates
 * nothing that matters here, while under-merging would make an aggregator that
 * republishes the same posting under three URLs look like three sources'
 * worth of coverage.
 *
 * This is NOT the pipeline's dedupe (lib/career/jobs/dedupe.ts), which
 * clusters normalized jobs with description shingles and decides what is
 * STORED. This one only has to count.
 */
export function postingKey(p: Pick<RawJobPosting, 'canonical_url' | 'apply_url' | 'source_url' | 'company_name' | 'company_domain' | 'title'>): string {
  const url = normalizeUrlKey(p.canonical_url) ?? normalizeUrlKey(p.apply_url) ?? normalizeUrlKey(p.source_url)
  if (url) return `u:${url}`
  const company = companyKeyFor(p.company_name ?? '', p.company_domain)
  return `t:${company}|${normalizeTitle(p.title ?? '').toLowerCase()}`
}

/** Host + path, lowercased, without query, hash, trailing slash or `www.`. */
export function normalizeUrlKey(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null
  try {
    const u = new URL(raw.trim())
    const host = u.hostname.toLowerCase().replace(/^www\./, '')
    const path = u.pathname.replace(/\/+$/, '')
    return `${host}${path}`
  } catch {
    return raw.trim().toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '') || null
  }
}
