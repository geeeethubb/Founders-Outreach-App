// How a durable scout run is PARAMETERISED and how a worker is REACHED.
//
// Split out of run-store.ts, which owns the run state machine and has no
// business knowing about HTTP, request headers or environment variables. This
// half answers two questions and nothing else:
//
//   1. what will the worker execute?  (sanitizeScoutParams / readScoutParams)
//   2. where is the worker?           (workerBaseUrl / dispatchScoutWorker)
//
// Both are security-relevant, which is the real reason they are together: the
// request body is untrusted and is executed minutes later by a different
// invocation, and the dispatch carries the run's single-use claim token — a
// capability. Neither may be derived from something a caller can dictate.

export interface ScoutRunParams {
  missionId: string | null
  strategies: number
  rounds: number
  companies: number
  extract: number
  verify: boolean
  rank: boolean
  label: string
}

/**
 * Vercel kills the function at 300s, so a hosted run is shallower and stops at
 * 280s. `companies` went 20 → 60: it is a LISTING budget, and a listing is one
 * cached JSON request per board, so twenty was rationing the cheapest thing in
 * the run. `extract` stays at 30 — that one is a model call per posting, it is
 * where the money goes, and 280 seconds cannot buy more of it.
 */
export const VERCEL_CAPS = { strategies: 2, rounds: 2, companies: 60, extract: 30 }
export const VERCEL_DEADLINE_MS = 280_000
/**
 * Off Vercel there is no function ceiling, so a local run should reach the
 * WHOLE watchlist rather than a sample of it: `companies` 25 → 250, which is
 * more than the founder's 188 and therefore not a cap in practice. `extract`
 * 40 → 80 because inventory no longer depends on it — a posting is stored
 * whether or not it was read (lib/career/jobs/sweep.ts), so this number now
 * only decides how many get read, and 80 is what twenty minutes affords.
 */
export const LOCAL_CAPS = { strategies: 3, rounds: 2, companies: 250, extract: 80 }
export const LOCAL_DEADLINE_MS = 1_200_000

export function onVercel(): boolean {
  return Boolean(process.env.VERCEL)
}

export function scoutCaps(vercel = onVercel()): typeof VERCEL_CAPS {
  return vercel ? VERCEL_CAPS : LOCAL_CAPS
}

/**
 * The wall clock a worker promises to finish inside. It is not only a budget:
 * `run-store` records it on the row at claim time and the reaper refuses to
 * declare a run dead before it, because a scout is legitimately silent for
 * minutes at a time (one live planner call took 226s).
 */
export function scoutDeadlineMs(vercel = onVercel()): number {
  return vercel ? VERCEL_DEADLINE_MS : LOCAL_DEADLINE_MS
}

function clampInt(v: unknown, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fallback
  return Math.max(0, Math.min(max, n))
}

/** The request body is untrusted and the row is executed later — sanitize once, here. */
export function sanitizeScoutParams(body: Record<string, unknown> | null | undefined, caps = scoutCaps()): ScoutRunParams {
  const b = body ?? {}
  return {
    missionId: typeof b.missionId === 'string' && b.missionId ? b.missionId : null,
    strategies: clampInt(b.strategies, caps.strategies, caps.strategies),
    rounds: clampInt(b.rounds, caps.rounds, caps.rounds),
    companies: clampInt(b.companies, caps.companies, caps.companies),
    extract: clampInt(b.extract, caps.extract, caps.extract),
    verify: b.verify !== false,
    rank: b.rank !== false,
    label: typeof b.label === 'string' && b.label ? b.label.slice(0, 120) : 'job scout · web',
  }
}

/** Reads a persisted `params` payload back into the shape the worker executes. */
export function readScoutParams(params: unknown, caps = scoutCaps()): ScoutRunParams {
  return sanitizeScoutParams((params ?? {}) as Record<string, unknown>, caps)
}

// ─── Where the worker is ─────────────────────────────────────────────────────

export type WorkerBaseSource = 'env:SCOUT_WORKER_BASE_URL' | 'env:VERCEL_URL' | 'env:NEXT_PUBLIC_APP_URL' | 'header:loopback' | 'default'

export interface WorkerBase {
  baseUrl: string
  source: WorkerBaseSource
  /** True when a host header was present and deliberately NOT used. */
  ignoredHeaderHost: string | null
}

type HeaderBag = { get(name: string): string | null }

function trimUrl(u: string): string {
  return u.replace(/\/$/, '')
}

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i

/**
 * The dispatch target, chosen by the SERVER — never by the caller.
 *
 * `x-forwarded-host` and `host` arrive from whoever made the request. Deriving
 * the dispatch URL from them means a request can point the server at any host
 * on the internet and hand it the run's claim token: a blind SSRF that also
 * leaks a capability. So the trustworthy sources come first, and a header host
 * is honoured only when it names this machine (a loopback address), which is
 * the one case where no configuration exists to consult — `next dev`.
 *
 * Set SCOUT_WORKER_BASE_URL when the app is reachable at an address neither
 * VERCEL_URL nor NEXT_PUBLIC_APP_URL describes (a tunnel, a reverse proxy on a
 * different origin).
 */
export function resolveWorkerBase(headers?: HeaderBag | null, env: Record<string, string | undefined> = process.env): WorkerBase {
  const headerHost = headers?.get('x-forwarded-host') ?? headers?.get('host') ?? null

  if (env.SCOUT_WORKER_BASE_URL) return { baseUrl: trimUrl(env.SCOUT_WORKER_BASE_URL), source: 'env:SCOUT_WORKER_BASE_URL', ignoredHeaderHost: null }
  if (env.VERCEL_URL) return { baseUrl: `https://${trimUrl(env.VERCEL_URL)}`, source: 'env:VERCEL_URL', ignoredHeaderHost: headerHost }
  if (env.NEXT_PUBLIC_APP_URL) return { baseUrl: trimUrl(env.NEXT_PUBLIC_APP_URL), source: 'env:NEXT_PUBLIC_APP_URL', ignoredHeaderHost: headerHost }
  if (headerHost && LOOPBACK.test(headerHost)) return { baseUrl: `http://${headerHost}`, source: 'header:loopback', ignoredHeaderHost: null }
  return { baseUrl: 'http://localhost:3000', source: 'default', ignoredHeaderHost: headerHost }
}

export function workerBaseUrl(headers?: HeaderBag | null, env: Record<string, string | undefined> = process.env): string {
  return resolveWorkerBase(headers, env).baseUrl
}

/**
 * Start the worker without waiting for it. We await only long enough for the
 * request to be on the wire — the whole point is that the run outlives this
 * request. A dispatch that never lands is not fatal: GET
 * /api/career/scout/runs/[id] re-dispatches a run still queued after
 * REDISPATCH_AFTER_MS.
 */
export async function dispatchScoutWorker(
  baseUrl: string,
  runId: string,
  token: string,
  opts: { raceMs?: number; fetchImpl?: typeof fetch } = {}
): Promise<{ dispatched: boolean; error: string | null }> {
  const raceMs = opts.raceMs ?? 1_500
  const doFetch = opts.fetchImpl ?? fetch
  let error: string | null = null
  const sent = doFetch(`${trimUrl(baseUrl)}/api/career/scout/worker`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runId, token }),
    cache: 'no-store',
  }).then(
    () => true,
    (e: unknown) => {
      error = e instanceof Error ? e.message : String(e)
      return false
    }
  )
  const raced = await Promise.race([sent, new Promise<boolean>((r) => setTimeout(() => r(true), raceMs))])
  return { dispatched: raced, error }
}
