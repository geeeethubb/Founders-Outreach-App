// Deterministic relevance — the gate that makes a wide, cheap sweep affordable.
//
// The strategy this file exists to serve: **decouple inventory from
// extraction.** Inventory (hundreds of postings) comes from free board
// listings and deterministic normalization. The model calls — extraction, fit,
// research — are bounded and spent on the BEST of that inventory rather than
// on whatever board happened to answer first. So "which of these 400 postings
// is worth paying for?" has to be arithmetic, not a model call, or the gate
// costs more than the thing it guards.
//
// It is deliberately NOT a fit score. Fit is the Fit Evaluator's judgment
// against the whole evidence bank, persisted with its evidence and its weights
// (ADR-004). This is a cheap ordering over columns the row already carries,
// computed at read time and stored nowhere — which is why scaling discovery
// needed no migration.
//
// It also owns the patch a DEFERRED extraction makes to a row that was stored
// without one, because that patch has to obey exactly the precedence
// `buildNormalizedJob` obeys and the only way two paths cannot drift is to
// keep them next to each other.
//
// Pure. No I/O, no model, every rule testable in memory.

import type { EmploymentType, ExtractedJobFields, SeasonRelevance, WorkMode } from '../types'
import { locationTier, parseLocation } from './location'
import { parseDeadline, titleSaysInternship, titleSaysOtherSeason, type NormalizeOptions } from './normalize'

/** The columns relevance reads. A stored row and a `NormalizedJob` both satisfy it. */
export interface RelevanceInput {
  title: string
  company_name?: string | null
  description_text?: string | null
  role_family?: string | null
  season_relevance?: SeasonRelevance | string | null
  location_tier?: number | null
  employment_type?: EmploymentType | string | null
  verification_status?: string | null
  extraction_version?: string | null
}

/**
 * How many of the stated direction's terms this posting carries.
 *
 * The term SET is built by `directionTerms` (lib/career/scout/direction.ts) and
 * passed in; that module imports ./normalize, so importing it here would close
 * a cycle. One owner for the parsing, one owner for the arithmetic.
 */
export function directionHits(job: RelevanceInput, terms: Set<string>): number {
  if (terms.size === 0) return 0
  const hay = `${job.title} ${job.company_name ?? ''} ${(job.description_text ?? '').slice(0, 1_500)}`.toLowerCase()
  let n = 0
  for (const t of terms) if (hay.includes(t)) n++
  return n
}

/** The internship shape of a row, from its own columns — no database, no model. */
export function looksLikeInternship(job: RelevanceInput): boolean {
  const type = job.employment_type ?? ''
  if (type === 'internship' || type === 'co_op') return true
  if (type === 'full_time' || type === 'contract' || type === 'part_time') return false
  return titleSaysInternship(job.title)
}

/** Every term of `jobRelevance`, so a run can explain an ordering rather than assert it. */
export const RELEVANCE_TERMS = {
  internship: 20,
  directionPerHit: 10,
  directionMaxHits: 3,
  seasonTarget: 25,
  seasonUnspecified: 10,
  seasonOther: -40,
  knownRoleFamily: 10,
  tier1: 15,
  tier2: 10,
  tier3: 5,
  verifiedOpen: 5,
} as const

/**
 * A posting's relevance, roughly −40…95, best first:
 *
 *   internship shape        +20   the mission is internships; anything else is noise
 *   stated direction        +10 each, max +30 — the strongest input the user gives
 *   target season           +25 summer_2027 · +10 unspecified · −40 a different season
 *   a known role family     +10   'other' means the title told us nothing
 *   geography               +15 tier 1 · +10 tier 2 · +5 tier 3
 *   confirmed open          +5    an ATS listed it
 *
 * A LISTING-ONLY row is not penalised for being thin: the whole point of
 * deferring extraction is that a row with no description can still be the best
 * candidate to spend an extraction on. Ties are broken by the caller (store
 * order), so the ordering is stable across runs.
 */
export function jobRelevance(job: RelevanceInput, terms: Set<string> = new Set()): number {
  const T = RELEVANCE_TERMS
  let score = 0
  if (looksLikeInternship(job)) score += T.internship
  score += Math.min(T.directionMaxHits, directionHits(job, terms)) * T.directionPerHit
  const season = job.season_relevance ?? ''
  if (season === 'summer_2027') score += T.seasonTarget
  else if (season === 'unspecified') score += T.seasonUnspecified
  else if (season === 'other_season') score += T.seasonOther
  if (job.role_family && job.role_family !== 'other') score += T.knownRoleFamily
  const tier = job.location_tier
  if (tier === 1) score += T.tier1
  else if (tier === 2) score += T.tier2
  else if (tier === 3) score += T.tier3
  if (job.verification_status === 'VERIFIED_OPEN') score += T.verifiedOpen
  return score
}

/**
 * Order rows best-first by relevance, keeping input order on a tie so the
 * choice is reproducible. Returns a new array; the input is untouched.
 */
export function byRelevance<T extends RelevanceInput>(rows: T[], terms: Set<string> = new Set()): T[] {
  return rows
    .map((row, i) => ({ row, i, score: jobRelevance(row, terms) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.row)
}

// ─── The patch a deferred extraction makes ───────────────────────────────────

/** A stored row as the deferred extractor reads it back. */
export interface ExtractableRow {
  id: string
  title: string
  company_name: string
  location_raw: string | null
  location_tier?: number | null
  employment_type: EmploymentType | string | null
  season_relevance: SeasonRelevance | string | null
  work_mode: WorkMode | string | null
  role_family: string | null
  description_text?: string | null
  verification_status?: string | null
}

/**
 * The column patch an extraction makes to a row that was stored WITHOUT one.
 *
 * The precedence is `buildNormalizedJob`'s, deliberately: an extractor's
 * 'unknown' never overwrites what the heuristics already decided, and a title
 * naming a non-summer season of the target year still overrules the body
 * (`titleSaysOtherSeason` — the shared-template trap).
 *
 * Location is recomputed only when the extractor actually CHANGED
 * `location_raw`, so an extraction run without geo tiers cannot blank a tier
 * the sweep already computed.
 */
export function extractionPatch(
  row: ExtractableRow,
  extracted: ExtractedJobFields,
  version: string,
  mission?: NormalizeOptions
): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    employment_type: extracted.employment_type !== 'unknown' ? extracted.employment_type : row.employment_type,
    season_relevance: titleSaysOtherSeason(row.title)
      ? 'other_season'
      : extracted.season_relevance !== 'unknown'
        ? extracted.season_relevance
        : row.season_relevance,
    work_mode: extracted.work_mode !== 'unknown' ? extracted.work_mode : row.work_mode,
    role_family: extracted.role_family ?? row.role_family,
    deadline: parseDeadline(extracted.deadline),
    compensation: extracted.compensation,
    min_qualifications: extracted.min_qualifications,
    preferred_qualifications: extracted.preferred_qualifications,
    graduation_eligibility: extracted.graduation_eligibility,
    work_authorization: extracted.work_authorization,
    skills: extracted.skills,
    responsibilities: extracted.responsibilities,
    industry: extracted.industry,
    extraction_version: version,
    extraction_confidence: extracted.confidence,
  }
  if (extracted.location_raw && extracted.location_raw !== row.location_raw) {
    const parsed = parseLocation(extracted.location_raw)
    patch.location_raw = extracted.location_raw
    patch.location_city = parsed.city
    patch.location_state = parsed.state
    patch.location_country = parsed.country
    if (mission?.geo_tiers) patch.location_tier = locationTier(parsed, mission.geo_tiers, mission.tier)
  }
  // The extractor reading "this role has been filled" is the one verdict an
  // extraction may write; everything else about verification is the verifier's.
  if (extracted.appears_closed) {
    patch.verification_status = 'CLOSED'
    patch.verification_note = 'posting text says the role is closed'
    patch.verification_method = 'extractor'
  }
  return patch
}
