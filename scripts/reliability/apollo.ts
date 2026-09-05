// The Apollo client under fault injection (lib/providers/apollo/client.ts),
// through its fetch seam: retries, deterministic failures, a fetch that never
// resolves, a body that never arrives, the key never in the log, and per-run
// stats isolation.
//
//   npx tsx scripts/reliability/apollo.ts
//
// No keys (a fake one is set below and must never appear in the output), no
// network, and the disk cache is pointed at a temp directory that is removed.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRunContext, withRunContext } from '../../lib/runs/context'
import { RunClock } from '../../lib/runs/deadline'
import { captureConsole, makeChecker } from './fake-db'

const FAKE_KEY = 'apollo_test_key_9f8e7d6c5b4a3210FAKEFAKE'
const CACHE_DIR = path.join(os.tmpdir(), `outreach-os-scout-reliability-${process.pid}`, 'provider-cache')
process.env.APOLLO_API_KEY = FAKE_KEY
process.env.PROVIDER_CACHE_DIR = CACHE_DIR
process.env.APOLLO_MIN_GAP_MS = '1'
process.env.APOLLO_TIMEOUT_MS = '1500'
delete process.env.APOLLO_CACHE_ONLY

const t = makeChecker()
type Client = typeof import('../../lib/providers/apollo/client')

interface Call {
  url: string
  headers: Record<string, string>
  signal: AbortSignal | null | undefined
}
type Answer = (call: Call) => Promise<Response>

const abortError = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
const json = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const text = (status: number, body: string) => async () => new Response(body, { status })
const hangUntilAbort: Answer = (c) => new Promise<Response>((_, reject) => c.signal?.addEventListener('abort', () => reject(abortError())))
const hungBody: Answer = async (c) => ({ status: 200, text: () => new Promise<string>((_, reject) => c.signal?.addEventListener('abort', () => reject(abortError()))) }) as unknown as Response
const networkThrow: Answer = async () => {
  throw new TypeError('fetch failed: ECONNRESET')
}

/** A fetch that answers from a script, one entry per attempt (the last repeats). */
function scripted(client: Client, answers: Answer[]) {
  const calls: Call[] = []
  client.__setApolloFetchForTests((async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = { url: String(input), headers: { ...((init?.headers as Record<string, string>) ?? {}) }, signal: init?.signal }
    calls.push(call)
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)]
    return answer(call)
  }) as typeof fetch)
  return calls
}

let n = 0
const body = () => ({ q: `case-${++n}-${Date.now()}` })

async function retries(client: Client) {
  console.log('\nretry policy (real backoff sleeps, ~0.5-1 s each)')
  {
    const calls = scripted(client, [text(429, 'rate limited'), json(200, { people: [1] })])
    const r = await client.apolloRequest<{ people: number[] }>('mixed_people/api_search', body(), { bypassCache: true })
    t.check('429 then 200 → ok on attempt 2', r.ok && r.attempts === 2 && r.data?.people[0] === 1 && calls.length === 2, JSON.stringify({ ok: r.ok, a: r.attempts, e: r.error }))
    t.check('every request carried the key header and never the key in the URL', calls.every((c) => c.headers['X-Api-Key'] === FAKE_KEY && !c.url.includes(FAKE_KEY)))
  }
  {
    const calls = scripted(client, [text(500, 'upstream'), json(200, { ok: 1 })])
    const r = await client.apolloRequest('organizations/enrich', body(), { bypassCache: true })
    t.check('500 then 200 → ok on attempt 2', r.ok && r.attempts === 2 && calls.length === 2, JSON.stringify({ ok: r.ok, a: r.attempts }))
  }
  {
    const calls = scripted(client, [networkThrow, json(200, { ok: 1 })])
    const r = await client.apolloRequest('people/bulk_match', body(), { bypassCache: true })
    t.check('a network throw is retried → ok on attempt 2', r.ok && r.attempts === 2 && calls.length === 2, JSON.stringify({ ok: r.ok, a: r.attempts, e: r.error }))
  }
  {
    const calls = scripted(client, [text(422, '{"error":"insufficient credits"}'), json(200, { ok: 1 })])
    const r = await client.apolloRequest('people/bulk_match', body(), { bypassCache: true })
    t.check('422 is deterministic: no retry, PROVIDER_ERROR', !r.ok && r.status === 422 && r.errorCode === 'PROVIDER_ERROR' && r.attempts === 1 && calls.length === 1, JSON.stringify({ s: r.status, c: r.errorCode, a: r.attempts, calls: calls.length }))
    t.check('the 422 body is in the error sentence', /insufficient credits/.test(r.error ?? ''), r.error ?? 'null')
  }
  {
    const calls = scripted(client, [text(401, 'bad key'), json(200, { ok: 1 })])
    const r = await client.apolloRequest('mixed_people/api_search', body(), { bypassCache: true })
    t.check('401 is deterministic: no retry, AUTHENTICATION', !r.ok && r.errorCode === 'AUTHENTICATION' && calls.length === 1, JSON.stringify({ c: r.errorCode, calls: calls.length }))
  }
  {
    const calls = scripted(client, [text(200, '<html>not json</html>'), json(200, { ok: 1 })])
    const r = await client.apolloRequest('mixed_companies/search', body(), { bypassCache: true })
    t.check('invalid JSON on a 200: no retry, PROVIDER_INVALID_RESPONSE', !r.ok && r.errorCode === 'PROVIDER_INVALID_RESPONSE' && r.attempts === 1 && calls.length === 1 && r.status === 200, JSON.stringify({ c: r.errorCode, a: r.attempts, calls: calls.length }))
  }
  {
    const calls = scripted(client, [text(429, 'x'), text(429, 'x'), text(429, 'x')])
    const r = await client.apolloRequest('mixed_people/api_search', body(), { bypassCache: true })
    t.check('three 429s → PROVIDER_RATE_LIMIT after 3 attempts', !r.ok && r.errorCode === 'PROVIDER_RATE_LIMIT' && r.attempts === 3 && calls.length === 3, JSON.stringify({ c: r.errorCode, a: r.attempts }))
  }
}

async function deadlines(client: Client) {
  console.log('\nrun deadline: a fetch that never resolves')
  {
    // Budget 2 s: after the reserve, less than APOLLO_MIN_ATTEMPT_MS is left,
    // so the request is refused before fetch is called.
    const calls = scripted(client, [hangUntilAbort])
    const clock = RunClock.forBudget(2_000, { finalizeReserveMs: 500, minAttemptMs: 100 })
    const started = Date.now()
    const r = await withRunContext(createRunContext({ runId: 'r-short', kind: 'people', clock }), () => client.apolloRequest('mixed_people/api_search', body(), { bypassCache: true }))
    const took = Date.now() - started
    t.check('a 2 s budget: refused with RUN_DEADLINE before any request', !r.ok && r.errorCode === 'RUN_DEADLINE' && calls.length === 0 && /not started/.test(r.error ?? ''), JSON.stringify({ c: r.errorCode, calls: calls.length, e: r.error }))
    t.check('…and immediately', took < 500, `${took} ms`)
  }
  {
    // Budget 4 s, reserve 0.5 s: one attempt of min(1.5 s ceiling, 3.5 s left)
    // is cut at 1.5 s; the retry has no room and the clock is answered.
    const calls = scripted(client, [hangUntilAbort])
    const clock = RunClock.forBudget(4_000, { finalizeReserveMs: 500, minAttemptMs: 100 })
    const started = Date.now()
    const r = await withRunContext(createRunContext({ runId: 'r-hang', kind: 'people', clock }), () => client.apolloRequest('mixed_people/api_search', body(), { bypassCache: true }))
    const took = Date.now() - started
    t.check('a hung fetch is cut and answered before the run deadline', !r.ok && took < 4_000, `${took} ms, ${r.errorCode}`)
    t.check('the code is RUN_DEADLINE or PROVIDER_TIMEOUT', r.errorCode === 'RUN_DEADLINE' || r.errorCode === 'PROVIDER_TIMEOUT', String(r.errorCode))
    t.check('exactly one request was started and it was aborted', calls.length === 1 && calls[0].signal?.aborted === true, `${calls.length} calls`)
    t.check('the fuse was the 1.5 s ceiling, not the 300 s undici default', took >= 1_300 && took < 2_500, `${took} ms`)
    t.check('the sentence explains the cut', /timed out|deadline/.test(r.error ?? ''), r.error ?? 'null')
  }
  {
    console.log('\nrun deadline: a body that never arrives')
    const calls = scripted(client, [hungBody])
    const clock = RunClock.forBudget(4_000, { finalizeReserveMs: 500, minAttemptMs: 100 })
    const started = Date.now()
    const r = await withRunContext(createRunContext({ runId: 'r-body', kind: 'people', clock }), () => client.apolloRequest('organizations/enrich', body(), { bypassCache: true }))
    const took = Date.now() - started
    t.check('a hung body read is cut under the same fuse', !r.ok && took < 4_000 && (r.errorCode === 'RUN_DEADLINE' || r.errorCode === 'PROVIDER_TIMEOUT'), `${took} ms, ${r.errorCode}`)
    t.check('exactly one request, aborted', calls.length === 1 && calls[0].signal?.aborted === true)
  }
  {
    // Outside a run the ceiling stands; a deterministic answer is unaffected.
    const clockless = scripted(client, [json(200, { ok: 1 })])
    const r = await client.apolloRequest('mixed_people/api_search', body(), { bypassCache: true })
    t.check('outside a run a normal answer is unaffected', r.ok && clockless.length === 1)
  }
}

async function isolation(client: Client) {
  console.log('\nper-run stats isolation')
  scripted(client, [json(200, { ok: 1 })])
  const clock = RunClock.forBudget(60_000)
  const a = createRunContext({ runId: 'A', kind: 'people', clock })
  const b = createRunContext({ runId: 'B', kind: 'jobs', clock })
  const before = client.apolloStats().calls
  const [sa, sb] = await Promise.all([
    withRunContext(a, async () => {
      await Promise.all([client.apolloRequest('mixed_people/api_search', body(), { bypassCache: true }), client.apolloRequest('mixed_people/api_search', body(), { bypassCache: true })])
      return client.apolloStats()
    }),
    withRunContext(b, async () => {
      await client.apolloRequest('organizations/enrich', body(), { bypassCache: true, credits: 1 })
      return client.apolloStats()
    }),
  ])
  t.check('run A counts its own 2 calls', sa.calls === 2 && sa.byEndpoint['mixed_people/api_search'] === 2 && sa.enrichmentCredits === 0, JSON.stringify(sa))
  t.check('run B counts its own 1 call and its credit', sb.calls === 1 && sb.byEndpoint['organizations/enrich'] === 1 && sb.enrichmentCredits === 1, JSON.stringify(sb))
  t.check('the process-wide counter did not absorb either run', client.apolloStats().calls === before, `${client.apolloStats().calls} vs ${before}`)
  const again = await withRunContext(a, async () => client.apolloStats())
  t.check('re-entering run A sees the same slot', again.calls === 2)
  await withRunContext(a, async () => client.resetApolloStats())
  t.check('resetApolloStats inside a run resets that run only', (await withRunContext(a, async () => client.apolloStats())).calls === 0 && (await withRunContext(b, async () => client.apolloStats())).calls === 1)
}

async function main() {
  const client: Client = await import('../../lib/providers/apollo/client')
  t.check('the client sees the key', client.apolloAvailable())
  const { lines } = await captureConsole(async () => {
    await retries(client)
    await deadlines(client)
    await isolation(client)
  })
  for (const l of lines) console.log(l)
  const leaked = lines.filter((l) => l.includes(FAKE_KEY))
  t.check('the API key never appears in captured console output', leaked.length === 0, leaked.slice(0, 2).join(' | '))
  t.check('the client logged structured provider lines', lines.some((l) => /\[scout\] .*provider="apollo"/.test(l)))
  client.__setApolloFetchForTests(null)
  try {
    fs.rmSync(path.dirname(CACHE_DIR), { recursive: true, force: true })
  } catch {
    // a temp dir left behind is not a failure
  }
  t.finish('apollo')
}

main().catch((e) => {
  console.error('apollo suite crashed', e)
  process.exitCode = 1
})
