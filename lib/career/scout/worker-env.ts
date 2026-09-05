// Is the address we dispatch the worker to believable?
//
// The scouting worker is an HTTP route in this same deployment, reached by the
// app POSTing to itself. That makes the base URL load-bearing, and it was the
// one thing nobody checked: a run sat queued for 328 minutes because the
// self-POST never landed, and the dispatch reported success anyway.
//
// This is the STATIC judgement — what the configuration says — shared by the
// build gate (scripts/check-deploy-config.ts), the readiness endpoint and the
// enqueue routes, so all three reach the same verdict from the same rules. The
// DYNAMIC judgement (does the address actually answer, and is it this
// deployment?) is lib/runs/readiness.ts, which sends a real request.

import { LOOPBACK_URL, resolveWorkerBase, type WorkerBase } from './worker-target'

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

/**
 * Judge the configured worker base. Pure, so the deploy check, the runtime
 * warning and the tests all reach the same verdict from the same rules.
 *
 * The severities mean different things and are not interchangeable:
 *   error — this WILL fail; refuse to call it healthy and refuse to start a run
 *   warn  — it may work, but it is guessing and should be pinned
 *   ok    — explicitly configured, the same deployment with a bypass, the
 *           production alias, or a local address on a local machine
 */
export function checkWorkerBase(
  env: Record<string, string | undefined> = process.env,
  resolved: WorkerBase = resolveWorkerBase(null, env)
): WorkerBaseHealth {
  const onVercel = Boolean(env.VERCEL)
  const { baseUrl, source } = resolved

  if (resolved.problem) {
    return { severity: 'error', source, baseUrl, onVercel, message: resolved.problem.message, remedy: resolved.problem.remedy }
  }

  if (source === 'env:SCOUT_WORKER_BASE_URL') {
    if (onVercel && DEPLOYMENT_HOST.test(baseUrl) && !env.VERCEL_AUTOMATION_BYPASS_SECRET) {
      return {
        severity: 'warn',
        source,
        baseUrl,
        onVercel,
        message: `SCOUT_WORKER_BASE_URL is a per-deployment URL (${baseUrl}). Those are covered by Deployment Protection, which answers the app's own POST with 401 unless a bypass secret is configured.`,
        remedy: 'Use the stable production domain instead of the deployment hash URL, or enable Protection Bypass for Automation.',
      }
    }
    return { severity: 'ok', source, baseUrl, onVercel, message: `worker base pinned to ${baseUrl}`, remedy: null }
  }

  if (source === 'env:VERCEL_URL+bypass') {
    return { severity: 'ok', source, baseUrl, onVercel, message: `worker base is this deployment (${baseUrl}) with the automation bypass header`, remedy: null }
  }

  if (source === 'env:VERCEL_PROJECT_PRODUCTION_URL') {
    return { severity: 'ok', source, baseUrl, onVercel, message: `worker base is the production alias (${baseUrl})`, remedy: null }
  }

  if (onVercel) {
    // NEXT_PUBLIC_APP_URL on production: probably right, but a guess.
    return {
      severity: 'warn',
      source,
      baseUrl,
      onVercel,
      message: `worker base was inferred from NEXT_PUBLIC_APP_URL (${baseUrl}) rather than configured for scouting.`,
      remedy: 'Set SCOUT_WORKER_BASE_URL to the production domain, or enable Protection Bypass for Automation, to remove the guess.',
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
