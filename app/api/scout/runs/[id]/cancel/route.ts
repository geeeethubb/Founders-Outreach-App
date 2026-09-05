// POST /api/scout/runs/[id]/cancel — stop a People Scout run.
//
// A QUEUED run is cancelled outright. A RUNNING run is asked to stop; the
// worker sees the request on its next heartbeat or progress write and stops
// at its next step, keeping everything it has found.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { apiError, thrownError, unauthorized } from '@/lib/http/api-error'
import { cancelScoutRun } from '@/lib/career/scout/queue-watchdog'

export const dynamic = 'force-dynamic'

export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return unauthorized()
    const r = await cancelScoutRun(user.id, params.id)
    if (r.error && !r.cancelled) return apiError(r.error === 'run not found' ? 'NOT_FOUND' : 'CONFLICT', r.error, { retryable: false })
    return NextResponse.json({ cancelled: r.cancelled, status: r.status, requested: r.requested, message: r.message })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return thrownError(error)
  }
}
