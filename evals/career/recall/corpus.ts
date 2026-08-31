// The recall benchmark corpus — loaded from checked-in fixtures, never the network.
//
// WHY THIS EXISTS. Measured on the founder's live database: 284 postings from
// 34 companies, 107 of them (38 %) from GE Vernova alone. "Scout feels better"
// cannot detect that, and cannot detect its repair either. A coverage claim is
// only worth what its ground truth is worth, so the ground truth is checked in,
// cited, and assembled from surfaces the pipeline does not itself use to
// answer the question.
//
// FOUR PARTS, per docs/EVALS.md §"Recall":
//   (a) simplify-sample.json    a bounded, proportional draw from the live
//                               Summer 2027 Simplify feed. Proportions are
//                               PRESERVED — the feed's own concentration
//                               (TikTok is 128 of its 775 open Summer 2027
//                               listings) is part of what is being measured,
//                               so flattening it would be cheating.
//   (b) benchmark.json          the hand-curated set: real chemical, process,
//                               materials, manufacturing, energy, CPG and
//                               pharma internships, each citing the company,
//                               title and URL it was observed at.
//   (c) ats-boards.json         whole board listings — 293 postings from 32
//                               boards, recorded verbatim on THREE platforms:
//                               workday (27 boards), greenhouse (4) and phenom
//                               (1). The benchmark entries are a SUBSET of
//                               these; the other 107 are hand-labelled
//                               non-internships and off-discipline postings, the
//                               noise a real board also returns.
//                               A caveat that must travel with the precision
//                               number: in the SHIPPED configuration the
//                               adapters' own `internshipsOnly` pre-filter
//                               removes most of those negatives before the
//                               pipeline sees them, so the eval drains the
//                               boards a second time WHOLE and reports both
//                               numbers.
//   (d) paid-provider.json      wired, empty. No key exists, so the source is
//                               registered, reported unconfigured, and named.
//
// THE HONEST LIMITATION, stated here because it must never be lost: a corpus
// measures coverage against ITSELF. It cannot prove discovery is complete. It
// can only prove discovery finds what a person, working the same public
// endpoints by hand on one day, was able to find.

import fs from 'fs'
import path from 'path'

export const RECALL_FIXTURES = path.resolve('evals', 'career', 'fixtures', 'recall')

/** The eight areas the founder's direction spans. The diversity test asserts against these. */
export const ROLE_AREAS = [
  'process_chemical',
  'manufacturing',
  'materials',
  'energy',
  'cpg',
  'pharma',
  'industrial_tech',
  'ai_industry',
] as const

export type RoleArea = (typeof ROLE_AREAS)[number]

/**
 * One benchmark job. `reachable_by` names the SURFACE FAMILIES that could see
 * it — not the sources this run happens to have. That distinction is the whole
 * qualifier on the headline number: an entry whose only surface has no adapter
 * is excluded from the recall denominator and named in the report, so the suite
 * never claims coverage of listings no configured source can reach.
 */
export interface BenchmarkEntry {
  id: string
  company: string
  title: string
  url: string
  canonical_url: string
  source: string
  platform: string
  active: boolean
  role_area: RoleArea
  why_relevant: string
  reachable_by: string[]
  observed_at: string
}

export interface CoverageGap {
  platform: string
  company: string
  board_total_reported: number | null
  endpoint: string
}

export interface BenchmarkCorpus {
  version: string
  generated_at: string
  method: string
  role_areas: string[]
  probe_notes: string[]
  coverage_gaps: CoverageGap[]
  entries: BenchmarkEntry[]
}

/** One posting exactly as a board returned it on 2026-08-31. */
export interface FixturePosting {
  external_id: string | null
  title: string
  location_raw: string | null
  url: string
  /** Workday's `postedOn` is relative prose ("Posted 13 Days Ago"), never a date. */
  posted_raw: string | null
  posted_at: string | null
}

export interface FixtureBoard {
  platform: string
  company: string
  company_domain: string | null
  board_key: string
  board_url: string
  /** What the board said it had, when it said. Null when the platform does not report a total. */
  board_total_reported: number | null
  tenant?: string
  postings: FixturePosting[]
}

export interface BoardCorpus {
  generated_at: string
  method: string
  boards: FixtureBoard[]
}

export interface PrecisionLabel {
  url: string
  company: string
  title: string
  label: 'internship' | 'not_internship'
  overridden_from?: string
  note?: string
}

export interface PrecisionLabels {
  version: string
  generated_at: string
  method: string
  labels: PrecisionLabel[]
}

export interface PaidProviderSlot {
  version: string
  generated_at: string
  note: string
  /** The credential of the provider actually wired, not an invented name. */
  env_var: string
  env_var_note?: string
  provider: string | null
  entries: BenchmarkEntry[]
}

/** One record of the Simplify feed, as the file has it. Mirrors `SimplifyListing`. */
export interface SimplifyFixtureRow {
  source?: string
  category?: string
  company_name?: string
  id?: string
  title?: string
  active?: boolean
  terms?: string[]
  date_updated?: number
  date_posted?: number
  url?: string
  locations?: string[]
  company_url?: string
  is_visible?: boolean
  sponsorship?: string
  degrees?: string[]
}

function read<T>(name: string): T {
  const file = path.join(RECALL_FIXTURES, name)
  if (!fs.existsSync(file)) throw new Error(`recall fixture missing: ${file}`)
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T
}

export interface RecallCorpus {
  benchmark: BenchmarkCorpus
  boards: BoardCorpus
  simplify: SimplifyFixtureRow[]
  labels: PrecisionLabels
  paid: PaidProviderSlot
}

let cached: RecallCorpus | null = null

export function loadRecallCorpus(force = false): RecallCorpus {
  if (cached && !force) return cached
  cached = {
    benchmark: read<BenchmarkCorpus>('benchmark.json'),
    boards: read<BoardCorpus>('ats-boards.json'),
    simplify: read<SimplifyFixtureRow[]>('simplify-sample.json'),
    labels: read<PrecisionLabels>('precision-labels.json'),
    paid: read<PaidProviderSlot>('paid-provider.json'),
  }
  return cached
}

// ─── Matching a benchmark entry to a discovered posting ──────────────────────
//
// Canonical URL first, because two records with the same first-party URL are
// unambiguously the same opening. Normalised company + title is the fallback,
// and it is deliberately coarse: a source that hands back a redirect instead of
// the employer's own URL has still FOUND the job, and scoring that as a miss
// would measure URL hygiene while calling it recall. URL hygiene has its own
// metric (`canonicalUrlRate`) so the two never hide behind each other.

/** Host + path, lowercased, no query, hash, trailing slash or `www.`. */
export function urlKey(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null
  try {
    const u = new URL(raw.trim())
    return `${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`
  } catch {
    return raw.trim().toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '') || null
  }
}

/** Lowercase alphanumerics only. "Applied Materials, Inc." and "applied materials" agree. */
export function companyKey(name: string | null | undefined): string {
  return (name ?? '')
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|company|co|plc|gmbh|sa|nv|group|holdings?)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '')
}

/**
 * Titles collapse to their content words: case, punctuation, season/year noise
 * and the word "intern" itself all go, because "Chemical Engineering Intern"
 * and "SUMMER CO-OP/INTERN – Chemical Engineering (FY 2027)" are the same job
 * described twice and a matcher that says otherwise reports a miss that did not
 * happen.
 */
export function titleKey(raw: string | null | undefined): string {
  return (raw ?? '')
    .toLowerCase()
    .replace(/\b(summer|fall|autumn|winter|spring)\b/g, ' ')
    .replace(/\b20\d\d\b|\bfy\s?\d{2,4}\b/g, ' ')
    .replace(/\bintern(ship)?s?\b|\bco-?op\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ')
}

export function benchmarkKeys(entry: Pick<BenchmarkEntry, 'canonical_url' | 'url' | 'company' | 'title'>): {
  url: string | null
  fallback: string
} {
  return {
    url: urlKey(entry.canonical_url) ?? urlKey(entry.url),
    fallback: `${companyKey(entry.company)}|${titleKey(entry.title)}`,
  }
}
