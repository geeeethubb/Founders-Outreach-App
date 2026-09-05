// Fault injection for the durable-run KERNEL (lib/runs/worker.ts) — both scout
// kinds, driven with fake executors against the in-memory RunStoreDb.
//
// Every check asserts PERSISTED STATE: the row the fake database holds after
// the kernel is done with it, or the exact patch a transition wrote. "Did not
// throw" is never the assertion.
//
//   npx tsx scripts/reliability/kernel.ts
//
// No network, no keys. Real sleeps are kept under ~3 s per case: where the
// kernel's own timers are longer (the 5 s last-resort grace) the injected
// clock is moved instead.

process.env.SCOUT_INVOCATION_BUDGET_MS = '3000'

import { runWorkerLeg, LAST_RESORT_GRACE_MS } from '../../lib/runs/worker'
import { enqueueScoutRun, finishScoutRun, recordProgress, resetProgressCache, touchScoutRun, LEASE_GRACE_MS, LEASE_MS, type DurableScoutKind } from '../../lib/career/scout/run-store'
import { reapStaleRuns } from '../../lib/career/scout/run-reaper'
import { createFakeRunStoreDb, makeChecker, sleep, iso, type Row } from './fake-db'
import { enqueue, events, harness, pending, type Leg } from './kernel-harness'

const t = makeChecker()

// ─── 1. Successful run, both kinds ───────────────────────────────────────────

async function successfulRun() {
  console.log('\n1. successful run')
  for (const kind of ['outreach', 'job_scout'] as DurableScoutKind[]) {
    const h = harness(kind, async (input) => {
      input.onProgress('stage-a', 'working on a')
      if (kind === 'outreach') {
        input.onCheckpoint({ v: 1, stages: ['strategy'] })
        input.onResult({ v: 1, prospects: [{ name: 'A' }] })
      } else input.onCursor({ stages: ['plan'], strategies: [], companies: [], families: [], pages: {} })
      input.onProgress('stage-b', 'working on b', { found: 3 })
      await sleep(20)
      return { status: 'succeeded', continuable: false, checkpoint: kind === 'outreach' ? { v: 1, stages: ['done'] } : null, cursor: kind === 'job_scout' ? { stages: ['done'], strategies: [], companies: [], families: [], pages: {} } : null, result: kind === 'outreach' ? { v: 1, prospects: [{ name: 'A' }, { name: 'B' }], complete: true } : null, stats: { cost_usd: 0.01 }, errors: [] }
    })
    const { runId, token } = await enqueue(h, kind)
    const res = await runWorkerLeg({ runId, token }, Date.now(), h.deps)
    const row = h.db.row(runId)
    t.check(`${kind}: leg answers 200 succeeded`, res.status === 200 && res.body.status === 'succeeded', JSON.stringify(res.body))
    t.check(`${kind}: row status succeeded`, row.status === 'succeeded', String(row.status))
    t.check(`${kind}: worker_id, lease and claim_token cleared`, row.worker_id === null && row.lease_expires_at === null && row.claim_token === null, JSON.stringify({ w: row.worker_id, l: row.lease_expires_at, c: row.claim_token }))
    t.check(`${kind}: invocation_count 1`, row.invocation_count === 1, String(row.invocation_count))
    t.check(`${kind}: completed_at stamped`, typeof row.completed_at === 'string')
    t.check(`${kind}: error_code null`, (row.error_code ?? null) === null, String(row.error_code))
    const stages = events(row).map((e) => e.stage)
    t.check(`${kind}: progress events carry the stages`, stages.includes('stage-a') && stages.includes('stage-b') && stages.includes('starting'), stages.join(','))
    t.same(`${kind}: counts persisted`, (row.progress as { counts?: unknown }).counts, { found: 3 })
    t.check(`${kind}: stats merged`, (row.stats as { cost_usd?: number })?.cost_usd === 0.01, JSON.stringify(row.stats))
    if (kind === 'outreach') {
      t.same(`${kind}: result persisted`, row.result, { v: 1, prospects: [{ name: 'A' }, { name: 'B' }], complete: true })
      t.same(`${kind}: final checkpoint persisted`, row.checkpoint, { v: 1, stages: ['done'] })
    } else {
      t.same(`${kind}: cursor persisted on params`, (row.params as { cursor?: unknown }).cursor, { stages: ['done'], strategies: [], companies: [], families: [], pages: {} })
    }
    t.check(`${kind}: executed exactly once`, h.executions.length === 1 && h.dispatches.length === 0)
  }
}

// ─── 2. Duplicate start ──────────────────────────────────────────────────────

async function duplicateStart() {
  console.log('\n2. duplicate start')
  const db = createFakeRunStoreDb()
  const first = await enqueueScoutRun('u1', { kind: 'outreach', params: {} }, db)
  const dup = await enqueueScoutRun('u1', { kind: 'outreach', params: {} }, db)
  t.check('second enqueue of the same kind conflicts', dup.conflict === true && dup.runId === null && dup.durable === false, JSON.stringify(dup))
  t.check('the conflict is not reported as a missing migration', dup.migrationMissing === false)
  t.check('exactly one row exists for the kind', [...db.rows.values()].filter((r) => r.kind === 'outreach').length === 1)
  const other = await enqueueScoutRun('u1', { kind: 'job_scout', params: {} }, db)
  t.check('a different kind does not conflict', other.conflict === false && other.runId !== null, JSON.stringify(other))
  const otherUser = await enqueueScoutRun('u2', { kind: 'outreach', params: {} }, db)
  t.check('another user does not conflict', otherUser.conflict === false && otherUser.runId !== null)

  const db2 = createFakeRunStoreDb()
  db2.seed({ user_id: 'u1', kind: 'job_scout', status: 'running', started_at: iso(Date.now()), heartbeat_at: null })
  const durable = await enqueueScoutRun('u1', { kind: 'job_scout', params: {} }, db2)
  t.check('an inline row (no queued_at) does not block a durable enqueue', durable.conflict === false && durable.runId !== null, JSON.stringify(durable))
  t.check('first enqueue was durable', first.durable && first.claimToken !== null)
}

// ─── 3. Wrong / reused token ─────────────────────────────────────────────────

async function wrongToken() {
  console.log('\n3. wrong and reused token')
  const h = harness('outreach', async () => ({ status: 'succeeded', continuable: false, result: { prospects: [] }, errors: [] }))
  const { runId, token } = await enqueue(h, 'outreach')
  const before = h.db.snapshot(runId)
  const wrong = await runWorkerLeg({ runId, token: 'not-the-token' }, Date.now(), h.deps)
  t.check('wrong token answers 409 CLAIM', wrong.status === 409 && wrong.body.code === 'CLAIM' && wrong.body.claimed === false, JSON.stringify(wrong))
  t.same('wrong token leaves the row untouched', h.db.snapshot(runId), before)
  t.check('wrong token executed nothing', h.executions.length === 0)

  const ok = await runWorkerLeg({ runId, token }, Date.now(), h.deps)
  t.check('the real token claims and finishes', ok.status === 200 && h.db.row(runId).status === 'succeeded')
  const after = h.db.snapshot(runId)
  const reused = await runWorkerLeg({ runId, token }, Date.now(), h.deps)
  t.check('the consumed token answers 409 CLAIM', reused.status === 409 && reused.body.code === 'CLAIM', JSON.stringify(reused))
  t.same('a reused token leaves the finished row untouched', h.db.snapshot(runId), after)
  t.check('a reused token executed nothing more', h.executions.length === 1)
  const missing = await runWorkerLeg({ runId: 'nope', token }, Date.now(), h.deps)
  t.check('an unknown run answers 409 CLAIM', missing.status === 409 && missing.body.code === 'CLAIM')
  const bad = await runWorkerLeg({}, Date.now(), h.deps)
  t.check('a body without runId/token answers 400 VALIDATION', bad.status === 400 && bad.body.code === 'VALIDATION')
}

// ─── 4a. Worker dies after claim: the executor never settles ─────────────────

async function executorNeverSettles() {
  console.log('\n4a. executor never settles: last-resort timer hands the leg off')
  // The last-resort timer fires at deadline + 5 s of grace. The injected clock
  // runs 5 s ahead so that fires ~0.5 s of real time after entry.
  const shift = LAST_RESORT_GRACE_MS
  const h = harness(
    'job_scout',
    async (input) => {
      input.onProgress('discover', 'listing boards')
      input.onCursor({ stages: ['plan'], strategies: ['s1'], companies: [], families: [], pages: {} })
      await new Promise<never>(() => undefined)
      throw new Error('unreachable')
    },
    { now: () => Date.now() + shift, budgetMs: 500 }
  )
  const { runId, token } = await enqueue(h, 'job_scout')
  const started = Date.now()
  const res = await runWorkerLeg({ runId, token }, Date.now(), h.deps)
  const took = Date.now() - started
  const row = h.db.row(runId)
  t.check('the leg is finalised without the executor (under 3 s real time)', took < 3_000, `${took} ms`)
  t.check('leg answers queued for the next pass', res.status === 200 && res.body.status === 'queued' && res.body.nextInvocation === 2, JSON.stringify(res.body))
  t.check('row is queued again', row.status === 'queued', String(row.status))
  t.check('row carries a NEW claim token', typeof row.claim_token === 'string' && row.claim_token !== token)
  t.check('worker_id and lease cleared by the handoff', row.worker_id === null && row.lease_expires_at === null)
  t.check('invocation_count stays 1 until the next claim', row.invocation_count === 1, String(row.invocation_count))
  t.same('the cursor the executor reached is on the row', (row.params as { cursor?: unknown }).cursor, { stages: ['plan'], strategies: ['s1'], companies: [], families: [], pages: {} })
  const handoffEvent = events(row).find((e) => e.stage === 'queued' && /cut off at its hard deadline/.test(e.detail))
  t.check('the handoff event says the pass was cut off at its deadline', Boolean(handoffEvent), JSON.stringify(events(row).slice(-3)))
  t.check('exactly one self-dispatch with the new token', h.dispatches.length === 1 && h.dispatches[0].token === row.claim_token, String(h.dispatches.length))
  t.check('a dispatch attempt was counted', row.attempt_count === 1, String(row.attempt_count))
}

// ─── 4b. Worker dies after claim: the reaper closes a lapsed lease ───────────

async function reaperClosesLapsedLease() {
  console.log('\n4b. reaper closes a running row whose lease lapsed')
  const db = createFakeRunStoreDb()
  const NOW = 1_800_000_000_000
  const startedAt = NOW - 200_000
  const base = (over: Row): Row => ({
    user_id: 'u1',
    status: 'running',
    stage: 'research',
    claim_token: null,
    worker_id: 'w_dead',
    started_at: iso(startedAt),
    worker_started_at: iso(startedAt),
    claimed_at: iso(startedAt),
    queued_at: iso(startedAt - 1_000),
    heartbeat_at: iso(startedAt + 150_000),
    lease_expires_at: iso(startedAt + 150_000 + LEASE_MS),
    progress: { stage: 'research', detail: 'x', counts: {}, events: [{ at: iso(startedAt), stage: 'starting', detail: 'a worker claimed the run' }], deadline_at: iso(startedAt + 280_000), invocation: 1 },
    ...over,
  })
  const noResult = db.seed(base({ id: 'r-failed', kind: 'outreach' }))
  const withResult = db.seed(base({ id: 'r-partial', kind: 'outreach', result: { prospects: [{ name: 'kept' }] }, checkpoint: { stages: ['internal'] } }))
  const withJobs = db.seed(base({ id: 'r-jobs', kind: 'job_scout' }))
  db.jobCounts.set(withJobs, 4)
  // Heartbeat 20 s into a 280 s pass: killed early.
  const killed = db.seed(base({ id: 'r-killed', kind: 'outreach', heartbeat_at: iso(startedAt + 20_000), lease_expires_at: iso(startedAt + 20_000 + LEASE_MS) }))

  const now = startedAt + 150_000 + LEASE_MS + LEASE_GRACE_MS + 1_000
  const reap = await reapStaleRuns('u1', { db, now })
  const ids = reap.reaped.map((r) => r.runId).sort()
  t.same('all four lapsed rows are reaped', ids, ['r-failed', 'r-jobs', 'r-killed', 'r-partial'])

  const f = db.row(noResult)
  t.check('no result → failed with RUN_DEADLINE', f.status === 'failed' && f.error_code === 'RUN_DEADLINE', `${f.status}/${f.error_code}`)
  t.check('reaped row: worker_id, lease, token cleared', f.worker_id === null && f.lease_expires_at === null && f.claim_token === null)
  t.check('reaped row: completed_at and progress.reaped_at stamped', f.completed_at === iso(now) && (f.progress as { reaped_at?: string }).reaped_at === iso(now))
  t.check('reaped row: error_detail says reaped', (f.error_detail as { reaped?: boolean })?.reaped === true)
  t.check('reaped row: the sentence names the lease', /stopped responding/.test(String(f.error)), String(f.error))

  const p = db.row(withResult)
  t.check(
    'result present → partial with RUN_DEADLINE (DEFECT if failed: run-reaper.ts:88 reads row.result off listRuns, whose select omits the heavy columns, so a People Scout with prospects is reaped as failed)',
    p.status === 'partial' && p.error_code === 'RUN_DEADLINE',
    `${p.status}/${p.error_code}`
  )
  t.same('the partial payload is kept', p.result, { prospects: [{ name: 'kept' }] })
  t.same('the checkpoint is kept', p.checkpoint, { stages: ['internal'] })
  t.check('the sentence says the prospects are kept', /prospects it found are kept/.test(String(p.error)), String(p.error))

  const j = db.row(withJobs)
  t.check('job_scout with saved jobs → partial', j.status === 'partial' && /4 job\(s\)/.test(String(j.error)), `${j.status}: ${j.error}`)

  const k = db.row(killed)
  t.check('heartbeat < 50% of the planned pass → PLATFORM_KILL', k.status === 'failed' && k.error_code === 'PLATFORM_KILL', `${k.status}/${k.error_code}`)
  t.check('PLATFORM_KILL detail carries observed and planned ms', (k.error_detail as { observed_ms?: number; planned_ms?: number })?.observed_ms === 20_000 && (k.error_detail as { planned_ms?: number })?.planned_ms === 280_000, JSON.stringify(k.error_detail))

  const again = await reapStaleRuns('u1', { db, now: now + 1 })
  t.check('a second reap is a no-op (guarded on running)', again.reaped.length === 0)
}

// ─── 5. Worker dies after results were persisted ─────────────────────────────

async function diesAfterResultsPersisted() {
  console.log('\n5. worker dies after results were persisted')
  const shift = LAST_RESORT_GRACE_MS
  const h = harness(
    'outreach',
    async (input) => {
      input.onProgress('rank', 'ranking')
      input.onCheckpoint({ v: 1, stages: ['strategy', 'internal'] })
      input.onResult({ v: 1, prospects: [{ name: 'persisted-before-death' }] })
      await new Promise<never>(() => undefined)
      throw new Error('unreachable')
    },
    { now: () => Date.now() + shift, budgetMs: 700 }
  )
  const { runId, token } = await enqueue(h, 'outreach')
  const leg = runWorkerLeg({ runId, token }, Date.now(), h.deps)
  await sleep(120)
  const live = h.db.row(runId)
  t.check('result landed on the row while the worker was alive', JSON.stringify(live.result) === JSON.stringify({ v: 1, prospects: [{ name: 'persisted-before-death' }] }) && live.status === 'running', JSON.stringify(live.result))

  // The platform kills the worker; the lease lapses; the reaper finds it.
  const reapNow = Date.now() + shift + LEASE_MS + LEASE_GRACE_MS + 5_000
  const reap = await reapStaleRuns('u1', { db: h.db, now: reapNow })
  const row = h.db.row(runId)
  t.check('reaped as partial (DEFECT if failed: run-reaper.ts:88, result not selected by listRuns)', reap.reaped.length === 1 && reap.reaped[0].status === 'partial' && row.status === 'partial', JSON.stringify(reap.reaped))
  t.check('reap code is RUN_DEADLINE or PLATFORM_KILL', row.error_code === 'RUN_DEADLINE' || row.error_code === 'PLATFORM_KILL', String(row.error_code))
  t.same('the result column keeps the partial payload after the reap', row.result, { v: 1, prospects: [{ name: 'persisted-before-death' }] })
  t.same('the checkpoint is kept after the reap', row.checkpoint, { v: 1, stages: ['strategy', 'internal'] })

  // The abandoned leg finalises after the reap: it must not reopen the row or lose the payload.
  const res = await leg
  const after = h.db.row(runId)
  t.check('the late leg does not reopen the row', after.status === 'partial', `${after.status} (leg said ${JSON.stringify(res.body)})`)
  t.same('the payload survives the late leg', after.result, { v: 1, prospects: [{ name: 'persisted-before-death' }] })
  t.check('no dispatch went out for a reaped run', h.dispatches.length === 0, String(h.dispatches.length))
  t.check('the reap is named in the error line when the leg overrides it', /reaper/.test(String(after.error)) || after.error_code === 'RUN_DEADLINE' || after.error_code === 'PLATFORM_KILL', String(after.error))
}

// ─── 6. Chaining ─────────────────────────────────────────────────────────────

async function chaining() {
  console.log('\n6. chaining: leg 1 hands off, self-dispatch starts leg 2, leg 2 finishes')
  // A holder, not a `let`: TS narrows a closure-assigned `let` to never.
  const next: { leg2: Leg | null } = { leg2: null }
  const snapshots: Row[] = []
  const h = harness(
    'outreach',
    async (input) => {
      input.onProgress(`leg-${input.invocation}`, `working in pass ${input.invocation}`)
      if (input.invocation === 1) {
        input.onCheckpoint({ v: 1, stages: ['strategy'] })
        input.onResult({ v: 1, prospects: [{ name: 'A' }] })
        return { status: 'partial', continuable: true, checkpoint: { v: 1, stages: ['strategy', 'internal'] }, result: { v: 1, prospects: [{ name: 'A' }] }, stats: { leg1: true }, errors: [] }
      }
      return { status: 'succeeded', continuable: false, checkpoint: { v: 1, stages: ['done'] }, result: { v: 1, prospects: [{ name: 'A' }, { name: 'B' }] }, stats: { leg2: true }, errors: [] }
    },
    {
      dispatch: (hh) => async (_t, runId, token) => {
        hh.dispatches.push({ runId, token })
        snapshots.push(hh.db.snapshot(runId)!)
        next.leg2 = runWorkerLeg({ runId, token }, Date.now(), hh.deps)
        return pending
      },
    }
  )
  const { runId, token } = await enqueue(h, 'outreach')
  const queuedAt0 = h.db.row(runId).queued_at
  await sleep(5)
  const r1 = await runWorkerLeg({ runId, token }, Date.now(), h.deps)
  t.check('leg 1 answers queued with nextInvocation 2', r1.body.status === 'queued' && r1.body.nextInvocation === 2, JSON.stringify(r1.body))
  t.check('leg 1 observed the next claim on the row', r1.body.nextClaimed === true, JSON.stringify(r1.body))

  // The handoff patch itself, as written.
  const handoff = h.db.history.find((p) => p.id === runId && p.patch.status === 'queued' && typeof p.patch.claim_token === 'string')
  t.check('handoff patch exists and matched', Boolean(handoff && handoff.matched === 1))
  if (handoff) {
    t.check('handoff: new token, attempt_count 0, worker_id null, lease null', handoff.patch.claim_token !== token && handoff.patch.attempt_count === 0 && handoff.patch.worker_id === null && handoff.patch.lease_expires_at === null && handoff.patch.last_dispatch_at === null, JSON.stringify(handoff.patch))
    t.check('handoff: queued_at reset to the handoff instant', typeof handoff.patch.queued_at === 'string' && handoff.patch.queued_at !== queuedAt0, `${handoff.patch.queued_at} vs ${queuedAt0}`)
    t.check('handoff: fenced on leg 1 worker', handoff.guard.status === 'running' && typeof handoff.guard.worker_id === 'string')
    t.same('handoff carries the checkpoint', handoff.patch.checkpoint, { v: 1, stages: ['strategy', 'internal'] })
    t.same('handoff carries the result', handoff.patch.result, { v: 1, prospects: [{ name: 'A' }] })
  }
  const seen = snapshots[0]
  t.check('at dispatch: row queued, invocation_count 1, attempt_count 1, new token', Boolean(seen) && seen.status === 'queued' && seen.invocation_count === 1 && seen.attempt_count === 1 && seen.claim_token === h.dispatches[0]?.token, JSON.stringify({ s: seen?.status, i: seen?.invocation_count, a: seen?.attempt_count }))

  const r2 = next.leg2 ? await next.leg2 : null
  const row = h.db.row(runId)
  t.check('leg 2 claimed invocation 2 and succeeded', r2?.body.status === 'succeeded' && r2?.body.invocation === 2, JSON.stringify(r2?.body))
  t.check('final row succeeded, invocation_count 2', row.status === 'succeeded' && row.invocation_count === 2, `${row.status}/${row.invocation_count}`)
  t.same('final result is leg 2\'s', row.result, { v: 1, prospects: [{ name: 'A' }, { name: 'B' }] })
  t.same('final checkpoint is leg 2\'s', row.checkpoint, { v: 1, stages: ['done'] })
  t.check('stats merged across legs', (row.stats as { leg1?: boolean; leg2?: boolean }).leg1 === true && (row.stats as { leg2?: boolean }).leg2 === true, JSON.stringify(row.stats))
  t.check('exactly 2 executions', h.executions.length === 2, String(h.executions.length))
  t.check('exactly 1 self-dispatch', h.dispatches.length === 1, String(h.dispatches.length))
  t.check('the two legs had different worker ids', h.executions[0].workerId !== h.executions[1].workerId)
  const stages = events(row).map((e) => e.stage)
  t.check('the story reads across passes (leg-1 and leg-2 events kept)', stages.includes('leg-1') && stages.includes('leg-2'), stages.join(','))
  t.check('row cleared: worker_id, lease, token', row.worker_id === null && row.lease_expires_at === null && row.claim_token === null)
}

// ─── 7. Fencing ──────────────────────────────────────────────────────────────

async function fencing() {
  console.log('\n7. fencing: a late leg-1 write cannot touch leg 2\'s row')
  // A holder, not a `let`: TS narrows a closure-assigned `let` to never.
  const next: { leg2: Leg | null } = { leg2: null }
  let release: () => void = () => undefined
  const gate = new Promise<void>((r) => (release = r))
  let enteredResolve: () => void = () => undefined
  const entered = new Promise<void>((r) => (enteredResolve = r))
  const h = harness(
    'outreach',
    async (input) => {
      if (input.invocation === 1) {
        input.onProgress('leg-1', 'first pass')
        input.onResult({ prospects: [{ name: 'A' }] })
        return { status: 'partial', continuable: true, checkpoint: { stages: ['strategy'] }, result: { prospects: [{ name: 'A' }] }, errors: [] }
      }
      input.onProgress('leg-2-start', 'second pass started')
      await sleep(10)
      enteredResolve()
      await gate
      input.onProgress('leg-2-end', 'second pass ending')
      await sleep(10)
      return { status: 'succeeded', continuable: false, checkpoint: { stages: ['done'] }, result: { prospects: [{ name: 'A' }, { name: 'B' }] }, errors: [] }
    },
    {
      dispatch: (hh) => async (_t, runId, token) => {
        hh.dispatches.push({ runId, token })
        next.leg2 = runWorkerLeg({ runId, token }, Date.now(), hh.deps)
        return pending
      },
    }
  )
  const { runId, token } = await enqueue(h, 'outreach')
  await runWorkerLeg({ runId, token }, Date.now(), h.deps)
  await entered
  const leg1Worker = h.executions[0].workerId
  const leg2Worker = h.executions[1].workerId
  const before = h.db.snapshot(runId)!
  t.check('leg 2 owns the row while it works', before.status === 'running' && before.worker_id === leg2Worker && before.invocation_count === 2, JSON.stringify({ s: before.status, w: before.worker_id, i: before.invocation_count }))

  const p = await recordProgress(runId, { stage: 'stale-leg-1', detail: 'late' }, { db: h.db, workerId: leg1Worker, force: true })
  t.check('late recordProgress from leg 1 matches 0 rows', p.written === false && p.notRunning === true, JSON.stringify({ w: p.written, n: p.notRunning }))
  const touch = await touchScoutRun(runId, { db: h.db, workerId: leg1Worker })
  t.check('late touch from leg 1 matches 0 rows', touch.ok === false && touch.notRunning === true)
  const fin = await finishScoutRun(runId, 'failed', { workerId: leg1Worker, error: 'stale finish', errorCode: 'INTERNAL', result: { prospects: [] } }, h.db)
  t.check('late finish from leg 1 is refused and names the owner', fin.ok === false && /another worker \(leg 2\)/.test(fin.error ?? ''), JSON.stringify(fin))
  t.same('leg 2\'s row is untouched by all three', h.db.snapshot(runId), before)
  t.check('every late write was fenced on leg 1\'s worker id and matched nothing', h.db.history.filter((r) => r.guard.worker_id === leg1Worker && r.seq > 0).slice(-3).every((r) => r.matched === 0))

  // Leg 1's hygiene must not wipe leg 2's progress cache.
  resetProgressCache(runId, leg1Worker)
  release()
  const r2 = next.leg2 ? await next.leg2 : null
  const row = h.db.row(runId)
  t.check('leg 2 finished succeeded', r2?.body.status === 'succeeded' && row.status === 'succeeded', JSON.stringify(r2?.body))
  const prog = row.progress as { deadline_at?: string | null; invocation?: number; events?: { stage: string }[] }
  t.check('leg 2\'s finish still carries its deadline_at (cache not wiped by leg 1\'s reset)', typeof prog.deadline_at === 'string', String(prog.deadline_at))
  t.check('leg 2\'s finish carries invocation 2', prog.invocation === 2, String(prog.invocation))
  const stages = (prog.events ?? []).map((e) => e.stage)
  t.check('leg 2\'s events survived', stages.includes('leg-2-start') && stages.includes('leg-2-end'), stages.join(','))
  t.check('the stale leg-1 stage never reached the row', !stages.includes('stale-leg-1'), stages.join(','))
}

async function main() {
  const started = Date.now()
  await successfulRun()
  await duplicateStart()
  await wrongToken()
  await executorNeverSettles()
  await reaperClosesLapsedLease()
  await diesAfterResultsPersisted()
  await chaining()
  await fencing()
  // Handoff refusals, cancel, throws and a failing dispatch: kernel-edges.ts.
  console.log(`\n(${((Date.now() - started) / 1000).toFixed(1)}s)`)
  t.finish('kernel')
}

main().catch((e) => {
  console.error('kernel suite crashed', e)
  process.exitCode = 1
})
