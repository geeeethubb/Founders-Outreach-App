// The worker's address and the dispatch to it (lib/career/scout/worker-target.ts).
//
//   npx tsx scripts/reliability/dispatch.ts
//
// resolveWorkerBase is pure and takes its env; dispatchScoutWorker takes a
// fetchImpl. Nothing here touches the network. The never-settling fetch case
// also proves the process exits promptly without awaiting `settled`.

import { dispatchScoutWorker, isOwnVercelHost, resolveWorkerBase, workerAuthHeaders, WORKER_PATH, DISPATCH_ACCEPT_TIMEOUT_MS } from '../../lib/career/scout/worker-target'
import { checkWorkerBase } from '../../lib/career/scout/worker-env'
import { makeChecker } from './fake-db'

const t = makeChecker()
type Env = Record<string, string | undefined>
const headers = (h: Record<string, string>) => ({ get: (k: string) => h[k.toLowerCase()] ?? null })

const VERCEL: Env = { VERCEL: '1', VERCEL_ENV: 'production', VERCEL_URL: 'app-abc123def-team.vercel.app', VERCEL_PROJECT_PRODUCTION_URL: 'app.vercel.app', VERCEL_DEPLOYMENT_ID: 'dpl_1' }

function resolveCases() {
  console.log('\nresolveWorkerBase: every source')
  {
    const b = resolveWorkerBase(headers({ host: 'evil.example' }), { ...VERCEL, SCOUT_WORKER_BASE_URL: 'https://my-app.example.com/', VERCEL_AUTOMATION_BYPASS_SECRET: 's3cret' })
    t.check('explicit SCOUT_WORKER_BASE_URL wins everywhere (trailing slash trimmed)', b.source === 'env:SCOUT_WORKER_BASE_URL' && b.baseUrl === 'https://my-app.example.com' && b.problem === null, JSON.stringify(b))
    t.check('explicit: the header host is ignored and reported', b.ignoredHeaderHost === 'evil.example')
    t.same('explicit FOREIGN host: the bypass secret is NOT attached', b.headers, {})
  }
  {
    const b = resolveWorkerBase(null, { ...VERCEL, SCOUT_WORKER_BASE_URL: 'https://app.vercel.app', VERCEL_AUTOMATION_BYPASS_SECRET: 's3cret' })
    t.same('explicit OWN vercel host: the bypass secret is attached', b.headers, { 'x-vercel-protection-bypass': 's3cret' })
  }
  {
    const b = resolveWorkerBase(null, { ...VERCEL, SCOUT_WORKER_BASE_URL: 'http://localhost:3000' })
    t.check('explicit loopback on Vercel is a problem, not an address to use', b.problem !== null && /loopback/.test(b.problem.message) && /production URL/.test(b.problem.remedy), JSON.stringify(b.problem))
    t.check('worker-env agrees: error', checkWorkerBase({ ...VERCEL, SCOUT_WORKER_BASE_URL: 'http://localhost:3000' }, b).severity === 'error')
  }
  {
    const b = resolveWorkerBase(null, { ...VERCEL, VERCEL_ENV: 'preview', VERCEL_AUTOMATION_BYPASS_SECRET: 's3cret' })
    t.check('VERCEL_URL + bypass: same deployment, https added', b.source === 'env:VERCEL_URL+bypass' && b.baseUrl === 'https://app-abc123def-team.vercel.app', JSON.stringify(b))
    t.same('VERCEL_URL + bypass: the header is attached', b.headers, { 'x-vercel-protection-bypass': 's3cret' })
    t.check('VERCEL_URL + bypass: worker-env says ok', checkWorkerBase({ ...VERCEL, VERCEL_ENV: 'preview', VERCEL_AUTOMATION_BYPASS_SECRET: 's3cret' }, b).severity === 'ok')
  }
  {
    const b = resolveWorkerBase(null, VERCEL)
    t.check('production alias without a secret', b.source === 'env:VERCEL_PROJECT_PRODUCTION_URL' && b.baseUrl === 'https://app.vercel.app' && b.problem === null, JSON.stringify(b))
    t.same('alias: no bypass header without a secret', b.headers, {})
  }
  {
    const env = { VERCEL: '1', VERCEL_ENV: 'production', NEXT_PUBLIC_APP_URL: 'https://app.example.com' }
    const b = resolveWorkerBase(null, env)
    t.check('production NEXT_PUBLIC_APP_URL (https, not loopback) as the last resort', b.source === 'env:NEXT_PUBLIC_APP_URL' && b.baseUrl === 'https://app.example.com', JSON.stringify(b))
    t.check('worker-env calls it a guess (warn)', checkWorkerBase(env, b).severity === 'warn')
    const http = resolveWorkerBase(null, { ...env, NEXT_PUBLIC_APP_URL: 'http://app.example.com' })
    t.check('an http NEXT_PUBLIC_APP_URL is refused on production', http.source === 'unresolved' && http.problem !== null)
    const loop = resolveWorkerBase(null, { ...env, NEXT_PUBLIC_APP_URL: 'https://localhost:3000' })
    t.check('a loopback NEXT_PUBLIC_APP_URL is refused on production', loop.source === 'unresolved')
  }
  {
    const b = resolveWorkerBase(headers({ 'x-forwarded-host': 'app-abc123def-team.vercel.app' }), { VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_URL: 'app-abc123def-team.vercel.app', VERCEL_PROJECT_PRODUCTION_URL: 'app.vercel.app' })
    t.check('PREVIEW without a bypass is refused — never routed to production', b.source === 'unresolved' && b.baseUrl === '' && b.problem !== null && /preview/.test(b.problem.message), JSON.stringify(b))
    t.check('preview refusal names the remedy (Protection Bypass or SCOUT_WORKER_BASE_URL)', /Protection Bypass for Automation/.test(b.problem?.remedy ?? '') && /SCOUT_WORKER_BASE_URL/.test(b.problem?.remedy ?? ''))
    t.check('preview refusal ignores the forwarded host', b.ignoredHeaderHost === 'app-abc123def-team.vercel.app')
    t.check('worker-env: error', checkWorkerBase({ VERCEL: '1', VERCEL_ENV: 'preview' }, b).severity === 'error')
  }
  {
    const b = resolveWorkerBase(null, { VERCEL: '1', VERCEL_ENV: 'production' })
    t.check('production with nothing configured is refused with the production message', b.source === 'unresolved' && /No worker address is configured for production/.test(b.problem?.message ?? ''), JSON.stringify(b.problem))
  }
  {
    const b = resolveWorkerBase(headers({ host: 'localhost:3000' }), { NEXT_PUBLIC_APP_URL: 'http://localhost:3001/' })
    t.check('off Vercel: NEXT_PUBLIC_APP_URL first', b.source === 'env:NEXT_PUBLIC_APP_URL' && b.baseUrl === 'http://localhost:3001')
    const h = resolveWorkerBase(headers({ 'x-forwarded-host': '127.0.0.1:4000' }), {})
    t.check('off Vercel: a loopback header host is honoured', h.source === 'header:loopback' && h.baseUrl === 'http://127.0.0.1:4000')
    const evil = resolveWorkerBase(headers({ 'x-forwarded-host': 'attacker.example' }), {})
    t.check('off Vercel: a non-loopback header host is NOT honoured (SSRF)', evil.source === 'default' && evil.baseUrl === 'http://localhost:3000' && evil.ignoredHeaderHost === 'attacker.example', JSON.stringify(evil))
    t.same('off Vercel: never a bypass header', workerAuthHeaders({ VERCEL_AUTOMATION_BYPASS_SECRET: 's3cret' }, 'https://app.vercel.app'), {})
  }
  {
    t.check('isOwnVercelHost: VERCEL_URL, branch, production, any *.vercel.app', isOwnVercelHost('https://app-abc123def-team.vercel.app', VERCEL) && isOwnVercelHost('https://other.vercel.app', {}) && !isOwnVercelHost('https://tunnel.ngrok.io', VERCEL) && !isOwnVercelHost('not a url', VERCEL))
    t.same('workerAuthHeaders without a target attaches when on Vercel with a secret', workerAuthHeaders({ VERCEL: '1', VERCEL_AUTOMATION_BYPASS_SECRET: ' s3cret ' }), { 'x-vercel-protection-bypass': 's3cret' })
    t.same('workerAuthHeaders with an empty secret attaches nothing', workerAuthHeaders({ VERCEL: '1', VERCEL_AUTOMATION_BYPASS_SECRET: '  ' }), {})
  }
}

interface Seen {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

function fakeFetch(answer: (seen: Seen, signal: AbortSignal | null | undefined) => Promise<Response>) {
  const seen: Seen[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const s: Seen = { url: String(input), method: init?.method ?? 'GET', headers: { ...((init?.headers as Record<string, string>) ?? {}) }, body: typeof init?.body === 'string' ? init.body : '' }
    seen.push(s)
    return answer(s, init?.signal)
  }) as typeof fetch
  return { seen, fetchImpl }
}

const abortError = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })

async function dispatchCases() {
  console.log('\ndispatchScoutWorker: outcomes')
  const target = { baseUrl: 'https://app.vercel.app/', headers: { 'x-vercel-protection-bypass': 's3cret' } }
  for (const status of [200, 202]) {
    const f = fakeFetch(async () => new Response(JSON.stringify({ ok: true }), { status }))
    const d = await dispatchScoutWorker(target, 'run-1', 'tok-1', { raceMs: 500, fetchImpl: f.fetchImpl })
    t.check(`${status} → accepted, dispatched`, d.outcome === 'accepted' && d.dispatched && d.status === status && d.error === null, JSON.stringify({ o: d.outcome, s: d.status, e: d.error }))
    const s = f.seen[0]
    t.check(`${status}: POST to ${WORKER_PATH} with the token and the bypass header`, s.method === 'POST' && s.url === `https://app.vercel.app${WORKER_PATH}` && s.headers['x-vercel-protection-bypass'] === 's3cret' && s.headers['content-type'] === 'application/json' && JSON.parse(s.body).token === 'tok-1' && JSON.parse(s.body).runId === 'run-1', JSON.stringify(s))
    const settled = await d.settled
    t.check(`${status}: settled agrees`, settled.outcome === 'accepted' && settled.status === status)
  }
  {
    const f = fakeFetch(async () => new Response(JSON.stringify({ error: 'run is not claimable', code: 'CLAIM' }), { status: 409 }))
    const d = await dispatchScoutWorker(target, 'run-1', 'tok-1', { raceMs: 500, fetchImpl: f.fetchImpl })
    t.check('409 → claimed_elsewhere, counts as dispatched, no error', d.outcome === 'claimed_elsewhere' && d.dispatched === true && d.error === null && d.status === 409, JSON.stringify({ o: d.outcome, d: d.dispatched }))
  }
  for (const status of [401, 403]) {
    const f = fakeFetch(async () => new Response('Authentication Required', { status }))
    const d = await dispatchScoutWorker(target, 'run-1', 'tok-1', { raceMs: 500, fetchImpl: f.fetchImpl })
    t.check(`${status} → failed with the Deployment Protection remedy`, d.outcome === 'failed' && !d.dispatched && d.status === status && /Deployment Protection/.test(d.error ?? '') && /Protection Bypass for Automation/.test(d.error ?? '') && /SCOUT_WORKER_BASE_URL/.test(d.error ?? ''), d.error ?? 'null')
    t.check(`${status}: the error names the URL`, (d.error ?? '').includes(`https://app.vercel.app${WORKER_PATH}`))
  }
  {
    const f = fakeFetch(async () => new Response('not found', { status: 404 }))
    const d = await dispatchScoutWorker(target, 'run-1', 'tok-1', { raceMs: 500, fetchImpl: f.fetchImpl })
    t.check('404 → failed, "without this route"', d.outcome === 'failed' && d.status === 404 && /HTTP 404/.test(d.error ?? '') && /without this route/.test(d.error ?? ''), d.error ?? 'null')
  }
  {
    const f = fakeFetch(async () => new Response('<html>500</html>', { status: 500 }))
    const d = await dispatchScoutWorker(target, 'run-1', 'tok-1', { raceMs: 500, fetchImpl: f.fetchImpl })
    t.check('500 → failed with the status', d.outcome === 'failed' && d.status === 500 && /HTTP 500/.test(d.error ?? ''), d.error ?? 'null')
  }
  {
    const f = fakeFetch(async () => {
      throw new TypeError('fetch failed: ECONNREFUSED')
    })
    const d = await dispatchScoutWorker(target, 'run-1', 'tok-1', { raceMs: 500, fetchImpl: f.fetchImpl })
    t.check('network throw → failed with the message and the URL', d.outcome === 'failed' && d.status === null && /ECONNREFUSED/.test(d.error ?? '') && /dispatching to https:\/\/app.vercel.app/.test(d.error ?? ''), d.error ?? 'null')
  }
  {
    const d = await dispatchScoutWorker({ baseUrl: '', headers: {} }, 'run-1', 'tok-1', { raceMs: 500, fetchImpl: fakeFetch(async () => new Response('')).fetchImpl })
    t.check('no base URL → failed without a request', d.outcome === 'failed' && /no worker address/.test(d.error ?? ''))
  }
  // Both of the dispatch's own timers are unref'd, and a fake fetch holds no
  // socket, so nothing below would keep the event loop alive during the race
  // and Node would exit mid-await with status 0. A real fetch holds a handle;
  // here a ref'd interval stands in for it, and is cleared before the end so
  // the "exits promptly" property is still what is measured.
  const keepAlive = setInterval(() => undefined, 1_000)
  try {
    await neverAnswers()
  } finally {
    clearInterval(keepAlive)
  }
}

async function neverAnswers() {
  const target = { baseUrl: 'https://app.vercel.app/', headers: {} }
  {
    console.log('\ndispatchScoutWorker: a worker that never answers')
    const f = fakeFetch((_s, signal) => new Promise<Response>((_, reject) => signal?.addEventListener('abort', () => reject(abortError()))))
    const started = Date.now()
    const d = await dispatchScoutWorker(target, 'run-1', 'tok-1', { raceMs: 150, fetchImpl: f.fetchImpl })
    const took = Date.now() - started
    t.check('pending after raceMs, still "dispatched"', d.outcome === 'pending' && d.dispatched === true && d.status === null && d.error === null, JSON.stringify({ o: d.outcome, took }))
    t.check('the race returned at about raceMs', took >= 140 && took < 1_000, `${took} ms`)
    let settledYet = false
    void d.settled.then(() => (settledYet = true))
    await new Promise((r) => setTimeout(r, 20))
    t.check('settled is still in flight', settledYet === false)
    d.abort()
    const s = await d.settled
    t.check('abort() settles it as failed with the accept timeout sentence', s.outcome === 'failed' && /did not accept the run within/.test(s.error ?? '') && new RegExp(`${Math.round(DISPATCH_ACCEPT_TIMEOUT_MS / 1000)}s`).test(s.error ?? ''), JSON.stringify(s))
    t.check('abort() is safe to call twice', (() => { d.abort(); return true })())
  }
  {
    // A never-settling dispatch we do NOT abort: the suite must still exit
    // promptly (the fuse is unref'd, the race timer is cleared). The runner
    // measures this suite's wall time; here we only record that it was left open.
    const f = fakeFetch(() => new Promise<Response>(() => undefined))
    const d = await dispatchScoutWorker(target, 'run-2', 'tok-2', { raceMs: 100, fetchImpl: f.fetchImpl })
    t.check('a never-settling fetch left open is pending (the process must exit anyway)', d.outcome === 'pending')
  }
}

async function main() {
  const started = Date.now()
  resolveCases()
  await dispatchCases()
  console.log(`\n(${((Date.now() - started) / 1000).toFixed(1)}s; the process must exit now — an open dispatch holds no handle)`)
  t.finish('dispatch')
}

main().catch((e) => {
  console.error('dispatch suite crashed', e)
  process.exitCode = 1
})
