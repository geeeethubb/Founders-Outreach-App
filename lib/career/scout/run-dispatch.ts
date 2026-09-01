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

import type { SearchStrategy } from '@/lib/agents/job-mission-planner'
import { MAX_CONFIGURABLE_SPEND_USD, parseRunMode, resolveRunBudget, type RunMode } from '@/lib/career/discovery/modes'

export interface ScoutRunParams {
  missionId: string | null
  /**
   * How deep this run goes. Null means the caller named no mode and gets the
   * legacy numbers with no spend ceiling — see LEGACY_BUDGET.
   */
  mode: RunMode | null
  /** The user's own ceiling in dollars, or null for the mode's default. */
  maxSpendUsd: number | null
  strategies: number
  rounds: number
  companies: number
  extract: number
  verify: boolean
  rank: boolean
  label: string
  /** Where a previous invocation of this run stopped. Empty on a first pass. */
  cursor: ScoutCursor
  /**
   * Deprecated per-stage fields the caller sent explicitly. They still win over
   * the mode (one release of compatibility), and the run says which ones did.
   */
  legacyFields: string[]
}

// ─── The task cursor ─────────────────────────────────────────────────────────
//
// A BROAD or EXHAUSTIVE run legitimately takes 10–60 minutes, and no worker
// invocation lives that long: Vercel kills a function at 300s. So a run is not
// one execution — it is a row plus a CURSOR saying which sources, query
// families, pages, strategies and companies are already done. A worker that
// reaches its deadline finishes `partial` and writes the cursor; the next
// invocation reads it and CONTINUES instead of paying for the same work twice.
//
// It is persisted inside the run's `params` (and mirrored into `progress`), so
// no migration is needed — ADR-040's row already carries both.

export interface ScoutCursor {
  /** Schema version. Anything else is read as an empty cursor. */
  v: 1
  /** Stages finished for good: 'sweep' | 'plan' | 'company-first' | 'job-first' | 'deferred' | 'rank'. */
  stages: string[]
  /** Job-first strategies already executed to completion, by name. */
  strategies: string[]
  /** Companies already checked this run, by id. */
  companies: string[]
  /** Query families already executed, by key. */
  families: string[]
  /** Per-source pagination: source id → next page index to request. */
  pages: Record<string, number>
  /**
   * The plan this run is executing. Kept so a continuation does NOT pay the
   * planner again — re-planning on every invocation would be the single most
   * expensive way to resume.
   */
  planned: SearchStrategy[] | null
  /** Dollars this run has already spent, across every invocation. */
  spent_usd: number
  /**
   * Wall clock this run has already burned, across every invocation.
   *
   * This is what makes `RunBudget.maxRuntimeMs` a real bound rather than a
   * sentence in the UI: an EXHAUSTIVE run may take an hour, no worker
   * invocation may take more than 280s (Vercel) or 1200s (local), so the total
   * has to live on the row. A continuation whose elapsed time has reached the
   * mode's runtime starts nothing new.
   */
  elapsed_ms: number
  /** How many worker invocations have worked this run. */
  attempts: number
  updated_at: string | null
}

const CURSOR_LIMITS = { stages: 12, strategies: 200, companies: 3000, families: 500, pages: 500, planned: 64, queries: 40, str: 200 }

export function emptyCursor(): ScoutCursor {
  return { v: 1, stages: [], strategies: [], companies: [], families: [], pages: {}, planned: null, spent_usd: 0, elapsed_ms: 0, attempts: 0, updated_at: null }
}

function strList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const v of value) {
    if (typeof v !== 'string' || !v) continue
    const s = v.slice(0, CURSOR_LIMITS.str)
    if (!out.includes(s)) out.push(s)
    if (out.length >= max) break
  }
  return out
}

function sanitizeStrategy(value: unknown): SearchStrategy | null {
  if (!value || typeof value !== 'object') return null
  const s = value as Record<string, unknown>
  if (typeof s.name !== 'string' || !s.name) return null
  const kind = s.kind === 'company_first' || s.kind === 'job_first' ? s.kind : 'job_first'
  return {
    name: s.name.slice(0, CURSOR_LIMITS.str),
    kind,
    queries: strList(s.queries, CURSOR_LIMITS.queries),
    geo_focus: strList(s.geo_focus, 20),
    target_titles: strList(s.target_titles, 40),
    priority: typeof s.priority === 'number' && Number.isFinite(s.priority) ? Math.max(0, Math.min(1, s.priority)) : 0.5,
    rationale: typeof s.rationale === 'string' ? s.rationale.slice(0, 500) : '',
  } as SearchStrategy
}

/**
 * A cursor read back from a persisted row, or from a request body. Both are
 * untrusted — the row is written by a worker and executed by a later one — so
 * every list is bounded and every string is clipped. Never throws.
 */
export function sanitizeCursor(value: unknown): ScoutCursor {
  const c = emptyCursor()
  if (!value || typeof value !== 'object') return c
  const v = value as Record<string, unknown>
  if (v.v !== 1) return c
  c.stages = strList(v.stages, CURSOR_LIMITS.stages)
  c.strategies = strList(v.strategies, CURSOR_LIMITS.strategies)
  c.companies = strList(v.companies, CURSOR_LIMITS.companies)
  c.families = strList(v.families, CURSOR_LIMITS.families)
  if (v.pages && typeof v.pages === 'object' && !Array.isArray(v.pages)) {
    let n = 0
    for (const [k, page] of Object.entries(v.pages as Record<string, unknown>)) {
      if (n >= CURSOR_LIMITS.pages) break
      const p = typeof page === 'number' && Number.isFinite(page) ? Math.max(0, Math.floor(page)) : null
      if (p === null) continue
      c.pages[k.slice(0, CURSOR_LIMITS.str)] = p
      n++
    }
  }
  if (Array.isArray(v.planned)) {
    const planned = v.planned.slice(0, CURSOR_LIMITS.planned).map(sanitizeStrategy).filter((s): s is SearchStrategy => s !== null)
    c.planned = planned.length ? planned : null
  }
  c.spent_usd = typeof v.spent_usd === 'number' && Number.isFinite(v.spent_usd) ? Math.max(0, v.spent_usd) : 0
  c.elapsed_ms = typeof v.elapsed_ms === 'number' && Number.isFinite(v.elapsed_ms) ? Math.max(0, Math.floor(v.elapsed_ms)) : 0
  c.attempts = typeof v.attempts === 'number' && Number.isFinite(v.attempts) ? Math.max(0, Math.floor(v.attempts)) : 0
  c.updated_at = typeof v.updated_at === 'string' ? v.updated_at.slice(0, 40) : null
  return c
}

/** Nothing done yet — a first pass, not a continuation. */
export function isCursorEmpty(c: ScoutCursor): boolean {
  return c.stages.length === 0 && c.strategies.length === 0 && c.companies.length === 0 && c.families.length === 0 && Object.keys(c.pages).length === 0
}

/** The run got all the way through; a continuation would do nothing. */
export function isCursorComplete(c: ScoutCursor): boolean {
  return c.stages.includes('done')
}

/** One line for the UI and the run report: how much of the run is already behind us. */
export function describeCursor(c: ScoutCursor): string {
  if (isCursorComplete(c)) return 'the run finished every stage'
  if (isCursorEmpty(c)) return 'nothing done yet'
  const parts: string[] = []
  if (c.stages.length) parts.push(`${c.stages.join(', ')} done`)
  if (c.strategies.length) parts.push(`${c.strategies.length} strateg${c.strategies.length === 1 ? 'y' : 'ies'} executed`)
  if (c.companies.length) parts.push(`${c.companies.length} companies checked`)
  const pages = Object.values(c.pages).reduce((a, b) => a + b, 0)
  if (pages) parts.push(`${pages} pages read`)
  if (c.spent_usd > 0) parts.push(`$${c.spent_usd.toFixed(2)} spent`)
  if (c.elapsed_ms > 0) parts.push(`${Math.round(c.elapsed_ms / 1000)}s of run time used`)
  return `${parts.join(' · ')} (pass ${c.attempts + 1})`
}

/**
 * The cursor a persisted run row is carrying, wherever it was written.
 *
 * Three places, in order of authority:
 *
 *   `params.cursor`   what the worker patched onto the row as it worked —
 *                     and what the next invocation is asked to execute.
 *   `progress.cursor` the same thing mirrored into the progress payload.
 *   `stats.discovery.cursor` where the ORCHESTRATOR's own report puts it when
 *                     the run finishes. A run whose worker died before it
 *                     could patch params still resumes from this, and so does
 *                     a run recorded by the CLI, which writes stats and no
 *                     params at all.
 *
 * Reading only the first of those is how "continue this run" quietly became
 * "start the whole run again at full price": the reader looked in a place
 * nothing wrote.
 */
export function readRunCursor(row: { params?: unknown; progress?: unknown; stats?: unknown } | null | undefined): ScoutCursor {
  if (!row) return emptyCursor()
  const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null)
  const fromParams = obj(row.params)?.cursor
  if (fromParams) return sanitizeCursor(fromParams)
  const fromProgress = obj(row.progress)?.cursor
  if (fromProgress) return sanitizeCursor(fromProgress)
  const discovery = obj(obj(row.stats)?.discovery)
  return sanitizeCursor(discovery?.cursor)
}

/**
 * The patch that writes a cursor onto a run row.
 *
 * One shape, so `params` (what the next worker executes) and `progress` (what
 * the UI reads) can never disagree about where a run got to. The patch is
 * merged onto the row's existing params by the caller — a cursor must never
 * replace the parameters the run was started with.
 */
export function cursorParamsPatch(params: ScoutRunParams | Record<string, unknown>, cursor: ScoutCursor): Record<string, unknown> {
  return { ...(params as Record<string, unknown>), cursor: sanitizeCursor(cursor) }
}

/**
 * Vercel kills the function at 300s, so a hosted run is shallower and stops at
 * 280s. `companies` went 20 → 60: it is a LISTING budget, and a listing is one
 * cached JSON request per board, so twenty was rationing the cheapest thing in
 * the run. `extract` stays at 30 — that one is a model call per posting, it is
 * where the money goes, and 280 seconds cannot buy more of it.
 */
export const VERCEL_CAPS = { strategies: 6, rounds: 3, companies: 60, extract: 40 }
export const VERCEL_DEADLINE_MS = 280_000
/**
 * Off Vercel there is no function ceiling, so a local run should reach the
 * WHOLE watchlist rather than a sample of it: `companies` 25 → 250, which is
 * more than the founder's 188 and therefore not a cap in practice. `extract`
 * 40 → 80 because inventory no longer depends on it — a posting is stored
 * whether or not it was read (lib/career/jobs/sweep.ts), so this number now
 * only decides how many get read, and 80 is what twenty minutes affords.
 */
export const LOCAL_CAPS = { strategies: 24, rounds: 5, companies: 1000, extract: 250 }
export const LOCAL_DEADLINE_MS = 1_200_000

/**
 * What a caller that names NO mode and sets no field gets — deliberately the
 * numbers this route used before run modes existed.
 *
 * The caps above are the per-invocation ceiling and they were raised so a
 * BROAD or EXHAUSTIVE run can actually reach for depth. A cap is not a
 * default: raising one must not silently make every old caller's run bigger
 * and more expensive, so the legacy defaults are pinned here instead.
 */
export const VERCEL_LEGACY_DEFAULTS = { strategies: 2, rounds: 2, companies: 60, extract: 30 }
export const LOCAL_LEGACY_DEFAULTS = { strategies: 3, rounds: 2, companies: 250, extract: 80 }

export function legacyDefaults(vercel = onVercel()): typeof VERCEL_LEGACY_DEFAULTS {
  return vercel ? VERCEL_LEGACY_DEFAULTS : LOCAL_LEGACY_DEFAULTS
}

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

const LEGACY_FIELDS = ['strategies', 'rounds', 'companies', 'extract'] as const

/**
 * The request body is untrusted and the row is executed later — sanitize once,
 * here.
 *
 * The shape of a run is now ONE choice (`mode`) plus an optional ceiling
 * (`maxSpendUsd`). The four old per-stage numbers are still honoured for one
 * release, and when a caller sends one it wins over what the mode would have
 * derived — so an old client, a saved bookmark or a script keeps behaving
 * exactly as it did. Which ones were used is recorded in `legacyFields`, so
 * the run can say it was steered by deprecated inputs rather than by its mode.
 */
export function sanitizeScoutParams(
  body: Record<string, unknown> | null | undefined,
  caps = scoutCaps(),
  opts: { trustCursor?: boolean } = {}
): ScoutRunParams {
  const b = body ?? {}
  const mode = parseRunMode(b.mode)
  // Clamped to the SAME ceiling resolveRunBudget enforces. It used to clamp at
  // 1000, so a request for $1000 was stored and echoed back as $1000 while the
  // run would in fact stop at $100: the row promised ten times what it could
  // spend. The number the caller is told is the number that will be enforced.
  const maxSpendUsd =
    typeof b.maxSpendUsd === 'number' && Number.isFinite(b.maxSpendUsd) ? Math.max(0, Math.min(MAX_CONFIGURABLE_SPEND_USD, b.maxSpendUsd)) : null
  const budget = mode ? resolveRunBudget(mode, { maxSpendUsd }) : null
  const fallback = budget
    ? { strategies: budget.maxStrategies, rounds: budget.maxRoundsPerStrategy, companies: budget.maxCompanyFirst, extract: budget.maxExtract }
    : legacyDefaults()
  const legacyFields = LEGACY_FIELDS.filter((f) => typeof b[f] === 'number' && Number.isFinite(b[f] as number))
  return {
    missionId: typeof b.missionId === 'string' && b.missionId ? b.missionId : null,
    mode,
    maxSpendUsd,
    strategies: clampInt(b.strategies, caps.strategies, fallback.strategies),
    rounds: clampInt(b.rounds, caps.rounds, fallback.rounds),
    companies: clampInt(b.companies, caps.companies, fallback.companies),
    extract: clampInt(b.extract, caps.extract, fallback.extract),
    verify: b.verify !== false,
    rank: b.rank !== false,
    label: typeof b.label === 'string' && b.label ? b.label.slice(0, 120) : 'job scout · web',
    // A cursor says "these stages are already done". Honouring one that came
    // from a REQUEST would let a caller skip stages of their own run for
    // reasons nobody can audit, so it is read only from a stored row
    // (readScoutParams) or built by continuationParams from one.
    cursor: opts.trustCursor === true ? sanitizeCursor(b.cursor) : emptyCursor(),
    legacyFields: [...legacyFields],
  }
}

/** Reads a persisted `params` payload back into the shape the worker executes. */
export function readScoutParams(params: unknown, caps = scoutCaps()): ScoutRunParams {
  // The row is the authority on what this run has already done, so a cursor
  // read from it IS trusted (it is still bounded by sanitizeCursor).
  return sanitizeScoutParams((params ?? {}) as Record<string, unknown>, caps, { trustCursor: true })
}

/**
 * The parameters a worker (or the CLI) spreads into `runJobScout`.
 *
 * It exists so that "what the row says" and "what the orchestrator is asked
 * for" cannot drift: every caller that executes a persisted run maps it here,
 * once, instead of listing eight fields by hand and quietly dropping the two
 * that were added last — which is exactly how `mode` and `cursor` would
 * otherwise fail to reach the run they belong to.
 */
export function toJobScoutParams(
  p: ScoutRunParams,
  extra: {
    userId: string
    deadlineMs: number
    onProgress?: (stage: string, detail: string, counts?: Record<string, number>) => void
    /**
     * Called whenever the cursor moves, so an executor can persist it while
     * the run is still alive. A worker killed at its platform deadline never
     * reaches the finishing write, and that is exactly the invocation whose
     * cursor matters.
     */
    onCursor?: (cursor: ScoutCursor) => void
  }
) {
  return {
    userId: extra.userId,
    missionId: p.missionId,
    budget: { deadlineMs: extra.deadlineMs },
    mode: p.mode ?? undefined,
    maxSpendUsd: p.maxSpendUsd ?? undefined,
    cursor: p.cursor,
    maxStrategies: p.strategies,
    maxRoundsPerStrategy: p.rounds,
    maxCompaniesFirst: p.companies,
    maxExtract: p.extract,
    verify: p.verify,
    rank: p.rank,
    label: p.label,
    onProgress: extra.onProgress,
    onCursor: extra.onCursor,
  }
}

/**
 * The params a CONTINUATION of this run should be enqueued with: the same
 * shape, carrying the cursor the last invocation stopped at.
 *
 * A continuation is a new invocation of the same work, not a new run: it must
 * not re-plan, re-check the companies already checked or re-execute the
 * strategies already executed, and its spend counts against the same ceiling.
 *
 * `attempts` is NOT incremented here. The orchestrator increments it on entry,
 * because it is the thing that actually makes an attempt — counting it in both
 * places made a resumed run report "pass 3" on its second pass.
 */
export function continuationParams(p: ScoutRunParams, cursor: ScoutCursor): ScoutRunParams {
  return { ...p, cursor: sanitizeCursor(cursor) }
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
 * Start the worker without waiting for it to finish. We await only long enough
 * to learn whether the request was ACCEPTED — the run itself outlives this
 * request.
 *
 * This used to lie in three separate ways, and together they are why a run sat
 * queued for 328 minutes with `dispatched: true` recorded against it:
 *
 *   1. The race timer resolved `true`, so "1.5 seconds elapsed" and "a worker
 *      took it" were the same answer.
 *   2. `.then(() => true)` never looked at the Response, so a 401 from
 *      deployment protection, a 404, a 500 or an HTML login page all reported
 *      success with no error.
 *   3. A rejection arriving after the race wrote `error` into a variable
 *      nobody read again.
 *
 * Now the three outcomes are distinct, because the caller has to act
 * differently on each: `accepted` (the worker answered 2xx), `pending` (still in
 * flight — genuinely worth waiting for), `failed` (we know it did not land, so
 * fail fast rather than leave a spinner running).
 */
export type DispatchOutcome = 'accepted' | 'pending' | 'failed'

export async function dispatchScoutWorker(
  baseUrl: string,
  runId: string,
  token: string,
  opts: { raceMs?: number; fetchImpl?: typeof fetch } = {}
): Promise<{ dispatched: boolean; outcome: DispatchOutcome; status: number | null; error: string | null }> {
  const raceMs = opts.raceMs ?? 1_500
  const doFetch = opts.fetchImpl ?? fetch
  const url = `${trimUrl(baseUrl)}/api/career/scout/worker`

  type Settled = { outcome: DispatchOutcome; status: number | null; error: string | null }
  const sent: Promise<Settled> = doFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runId, token }),
    cache: 'no-store',
  }).then(
    (res) =>
      res.ok
        ? { outcome: 'accepted' as const, status: res.status, error: null }
        : {
            outcome: 'failed' as const,
            status: res.status,
            // 401 here is almost always Vercel Deployment Protection on the
            // self-POST; say so, because "401" alone sends people to their auth code.
            error:
              res.status === 401 || res.status === 403
                ? `the worker refused the request (HTTP ${res.status}) — on Vercel this is usually Deployment Protection blocking the app from calling itself; set SCOUT_WORKER_BASE_URL to a reachable URL`
                : `the worker answered HTTP ${res.status} at ${url}`,
          },
    (e: unknown) => ({
      outcome: 'failed' as const,
      status: null,
      error: `${e instanceof Error ? e.message : String(e)} (dispatching to ${url})`,
    })
  )

  const pending: Promise<Settled> = new Promise((r) =>
    setTimeout(() => r({ outcome: 'pending', status: null, error: null }), raceMs)
  )
  const raced = await Promise.race([sent, pending])
  // `dispatched` keeps its old meaning for existing callers — "not known to have
  // failed" — while `outcome` carries the distinction they now need.
  return { dispatched: raced.outcome !== 'failed', outcome: raced.outcome, status: raced.status, error: raced.error }
}
