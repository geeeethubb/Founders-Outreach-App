// GET /api/scout/runs/[id] — one People Scout run, as the page reads it.
//
// `?result=1` includes the persisted result payload (prospects, funnel, the
// internal-first decision). The page asks for it when the run is terminal and
// every few polls while it runs, so a run that stops short still shows what it
// found without shipping the payload on every tick.

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
    const withResult = new URL(request.url).searchParams.get('result') === '1'
    const r = await readScoutRun(user.id, params.id, { headers: request.headers, withResult })
    if (r.kind === 'error') return jsonError(r.error)
    return NextResponse.json({ run: r.run, queueActions: r.actions })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return thrownError(error)
  }
}
