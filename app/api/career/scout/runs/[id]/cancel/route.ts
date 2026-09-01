import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { cancelScoutRun } from '@/lib/career/scout/queue-watchdog'

export const dynamic = 'force-dynamic'

/**
 * POST → stop this run.
 *
 * A QUEUED run is cancelled outright: nothing has started, so there is nothing
 * to wind down and no reason to make the founder wait.
 *
 * A RUNNING run is asked to stop — `cancel_requested` is set and the worker
 * checks it between expensive stages. It is not killed mid-stage, because a
 * stage that is halfway through writing findings should finish that write; the
 * lease and the reaper are what handle a worker that ignores the request.
 */
export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const r = await cancelScoutRun(user.id, params.id)
    if (r.error && !r.cancelled) {
      return NextResponse.json({ error: r.error }, { status: r.error === 'run not found' ? 404 : 409 })
    }
    return NextResponse.json({ cancelled: r.cancelled, status: r.status, requested: r.requested, message: r.message })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}
