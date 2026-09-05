// Fault injection for the queue watchdog, the cancel path and the reaper:
// sweepScoutQueue, queueVerdict, cancelScoutRun, reapStaleRuns.
//
//   npx tsx scripts/reliability/watchdog.ts
//
// Fake clock throughout (`now:`), so "ten minutes queued" costs nothing. Every
// check reads the row the fake database holds afterwards.

// Pulseless ceilings derive from the invocation budget; pin it so the cases
// below are exact whatever machine runs them.
process.env.SCOUT_INVOCATION_BUDGET_MS = '60000'

import { sweepScoutQueue, cancelScoutRun } from '../../lib/career/scout/queue-watchdog'
import { queueVerdict, redispatchDue, HARD_QUEUE_CEILING_MS, MAX_QUEUE_WAIT_MS, MAX_START_ATTEMPTS, REDISPATCH_SPACING_MS } from '../../lib/career/scout/queue-health'
import { reapStaleRuns } from '../../lib/career/scout/run-reaper'
import { isRunStale, LEASE_GRACE_MS, LEASE_MS, DEFAULT_STALE_MS, pulselessCeilingMs, type ScoutRunRow } from '../../lib/career/scout/run-record'
import { createFakeRunStoreDb, makeChecker, iso, type Row } from './fake-db'

const t = makeChecker()
const NOW = 1_800_000_000_000
const ago = (ms: number) => iso(NOW - ms)
const BUDGET_MS = 60_000

function queuedRow(over: Row = {}): Row {
  return { user_id: 'u1', kind: 'job_scout', status: 'queued', stage: 'queued', claim_token: 'tok', started_at: ago(0), queued_at: ago(0), heartbeat_at: ago(0), attempt_count: 0, invocation_count: 0, progress: { stage: 'queued', detail: 'waiting', counts: {}, events: [] }, ...over }
}

function dispatcher() {
  const calls: { runId: string; token: string }[] = []
  const dispatch = async (runId: string, token: string) => {
    calls.push({ runId, token })
    return { dispatched: true, error: null, status: null, outcome: 'pending' as const }
  }
  return { calls, dispatch }
}

const events = (row: Row) => ((row.progress as { events?: { stage: string; detail: string }[] })?.events ?? [])

async function chainedLeg() {
  console.log('\nchain: a handed-back leg nobody dispatched')
  const db = createFakeRunStoreDb()
  const id = db.seed(queuedRow({ id: 'chain', invocation_count: 1, attempt_count: 0, queued_at: ago(600_000), started_at: ago(600_000), heartbeat_at: ago(600_000) }))
  const v = queueVerdict(db.row(id) as unknown as ScoutRunRow, NOW)
  t.check('verdict is chain even at 10 minutes (past the hard ceiling)', v.state === 'chain' && 600_000 > HARD_QUEUE_CEILING_MS, v.state)
  const d = dispatcher()
  const sw = await sweepScoutQueue('u1', { db, now: NOW, dispatch: d.dispatch })
  const row = db.row(id)
  t.check('the sweep dispatches it', sw.actions.length === 1 && sw.actions[0].action === 'redispatched' && d.calls.length === 1 && d.calls[0].token === 'tok', JSON.stringify(sw.actions))
  t.check('the row is still queued, never failed', row.status === 'queued' && row.error_code === undefined, `${row.status}/${row.error_code}`)
  t.check('attempt_count 1 and last_dispatch_at stamped', row.attempt_count === 1 && row.last_dispatch_at === iso(NOW), `${row.attempt_count}/${row.last_dispatch_at}`)
  t.check('the dispatch is recorded on the row', events(row).some((e) => e.stage === 'dispatch' && /watchdog/.test(e.detail)), JSON.stringify(events(row)))
  t.check('the token is untouched (the worker still needs it)', row.claim_token === 'tok')

  const again = await sweepScoutQueue('u1', { db, now: NOW + 1_000, dispatch: d.dispatch })
  t.check(
    'the next sweep 1 s after the chain dispatch neither re-dispatches nor fails it (DEFECT if failed: queue-health.ts:131-135 measures a chained row from queued_at, so once the chain dispatch bumps attempt_count the age is past HARD_QUEUE_CEILING and the verdict is no_worker)',
    again.actions.length === 0 && d.calls.length === 1 && db.row(id).attempt_count === 1 && db.row(id).status === 'queued',
    JSON.stringify(again.actions)
  )
  t.check('a chained leg is never failed while its one dispatch may still be landing', db.row(id).status !== 'failed', String(db.row(id).error))
}

async function redispatchSpacing() {
  console.log('\nredispatch spacing')
  const db = createFakeRunStoreDb()
  const id = db.seed(queuedRow({ id: 'slow', queued_at: ago(MAX_QUEUE_WAIT_MS + 1_000), started_at: ago(MAX_QUEUE_WAIT_MS + 1_000), attempt_count: 1, last_dispatch_at: ago(5_000) }))
  t.check('redispatchDue is false inside the window', redispatchDue(db.row(id) as unknown as ScoutRunRow, NOW) === false)
  const d = dispatcher()
  const s1 = await sweepScoutQueue('u1', { db, now: NOW, dispatch: d.dispatch })
  t.check('no dispatch 5 s after the last one', s1.actions.length === 0 && d.calls.length === 0 && db.row(id).attempt_count === 1, JSON.stringify(s1.actions))
  const later = NOW + REDISPATCH_SPACING_MS - 5_000 + 1
  const s2 = await sweepScoutQueue('u1', { db, now: later, dispatch: d.dispatch })
  const row = db.row(id)
  t.check('dispatched once the spacing has passed', s2.actions.length === 1 && s2.actions[0].action === 'redispatched' && d.calls.length === 1, JSON.stringify(s2.actions))
  t.check('attempt_count 2, last_dispatch_at moved', row.attempt_count === 2 && row.last_dispatch_at === iso(later), `${row.attempt_count}/${row.last_dispatch_at}`)
  t.check('still queued (dispatch pending)', row.status === 'queued')
}

async function attemptBumpRace() {
  console.log('\nattempt bump race: two concurrent sweeps on one row')
  const db = createFakeRunStoreDb()
  const id = db.seed(queuedRow({ id: 'race', queued_at: ago(MAX_QUEUE_WAIT_MS + 1_000), started_at: ago(MAX_QUEUE_WAIT_MS + 1_000), attempt_count: 0 }))
  const d = dispatcher()
  const [a, b] = await Promise.all([sweepScoutQueue('u1', { db, now: NOW, dispatch: d.dispatch }), sweepScoutQueue('u1', { db, now: NOW, dispatch: d.dispatch })])
  const row = db.row(id)
  t.check('exactly one dispatch', d.calls.length === 1, String(d.calls.length))
  t.check('attempt_count ends at 1', row.attempt_count === 1, String(row.attempt_count))
  t.check('exactly one redispatched action across both sweeps', a.actions.length + b.actions.length === 1, JSON.stringify([a.actions, b.actions]))
  const bumps = db.history.filter((p) => p.id === id && typeof p.patch.attempt_count === 'number')
  t.check('both sweeps tried the guarded bump; one matched', bumps.length === 2 && bumps.filter((p) => p.matched === 1).length === 1 && bumps.every((p) => p.guard.attempt_count === 0), JSON.stringify(bumps.map((p) => ({ g: p.guard, m: p.matched }))))
  t.check('still queued', row.status === 'queued')
}

async function noWorker() {
  console.log('\nno_worker: the row\'s last_error is the cause')
  const db = createFakeRunStoreDb()
  const cause = 'the worker refused the request (HTTP 401 at https://x.vercel.app/api/scout/worker) — Deployment Protection'
  const withCause = db.seed(queuedRow({ id: 'nw1', queued_at: ago(MAX_QUEUE_WAIT_MS + 1_000), started_at: ago(MAX_QUEUE_WAIT_MS + 1_000), attempt_count: MAX_START_ATTEMPTS, last_error: cause }))
  const noCause = db.seed(queuedRow({ id: 'nw2', kind: 'outreach', queued_at: ago(MAX_QUEUE_WAIT_MS + 1_000), started_at: ago(MAX_QUEUE_WAIT_MS + 1_000), attempt_count: MAX_START_ATTEMPTS }))
  // A token-less queued row is failed at EVERY age: the token is only ever
  // cleared by the claim itself, in the statement that makes the row running,
  // so a queued row without one can never be claimed and is not a race.
  const noToken = db.seed(queuedRow({ id: 'nw3', kind: 'outreach', claim_token: null, queued_at: ago(MAX_QUEUE_WAIT_MS + 1_000), started_at: ago(MAX_QUEUE_WAIT_MS + 1_000), user_id: 'u2' }))
  const noTokenYoung = db.seed(queuedRow({ id: 'nw4', kind: 'outreach', claim_token: null, queued_at: ago(1_000), started_at: ago(1_000), user_id: 'u2' }))
  const d = dispatcher()
  const sw = await sweepScoutQueue('u1', { db, now: NOW, dispatch: d.dispatch })
  t.check('no dispatch once the attempts are spent', d.calls.length === 0)
  const r1 = db.row(withCause)
  t.check('failed with DISPATCH', r1.status === 'failed' && r1.error_code === 'DISPATCH', `${r1.status}/${r1.error_code}`)
  t.check('the row\'s last_error is the sentence, not a fabricated count', String(r1.error) === `Scouting could not start: ${cause}`, String(r1.error))
  t.check('completed_at, stage, token cleared', r1.completed_at === iso(NOW) && r1.stage === 'failed' && r1.claim_token === null)
  t.check('error_detail carries the attempt count', (r1.error_detail as { attempt?: number })?.attempt === MAX_START_ATTEMPTS, JSON.stringify(r1.error_detail))
  t.check('the failure is an action', sw.actions.some((a) => a.runId === withCause && a.action === 'failed'))
  const r2 = db.row(noCause)
  t.check('without a last_error the generic sentence names the real attempts and wait', r2.status === 'failed' && new RegExp(`after ${MAX_START_ATTEMPTS} attempts over ${Math.round((MAX_QUEUE_WAIT_MS + 1_000) / 1000)}s`).test(String(r2.error)), String(r2.error))
  const sw2 = await sweepScoutQueue('u2', { db, now: NOW, dispatch: d.dispatch })
  const r3 = db.row(noToken)
  t.check('a queued row without a token past the wait is failed as CLAIM, never dispatched', r3.status === 'failed' && r3.error_code === 'CLAIM' && sw2.actions.some((a) => a.runId === noToken) && d.calls.length === 0, `${r3.status}/${r3.error_code}`)
  const r3y = db.row(noTokenYoung)
  t.check('a young token-less row is failed as CLAIM at once, never dispatched (DEFECT if queued: queue-watchdog.ts skips starting/slow_start rows before the token check)', r3y.status === 'failed' && r3y.error_code === 'CLAIM' && sw2.actions.some((a) => a.runId === noTokenYoung && a.action === 'failed') && d.calls.length === 0, `${r3y.status}/${r3y.error_code}`)

  const db2 = createFakeRunStoreDb()
  const ceiling = db2.seed(queuedRow({ id: 'ceil', queued_at: ago(HARD_QUEUE_CEILING_MS + 1), started_at: ago(HARD_QUEUE_CEILING_MS + 1), attempt_count: 0, last_error: 'nothing answered' }))
  await sweepScoutQueue('u1', { db: db2, now: NOW, dispatch: d.dispatch })
  const r4 = db2.row(ceiling)
  t.check('past the hard ceiling with attempts unspent: failed on the clock, cause kept', r4.status === 'failed' && /nothing answered/.test(String(r4.error)) && d.calls.length === 0, `${r4.status}: ${r4.error}`)
}

async function cancelRace() {
  console.log('\ncancel')
  {
    const db = createFakeRunStoreDb()
    const id = db.seed(queuedRow({ id: 'c1' }))
    let interposed = 0
    // A worker claims the row between the read and the guarded cancel write.
    db.hooks.beforePatch = (rowId, patch, guard) => {
      if (rowId === id && guard.status === 'queued' && patch.status === 'cancelled' && interposed++ === 0) {
        Object.assign(db.row(id), { status: 'running', claim_token: null, worker_id: 'w_fast', worker_started_at: iso(NOW), lease_expires_at: iso(NOW + LEASE_MS) })
      }
    }
    const r = await cancelScoutRun('u1', id, { db, now: NOW })
    const row = db.row(id)
    t.check('cancel of a just-claimed run falls through to cancel_requested', r.cancelled === false && r.requested === true && r.status === 'running', JSON.stringify(r))
    t.check('the row is running with cancel_requested set', row.status === 'running' && row.cancel_requested === true && row.worker_id === 'w_fast', JSON.stringify({ s: row.status, c: row.cancel_requested }))
    t.check('the failed cancel write matched nothing (it did not close the claimed run)', db.history.some((p) => p.id === id && p.patch.status === 'cancelled' && p.matched === 0))
  }
  {
    const db = createFakeRunStoreDb()
    const id = db.seed(queuedRow({ id: 'c2' }))
    const r = await cancelScoutRun('u1', id, { db, now: NOW })
    const row = db.row(id)
    t.check('cancel of a queued run closes it outright', r.cancelled === true && row.status === 'cancelled' && row.error_code === 'CANCELLED' && row.claim_token === null, JSON.stringify({ r, s: row.status, e: row.error_code }))
    t.check('the cancel is stamped', row.completed_at === iso(NOW) && row.stage === 'cancelled')
  }
  {
    const db = createFakeRunStoreDb()
    const id = db.seed(queuedRow({ id: 'c3', status: 'running', worker_id: 'w1', claim_token: null, lease_expires_at: iso(NOW + LEASE_MS) }))
    const r = await cancelScoutRun('u1', id, { db, now: NOW })
    t.check('cancel of a running run requests a stop', r.requested === true && db.row(id).cancel_requested === true && db.row(id).status === 'running', JSON.stringify(r))
    const d = dispatcher()
    const sw = await sweepScoutQueue('u1', { db, now: NOW, dispatch: d.dispatch })
    t.check('the sweep leaves a running run with a live lease alone even when cancel is requested', sw.actions.length === 0 && db.row(id).status === 'running', JSON.stringify(sw.actions))
  }
  {
    const db = createFakeRunStoreDb()
    const id = db.seed(queuedRow({ id: 'c4', status: 'succeeded', claim_token: null }))
    const before = db.snapshot(id)
    const r = await cancelScoutRun('u1', id, { db, now: NOW })
    t.check('cancel of a finished run changes nothing and says so', r.cancelled === false && r.requested === false && /already succeeded/.test(r.message), JSON.stringify(r))
    t.same('finished row untouched', db.snapshot(id), before)
    const other = await cancelScoutRun('someone-else', id, { db, now: NOW })
    t.check('cancel by another user finds no run', other.error === 'run not found')
  }
  {
    const db = createFakeRunStoreDb()
    const id = db.seed(queuedRow({ id: 'c5', cancel_requested: true }))
    const d = dispatcher()
    const sw = await sweepScoutQueue('u1', { db, now: NOW, dispatch: d.dispatch })
    t.check('a queued row with cancel_requested is cancelled by the sweep, never dispatched', sw.actions.some((a) => a.action === 'cancelled') && db.row(id).status === 'cancelled' && d.calls.length === 0, JSON.stringify(sw.actions))
  }
}

async function reaperRules() {
  console.log('\nreaper: lease, legacy pulse, pulseless')
  const running = (over: Row = {}): Row => ({ user_id: 'u1', kind: 'job_scout', status: 'running', stage: 'research', claim_token: null, worker_id: 'w1', started_at: ago(600_000), worker_started_at: ago(600_000), progress: { stage: 'research', detail: '', counts: {}, events: [] }, ...over })

  {
    const db = createFakeRunStoreDb()
    const id = db.seed(running({ id: 'live', heartbeat_at: ago(600_000), lease_expires_at: iso(NOW + 60_000) }))
    const before = db.snapshot(id)
    const reap = await reapStaleRuns('u1', { db, now: NOW })
    t.check('a running row with a live lease is never reaped, however old its heartbeat', reap.reaped.length === 0 && db.row(id).status === 'running', JSON.stringify(reap.reaped))
    t.same('and untouched', db.snapshot(id), before)
    t.check('queueVerdict agrees: working', queueVerdict(db.row(id) as unknown as ScoutRunRow, NOW).state === 'working')
    const sw = await sweepScoutQueue('u1', { db, now: NOW, dispatch: dispatcher().dispatch })
    t.check('the sweep does not touch it either', sw.actions.length === 0 && db.row(id).status === 'running')
    const justLapsed = db.seed(running({ id: 'grace', user_id: 'u3', heartbeat_at: ago(LEASE_MS), lease_expires_at: ago(LEASE_GRACE_MS - 1_000) }))
    const r2 = await reapStaleRuns('u3', { db, now: NOW })
    t.check('inside the lease grace it is still alive', r2.reaped.length === 0 && db.row(justLapsed).status === 'running')
    const overdue = db.seed(running({ id: 'over', user_id: 'u4', heartbeat_at: ago(LEASE_MS + LEASE_GRACE_MS + 2_000), lease_expires_at: ago(LEASE_GRACE_MS + 2_000), worker_id: 'w_o' }))
    const r3 = await reapStaleRuns('u4', { db, now: NOW })
    const o = db.row(overdue)
    t.check('past the lease plus grace it is reaped, fenced on its worker id', r3.reaped.length === 1 && o.status === 'failed' && db.history.some((p) => p.id === overdue && p.guard.worker_id === 'w_o' && p.matched === 1), `${o.status}`)
  }

  {
    const db = createFakeRunStoreDb()
    // Legacy rows: no lease column value. Judged on silence AND the deadline they were claimed with.
    const patient = db.seed(running({ id: 'legacy-alive', heartbeat_at: ago(DEFAULT_STALE_MS - 60_000), progress: { stage: 'research', detail: '', counts: {}, events: [], deadline_at: iso(NOW + 40_000) } }))
    const silentUnderDeadline = db.seed(running({ id: 'legacy-silent', user_id: 'u5', heartbeat_at: ago(DEFAULT_STALE_MS + 60_000), progress: { stage: 'research', detail: '', counts: {}, events: [], deadline_at: iso(NOW + 40_000) } }))
    const dead = db.seed(running({ id: 'legacy-dead', user_id: 'u6', heartbeat_at: ago(DEFAULT_STALE_MS + 60_000), progress: { stage: 'research', detail: '', counts: {}, events: [], deadline_at: ago(120_000) } }))
    t.check('isRunStale: quiet under staleMs is alive', isRunStale(db.row(patient) as unknown as ScoutRunRow, DEFAULT_STALE_MS, NOW) === false)
    t.check('isRunStale: silent past staleMs but under its deadline + grace is alive (old patient rule)', isRunStale(db.row(silentUnderDeadline) as unknown as ScoutRunRow, DEFAULT_STALE_MS, NOW) === false)
    t.check('isRunStale: silent AND past its deadline + grace is dead', isRunStale(db.row(dead) as unknown as ScoutRunRow, DEFAULT_STALE_MS, NOW) === true)
    await reapStaleRuns('u1', { db, now: NOW })
    await reapStaleRuns('u5', { db, now: NOW })
    const r = await reapStaleRuns('u6', { db, now: NOW })
    t.check('reaper: the two patient rows stay running', db.row(patient).status === 'running' && db.row(silentUnderDeadline).status === 'running')
    const d = db.row(dead)
    t.check('reaper: the dead legacy row is closed with RUN_DEADLINE (not PLATFORM_KILL: no lease)', r.reaped.length === 1 && d.status === 'failed' && d.error_code === 'RUN_DEADLINE', `${d.status}/${d.error_code}`)
    t.check('reaper: a lease-less row is fenced on status alone', db.history.some((p) => p.id === dead && p.matched === 1 && p.guard.status === 'running' && p.guard.worker_id === 'w1'))
  }

  {
    const db = createFakeRunStoreDb()
    const ceiling = pulselessCeilingMs('job_scout', BUDGET_MS)!
    t.check(`pulseless ceiling for scouts is budget + ${DEFAULT_STALE_MS / 1000}s`, ceiling === BUDGET_MS + DEFAULT_STALE_MS, String(ceiling))
    const pulseless = (over: Row) => running({ heartbeat_at: null, worker_started_at: null, worker_id: null, ...over })
    const jobOld = db.seed(pulseless({ id: 'p-job', started_at: ago(ceiling + 1_000) }))
    const peopleOld = db.seed(pulseless({ id: 'p-people', kind: 'outreach', started_at: ago(ceiling + 1_000) }))
    const jobYoung = db.seed(pulseless({ id: 'p-young', started_at: ago(ceiling - 10_000) }))
    const pkg = db.seed(pulseless({ id: 'p-pkg', kind: 'package', started_at: ago(7 * 60_000) }))
    const verify = db.seed(pulseless({ id: 'p-verify', kind: 'job_verify', started_at: ago(5 * 60_000) }))
    const noCeiling = db.seed(pulseless({ id: 'p-manual', kind: 'manual_add', started_at: ago(3 * 24 * 3_600_000) }))
    const noKind = db.seed(pulseless({ id: 'p-nokind', kind: null, started_at: ago(ceiling + 1_000) }))
    const before = db.snapshot(noCeiling)
    const r = await reapStaleRuns('u1', { db, now: NOW })
    const ids = r.reaped.map((x) => x.runId).sort()
    t.same('pulseless scout rows past the ceiling are closed, package too, kind-less as a job scout', ids, ['p-job', 'p-nokind', 'p-people', 'p-pkg'])
    t.check('the pulseless sentence names the cause', /executed inside a request that ended before the run did/.test(String(db.row(jobOld).error)), String(db.row(jobOld).error))
    t.check('closed as failed with RUN_DEADLINE, token cleared', db.row(peopleOld).status === 'failed' && db.row(peopleOld).error_code === 'RUN_DEADLINE' && db.row(peopleOld).claim_token === null)
    t.check('a pulseless scout inside the ceiling is untouched', db.row(jobYoung).status === 'running')
    t.check('a verify run inside its own ceiling is untouched', db.row(verify).status === 'running')
    t.check('a kind with no ceiling is untouched at any age', db.row(noCeiling).status === 'running')
    t.same('… and its row is byte-identical', db.snapshot(noCeiling), before)
    t.check('reap is fenced on status alone for a worker-less row', db.history.filter((p) => p.matched === 1 && ['p-job', 'p-people', 'p-pkg', 'p-nokind'].includes(p.id)).every((p) => p.guard.status === 'running' && !('worker_id' in p.guard)))
  }

  {
    // Pre-020 database: the reap must still land with the columns it has.
    const db = createFakeRunStoreDb()
    db.unknownColumns = ['worker_id', 'lease_expires_at', 'error_code', 'error_detail', 'last_error']
    const id = db.seed(running({ id: 'old-schema', worker_id: null, heartbeat_at: null, started_at: ago(pulselessCeilingMs('job_scout', BUDGET_MS)! + 1_000) }))
    const r = await reapStaleRuns('u1', { db, now: NOW })
    t.check('on an older schema the reap falls back and still closes the row', r.reaped.length === 1 && db.row(id).status === 'failed' && r.error === null, JSON.stringify({ r, s: db.row(id).status }))
  }
}

async function main() {
  await chainedLeg()
  await redispatchSpacing()
  await attemptBumpRace()
  await noWorker()
  await cancelRace()
  await reaperRules()
  t.finish('watchdog')
}

main().catch((e) => {
  console.error('watchdog suite crashed', e)
  process.exitCode = 1
})
