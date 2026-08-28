// Evidence preferences — the user's stated priorities as rows.
//
// `evidence_preferences` is the editable, per-value view of what a mission's
// jsonb preferences say in bulk: one row per (category, value) with a weight
// and a hard-constraint flag. The seed writes DEFAULT_MISSION_PREFERENCES
// here once; the Evidence page edits the rows; nothing regenerates them.

import { createServiceClient } from '@/lib/supabase/server'
import { DEFAULT_MISSION_PREFERENCES } from '../missions/store'
import { isMissingSchema } from './store'
import type { EvidencePreference } from '../types'

export interface PreferenceInput {
  category: string
  value: string
  weight?: number
  hard_constraint?: boolean
  note?: string | null
}

export async function listPreferences(
  userId: string,
  category?: string
): Promise<{ preferences: EvidencePreference[]; error: string | null; migrationMissing: boolean }> {
  const supabase = createServiceClient()
  let q = supabase.from('evidence_preferences').select('*').eq('user_id', userId).order('category').order('weight', { ascending: false })
  if (category) q = q.eq('category', category)
  const { data, error } = await q
  if (error) return { preferences: [], error: error.message, migrationMissing: isMissingSchema(error.message) }
  return { preferences: (data ?? []) as EvidencePreference[], error: null, migrationMissing: false }
}

function clampWeight(w: unknown): number {
  const n = typeof w === 'number' && Number.isFinite(w) ? w : 0.5
  return Math.min(1, Math.max(0, Math.round(n * 1000) / 1000))
}

/**
 * Insert or update by (category, value). The table has no unique constraint
 * on the pair — a value can legitimately be re-stated with a note — so this
 * matches case-insensitively in code and updates the first hit.
 */
export async function upsertPreferences(
  userId: string,
  inputs: PreferenceInput[]
): Promise<{ inserted: number; updated: number; skipped: number; error: string | null; migrationMissing: boolean }> {
  const { preferences, error, migrationMissing } = await listPreferences(userId)
  if (error) return { inserted: 0, updated: 0, skipped: 0, error, migrationMissing }
  const supabase = createServiceClient()
  let inserted = 0
  let updated = 0
  let skipped = 0
  for (const p of inputs) {
    const category = p.category.trim()
    const value = p.value.trim()
    if (!category || !value) {
      skipped++
      continue
    }
    const existing = preferences.find(
      (e) => e.category === category && e.value.toLowerCase() === value.toLowerCase()
    )
    const patch = {
      weight: clampWeight(p.weight ?? existing?.weight ?? 0.5),
      hard_constraint: p.hard_constraint ?? existing?.hard_constraint ?? false,
      note: p.note === undefined ? existing?.note ?? null : p.note,
    }
    if (existing) {
      const { error: e } = await supabase.from('evidence_preferences').update(patch as never).eq('id', existing.id)
      if (e) return { inserted, updated, skipped, error: e.message, migrationMissing: isMissingSchema(e.message) }
      updated++
    } else {
      const { error: e } = await supabase
        .from('evidence_preferences')
        .insert({ user_id: userId, category, value, ...patch } as never)
      if (e) return { inserted, updated, skipped, error: e.message, migrationMissing: isMissingSchema(e.message) }
      inserted++
    }
  }
  return { inserted, updated, skipped, error: null, migrationMissing: false }
}

/**
 * The founder's mission preferences as rows: tier-1 locations at 1.0, tier-2
 * at 0.7, company types at 0.6, and `optimize_for` with descending weights in
 * the order stated. Rows that already exist are left alone — the seed never
 * overwrites an edit.
 */
export function defaultPreferenceRows(): PreferenceInput[] {
  const rows: PreferenceInput[] = []
  const p = DEFAULT_MISSION_PREFERENCES
  for (const tier of p.geo_tiers) {
    const weight = tier.tier === 1 ? 1.0 : tier.tier === 2 ? 0.7 : 0.4
    for (const loc of tier.locations) rows.push({ category: 'location', value: loc, weight, note: `tier ${tier.tier}` })
  }
  for (const t of p.company_types) rows.push({ category: 'company_type', value: t, weight: 0.6 })
  p.optimize_for.forEach((v, i) => {
    const weight = Math.max(0.3, 1 - i * (0.7 / Math.max(1, p.optimize_for.length - 1)))
    rows.push({ category: 'optimize_for', value: v, weight: Math.round(weight * 100) / 100 })
  })
  for (const m of p.work_modes) rows.push({ category: 'work_mode', value: m, weight: 0.5 })
  return rows
}

export async function seedDefaultPreferences(
  userId: string
): Promise<{ inserted: number; skipped: number; error: string | null; migrationMissing: boolean }> {
  const { preferences, error, migrationMissing } = await listPreferences(userId)
  if (error) return { inserted: 0, skipped: 0, error, migrationMissing }
  const have = new Set(preferences.map((e) => `${e.category}::${e.value.toLowerCase()}`))
  const fresh = defaultPreferenceRows().filter((r) => !have.has(`${r.category}::${r.value.toLowerCase()}`))
  const skipped = defaultPreferenceRows().length - fresh.length
  if (fresh.length === 0) return { inserted: 0, skipped, error: null, migrationMissing: false }
  const supabase = createServiceClient()
  const { error: e } = await supabase.from('evidence_preferences').insert(
    fresh.map((r) => ({
      user_id: userId,
      category: r.category,
      value: r.value,
      weight: clampWeight(r.weight),
      hard_constraint: r.hard_constraint ?? false,
      note: r.note ?? null,
    })) as never[]
  )
  if (e) return { inserted: 0, skipped, error: e.message, migrationMissing: isMissingSchema(e.message) }
  return { inserted: fresh.length, skipped, error: null, migrationMissing: false }
}
