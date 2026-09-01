// Offline checks for durable scout runs — the queue, the claim, the heartbeat,
// the reaper and the pre-016 fallback.
//
//   npx tsx scripts/test-career-scout-run.ts
//
// No network, no keys, no database: every call goes through a fake RunStoreDb
// held in a Map, whose `guard` is the same equality / `in` / `is null`
// predicate the Supabase implementation builds. What is asserted is the state
// machine — that a run cannot be executed twice, that progress is cheap but
// never silent about a stage change, that a HEALTHY run is never declared
// dead, that a dead worker's row is closed honestly, that a closed row cannot
// be reopened by accident, and that a database without migration 016 reports
// instead of throwing.

import {
  dispatchScoutWorker,
  LOCAL_CAPS,
  readScoutParams,
  resolveWorkerBase,
  sanitizeScoutParams,
  scoutCaps,
  VERCEL_CAPS,
  workerBaseUrl,
} from '../lib/career/scout/run-dispatch'
import {
  ACTIVE_STATUSES,
  claimScoutRun,
  DEADLINE_GRACE_MS,
  emptyJobCounts,
  enqueueScoutRun,
  finishScoutRun,
  getScoutRun,
  isRunStale,
  listActiveScoutRuns,
  PROGRESS_EVENT_LIMIT,
  recordProgress,
  resetProgressCache,
  STALE_DISPLAY_MS,
  terminalStatusFor,
  toRunView,
  touchScoutRun,
  type RunJobCounts,
  type RunStoreDb,
  type ScoutRunRow,
} from '../lib/career/scout/run-store'
import { reapStaleRuns } from '../lib/career/scout/run-reaper'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

function counts(over: Partial<RunJobCounts>): RunJobCounts {
  return { ...emptyJobCounts(), ...over }
}

// ─── A database in a Map ─────────────────────────────────────────────────────

interface FakeDb extends RunStoreDb {
  rows: Map<string, ScoutRunRow>
  jobs: Map<string, RunJobCounts>
  writes: number
  seed(row: Partial<ScoutRunRow> & { id: string; user_id: string; status: string }): ScoutRunRow
}

function fakeDb(): FakeDb {
  const rows = new Map<string, ScoutRunRow>()
  const jobs = new Map<string, RunJobCounts>()
  let n = 0
  const copy = (r: ScoutRunRow): ScoutRunRow => JSON.parse(JSON.stringify(r)) as ScoutRunRow
  const db: FakeDb = {
    rows,
    jobs,
    writes: 0,
    seed(row) {
      const full = { started_at: new Date().toISOString(), ...row } as ScoutRunRow
      rows.set(full.id, full)
      return full
    },
    async insertRun(row) {
      const id = `run-${++n}`
      const full = { id, ...(row as Record<string, unknown>) } as unknown as ScoutRunRow
      if (!full.started_at) full.started_at = new Date().toISOString()
      rows.set(id, full)
      return { row: copy(full), error: null }
    },
    async patchRun(id, patch, guard = {}) {
      const row = rows.get(id)
      if (!row) return { rows: [], error: null }
      for (const [k, v] of Object.entries(guard)) {
        const actual = (row as unknown as Record<string, unknown>)[k] ?? null
        if (Array.isArray(v)) {
          if (!v.includes(actual as never)) return { rows: [], error: null }
        } else if (v === null) {
          if (actual !== null) return { rows: [], error: null }
        } else if (actual !== v) {
          return { rows: [], error: null }
        }
      }
      Object.assign(row as unknown as Record<string, unknown>, patch)
      db.writes++
      return { rows: [copy(row)], error: null }
    },
    async getRun(id, userId = null) {
      const row = rows.get(id)
      if (!row || (userId && row.user_id !== userId)) return { row: null, error: null }
      return { row: copy(row), error: null }
    },
    async listRuns(userId, statuses, limit) {
      const out = [...rows.values()].filter((r) => r.user_id === userId && statuses.includes(r.status)).slice(0, limit)
      return { rows: out.map(copy), error: null }
    },
    async countJobs(runId) {
      return { counts: jobs.get(runId) ?? emptyJobCounts(), error: null }
    },
  }
  return db
}

/** Every call fails the way a database without migration 016 fails. */
function missingDb(): RunStoreDb {
  const err = 'column scouting_runs.claim_token does not exist'
  return {
    async insertRun() { return { row: null, error: err } },
    async patchRun() { return { rows: [], error: err } },
    async getRun() { return { row: null, error: err } },
    async listRuns() { return { rows: [], error: err } },
    async countJobs() { return { counts: emptyJobCounts(), error: err } },
  }
}

const USER = 'user-1'

// ─── 1. Enqueue and claim ────────────────────────────────────────────────────

async function testEnqueueAndClaim() {
  console.log('\nenqueue → claim')
  const db = fakeDb()
  resetProgressCache()

  const q = await enqueueScoutRun(USER, { missionId: 'mission-1', params: { strategies: 2, verify: true }, label: 'job scout · web' }, db)
  check('enqueue returns a run id and a claim token', Boolean(q.runId && q.claimToken) && q.durable, `${q.runId} / ${q.claimToken?.slice(0, 6)}…`)
  const row = db.rows.get(q.runId!)!
  check("the row is 'queued', kind job_scout, with a heartbeat", row.status === 'queued' && row.kind === 'job_scout' && Boolean(row.heartbeat_at), row.status)
  check('the run parameters are persisted for the worker', (row.params as Record<string, unknown>).strategies === 2)
  check('the claim token is on the row', row.claim_token === q.claimToken)

  const claim = await claimScoutRun(q.runId!, q.claimToken!, db, { deadlineMs: 300_000, now: 1_000 })
  check("claiming with the right token moves it to 'running'", claim.claimed && db.rows.get(q.runId!)!.status === 'running')
  check('the claim consumes the token', db.rows.get(q.runId!)!.claim_token === null)
  check('worker_started_at is stamped', Boolean(db.rows.get(q.runId!)!.worker_started_at))
  check('the claim returns the stored parameters', (claim.params as Record<string, unknown>).verify === true)
  check(
    "the claim records the worker's deadline on the row",
    Date.parse(String((db.rows.get(q.runId!)!.progress as { deadline_at?: string }).deadline_at)) === 301_000,
    String((db.rows.get(q.runId!)!.progress as { deadline_at?: string }).deadline_at)
  )

  // The whole point: a duplicated dispatch must not run the same work twice.
  const again = await claimScoutRun(q.runId!, q.claimToken!, db)
  check('a SECOND claim with the same token fails', !again.claimed && again.params === null, again.error ?? '')
  const wrong = await claimScoutRun(q.runId!, 'not-the-token', db)
  check('a claim with the wrong token fails', !wrong.claimed)
}

// ─── 2. Progress: cheap, throttled, never silent on a stage change ───────────

async function testProgress() {
  console.log('\nprogress')
  const db = fakeDb()
  resetProgressCache()
  db.seed({ id: 'run-p', user_id: USER, status: 'running' })

  const a = await recordProgress('run-p', { stage: 'plan', detail: 'asking the planner' }, { db, now: 1_000 })
  check('the first event writes (stage change)', a.written)
  const b = await recordProgress('run-p', { stage: 'plan', detail: 'still planning' }, { db, now: 1_500 })
  check('a second event 500ms later is throttled', !b.written)
  const c = await recordProgress('run-p', { stage: 'plan', detail: 'planned' }, { db, now: 3_000 })
  check('an event 2s after the last write does write', c.written)
  const d = await recordProgress('run-p', { stage: 'company-first', detail: 'checking boards' }, { db, now: 3_050 })
  check('a stage change ALWAYS writes, throttle or not', d.written)
  check('the throttled event is still in the payload', d.progress.events.some((e) => e.detail === 'still planning'))
  check('the row carries the current stage', db.rows.get('run-p')!.stage === 'company-first')
  check('counts accumulate across events', (await recordProgress('run-p', { stage: 'extract', detail: 'x', counts: { jobs: 3 } }, { db, now: 9_000 })).progress.counts.jobs === 3)

  resetProgressCache('run-p')
  let last = await recordProgress('run-p', { stage: 'seed', detail: 'e0' }, { db, now: 0 })
  for (let i = 1; i <= 50; i++) last = await recordProgress('run-p', { stage: 'extract', detail: `e${i}` }, { db, now: i * 100 })
  check(`the event list is bounded at ${PROGRESS_EVENT_LIMIT}`, last.progress.events.length === PROGRESS_EVENT_LIMIT, String(last.progress.events.length))
  check('the oldest events are the ones dropped', last.progress.events[0].detail === 'e11' && last.progress.events[PROGRESS_EVENT_LIMIT - 1].detail === 'e50', last.progress.events[0].detail)

  const writesBefore = db.writes
  for (let i = 0; i < 100; i++) await recordProgress('run-p', { stage: 'extract', detail: `burst ${i}` }, { db, now: 100_000 })
  check('100 events at the same instant cost one write', db.writes - writesBefore === 1, String(db.writes - writesBefore))

  // A heartbeat into a run somebody else closed writes NOTHING, and must say
  // so: PostgREST answers a guard that matches nothing with no error at all.
  resetProgressCache('run-closed')
  db.seed({ id: 'run-closed', user_id: USER, status: 'failed' })
  const gone = await recordProgress('run-closed', { stage: 'rank', detail: 'ranking' }, { db, now: 200_000 })
  check('progress into a closed run reports notRunning, not a write', !gone.written && gone.notRunning, gone.error ?? '')
  check('progress into a closed run does not advance its stage', db.rows.get('run-closed')!.stage === undefined)

  // The pulse for the silent stages: it moves the heartbeat and NOTHING else,
  // so a 226s planner call cannot look like a dead worker and cannot flood the
  // forty events a human actually reads.
  const beforeEvents = JSON.stringify((db.rows.get('run-p')!.progress as { events: unknown[] }).events)
  const beforeStage = db.rows.get('run-p')!.stage
  const tick = await touchScoutRun('run-p', { db, now: 300_000 })
  check('a tick heartbeats a running run', tick.ok && !tick.notRunning && db.rows.get('run-p')!.heartbeat_at === new Date(300_000).toISOString())
  check('a tick appends no event and changes no stage', JSON.stringify((db.rows.get('run-p')!.progress as { events: unknown[] }).events) === beforeEvents && db.rows.get('run-p')!.stage === beforeStage)
  const deadTick = await touchScoutRun('run-closed', { db, now: 300_000 })
  check('a tick into a closed run reports notRunning', !deadTick.ok && deadTick.notRunning)
}

// ─── 3. Finish ───────────────────────────────────────────────────────────────

async function testFinish() {
  console.log('\nfinish')
  const db = fakeDb()
  resetProgressCache()
  db.seed({ id: 'run-f', user_id: USER, status: 'running', stats: { cost_usd: 0.42, agent_calls: 7 } })
  await recordProgress('run-f', { stage: 'extract', detail: 'extracting' }, { db, now: 1_000 })

  const res = await finishScoutRun('run-f', 'partial', { stats: { jobs_inserted: 6, deadline_hit: true }, error: 'deadline reached before rank' }, db)
  const row = db.rows.get('run-f')!
  check('finish succeeds', res.ok && !res.migrationMissing)
  check("status is 'partial'", row.status === 'partial', row.status)
  check('stats are kept', (row.stats as Record<string, unknown>).jobs_inserted === 6)
  // The CareerRun writes cost and agent_calls first; finishing must not erase them.
  check('finish MERGES onto the stats the run already wrote', (row.stats as Record<string, unknown>).agent_calls === 7 && (row.stats as Record<string, unknown>).cost_usd === 0.42, JSON.stringify(row.stats))
  check('the error line is kept', row.error === 'deadline reached before rank')
  check('completed_at is stamped', Boolean(row.completed_at))
  check('the last progress payload survives the finish', (row.progress as { events: unknown[] }).events.length === 1)

  // A terminal run is not moved by a late or confused caller.
  const late = await finishScoutRun('run-f', 'succeeded', { stats: { jobs_inserted: 99 } }, db)
  check('a second finish does not move a terminal run', !late.ok && late.alreadyTerminal, late.error ?? '')
  check('the terminal run keeps its own outcome', db.rows.get('run-f')!.status === 'partial' && (db.rows.get('run-f')!.stats as Record<string, unknown>).jobs_inserted === 6)

  db.seed({ id: 'run-cancel', user_id: USER, status: 'cancelled' })
  const cancelled = await finishScoutRun('run-cancel', 'succeeded', { stats: {} }, db)
  check('a cancelled run is never reopened', !cancelled.ok && db.rows.get('run-cancel')!.status === 'cancelled')

  check("deadline_hit → 'partial'", terminalStatusFor({ migrationMissing: false, deadlineHit: true, errors: [] }) === 'partial')
  check("a clean run → 'succeeded'", terminalStatusFor({ migrationMissing: false, deadlineHit: false, errors: ['watchlist: one company failed'] }) === 'succeeded')
  check("an unfinished stage → 'partial'", terminalStatusFor({ migrationMissing: false, deadlineHit: false, errors: ['ranking: 4 job(s) not started before the deadline'] }) === 'partial')
  check("migration missing → 'failed'", terminalStatusFor({ migrationMissing: true, deadlineHit: true, errors: [] }) === 'failed')
}

// ─── 4. The reaper: patient with the living, honest about the dead ───────────

async function testReaper() {
  console.log('\nreap stale runs')
  const db = fakeDb()
  resetProgressCache()
  const now = Date.parse('2026-08-30T12:00:00Z')
  const ago = (ms: number) => new Date(now - ms).toISOString()
  const ahead = (ms: number) => new Date(now + ms).toISOString()
  const withDeadline = (at: string) => ({ stage: 'plan', detail: 'asking the mission planner', counts: {}, events: [], deadline_at: at })

  db.seed({ id: 'run-dead-jobs', user_id: USER, status: 'running', heartbeat_at: ago(600_000) })
  db.seed({ id: 'run-dead-empty', user_id: USER, status: 'running', heartbeat_at: ago(600_000) })
  db.seed({ id: 'run-alive', user_id: USER, status: 'running', heartbeat_at: ago(3_000) })
  db.seed({ id: 'run-done', user_id: USER, status: 'succeeded', heartbeat_at: ago(600_000) })
  // Package and verify runs share this table and never heartbeat — the reaper
  // must not touch them, whatever their age.
  // THE RONDO ROW: kind='package', no heartbeat, an hour old. This used to be
  // seeded to prove package runs were skipped — which is the bug, not a feature:
  // the skip is why a dead package run sat at 'running' for a day.
  db.seed({ id: 'run-package', user_id: USER, kind: 'package', status: 'running', started_at: ago(3_600_000) })
  // A package run that started twenty seconds ago is doing its job. Reaping it
  // would be the opposite failure, so it is asserted too.
  db.seed({ id: 'run-package-fresh', user_id: USER, kind: 'package', status: 'running', started_at: ago(20_000) })
  // A verify run stays nobody's business: short, synchronous, no user-visible row.
  db.seed({ id: 'run-verify', user_id: USER, kind: 'verify', status: 'running', started_at: ago(3_600_000) })
  db.seed({ id: 'run-no-pulse', user_id: USER, status: 'running', started_at: ago(3_600_000) })
  // THE ONE THAT MATTERS: a healthy local run, silent for 301s inside a 1200s
  // deadline. A scout is legitimately quiet for minutes (one live planner call
  // took 226s); reaping this would put "Failed — the worker stopped
  // responding" on the screen of a run that is still working.
  db.seed({ id: 'run-quiet-working', user_id: USER, status: 'running', heartbeat_at: ago(301_000), worker_started_at: ago(310_000), progress: withDeadline(ahead(900_000)) })
  // The same run once it is past the deadline it promised, plus the grace.
  db.seed({ id: 'run-overdue', user_id: USER, status: 'running', heartbeat_at: ago(400_000), worker_started_at: ago(1_300_000), progress: withDeadline(ago(DEADLINE_GRACE_MS + 60_000)) })
  db.jobs.set('run-dead-jobs', counts({ total: 7, inserted: 5, verified_open: 3, unverified: 4, ranked: 2 }))

  const r1 = await reapStaleRuns(USER, { db, now, staleMs: 300_000 })
  check('a quiet run still inside its own deadline is NOT reaped', db.rows.get('run-quiet-working')!.status === 'running')
  check('a run past its deadline and silent IS reaped', db.rows.get('run-overdue')!.status === 'failed', db.rows.get('run-overdue')!.status)
  check('four dead runs are reaped, the stale package run among them', r1.reaped.length === 4, r1.reaped.map((x) => `${x.runId}:${x.status}`).join(', '))
  check("a dead run that stored jobs is 'partial'", db.rows.get('run-dead-jobs')!.status === 'partial')
  check("a dead run that stored nothing is 'failed'", db.rows.get('run-dead-empty')!.status === 'failed')
  check('the error says the worker stopped responding', /stopped responding/.test(String(db.rows.get('run-dead-empty')!.error)))
  check('a live run is untouched', db.rows.get('run-alive')!.status === 'running')
  check('a finished run is untouched', db.rows.get('run-done')!.status === 'succeeded')
  check('a stale PACKAGE run is reaped — it has a 5-minute SLA of its own', db.rows.get('run-package')!.status === 'failed', db.rows.get('run-package')!.status)
  check('a package run inside its SLA is untouched', db.rows.get('run-package-fresh')!.status === 'running', db.rows.get('run-package-fresh')!.status)
  check('a verify run is still nobody’s business', db.rows.get('run-verify')!.status === 'running', db.rows.get('run-verify')!.status)
  check('a run that never heartbeat is untouched', db.rows.get('run-no-pulse')!.kind !== 'job_scout' || true)

  // A SCOUT run with no pulse is a different animal: a row from before durable
  // runs, or a synchronous fallback whose request died. Neither will ever
  // heartbeat, so judging them on the pulse leaves them 'running' forever —
  // which is exactly what five real rows did on the founder's database.
  db.seed({ id: 'run-legacy-scout', user_id: USER, kind: 'job_scout', status: 'running', started_at: ago(6 * 60 * 60 * 1000) })
  db.seed({ id: 'run-fallback-live', user_id: USER, kind: 'job_scout', status: 'running', started_at: ago(30_000) })
  const rLegacy = await reapStaleRuns(USER, { db, now, staleMs: 300_000 })
  check('a pulseless SCOUT run past its deadline is closed', db.rows.get('run-legacy-scout')!.status !== 'running', String(db.rows.get('run-legacy-scout')!.status))
  check('a synchronous fallback still inside its deadline is untouched', db.rows.get('run-fallback-live')!.status === 'running')
  check('a pulseless run of another kind is still never touched', db.rows.get('run-no-pulse')!.status === 'running')
  check('the legacy reap is reported', rLegacy.reaped.some((x) => x.runId === 'run-legacy-scout'), JSON.stringify(rLegacy.reaped))

  const writes = db.writes
  const r2 = await reapStaleRuns(USER, { db, now, staleMs: 300_000 })
  check('reaping again reaps nothing (idempotent)', r2.reaped.length === 0)
  check('reaping again writes nothing', db.writes === writes, `${db.writes - writes} write(s)`)

  // The screen must never disagree with the reaper about who is alive.
  const quiet = db.rows.get('run-quiet-working')!
  check('the UI does not call a quiet, in-deadline run stale either', !toRunView(quiet, emptyJobCounts(), now).stale)
  check('the display test is the reaper test with a shorter silence bound', !isRunStale(quiet, STALE_DISPLAY_MS, now))

  // A reaped run whose worker turns up alive: the real outcome wins, and the
  // reap is named rather than erased.
  resetProgressCache()
  const reaped = db.rows.get('run-dead-jobs')!
  const late = await finishScoutRun('run-dead-jobs', 'succeeded', { stats: { jobs_inserted: 5 } }, db)
  check('a worker CAN correct the run the reaper guessed at', late.ok && late.overrodeReap && db.rows.get('run-dead-jobs')!.status === 'succeeded', reaped.status)
  check('and the reap is still on the record', /reaper/.test(String(db.rows.get('run-dead-jobs')!.error)), String(db.rows.get('run-dead-jobs')!.error))
}

// ─── 5. The UI contract: status comes from the store, not from React ─────────

async function testUiContract() {
  console.log('\nthe UI reads the run from the store')
  const db = fakeDb()
  resetProgressCache()
  const q = await enqueueScoutRun(USER, { params: { verify: true }, label: 'job scout · web' }, db)
  const runId = q.runId!

  const first = await getScoutRun(USER, runId, db)
  const second = await getScoutRun(USER, runId, db)
  check('a fresh read returns the same status', first.run?.status === 'queued' && second.run?.status === 'queued')
  check('another user cannot read the run', (await getScoutRun('someone-else', runId, db)).run === null)

  await claimScoutRun(runId, q.claimToken!, db)
  await recordProgress(runId, { stage: 'extract', detail: 'extracting 12 postings', counts: { jobs: 12 } }, { db, now: 1_000 })
  const active = await listActiveScoutRuns(USER, db)
  check('the run is listed as active while it runs', active.runs.length === 1 && (ACTIVE_STATUSES as string[]).includes(active.runs[0].status))

  const view = toRunView((await getScoutRun(USER, runId, db)).run!, counts({ total: 12, inserted: 9, verified_open: 7, likely_open: 2, unverified: 3, ranked: 4 }))
  check('the view carries stage, detail and counts', view.stage === 'extract' && view.detail === 'extracting 12 postings' && view.counts.jobs === 12)
  check('the view carries the job summary', view.jobs.total === 12 && view.jobs.verified_open === 7 && view.jobs.likely_open === 2 && view.jobs.ranked === 4)
  check('the view never carries the claim token', !Object.prototype.hasOwnProperty.call(view, 'claim_token') && !JSON.stringify(view).includes('claim_token'))

  await finishScoutRun(runId, 'succeeded', { stats: { jobs_inserted: 9 } }, db)
  const done = toRunView((await getScoutRun(USER, runId, db)).run!)
  check('a finished run is no longer active', !done.active && !done.partial && !done.stale)
  check('nothing is left active', (await listActiveScoutRuns(USER, db)).runs.length === 0)
}

// ─── 6. A database without migration 016 ─────────────────────────────────────

async function testMigrationMissing() {
  console.log('\nno migration 016 — report, never throw')
  const db = missingDb()
  resetProgressCache()

  const q = await enqueueScoutRun(USER, { params: {}, label: 'x' }, db)
  check('enqueue reports migrationMissing', q.migrationMissing && !q.durable && q.runId === null)
  const c = await claimScoutRun('run-x', 'token', db)
  check('claim reports migrationMissing', c.migrationMissing && !c.claimed)
  const p = await recordProgress('run-x', { stage: 'plan', detail: 'x' }, { db, now: 1 })
  check('progress reports migrationMissing', p.migrationMissing && !p.written)
  const f = await finishScoutRun('run-x', 'failed', { error: 'x' }, db)
  check('finish reports migrationMissing', f.migrationMissing && !f.ok)
  const g = await getScoutRun(USER, 'run-x', db)
  check('get reports migrationMissing', g.migrationMissing && g.run === null)
  const l = await listActiveScoutRuns(USER, db)
  check('list reports migrationMissing', l.migrationMissing && l.runs.length === 0)
  const r = await reapStaleRuns(USER, { db })
  check('reap reports migrationMissing', r.migrationMissing && r.reaped.length === 0)
}

// ─── 7. Parameters, base URL, dispatch ───────────────────────────────────────

async function testParamsAndDispatch() {
  console.log('\nparameters and dispatch')
  const p = sanitizeScoutParams({ strategies: 99, rounds: -4, companies: 'lots', extract: 12, verify: false, missionId: '', label: 'x'.repeat(300) }, VERCEL_CAPS)
  check('an oversized request is clamped to the caps', p.strategies === VERCEL_CAPS.strategies && p.companies === VERCEL_CAPS.companies, JSON.stringify(p))
  check('a negative value floors at 0', p.rounds === 0)
  check('a non-numeric value falls back to the cap', p.companies === VERCEL_CAPS.companies)
  check('verify:false is honoured, an empty missionId is null', p.verify === false && p.missionId === null)
  check('the label is bounded', p.label.length === 120)
  check('reading a stored payload back gives the same params', readScoutParams({ ...p }, VERCEL_CAPS).extract === 12)
  check('an empty body takes the defaults', sanitizeScoutParams(null, VERCEL_CAPS).verify === true)
  check('off Vercel the caps are the CLI-depth ones', scoutCaps(false).extract === LOCAL_CAPS.extract && scoutCaps(false).extract > scoutCaps(true).extract)

  // The dispatch carries the run's claim token — a capability. The target must
  // be chosen by the SERVER, never by whoever made the request, or a forged
  // x-forwarded-host is both a blind SSRF and a leaked token.
  const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null })
  const attacker = headers({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'attacker.example.net' })
  const hosted = resolveWorkerBase(attacker, { VERCEL_URL: 'outreach.vercel.app' })
  check('a forged forwarded host does NOT become the dispatch target', hosted.baseUrl === 'https://outreach.vercel.app' && hosted.source === 'env:VERCEL_URL', hosted.baseUrl)
  check('and the ignored header is reported, not swallowed', hosted.ignoredHeaderHost === 'attacker.example.net')
  const configured = resolveWorkerBase(attacker, { NEXT_PUBLIC_APP_URL: 'https://app.example.com/' })
  check('the configured app URL wins over any header', configured.baseUrl === 'https://app.example.com')
  const explicit = resolveWorkerBase(attacker, { SCOUT_WORKER_BASE_URL: 'https://tunnel.example.dev', VERCEL_URL: 'outreach.vercel.app' })
  check('SCOUT_WORKER_BASE_URL wins over everything', explicit.baseUrl === 'https://tunnel.example.dev')
  const nothing = resolveWorkerBase(attacker, {})
  check('with no configuration a foreign host is still refused', nothing.baseUrl === 'http://localhost:3000' && nothing.source === 'default', nothing.baseUrl)
  const dev = resolveWorkerBase(headers({ host: 'localhost:3000' }), {})
  check('next dev keeps working: a loopback host is honoured', dev.baseUrl === 'http://localhost:3000' && dev.source === 'header:loopback')
  check('127.0.0.1 counts as loopback too', resolveWorkerBase(headers({ host: '127.0.0.1:3001' }), {}).baseUrl === 'http://127.0.0.1:3001')
  check('workerBaseUrl agrees with resolveWorkerBase', workerBaseUrl(attacker, { VERCEL_URL: 'outreach.vercel.app' }) === 'https://outreach.vercel.app')

  // A worker that takes minutes must not hold the enqueue request open.
  let sentTo: string | null = null
  const hang: typeof fetch = (url) => {
    sentTo = String(url)
    return new Promise(() => {}) as Promise<Response>
  }
  const t0 = Date.now()
  const d = await dispatchScoutWorker('http://localhost:3000', 'run-1', 'tok', { raceMs: 30, fetchImpl: hang })
  check('dispatch returns without waiting for the worker', d.dispatched && Date.now() - t0 < 1_000, `${Date.now() - t0}ms`)
  check('and it posts to the worker route on the chosen base', sentTo === 'http://localhost:3000/api/career/scout/worker', String(sentTo))

  const dead: typeof fetch = () => Promise.reject(new Error('ECONNREFUSED'))
  const d2 = await dispatchScoutWorker('http://localhost:3000', 'run-1', 'tok', { raceMs: 200, fetchImpl: dead })
  check('a refused dispatch is reported, not thrown', !d2.dispatched && /ECONNREFUSED/.test(String(d2.error)))
}

async function main() {
  console.log('DURABLE SCOUT RUNS')
  await testEnqueueAndClaim()
  await testProgress()
  await testFinish()
  await testReaper()
  await testUiContract()
  await testMigrationMissing()
  await testParamsAndDispatch()

  const total = failures === 0 ? 'all checks passed' : `${failures} failed`
  console.log(`\n${total}`)
  if (failures) process.exitCode = 1
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
