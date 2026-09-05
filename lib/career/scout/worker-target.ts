// Where the worker is, and how to reach it.
//
// The scouting worker is an HTTP route in this same deployment, reached by the
// app POSTing to itself. Two things make that address load-bearing:
//
//   1. The dispatch carries the run's single-use claim token — a capability.
//      So the target must be chosen by the SERVER, never derived from a request
//      header anyone can forge (a blind SSRF that also leaks the token).
//
//   2. On Vercel, the obvious address is the wrong one. `VERCEL_URL` is the
//      PER-DEPLOYMENT hostname, and Deployment Protection answers a request to
//      it with 401 unless the request carries the project's automation bypass
//      secret. A run once sat queued for 328 minutes that way.
//
// The resolution rules, in order:
//
//   SCOUT_WORKER_BASE_URL              explicit, wins everywhere
//   VERCEL_URL + bypass header         when VERCEL_AUTOMATION_BYPASS_SECRET is set:
//                                      the SAME deployment, preview or production,
//                                      with `x-vercel-protection-bypass` so
//                                      Deployment Protection lets it through
//   VERCEL_PROJECT_PRODUCTION_URL      production only: the stable alias, which
//                                      Standard Protection does not guard
//   NEXT_PUBLIC_APP_URL                production only, https, not loopback
//   (unresolved)                       a PREVIEW with no bypass and nothing
//                                      pinned: refused, with the remedy — never
//                                      routed to production, whose code and
//                                      database may differ
//
// Off Vercel: the explicit URL, then NEXT_PUBLIC_APP_URL, then a loopback host
// header (what makes `next dev` work with no configuration), then localhost.
//
// Whether the chosen address actually answers is a separate question, and it
// is asked for real by lib/runs/readiness.ts (a GET to the worker's health
// endpoint with these same headers, checking the deployment id that answers).

export type WorkerBaseSource =
  | 'env:SCOUT_WORKER_BASE_URL'
  | 'env:VERCEL_URL+bypass'
  | 'env:VERCEL_PROJECT_PRODUCTION_URL'
  | 'env:NEXT_PUBLIC_APP_URL'
  | 'header:loopback'
  | 'default'
  | 'unresolved'

export interface WorkerBase {
  /** Empty when unresolved. */
  baseUrl: string
  source: WorkerBaseSource
  /** True when a host header was present and deliberately NOT used. */
  ignoredHeaderHost: string | null
  /** Headers every request to the worker must carry (the protection bypass, when configured). */
  headers: Record<string, string>
  /** Set when no usable address exists for this environment. */
  problem: { message: string; remedy: string } | null
  vercel: { onVercel: boolean; env: string | null; deploymentId: string | null }
}

type HeaderBag = { get(name: string): string | null }

function trimUrl(u: string): string {
  return u.trim().replace(/\/+$/, '')
}

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i
export const LOOPBACK_URL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i

function withScheme(host: string): string {
  return /^https?:\/\//i.test(host) ? trimUrl(host) : `https://${trimUrl(host)}`
}

/** Is this host one of OUR deployments — where the bypass secret may be sent? */
export function isOwnVercelHost(baseUrl: string, env: Record<string, string | undefined> = process.env): boolean {
  let host: string
  try {
    host = new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return false
  }
  const own = [env.VERCEL_URL, env.VERCEL_BRANCH_URL, env.VERCEL_PROJECT_PRODUCTION_URL]
    .filter((h): h is string => Boolean(h))
    .map((h) => h.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase())
  return own.includes(host) || host.endsWith('.vercel.app')
}

/**
 * The headers a request from this deployment to itself must carry to pass
 * Deployment Protection. The bypass secret opens EVERY protected deployment of
 * the project, so it is attached only when the target is one of our own Vercel
 * hosts — never to an arbitrary SCOUT_WORKER_BASE_URL (a tunnel, a proxy).
 */
export function workerAuthHeaders(env: Record<string, string | undefined> = process.env, targetBaseUrl?: string | null): Record<string, string> {
  const secret = (env.VERCEL_AUTOMATION_BYPASS_SECRET ?? '').trim()
  if (!env.VERCEL || !secret) return {}
  if (targetBaseUrl && !isOwnVercelHost(targetBaseUrl, env)) return {}
  return { 'x-vercel-protection-bypass': secret }
}

/**
 * The dispatch target, chosen by the SERVER — never by the caller.
 *
 * `x-forwarded-host` and `host` arrive from whoever made the request. Deriving
 * the dispatch URL from them means a request can point the server at any host
 * on the internet and hand it the run's claim token. So the trustworthy sources
 * come first, and a header host is honoured only when it names this machine.
 */
export function resolveWorkerBase(headers?: HeaderBag | null, env: Record<string, string | undefined> = process.env): WorkerBase {
  const headerHost = headers?.get('x-forwarded-host') ?? headers?.get('host') ?? null
  const onVercel = Boolean(env.VERCEL)
  const vercelEnv = env.VERCEL_ENV ?? null
  const vercel = { onVercel, env: vercelEnv, deploymentId: env.VERCEL_DEPLOYMENT_ID ?? null }
  const base = (baseUrl: string, source: WorkerBaseSource, ignored: string | null = null): WorkerBase => ({
    baseUrl,
    source,
    ignoredHeaderHost: ignored,
    headers: workerAuthHeaders(env, baseUrl),
    problem: null,
    vercel,
  })

  const explicit = (env.SCOUT_WORKER_BASE_URL ?? '').trim()
  if (explicit) {
    const b = base(trimUrl(explicit), 'env:SCOUT_WORKER_BASE_URL', headerHost)
    if (onVercel && LOOPBACK_URL.test(b.baseUrl)) {
      b.problem = {
        message: `SCOUT_WORKER_BASE_URL is ${b.baseUrl}, which is this function's own loopback address, not your site. Scouting cannot start.`,
        remedy: 'Set SCOUT_WORKER_BASE_URL to your production URL (https://your-app.vercel.app), or remove it and enable Protection Bypass for Automation.',
      }
    }
    return b
  }

  if (onVercel) {
    if (env.VERCEL_URL && env.VERCEL_AUTOMATION_BYPASS_SECRET) {
      return base(withScheme(env.VERCEL_URL), 'env:VERCEL_URL+bypass', headerHost)
    }
    if (vercelEnv === 'production') {
      if (env.VERCEL_PROJECT_PRODUCTION_URL) return base(withScheme(env.VERCEL_PROJECT_PRODUCTION_URL), 'env:VERCEL_PROJECT_PRODUCTION_URL', headerHost)
      const pub = (env.NEXT_PUBLIC_APP_URL ?? '').trim()
      if (pub && /^https:\/\//i.test(pub) && !LOOPBACK_URL.test(pub)) return base(trimUrl(pub), 'env:NEXT_PUBLIC_APP_URL', headerHost)
    }
    // A preview (or a production deployment with none of the above): nothing
    // this function can prove it may call. Refuse, and say what fixes it.
    return {
      baseUrl: '',
      source: 'unresolved',
      ignoredHeaderHost: headerHost,
      headers: {},
      vercel,
      problem: {
        message:
          vercelEnv === 'production'
            ? 'No worker address is configured for production: SCOUT_WORKER_BASE_URL is unset, no automation bypass secret is available, and VERCEL_PROJECT_PRODUCTION_URL is missing. Scouting cannot start.'
            : `This is a ${vercelEnv ?? 'non-production'} deployment with no way to reach its own worker: Deployment Protection would answer the app's self-request with 401, and preview work is never sent to production.`,
        remedy:
          'Enable "Protection Bypass for Automation" in the Vercel project (Settings → Deployment Protection) so VERCEL_AUTOMATION_BYPASS_SECRET is provided to every deployment, or set SCOUT_WORKER_BASE_URL for this environment.',
      },
    }
  }

  const pub = (env.NEXT_PUBLIC_APP_URL ?? '').trim()
  if (pub) return base(trimUrl(pub), 'env:NEXT_PUBLIC_APP_URL', headerHost)
  if (headerHost && LOOPBACK_HOST.test(headerHost)) return base(`http://${headerHost}`, 'header:loopback')
  return base('http://localhost:3000', 'default', headerHost)
}

export function workerBaseUrl(headers?: HeaderBag | null, env: Record<string, string | undefined> = process.env): string {
  return resolveWorkerBase(headers, env).baseUrl
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

/**
 *   accepted          the worker answered 2xx (it claimed the run)
 *   claimed_elsewhere the worker answered 409: the run was already claimed or
 *                     finished — another dispatcher won, which is a SUCCESS for
 *                     the system, not a protection failure
 *   pending           no answer yet; the worker executes inside its POST and
 *                     answers at the end, so this is the NORMAL outcome of the
 *                     race — acceptance is observed on the row (awaitClaim)
 *   failed            we KNOW it did not land
 */
export type DispatchOutcome = 'accepted' | 'claimed_elsewhere' | 'pending' | 'failed'

export interface DispatchSettled {
  outcome: DispatchOutcome
  status: number | null
  error: string | null
  /** Milliseconds from the request to the answer (or the failure). */
  latencyMs: number
}

export interface DispatchResult extends DispatchSettled {
  /** "Not known to have failed" — kept for existing callers. */
  dispatched: boolean
  /**
   * The underlying request, still in flight when `outcome` is 'pending'. The
   * caller hands it to `waitUntil` and ACTS on how it settles: a late 401 is
   * written to the run row, never dropped.
   */
  settled: Promise<DispatchSettled>
  /** Stop waiting for the worker. Safe to call after it settled. */
  abort: () => void
}

/** The worker route, shared by both scout kinds (claims by token, then switches on `kind`). */
export const WORKER_PATH = '/api/scout/worker'

/**
 * The fuse on the dispatch request itself. The worker executes INSIDE its POST
 * and answers only at the end, so the request legitimately stays open for the
 * whole invocation; this fuse only stops a dead connection from lingering for
 * ever. Acceptance is never inferred from it — see `awaitClaim`.
 */
export const DISPATCH_ACCEPT_TIMEOUT_MS = 330_000

/**
 * Start the worker without waiting for it to finish. The race decides only
 * what the CALLER is told immediately; `settled` carries the HTTP truth, and
 * the row carries the real one (a worker that claimed the run wrote 'running').
 *
 *   accepted          the worker answered 2xx already (it finished fast)
 *   claimed_elsewhere the worker answered 409: another dispatcher won
 *   pending           no answer yet — normal; observe the claim on the row
 *   failed            we KNOW it did not land: a 401 from Deployment Protection,
 *                     a 404 on a wrong base, a 500, a network error
 */
export async function dispatchScoutWorker(
  target: string | Pick<WorkerBase, 'baseUrl' | 'headers'>,
  runId: string,
  token: string,
  opts: { raceMs?: number; acceptTimeoutMs?: number; fetchImpl?: typeof fetch; path?: string; extraHeaders?: Record<string, string> } = {}
): Promise<DispatchResult> {
  const raceMs = opts.raceMs ?? 1_500
  const acceptTimeoutMs = opts.acceptTimeoutMs ?? DISPATCH_ACCEPT_TIMEOUT_MS
  const doFetch = opts.fetchImpl ?? fetch
  const baseUrl = typeof target === 'string' ? target : target.baseUrl
  const headers = typeof target === 'string' ? workerAuthHeaders(process.env, target) : target.headers
  const url = `${trimUrl(baseUrl)}${opts.path ?? WORKER_PATH}`
  const startedAt = Date.now()

  const never: DispatchResult = {
    dispatched: false,
    outcome: 'failed',
    status: null,
    error: 'no worker address is configured for this deployment',
    latencyMs: 0,
    settled: Promise.resolve({ outcome: 'failed', status: null, error: 'no worker address is configured for this deployment', latencyMs: 0 }),
    abort: () => undefined,
  }
  if (!baseUrl) return never

  const controller = new AbortController()
  // Unref'd: a fuse must never be the thing keeping a process alive.
  const fuse = setTimeout(() => controller.abort(), acceptTimeoutMs)
  fuse.unref?.()

  const sent: Promise<DispatchSettled> = doFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers, ...(opts.extraHeaders ?? {}) },
    body: JSON.stringify({ runId, token }),
    cache: 'no-store',
    signal: controller.signal,
  }).then(
    (res) => {
      clearTimeout(fuse)
      const latencyMs = Date.now() - startedAt
      if (res.ok) return { outcome: 'accepted' as const, status: res.status, error: null, latencyMs }
      // 409 is the worker saying "not claimable": already claimed, already
      // finished, or a token that was consumed by the dispatcher that won.
      if (res.status === 409) return { outcome: 'claimed_elsewhere' as const, status: res.status, error: null, latencyMs }
      return {
        outcome: 'failed' as const,
        status: res.status,
        latencyMs,
        error:
          res.status === 401 || res.status === 403
            ? `the worker refused the request (HTTP ${res.status} at ${url}) — on Vercel this is Deployment Protection blocking the app from calling itself; enable Protection Bypass for Automation or set SCOUT_WORKER_BASE_URL to the production domain`
            : res.status === 404
              ? `nothing answers at ${url} (HTTP 404) — the worker address points at a deployment without this route`
              : `the worker answered HTTP ${res.status} at ${url}`,
      }
    },
    (e: unknown) => {
      clearTimeout(fuse)
      const latencyMs = Date.now() - startedAt
      const aborted = (e instanceof Error && e.name === 'AbortError') || controller.signal.aborted
      return {
        outcome: 'failed' as const,
        status: null,
        latencyMs,
        error: aborted
          ? `the worker did not accept the run within ${Math.round(acceptTimeoutMs / 1000)}s (dispatching to ${url})`
          : `${e instanceof Error ? e.message : String(e)} (dispatching to ${url})`,
      }
    }
  )

  let pendingTimer: ReturnType<typeof setTimeout> | null = null
  const pending: Promise<DispatchSettled> = new Promise((r) => {
    pendingTimer = setTimeout(() => r({ outcome: 'pending', status: null, error: null, latencyMs: raceMs }), raceMs)
    pendingTimer.unref?.()
  })
  const raced = await Promise.race([sent, pending])
  if (pendingTimer) clearTimeout(pendingTimer)
  return {
    dispatched: raced.outcome !== 'failed',
    outcome: raced.outcome,
    status: raced.status,
    error: raced.error,
    latencyMs: raced.latencyMs,
    settled: sent,
    abort: () => {
      clearTimeout(fuse)
      controller.abort()
    },
  }
}
