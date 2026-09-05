// Fault injection for the durable-run KERNEL, the edges: a handoff refused by
// the run's clock or its leg cap, cancel arriving mid-leg and at the handoff,
// an executor that throws, and a self-dispatch that fails. The happy path,
// the token, the reaper, chaining and fencing are in kernel.ts.
//
//   npx tsx scripts/reliability/kernel-edges.ts
//
// Every check asserts PERSISTED STATE on the fake database's row.

process.env.SCOUT_INVOCATION_BUDGET_MS = '3000'

import { runWorkerLeg, type LegInput, type LegOutcome } from '../../lib/runs/worker'
import { MAX_INVOCATIONS } from '../../lib/career/scout/run-store'
import { sweepScoutQueue } from '../../lib/career/scout/queue-watchdog'
import { MAX_QUEUE_WAIT_MS } from '../../lib/career/scout/queue-health'
import { makeChecker, sleep } from './fake-db'
import { enqueue, events, harness } from './kernel-harness'

const t = makeChecker()

// ─── 8. Handoff refused: run deadline, MAX_INVOCATIONS ───────────────────────

async function handoffRefused() {
  console.log('\n8. handoff refused at run_deadline_at and at MAX_INVOCATIONS')
  const continuable = async (input: LegInput): Promise<LegOutcome> => {
    input.onProgress('work', 'working')
    input.onCheckpoint({ stages: ['strategy'] })
    input.onResult({ prospects: [{ name: 'A' }] })
    return { status: 'partial', continuable: true, checkpoint: { stages: ['strategy', 'internal'] }, result: { prospects: [{ name: 'A' }] }, errors: [] }
  }
  {
    const h = harness('outreach', continuable)
    const { runId, token } = await enqueue(h, 'outreach', { runDeadlineMs: 1 })
    await sleep(5)
    const res = await runWorkerLeg({ runId, token }, Date.now(), h.deps)
    const row = h.db.row(runId)
    t.check('run deadline: leg answers partial RUN_DEADLINE', res.body.status === 'partial' && res.body.code === 'RUN_DEADLINE', JSON.stringify(res.body))
    t.check('run deadline: row terminal partial with RUN_DEADLINE', row.status === 'partial' && row.error_code === 'RUN_DEADLINE', `${row.status}/${row.error_code}`)
    t.check('run deadline: the sentence says the run used all its time', /used all the time/.test(String(row.error)), String(row.error))
    t.check('run deadline: remedy recorded', typeof (row.error_detail as { remedy?: string })?.remedy === 'string')
    t.same('run deadline: checkpoint kept', row.checkpoint, { stages: ['strategy', 'internal'] })
    t.same('run deadline: result kept', row.result, { prospects: [{ name: 'A' }] })
    t.check('run deadline: no dispatch, token cleared', h.dispatches.length === 0 && row.claim_token === null && row.worker_id === null)
  }
  {
    const h = harness('outreach', continuable)
    const { runId, token } = await enqueue(h, 'outreach')
    h.db.row(runId).invocation_count = MAX_INVOCATIONS - 1
    const res = await runWorkerLeg({ runId, token }, Date.now(), h.deps)
    const row = h.db.row(runId)
    t.check(`max invocations: claimed as pass ${MAX_INVOCATIONS}`, row.invocation_count === MAX_INVOCATIONS, String(row.invocation_count))
    t.check('max invocations: row terminal partial with RUN_DEADLINE', row.status === 'partial' && row.error_code === 'RUN_DEADLINE' && res.body.status === 'partial', `${row.status}/${row.error_code}`)
    t.check('max invocations: the sentence names the passes', new RegExp(`all ${MAX_INVOCATIONS} passes`).test(String(row.error)), String(row.error))
    t.same('max invocations: checkpoint kept', row.checkpoint, { stages: ['strategy', 'internal'] })
    t.same('max invocations: result kept', row.result, { prospects: [{ name: 'A' }] })
    t.check('max invocations: no dispatch', h.dispatches.length === 0)
  }
}

// ─── 9. Cancel ───────────────────────────────────────────────────────────────

async function cancel() {
  console.log('\n9. cancel')
  {
    let sawStop = false
    const h = harness('outreach', async (input, hh) => {
      input.onProgress('a', 'step a')
      input.onCheckpoint({ stages: ['strategy'] })
      input.onResult({ prospects: [{ name: 'A' }] })
      await sleep(30)
      // Someone presses Cancel: the row says so; the next write returns it.
      hh.db.row(input.runId).cancel_requested = true
      input.onProgress('b', 'step b')
      await sleep(30)
      sawStop = input.shouldStop()
      return { status: 'partial', continuable: true, checkpoint: { stages: ['strategy', 'internal'] }, result: { prospects: [{ name: 'A' }, { name: 'B' }] }, errors: [] }
    })
    const { runId, token } = await enqueue(h, 'outreach')
    const res = await runWorkerLeg({ runId, token }, Date.now(), h.deps)
    const row = h.db.row(runId)
    t.check('mid-leg: the executor saw shouldStop() after the write that returned the flag', sawStop)
    t.check('mid-leg: leg answers cancelled', res.body.status === 'cancelled', JSON.stringify(res.body))
    t.check('mid-leg: row terminal cancelled with CANCELLED', row.status === 'cancelled' && row.error_code === 'CANCELLED', `${row.status}/${row.error_code}`)
    t.same('mid-leg: the result is kept', row.result, { prospects: [{ name: 'A' }, { name: 'B' }] })
    t.same('mid-leg: the checkpoint is kept', row.checkpoint, { stages: ['strategy', 'internal'] })
    t.check('mid-leg: no dispatch, row cleared', h.dispatches.length === 0 && row.worker_id === null && row.claim_token === null && row.lease_expires_at === null)
  }
  {
    const h = harness('outreach', async (input, hh) => {
      input.onProgress('a', 'step a')
      input.onResult({ prospects: [{ name: 'A' }] })
      await sleep(30)
      // Cancel lands AFTER the last fenced write and BEFORE the handoff.
      hh.db.row(input.runId).cancel_requested = true
      return { status: 'partial', continuable: true, checkpoint: { stages: ['strategy'] }, result: { prospects: [{ name: 'A' }] }, errors: [] }
    })
    const { runId, token } = await enqueue(h, 'outreach')
    const res = await runWorkerLeg({ runId, token }, Date.now(), h.deps)
    const row = h.db.row(runId)
    t.check('at handoff: leg answers cancelled', res.body.status === 'cancelled', JSON.stringify(res.body))
    t.check(
      'at handoff: row terminal cancelled (DEFECT if running: worker.ts:318 calls failQueuedRun, whose guard is status=queued, on a row handoffScoutRun left running)',
      row.status === 'cancelled' && row.error_code === 'CANCELLED',
      `${row.status}/${row.error_code ?? 'null'} worker_id=${row.worker_id}`
    )
    t.same('at handoff: the result is kept', row.result, { prospects: [{ name: 'A' }] })
    t.check('at handoff: no dispatch', h.dispatches.length === 0, String(h.dispatches.length))
    t.check('at handoff: worker_id and lease cleared', row.worker_id === null && row.lease_expires_at === null, JSON.stringify({ w: row.worker_id, l: row.lease_expires_at }))
  }
}

// ─── 10. Unexpected throw ────────────────────────────────────────────────────

async function unexpectedThrow() {
  console.log('\n10. unexpected throw in the executor')
  const cases: { name: string; error: Error; code: string }[] = [
    { name: 'network fault', error: new Error('fetch failed: ECONNRESET while calling apollo'), code: 'PROVIDER_TIMEOUT' },
    { name: 'plain error', error: new Error('boom'), code: 'INTERNAL' },
    { name: 'missing column', error: new Error('column scouting_runs.checkpoint does not exist'), code: 'SCHEMA_MIGRATION' },
    { name: 'rate limit', error: Object.assign(new Error('too many requests'), { status: 429 }), code: 'PROVIDER_RATE_LIMIT' },
  ]
  for (const c of cases) {
    const h = harness('outreach', async (input) => {
      input.onProgress('research', 'researching')
      input.onCheckpoint({ stages: ['strategy'] })
      input.onResult({ prospects: [{ name: 'A' }] })
      await sleep(20)
      throw c.error
    })
    const { runId, token } = await enqueue(h, 'outreach')
    const res = await runWorkerLeg({ runId, token }, Date.now(), h.deps)
    const row = h.db.row(runId)
    t.check(`${c.name}: row terminal failed with ${c.code}`, row.status === 'failed' && row.error_code === c.code && res.body.code === c.code, `${row.status}/${row.error_code} (body ${res.body.code})`)
    t.check(`${c.name}: the message is the thrown one`, String(row.error).includes(c.error.message), String(row.error))
    t.same(`${c.name}: latest checkpoint kept`, row.checkpoint, { stages: ['strategy'] })
    t.same(`${c.name}: latest result kept`, row.result, { prospects: [{ name: 'A' }] })
    t.check(`${c.name}: row cleared, no dispatch`, row.worker_id === null && row.claim_token === null && row.lease_expires_at === null && h.dispatches.length === 0)
    t.check(`${c.name}: stats.errors carries the throw`, Array.isArray((row.stats as { errors?: string[] })?.errors) && (row.stats as { errors: string[] }).errors.some((e) => e.includes(c.error.message)), JSON.stringify(row.stats))
  }
}

// ─── 11. Dispatch fails at handoff; the watchdog picks it up ─────────────────

async function dispatchFailsAtHandoff() {
  console.log('\n11. dispatch fails at handoff')
  const h = harness(
    'job_scout',
    async (input) => {
      input.onProgress('discover', 'listing')
      input.onCursor({ stages: ['plan'], strategies: [], companies: [], families: [], pages: {} })
      return { status: 'partial', continuable: true, cursor: { stages: ['plan'], strategies: ['s1'], companies: [], families: [], pages: {} }, errors: [] }
    },
    {
      dispatch: (hh) => async (_t, runId, token) => {
        hh.dispatches.push({ runId, token })
        return { dispatched: false, outcome: 'failed', status: 401, error: 'the worker refused the request (HTTP 401 at http://fake.test/api/scout/worker) — Deployment Protection', latencyMs: 12 }
      },
    }
  )
  const { runId, token } = await enqueue(h, 'job_scout')
  const res = await runWorkerLeg({ runId, token }, Date.now(), h.deps)
  const row = h.db.row(runId)
  t.check('leg answers queued with dispatch failed', res.body.status === 'queued' && res.body.dispatch === 'failed' && res.body.nextClaimed === false, JSON.stringify(res.body))
  t.check('row stays queued with a token', row.status === 'queued' && typeof row.claim_token === 'string' && row.invocation_count === 1, `${row.status}/${row.invocation_count}`)
  t.check('recordDispatchOutcome wrote error_code DISPATCH', row.error_code === 'DISPATCH', String(row.error_code))
  t.check('recordDispatchOutcome wrote last_error with the cause', /HTTP 401/.test(String(row.last_error)), String(row.last_error))
  t.check('error_detail names the handoff source and attempt 1', (row.error_detail as { source?: string; attempt?: number })?.source === 'handoff' && (row.error_detail as { attempt?: number })?.attempt === 1, JSON.stringify(row.error_detail))
  const ev = events(row)
  t.check('a dispatch event was appended', ev.some((e) => e.stage === 'dispatch' && /failed/.test(e.detail)), JSON.stringify(ev.slice(-2)))
  t.check('attempt_count 1 after the failed handoff dispatch', row.attempt_count === 1, String(row.attempt_count))
  const cursor = (row.params as { cursor?: { strategies?: string[] } }).cursor
  t.check('the cursor the leg reached is on the row', cursor?.strategies?.[0] === 's1', JSON.stringify(cursor))

  // The next sweep. The failed self-dispatch already counted as attempt 1, so
  // the verdict is not 'chain' (attempt_count 0); the row waits MAX_QUEUE_WAIT
  // and is then redispatched by the watchdog.
  const sweeps: { runId: string; token: string }[] = []
  const dispatch = async (id: string, tok: string) => {
    sweeps.push({ runId: id, token: tok })
    return { dispatched: true, error: null, status: null, outcome: 'pending' as const }
  }
  const queuedAt = Date.parse(String(row.queued_at))
  const early = await sweepScoutQueue('u1', { db: h.db, now: queuedAt + 1_000, dispatch })
  t.check('a sweep 1 s later does not fail the run', h.db.row(runId).status === 'queued' && !early.actions.some((a) => a.action === 'failed'), JSON.stringify(early.actions))
  const later = await sweepScoutQueue('u1', { db: h.db, now: queuedAt + MAX_QUEUE_WAIT_MS + 1_000, dispatch })
  const after = h.db.row(runId)
  t.check('the watchdog redispatches it after the queue wait', later.actions.some((a) => a.runId === runId && a.action === 'redispatched') && sweeps.length === 1 && sweeps[0].token === row.claim_token, JSON.stringify(later.actions))
  t.check('attempt_count 2 after the watchdog dispatch, still queued', after.attempt_count === 2 && after.status === 'queued', `${after.attempt_count}/${after.status}`)
  t.check('the watchdog recorded its dispatch on the row', events(after).some((e) => e.stage === 'dispatch' && /watchdog/.test(e.detail)), JSON.stringify(events(after).slice(-1)))
  t.check('the row was never failed', after.status !== 'failed')
}


async function main() {
  const started = Date.now()
  await handoffRefused()
  await cancel()
  await unexpectedThrow()
  await dispatchFailsAtHandoff()
  console.log(`\n(${((Date.now() - started) / 1000).toFixed(1)}s)`)
  t.finish('kernel-edges')
}

main().catch((e) => {
  console.error('kernel-edges suite crashed', e)
  process.exitCode = 1
})
