// Can scouting actually run here? Answered BEFORE anyone pays.
//
// One validator for both scout kinds, consulted by the readiness endpoint
// (the pages show its verdict), by both enqueue routes (a run is refused
// before a row is written), and by the build gate for the static half. It
// checks what a run needs, in the order a run would find out:
//
//   configuration   Supabase, Anthropic, Apollo (degradable), the cron secret
//   schema          the columns migrations 016/020/021 added — by asking
//   worker address  can this deployment name an address it may call?
//   worker probe    a real GET to that address, with the headers the dispatch
//                   would send: is the worker there, and is it THIS deployment?
//
// A mismatch between the deployment that answers and the one asking is a hard
// error only for the VERCEL_URL+bypass source, which must be the same
// deployment by construction; for the production alias it is a warning
// (rollouts legitimately answer from the newer deployment for a minute).
//
// The verdict is cached per instance for a short time: a cold self-GET on
// every click would add seconds and a second cold start.

import { createServiceClient } from '@/lib/supabase/server'
import { isMissingSchema } from '@/lib/career/jobs/db'
import { resolveWorkerBase, WORKER_PATH, type WorkerBase } from '@/lib/career/scout/worker-target'
import { checkWorkerBase } from '@/lib/career/scout/worker-env'
import { invocationBudgetMs } from './deadline'
import type { ScoutErrorCode } from './errors'

export type ReadinessSeverity = 'ok' | 'warn' | 'error'

export interface ReadinessCheck {
  id: string
  severity: ReadinessSeverity
  message: string
  remedy: string | null
  /** The error code a refused run would carry. */
  code: ScoutErrorCode | null
  /** Which scout kinds this check gates. */
  affects: ('people' | 'jobs')[]
}

export interface KindReadiness {
  ready: boolean
  /** The first blocking reason, as a sentence. */
  reason: string | null
  remedy: string | null
  code: ScoutErrorCode | null
  warnings: string[]
}

export interface ScoutReadiness {
  ready: boolean
  people: KindReadiness
  jobs: KindReadiness
  checks: ReadinessCheck[]
  worker: { source: string; baseUrl: string; probed: boolean; deployment: string | null; ours: string | null; budgetMs: number | null }
  env: { onVercel: boolean; vercelEnv: string | null }
  checkedAt: string
  cached: boolean
}

export interface ReadinessOptions {
  env?: Record<string, string | undefined>
  /** Probe the worker over HTTP. Default true. */
  probe?: boolean
  /** Ask the database about the schema. Default true. */
  schema?: boolean
  fetchImpl?: typeof fetch
  /** A schema probe for tests: returns null when every column exists, else the missing migration's name. */
  schemaProbe?: () => Promise<string | null>
  /** Skip the cache. */
  fresh?: boolean
  now?: () => number
}

const CACHE_TTL_MS = 45_000
let cache: { at: number; key: string; value: ScoutReadiness } | null = null

function check(id: string, severity: ReadinessSeverity, message: string, remedy: string | null, code: ScoutErrorCode | null, affects: ('people' | 'jobs')[]): ReadinessCheck {
  return { id, severity, message, remedy, code, affects }
}

/**
 * Which migration is missing, judged by the columns a run writes. Each probe
 * is one cheap select; the first failure names the file to paste.
 */
export async function probeSchema(): Promise<string | null> {
  const db = createServiceClient()
  const probes: [string, string, string][] = [
    ['016_scout_durability_and_company_intent.sql', 'scouting_runs', 'stage, progress, heartbeat_at, params, worker_started_at, claim_token'],
    ['020_scout_queue_watchdog.sql', 'scouting_runs', 'queued_at, attempt_count, last_dispatch_at, worker_id, lease_expires_at, cancel_requested, last_error'],
    ['021_scout_reliability.sql', 'scouting_runs', 'error_code, error_detail, invocation_count, run_deadline_at, checkpoint, result'],
  ]
  for (const [migration, table, cols] of probes) {
    const { error } = await db.from(table).select(cols).limit(1)
    if (error) {
      if (isMissingSchema(error.message)) return migration
      throw new Error(error.message)
    }
  }
  return null
}

async function probeWorker(target: WorkerBase, fetchImpl: typeof fetch, timeoutMs = 6_000): Promise<{ ok: boolean; status: number | null; deployment: string | null; budgetMs: number | null; error: string | null; html: boolean }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    const res = await fetchImpl(`${target.baseUrl}${WORKER_PATH}`, { method: 'GET', headers: { accept: 'application/json', ...target.headers }, cache: 'no-store', signal: controller.signal })
    const text = await res.text()
    const html = /^\s*<(!doctype|html)/i.test(text)
    let body: { ok?: boolean; worker?: string; deployment?: string | null; budget_ms?: number } | null = null
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
    if (!res.ok) return { ok: false, status: res.status, deployment: null, budgetMs: null, error: html ? `HTTP ${res.status} with an HTML page (a login or challenge page, not the worker)` : `HTTP ${res.status}`, html }
    if (!body || body.ok !== true || body.worker !== 'scout') return { ok: false, status: res.status, deployment: null, budgetMs: null, error: html ? 'an HTML page answered instead of the worker' : 'something other than the worker answered', html }
    return { ok: true, status: res.status, deployment: body.deployment ?? null, budgetMs: typeof body.budget_ms === 'number' ? body.budget_ms : null, error: null, html: false }
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError'
    return { ok: false, status: null, deployment: null, budgetMs: null, error: aborted ? `no answer within ${Math.round(timeoutMs / 1000)}s` : e instanceof Error ? e.message : String(e), html: false }
  } finally {
    clearTimeout(timer)
  }
}

export async function checkScoutReadiness(opts: ReadinessOptions = {}): Promise<ScoutReadiness> {
  const env = opts.env ?? process.env
  const now = opts.now ?? (() => Date.now())
  const cacheKey = `${env.VERCEL ?? ''}|${env.VERCEL_ENV ?? ''}|${env.SCOUT_WORKER_BASE_URL ?? ''}|${opts.probe !== false}|${opts.schema !== false}`
  if (!opts.fresh && cache && cache.key === cacheKey && now() - cache.at < CACHE_TTL_MS) return { ...cache.value, cached: true }

  const checks: ReadinessCheck[] = []
  const onVercel = Boolean(env.VERCEL)

  // ─── Configuration ─────────────────────────────────────────────────────────
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    checks.push(check('supabase', 'error', 'Supabase is not configured (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY).', 'Set both in the environment.', 'CONFIGURATION', ['people', 'jobs']))
  }
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    checks.push(check('supabase-service', 'error', 'SUPABASE_SERVICE_ROLE_KEY is not set; the worker cannot write run state.', 'Set SUPABASE_SERVICE_ROLE_KEY (server-side only, never NEXT_PUBLIC_).', 'CONFIGURATION', ['people', 'jobs']))
  }
  if (!env.ANTHROPIC_API_KEY) {
    checks.push(check('anthropic', 'error', 'ANTHROPIC_API_KEY is not set; no agent can run.', 'Set ANTHROPIC_API_KEY.', 'CONFIGURATION', ['people', 'jobs']))
  }
  if (!env.APOLLO_API_KEY) {
    checks.push(check('apollo', 'warn', 'APOLLO_API_KEY is not set: People Scout can search your existing network but cannot discover new people.', 'Set APOLLO_API_KEY to enable external discovery, or use “Existing network only”.', null, ['people']))
  }
  if (onVercel && !env.CRON_SECRET) {
    checks.push(check('cron', 'warn', 'CRON_SECRET is not set, so the daily watchdog crons answer 503: a run nobody looks at is only closed when its owner next opens a scout page.', 'Set CRON_SECRET in the Vercel project (all environments) so the scheduled sweep can run.', null, ['people', 'jobs']))
  }
  if (env.SCOUT_INVOCATION_BUDGET_MS && onVercel) {
    checks.push(check('budget-override', 'warn', `SCOUT_INVOCATION_BUDGET_MS overrides the platform budget (${env.SCOUT_INVOCATION_BUDGET_MS} ms) on Vercel.`, 'Remove the override on Vercel unless you are testing.', null, ['people', 'jobs']))
  }

  // ─── Schema ────────────────────────────────────────────────────────────────
  if (opts.schema !== false && env.NEXT_PUBLIC_SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const missing = await (opts.schemaProbe ?? probeSchema)()
      if (missing && missing.startsWith('021')) {
        // 021's columns have a fallback home in `params` (run-store-db.ts), so a
        // run still records everything. What a pre-021 database cannot give is
        // the INDEX that makes "one active run per kind" atomic.
        checks.push(
          check(
            'schema-021',
            'warn',
            `supabase/migrations/${missing} is not applied: run state is kept inside the row's params instead of its own columns, and a double click is guarded by a read-then-insert rather than by the database.`,
            `Paste supabase/migrations/${missing} into the Supabase SQL editor and run it (idempotent).`,
            null,
            ['people', 'jobs']
          )
        )
      } else if (missing) {
        checks.push(check('schema', 'error', `The database is missing the columns that supabase/migrations/${missing} adds; a durable run cannot be recorded.`, `Paste supabase/migrations/${missing} into the Supabase SQL editor and run it (idempotent), then try again.`, 'SCHEMA_MIGRATION', ['people', 'jobs']))
      }
    } catch (e) {
      checks.push(check('schema', 'error', `The database could not be reached: ${e instanceof Error ? e.message : String(e)}`, 'Check the Supabase project and the keys.', 'DATABASE', ['people', 'jobs']))
    }
  }

  // ─── The worker's address ──────────────────────────────────────────────────
  const target = resolveWorkerBase(null, env)
  const health = checkWorkerBase(env, target)
  if (health.severity === 'error') {
    checks.push(check('worker-address', 'error', health.message, health.remedy, 'CONFIGURATION', ['people', 'jobs']))
  } else if (health.severity === 'warn') {
    checks.push(check('worker-address', 'warn', health.message, health.remedy, null, ['people', 'jobs']))
  }

  // ─── The worker itself ─────────────────────────────────────────────────────
  let probed = false
  let deployment: string | null = null
  let budgetMs: number | null = null
  if (opts.probe !== false && target.baseUrl && !target.problem) {
    probed = true
    const p = await probeWorker(target, opts.fetchImpl ?? fetch)
    deployment = p.deployment
    budgetMs = p.budgetMs
    if (!p.ok) {
      const remedy =
        p.status === 401 || p.status === 403
          ? 'Deployment Protection is answering the app’s own request. Enable “Protection Bypass for Automation” in the Vercel project (Settings → Deployment Protection) — if it is already on and the secret was rotated, redeploy — or set SCOUT_WORKER_BASE_URL to the production domain.'
          : p.html
            ? 'A challenge or login page sits between the app and its worker (Vercel Firewall / Attack Challenge Mode, or password protection). Exempt /api/scout/worker or disable it for this project.'
            : p.status === 404
              ? 'The address points at a deployment without this worker route. Set SCOUT_WORKER_BASE_URL to THIS app’s domain, or remove it so the deployment dispatches to itself.'
              : onVercel
                ? 'Check SCOUT_WORKER_BASE_URL, or remove it and enable Protection Bypass for Automation so the deployment dispatches to itself.'
                : `Start the app at ${target.baseUrl} (next dev / next start), or set SCOUT_WORKER_BASE_URL to where it runs.`
      checks.push(check('worker-probe', 'error', `The scouting worker at ${target.baseUrl} did not answer: ${p.error}.`, remedy, 'DISPATCH', ['people', 'jobs']))
    } else {
      const ours = env.VERCEL_DEPLOYMENT_ID ?? null
      if (ours && p.deployment && ours !== p.deployment) {
        const sameByConstruction = target.source === 'env:VERCEL_URL+bypass'
        checks.push(
          check(
            'worker-deployment',
            sameByConstruction ? 'error' : 'warn',
            `The worker that answered belongs to deployment ${p.deployment}, not this one (${ours}).`,
            sameByConstruction ? 'The bypass address should reach this very deployment; check SCOUT_WORKER_BASE_URL is not overriding it.' : 'Expected briefly during a rollout. If it persists, SCOUT_WORKER_BASE_URL points at a different deployment than the one serving the app.',
            sameByConstruction ? 'CONFIGURATION' : null,
            ['people', 'jobs']
          )
        )
      }
      if (p.budgetMs !== null && p.budgetMs !== invocationBudgetMs(env)) {
        checks.push(check('worker-budget', 'warn', `The worker plans on ${Math.round(p.budgetMs / 1000)}s per pass; this app expects ${Math.round(invocationBudgetMs(env) / 1000)}s.`, 'The two deployments differ; expect this only during a rollout.', null, ['people', 'jobs']))
      }
    }
  }

  const verdict = (kind: 'people' | 'jobs'): KindReadiness => {
    const mine = checks.filter((c) => c.affects.includes(kind))
    const blocking = mine.find((c) => c.severity === 'error')
    return {
      ready: !blocking,
      reason: blocking?.message ?? null,
      remedy: blocking?.remedy ?? null,
      code: blocking?.code ?? null,
      warnings: mine.filter((c) => c.severity === 'warn').map((c) => c.message),
    }
  }
  const people = verdict('people')
  const jobs = verdict('jobs')
  const value: ScoutReadiness = {
    ready: people.ready && jobs.ready,
    people,
    jobs,
    checks,
    worker: { source: target.source, baseUrl: target.baseUrl, probed, deployment, ours: env.VERCEL_DEPLOYMENT_ID ?? null, budgetMs },
    env: { onVercel, vercelEnv: env.VERCEL_ENV ?? null },
    checkedAt: new Date(now()).toISOString(),
    cached: false,
  }
  cache = { at: now(), key: cacheKey, value }
  return value
}

/** Test seam. */
export function resetReadinessCache(): void {
  cache = null
}
