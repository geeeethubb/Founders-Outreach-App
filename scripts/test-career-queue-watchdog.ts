// A scouting run may never sit queued. These are the tests for that.
//
// The incident: a run sat at status='queued' for 328 minutes with a claim token
// set, a heartbeat stamped at the enqueue instant and worker_started_at NULL —
// asked to start, never started, and invisible to every recovery path in the
// system because the reaper only ever selected ['running'].
//
// Fake clocks throughout: "sixty-one seconds queued" costs nothing to test.
//
// No network, no keys, no database.
//
//   npx tsx scripts/test-career-queue-watchdog.ts

import {
  LEASE_MS,
  HARD_QUEUE_CEILING_MS,
  MAX_QUEUE_WAIT_MS,
  MAX_START_ATTEMPTS,
  SLOW_QUEUE_MS,
  needsAction,
  queueMessage,
  queueVerdict,
  type QueueRow,
} from '../lib/career/scout/queue-health'
import { sweepScoutQueue } from '../lib/career/scout/queue-watchdog'
import { dispatchScoutWorker } from '../lib/career/scout/run-dispatch'
import { checkWorkerBase } from '../lib/career/scout/worker-env'
import { platformWaitUntil, runInBackground } from '../lib/career/scout/background'
import type { RunStoreDb } from '../lib/career/scout/run-store-db'
import type { ScoutRunRow } from '../lib/career/scout/run-record'

let passed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failures.push(`${name} — ${detail}`)
    console.log(`  FAIL ${name} — ${detail}`)
  }
}

const NOW = 1_800_000_000_000
const iso = (t: number) => new Date(t).toISOString()
const ago = (ms: number) => iso(NOW - ms)

/** An in-memory RunStoreDb with the same conditional-update semantics as Postgres. */
function fakeDb(seed: Partial<ScoutRunRow>[] = []) {
  const rows = new Map<string, Record<string, unknown>>()
  for (const r of seed) rows.set(String(r.id), { user_id: 'u', ...r } as Record<string, unknown>)
  let patches = 0
  const db: RunStoreDb & { rows: typeof rows; patches: () => number } = {
    rows,
    patches: () => patches,
    async insertRun(row: Record<string, unknown>) {
      rows.set(String(row.id), row)
      return { row: row as unknown as ScoutRunRow, error: null }
    },
    async patchRun(id: string, patch: Record<string, unknown>, guard?: Record<string, unknown>) {
      patches++
      const row = rows.get(id)
      if (!row) return { rows: [], error: null }
      // The guard is the whole point: it is what makes the write atomic.
      if (guard) for (const [k, v] of Object.entries(guard)) if (row[k] !== v) return { rows: [], error: null }
      // Simulate a pre-020 database rejecting unknown columns.
      if (unknownColumns.length) {
        const bad = Object.keys(patch).find((k) => unknownColumns.includes(k))
        if (bad) return { rows: [], error: `column scouting_runs.${bad} does not exist` }
      }
      Object.assign(row, patch)
      return { rows: [row as unknown as ScoutRunRow], error: null }
    },
    async listRuns(_userId: string, statuses: string[]) {
      return { rows: [...rows.values()].filter((r) => statuses.includes(String(r.status))) as unknown as ScoutRunRow[], error: null }
    },
    async getRun(id: string) {
      return { row: (rows.get(id) ?? null) as unknown as ScoutRunRow | null, error: null }
    },
    async countJobs() {
      return { counts: { total: 0, inserted: 0, verified_open: 0, likely_open: 0, unverified: 0, closed: 0, ranked: 0 }, error: null }
    },
  } as unknown as RunStoreDb & { rows: typeof rows; patches: () => number }
  return db
}
let unknownColumns: string[] = []

function queued(over: Partial<ScoutRunRow> = {}): Partial<ScoutRunRow> {
  return { id: 'r1', kind: 'job_scout', status: 'queued', stage: 'queued', started_at: ago(0), heartbeat_at: ago(0), claim_token: 'tok', ...over }
}

async function main(): Promise<void> {
  console.log('queueVerdict: how long is too long')
  {
    const v = (waited: number, over: Partial<QueueRow> = {}) =>
      queueVerdict({ status: 'queued', started_at: ago(waited), claim_token: 'tok', ...over }, NOW)
    check('a fresh run is simply starting', v(1_000).state === 'starting')
    check(`under ${SLOW_QUEUE_MS / 1000}s is still starting`, v(SLOW_QUEUE_MS - 1).state === 'starting')
    check('past that it is slow, but nothing is wrong yet', v(SLOW_QUEUE_MS + 1).state === 'slow_start')
    check(`past ${MAX_QUEUE_WAIT_MS / 1000}s the watchdog acts`, v(MAX_QUEUE_WAIT_MS + 1).state === 'redispatch')
    check('with the attempts spent it is a real failure', v(MAX_QUEUE_WAIT_MS + 1, { attempt_count: MAX_START_ATTEMPTS }).state === 'no_worker')
    // THE INCIDENT ROW.
    const rondo = v(328 * 60_000, { attempt_count: 0 })
    check('the 328-minute run is actionable, not "starting"', needsAction(rondo), rondo.state)
    check('and past the hard ceiling it is terminal even with attempts unspent',
      v(HARD_QUEUE_CEILING_MS + 1, { attempt_count: 0 }).state === 'no_worker',
      v(HARD_QUEUE_CEILING_MS + 1, { attempt_count: 0 }).state)
    check('just under the ceiling it still retries', v(HARD_QUEUE_CEILING_MS - 1, { attempt_count: 0 }).state === 'redispatch')
    check('and at 328 minutes with attempts spent it is no_worker',
      v(328 * 60_000, { attempt_count: MAX_START_ATTEMPTS }).state === 'no_worker')
  }
  {
    // Before this fix a queued run was not judged at all. Prove it is now, at
    // every age, in a loop rather than at one hand-picked minute.
    let unjudged = 0
    for (const mins of [2, 5, 60, 328, 1440, 4320]) {
      const s = queueVerdict({ status: 'queued', started_at: ago(mins * 60_000), attempt_count: MAX_START_ATTEMPTS }, NOW).state
      if (s !== 'no_worker') unjudged++
    }
    check('no queued age escapes a terminal verdict once attempts are spent', unjudged === 0, `${unjudged} escaped`)
  }
  {
    check('a cancelled request wins over everything', queueVerdict({ status: 'queued', started_at: ago(1000), cancel_requested: true }, NOW).state === 'cancelled')
    for (const status of ['succeeded', 'partial', 'failed', 'cancelled']) {
      if (queueVerdict({ status, started_at: ago(9e8) }, NOW).state !== 'terminal') {
        check(`${status} is terminal`, false)
        break
      }
    }
    check('every terminal status is left alone however old', true)
  }
  {
    const running = (quiet: number) => queueVerdict({ status: 'running', heartbeat_at: ago(quiet), worker_started_at: ago(quiet + 1000) }, NOW)
    check('a beating run is working', running(5_000).state === 'working')
    check('a run inside its lease is still working', running(LEASE_MS - 1).state === 'working')
    check('past the lease it is abandoned', running(LEASE_MS + 1).state === 'abandoned')
    // A 'running' row that never recorded a worker start is a contradiction; it
    // must still be judged rather than trusted.
    check('running with no worker_started_at is judged on what it has',
      queueVerdict({ status: 'running', heartbeat_at: null, worker_started_at: null, started_at: ago(9e6) }, NOW).state === 'abandoned')
  }
  {
    const msg = queueMessage(queueVerdict({ status: 'queued', started_at: ago(9e6), attempt_count: MAX_START_ATTEMPTS }, NOW))
    check('the failure message is written for a person', /could not start/.test(msg) && !/worker_started_at|claim_token/.test(msg), msg)
  }

  console.log('\nsweep: a queued run past the wait gets acted on')
  {
    unknownColumns = []
    const db = fakeDb([queued({ started_at: ago(MAX_QUEUE_WAIT_MS + 5_000) })])
    const sent: string[] = []
    const r = await sweepScoutQueue('u', { db, now: NOW, dispatch: async (id) => { sent.push(id); return { dispatched: true, error: null } } })
    check('it redispatches', r.actions[0]?.action === 'redispatched', JSON.stringify(r.actions))
    check('to the right run', sent.length === 1 && sent[0] === 'r1')
    check('and the attempt is counted', db.rows.get('r1')!.attempt_count === 1, String(db.rows.get('r1')!.attempt_count))
    check('the run is still queued, awaiting the worker', db.rows.get('r1')!.status === 'queued')
  }
  {
    unknownColumns = []
    const db = fakeDb([queued({ started_at: ago(MAX_QUEUE_WAIT_MS + 5_000), attempt_count: MAX_START_ATTEMPTS })])
    const r = await sweepScoutQueue('u', { db, now: NOW, dispatch: async () => { throw new Error('must not dispatch') } })
    check('with attempts spent it FAILS the run', db.rows.get('r1')!.status === 'failed', String(db.rows.get('r1')!.status))
    check('and records why', /could not start/.test(String(db.rows.get('r1')!.error)), String(db.rows.get('r1')!.error))
    check('it is reported as an action', r.actions[0]?.action === 'failed')
    check('and it is terminal, so a later sweep does nothing',
      (await sweepScoutQueue('u', { db, now: NOW + 60_000, dispatch: async () => ({ dispatched: true, error: null }) })).actions.length === 0)
  }
  {
    // The attempt must be counted even when the dispatch itself hangs or throws,
    // or a broken worker is retried for ever by a sweep that only counts wins.
    unknownColumns = []
    const db = fakeDb([queued({ started_at: ago(MAX_QUEUE_WAIT_MS + 5_000) })])
    await sweepScoutQueue('u', { db, now: NOW, dispatch: async () => ({ dispatched: false, error: 'ECONNREFUSED' }) })
    check('a failed dispatch still counts as an attempt', db.rows.get('r1')!.attempt_count === 1)
    check('and the real reason is on the row, not a fabricated count', /ECONNREFUSED/.test(String(db.rows.get('r1')!.last_error)) && db.rows.get('r1')!.error_code === 'DISPATCH', String(db.rows.get('r1')!.last_error))
    // Not again inside the spacing window: the last dispatch may still be a cold start landing.
    await sweepScoutQueue('u', { db, now: NOW + 1_000, dispatch: async () => ({ dispatched: false, error: 'ECONNREFUSED' }) })
    check('a second sweep a second later does not redispatch (spacing)', db.rows.get('r1')!.attempt_count === 1 && db.rows.get('r1')!.status === 'queued')
    await sweepScoutQueue('u', { db, now: NOW + 20_000, dispatch: async () => ({ dispatched: false, error: 'ECONNREFUSED' }) })
    check('the second failure exhausts the attempts', db.rows.get('r1')!.attempt_count === 2)
    // A dispatch that FAILED with the attempts spent is a terminal answer, now,
    // with the reason — not another minute of spinner for a third sweep to end.
    check('and fails the run at once, naming the cause', db.rows.get('r1')!.status === 'failed' && /ECONNREFUSED/.test(String(db.rows.get('r1')!.error)), `${db.rows.get('r1')!.status}: ${db.rows.get('r1')!.error}`)
    const third = await sweepScoutQueue('u', { db, now: NOW + 40_000, dispatch: async () => ({ dispatched: false, error: 'ECONNREFUSED' }) })
    check('and the third sweep finds nothing to do', third.actions.length === 0 && db.rows.get('r1')!.status === 'failed', String(db.rows.get('r1')!.status))
  }
  {
    unknownColumns = []
    const db = fakeDb([queued({ started_at: ago(5_000) })])
    const r = await sweepScoutQueue('u', { db, now: NOW, dispatch: async () => { throw new Error('must not dispatch') } })
    check('a run inside the wait is left completely alone', r.actions.length === 0 && db.rows.get('r1')!.status === 'queued')
  }
  {
    unknownColumns = []
    const db = fakeDb([queued({ started_at: ago(9e6), claim_token: null })])
    await sweepScoutQueue('u', { db, now: NOW, dispatch: async () => { throw new Error('must not dispatch') } })
    check('a queued run with no claim token is unclaimable and is failed', db.rows.get('r1')!.status === 'failed')
    check('and it says so', /claim token/.test(String(db.rows.get('r1')!.error)), String(db.rows.get('r1')!.error))
  }

  console.log('\nsweep: races and idempotency')
  {
    // The worker claiming a moment before the watchdog gives up. The guard must
    // make the worker win — failing a run that just started would be worse than
    // the bug being fixed.
    unknownColumns = []
    const db = fakeDb([queued({ started_at: ago(9e6), attempt_count: MAX_START_ATTEMPTS })])
    db.rows.get('r1')!.status = 'running'
    await sweepScoutQueue('u', { db, now: NOW, dispatch: async () => ({ dispatched: true, error: null }) })
    check('a run that started first is never failed by the watchdog', db.rows.get('r1')!.status === 'running')
  }
  {
    unknownColumns = []
    const db = fakeDb([queued({ started_at: ago(9e6), attempt_count: MAX_START_ATTEMPTS })])
    const [a, b] = await Promise.all([
      sweepScoutQueue('u', { db, now: NOW, dispatch: async () => ({ dispatched: true, error: null }) }),
      sweepScoutQueue('u', { db, now: NOW, dispatch: async () => ({ dispatched: true, error: null }) }),
    ])
    const failedTwice = a.actions.filter((x) => x.action === 'failed').length + b.actions.filter((x) => x.action === 'failed').length
    check('two concurrent sweeps fail the run exactly once', failedTwice === 1, `${failedTwice} times`)
  }
  {
    unknownColumns = []
    const db = fakeDb([
      queued({ id: 'a', started_at: ago(9e6), attempt_count: MAX_START_ATTEMPTS }),
      queued({ id: 'b', started_at: ago(2_000) }),
      { id: 'c', kind: 'job_scout', status: 'running', heartbeat_at: ago(1_000) },
      { id: 'd', kind: 'job_scout', status: 'succeeded', started_at: ago(9e6) },
    ])
    const r = await sweepScoutQueue('u', { db, now: NOW, dispatch: async () => ({ dispatched: true, error: null }) })
    check('the sweep only touches queued runs', r.checked === 2, `checked ${r.checked}`)
    check('the stale one is failed', db.rows.get('a')!.status === 'failed')
    check('the fresh one is untouched', db.rows.get('b')!.status === 'queued')
    check('a running run is not the queue watchdog’s business', db.rows.get('c')!.status === 'running')
    check('a finished run is untouched', db.rows.get('d')!.status === 'succeeded')
  }

  console.log('\nsweep: it works on a database that has not had migration 020')
  {
    // The rows stuck TODAY are on the pre-020 schema. A watchdog that needed the
    // new columns would leave exactly them stuck.
    unknownColumns = ['attempt_count', 'last_dispatch_at', 'last_error']
    // Inside the retry window (60s..180s), so the redispatch path is the one
    // under test rather than the hard ceiling.
    const db = fakeDb([queued({ started_at: ago(MAX_QUEUE_WAIT_MS + 5_000) })])
    const r = await sweepScoutQueue('u', { db, now: NOW, dispatch: async () => ({ dispatched: true, error: null }) })
    check('it still redispatches without attempt_count', r.actions[0]?.action === 'redispatched', JSON.stringify(r.actions))
    check('and the run is not corrupted', db.rows.get('r1')!.status === 'queued')

    // THE BUG THIS SUITE MISSED THE FIRST TIME. Without attempt_count the
    // counter never persists, so an attempts-only rule redispatches for ever and
    // the run stays queued — the original bug with extra steps. Sweeping the
    // real 341-minute run reported "attempt 1" three times in a row.
    const dbForever = fakeDb([queued({ started_at: ago(9e6) })])
    for (let i = 0; i < 3; i++) {
      await sweepScoutQueue('u', { db: dbForever, now: NOW + i * 1_000, dispatch: async () => ({ dispatched: false, error: 'no server' }) })
    }
    check('a pre-020 run still reaches a terminal state, on the clock alone',
      dbForever.rows.get('r1')!.status === 'failed', String(dbForever.rows.get('r1')!.status))

    const db2 = fakeDb([queued({ started_at: ago(9e6), attempt_count: MAX_START_ATTEMPTS })])
    await sweepScoutQueue('u', { db: db2, now: NOW, dispatch: async () => ({ dispatched: true, error: null }) })
    check('and it can still FAIL a run without last_error', db2.rows.get('r1')!.status === 'failed', String(db2.rows.get('r1')!.status))
    check('keeping the message in the column that does exist', /could not start/.test(String(db2.rows.get('r1')!.error)))
    unknownColumns = []
  }

  // ─── dispatchScoutWorker: it used to report success for every failure ───
  console.log('\ndispatch: an unreachable or refusing worker is not a success')
  {
    const url = 'http://example.test'
    const res = (status: number) => (async () => new Response('', { status })) as unknown as typeof fetch

    const ok = await dispatchScoutWorker(url, 'r', 't', { fetchImpl: res(200), raceMs: 5_000 })
    check('a 2xx is accepted', ok.outcome === 'accepted' && ok.dispatched, JSON.stringify(ok))

    // The defect that hid the incident: a non-2xx answer was never inspected,
    // so `dispatched: true, error: null` was recorded for a run nothing took.
    const unauth = await dispatchScoutWorker(url, 'r', 't', { fetchImpl: res(401), raceMs: 5_000 })
    check('a 401 is a FAILURE, not a dispatch', unauth.outcome === 'failed' && !unauth.dispatched, JSON.stringify(unauth))
    check('and it names the likely cause instead of just the code',
      /Deployment Protection/.test(String(unauth.error)), String(unauth.error))
    const missing = await dispatchScoutWorker(url, 'r', 't', { fetchImpl: res(404), raceMs: 5_000 })
    check('a 404 is a failure and reports the URL it tried',
      missing.outcome === 'failed' && /example\.test/.test(String(missing.error)), String(missing.error))
    check('a 500 is a failure', (await dispatchScoutWorker(url, 'r', 't', { fetchImpl: res(500), raceMs: 5_000 })).outcome === 'failed')

    const refused = await dispatchScoutWorker(url, 'r', 't', {
      fetchImpl: (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch,
      raceMs: 5_000,
    })
    check('a connection refusal is a failure and keeps the reason',
      refused.outcome === 'failed' && /ECONNREFUSED/.test(String(refused.error)))

    // The other defect: the race timer resolved `true`, so "still in flight" and
    // "accepted" were the same answer. They must not be — one is worth waiting
    // for and the other means fail fast.
    const slow = await dispatchScoutWorker(url, 'r', 't', {
      fetchImpl: (() => new Promise(() => {})) as unknown as typeof fetch,
      raceMs: 20,
    })
    check('a request still in flight is PENDING, not accepted', slow.outcome === 'pending', JSON.stringify(slow))
    check('and pending is not treated as a failure either', slow.dispatched && slow.error === null)
  }

  // ─── The worker base: never silently healthy ───
  console.log('\nworker base: a misconfigured deployment must be loud')
  {
    const at = (env: Record<string, string | undefined>) => checkWorkerBase(env)

    // THE INCIDENT CONFIGURATION: a preview on Vercel with nothing pinned and
    // no bypass secret. The old code fell back to the per-deployment hostname
    // that Deployment Protection 401s; the new one refuses to resolve at all.
    const unpinned = at({ VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_URL: 'app-abc123-team.vercel.app' })
    check('Vercel with nothing pinned is an ERROR', unpinned.severity === 'error', unpinned.severity)
    check('and it names the variable that fixes it', /SCOUT_WORKER_BASE_URL/.test(String(unpinned.remedy)), String(unpinned.remedy))
    check('and explains Deployment Protection rather than just saying 401', /Deployment Protection/.test(unpinned.message), unpinned.message)
    check('and the bypass secret is the other remedy', /Protection Bypass for Automation/.test(String(unpinned.remedy)))

    // Production with none of the three: also an error — no address can be proven callable.
    const prodBare = at({ VERCEL: '1', VERCEL_ENV: 'production', VERCEL_URL: 'app-abc123-team.vercel.app' })
    check('production with no alias, no bypass and nothing pinned is an ERROR', prodBare.severity === 'error', prodBare.severity)

    // The same deployment with the automation bypass: ok, preview or production.
    const bypass = at({ VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_URL: 'app-abc123-team.vercel.app', VERCEL_AUTOMATION_BYPASS_SECRET: 'secret' })
    check('a deployment with the bypass secret is ok', bypass.severity === 'ok' && bypass.source === 'env:VERCEL_URL+bypass', `${bypass.severity} ${bypass.source}`)

    // Production without a bypass: the stable alias Vercel provides.
    const alias = at({ VERCEL: '1', VERCEL_ENV: 'production', VERCEL_URL: 'app-abc123-team.vercel.app', VERCEL_PROJECT_PRODUCTION_URL: 'outreach.vercel.app' })
    check('production falls back to its stable alias, and that is ok', alias.severity === 'ok' && alias.baseUrl === 'https://outreach.vercel.app', `${alias.severity} ${alias.baseUrl}`)

    const pinned = at({ VERCEL: '1', SCOUT_WORKER_BASE_URL: 'https://outreach.example.com' })
    check('a pinned production URL is ok', pinned.severity === 'ok', pinned.severity)

    // Pinned, but to something a serverless function cannot reach.
    const loopback = at({ VERCEL: '1', SCOUT_WORKER_BASE_URL: 'http://localhost:3000' })
    check('localhost pinned on Vercel is an ERROR', loopback.severity === 'error', loopback.severity)

    // Pinned, but to the deployment hash URL — the subtle version of the bug.
    const hash = at({ VERCEL: '1', SCOUT_WORKER_BASE_URL: 'https://app-9f2c1a-team.vercel.app' })
    check('a per-deployment URL pinned on Vercel without a bypass still WARNS', hash.severity === 'warn', hash.severity)

    const local = at({ NEXT_PUBLIC_APP_URL: 'http://localhost:3000' })
    check('localhost off Vercel is fine', local.severity === 'ok', local.severity)

    const guessed = at({ NEXT_PUBLIC_APP_URL: 'https://staging.example.com' })
    check('an inferred non-local base warns rather than passing silently', guessed.severity === 'warn', guessed.severity)

    // The whole point of the module: nothing unverified is reported as healthy.
    const verdicts = [unpinned, loopback, hash, guessed].map((v) => v.severity)
    check('no unverified configuration is ever "ok"', !verdicts.includes('ok'), verdicts.join(','))
  }

  console.log('\nbackground: waitUntil is an optimisation, never a dependency')
  {
    const KEY = Symbol.for('@vercel/request-context')
    const g = globalThis as Record<symbol, unknown>
    const original = g[KEY]
    try {
      delete g[KEY]
      check('off-platform there is no waitUntil', platformWaitUntil() === null)
      check('and running in background still succeeds, just unextended', runInBackground(Promise.resolve('x')).extended === false)

      const held: Promise<unknown>[] = []
      g[KEY] = { get: () => ({ waitUntil: (p: Promise<unknown>) => held.push(p) }) }
      check('on-platform it is found', typeof platformWaitUntil() === 'function')
      const on = runInBackground(Promise.resolve('y'))
      check('and the promise is handed over', on.extended === true && held.length === 1)

      // A rejection must not become an unhandled rejection that kills a request
      // which has already succeeded.
      check('a rejected background promise is swallowed', runInBackground(Promise.reject(new Error('dispatch died'))).extended === true)
      await Promise.allSettled(held)

      // A platform whose waitUntil throws must not take the request down.
      g[KEY] = { get: () => ({ waitUntil: () => { throw new Error('no') } }) }
      check('a throwing waitUntil degrades instead of propagating', runInBackground(Promise.resolve(1)).extended === false)

      g[KEY] = { get: () => undefined }
      check('a context with no request in flight is handled', platformWaitUntil() === null)
    } finally {
      if (original === undefined) delete g[KEY]
      else g[KEY] = original
    }
  }

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) {
    console.log(failures.map((f) => `  - ${f}`).join('\n'))
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
