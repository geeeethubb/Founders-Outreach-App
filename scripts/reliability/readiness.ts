// checkScoutReadiness (lib/runs/readiness.ts) with env, schemaProbe and
// fetchImpl injected — the probe is ON, answered by a fake worker.
//
//   npx tsx scripts/reliability/readiness.ts

import { checkScoutReadiness, resetReadinessCache, type ScoutReadiness } from '../../lib/runs/readiness'
import { WORKER_PATH } from '../../lib/career/scout/worker-target'
import { invocationBudgetMs } from '../../lib/runs/deadline'
import { makeChecker } from './fake-db'

const t = makeChecker()
type Env = Record<string, string | undefined>

const BASE: Env = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  APOLLO_API_KEY: 'apollo',
  CRON_SECRET: 'cron',
}
const VERCEL: Env = { ...BASE, VERCEL: '1', VERCEL_ENV: 'production', VERCEL_URL: 'app-abc123def-team.vercel.app', VERCEL_PROJECT_PRODUCTION_URL: 'app.vercel.app', VERCEL_DEPLOYMENT_ID: 'dpl_me' }

interface Probe {
  calls: { url: string; headers: Record<string, string> }[]
  fetchImpl: typeof fetch
}

function worker(answer: (url: string) => Response | Promise<Response>): Probe {
  const calls: Probe['calls'] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: { ...((init?.headers as Record<string, string>) ?? {}) } })
    return answer(String(input))
  }) as typeof fetch
  return { calls, fetchImpl }
}

const healthy = (env: Env, deployment = env.VERCEL_DEPLOYMENT_ID ?? null) => worker(() => new Response(JSON.stringify({ ok: true, worker: 'scout', deployment, budget_ms: invocationBudgetMs(env) }), { status: 200, headers: { 'content-type': 'application/json' } }))

const find = (r: ScoutReadiness, id: string) => r.checks.find((c) => c.id === id) ?? null

async function run(env: Env, probe: Probe, extra: Parameters<typeof checkScoutReadiness>[0] = {}) {
  resetReadinessCache()
  return checkScoutReadiness({ env, probe: true, schemaProbe: async () => null, fetchImpl: probe.fetchImpl, ...extra })
}

async function sources() {
  console.log('\nworker-base sources, probed')
  const cases: { name: string; env: Env; source: string; url: string; bypass: boolean }[] = [
    { name: 'explicit', env: { ...VERCEL, SCOUT_WORKER_BASE_URL: 'https://app.vercel.app' }, source: 'env:SCOUT_WORKER_BASE_URL', url: 'https://app.vercel.app', bypass: false },
    { name: 'VERCEL_URL+bypass', env: { ...VERCEL, VERCEL_AUTOMATION_BYPASS_SECRET: 's3cret' }, source: 'env:VERCEL_URL+bypass', url: 'https://app-abc123def-team.vercel.app', bypass: true },
    { name: 'production alias', env: VERCEL, source: 'env:VERCEL_PROJECT_PRODUCTION_URL', url: 'https://app.vercel.app', bypass: false },
    { name: 'NEXT_PUBLIC_APP_URL on production', env: { ...BASE, VERCEL: '1', VERCEL_ENV: 'production', NEXT_PUBLIC_APP_URL: 'https://app.example.com' }, source: 'env:NEXT_PUBLIC_APP_URL', url: 'https://app.example.com', bypass: false },
    { name: 'local', env: { ...BASE, NEXT_PUBLIC_APP_URL: 'http://localhost:3000' }, source: 'env:NEXT_PUBLIC_APP_URL', url: 'http://localhost:3000', bypass: false },
  ]
  for (const c of cases) {
    const p = healthy(c.env)
    const r = await run(c.env, p)
    t.check(`${c.name}: source ${c.source}`, r.worker.source === c.source && r.worker.baseUrl === c.url, JSON.stringify(r.worker))
    t.check(`${c.name}: probed the worker health endpoint once`, p.calls.length === 1 && p.calls[0].url === `${c.url}${WORKER_PATH}`, JSON.stringify(p.calls))
    t.check(`${c.name}: bypass header ${c.bypass ? 'sent' : 'not sent'}`, (p.calls[0]?.headers['x-vercel-protection-bypass'] === 's3cret') === c.bypass, JSON.stringify(p.calls[0]?.headers))
    t.check(`${c.name}: no blocking check`, r.people.ready && r.jobs.ready && r.ready, JSON.stringify(r.checks))
    if (c.name === 'NEXT_PUBLIC_APP_URL on production') t.check(`${c.name}: the address is a warning`, find(r, 'worker-address')?.severity === 'warn' && r.people.warnings.length > 0)
  }
  {
    const env: Env = { ...BASE, VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_URL: 'app-abc123def-team.vercel.app' }
    const p = healthy(env)
    const r = await run(env, p)
    t.check('preview without a bypass: CONFIGURATION error, not probed', !r.ready && find(r, 'worker-address')?.code === 'CONFIGURATION' && r.worker.probed === false && p.calls.length === 0 && r.worker.source === 'unresolved', JSON.stringify({ c: find(r, 'worker-address'), p: r.worker.probed }))
    t.check('preview: both kinds refused with the same reason and remedy', r.people.code === 'CONFIGURATION' && r.jobs.code === 'CONFIGURATION' && /Protection Bypass/.test(r.people.remedy ?? ''))
  }
}

async function configuration() {
  console.log('\nconfiguration')
  {
    const env = { ...VERCEL, CRON_SECRET: undefined }
    const r = await run(env, healthy(env))
    const c = find(r, 'cron')
    t.check('CRON_SECRET missing on Vercel → warning, still ready', c?.severity === 'warn' && c.code === null && r.ready && r.people.warnings.some((w) => /CRON_SECRET/.test(w)), JSON.stringify(c))
  }
  {
    const env = { ...BASE, NEXT_PUBLIC_APP_URL: 'http://localhost:3000' }
    const r = await run(env, healthy(env))
    t.check('CRON_SECRET missing off Vercel is not a warning', find(r, 'cron') === null)
  }
  {
    const env = { ...VERCEL, ANTHROPIC_API_KEY: undefined, APOLLO_API_KEY: undefined }
    const r = await run(env, healthy(env))
    t.check('no Anthropic key → CONFIGURATION error for both kinds', find(r, 'anthropic')?.severity === 'error' && r.people.code === 'CONFIGURATION' && r.jobs.code === 'CONFIGURATION')
    t.check('no Apollo key → a people-only warning', find(r, 'apollo')?.severity === 'warn' && find(r, 'apollo')?.affects.join() === 'people')
  }
  {
    const env = { ...VERCEL, SUPABASE_SERVICE_ROLE_KEY: undefined }
    let schemaAsked = false
    const r = await run(env, healthy(env), { schemaProbe: async () => ((schemaAsked = true), null) })
    t.check('no service key → error, and the schema is not probed', find(r, 'supabase-service')?.severity === 'error' && schemaAsked === false)
  }
  {
    const env = { ...VERCEL, SCOUT_INVOCATION_BUDGET_MS: '10000' }
    const r = await run(env, healthy(env))
    t.check('a budget override on Vercel is a warning', find(r, 'budget-override')?.severity === 'warn')
  }
}

async function schema() {
  console.log('\nschema probe')
  // 021's columns have a fallback home in params (run-store-db.ts), so a
  // missing 021 is a WARNING that names the file; 016/020 are blocking.
  const r = await run(VERCEL, healthy(VERCEL), { schemaProbe: async () => '021_scout_reliability.sql' })
  const c = find(r, 'schema-021')
  t.check('a probe naming 021 → a schema-021 warning, still ready', c?.severity === 'warn' && c.code === null && r.ready && find(r, 'schema') === null, JSON.stringify(r.checks))
  t.check('the 021 remedy names the file to paste', /supabase\/migrations\/021_scout_reliability\.sql/.test(c?.remedy ?? '') && /SQL editor/.test(c?.remedy ?? ''), c?.remedy ?? 'null')
  t.check('the 021 message says what is lost (params fallback, no atomic double-click guard)', /params/.test(c?.message ?? '') && /double click/.test(c?.message ?? ''), c?.message ?? 'null')
  t.check('both kinds carry the warning', r.people.warnings.some((w) => /021/.test(w)) && r.jobs.warnings.some((w) => /021/.test(w)))
  const r020 = await run(VERCEL, healthy(VERCEL), { schemaProbe: async () => '020_scout_queue_watchdog.sql' })
  const c020 = find(r020, 'schema')
  t.check('a probe naming 020 → SCHEMA_MIGRATION error, not ready', c020?.severity === 'error' && c020.code === 'SCHEMA_MIGRATION' && !r020.ready, JSON.stringify(c020))
  t.check('the 020 remedy names the file to paste', /supabase\/migrations\/020_scout_queue_watchdog\.sql/.test(c020?.remedy ?? '') && /SQL editor/.test(c020?.remedy ?? ''), c020?.remedy ?? 'null')
  t.check('both kinds carry the code and remedy', r020.people.code === 'SCHEMA_MIGRATION' && r020.jobs.code === 'SCHEMA_MIGRATION' && r020.jobs.remedy === c020?.remedy)
  const r016 = await run(VERCEL, healthy(VERCEL), { schemaProbe: async () => '016_scout_durability_and_company_intent.sql' })
  t.check('a probe naming 016 → SCHEMA_MIGRATION error naming 016', find(r016, 'schema')?.code === 'SCHEMA_MIGRATION' && /016_scout_durability/.test(find(r016, 'schema')?.remedy ?? ''))
  const boom = await run(VERCEL, healthy(VERCEL), { schemaProbe: async () => { throw new Error('connect ETIMEDOUT') } })
  t.check('a probe that throws → DATABASE error with the message', find(boom, 'schema')?.code === 'DATABASE' && /ETIMEDOUT/.test(find(boom, 'schema')?.message ?? ''))
}

async function probe() {
  console.log('\nworker probe')
  {
    const p = worker(() => new Response('Authentication Required', { status: 401 }))
    const r = await run(VERCEL, p)
    const c = find(r, 'worker-probe')
    t.check('401 → DISPATCH error', c?.severity === 'error' && c.code === 'DISPATCH' && !r.ready && r.people.code === 'DISPATCH', JSON.stringify(c))
    t.check('401 remedy: Protection Bypass for Automation', /Protection Bypass for Automation/.test(c?.remedy ?? '') && /Deployment Protection/.test(c?.remedy ?? ''), c?.remedy ?? 'null')
    t.check('401 message carries the status and the address', /HTTP 401/.test(c?.message ?? '') && /https:\/\/app\.vercel\.app/.test(c?.message ?? ''))
  }
  {
    const p = worker(() => new Response('<!DOCTYPE html><html><body>Checking your browser</body></html>', { status: 503, headers: { 'content-type': 'text/html' } }))
    const r = await run(VERCEL, p)
    const c = find(r, 'worker-probe')
    t.check('an HTML body → the challenge/login remedy', c?.code === 'DISPATCH' && /challenge or login page/i.test(c.remedy ?? '') && /Attack Challenge Mode/.test(c.remedy ?? ''), c?.remedy ?? 'null')
    t.check('an HTML body is named in the message', /HTML page/.test(c?.message ?? ''), c?.message ?? 'null')
  }
  {
    const p = worker(() => new Response('<html><body>ok</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }))
    const r = await run(VERCEL, p)
    const c = find(r, 'worker-probe')
    t.check('an HTML 200 that is not the worker → still an error with the challenge remedy', c?.code === 'DISPATCH' && /challenge or login page/i.test(c.remedy ?? ''), JSON.stringify(c))
  }
  {
    const p = worker(() => new Response('{"error":"not found"}', { status: 404 }))
    const r = await run({ ...VERCEL, SCOUT_WORKER_BASE_URL: 'https://old-app.vercel.app' }, p)
    const c = find(r, 'worker-probe')
    t.check('404 → the "without this worker route" remedy naming SCOUT_WORKER_BASE_URL', c?.code === 'DISPATCH' && /without this worker route/.test(c.remedy ?? '') && /SCOUT_WORKER_BASE_URL/.test(c.remedy ?? ''), c?.remedy ?? 'null')
  }
  {
    const p = worker(() => new Response(JSON.stringify({ ok: true, worker: 'scout', deployment: 'dpl_other', budget_ms: invocationBudgetMs(VERCEL) }), { status: 200 }))
    const env = { ...VERCEL, VERCEL_AUTOMATION_BYPASS_SECRET: 's3cret' }
    const r = await run(env, p)
    const c = find(r, 'worker-deployment')
    t.check('deployment mismatch on the VERCEL_URL+bypass source → error CONFIGURATION', c?.severity === 'error' && c.code === 'CONFIGURATION' && !r.ready && r.worker.deployment === 'dpl_other' && r.worker.ours === 'dpl_me', JSON.stringify(c))
    const r2 = await run(VERCEL, p)
    const c2 = find(r2, 'worker-deployment')
    t.check('deployment mismatch on the alias source → warning, still ready', c2?.severity === 'warn' && c2.code === null && r2.ready && /rollout/.test(c2.remedy ?? ''), JSON.stringify(c2))
  }
  {
    const p = worker(() => new Response(JSON.stringify({ ok: true, worker: 'scout', deployment: 'dpl_me', budget_ms: 60_000 }), { status: 200 }))
    const r = await run(VERCEL, p)
    t.check('a worker planning on a different budget → warning', find(r, 'worker-budget')?.severity === 'warn' && r.ready && r.worker.budgetMs === 60_000)
  }
  {
    const p = worker(() => {
      throw new TypeError('fetch failed: ENOTFOUND')
    })
    const r = await run({ ...BASE, NEXT_PUBLIC_APP_URL: 'http://localhost:3000' }, p)
    const c = find(r, 'worker-probe')
    t.check('a network failure off Vercel → DISPATCH error telling the founder to start the app', c?.code === 'DISPATCH' && /ENOTFOUND/.test(c.message) && /next dev/.test(c.remedy ?? ''), JSON.stringify(c))
  }
  {
    const p = healthy(VERCEL)
    const r = await run(VERCEL, p)
    t.check('a healthy probe → ready, no checks at all', r.ready && r.checks.length === 0 && r.worker.probed && r.worker.deployment === 'dpl_me' && r.cached === false, JSON.stringify(r.checks))
  }
}

async function cache() {
  console.log('\ncache')
  resetReadinessCache()
  const T = 1_800_000_000_000
  let now = T
  const p = healthy(VERCEL)
  const a = await checkScoutReadiness({ env: VERCEL, probe: true, schemaProbe: async () => null, fetchImpl: p.fetchImpl, now: () => now })
  now = T + 10_000
  const b = await checkScoutReadiness({ env: VERCEL, probe: true, schemaProbe: async () => null, fetchImpl: p.fetchImpl, now: () => now })
  t.check('within the TTL the verdict is served from cache', a.cached === false && b.cached === true && b.checkedAt === a.checkedAt && p.calls.length === 1, JSON.stringify({ a: a.cached, b: b.cached, calls: p.calls.length }))
  const c = await checkScoutReadiness({ env: VERCEL, probe: true, schemaProbe: async () => null, fetchImpl: p.fetchImpl, now: () => now, fresh: true })
  t.check('fresh:true bypasses it and probes again', c.cached === false && p.calls.length === 2)
  now = T + 10_000 + 46_000
  const d = await checkScoutReadiness({ env: VERCEL, probe: true, schemaProbe: async () => null, fetchImpl: p.fetchImpl, now: () => now })
  t.check('past the TTL it probes again', d.cached === false && p.calls.length === 3)
  const e = await checkScoutReadiness({ env: { ...VERCEL, SCOUT_WORKER_BASE_URL: 'https://app.vercel.app' }, probe: true, schemaProbe: async () => null, fetchImpl: p.fetchImpl, now: () => now })
  t.check('a different env is a different cache key', e.cached === false && p.calls.length === 4)
  resetReadinessCache()
  const f = await checkScoutReadiness({ env: VERCEL, probe: true, schemaProbe: async () => null, fetchImpl: p.fetchImpl, now: () => now })
  t.check('resetReadinessCache clears it', f.cached === false && p.calls.length === 5)
}

async function main() {
  await sources()
  await configuration()
  await schema()
  await probe()
  await cache()
  t.finish('readiness')
}

main().catch((e) => {
  console.error('readiness suite crashed', e)
  process.exitCode = 1
})
