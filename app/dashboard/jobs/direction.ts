// Pure helpers and copy for the two dials on the Jobs screens: what I'm
// scouting for (and how hard that binds), and where I'll go. Kept out of the
// React files so an offline test can exercise them without a DOM or a React
// import, and so the words the founder reads live in ONE place.
//
// House rule for every string below: no internal vocabulary. The founder never
// sees "boost", "exclusive", "mode" or "geo tier" — they see what will happen.

import type { CareerMissionPreferences, DirectionMode, LocationMode, LocationPreference } from '@/lib/career/types'
import { geoTiersForLocations, missionDirectionMode } from '@/lib/career/types'

export const DIRECTION_PLACEHOLDER =
  "Pivot into life sciences / genomics research — computational or wet-lab R&D internships where a chemical engineer's process, lab and data experience transfers. Also open to industrial AI."

export const DIRECTION_HINT_LEAD = 'This leads the search; the Evidence Bank explains why you’re credible for it.'
export const DIRECTION_HINT_WHERE = 'Locations, company types and hard constraints live on the Mission page.'
export const DIRECTION_HINT = `${DIRECTION_HINT_LEAD} ${DIRECTION_HINT_WHERE}`

export const NO_DIRECTION_LINE = 'No direction stated — exploring broadly from your evidence'
const PREVIEW_CHARS = 140

/** Whitespace-only text is "no direction", stored as null so the planner falls back to the evidence. */
export function normalizeDirection(value: string | null | undefined): string | null {
  const t = (value ?? '').trim()
  return t ? t : null
}

/** True when the textarea differs from what the mission has stored, ignoring trailing whitespace. */
export function directionDirty(draft: string, stored: string | null | undefined): boolean {
  return normalizeDirection(draft) !== normalizeDirection(stored)
}

/**
 * The PATCH body for /api/career/missions/[id]: only the direction keys. The
 * store merges a partial preferences patch over the stored row, so a stale
 * Jobs tab cannot overwrite company types or notes edited on the Mission page.
 *
 * `mode` is optional so an older caller that only saves the text keeps working;
 * the store then derives the default (search harder for it) on its own.
 */
export function directionPatch(
  direction: string,
  mode?: DirectionMode
): { preferences: Pick<CareerMissionPreferences, 'direction' | 'direction_mode'> } {
  const text = normalizeDirection(direction)
  return { preferences: { direction: text, ...(text && mode ? { direction_mode: mode } : {}) } }
}

// ─── What a direction DOES ───────────────────────────────────────────────────

export const DIRECTION_MODE_OPTIONS: { value: Exclude<DirectionMode, 'off'>; label: string; hint: string }[] = [
  {
    value: 'boost',
    label: 'Search harder for this',
    hint: 'Most of the search goes here, and strong nearby roles still reach you.',
  },
  {
    value: 'exclusive',
    label: 'Only show me this',
    hint: 'Everything outside it is left out, even if it looks good.',
  },
]

export const DIRECTION_MODE_EMPTY_HINT = 'Leave this empty and the search explores broadly from your evidence.'

/** The mode a card should show as selected, for a draft that may not be saved yet. */
export function directionModeFor(draft: string, stored: DirectionMode | null | undefined): Exclude<DirectionMode, 'off'> {
  const resolved = missionDirectionMode({ direction: normalizeDirection(draft), direction_mode: stored ?? undefined })
  return resolved === 'exclusive' ? 'exclusive' : 'boost'
}

/**
 * Is the direction CARD unsaved — either half of it?
 *
 * Switching from "search harder for this" to "only show me this" changes what a
 * paid run will do, so it has to light up Save exactly the way editing the text
 * does. Choosing a mode with no direction to apply it to is NOT a change: the
 * store drops a mode it has nothing to attach to, so Save would do nothing.
 */
export function directionDialDirty(
  draft: string,
  mode: Exclude<DirectionMode, 'off'>,
  stored: Pick<CareerMissionPreferences, 'direction' | 'direction_mode'> | null | undefined
): boolean {
  if (!stored) return false
  if (directionDirty(draft, stored.direction)) return true
  if (!normalizeDirection(draft)) return false
  return mode !== directionModeFor(stored.direction ?? '', stored.direction_mode ?? null)
}

// ─── Where I'll go ───────────────────────────────────────────────────────────

export const LOCATION_MODE_OPTIONS: { value: LocationMode; label: string; hint: string }[] = [
  {
    value: 'anywhere',
    label: 'Anywhere in the US',
    hint: 'Where a job is never counts for it or against it. This is the default.',
  },
  {
    value: 'prefer',
    label: 'Prefer these places',
    hint: 'Jobs in these places rank higher. Everywhere else still gets found and still gets shown.',
  },
  {
    value: 'only',
    label: 'Only these places',
    hint: 'Jobs outside these places are left out entirely. This one really does hide things.',
  },
]

/**
 * BOTH non-neutral choices need somewhere to point, and the API rejects either
 * one empty (`missionPatchError`). Saying so inline is the difference between
 * "your choice was refused, here is why" and a red toast after the fact — and
 * `prefer` used to be worse than that: it was silently coerced back to
 * "Anywhere in the US" and reported as "Saved."
 */
export const LOCATION_EMPTY_WARNING: Record<Exclude<LocationMode, 'anywhere'>, string> = {
  only: 'Add at least one place, or nothing will get through.',
  prefer: 'Add at least one place, or there is nothing to prefer.',
}

export const LOCATION_ONLY_EMPTY_WARNING = LOCATION_EMPTY_WARNING.only

/** True when the location choice cannot be saved as it stands. The Save button reads this. */
export function locationChoiceIncomplete(l: LocationPreference): boolean {
  return l.mode !== 'anywhere' && !l.regions.filter((r) => r.trim()).length
}

/**
 * The preferences patch for a change to the location dial. `locations` is what
 * the person chose; `geo_tiers` is the ranking table it drives, written in the
 * same breath so the two can never disagree about what was asked for.
 */
export function locationsPatch(l: LocationPreference): Pick<CareerMissionPreferences, 'locations' | 'geo_tiers'> {
  const clean: LocationPreference = { mode: l.mode, regions: l.mode === 'anywhere' ? [] : l.regions.filter((r) => r.trim()) }
  return { locations: clean, geo_tiers: geoTiersForLocations(clean) }
}

/**
 * The one line the Scout panel shows before a run so stale text never runs
 * unnoticed. The mode is part of it: "only this" hides jobs, and a person about
 * to spend money on a run should be told that before it starts, not after.
 */
export function scoutingLine(direction: string | null | undefined, mode?: DirectionMode | null): string {
  const d = normalizeDirection(direction)
  if (!d) return NO_DIRECTION_LINE
  const oneLine = d.replace(/\s+/g, ' ')
  const text = oneLine.length > PREVIEW_CHARS ? `${oneLine.slice(0, PREVIEW_CHARS).trimEnd()}…` : oneLine
  const label = missionDirectionMode({ direction: d, direction_mode: mode ?? undefined }) === 'exclusive' ? 'Scouting for ONLY' : 'Scouting for'
  return `${label}: ${text}`
}
