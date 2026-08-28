import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { runJobScout } from '@/lib/career/scout/orchestrator'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Vercel's function ceiling is 300s; the run must finish AND persist inside
// it, so the deadline is 270s and the caps are conservative. The CLI
// (scripts/career-scout.ts) has no ceiling and takes the full defaults.
const ROUTE_DEADLINE_MS = 270_000
const CAPS = { strategies: 2, rounds: 2, companies: 20, extract: 30 }

function clamp(v: unknown, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fallback
  return Math.max(0, Math.min(max, n))
}

/** POST { missionId?, strategies?, rounds?, companies?, extract?, verify? } → JobScoutResult */
export async function POST(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = ((await request.json().catch(() => ({}))) ?? {}) as { missionId?: string | null; strategies?: number; rounds?: number; companies?: number; extract?: number; verify?: boolean }
    const result = await runJobScout({
      userId: user.id,
      missionId: body.missionId ?? null,
      budget: { deadlineMs: ROUTE_DEADLINE_MS },
      maxStrategies: clamp(body.strategies, CAPS.strategies, CAPS.strategies),
      maxRoundsPerStrategy: clamp(body.rounds, CAPS.rounds, CAPS.rounds),
      maxCompaniesFirst: clamp(body.companies, CAPS.companies, CAPS.companies),
      maxExtract: clamp(body.extract, CAPS.extract, CAPS.extract),
      verify: body.verify !== false,
      label: 'job scout · web',
    })
    if (result.migrationMissing) {
      return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true, result }, { status: 409 })
    }
    return NextResponse.json(result)
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}
