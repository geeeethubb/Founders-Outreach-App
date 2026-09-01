// Package generation must ALWAYS terminate. These are the tests for that.
//
// The incident: a package sat at status='generating', stage='intelligence',
// cost_usd=$0 for over a day, because nothing in the system had an opinion
// about a worker that had died. Every assertion below is about the invariant
// that replaced that — a package reaches a terminal state within its deadline,
// no matter what goes wrong.
//
// A fake clock and a two-second budget stand in for five minutes, so the
// timeout paths are exercised in milliseconds rather than by waiting.
//
// No network, no keys, no database.
//
//   npx tsx scripts/test-career-deadline.ts

import {
  DeadlineExceededError,
  GENERATION_DEADLINE_MS,
  GenerationDeadline,
  retryWithin,
  tryWithDeadline,
  withDeadline,
} from '../lib/career/package/deadline'
import { DEADLINE_GRACE_MS, LEGACY_STALE_MS, packageLiveness, recoveryFor, staleMessage } from '../lib/career/package/liveness'

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** A promise that never settles — the thing that actually happened in production. */
const never = () => new Promise<never>(() => {})

/** A clock you control, so "four minutes in" costs no time at all. */
function fakeClock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms }, set: (v: number) => { t = v } }
}

async function main(): Promise<void> {
  console.log('deadline: one absolute clock, not a timer per stage')
  {
    const c = fakeClock()
    const d = new GenerationDeadline({ totalMs: 300_000, now: c.now })
    check('starts with the whole budget', d.remainingMs() === 300_000)
    c.advance(120_000)
    check('elapsed and remaining agree', d.elapsedMs() === 120_000 && d.remainingMs() === 180_000)
    check('not expired inside the budget', !d.expired())
    c.advance(200_000)
    check('expired past it', d.expired() && d.remainingMs() === 0)
    check('remaining never goes negative', d.remainingMs() === 0)
  }
  {
    // The bug this shape prevents: five stages each allowed the full budget.
    const c = fakeClock()
    const d = new GenerationDeadline({ totalMs: 300_000, now: c.now })
    const sum = (['initialize', 'research', 'analysis', 'tailoring', 'finalize'] as const)
      .map((s) => d.budgetFor(s))
      .reduce((a, b) => a + b, 0)
    check('stage ceilings sum to no more than the whole budget', sum <= 300_000, `${sum}ms of 300000ms`)
  }
  {
    const c = fakeClock()
    const d = new GenerationDeadline({ totalMs: 300_000, reserveMs: 45_000, now: c.now })
    c.advance(270_000) // 30s left — less than the finalise reserve
    check('optional work gets nothing once inside the reserve', d.remainingBeforeReserveMs() === 0, String(d.remainingBeforeReserveMs()))
    check('finalisation still gets the real remainder', d.budgetFor('finalize') === 30_000, String(d.budgetFor('finalize')))
    check('an optional stage refuses to start', !d.canStart('research'))
    check('and a stage cannot be started on fumes', !d.canStart('tailoring', 5_000))
  }

  console.log('\nwithDeadline: a hung call cannot hold the pipeline')
  {
    const t0 = Date.now()
    let threw: unknown = null
    try {
      await withDeadline('hung-search', 120, () => never())
    } catch (e) {
      threw = e
    }
    const waited = Date.now() - t0
    check('a promise that never settles still returns control', threw instanceof DeadlineExceededError, String(threw))
    check('and it does so on time', waited < 1_000, `${waited}ms`)
  }
  {
    const r = await withDeadline('optional', 60, () => never(), { onTimeout: () => 'fallback' })
    check('optional work degrades to its fallback instead of throwing', r === 'fallback')
  }
  {
    const r = await withDeadline('fast', 500, async () => 'done')
    check('work that finishes in time is untouched', r === 'done')
  }
  {
    let sawAbort = false
    await withDeadline('abortable', 60, async (signal) => {
      signal.addEventListener('abort', () => { sawAbort = true })
      return never()
    }, { onTimeout: () => null })
    check('the callback is given an abort signal and it fires', sawAbort)
  }
  {
    const r = await tryWithDeadline('probe', 60, () => never())
    check('tryWithDeadline reports a timeout as a result, not an error', !r.ok && r.timedOut)
    const e = await tryWithDeadline('probe', 500, async () => { throw new Error('search 503') })
    check('and a real failure is distinguishable from a timeout', !e.ok && !e.timedOut && /503/.test(e.error))
  }
  {
    // Zero budget must not "run it anyway" — that is how a deadline leaks.
    let ran = false
    const r = await withDeadline('none-left', 0, async () => { ran = true; return 'x' }, { onTimeout: () => 'skipped' })
    check('a stage with no time left is not started at all', r === 'skipped' && !ran)
  }

  console.log('\nretryWithin: bounded, and bounded by the SAME clock')
  {
    let attempts = 0
    const c = fakeClock()
    const d = new GenerationDeadline({ totalMs: 300_000, now: c.now })
    try {
      await retryWithin('flaky', d, 50, async () => { attempts++; throw new Error('boom') })
    } catch { /* expected */ }
    check('retries stop at the cap', attempts === 2, `${attempts} attempts`)
  }
  {
    let attempts = 0
    const c = fakeClock()
    const d = new GenerationDeadline({ totalMs: 300_000, now: c.now })
    try {
      await retryWithin('flaky', d, 50_000, async () => {
        attempts++
        c.advance(299_000) // the first attempt ate the budget
        throw new Error('boom')
      })
    } catch { /* expected */ }
    check('no second attempt when the deadline cannot fit one', attempts === 1, `${attempts} attempts`)
  }
  {
    // Optional work has a higher bar than "does it fit": twenty seconds is
    // enough for another search and still the wrong place to spend them.
    let attempts = 0
    const c = fakeClock()
    const d = new GenerationDeadline({ totalMs: 300_000, now: c.now })
    try {
      await retryWithin('optional-research', d, 5_000, async () => {
        attempts++
        c.advance(280_000)
        throw new Error('search down')
      }, { optional: true })
    } catch { /* expected */ }
    check('optional work is not retried under the 60s floor', attempts === 1, `${attempts} attempts, ${d.remainingMs()}ms left`)
  }
  {
    let attempts = 0
    const c = fakeClock()
    const d = new GenerationDeadline({ totalMs: 300_000, now: c.now })
    const v = await retryWithin('recovers', d, 200, async () => {
      attempts++
      if (attempts === 1) throw new Error('transient')
      return 'second time lucky'
    })
    check('a retry that succeeds returns its value', v === 'second time lucky' && attempts === 2)
  }

  console.log('\nliveness: the Rondo row, and every row like it')
  {
    // The real thing: generating, no heartbeat, no deadline, a day old.
    const rondo = {
      status: 'generating',
      stage: 'intelligence',
      created_at: new Date(Date.now() - 25 * 3600_000).toISOString(),
      updated_at: new Date(Date.now() - 25 * 3600_000).toISOString(),
      generation_started_at: null,
      generation_deadline_at: null,
      last_heartbeat_at: null,
    }
    const v = packageLiveness(rondo)
    check('the actual stuck package is judged STALE', v.state === 'stale', v.state)
    check('and the reason names the silence', v.state === 'stale' && /minutes/.test(v.reason), v.state === 'stale' ? v.reason : '')
    check('the message names the stage it died in', /during intelligence/.test(staleMessage(rondo, v as never)), staleMessage(rondo, v as never))
    check('recovery keeps it retryable', recoveryFor(rondo).status === 'failed')
  }
  {
    const now = Date.now()
    const live = {
      status: 'generating', stage: 'tailoring',
      generation_started_at: new Date(now - 60_000).toISOString(),
      generation_deadline_at: new Date(now + 240_000).toISOString(),
      last_heartbeat_at: new Date(now - 5_000).toISOString(),
    }
    check('a package inside its deadline is ALIVE', packageLiveness(live, now).state === 'alive')
    // The false positive that would matter most: killing a healthy run.
    const quiet = { ...live, last_heartbeat_at: new Date(now - 120_000).toISOString() }
    check('silence inside the deadline is not death', packageLiveness(quiet, now).state === 'alive', 'a single agent call legitimately goes quiet for minutes')
  }
  {
    const now = Date.now()
    const overdue = {
      status: 'generating', stage: 'intelligence',
      generation_started_at: new Date(now - 400_000).toISOString(),
      generation_deadline_at: new Date(now - 100_000).toISOString(),
      last_heartbeat_at: new Date(now - 350_000).toISOString(),
    }
    check('past the deadline plus grace is STALE', packageLiveness(overdue, now).state === 'stale')
    const justOver = { ...overdue, generation_deadline_at: new Date(now - (DEADLINE_GRACE_MS - 5_000)).toISOString() }
    check('inside the grace period it is still alive', packageLiveness(justOver, now).state === 'alive')
  }
  {
    const now = Date.now()
    for (const status of ['ready_to_apply', 'ready_for_review', 'failed', 'locked', 'superseded']) {
      const v = packageLiveness({ status, generation_deadline_at: new Date(now - 10 * 3600_000).toISOString() }, now)
      if (v.state !== 'terminal') { check(`${status} is terminal`, false, v.state); break }
    }
    check('every terminal status is left alone however old', true)
    // resume_review is NOT terminal: it stopped one step short of its documents.
    const rr = { status: 'resume_review', stage: 'resume_review', updated_at: new Date(now - LEGACY_STALE_MS - 60_000).toISOString() }
    check('a stranded resume_review is recoverable, not terminal', packageLiveness(rr, now).state === 'stale')
    check('and it is marked resumable, because its patch was paid for', recoveryFor(rr).resumable)
  }
  {
    // Nothing may crash the sweep — it runs on a page load.
    const odd = [
      { status: 'generating' },
      { status: 'generating', generation_deadline_at: 'not-a-date', created_at: 'nonsense' },
      { status: 'generating', generation_deadline_at: null, updated_at: null, created_at: null },
    ]
    let threw = false
    for (const row of odd) { try { packageLiveness(row as never) } catch { threw = true } }
    check('malformed rows are judged, never thrown on', !threw)
  }

  console.log('\nthe invariant: no configuration allows a non-terminal state past the deadline')
  {
    const now = Date.now()
    // Sweep a wide grid of ages against the real production deadline.
    let violations = 0
    for (const ageMin of [6, 10, 60, 24 * 60, 3 * 24 * 60]) {
      const started = now - ageMin * 60_000
      const row = {
        status: 'generating', stage: 'intelligence',
        generation_started_at: new Date(started).toISOString(),
        generation_deadline_at: new Date(started + GENERATION_DEADLINE_MS).toISOString(),
        last_heartbeat_at: null,
      }
      if (packageLiveness(row, now).state !== 'stale') violations++
    }
    check('every package older than the deadline is stale, at every age tested', violations === 0, `${violations} violations`)
  }

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) {
    console.log(failures.map((f) => `  - ${f}`).join('\n'))
    process.exitCode = 1
  }
  await sleep(0)
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
