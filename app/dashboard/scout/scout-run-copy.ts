// What a People Scout run says to the founder — the words and numbers on
// screen. The parsing half is scout-run-view.ts; this turns a parsed run into
// the headline, the queued line, the event lines, the spend, and the notice a
// finished run shows.
//
// Every sentence here is about something the server reported. Nothing
// estimates progress; the only clock is the one that says "waiting 42s".
//
// Pure. No fetch, no React, no storage.

import type { PeopleScoutResult } from '@/lib/scouting/checkpoint'
import { isActive, type RunEvent, type ScoutRun } from './scout-run-view'

export function relativeTime(at: string | number | null | undefined, now: number = Date.now()): string {
  const t = typeof at === 'number' ? at : at ? Date.parse(at) : NaN
  if (!Number.isFinite(t)) return 'an unknown time ago'
  const mins = Math.max(0, Math.round((now - t) / 60_000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

/** Elapsed wall clock for a run, from its own timestamps. */
export function runElapsed(run: ScoutRun, now: number = Date.now()): string {
  const start = run.started_at ? Date.parse(run.started_at) : NaN
  if (!Number.isFinite(start)) return '—'
  const end = run.completed_at ? Date.parse(run.completed_at) : NaN
  return formatDuration((Number.isFinite(end) ? end : now) - start)
}

/** Spend so far: the row's stats first (written every leg), else the result payload. */
export function costSoFar(run: ScoutRun | null, result: PeopleScoutResult | null): number | null {
  const fromStats = run?.stats ? Number(run.stats.cost_usd) : NaN
  if (Number.isFinite(fromStats)) return fromStats
  if (result && Number.isFinite(result.usage.costUsd)) return result.usage.costUsd
  return null
}

export function runHeadline(run: ScoutRun, prospects: number | null): string {
  switch (run.status) {
    case 'queued':
      // The row's detail carries the dispatch's own account ("asked a worker", "retry 2 could not reach …").
      return run.detail ? `Queued — ${run.detail}` : 'Queued — waiting for the worker to pick it up'
    case 'running':
      return run.stage ? `Running · ${run.stage.replace(/_/g, ' ')}` : 'Running'
    case 'succeeded':
      return prospects === null ? 'Completed' : `Completed · ${prospects} prospect${prospects === 1 ? '' : 's'}`
    case 'partial':
      return 'Partial run — stopped before it finished'
    case 'failed':
      return 'Failed'
    case 'cancelled':
      return 'Cancelled'
  }
}

/** The queued line: dispatch attempts and how long it has waited. */
export function queuedLine(run: ScoutRun, now: number = Date.now()): string {
  const start = run.started_at ? Date.parse(run.started_at) : NaN
  const waited = Number.isFinite(start) ? formatDuration(now - start) : null
  const attempts = run.attempts > 0 ? `dispatch attempt ${run.attempts}` : 'not dispatched yet'
  return waited ? `${attempts} · waiting ${waited}` : attempts
}

export function eventLine(e: RunEvent): string {
  const stage = e.stage ? e.stage.replace(/_/g, ' ') : null
  if (stage && e.detail) return `${stage} — ${e.detail}`
  return e.detail ?? stage ?? ''
}

export function recentEvents(run: ScoutRun, limit = 6): RunEvent[] {
  return run.events.slice(-Math.max(1, limit))
}

const COUNT_ORDER = ['companies', 'people', 'researched', 'ranked']

/** The run's live counts, known keys first, in a fixed order. */
export function countPairs(counts: Record<string, number>): [string, number][] {
  const known = COUNT_ORDER.filter((k) => k in counts).map((k): [string, number] => [k, counts[k]])
  const rest = Object.keys(counts)
    .filter((k) => !COUNT_ORDER.includes(k))
    .sort()
    .map((k): [string, number] => [k, counts[k]])
  return [...known, ...rest]
}

/** Seconds since the last heartbeat, or null when the run never reported one. */
export function secondsSinceHeartbeat(run: ScoutRun, now: number = Date.now()): number | null {
  const t = run.heartbeat_at ? Date.parse(run.heartbeat_at) : NaN
  if (!Number.isFinite(t)) return null
  return Math.max(0, Math.round((now - t) / 1000))
}

/** A warning to show while a run is active but the server itself calls it quiet. */
export function stalenessNote(run: ScoutRun, now: number = Date.now()): string | null {
  if (!isActive(run.status) || !run.stale) return null
  const since = secondsSinceHeartbeat(run, now)
  return since === null
    ? 'This run has not reported any progress yet. The watchdog closes it if it never does.'
    : `No progress reported for ${since < 120 ? `${since}s` : `${Math.floor(since / 60)}m`}. If the worker died, the watchdog closes the run and keeps what it found.`
}

export interface TerminalNotice {
  kind: 'ok' | 'warn' | 'error' | 'info'
  title: string
  lines: string[]
}

/** The notice for a finished run. Null while it is active, and for a clean success (the results speak). */
export function terminalNotice(run: ScoutRun): TerminalNotice | null {
  const code = run.error_code ? ` [${run.error_code}]` : ''
  switch (run.status) {
    case 'partial':
      return {
        kind: 'warn',
        title: `Partial run — ${run.error ?? 'the run stopped before it finished'}${code}`,
        lines: [run.remedy ?? 'Everything it found is shown below; the prospects it ranked are real, the list is just shorter than planned.'],
      }
    case 'failed':
      return {
        kind: 'error',
        title: `Failed — ${run.error ?? 'the run stopped without saying why'}${code}`,
        lines: run.remedy ? [run.remedy] : [],
      }
    case 'cancelled':
      return { kind: 'info', title: 'Cancelled — the run stopped at your request.', lines: run.error && run.error !== 'cancelled' ? [run.error] : [] }
    default:
      return null
  }
}
