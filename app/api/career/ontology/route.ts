import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { listMissions } from '@/lib/career/missions/store'
import { loadEvidenceBank } from '@/lib/career/evidence/store'
import {
  applyOntologyOverrides, buildSearchOntology, clearOntologyOverride, normalizeOverride,
  readOntologyOverrides, recordOntologyOverride, withOntologyOverrides,
  ONTOLOGY_KINDS, type OntologyKind, type OntologyOverrides, type SearchOntology,
} from '@/lib/career/ontology'
import type { CareerMission } from '@/lib/career/types'

export const dynamic = 'force-dynamic'

/**
 * The search ontology: what the Evidence Bank says is worth searching for, and
 * the user's corrections to it.
 *
 *   GET    build it and apply the stored overrides
 *   PATCH  record one BOOST / MUTE / EXCLUDE / ADD (or 'clear' to forget one)
 *
 * The overrides live on `career_missions.preferences.ontology_overrides`. V1
 * owns that column and `sanitizePreferences` drops keys it does not know, so
 * the write here is a read-modify-write of the preferences jsonb rather than a
 * call through `updateMission` — and it merges, so a concurrent edit to the
 * direction or the geo tiers is never wiped by an ontology click.
 */

async function activeMission(userId: string): Promise<{ mission: CareerMission | null; migrationMissing: boolean; error: string | null }> {
  const { missions, migrationMissing, error } = await listMissions(userId)
  if (migrationMissing || error) return { mission: null, migrationMissing, error }
  return { mission: missions.find((m) => m.status === 'active') ?? missions[0] ?? null, migrationMissing: false, error: null }
}

async function buildFor(userId: string, mission: CareerMission | null): Promise<{
  ontology: SearchOntology
  overrides: OntologyOverrides
  bank: { canonical: boolean; errors: string[]; migrationMissing: boolean }
}> {
  const { bank, canonical, errors, migrationMissing } = await loadEvidenceBank(userId)
  const overrides = readOntologyOverrides(mission?.preferences)
  const ontology = applyOntologyOverrides(buildSearchOntology({ bank, mission }), overrides)
  return { ontology, overrides, bank: { canonical, errors, migrationMissing } }
}

export async function GET() {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { mission, migrationMissing, error } = await activeMission(user.id)
    if (migrationMissing) return NextResponse.json({ error: 'migration 014_career_os.sql has not been applied', migrationMissing: true }, { status: 409 })
    if (error) return NextResponse.json({ error }, { status: 500 })

    const built = await buildFor(user.id, mission)
    return NextResponse.json({
      ontology: built.ontology,
      overrides: built.overrides,
      mission: mission ? { id: mission.id, name: mission.name, direction: mission.preferences?.direction ?? null } : null,
      bank: built.bank,
    })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    console.error('ontology GET failed:', error)
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}

interface PatchBody {
  missionId?: string
  kind?: string
  id?: string
  /** 'clear' forgets every decision about the entry; the rest are stored. */
  action?: string
  label?: string
  titleVariants?: string[]
  note?: string
}

export async function PATCH(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = (await request.json().catch(() => null)) as PatchBody | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'Body must be a JSON object' }, { status: 400 })
    if (!ONTOLOGY_KINDS.includes(body.kind as OntologyKind)) {
      return NextResponse.json({ error: `kind must be one of: ${ONTOLOGY_KINDS.join(', ')}` }, { status: 400 })
    }
    const kind = body.kind as OntologyKind

    const { mission, migrationMissing, error } = await activeMission(user.id)
    if (migrationMissing) return NextResponse.json({ error: 'migration 014_career_os.sql has not been applied', migrationMissing: true }, { status: 409 })
    if (error) return NextResponse.json({ error }, { status: 500 })
    const target = body.missionId && mission?.id !== body.missionId
      ? (await listMissions(user.id)).missions.find((m) => m.id === body.missionId) ?? null
      : mission
    if (!target) return NextResponse.json({ error: 'No mission to store the override on' }, { status: 404 })

    const current = readOntologyOverrides(target.preferences)
    let next: OntologyOverrides
    if (body.action === 'clear') {
      const id = (body.id ?? '').trim()
      if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
      next = clearOntologyOverride(current, kind, id)
    } else {
      const override = normalizeOverride({
        id: body.id, kind, action: body.action, label: body.label,
        titleVariants: body.titleVariants, note: body.note, at: new Date().toISOString(),
      })
      if (!override) return NextResponse.json({ error: 'action must be boost, mute, exclude, add or clear, with an id (or, for add, a label)' }, { status: 400 })
      next = recordOntologyOverride(current, override)
    }

    // Merge into the stored preferences; never replace them.
    const service = createServiceClient()
    const preferences = withOntologyOverrides(target.preferences as unknown as Record<string, unknown>, next)
    const { error: writeError } = await service
      .from('career_missions')
      .update({ preferences } as never)
      .eq('user_id', user.id)
      .eq('id', target.id)
    if (writeError) return NextResponse.json({ error: writeError.message }, { status: 500 })

    const built = await buildFor(user.id, { ...target, preferences: preferences as unknown as CareerMission['preferences'] })
    return NextResponse.json({ ontology: built.ontology, overrides: built.overrides, mission: { id: target.id, name: target.name } })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    console.error('ontology PATCH failed:', error)
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}
