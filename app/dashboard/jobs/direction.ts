// Pure helpers for the "What I'm scouting for" input. Kept out of the React
// files so an offline test can exercise them without a DOM or a React import.

import type { CareerMissionPreferences } from '@/lib/career/types'

export const DIRECTION_PLACEHOLDER =
  "Pivot into life sciences / genomics research — computational or wet-lab R&D internships where a chemical engineer's process, lab and data experience transfers. Also open to industrial AI."

export const DIRECTION_HINT_LEAD = 'This leads the search; the Evidence Bank explains why you’re credible for it.'
export const DIRECTION_HINT_WHERE = 'Locations, company types and hard constraints live on the Mission page.'
export const DIRECTION_HINT = `${DIRECTION_HINT_LEAD} ${DIRECTION_HINT_WHERE}`

export const NO_DIRECTION_LINE = 'No direction stated — planning from your evidence'
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
 * The PATCH body for /api/career/missions/[id]: only the direction key. The
 * store merges a partial preferences patch over the stored row, so a stale
 * Jobs tab cannot overwrite company types or notes edited on the Mission page.
 */
export function directionPatch(direction: string): { preferences: Pick<CareerMissionPreferences, 'direction'> } {
  return { preferences: { direction: normalizeDirection(direction) } }
}

/** The one line the Scout panel shows before a run so stale text never runs unnoticed. */
export function scoutingLine(direction: string | null | undefined): string {
  const d = normalizeDirection(direction)
  if (!d) return NO_DIRECTION_LINE
  const oneLine = d.replace(/\s+/g, ' ')
  return `Scouting for: ${oneLine.length > PREVIEW_CHARS ? `${oneLine.slice(0, PREVIEW_CHARS).trimEnd()}…` : oneLine}`
}
