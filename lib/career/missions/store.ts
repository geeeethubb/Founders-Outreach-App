// Career missions — persistence and the default mission.
//
// A mission is the unit of intent for a job search (docs/CAREER_OS.md §2).
// Preferences are editable data, never code: the geographic tiers, company
// types and optimization priorities below are the SEED for the first mission
// row, not rules anything reads directly.

import { createServiceClient } from '@/lib/supabase/server'
import { FIT_DIMENSIONS, type CareerMission, type CareerMissionPreferences, type FitWeights, type HardConstraint } from '../types'
import {
  DEFAULT_LOCATION_PREFERENCE,
  DIRECTION_MODES,
  LOCATION_MODES,
  geoTiersForLocations,
  isDerivedLocationConstraint,
  locationOnlyConstraint,
  missionDirectionMode,
  missionLocations,
  rankingGeoTiers,
  type DirectionMode,
  type LocationPreference,
} from './preferences'
import { isFitWeights } from '../fit/dimensions'
import { MAX_DIRECTION_CHARS, sanitizeDirection } from './direction'
import { NEUTRAL_DEFAULT_OBJECTIVE } from './neutrality'

function isMissingSchema(message: string): boolean {
  return /relation .* does not exist|column .* does not exist|schema cache|could not find/i.test(message)
}

/** The founder's stated initial mission, as data. */
export const DEFAULT_MISSION_PREFERENCES: CareerMissionPreferences = {
  // No city, anywhere. Geography is a ranking signal the user turns on, never a
  // preference the product ships with. `locations` is the dial; `geo_tiers` is
  // the ranking table it drives, empty until there is something to rank on.
  geo_tiers: [],
  locations: DEFAULT_LOCATION_PREFERENCE,
  company_types: [
    'high-quality startups',
    'growth-stage technology companies',
    'major industrial companies',
    'energy / oil & gas',
    'advanced manufacturing',
    'industrial AI',
    'chemicals',
    'materials',
    'CPG',
    'healthcare',
    'medical technology',
    'pharma where relevant',
    'robotics / automation',
    'other technically interesting industries',
  ],
  role_families: [],
  industries: [],
  optimize_for: [
    'learning',
    'ownership',
    'intelligent colleagues',
    'technically interesting work',
    'mentorship',
    'exposure to important problems',
    'professional growth',
    'strong career optionality',
    // No 'location' here. The place dial IS the place preference now; shipping
    // it in the priority list too told every agent to optimize for geography
    // three lines under "LOCATIONS: ANYWHERE — no place preference".
    'company quality',
    'mission relevance',
  ],
  work_modes: ['onsite', 'hybrid', 'remote'],
  notes:
    'Do not equate prestige with quality. Learn adjacent categories rather than filtering on these strings. ' +
    'Roles may span technical, engineering, technical strategy, product, industrial innovation, operations ' +
    'technology, AI/manufacturing, analytical, or cross-functional work — when no direction is stated, infer plausible ' +
    'roles from the evidence bank; when one is, it decides the roles and the evidence explains why I am credible for them.',
  direction: null,
  // No `direction_mode` here ON PURPOSE. A stored 'off' would survive every
  // `{ ...defaults, direction }` spread and every partial patch that sets only
  // the text, so the Jobs page could save a direction that then did nothing at
  // all. The mode is DERIVED instead — `missionDirectionMode()` reads 'off'
  // with no direction and 'boost' the moment one is written.
}

export { MAX_DIRECTION_CHARS, sanitizeDirection }
export { LOCATION_ONLY_LABEL_PREFIX, locationHardFilter, locationOnlyConstraint, missionLocations, rankingGeoTiers } from './preferences'
export {
  NEUTRAL_DEFAULT_OBJECTIVE,
  PRE_V2_DEFAULT_GEO_TIERS,
  PRE_V2_DEFAULT_OBJECTIVE,
  isShippedPreV2Geography,
  isShippedPreV2Objective,
} from './neutrality'

export const DEFAULT_HARD_CONSTRAINTS: HardConstraint[] = [
  { dimension: 'employment_type', operator: 'in', value: ['internship', 'co_op'], label: 'Internships only' },
  { dimension: 'season', operator: 'not_equals', value: 'other_season', label: 'Not a different season' },
  { dimension: 'location_country', operator: 'in', value: ['US', 'United States', ''], label: 'United States' },
]

export function defaultMission(userId: string): Omit<CareerMission, 'id' | 'created_at' | 'updated_at'> {
  return {
    user_id: userId,
    name: 'Summer 2027 Internships',
    objective: NEUTRAL_DEFAULT_OBJECTIVE,
    season: 'summer_2027',
    preferences: DEFAULT_MISSION_PREFERENCES,
    hard_constraints: DEFAULT_HARD_CONSTRAINTS,
    fit_weights: null,
    status: 'active',
  }
}

export async function listMissions(userId: string): Promise<{ missions: CareerMission[]; migrationMissing: boolean; error: string | null }> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('career_missions')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
  if (error) return { missions: [], migrationMissing: isMissingSchema(error.message), error: error.message }
  return { missions: (data ?? []) as CareerMission[], migrationMissing: false, error: null }
}

export async function getMission(userId: string, id: string): Promise<CareerMission | null> {
  const supabase = createServiceClient()
  const { data } = await supabase.from('career_missions').select('*').eq('user_id', userId).eq('id', id).maybeSingle()
  return (data as CareerMission | null) ?? null
}

/** The active mission, creating the default one when none exists. */
export async function ensureDefaultMission(userId: string): Promise<{ mission: CareerMission | null; created: boolean; error: string | null }> {
  const { missions, error, migrationMissing } = await listMissions(userId)
  if (migrationMissing) return { mission: null, created: false, error: 'migration 014_career_os.sql has not been applied' }
  if (error) return { mission: null, created: false, error }
  const active = missions.find((m) => m.status === 'active') ?? missions[0]
  if (active) return { mission: active, created: false, error: null }

  const supabase = createServiceClient()
  const { data, error: insErr } = await supabase
    .from('career_missions')
    .insert(defaultMission(userId) as never)
    .select('*')
    .single()
  if (insErr) return { mission: null, created: false, error: insErr.message }
  return { mission: data as CareerMission, created: true, error: null }
}

export async function createMission(
  userId: string,
  input: MissionPatch
): Promise<{ mission: CareerMission | null; error: string | null }> {
  const supabase = createServiceClient()
  const row = {
    ...defaultMission(userId),
    ...sanitizeMissionPatch(input, { preferences: DEFAULT_MISSION_PREFERENCES, hard_constraints: DEFAULT_HARD_CONSTRAINTS }),
  }
  const { data, error } = await supabase.from('career_missions').insert(row as never).select('*').single()
  return { mission: (data as CareerMission | null) ?? null, error: error?.message ?? null }
}

export async function updateMission(
  userId: string,
  id: string,
  patch: MissionPatch
): Promise<{ mission: CareerMission | null; error: string | null }> {
  const supabase = createServiceClient()
  // A partial preferences patch ({ preferences: { direction } }) merges over
  // what is stored; it must never wipe the other lists. The stored constraints
  // are loaded with it so the derived "only these places" rule can be kept in
  // step even when the patch carries only one half of the pair.
  const current = patch.preferences || patch.hard_constraints ? await getMission(userId, id) : null
  const base = current ? { preferences: current.preferences, hard_constraints: current.hard_constraints } : null
  const { data, error } = await supabase
    .from('career_missions')
    .update(sanitizeMissionPatch(patch, base) as never)
    .eq('user_id', userId)
    .eq('id', id)
    .select('*')
    .single()
  return { mission: (data as CareerMission | null) ?? null, error: error?.message ?? null }
}

/**
 * Only known columns, only well-formed values. Malformed input is dropped, not
 * coerced. When `base` preferences are given, a partial `preferences` patch is
 * merged over them key by key (absent keys keep the stored value); without a
 * base the patch is taken whole, as `createMission` does over the defaults.
 */
export type MissionPatch = Partial<Omit<CareerMission, 'preferences'>> & { preferences?: Partial<CareerMissionPreferences> }

/** What a patch is merged over: the row as stored. Only the two fields the reconciliation reads. */
export type MissionBase = Pick<CareerMission, 'preferences' | 'hard_constraints'>

/**
 * Keep the enforced "only these places" rule in step with the location dial.
 *
 * "Only these places" is a promise the UI makes and the fit prompt repeats, so
 * something has to actually stop a job — a claim without a mechanism is worse
 * than not offering the option. The mechanism is the one that already exists:
 * a HARD CONSTRAINT on the mission row, applied by `applyHardConstraints()` at
 * extraction, on manual add and before fit is scored, and reported by LABEL so
 * the founder can see which rule hid a posting.
 *
 * Rows this function wrote are identified by their label prefix and rewritten
 * or removed here; a constraint a person typed is never touched.
 */
export function reconcileLocationConstraints(constraints: HardConstraint[], preferences: CareerMissionPreferences): HardConstraint[] {
  const kept = constraints.filter((c) => !isDerivedLocationConstraint(c))
  const derived = locationOnlyConstraint(preferences)
  return derived ? [...kept, derived] : kept
}

/**
 * Why a mission body is a 400, or null when it is fine. Malformed values that
 * `sanitizeMissionPatch` would silently drop are rejected loudly here instead,
 * so "I set 'only these places' and nothing happened" cannot happen quietly.
 */
export function missionPatchError(body: MissionPatch): string | null {
  const p = body.preferences
  if (p !== undefined && (p === null || typeof p !== 'object' || Array.isArray(p))) return 'preferences must be an object'
  if (!p) return null
  if (p.direction != null && typeof p.direction !== 'string') return 'preferences.direction must be a string or null'
  if (p.direction_mode !== undefined && p.direction_mode !== null && !DIRECTION_MODES.includes(p.direction_mode)) {
    return `preferences.direction_mode must be one of ${DIRECTION_MODES.join(', ')}`
  }
  if (p.locations !== undefined && p.locations !== null) {
    const l = p.locations as Partial<LocationPreference>
    if (typeof l !== 'object' || Array.isArray(l)) return 'preferences.locations must be an object'
    if (!l.mode || !LOCATION_MODES.includes(l.mode)) return `preferences.locations.mode must be one of ${LOCATION_MODES.join(', ')}`
    if (l.regions !== undefined && !Array.isArray(l.regions)) return 'preferences.locations.regions must be an array of strings'
    // Both non-neutral modes need somewhere to point. 'only' with no region
    // would filter out every job; 'prefer' with no region used to be coerced
    // silently back to 'anywhere', so the founder chose a mode, saw "Saved."
    // and got the opposite. Neither is dropped quietly now.
    if (l.mode !== 'anywhere' && !strings(l.regions).length) {
      return l.mode === 'only'
        ? 'preferences.locations.regions cannot be empty when mode is "only" — that would filter out every job'
        : 'preferences.locations.regions cannot be empty when mode is "prefer" — there would be nothing to prefer'
    }
  }
  return null
}

export function sanitizeMissionPatch(patch: MissionPatch, base: MissionBase | CareerMissionPreferences | null = null): Record<string, unknown> {
  // `base` used to be preferences alone; both shapes are accepted so an older
  // caller (and every existing test) keeps working.
  const baseRow: MissionBase | null = base
    ? 'preferences' in base && 'hard_constraints' in base
      ? (base as MissionBase)
      : { preferences: base as CareerMissionPreferences, hard_constraints: [] }
    : null
  const out: Record<string, unknown> = {}
  if (typeof patch.name === 'string' && patch.name.trim()) out.name = patch.name.trim()
  if (typeof patch.objective === 'string' && patch.objective.trim()) out.objective = patch.objective.trim()
  if (typeof patch.season === 'string' && patch.season.trim()) out.season = patch.season.trim()
  if (patch.status && ['draft', 'active', 'paused', 'archived'].includes(patch.status)) out.status = patch.status
  if (patch.preferences && typeof patch.preferences === 'object') {
    const given = Object.fromEntries(Object.entries(patch.preferences).filter(([, v]) => v !== undefined)) as Partial<CareerMissionPreferences>
    out.preferences = sanitizePreferences(baseRow ? { ...baseRow.preferences, ...given } : given)
  }
  if (Array.isArray(patch.hard_constraints)) {
    out.hard_constraints = patch.hard_constraints.filter(
      (c) => c && typeof c === 'object' && typeof c.dimension === 'string' && typeof c.operator === 'string'
    )
  }
  // The enforced "only these places" rule is derived, not typed, so it is
  // rewritten whenever EITHER side of the pair moves — a dial change with no
  // constraints in the patch, or a constraints edit that stripped it.
  const nextPrefs = (out.preferences as CareerMissionPreferences | undefined) ?? baseRow?.preferences ?? null
  if (nextPrefs && (out.preferences !== undefined || out.hard_constraints !== undefined)) {
    const nextConstraints = (out.hard_constraints as HardConstraint[] | undefined) ?? baseRow?.hard_constraints ?? []
    out.hard_constraints = reconcileLocationConstraints(nextConstraints, nextPrefs)
  }
  // Notes are written by a migration and only ever dismissed by the user, so a
  // patch may shorten the array or empty it — never invent a note through here.
  if (Array.isArray(patch.mission_migration_notes)) {
    out.mission_migration_notes = patch.mission_migration_notes.filter(
      (n) => n && typeof n === 'object' && typeof n.kind === 'string' && typeof n.migration === 'string'
    )
  }
  if (patch.fit_weights === null) out.fit_weights = null
  else if (patch.fit_weights && isFitWeights(patch.fit_weights)) {
    const w: Partial<FitWeights> = {}
    for (const d of FIT_DIMENSIONS) if (typeof patch.fit_weights[d] === 'number') w[d] = patch.fit_weights[d]
    out.fit_weights = w
  }
  return out
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((s) => s.trim()) : []
}

/** A location dial, or null when the input is not one. `only` with no region is not a filter — it is nothing. */
export function sanitizeLocations(v: unknown): LocationPreference | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const l = v as Partial<LocationPreference>
  if (!l.mode || !LOCATION_MODES.includes(l.mode)) return null
  const regions = strings(l.regions)
  return regions.length ? { mode: l.mode, regions } : { ...DEFAULT_LOCATION_PREFERENCE }
}

export function sanitizePreferences(p: Partial<CareerMissionPreferences>): CareerMissionPreferences {
  const tiers = Array.isArray(p.geo_tiers)
    ? p.geo_tiers
        .filter((t) => t && typeof t === 'object' && [1, 2, 3].includes(Number(t.tier)))
        .map((t) => ({
          tier: Number(t.tier) as 1 | 2 | 3,
          locations: strings(t.locations),
          ...(typeof t.description === 'string' && t.description.trim() ? { description: t.description.trim() } : {}),
        }))
    : DEFAULT_MISSION_PREFERENCES.geo_tiers
  const direction = sanitizeDirection(p.direction)
  // A mode is only meaningful with something to apply it to.
  const directionMode: DirectionMode | null =
    direction && p.direction_mode && DIRECTION_MODES.includes(p.direction_mode) ? p.direction_mode : direction ? 'boost' : null
  // The dial is authoritative when given. Absent, it is read off the tiers, so a
  // pre-017 row keeps saying exactly what it already said (see missionLocations).
  const given = sanitizeLocations(p.locations)
  const locations = given ?? missionLocations({ locations: undefined, geo_tiers: tiers })
  // The dial and the ranking table can never be allowed to disagree, because
  // code that scores geography reads the TABLE (normalize stamps location_tier
  // from it). So: a dial pointed at 'anywhere' clears the tiers outright — a
  // stale tier from an older write must not keep scoring places up after the
  // person has said place does not matter — and a dial with regions but no
  // authored tiers writes them, so ranking has something to read.
  const geoTiers = given && locations.mode === 'anywhere' ? [] : tiers.length || !given ? tiers : geoTiersForLocations(given)
  const modes = strings(p.work_modes).filter((m): m is 'remote' | 'hybrid' | 'onsite' => ['remote', 'hybrid', 'onsite'].includes(m))
  // Keys this function does not know about but must not destroy. The search
  // ontology stores the user's boost/mute/exclude decisions at
  // `preferences.ontology_overrides` (lib/career/ontology); without this, saving
  // the direction — the control directly above that panel — would erase them.
  const carried: Partial<CareerMissionPreferences> = {}
  const overrides = (p as Record<string, unknown>).ontology_overrides
  if (overrides && typeof overrides === 'object') Object.assign(carried, { ontology_overrides: overrides })
  return {
    ...carried,
    geo_tiers: geoTiers,
    locations,
    company_types: strings(p.company_types),
    role_families: strings(p.role_families),
    industries: strings(p.industries),
    optimize_for: strings(p.optimize_for),
    work_modes: modes.length ? modes : DEFAULT_MISSION_PREFERENCES.work_modes,
    ...(typeof p.notes === 'string' ? { notes: p.notes } : {}),
    ...(direction ? { direction } : {}),
    ...(directionMode ? { direction_mode: directionMode } : {}),
  }
}

const DIRECTION_LINES: Record<Exclude<DirectionMode, 'off'>, string> = {
  boost: 'DIRECTION — BOOST (search hardest here, and still take strong adjacent postings)',
  exclusive: 'DIRECTION — ONLY THIS (restrict discovery and ranking to it; anything else is out of scope)',
}

const NO_DIRECTION_LINE =
  'DIRECTION: none stated — explore broadly from the evidence. Do not assume a role family, an industry, ' +
  'or a place; infer what this person could plausibly do and search wide.'

/** The LOCATIONS line: which of the three behaviours geography has, said once, in words that cannot be confused. */
function renderLocations(p: CareerMissionPreferences): string {
  const l = missionLocations(p)
  if (l.mode === 'anywhere') {
    return (
      'LOCATIONS: ANYWHERE in the United States — no place preference. Where a role is neither counts ' +
      'for it nor against it. Do not put a city in a query and do not prefer one posting over another for where it is.'
    )
  }
  if (l.mode === 'only') {
    // The hard filter is REAL: `locationOnlyConstraint` puts it on the mission's
    // hard_constraints, where applyHardConstraints() rejects postings before fit
    // is ever scored. The prompt may safely say it has already been applied.
    return `LOCATIONS — ONLY THESE (a HARD FILTER, already applied in code; a role outside them is out of scope): ${l.regions.join('; ')}`
  }
  return (
    `LOCATIONS — PREFERRED (a RANKING signal only, never a filter): ${l.regions.join('; ')}. ` +
    'A strong role anywhere else is still in scope and still worth surfacing.'
  )
}

/** Compact rendering for prompts. Every agent that needs the mission reads this, so it is one place. */
export function renderMission(m: Pick<CareerMission, 'objective' | 'season' | 'preferences' | 'hard_constraints'>): string {
  const p = m.preferences
  const direction = sanitizeDirection(p.direction)
  const mode = missionDirectionMode(p)
  const lines: string[] = []
  // The direction leads: it is the first thing every agent reads, it says what
  // it DOES, and the default company types are demoted to examples beneath it.
  if (direction && mode !== 'off') lines.push(`${DIRECTION_LINES[mode]}: ${direction}`)
  else lines.push(NO_DIRECTION_LINE)
  lines.push(`OBJECTIVE: ${m.objective}`, `SEASON: ${m.season}`)
  lines.push(renderLocations(p))
  // Tiers are a ranking table, never a filter — the LOCATIONS line above is the
  // only place a filter is ever stated. `rankingGeoTiers` returns nothing under
  // 'anywhere' whatever the row still holds, so a stale tier cannot leak a city
  // into a prompt that has just said there is no place preference.
  for (const t of rankingGeoTiers(p)) {
    if (!t.locations.length) continue
    lines.push(`GEOGRAPHY RANKING TIER ${t.tier} (soft signal): ${t.locations.join('; ')}${t.description ? ` — ${t.description}` : ''}`)
  }
  if (p.company_types.length) {
    const label =
      direction && mode !== 'off'
        ? 'COMPANY TYPES (default examples — the DIRECTION above takes precedence where they differ)'
        : 'COMPANY TYPES'
    lines.push(`${label}: ${p.company_types.join(', ')}`)
  }
  if (p.industries.length) lines.push(`INDUSTRIES: ${p.industries.join(', ')}`)
  if (p.role_families.length) lines.push(`ROLE FAMILIES (seed): ${p.role_families.join(', ')}`)
  if (p.optimize_for.length) lines.push(`OPTIMIZE FOR (in order): ${p.optimize_for.join(' > ')}`)
  if (p.work_modes.length) lines.push(`WORK MODES: ${p.work_modes.join(', ')}`)
  if (p.notes) lines.push(`${direction && mode !== 'off' ? 'NOTES (defaults — the DIRECTION above takes precedence)' : 'NOTES'}: ${p.notes}`)
  if (m.hard_constraints.length) lines.push(`HARD CONSTRAINTS: ${m.hard_constraints.map((c) => c.label).join('; ')}`)
  return lines.join('\n')
}
