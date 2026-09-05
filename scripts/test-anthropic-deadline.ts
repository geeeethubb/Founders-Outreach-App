// The Anthropic client under a run clock: every attempt sized from the run,
// no retry past the deadline, no state shared between runs.
//
// The old test checked a module-level deadline slot. That slot is gone: the
// clock now travels with the run context (AsyncLocalStorage), so what has to
// be proved is different — that a request's timeout is the smaller of the
// provider ceiling and the run's remaining time, that a retry is refused when
// the clock has no room for it, that two concurrent runs see only their own
// clocks and their own usage, and that a run that throws leaves nothing behind.
//
// A fake SDK client stands in for Anthropic. It honours the per-request
// `timeout` the client passes, exactly as the real SDK does, so "a request that
// never resolves" is a request that rejects with APIConnectionTimeoutError at
// the timeout the client chose — which is the whole point under test.
//
// No network, no keys.
//
//   npx tsx scripts/test-anthropic-deadline.ts

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-ant-test-not-a-real-key'

import type Anthropic from '@anthropic-ai/sdk'
import {
  __pastRunDeadlineForTests,
  __setAnthropicClientForTests,
  anthropicComplete,
  anthropicStructured,
  anthropicUsage,
  attemptTimeoutMs,
  DEFAULT_REQUEST_TIMEOUT_MS,
  resetAnthropicUsage,
  SEARCH_REQUEST_TIMEOUT_MS,
  usesWebSearch,
  withAnthropicDeadline,
} from '../lib/providers/anthropic/client'
import { createRunContext, currentRunClock, currentRunContext, withRunContext } from '../lib/runs/context'
import { RunClock } from '../lib/runs/deadline'

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

// ─── A fake SDK ──────────────────────────────────────────────────────────────

type Behaviour =
  | { kind: 'ok'; text?: string; delayMs?: number }
  | { kind: 'status'; status: number }
  | { kind: 'network' }
  | { kind: 'hang' }

interface Call {
  at: number
  timeout: number | undefined
}

function fakeClient(script: Behaviour[]) {
  const calls: Call[] = []
  let i = 0
  const client = {
    messages: {
      create: (_params: unknown, opts?: { timeout?: number }) =>
        new Promise((resolve, reject) => {
          const b = script[Math.min(i, script.length - 1)]
          i++
          calls.push({ at: Date.now(), timeout: opts?.timeout })
          const respond = () =>
            resolve({
              content: [{ type: 'text', text: (b as { text?: string }).text ?? 'hello' }],
              usage: { input_tokens: 10, output_tokens: 5 },
              stop_reason: 'end_turn',
            })
          if (b.kind === 'ok') {
            if (b.delayMs) setTimeout(respond, b.delayMs)
            else respond()
            return
          }
          if (b.kind === 'status') {
            reject(Object.assign(new Error(`HTTP ${b.status}`), { status: b.status }))
            return
          }
          if (b.kind === 'network') {
            reject(new Error('fetch failed: ECONNRESET'))
            return
          }
          // hang: only the client's own timeout ends this — as with the real SDK.
          const t = opts?.timeout
          if (typeof t === 'number' && Number.isFinite(t)) {
            setTimeout(() => reject(Object.assign(new Error(`Request timed out after ${t}ms.`), { name: 'APIConnectionTimeoutError' })), t)
          }
        }),
    },
  }
  __setAnthropicClientForTests(client as unknown as Anthropic)
  return { calls }
}

const msg = (stage = 'test') => ({ role: 'reasoning' as const, messages: [{ role: 'user' as const, content: 'hi' }], stage })
const search = () => ({ ...msg('search'), tools: [{ type: 'web_search_20250305', name: 'web_search' }] })

/** A run context whose clock runs for `budgetMs`, with a tiny minimum attempt so tests stay fast. */
function runFor<T>(budgetMs: number, fn: () => Promise<T>, opts: { reserveMs?: number; label?: string } = {}): Promise<T> {
  const clock = new RunClock({ hardDeadlineAt: Date.now() + budgetMs, finalizeReserveMs: opts.reserveMs ?? 0, minAttemptMs: 100 })
  return withRunContext(createRunContext({ clock, kind: 'people', label: opts.label ?? 'test', runId: opts.label ?? null }), fn)
}

async function main(): Promise<void> {
  console.log('1. normal completion')
  {
    resetAnthropicUsage()
    const f = fakeClient([{ kind: 'ok', text: 'fine' }])
    const r = await anthropicComplete(msg())
    check('a plain call succeeds', r.text === 'fine' && !r.error && r.attempts === 1, r.error ?? '')
    check('outside a run the attempt gets the provider ceiling', f.calls[0].timeout === DEFAULT_REQUEST_TIMEOUT_MS, String(f.calls[0].timeout))
    check('usage is recorded', anthropicUsage().calls === 1 && anthropicUsage().errors === 0)
  }

  console.log('\n2. 429 then success')
  {
    resetAnthropicUsage()
    const f = fakeClient([{ kind: 'status', status: 429 }, { kind: 'ok', text: 'after-429' }])
    const started = Date.now()
    const { r, usage } = await runFor(30_000, async () => ({ r: await anthropicComplete(msg()), usage: anthropicUsage() }))
    check('a rate limit is retried and the call succeeds', r.text === 'after-429' && r.attempts === 2, r.error ?? '')
    check('the retry waited a bounded backoff', f.calls.length === 2 && f.calls[1].at - f.calls[0].at >= 300 && Date.now() - started < 5_000, `${f.calls[1].at - f.calls[0].at}ms`)
    check('the retry is counted on the run’s own usage', usage.retries === 1 && usage.errors === 0 && usage.calls === 1, JSON.stringify({ retries: usage.retries, errors: usage.errors, calls: usage.calls }))
  }

  console.log('\n3. 500 then success')
  {
    resetAnthropicUsage()
    fakeClient([{ kind: 'status', status: 500 }, { kind: 'ok', text: 'after-500' }])
    const r = await runFor(30_000, () => anthropicComplete(msg()))
    check('a 5xx is retried and the call succeeds', r.text === 'after-500' && r.attempts === 2, r.error ?? '')
  }
  {
    resetAnthropicUsage()
    fakeClient([{ kind: 'status', status: 400 }])
    const r = await runFor(30_000, () => anthropicComplete(msg()))
    check('a deterministic 4xx is NOT retried', r.attempts === 1 && Boolean(r.error) && r.errorCode === 'PROVIDER_ERROR', `${r.attempts} attempt(s), ${r.errorCode}`)
  }

  console.log('\n4. repeated network timeout')
  {
    resetAnthropicUsage()
    const f = fakeClient([{ kind: 'hang' }])
    const started = Date.now()
    // 2.5s of run: attempt 1 gets ~2.5s, times out, and the client must give
    // up BEFORE the run's deadline rather than sleeping and hanging again.
    const r = await runFor(2_500, () => anthropicComplete(msg()))
    const elapsed = Date.now() - started
    check('a hung request is cut at the run’s remaining time, not at 120s', f.calls[0].timeout !== undefined && f.calls[0].timeout <= 2_500, String(f.calls[0].timeout))
    check('control returns before the run deadline (+ a small margin)', elapsed < 3_200, `${elapsed}ms`)
    check('and the failure is classified as the run’s deadline', r.errorCode === 'RUN_DEADLINE', `${r.errorCode}: ${r.error}`)
    check('no second attempt was started after the clock ran out', f.calls.length === 1, `${f.calls.length} call(s)`)
  }
  {
    resetAnthropicUsage()
    const f = fakeClient([{ kind: 'network' }, { kind: 'network' }, { kind: 'network' }, { kind: 'network' }])
    const r = await runFor(60_000, () => anthropicComplete(msg()))
    check('a network fault is retried up to the attempt cap and then reported', r.attempts === 4 && r.errorCode === 'PROVIDER_TIMEOUT' && f.calls.length === 4, `${r.attempts} attempts, ${r.errorCode}`)
  }

  console.log('\n5. a web-search call near the run deadline')
  {
    check('a server-side web_search tool is recognised', usesWebSearch(search().tools) && !usesWebSearch(undefined))
    check('the search ceiling exceeds the default', SEARCH_REQUEST_TIMEOUT_MS > DEFAULT_REQUEST_TIMEOUT_MS)
    resetAnthropicUsage()
    const f = fakeClient([{ kind: 'ok', text: 'searched' }])
    const r = await runFor(8_000, () => anthropicComplete(search()))
    check('a search call gets min(300s ceiling, remaining run time)', f.calls[0].timeout !== undefined && f.calls[0].timeout <= 8_000 && f.calls[0].timeout > 6_000, String(f.calls[0].timeout))
    check('and still succeeds', r.text === 'searched')
  }
  {
    resetAnthropicUsage()
    const f = fakeClient([{ kind: 'ok' }])
    // 50ms of run left, minimum attempt 100ms: the attempt is not worth starting.
    const r = await runFor(50, () => anthropicComplete(search()))
    check('with less than a minimum attempt left, the request is NOT sent', f.calls.length === 0 && r.errorCode === 'RUN_DEADLINE', `${f.calls.length} call(s), ${r.errorCode}`)
    check('the error says how much was left', /not started/.test(r.error ?? ''), r.error ?? '')
  }
  {
    // The reserve counts: a 10s run with an 8s reserve has 2s of work time.
    const clock = new RunClock({ hardDeadlineAt: Date.now() + 10_000, finalizeReserveMs: 4_000, minAttemptMs: 100 })
    check('attemptTimeoutMs never exceeds the time before the reserve', attemptTimeoutMs(300_000, clock) <= 6_000 && attemptTimeoutMs(300_000, clock) > 5_000, String(attemptTimeoutMs(300_000, clock)))
  }

  console.log('\n6. a retry requested after the deadline')
  {
    resetAnthropicUsage()
    const f = fakeClient([{ kind: 'status', status: 429 }, { kind: 'ok' }])
    const started = Date.now()
    // 400ms of run: the 429 comes back at once, and a backoff of 350–700ms
    // would end past the deadline — so no sleep, no second attempt.
    const r = await runFor(400, () => anthropicComplete(msg()))
    check('a retry that would end past the deadline is refused', f.calls.length === 1 && r.errorCode === 'RUN_DEADLINE', `${f.calls.length} call(s), ${r.errorCode}`)
    check('and it returned promptly instead of sleeping into the deadline', Date.now() - started < 1_000, `${Date.now() - started}ms`)
    // Either the sleep was refused outright, or it was bounded and the next
    // attempt found no room — both are the deadline refusing the retry.
    check('the refusal names the retry or the empty clock', /before retry|not started/.test(r.error ?? ''), r.error ?? '')
  }

  console.log('\n7. two simultaneous runs with different deadlines')
  {
    resetAnthropicUsage()
    const f = fakeClient([{ kind: 'ok', delayMs: 200 }])
    const [short, long] = await Promise.all([
      runFor(700, async () => {
        const before = currentRunClock()?.remainingMs() ?? -1
        const r = await anthropicComplete(msg('short'))
        return { before, r, usage: anthropicUsage(), clock: currentRunClock() }
      }, { label: 'run-short' }),
      runFor(60_000, async () => {
        const before = currentRunClock()?.remainingMs() ?? -1
        const r = await anthropicComplete(msg('long'))
        return { before, r, usage: anthropicUsage(), clock: currentRunClock() }
      }, { label: 'run-long' }),
    ])
    check('each run sees its own remaining time', short.before <= 700 && long.before > 50_000, `${short.before} vs ${long.before}`)
    check('the short run’s attempt was sized from ITS clock', f.calls.some((c) => c.timeout !== undefined && c.timeout <= 700))
    // 60s of run is shorter than the 120s ceiling, so the long run's attempt is sized to its own clock — not to the short run's, and not to the ceiling.
    check('the long run’s attempt was sized from ITS clock', f.calls.some((c) => c.timeout !== undefined && c.timeout > 50_000 && c.timeout <= 60_000), f.calls.map((c) => c.timeout).join(','))
    check('both calls succeeded', short.r.text === 'hello' && long.r.text === 'hello', `${short.r.error ?? ''} ${long.r.error ?? ''}`)
    check('usage is accounted per run, not shared', short.usage.calls === 1 && long.usage.calls === 1)
    check('the process-wide usage saw neither', anthropicUsage().calls === 0, String(anthropicUsage().calls))
    check('neither run’s clock leaked outside', currentRunClock() === null && currentRunContext() === null)
  }
  {
    // The two shapes nest: a package deadline inside a scout run takes the EARLIER of the two and keeps the outer identity.
    const outerSaw = await runFor(60_000, async () => {
      const inner = await withAnthropicDeadline(Date.now() + 5_000, async () => ({ ctx: currentRunContext(), remaining: currentRunClock()?.remainingMs() ?? -1 }))
      return { innerRemaining: inner.remaining, innerLabel: inner.ctx?.label, outerRemaining: currentRunClock()?.remainingMs() ?? -1 }
    }, { label: 'outer' })
    check('a nested deadline is the earlier of the two', outerSaw.innerRemaining <= 5_000 && outerSaw.innerRemaining > 3_000, String(outerSaw.innerRemaining))
    check('and the outer run’s identity is kept', outerSaw.innerLabel === 'outer', String(outerSaw.innerLabel))
    check('and the outer clock is untouched afterwards', outerSaw.outerRemaining > 50_000, String(outerSaw.outerRemaining))
    const alone = await withAnthropicDeadline(Date.now() + 5_000, async () => currentRunClock()?.remainingMs() ?? -1)
    check('a lone package deadline still arms a clock', alone <= 5_000 && alone > 3_000, String(alone))
  }

  console.log('\n8. a thrown orchestrator leaves no deadline state behind')
  {
    resetAnthropicUsage()
    fakeClient([{ kind: 'ok' }])
    let threw = false
    try {
      await runFor(50, async () => {
        check('inside the doomed run the deadline is (nearly) past', __pastRunDeadlineForTests())
        throw new Error('the planner exploded')
      })
    } catch {
      threw = true
    }
    check('the orchestrator’s throw propagates', threw)
    check('afterwards there is no ambient clock at all', currentRunClock() === null && !__pastRunDeadlineForTests())
  }

  console.log('\n9. the next run after a failed run starts normally')
  {
    resetAnthropicUsage()
    const f = fakeClient([{ kind: 'ok', text: 'fresh' }])
    const r = await runFor(30_000, () => anthropicComplete(msg()))
    check('a later run is not poisoned by the earlier one', r.text === 'fresh' && f.calls[0].timeout !== undefined && f.calls[0].timeout > 25_000 && f.calls[0].timeout <= 30_000, `${r.error ?? ''} timeout=${f.calls[0].timeout}`)
    const outside = await anthropicComplete(msg())
    check('and a call outside any run still gets the full ceiling', outside.text === 'fresh' && f.calls[1].timeout === DEFAULT_REQUEST_TIMEOUT_MS)
  }

  console.log('\nstructured calls obey the same clock')
  {
    resetAnthropicUsage()
    const f = fakeClient([{ kind: 'ok' }])
    const r = await runFor(50, () =>
      anthropicStructured({ role: 'reasoning', messages: [{ role: 'user', content: 'x' }], schemaName: 's', schemaDescription: 'd', schema: {}, validate: () => null })
    )
    check('a structured call with no time left is not sent', f.calls.length === 0 && r.errorCode === 'RUN_DEADLINE', `${f.calls.length} call(s), ${r.errorCode}`)
  }

  __setAnthropicClientForTests(null)
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
