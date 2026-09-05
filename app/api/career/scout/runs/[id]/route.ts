// GET /api/career/scout/runs/[id] — one durable scout run, as the UI reads it.
//
// The poll. See lib/runs/read.ts: it reaps a dead run, dispatches a queued
// leg nothing has dispatched (the chain link), and answers the one shape every
// reader of a run gets. The claim token is never in the response.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { jsonError, thrownError, unauthorized } from '@/lib/http/api-error'
import { readScoutRun } from '@/lib/runs/read'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return unauthorized()
    const r = await readScoutRun(user.id, params.id, { headers: request.headers })
    if (r.kind === 'error') return jsonError(r.error)
    return NextResponse.json({ run: r.run, queueActions: r.actions, redispatched: r.actions.some((a) => a.action === 'redispatched'), reaped: r.actions.filter((a) => a.action === 'reaped') })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return thrownError(error)
  }
}
