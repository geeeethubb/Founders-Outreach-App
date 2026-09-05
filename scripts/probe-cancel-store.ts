// Live probe (throwaway row, no model calls, no dispatch): does a fenced
// heartbeat on the FOUNDER'S database report cancel_requested to the worker
// that holds the leg?
//
//   npx tsx scripts/probe-cancel-store.ts
//
// Enqueues a throwaway outreach run with a label that says so, claims it as a
// worker at once (so no sweep can dispatch it), asks it to stop through the
// same function the cancel route uses, heartbeats as that worker, prints what
// the heartbeat said, then closes the row as cancelled — also on any error.
import { config } from 'dotenv'
import path from 'path'
config({ path: path.resolve(process.cwd(), '.env.local') })

import { createServiceClient } from '../lib/supabase/server'
import { liveRunStoreDb } from '../lib/career/scout/run-store-db'
import { claimScoutRun, enqueueScoutRun, finishScoutRun, touchScoutRun, recordProgress } from '../lib/career/scout/run-store'
import { cancelScoutRun } from '../lib/career/scout/queue-watchdog'
import { defaultProfiles } from './lib/cli-user'

async function main(): Promise<void> {
  const { data: profiles } = await defaultProfiles()
  if (profiles.length !== 1) throw new Error(`expected exactly one profile, found ${profiles.length}`)
  const userId = profiles[0].id
  const db = liveRunStoreDb(createServiceClient())
  const q = await enqueueScoutRun(userId, { kind: 'outreach', params: { goal: 'probe' }, label: 'probe/cancel-store (throwaway)', runDeadlineMs: 60_000 }, db)
  if (!q.runId || !q.claimToken) throw new Error(`enqueue failed: ${JSON.stringify(q)}`)
  const runId = q.runId
  console.log('enqueued', runId)
  let closed = false
  try {
    const claim = await claimScoutRun(runId, q.claimToken, db, { deadlineMs: 60_000, workerId: 'w_probe' })
    console.log('claimed', claim.claimed, 'worker', claim.workerId)
    const before = await touchScoutRun(runId, { db, workerId: 'w_probe' })
    console.log('heartbeat before cancel →', JSON.stringify(before))
    const c = await cancelScoutRun(userId, runId)
    console.log('cancel →', JSON.stringify(c))
    const after = await touchScoutRun(runId, { db, workerId: 'w_probe' })
    console.log('heartbeat after cancel →', JSON.stringify(after))
    const prog = await recordProgress(runId, { stage: 'probe', detail: 'progress write after cancel' }, { db, workerId: 'w_probe' })
    console.log('progress write after cancel →', JSON.stringify(prog))
    const raw = await db.getRun(runId, userId)
    console.log('row →', JSON.stringify({ status: raw.row?.status, cancel_requested: raw.row?.cancel_requested, worker_id: raw.row?.worker_id }))
    const fin = await finishScoutRun(runId, 'cancelled', { workerId: 'w_probe', error: 'probe closed', errorCode: 'CANCELLED' }, db)
    closed = fin.ok
    console.log('closed →', JSON.stringify(fin))
  } finally {
    if (!closed) {
      const fin = await finishScoutRun(runId, 'cancelled', { error: 'probe closed after an error', errorCode: 'CANCELLED', force: true }, db).catch((e) => ({ ok: false, error: String(e) }))
      console.log('cleanup →', JSON.stringify(fin))
    }
  }
}

main().catch((e) => {
  console.error('PROBE FAILED', e)
  process.exitCode = 1
})
