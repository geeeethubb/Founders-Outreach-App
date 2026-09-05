// Why a run stopped, whether it can go on, and whether one can start at all.
//
// Split out of run-copy.ts: that file turns a run into the numbers and
// headlines on screen; this one turns the SERVER'S verdicts — an error code
// on the row, a `resumable` flag from the persisted cursor, a readiness
// answer — into sentences the founder can act on. The rule everywhere is the
// same: prefer what the server judged over what the client could infer.
//
// Pure. No fetch, no React, no database.

import { discoveryReport, object, str, type RunDetail } from './run-view'

// ─── Why a run ended ─────────────────────────────────────────────────────────

/** The stable error codes (lib/runs/errors.ts) that have a plain-English sentence. */
const CODE_SENTENCES: Record<string, string> = {
  RUN_DEADLINE: 'It ran out of time before working through everything it planned, so the later strategies never ran.',
  PLATFORM_KILL: 'The hosting platform ended the worker well before its planned deadline — a lower function ceiling than assumed, or an out-of-memory kill.',
  DISPATCH: 'The app could not reach its own worker, so the run never started.',
  PROVIDER_TIMEOUT: 'A provider was too slow to answer inside the run’s clock.',
  PROVIDER_RATE_LIMIT: 'A provider rate-limited this account, so the run stopped starting new work.',
  CANCELLED: 'The run was cancelled.',
  SCHEMA_MIGRATION: 'The database is missing a migration the run needs.',
  CONFIGURATION: 'The deployment is missing configuration the run needs, so nothing paid was started.',
}

/** The sentence for an error code, or null for a code that has none. */
export function errorCodeSentence(code: string | null | undefined): string | null {
  return code ? CODE_SENTENCES[code.toUpperCase()] ?? null : null
}

export interface RunStopReason {
  /** The one sentence in the notice. */
  sentence: string
  /** The server's own error text, when the sentence came from a code and the text adds to it. */
  detail: string | null
  /** What to do about it — the row's remedy, on its own line. */
  remedy: string | null
  code: string | null
}

/**
 * Why a run ended early, in words the founder can act on.
 *
 * Server truth first: a stable `error_code` maps to a sentence, and the row's
 * `remedy` is shown with it. Only a run that recorded no code falls back to
 * its error text, its stats and its staleness — the client-side guesses that
 * used to be the whole answer.
 */
export function runStopReason(run: RunDetail): RunStopReason | null {
  if (!run.partial && run.status !== 'partial' && run.status !== 'failed' && run.status !== 'cancelled') return null
  const code = run.error_code
  const fromCode = errorCodeSentence(code)
  const remedy = run.remedy
  if (fromCode) return { sentence: fromCode, detail: run.error && run.error !== fromCode ? run.error : null, remedy, code }
  if (run.error) return { sentence: run.error, detail: null, remedy, code }
  if (code) return { sentence: `The run stopped with ${code}.`, detail: null, remedy, code }
  if (run.stats?.deadline_hit === true) return { sentence: CODE_SENTENCES.RUN_DEADLINE, detail: null, remedy, code: null }
  if (run.stale) return { sentence: 'The run stopped reporting progress and was closed out at what it had already stored.', detail: null, remedy, code: null }
  if (run.status === 'cancelled') return { sentence: CODE_SENTENCES.CANCELLED, detail: null, remedy, code: null }
  return { sentence: 'Some stages did not finish. Everything it did store is shown in this run’s results.', detail: null, remedy, code: null }
}

/** The sentence alone — what the run results view and the tests read. */
export function partialReason(run: RunDetail): string | null {
  return runStopReason(run)?.sentence ?? null
}

// ─── Can it go on? ───────────────────────────────────────────────────────────

export interface RunContinuation {
  /** There is work left and a later pass would not redo what is done. */
  canContinue: boolean
  /** 'complete' | 'deadline' | 'budget' | 'saturated', or null on a run that predates the report. */
  stopped: string | null
  /** One line for the button's neighbour: why continuing is worth a click. */
  note: string | null
}

const STOPPED_NOTES: Record<string, string> = {
  budget: 'It stopped at its spend limit. Continuing picks up where it stopped — raise the limit to go further.',
  deadline: 'It ran out of time. Continuing picks up at the strategies and companies it never reached.',
}

/**
 * Can this run be picked up where it stopped?
 *
 * The server says: `resumable` is its reading of the persisted cursor —
 * neither empty nor finished — and that is what the button follows. A run
 * the server called resumable is offered even when its stats never recorded
 * why it stopped (a reaped run has no report). A finished run is never
 * offered a second pass. Only when the server did not say (an older endpoint,
 * or a fixture without the flag) does the run's own discovery report decide,
 * the way it did before the flag existed.
 */
export function runContinuation(run: RunDetail): RunContinuation {
  const d = discoveryReport(run.stats)
  const stopped = typeof d?.stopped === 'string' ? d.stopped : null
  const note = stopped && STOPPED_NOTES[stopped] ? STOPPED_NOTES[stopped] : null
  if (run.resumable === true) {
    if (run.status === 'succeeded') return { canContinue: false, stopped, note: null }
    return { canContinue: true, stopped, note: note ?? 'It stopped before finishing; continuing picks up from what it saved.' }
  }
  if (run.resumable === false) return { canContinue: false, stopped, note: null }
  const cursor = object(d?.cursor)
  const stages = Array.isArray(cursor?.stages) ? (cursor!.stages as unknown[]).filter((s): s is string => typeof s === 'string') : []
  if (!stopped || stages.includes('done') || !note) return { canContinue: false, stopped, note: null }
  return { canContinue: true, stopped, note }
}

// ─── Losing contact with the poll ────────────────────────────────────────────

export interface PollVerdict {
  /** Stop polling: nothing a later poll could change. */
  stop: boolean
  /** What to tell the founder, or null when one miss is not worth a sentence. */
  message: string | null
  /** When to ask again, if at all. */
  nextMs: number
}

/**
 * What one failed poll means, given how many failed before it. A 401 or a 404
 * will not change by asking again; anything else is tolerated up to the
 * shared miss count and then reported — while the poll keeps going, slower,
 * because the run itself is still going on the server.
 */
export function pollVerdict(input: { status: number; failures: number; error: string | null; maxFailures: number; pollMs: number; lostContactPollMs: number }): PollVerdict {
  if (input.status === 401 || input.status === 403) return { stop: true, message: 'You are signed out. Sign in again — the run keeps going on the server.', nextMs: 0 }
  if (input.status === 404) return { stop: true, message: 'The server has no such run. It may have been deleted, or the link belongs to another account.', nextMs: 0 }
  if (input.failures >= input.maxFailures) {
    return { stop: false, message: `Lost contact (${input.error ?? 'no answer'}). The run keeps going on the server; reload to pick it up.`, nextMs: input.lostContactPollMs }
  }
  return { stop: false, message: null, nextMs: input.pollMs }
}

// ─── Can a run start here at all? ────────────────────────────────────────────

export interface ReadinessVerdict {
  /** The server answered for this kind. False means the body was not a readiness answer. */
  known: boolean
  /** null when unknown. */
  ready: boolean | null
  reason: string | null
  remedy: string | null
  code: string | null
  warnings: string[]
  worker: { source: string; baseUrl: string } | null
}

/** GET /api/scout/readiness for one scout kind, read defensively. */
export function parseReadiness(body: unknown, kind: 'jobs' | 'people' = 'jobs'): ReadinessVerdict {
  const b = object(body)
  const k = object(b?.[kind])
  const w = object(b?.worker)
  const worker = w && str(w.source) ? { source: str(w.source)!, baseUrl: str(w.baseUrl) ?? '' } : null
  if (!k || typeof k.ready !== 'boolean') return { known: false, ready: null, reason: null, remedy: null, code: null, warnings: [], worker }
  const warnings = Array.isArray(k.warnings) ? (k.warnings as unknown[]).map((x) => str(x)).filter((x): x is string => !!x) : []
  return { known: true, ready: k.ready, reason: str(k.reason), remedy: str(k.remedy), code: str(k.code), warnings, worker }
}

/** The one line a blocked page shows: "Scouting is unavailable: <reason> — Fix: <remedy>". Null when not blocked. */
export function readinessBlockLine(v: ReadinessVerdict): string | null {
  if (v.ready !== false) return null
  const reason = v.reason ?? 'the server refused to start a run'
  return v.remedy ? `Scouting is unavailable: ${reason} — Fix: ${v.remedy}` : `Scouting is unavailable: ${reason}`
}
