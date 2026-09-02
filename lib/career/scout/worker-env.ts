// Is the address we dispatch the worker to actually reachable?
//
// The scouting worker is an HTTP route in this same deployment, reached by the
// app POSTing to itself. That makes the base URL load-bearing, and it was the
// one thing nobody checked: a run sat queued for 328 minutes because the
// self-POST never landed, and the dispatch reported success anyway.
//
// The dangerous case is Vercel. `resolveWorkerBase` falls back to `VERCEL_URL`,
// which is the PER-DEPLOYMENT hostname — precisely the one Deployment
// Protection guards. A protected deployment answers its own POST with 401, and
// before this pass that was recorded as a successful dispatch.
//
// So: never silently treat an unverified base as healthy. Say what is wrong,
// name the variable that fixes it, and let the watchdog remain the backstop.

export type WorkerBaseSeverity = 'ok' | 'warn' | 'error'

export interface WorkerBaseHealth {
  severity: WorkerBaseSeverity
  /** Where the base URL came from — the same vocabulary `resolveWorkerBase` uses. */
  source: string
  baseUrl: string
  onVercel: boolean
  message: string
  /** What to set, in words the founder can act on. */
  remedy: string | null
}

/** A Vercel per-deployment hostname: `<project>-<hash>-<scope>.vercel.app`. */
const DEPLOYMENT_HOST = /^https:\/\/[a-z0-9-]+-[a-z0-9]{6,}-[a-z0-9-]+\.vercel\.app$/i
const LOOPBACK_URL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i

/**
 * Judge the configured worker base. Pure, so the deploy check, the runtime
 * warning and the tests all reach the same verdict from the same rules.
 *
 * The severities mean different things and are not interchangeable:
 *   error — this WILL fail in production; refuse to call it healthy
 *   warn  — it may work, but it is guessing and should be pinned
 *   ok    — explicitly configured, or a local address on a local machine
 */
export function checkWorkerBase(
  env: Record<string, string | undefined> = process.env,
  resolved?: { baseUrl: string; source: string }
): WorkerBaseHealth {
  const onVercel = Boolean(env.VERCEL)
  const explicit = (env.SCOUT_WORKER_BASE_URL ?? '').trim()
  const baseUrl = resolved?.baseUrl ?? ''
  const source = resolved?.source ?? (explicit ? 'env:SCOUT_WORKER_BASE_URL' : 'unresolved')

  if (explicit) {
    // Explicitly set, but still wrong if it points at localhost from a
    // deployment — a serverless function cannot reach the founder's laptop.
    if (onVercel && LOOPBACK_URL.test(explicit)) {
      return {
        severity: 'error',
        source,
        baseUrl: explicit,
        onVercel,
        message: `SCOUT_WORKER_BASE_URL is ${explicit}, which is this function's own loopback address, not your site. Scouting cannot start.`,
        remedy: 'Set SCOUT_WORKER_BASE_URL to your production URL, e.g. https://your-app.vercel.app',
      }
    }
    if (onVercel && DEPLOYMENT_HOST.test(explicit)) {
      return {
        severity: 'warn',
        source,
        baseUrl: explicit,
        onVercel,
        message: `SCOUT_WORKER_BASE_URL is a per-deployment URL (${explicit}). Those are covered by Deployment Protection, which answers the app's own POST with 401.`,
        remedy: 'Use the stable production domain instead of the deployment hash URL.',
      }
    }
    return { severity: 'ok', source, baseUrl: explicit, onVercel, message: `worker base pinned to ${explicit}`, remedy: null }
  }

  if (onVercel) {
    // The incident configuration: nothing pinned, so VERCEL_URL wins and the
    // app POSTs to the protected per-deployment hostname.
    return {
      severity: 'error',
      source,
      baseUrl,
      onVercel,
      message:
        'SCOUT_WORKER_BASE_URL is not set. On Vercel the worker address falls back to VERCEL_URL — the per-deployment hostname, which Deployment Protection answers with 401. Scouting will queue and then fail rather than run.',
      remedy: 'Set SCOUT_WORKER_BASE_URL to your stable production URL in the Vercel project environment variables.',
    }
  }

  if (LOOPBACK_URL.test(baseUrl) || baseUrl === '') {
    return {
      severity: 'ok',
      source,
      baseUrl,
      onVercel,
      message: `worker base is local (${baseUrl || 'http://localhost:3000'}); fine for development`,
      remedy: null,
    }
  }

  return {
    severity: 'warn',
    source,
    baseUrl,
    onVercel,
    message: `worker base was inferred (${source}) rather than configured: ${baseUrl}`,
    remedy: 'Set SCOUT_WORKER_BASE_URL to remove the guess.',
  }
}

/**
 * One line for the log, at the severity the verdict deserves.
 *
 * Deliberately loud on `error`: the failure it describes is invisible at the
 * moment it happens — the run simply sits queued — so the log is the only place
 * anyone will ever see it before the watchdog gives up sixty seconds later.
 */
export function logWorkerBaseHealth(h: WorkerBaseHealth): void {
  const line = `[scout] event=worker_base severity=${h.severity} source=${h.source} url=${h.baseUrl || '(none)'} vercel=${h.onVercel} :: ${h.message}${h.remedy ? ` FIX: ${h.remedy}` : ''}`
  if (h.severity === 'error') console.error(line)
  else if (h.severity === 'warn') console.warn(line)
  else console.log(line)
}
