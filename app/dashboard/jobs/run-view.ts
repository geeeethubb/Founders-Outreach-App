// Reading a durable scout run — the parsing half of the run monitor.
//
// POST /api/career/scout queues a run and answers a `runId`; everything the
// panel shows afterwards comes from GET /api/career/scout/runs/[id]. That
// endpoint is the single source of truth, so this module never invents
// progress — it only normalizes what the server said. Sentences live in
// run-copy.ts; why a run stopped, or cannot start, in run-reasons.ts.
//
// Kept out of the React files so every shape the endpoints can answer is an
// offline fixture (scripts/test-career-ui-direction.ts), not a live run.
//
// Pure. No fetch, no React, no database.

export const RUN_STATUSES = ['queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

/** Statuses that will never change again. Polling stops here. */
export const TERMINAL_STATUSES: RunStatus[] = ['succeeded', 'partial', 'failed', 'cancelled']

/** How often the monitor asks the server what is happening. */
export const POLL_MS = 3_000
/** How often it keeps asking after it has lost contact — slower, never never. */
export const LOST_CONTACT_POLL_MS = 10_000

/**
 * Consecutive failed polls tolerated before a surface says it lost contact.
 * One 500 or one dropped packet must not freeze a run monitor, and both
 * monitors count to the same number.
 */
export const MAX_POLL_FAILURES = 5

export interface RunEvent {
  at: string | null
  stage: string | null
  detail: string | null
}

/**
 * The funnel as the run endpoint counts it. `unverified` means the UNVERIFIED
 * status itself, not "everything that is not verified open" — `likely_open` and
 * `closed` are their own columns, and a surface that shows only verified and
 * unverified would print numbers that do not add up to `total`. An endpoint
 * that does not report them answers 0, which is the pre-016 truth.
 */
export interface RunJobCounts {
  total: number
  inserted: number
  verified_open: number
  likely_open: number
  unverified: number
  closed: number
  ranked: number
}

export interface RunDetail {
  id: string
  /** 'job_scout' | 'outreach', or null when the endpoint did not say. */
  kind: string | null
  status: RunStatus
  stage: string | null
  detail: string | null
  counts: Record<string, number>
  events: RunEvent[]
  started_at: string | null
  heartbeat_at: string | null
  completed_at: string | null
  stats: Record<string, unknown> | null
  error: string | null
  /** The stable code behind `error` (lib/runs/errors.ts), when the run recorded one. */
  error_code: string | null
  /** What to do about it, when the run recorded one. */
  remedy: string | null
  jobs: RunJobCounts
  /** The server's own judgement that the run stopped short of its plan. */
  partial: boolean
  /** The server's own judgement that the heartbeat went quiet. */
  stale: boolean
  /** Which leg of the run is (or was) executing; 1 on a first pass. */
  invocation: number
  /** How many times a worker has been asked to start the current leg. */
  attempts: number
  /** The server's judgement from the persisted cursor; null when it did not say. */
  resumable: boolean | null
  cancel_requested: boolean
}

// ─── Normalizing whatever the endpoint answered ──────────────────────────────

/** A count from an untrusted payload: never negative, never NaN, never a string. */
export function toCount(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0
}

export function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** A histogram from an untrusted payload — the shape `counts`, `verification` and `jobs_rejected` all have. */
export function toCounts(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const n = typeof v === 'number' ? v : Number(v)
    if (Number.isFinite(n)) out[k] = n
  }
  return out
}

const num = toCount
const record = toCounts

export function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** A tri-state boolean from an untrusted payload: only a real boolean is believed. */
function bool(value: unknown): boolean | null {
  return value === true ? true : value === false ? false : null
}

export function isTerminal(status: RunStatus | null | undefined): boolean {
  return !!status && TERMINAL_STATUSES.includes(status)
}

export function isActive(status: RunStatus | null | undefined): boolean {
  return status === 'queued' || status === 'running'
}

function toStatus(value: unknown, completed: boolean): RunStatus {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if ((RUN_STATUSES as readonly string[]).includes(s)) return s as RunStatus
  // An old row can still say 'abandoned' (the Runs page derives it) or nothing
  // at all. Never guess success: an unfinished unknown run is still running.
  if (s === 'abandoned' || s === 'timeout') return 'failed'
  return completed ? 'succeeded' : 'running'
}

function toEvents(value: unknown): RunEvent[] {
  if (!Array.isArray(value)) return []
  return value
    .map((e) => {
      const o = object(e)
      if (!o) return typeof e === 'string' ? { at: null, stage: null, detail: e } : null
      return { at: str(o.at) ?? str(o.created_at), stage: str(o.stage), detail: str(o.detail) ?? str(o.message) }
    })
    .filter((e): e is RunEvent => !!e && (!!e.detail || !!e.stage))
}

/** `stats.discovery`, as the orchestrator writes it, or null. */
export function discoveryReport(stats: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  return object(stats?.discovery)
}

/**
 * The run as the UI needs it, from whatever the endpoint answered — a bare run
 * object or one wrapped in `{ run }`. Returns null only when there is no id to
 * poll, which is the one case the panel cannot recover from.
 */
export function parseRunDetail(raw: unknown): RunDetail | null {
  const top = object(raw)
  if (!top) return null
  const r = object(top.run) ?? top
  const id = str(r.id) ?? str(r.runId)
  if (!id) return null

  const completedAt = str(r.completed_at)
  const status = toStatus(r.status, !!completedAt)
  const counts = record(r.counts)
  const stats = object(r.stats)
  const jobsRaw = object(r.jobs) ?? {}
  const verification = record(stats?.verification)

  const inserted = num(jobsRaw.inserted ?? counts.inserted ?? counts.saved ?? stats?.jobs_inserted)
  const verifiedOpen = num(jobsRaw.verified_open ?? counts.verified_open ?? verification.VERIFIED_OPEN)
  const likelyOpen = num(jobsRaw.likely_open ?? counts.likely_open ?? verification.LIKELY_OPEN)
  const closed = num(jobsRaw.closed ?? counts.closed ?? verification.CLOSED)
  const touched = Math.max(num(jobsRaw.total ?? counts.jobs ?? inserted), inserted)
  const jobs: RunJobCounts = {
    total: touched,
    inserted,
    verified_open: verifiedOpen,
    likely_open: likelyOpen,
    closed,
    // Only when the endpoint did not count it: what is left after every status
    // it did report, so the parts never exceed the whole.
    unverified: num(jobsRaw.unverified ?? counts.unverified ?? Math.max(0, touched - verifiedOpen - likelyOpen - closed)),
    ranked: num(jobsRaw.ranked ?? counts.ranked ?? stats?.jobs_ranked),
  }

  return {
    id,
    kind: str(r.kind),
    status,
    stage: str(r.stage),
    detail: str(r.detail),
    counts,
    events: toEvents(r.events),
    started_at: str(r.started_at),
    heartbeat_at: str(r.heartbeat_at),
    completed_at: completedAt,
    stats,
    error: str(r.error),
    error_code: str(r.error_code)?.toUpperCase() ?? null,
    remedy: str(r.remedy),
    jobs,
    partial: r.partial === true || status === 'partial',
    stale: r.stale === true,
    invocation: Math.max(1, num(r.invocation ?? 1)),
    attempts: num(r.attempts),
    resumable: bool(r.resumable),
    cancel_requested: r.cancel_requested === true,
  }
}

// ─── What the queue did while we were polling ────────────────────────────────

export interface QueueActionView {
  action: string
  message: string | null
  attempt: number
  waitedMs: number
}

/** `queueActions` on the poll answer: what the watchdog did to this run on the way to answering. */
export function parseQueueActions(raw: unknown): QueueActionView[] {
  const list = object(raw)?.queueActions
  if (!Array.isArray(list)) return []
  return list
    .map((a) => {
      const o = object(a)
      const action = str(o?.action)
      return o && action ? { action, message: str(o.message), attempt: num(o.attempt), waitedMs: num(o.waitedMs) } : null
    })
    .filter((a): a is QueueActionView => !!a)
}

// ─── What POST /api/career/scout answered ────────────────────────────────────

export interface StartDispatch {
  /** 'accepted' | 'claimed_elsewhere' | 'pending' | 'failed' — what the worker request itself did. */
  outcome: string
  status: number | null
  error: string | null
  attempt: number
}

export interface StartOutcome {
  runId: string | null
  /** True when there is a durable run to poll. */
  queued: boolean
  /** True when the answer is a finished synchronous run (pre-016 database). */
  legacy: boolean
  /** What the answer itself said about durability. Never inferred — see durableOf. */
  durable: boolean | null
  /** 409: a run of this kind was already going, and `run` is it. The request's mode and spend were NOT applied. */
  alreadyActive: boolean
  run: RunDetail | null
  /** The worker request the enqueue made, as the 202 reported it. */
  dispatch: StartDispatch | null
  /** Which address the enqueue chose for its worker. */
  workerBase: { source: string; baseUrl: string } | null
  /** The worker had claimed the run before the 202 was written. */
  claimed: boolean
  claimInMs: number | null
}

export function parseStartResponse(body: unknown, httpStatus: number): StartOutcome {
  const b = object(body) ?? {}
  const run = parseRunDetail(b.run)
  const alreadyActive = httpStatus === 409 && (b.alreadyActive === true || !!run)
  const runId = (alreadyActive ? run?.id ?? null : null) ?? str(b.runId) ?? str(b.run_id) ?? run?.id ?? null
  const said = typeof b.status === 'string' ? b.status.toLowerCase() : ''
  const queued = !alreadyActive && !!runId && (httpStatus === 202 || said === 'queued' || said === 'running')
  const d = object(b.dispatch)
  const dispatch: StartDispatch | null = d && str(d.outcome) ? { outcome: str(d.outcome)!, status: typeof d.status === 'number' ? d.status : null, error: str(d.error), attempt: num(d.attempt) } : null
  const w = object(b.workerBase)
  const workerBase = w && (str(w.source) || str(w.baseUrl)) ? { source: str(w.source) ?? 'unknown', baseUrl: str(w.baseUrl) ?? '' } : null
  // A queued (or already-going) run is durable by definition: only the 016 path has one.
  return {
    runId,
    queued,
    legacy: !queued && !alreadyActive && httpStatus < 400,
    durable: queued || alreadyActive ? true : durableOf(body),
    alreadyActive,
    run,
    dispatch,
    workerBase,
    claimed: b.claimed === true,
    claimInMs: typeof b.claimInMs === 'number' && Number.isFinite(b.claimInMs) ? Math.max(0, Math.round(b.claimInMs)) : null,
  }
}

// ─── Is the run detached from this request? ──────────────────────────────────

/** What the server said about durability (`durable` on the runs list and the enqueue): true, false, or "it did not say". Never inferred. */
export function durableOf(body: unknown): boolean | null {
  return bool(object(body)?.durable)
}

/**
 * The id of a run the server itself calls queued or running.
 *
 * Only `active` is trusted, and only the words 'queued' and 'running' verbatim.
 * The list in `runs` carries a DERIVED display status — 'stalled' is that
 * route's word for a run it has decided is dead — and reading a run out of it
 * would resume a corpse, open the monitor on it and then lose contact.
 */
export function activeRunIdOf(body: unknown): string | null {
  const active = object(object(body)?.active)
  if (!active) return null
  const id = str(active.id) ?? str(active.runId)
  const status = typeof active.status === 'string' ? active.status.trim().toLowerCase() : ''
  if (!id || !isRunId(id)) return null
  return status === 'queued' || status === 'running' ? id : null
}

/**
 * A pre-016 database once answered POST /api/career/scout with the old
 * synchronous result. Read it as a finished run so the panel has one renderer
 * and one vocabulary — there is simply nothing to poll.
 */
export function legacyRunDetail(body: unknown): RunDetail | null {
  const b = object(body)
  if (!b) return null
  const stats = object(b.stats)
  const jobsArray = Array.isArray(b.jobs) ? (b.jobs as unknown[]) : []
  const errors = Array.isArray(b.errors) ? (b.errors as unknown[]).map((e) => str(e)).filter((e): e is string => !!e) : []
  const verification = record(stats?.verification)
  const inserted = num(stats?.jobs_inserted ?? jobsArray.length)
  const verifiedOpen = num(verification.VERIFIED_OPEN)
  const total = Math.max(jobsArray.length, inserted)
  const deadlineHit = stats?.deadline_hit === true
  const started = new Date(Date.now() - num(b.latencyMs)).toISOString()
  return {
    id: str(b.runId) ?? 'legacy',
    kind: 'job_scout',
    status: deadlineHit ? 'partial' : 'succeeded',
    stage: null,
    detail: null,
    counts: {},
    events: [],
    started_at: started,
    heartbeat_at: null,
    completed_at: new Date().toISOString(),
    stats,
    error: errors[0] ?? null,
    error_code: null,
    remedy: null,
    jobs: {
      total,
      inserted,
      verified_open: verifiedOpen,
      likely_open: num(verification.LIKELY_OPEN),
      closed: num(verification.CLOSED),
      unverified: Math.max(0, total - verifiedOpen - num(verification.LIKELY_OPEN) - num(verification.CLOSED)),
      ranked: num(stats?.jobs_ranked),
    },
    partial: deadlineHit,
    stale: false,
    invocation: 1,
    attempts: 0,
    resumable: null,
    cancel_requested: false,
  }
}

// ─── URLs ────────────────────────────────────────────────────────────────────

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** True when a run has an id the results view can query. */
export function isRunId(id: string | null | undefined): boolean {
  return !!id && RUN_ID.test(id)
}

/** The results view for one run — the same link from the panel, the Runs page and a partial failure. */
export function runResultsHref(runId: string): string {
  return `/dashboard/jobs?run=${encodeURIComponent(runId)}`
}

/** How many of a run's jobs the results view asks for at once. */
export const RUN_JOBS_LIMIT = 200

/** The jobs query for a run: every job it touched, with none of the inbox's curating defaults. */
export function runJobsQuery(runId: string, limit = RUN_JOBS_LIMIT): string {
  return new URLSearchParams({ run: runId, limit: String(limit) }).toString()
}

export function runDetailHref(runId: string): string {
  return `/api/career/scout/runs/${encodeURIComponent(runId)}`
}

export function runCancelHref(runId: string): string {
  return `${runDetailHref(runId)}/cancel`
}
