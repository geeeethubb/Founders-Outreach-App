// GET /api/scout/runs?active=1&limit=5 — the People Scout's runs.
//
// `active` is the newest run the server itself calls queued or running, so a
// refresh, a second tab or a reopened page resumes the same run instead of
// paying for another. `runs` is the recent history (newest first); the page
// restores the latest finished run from here, not from the browser's storage.

import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { apiError, thrownError, unauthorized } from '@/lib/http/api-error'
import { isMissingSchema } from '@/lib/career/jobs/db'
import { activeScoutRun, isDurableRow, liveRunStoreDb, toRunView, type ScoutRunRow } from '@/lib/career/scout/run-store'
import { sweepScoutQueue } from '@/lib/career/scout/queue-watchdog'
import { resolveWorkerBase } from '@/lib/career/scout/worker-target'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return unauthorized()

    const p = new URL(request.url).searchParams
    const limit = Math.min(20, Math.max(1, Number(p.get('limit')) || 5))
    const wantActive = p.get('active') === '1'

    // Self-heal on read, like every other scout read.
    const swept = await sweepScoutQueue(user.id, { target: resolveWorkerBase(request.headers) })
    if (swept.migrationMissing) return apiError('SCHEMA_MIGRATION', 'The database predates the durable-run migrations.', { remedy: 'Apply supabase/migrations/016, 020 and 021 in the Supabase SQL editor.' })

    const db = liveRunStoreDb(createServiceClient())
    const { rows, error } = await db.listRuns(user.id, ['queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled'], limit, ['outreach'])
    if (error) return apiError(isMissingSchema(error) ? 'SCHEMA_MIGRATION' : 'DATABASE', error)
    // Only the queue's own rows: a CLI run that is still writing its own row is not something the page should attach to.
    const runs = (rows as ScoutRunRow[]).filter((r) => isDurableRow(r)).map((r) => toRunView(r))

    let active = null
    if (wantActive) {
      const a = await activeScoutRun(user.id, 'outreach')
      if (a.run) active = toRunView(a.run)
    }
    return NextResponse.json({ runs, active, durable: true })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return thrownError(error)
  }
}
