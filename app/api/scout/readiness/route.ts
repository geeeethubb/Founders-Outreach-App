// GET /api/scout/readiness — can scouting run here?
//
// Both scout pages ask this on load and show "Scouting is unavailable: <why>
// — Fix: <what>" before the founder can start a paid run. `?fresh=1` skips
// the short per-instance cache.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { thrownError, unauthorized } from '@/lib/http/api-error'
import { checkScoutReadiness } from '@/lib/runs/readiness'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return unauthorized()
    const fresh = new URL(request.url).searchParams.get('fresh') === '1'
    const r = await checkScoutReadiness({ fresh })
    return NextResponse.json(r)
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return thrownError(error)
  }
}
