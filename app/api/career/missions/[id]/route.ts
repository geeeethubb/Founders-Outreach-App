import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { getMission, missionPatchError, updateMission, type MissionPatch } from '@/lib/career/missions/store'

export const dynamic = 'force-dynamic'

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const mission = await getMission(user.id, params.id)
    if (!mission) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ mission })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}

/**
 * Edit preferences, hard constraints, weights, status. Weights changing does
 * not re-run any agent — stored fit components are re-summed on read. A
 * partial `preferences` ({ preferences: { direction } }) merges over the
 * stored preferences; sanitizeMissionPatch drops anything malformed.
 */
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const body = (await request.json().catch(() => null)) as MissionPatch | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'Body must be a JSON object' }, { status: 400 })
    const invalid = missionPatchError(body)
    if (invalid) return NextResponse.json({ error: invalid }, { status: 400 })
    const { mission, error } = await updateMission(user.id, params.id, body)
    if (error || !mission) return NextResponse.json({ error: error ?? 'Update failed' }, { status: 500 })
    return NextResponse.json({ mission })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}
