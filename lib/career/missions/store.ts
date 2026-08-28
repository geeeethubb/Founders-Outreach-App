// Career missions — persistence and the default mission.
//
// A mission is the unit of intent for a job search (docs/CAREER_OS.md §2).
// Preferences are editable data, never code: the geographic tiers, company
// types and optimization priorities below are the SEED for the first mission
// row, not rules anything reads directly.

import { createServiceClient } from '@/lib/supabase/server'
import { FIT_DIMENSIONS, type CareerMission, type CareerMissionPreferences, type FitWeights, type HardConstraint } from '../types'
import { isFitWeights } from '../fit/dimensions'

function isMissingSchema(message: string): boolean {
  return /relation .* does not exist|column .* does not exist|schema cache|could not find/i.test(message)
}

/** The founder's stated initial mission, as data. */
export const DEFAULT_MISSION_PREFERENCES: CareerMissionPreferences = {
  geo_tiers: [
    { tier: 1, locations: ['San Francisco / Bay Area', 'New York City'] },
    {
      tier: 2,
      locations: ['Boston', 'Seattle', 'Los Angeles', 'Washington DC'],
      description: 'other large, vibrant East or West Coast cities — genuinely strong urban markets',
    },
  ],
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
    'location',
    'company quality',
    'mission relevance',
  ],
  work_modes: ['onsite', 'hybrid', 'remote'],
  notes:
    'Do not equate prestige with quality. Learn adjacent categories rather than filtering on these strings. ' +
    'Roles may span technical, engineering, technical strategy, product, industrial innovation, operations ' +
    'technology, AI/manufacturing, analytical, or cross-functional work — infer plausible roles from the evidence bank.',
}

export const DEFAULT_HARD_CONSTRAINTS: HardConstraint[] = [
  { dimension: 'employment_type', operator: 'in', value: ['internship', 'co_op'], label: 'Internships only' },
  { dimension: 'season', operator: 'not_equals', value: 'other_season', label: 'Not a different season' },
  { dimension: 'location_country', operator: 'in', value: ['US', 'United States', ''], label: 'United States' },
]

export function defaultMission(userId: string): Omit<CareerMission, 'id' | 'created_at' | 'updated_at'> {
  return {
    user_id: userId,
    name: 'Summer 2027 Internships',
    objective:
      'Find high-quality Summer 2027 internships where I will learn fast, own real work, and sit with ' +
      'intelligent colleagues on technically interesting, important problems — in the Bay Area or New York ' +
      'first, other strong coastal cities second.',
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
  input: Partial<Omit<CareerMission, 'id' | 'user_id' | 'created_at' | 'updated_at'>>
): Promise<{ mission: CareerMission | null; error: string | null }> {
  const supabase = createServiceClient()
  const row = { ...defaultMission(userId), ...sanitizeMissionPatch(input) }
  const { data, error } = await supabase.from('career_missions').insert(row as never).select('*').single()
  return { mission: (data as CareerMission | null) ?? null, error: error?.message ?? null }
}

export async function updateMission(
  userId: string,
  id: string,
  patch: Partial<CareerMission>
): Promise<{ mission: CareerMission | null; error: string | null }> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('career_missions')
    .update(sanitizeMissionPatch(patch) as never)
    .eq('user_id', userId)
    .eq('id', id)
    .select('*')
    .single()
  return { mission: (data as CareerMission | null) ?? null, error: error?.message ?? null }
}

/** Only known columns, only well-formed values. Malformed input is dropped, not coerced. */
export function sanitizeMissionPatch(patch: Partial<CareerMission>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (typeof patch.name === 'string' && patch.name.trim()) out.name = patch.name.trim()
  if (typeof patch.objective === 'string' && patch.objective.trim()) out.objective = patch.objective.trim()
  if (typeof patch.season === 'string' && patch.season.trim()) out.season = patch.season.trim()
  if (patch.status && ['draft', 'active', 'paused', 'archived'].includes(patch.status)) out.status = patch.status
  if (patch.preferences && typeof patch.preferences === 'object') out.preferences = sanitizePreferences(patch.preferences)
  if (Array.isArray(patch.hard_constraints)) {
    out.hard_constraints = patch.hard_constraints.filter(
      (c) => c && typeof c === 'object' && typeof c.dimension === 'string' && typeof c.operator === 'string'
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
  const modes = strings(p.work_modes).filter((m): m is 'remote' | 'hybrid' | 'onsite' => ['remote', 'hybrid', 'onsite'].includes(m))
  return {
    geo_tiers: tiers,
    company_types: strings(p.company_types),
    role_families: strings(p.role_families),
    industries: strings(p.industries),
    optimize_for: strings(p.optimize_for),
    work_modes: modes.length ? modes : DEFAULT_MISSION_PREFERENCES.work_modes,
    ...(typeof p.notes === 'string' ? { notes: p.notes } : {}),
  }
}

/** Compact rendering for prompts. Every agent that needs the mission reads this, so it is one place. */
export function renderMission(m: Pick<CareerMission, 'objective' | 'season' | 'preferences' | 'hard_constraints'>): string {
  const p = m.preferences
  const lines: string[] = [`OBJECTIVE: ${m.objective}`, `SEASON: ${m.season}`]
  for (const t of p.geo_tiers) {
    lines.push(`GEOGRAPHY TIER ${t.tier}: ${t.locations.join('; ')}${t.description ? ` — ${t.description}` : ''}`)
  }
  if (p.company_types.length) lines.push(`COMPANY TYPES: ${p.company_types.join(', ')}`)
  if (p.industries.length) lines.push(`INDUSTRIES: ${p.industries.join(', ')}`)
  if (p.role_families.length) lines.push(`ROLE FAMILIES (seed): ${p.role_families.join(', ')}`)
  if (p.optimize_for.length) lines.push(`OPTIMIZE FOR (in order): ${p.optimize_for.join(' > ')}`)
  if (p.work_modes.length) lines.push(`WORK MODES: ${p.work_modes.join(', ')}`)
  if (p.notes) lines.push(`NOTES: ${p.notes}`)
  if (m.hard_constraints.length) lines.push(`HARD CONSTRAINTS: ${m.hard_constraints.map((c) => c.label).join('; ')}`)
  return lines.join('\n')
}
