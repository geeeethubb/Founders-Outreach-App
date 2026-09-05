// Reading a durable People Scout run — the parsing half of the Scout page.
//
// POST /api/scout queues a run and answers a `runId`; everything the page
// shows afterwards comes from GET /api/scout/runs/[id] (a ScoutRunView, with
// the PeopleScoutResult payload when `?result=1`). This module never invents
// progress: it normalizes what the server said, decides when a poll should ask
// for the (large) result payload, and turns a poll failure into the sentence
// the page shows. The result payload itself is read in scout-result-view.ts;
// the words on screen live in scout-run-copy.ts. Every shape the endpoints can
// answer is a fixture in scripts/test-scout-page-view.ts.
//
// Pure. No fetch, no React, no storage.

import type { PeopleScoutResult } from '@/lib/scouting/checkpoint'
import { num, object, parseScoutResult, str, strings, toCounts } from './scout-result-view'

export const RUN_STATUSES = ['queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled'] as const
export type ScoutRunStatus = (typeof RUN_STATUSES)[number]
export const TERMINAL_STATUSES: ScoutRunStatus[] = ['succeeded', 'partial', 'failed', 'cancelled']

/** How often the page asks the server what is happening. */
export const POLL_MS = 3_000
/** The cadence after contact is lost: keep asking, just less often. */
export const SLOW_POLL_MS = 10_000
/** Consecutive failed polls tolerated before the page says it lost contact. */
export const MAX_POLL_FAILURES = 5
/** Every Nth poll asks for the result payload while the run is active. */
export const RESULT_EVERY_N_POLLS = 4

export interface RunEvent {
  at: string | null
  stage: string | null
  detail: string | null
}

export interface ScoutRun {
  id: string
  status: ScoutRunStatus
  stage: string | null
  detail: string | null
  counts: Record<string, number>
  events: RunEvent[]
  label: string | null
  started_at: string | null
  heartbeat_at: string | null
  completed_at: string | null
  deadline_at: string | null
  run_deadline_at: string | null
  stats: Record<string, unknown> | null
  error: string | null
  error_code: string | null
  remedy: string | null
  partial: boolean
  stale: boolean
  /** Which leg of the run is (or was) executing. 1 on a first pass. */
  invocation: number
  /** Dispatch attempts for the current leg. */
  attempts: number
  cancel_requested: boolean
  /** Present only when the poll asked for it and the run has written one. */
  result: PeopleScoutResult | null
}

export function isTerminal(status: ScoutRunStatus | null | undefined): boolean {
  return !!status && TERMINAL_STATUSES.includes(status)
}

export function isActive(status: ScoutRunStatus | null | undefined): boolean {
  return status === 'queued' || status === 'running'
}

function toStatus(value: unknown, completed: boolean): ScoutRunStatus {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if ((RUN_STATUSES as readonly string[]).includes(s)) return s as ScoutRunStatus
  // Never guess success: an unknown finished status is a failure to explain, an unfinished one is still going.
  return completed ? 'failed' : 'running'
}

function toEvents(value: unknown): RunEvent[] {
  if (!Array.isArray(value)) return []
  return value
    .map((e): RunEvent | null => {
      const o = object(e)
      if (!o) return typeof e === 'string' ? { at: null, stage: null, detail: e } : null
      return { at: str(o.at), stage: str(o.stage), detail: str(o.detail) }
    })
    .filter((e): e is RunEvent => !!e && (!!e.detail || !!e.stage))
}

// ─── The run ─────────────────────────────────────────────────────────────────

/**
 * The run as the page needs it, from whatever the endpoint answered — a bare
 * ScoutRunView or one wrapped in `{ run, queueActions }`. Null only when there
 * is no id to poll.
 */
export function parseRunDetail(raw: unknown): ScoutRun | null {
  const top = object(raw)
  if (!top) return null
  const r = object(top.run) ?? top
  const id = str(r.id) ?? str(r.runId)
  if (!id) return null
  const completedAt = str(r.completed_at)
  const status = toStatus(r.status, !!completedAt)
  return {
    id,
    status,
    stage: str(r.stage),
    detail: str(r.detail),
    counts: toCounts(r.counts),
    events: toEvents(r.events),
    label: str(r.label),
    started_at: str(r.started_at),
    heartbeat_at: str(r.heartbeat_at),
    completed_at: completedAt,
    deadline_at: str(r.deadline_at),
    run_deadline_at: str(r.run_deadline_at),
    stats: object(r.stats),
    error: str(r.error),
    error_code: str(r.error_code),
    remedy: str(r.remedy),
    partial: r.partial === true || status === 'partial',
    stale: r.stale === true,
    invocation: Math.max(1, Math.round(num(r.invocation, 1))),
    attempts: Math.max(0, Math.round(num(r.attempts, 0))),
    cancel_requested: r.cancel_requested === true,
    result: parseScoutResult(r.result),
  }
}

/** GET /api/scout/runs?active=1&limit=1 → the run to attach to, and the newest run of any status. */
export function parseRunsList(raw: unknown): { active: ScoutRun | null; last: ScoutRun | null } {
  const b = object(raw)
  const active = parseRunDetail(b?.active)
  const runs = Array.isArray(b?.runs) ? b!.runs : []
  const last = runs.length ? parseRunDetail(runs[0]) : null
  return { active: active && isActive(active.status) ? active : null, last }
}

export type StartOutcome =
  | { kind: 'started'; runId: string; status: ScoutRunStatus }
  | { kind: 'conflict'; runId: string; run: ScoutRun | null }
  | { kind: 'error'; message: string }

/** What POST /api/scout answered: 202 started, 409 a run already going, anything else an error. */
export function parseStartResponse(httpStatus: number, body: unknown): StartOutcome {
  const b = object(body) ?? {}
  const runId = str(b.runId) ?? str(object(b.run)?.id)
  if (httpStatus === 409 && runId && (b.code === 'CONFLICT' || b.alreadyActive === true)) {
    return { kind: 'conflict', runId, run: parseRunDetail(b.run) }
  }
  if (httpStatus === 202 && runId) return { kind: 'started', runId, status: toStatus(b.status, false) }
  return { kind: 'error', message: str(b.error) ?? `The scout could not be started (HTTP ${httpStatus}).` }
}

// ─── Polling decisions ───────────────────────────────────────────────────────

/**
 * Should the Nth poll (1-based) ask for `?result=1`? Always once the run is
 * known to be terminal; otherwise every Nth poll, so a run that stops short
 * already shows what it found without shipping the payload on every tick.
 */
export function shouldRequestResult(pollIndex: number, knownStatus: ScoutRunStatus | null): boolean {
  if (isTerminal(knownStatus)) return true
  return pollIndex > 0 && pollIndex % RESULT_EVERY_N_POLLS === 0
}

/** The delay before the next poll, given how many polls in a row have failed. */
export function nextPollDelayMs(consecutiveFailures: number): number {
  return consecutiveFailures >= MAX_POLL_FAILURES ? SLOW_POLL_MS : POLL_MS
}

export interface PollFailure {
  /** Stop polling for good — the answer cannot change by asking again. */
  stop: boolean
  /** Say something now, or only once the failure count reaches the tolerance. */
  immediate: boolean
  message: string
}

/** What a failed poll means for the page. 401 and 404 are final; everything else is "keep trying". */
export function describePollFailure(httpStatus: number, error: string | null): PollFailure {
  if (httpStatus === 401 || httpStatus === 403) {
    return { stop: true, immediate: true, message: 'You are signed out; sign in again — the run keeps going on the server.' }
  }
  if (httpStatus === 404) {
    return { stop: true, immediate: true, message: 'This run was not found on the server. Start a new scout.' }
  }
  return { stop: false, immediate: false, message: `Lost contact with the run (${error ?? 'no answer'}). It keeps going on the server; reloading picks it back up.` }
}

export function runDetailHref(runId: string, withResult: boolean): string {
  return `/api/scout/runs/${encodeURIComponent(runId)}${withResult ? '?result=1' : ''}`
}

export function runCancelHref(runId: string): string {
  return `/api/scout/runs/${encodeURIComponent(runId)}/cancel`
}

// ─── Readiness ───────────────────────────────────────────────────────────────

export interface PeopleReadiness {
  ready: boolean
  reason: string | null
  remedy: string | null
  code: string | null
  warnings: string[]
  checkedAt: string | null
}

/** GET /api/scout/readiness → the People Scout's verdict. Null when the answer is not a readiness payload. */
export function parsePeopleReadiness(raw: unknown): PeopleReadiness | null {
  const b = object(raw)
  const people = object(b?.people)
  if (!b || !people || typeof people.ready !== 'boolean') return null
  return {
    ready: people.ready,
    reason: str(people.reason),
    remedy: str(people.remedy),
    code: str(people.code),
    warnings: strings(people.warnings),
    checkedAt: str(b.checkedAt),
  }
}

// ─── Form preferences (the only thing the browser keeps) ─────────────────────

export interface ScoutFormPrefs {
  goal: string
  geography: string
  segments: number
  depth: number
  searchMode: string
  campaignId: string
}

export const SEARCH_MODE_VALUES = ['internal_first', 'internal_only', 'both', 'external_only'] as const

/** Parse a stored preferences blob; anything malformed falls back to the defaults given. */
export function parseFormPrefs(raw: string | null | undefined, defaults: ScoutFormPrefs): ScoutFormPrefs {
  if (!raw) return defaults
  let o: Record<string, unknown> | null
  try {
    o = object(JSON.parse(raw))
  } catch {
    return defaults
  }
  if (!o) return defaults
  const clamp = (v: unknown, min: number, max: number, fb: number) => {
    const n = Math.round(num(v, fb))
    return Math.max(min, Math.min(max, n))
  }
  return {
    goal: str(o.goal) ?? defaults.goal,
    geography: str(o.geography) ?? defaults.geography,
    segments: clamp(o.segments, 1, 3, defaults.segments),
    depth: clamp(o.depth, 2, 15, defaults.depth),
    searchMode: (SEARCH_MODE_VALUES as readonly string[]).includes(String(o.searchMode)) ? String(o.searchMode) : defaults.searchMode,
    campaignId: typeof o.campaignId === 'string' ? o.campaignId : defaults.campaignId,
  }
}
