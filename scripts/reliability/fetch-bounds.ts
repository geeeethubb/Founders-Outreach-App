// lib/career/sources/fetch.ts under a run clock: fetchJson and the page
// fetcher refuse to start inside the run's reserve (without touching fetch)
// and size their timeout from the clock otherwise.
//
//   npx tsx scripts/reliability/fetch-bounds.ts
//
// globalThis.fetch is replaced by a spy for the duration; no request leaves
// the process.

import os from 'os'
import path from 'path'
import { createRunContext, withRunContext } from '../../lib/runs/context'
import { RunClock } from '../../lib/runs/deadline'
import { makeChecker } from './fake-db'

process.env.PROVIDER_CACHE_DIR = path.join(os.tmpdir(), `outreach-os-scout-reliability-${process.pid}`, 'page-cache')

const t = makeChecker()
type Sources = typeof import('../../lib/career/sources/fetch')

interface Spy {
  calls: { url: string; signal: AbortSignal | null | undefined; abortedAt: number | null; startedAt: number }[]
  restore: () => void
}

const abortError = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })

/** A fetch that never answers, rejecting only when its signal aborts, and records when. */
function installHangingFetch(): Spy {
  const original = globalThis.fetch
  const spy: Spy = { calls: [], restore: () => (globalThis.fetch = original) }
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), signal: init?.signal, abortedAt: null as number | null, startedAt: Date.now() }
    spy.calls.push(call)
    return new Promise<Response>((_, reject) =>
      init?.signal?.addEventListener('abort', () => {
        call.abortedAt = Date.now()
        reject(abortError())
      })
    )
  }) as typeof fetch
  return spy
}

async function main() {
  const sources: Sources = await import('../../lib/career/sources/fetch')
  const fetcher = sources.createPageFetcher({ skipRobots: true, bypassCache: true, minGapMs: 0 })

  console.log('\ninside the reserve: refused without calling fetch')
  {
    const spy = installHangingFetch()
    try {
      // 1 s budget, 400 ms reserve: 600 ms of work left, under the 1.5 s floor.
      const clock = RunClock.forBudget(1_000, { finalizeReserveMs: 400 })
      const ctx = createRunContext({ runId: 'r-reserve', kind: 'jobs', clock })
      const [j, p] = await withRunContext(ctx, () => Promise.all([sources.fetchJson('https://boards.example.com/api/jobs'), fetcher.fetch('https://careers.example.com/jobs')]))
      t.check('fetchJson refuses with a "run deadline" error', j.status === 0 && j.data === null && /run deadline/.test(j.error ?? ''), JSON.stringify(j))
      t.check('the page fetcher refuses with a "run deadline" error', p.status === 0 && /run deadline/.test(p.error ?? '') && p.text === '', JSON.stringify({ s: p.status, e: p.error }))
      t.check('fetch was never called', spy.calls.length === 0, String(spy.calls.length))
      t.check('boundedTimeoutMs is 0 in the reserve', withRunContext(ctx, async () => sources.boundedTimeoutMs(15_000)) instanceof Promise && (await withRunContext(ctx, async () => sources.boundedTimeoutMs(15_000))) === 0)
    } finally {
      spy.restore()
    }
  }

  console.log('\noutside the reserve: the timeout is sized from the clock')
  {
    const spy = installHangingFetch()
    try {
      // 2.5 s budget, 0.5 s reserve: 2 s of work. Both ceilings (15 s, 12 s)
      // are larger, so both requests must be aborted at about 2 s.
      const clock = RunClock.forBudget(2_500, { finalizeReserveMs: 500 })
      const ctx = createRunContext({ runId: 'r-sized', kind: 'jobs', clock })
      const expected = await withRunContext(ctx, async () => sources.boundedTimeoutMs(15_000))
      t.check('boundedTimeoutMs is what the clock has left for work', expected > 1_800 && expected <= 2_000, String(expected))
      const started = Date.now()
      const [j, p] = await withRunContext(ctx, () => Promise.all([sources.fetchJson('https://boards.example.com/api/jobs', { timeoutMs: 15_000 }), fetcher.fetch('https://careers.example.com/jobs')]))
      const took = Date.now() - started
      t.check('fetchJson reports a timeout, status 0', j.status === 0 && j.error === 'timeout', JSON.stringify(j))
      t.check('the page fetcher reports the timeout', p.status === 0 && /timeout/.test(p.error ?? ''), JSON.stringify({ s: p.status, e: p.error }))
      t.check('fetch was called for both', spy.calls.length === 2, String(spy.calls.length))
      const aborts = spy.calls.map((c) => (c.abortedAt ?? 0) - c.startedAt)
      t.check('both requests were aborted at about the clock\'s 2 s, not their 12-15 s ceilings', aborts.every((ms) => ms >= 1_800 && ms < 2_600), aborts.join(','))
      t.check('the pair returned before the run deadline', took < 2_500 + 300, `${took} ms`)
    } finally {
      spy.restore()
    }
  }

  console.log('\noutside any run: the ceiling stands')
  {
    const spy = installHangingFetch()
    try {
      const started = Date.now()
      const j = await sources.fetchJson('https://boards.example.com/api/jobs', { timeoutMs: 300 })
      const took = Date.now() - started
      t.check('fetchJson with its own 300 ms ceiling aborts at about 300 ms', j.status === 0 && j.error === 'timeout' && took >= 280 && took < 900, `${took} ms ${JSON.stringify(j)}`)
      t.check('outside a run boundedTimeoutMs returns the ceiling', sources.boundedTimeoutMs(15_000) === 15_000)
      const p = await fetcher.fetch('https://careers.example.com/x', { timeoutMs: 200 })
      t.check('the page fetcher with its own ceiling aborts too', p.status === 0 && /timeout/.test(p.error ?? ''), JSON.stringify({ s: p.status, e: p.error }))
    } finally {
      spy.restore()
    }
  }

  console.log('\npolicy refusals never reach fetch')
  {
    const spy = installHangingFetch()
    try {
      const li = await fetcher.fetch('https://www.linkedin.com/in/someone')
      t.check('an excluded platform is refused before any request', li.robots_blocked && /excluded/.test(li.error ?? '') && spy.calls.length === 0)
      const bad = await fetcher.fetch('not a url')
      t.check('an invalid URL is refused', /invalid url/.test(bad.error ?? '') && spy.calls.length === 0)
    } finally {
      spy.restore()
    }
  }

  t.finish('fetch-bounds')
}

main().catch((e) => {
  console.error('fetch-bounds suite crashed', e)
  process.exitCode = 1
})
