// POST /api/career/scout/runs/[id]/cancel — stop a Job Scout run.
//
// A QUEUED run is cancelled outright: nothing has started, so there is nothing
// to wind down and no reason to make the founder wait.
//
// A RUNNING run is asked to stop — `cancel_requested` is set and the worker
// sees it on its next heartbeat or progress write and stops at its next step,
// keeping everything it has found. It is not killed mid-stage, because a stage
// halfway through writing findings should finish that write; the lease and the
// reaper are what handle a worker that ignores the request.
//
// Answers speak the lib/runs/errors.ts contract like every other scouting
// route, so the panel can tell "run not found" from a state conflict by code.
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
    if (r.error && !r.cancelled) {
      return apiError(r.error === 'run not found' ? 'NOT_FOUND' : 'CONFLICT', r.error, { retryable: false })
    }
    return NextResponse.json({ cancelled: r.cancelled, status: r.status, requested: r.requested, message: r.message })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return thrownError(error)
  }
}
