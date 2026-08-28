import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { createMission, ensureDefaultMission, listMissions } from '@/lib/career/missions/store'
import { DEFAULT_FIT_WEIGHTS, FIT_DIMENSION_LABELS, FIT_DIMENSION_QUESTIONS } from '@/lib/career/fit/dimensions'
import type { CareerMission } from '@/lib/career/types'

export const dynamic = 'force-dynamic'

/**
 * The user's career missions. Creates the default Summer 2027 mission on first
 * read, so the Jobs page always has something to scout against.
 */
export async function GET() {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const ensured = await ensureDefaultMission(user.id)
    if (ensured.error && !ensured.mission) {
      const missing = /014_career_os/.test(ensured.error)
      return NextResponse.json({ error: ensured.error, migrationMissing: missing }, { status: missing ? 409 : 500 })
    }
    const { missions } = await listMissions(user.id)
    return NextResponse.json({
      missions,
      activeId: ensured.mission?.id ?? null,
      defaults: {
        weights: DEFAULT_FIT_WEIGHTS,
        labels: FIT_DIMENSION_LABELS,
        questions: FIT_DIMENSION_QUESTIONS,
      },
    })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    console.error('missions GET failed:', error)
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = (await request.json()) as Partial<CareerMission>
    const { mission, error } = await createMission(user.id, body)
    if (error || !mission) return NextResponse.json({ error: error ?? 'Failed to create mission' }, { status: 500 })
    return NextResponse.json({ mission })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}
