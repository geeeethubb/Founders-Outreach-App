// Is this deployment's configuration one that can work? Judged offline.
//
// Every scouting incident so far was a configuration that deployed cleanly
// and then failed at the first request: the app POSTing to its own protected
// hostname, a Vercel build with the system variables hidden so every branch
// of the code believed it was local, a cron answering 503 because its secret
// was never set. None of that needs a database or a network call to see. So
// this module reads an environment and says, before `next build` runs, whether
// the deployment it describes can start a run — and `npm run build` refuses to
// continue on an `error`.
//
// Three consumers share it so they cannot disagree:
//
//   scripts/check-deploy-config.ts   the build gate (fails the deploy)
//   scripts/check-worker-env.ts      the same judgement, by hand
//   scripts/test-deploy-config.ts    the rules, each exercised offline
//
// The rules are deliberately stricter ON Vercel than off it. On a laptop a
// missing key means "you cannot run that part"; on Vercel it means "you just
// shipped a site whose Scout button cannot work". Off Vercel this never errors.
//
// It never prints a secret. Every message is about presence, absence or
// equality — never a value.

import { checkWorkerBase } from '@/lib/career/scout/worker-env'
import { LOOPBACK_URL, resolveWorkerBase } from '@/lib/career/scout/worker-target'

export type DeploySeverity = 'ok' | 'warn' | 'error'

export interface DeployCheck {
  id: string
  severity: DeploySeverity
  /** Names the variable and what is wrong with it. */
  message: string
  /** What to set, in words the founder can act on. Null when nothing is wrong. */
  remedy: string | null
}

export interface DeployVerdict {
  severity: DeploySeverity
  checks: DeployCheck[]
  /** What the judgement believed about where it was running. */
  environment: { onVercel: boolean; vercelEnv: string | null }
}

type Env = Record<string, string | undefined>

/** The variables scouting cannot run without. */
export const REQUIRED_VARIABLES: ReadonlyArray<{ name: string; why: string }> = [
  { name: 'NEXT_PUBLIC_SUPABASE_URL', why: 'nothing can reach the database' },
  { name: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', why: 'no page can sign a user in' },
  { name: 'SUPABASE_SERVICE_ROLE_KEY', why: 'the worker cannot write run state' },
  { name: 'ANTHROPIC_API_KEY', why: 'no agent can run' },
]

/**
 * Server-only secrets. If any NEXT_PUBLIC_* variable carries one of these
 * VALUES, `next build` compiles the secret into the browser bundle.
 */
export const SERVER_SECRETS: ReadonlyArray<string> = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'ANTHROPIC_API_KEY',
  'APOLLO_API_KEY',
  'OPENAI_API_KEY',
  'CRON_SECRET',
  'VERCEL_AUTOMATION_BYPASS_SECRET',
  'GOOGLE_CLIENT_SECRET',
  'EMAIL_TOKEN_ENCRYPTION_KEY',
]

const RANK: Record<DeploySeverity, number> = { ok: 0, warn: 1, error: 2 }

function present(env: Env, name: string): boolean {
  return (env[name] ?? '').trim().length > 0
}

function worst(checks: DeployCheck[]): DeploySeverity {
  return checks.reduce<DeploySeverity>((acc, c) => (RANK[c.severity] > RANK[acc] ? c.severity : acc), 'ok')
}

/**
 * Judge an environment. Pure: no I/O, no process.env unless handed it, and the
 * same input always yields the same checks in the same order.
 */
export function judgeDeployConfig(env: Env): DeployVerdict {
  const onVercel = Boolean(env.VERCEL)
  const vercelEnv = (env.VERCEL_ENV ?? '').trim() || null
  const production = onVercel && vercelEnv === 'production'
  const checks: DeployCheck[] = []
  const add = (id: string, severity: DeploySeverity, message: string, remedy: string | null = null) => checks.push({ id, severity, message, remedy })

  // ─── Where are we? ─────────────────────────────────────────────────────────
  if (onVercel && !vercelEnv) {
    add(
      'vercel-env',
      'error',
      'VERCEL is set but VERCEL_ENV is not: the system environment variables are hidden from this build, so every Vercel branch of the code (worker address, invocation budget, deployment id) thinks it is running locally and would dispatch scouting to localhost.',
      'Turn on "Automatically expose System Environment Variables" in the Vercel project (Settings → Environment Variables) and redeploy.'
    )
  } else if (onVercel) {
    add('vercel-env', 'ok', `Vercel ${vercelEnv} deployment; system environment variables are exposed.`)
  } else {
    add('vercel-env', 'ok', 'Not on Vercel: local rules apply (missing keys warn, nothing errors).')
  }

  // ─── Keys the runtime cannot do without ────────────────────────────────────
  for (const { name, why } of REQUIRED_VARIABLES) {
    if (present(env, name)) {
      add(`env:${name}`, 'ok', `${name} is set.`)
    } else {
      add(
        `env:${name}`,
        onVercel ? 'error' : 'warn',
        `${name} is not set: ${why}.`,
        onVercel
          ? `Add ${name} to the Vercel project for this environment (Settings → Environment Variables) and redeploy.`
          : `Add ${name} to .env.local (see .env.local.example).`
      )
    }
  }

  if (present(env, 'APOLLO_API_KEY')) {
    add('env:APOLLO_API_KEY', 'ok', 'APOLLO_API_KEY is set.')
  } else {
    add(
      'env:APOLLO_API_KEY',
      'warn',
      'APOLLO_API_KEY is not set: People Scout can search the existing network but cannot discover new people.',
      onVercel ? 'Add APOLLO_API_KEY to the Vercel project, or accept "Existing network only" scouting.' : 'Add APOLLO_API_KEY to .env.local, or use "Existing network only".'
    )
  }

  // ─── The cron secret ───────────────────────────────────────────────────────
  if (onVercel) {
    if (present(env, 'CRON_SECRET')) {
      add('cron-secret', 'ok', 'CRON_SECRET is set; the daily watchdog crons in vercel.json can authenticate.')
    } else {
      add(
        'cron-secret',
        production ? 'error' : 'warn',
        production
          ? 'CRON_SECRET is not set in production: the daily crons in vercel.json (/api/career/cron/sweep, /api/career/cron/verify) answer 503, so a run nobody is watching is only ever closed when its owner next opens a scout page.'
          : `CRON_SECRET is not set on this ${vercelEnv ?? 'non-production'} deployment; the crons only fire in production, so this matters only if it is also missing there.`,
        'Add CRON_SECRET to the Vercel project (all environments) — any long random string — and redeploy.'
      )
    }
  }

  // ─── A server secret in a public variable ──────────────────────────────────
  // Compared by value, reported by name. Never the value.
  const secretValues = SERVER_SECRETS.map((name) => ({ name, value: (env[name] ?? '').trim() })).filter((s) => s.value.length > 0)
  let leaked = 0
  for (const key of Object.keys(env).sort()) {
    if (!key.startsWith('NEXT_PUBLIC_')) continue
    const value = (env[key] ?? '').trim()
    if (!value) continue
    for (const secret of secretValues) {
      if (secret.name === key) continue
      if (secret.value !== value) continue
      leaked++
      add(
        `public-leak:${key}`,
        'error',
        `${key} has the same value as ${secret.name}. Everything named NEXT_PUBLIC_* is compiled into the browser bundle, so this build would publish a server secret.`,
        `Give ${key} its own (public) value, or remove it, then rotate ${secret.name}: assume it is already exposed.`
      )
    }
  }
  if (leaked === 0) add('public-leak', 'ok', 'No NEXT_PUBLIC_* variable carries the value of a server secret.')

  // ─── The worker's address ──────────────────────────────────────────────────
  const explicit = (env.SCOUT_WORKER_BASE_URL ?? '').trim().replace(/\/+$/, '')
  if (onVercel && explicit && LOOPBACK_URL.test(explicit)) {
    add(
      'worker-loopback',
      'error',
      'SCOUT_WORKER_BASE_URL points at a loopback address (localhost / 127.0.0.1 / [::1]). On Vercel that is the function\'s own container, not your site: every dispatch would fail and every run would sit queued.',
      'Set SCOUT_WORKER_BASE_URL to the site\'s https URL (the stable production domain), or remove it and enable "Protection Bypass for Automation" so the deployment dispatches to itself.'
    )
  }

  const resolved = resolveWorkerBase(null, env)
  const health = checkWorkerBase(env, resolved)
  if (resolved.problem) {
    // A preview may not see VERCEL_AUTOMATION_BYPASS_SECRET at build time
    // (it can be runtime-only), so the static check cannot prove a preview is
    // broken. The readiness gate at runtime enforces it for real.
    const severity: DeploySeverity = production ? 'error' : 'warn'
    add(
      'worker-address',
      severity,
      production ? resolved.problem.message : `${resolved.problem.message} (Not fatal for a ${vercelEnv ?? 'non-production'} deployment at build time: the bypass secret may only be visible at runtime, where the readiness gate checks it.)`,
      resolved.problem.remedy
    )
  } else {
    add('worker-address', health.severity, `${health.message} [source ${health.source}]`, health.remedy)
  }

  // ─── Overrides that should not follow the code to Vercel ───────────────────
  if (onVercel && present(env, 'SCOUT_INVOCATION_BUDGET_MS')) {
    add(
      'budget-override',
      'warn',
      'SCOUT_INVOCATION_BUDGET_MS is set on Vercel. It overrides the platform invocation budget (280 s under a 300 s function ceiling); a value past the ceiling makes the platform kill the worker mid-leg.',
      'Remove SCOUT_INVOCATION_BUDGET_MS from the Vercel project unless you are deliberately testing a shorter budget.'
    )
  }

  return { severity: worst(checks), checks, environment: { onVercel, vercelEnv } }
}

/** One line per check, for a terminal. */
export function formatDeployCheck(c: DeployCheck): string {
  const icon = c.severity === 'ok' ? 'ok  ' : c.severity === 'warn' ? 'WARN' : 'FAIL'
  return `${icon} ${c.id.padEnd(34)} ${c.message}${c.remedy ? `\n     FIX: ${c.remedy}` : ''}`
}
