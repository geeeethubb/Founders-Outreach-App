// The two dials on a mission — WHERE, and WHAT DIRECTION — and the pure
// functions that resolve them.
//
// Every one of these is a resolver, not a field read. A mission row can be any
// vintage (pre-017 rows have no `locations` key at all) and a patch can be
// partial, so nothing in the product is allowed to read `preferences.locations`
// or `preferences.direction_mode` directly. It asks here instead, and gets one
// answer.
//
// Pure. It imports TYPES from ../types and nothing else, so a client component,
// a lib module and an offline test can all call it. `../types` re-exports every
// symbol below, which is why the old import path still works — and why this
// file must never import a VALUE from ../types (that would be a cycle).
//
// Split out of lib/career/types.ts, which is over the ~400-line rule in
// CLAUDE.md; adding another hundred lines of behaviour to it was the wrong move.

import type { CareerMissionPreferences, GeoTier, HardConstraint } from '../types'

// ─── Where ───────────────────────────────────────────────────────────────────

/**
 * How geography is used. THREE DISTINCT BEHAVIOURS — never conflate them.
 *
 *   anywhere   No place preference at all. Where a posting is neither helps nor
 *              hurts it, and no query ever carries a city. This is the default:
 *              the product does not get to have an opinion the user did not state.
 *   prefer     A RANKING signal only. Postings in `regions` score higher; a
 *              posting anywhere else is still discovered, still stored, still shown.
 *   only       A HARD FILTER, enforced in code as a hard constraint on the
 *              mission (see `locationOnlyConstraint`) — not a claim in a prompt.
 */
export type LocationMode = 'anywhere' | 'prefer' | 'only'

export interface LocationPreference {
  mode: LocationMode
  /** Free text places as the user wrote them. Empty (and ignored) when mode is 'anywhere'. */
  regions: string[]
}

/**
 * What a stated direction DOES to the search.
 *
 *   off         The direction text, if any, is not applied — plan broadly from the evidence.
 *   boost       Search HARDER in that direction, while still ingesting strong adjacent postings.
 *   exclusive   Restrict discovery and ranking to the direction.
 *
 * Defaults are derived, never stored blindly: `boost` when a direction is set,
 * `off` when it is empty. Read it through `missionDirectionMode()`.
 */
export type DirectionMode = 'off' | 'boost' | 'exclusive'

export const LOCATION_MODES: LocationMode[] = ['anywhere', 'prefer', 'only']
export const DIRECTION_MODES: DirectionMode[] = ['off', 'boost', 'exclusive']

/** No city, no region, no opinion. The shipped default. */
export const DEFAULT_LOCATION_PREFERENCE: LocationPreference = { mode: 'anywhere', regions: [] }

type LocationInput = Pick<CareerMissionPreferences, 'locations' | 'geo_tiers'>

/**
 * The location dial for a mission, whatever vintage the row is.
 *
 * A pre-017 row has no `locations` key, so it is read from `geo_tiers`: named
 * tiers meant "rank these higher", which is exactly `prefer`. No tiers means no
 * opinion, which is `anywhere`. Nothing is invented and nothing is filtered —
 * `only` is only ever something a person chose.
 */
export function missionLocations(p: LocationInput): LocationPreference {
  const l = p.locations
  if (l && typeof l === 'object' && LOCATION_MODES.includes(l.mode)) {
    const regions = Array.isArray(l.regions) ? l.regions.filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim()) : []
    // A dial pointed at nowhere is no dial: 'prefer'/'only' with no region is 'anywhere'.
    return regions.length ? { mode: l.mode, regions } : DEFAULT_LOCATION_PREFERENCE
  }
  const legacy = (Array.isArray(p.geo_tiers) ? p.geo_tiers : []).flatMap((t) => t.locations ?? [])
  return legacy.length ? { mode: 'prefer', regions: legacy } : DEFAULT_LOCATION_PREFERENCE
}

/**
 * The regions a posting MUST be in, or null when geography does not filter.
 * The single function any filter is allowed to call — `prefer` returns null
 * here by construction, so a preference cannot become a filter by accident.
 */
export function locationHardFilter(p: LocationInput): string[] | null {
  const l = missionLocations(p)
  return l.mode === 'only' && l.regions.length ? l.regions : null
}

/**
 * Every hard constraint whose label starts with this was DERIVED from the
 * location dial, not typed by a person. `reconcileLocationConstraints()` in
 * store.ts owns rows carrying it and rewrites them whenever the dial changes.
 */
export const LOCATION_ONLY_LABEL_PREFIX = 'Only these places: '

/**
 * "Only these places" as an ENFORCED rule, or null when geography does not filter.
 *
 * This is the mechanism behind the promise. `applyHardConstraints()` /
 * `constraintRejections()` already run over every posting at extraction, at
 * manual add, and before fit is scored (lib/career/jobs/filters.ts), and they
 * report the LABEL of whatever excluded a job — so the founder can see which
 * rule hid something instead of wondering where the postings went.
 *
 * It reads `location_tier`, which `buildNormalizedJob` stamps from the same
 * regions (`geoTiersForLocations` puts them in tier 1):
 *
 *   tier 1  the posting is in one of the chosen places   → kept
 *   tier 2  remote, in the US, with no city named        → kept: it CAN be done from there
 *   tier 3  somewhere else in the US                     → rejected
 *   null    non-US, or a location nothing could parse    → rejected
 */
export function locationOnlyConstraint(p: LocationInput): HardConstraint | null {
  const regions = locationHardFilter(p)
  if (!regions) return null
  return {
    dimension: 'location_tier',
    operator: 'in',
    value: ['1', '2'],
    label: `${LOCATION_ONLY_LABEL_PREFIX}${regions.join('; ')}`,
  }
}

/** True for a constraint this module wrote, and therefore one it may replace or drop. */
export function isDerivedLocationConstraint(c: Pick<HardConstraint, 'dimension' | 'label'>): boolean {
  return c.dimension === 'location_tier' && typeof c.label === 'string' && c.label.startsWith(LOCATION_ONLY_LABEL_PREFIX)
}

/**
 * The ranking tiers geography scoring should read.
 *
 * `anywhere` returns NOTHING, whatever the row happens to still hold: a stale
 * tier left over from an older write must not quietly score a posting up when
 * the person has said place does not matter. `sanitizePreferences` also clears
 * the tiers on the way in, so the two agree; this is the read-side guarantee.
 */
export function rankingGeoTiers(p: LocationInput): GeoTier[] {
  const l = missionLocations(p)
  if (l.mode === 'anywhere') return []
  const tiers = (Array.isArray(p.geo_tiers) ? p.geo_tiers : []).filter((t) => t.locations?.length)
  return tiers.length ? tiers : [{ tier: 1, locations: l.regions }]
}

/** The `geo_tiers` a location dial implies. The UI writes both together so they never disagree. */
export function geoTiersForLocations(l: LocationPreference): GeoTier[] {
  return l.mode === 'anywhere' || !l.regions.length ? [] : [{ tier: 1, locations: l.regions }]
}

// ─── Direction ───────────────────────────────────────────────────────────────

/** `boost` when a direction is set and no mode was chosen; `off` whenever there is no direction to apply. */
export function missionDirectionMode(p: Pick<CareerMissionPreferences, 'direction' | 'direction_mode'>): DirectionMode {
  const hasDirection = typeof p.direction === 'string' && p.direction.trim().length > 0
  if (!hasDirection) return 'off'
  return p.direction_mode && DIRECTION_MODES.includes(p.direction_mode) ? p.direction_mode : 'boost'
}

// ─── Place is stated ONCE ────────────────────────────────────────────────────

/**
 * The Evidence Bank's preference block with every PLACE line removed.
 *
 * WHY THIS EXISTS. `evidence_preferences` was seeded from the old shipped
 * geography — six coastal cities as `location` rows, plus `location` itself in
 * `optimize_for` — and `renderPreferences()` prints those rows verbatim into the
 * planner's and the fit evaluator's user message, right beside the mission. So a
 * mission that says "LOCATIONS: ANYWHERE — no place preference" arrived at the
 * model in the same breath as "location: San Francisco / Bay Area (weight 1)".
 * Migration 017 removes those rows from the database; this removes them from the
 * prompt whatever the database still holds, so the contradiction cannot come
 * back through a stale row, a restored backup, or a re-run of an old seed.
 *
 * THE RULE IT ENFORCES: place is stated exactly once, on the mission's LOCATIONS
 * line, which is the only place the three behaviours are named. A duplicate
 * statement of geography somewhere else in the prompt can only agree redundantly
 * or disagree dangerously.
 *
 * A `[HARD]` place row is NOT dropped: that is a constraint a person typed, and
 * silently removing it would be the same sin in the other direction. It stays
 * visible so the contradiction is the founder's to resolve, not ours to hide.
 */
export function withoutPlacePreferences(rendered: string): string {
  const kept = rendered
    .split('\n')
    .filter((line) => {
      if (/\[HARD\]\s*$/.test(line)) return true
      return !/^\s*location\s*:/i.test(line) && !/^\s*optimize_for\s*:\s*location\s*(\(|\[|$)/i.test(line)
    })
  const text = kept.join('\n').trim()
  return text || '(no preferences recorded)'
}

// ─── Migration notes ─────────────────────────────────────────────────────────

/**
 * A migration that CHANGED, or DECLINED to change, a preference — so the UI can
 * show what happened (or offer the change as a suggestion) instead of a row
 * silently becoming something else. Written by SQL, read by the Mission page,
 * never read by an agent and never a filter. (migration 017)
 */
export interface MissionMigrationNote {
  kind: string
  migration: string
  created_at: string
  message: string
  [extra: string]: unknown
}
