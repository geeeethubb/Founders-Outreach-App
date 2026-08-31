// What migration 017 replaces, and the exact test for whether it may.
//
// Until V2 the shipped default mission put "San Francisco / Bay Area" and
// "New York City" in geography tier 1 and four coastal cities in tier 2, and
// said so again in prose in the objective. Nobody asked for that: it was
// written by `defaultMission()` at seed time, printed into every planner and
// fit-evaluator prompt by `renderMission()`, and appended to deterministic
// search queries — while the founder's own stated direction read "I don't care
// about location or which company". A preference the PRODUCT invented was
// outranking the one the USER stated.
//
// So it is migrated. But a mission somebody EDITED is a preference a person
// expressed, and is never overwritten — not one city of it. The whole test is
// byte identity with what shipped. This module is that test, kept pure and
// kept apart from the database so migration 017's SQL predicate has a
// TypeScript twin an offline suite can drive.
//
// Pure. No imports beyond types. Do not add a database call here.

import type { GeoTier } from '../types'

/** The exact tier arrays shipped before V2. Frozen: 017 keys on this and nothing else. */
export const PRE_V2_DEFAULT_GEO_TIERS: GeoTier[] = [
  { tier: 1, locations: ['San Francisco / Bay Area', 'New York City'] },
  {
    tier: 2,
    locations: ['Boston', 'Seattle', 'Los Angeles', 'Washington DC'],
    description: 'other large, vibrant East or West Coast cities — genuinely strong urban markets',
  },
]

/** The exact objective string shipped before V2 — it named the same cities in prose. */
export const PRE_V2_DEFAULT_OBJECTIVE =
  'Find high-quality Summer 2027 internships where I will learn fast, own real work, and sit with ' +
  'intelligent colleagues on technically interesting, important problems — in the Bay Area or New York ' +
  'first, other strong coastal cities second.'

/** The V2 objective. Says what a good internship is; says nothing about where it is. */
export const NEUTRAL_DEFAULT_OBJECTIVE =
  'Find high-quality Summer 2027 internships where I will learn fast, own real work, and sit with ' +
  'intelligent colleagues on technically interesting, important problems — anywhere in the United States.'

/**
 * True ONLY for the byte-identical shipped default: same tiers, in the same
 * order, with the same strings, the same description, no key added and none
 * removed. One extra city, one reordered tier, one edited description — and
 * this is false, the migration leaves the row alone, and the UI is handed a
 * suggestion instead.
 *
 * This is the same comparison migration 017 makes in jsonb (`preferences ->
 * 'geo_tiers' = '[…]'::jsonb`); if you change one, change the other.
 */
export function isShippedPreV2Geography(tiers: unknown): boolean {
  if (!Array.isArray(tiers) || tiers.length !== PRE_V2_DEFAULT_GEO_TIERS.length) return false
  return PRE_V2_DEFAULT_GEO_TIERS.every((want, i) => {
    const got = tiers[i] as Partial<GeoTier> | null
    if (!got || typeof got !== 'object' || Array.isArray(got)) return false
    if (Object.keys(got).sort().join(',') !== Object.keys(want).sort().join(',')) return false
    if (got.tier !== want.tier) return false
    if (!Array.isArray(got.locations) || got.locations.length !== want.locations.length) return false
    if (!want.locations.every((loc, j) => got.locations![j] === loc)) return false
    return got.description === want.description
  })
}

/** True for the byte-identical shipped pre-V2 objective, whitespace and all. */
export function isShippedPreV2Objective(objective: unknown): boolean {
  return objective === PRE_V2_DEFAULT_OBJECTIVE
}
