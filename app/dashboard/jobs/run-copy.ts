// What a run says to the founder — the words and the numbers on screen.
//
// The other half of the run monitor: `run-view.ts` turns whatever the endpoint
// answered into a `RunDetail`, and this file turns a `RunDetail` into the
// sentences and counts the Scout panel, the run results view and the Runs page
// render. Why a run stopped, whether it can continue and whether one can start
// live in run-reasons.ts (re-exported here so older imports keep working).
//
// Every sentence here is about something the server actually reported. Nothing
// estimates progress, nothing counts down, and nothing tells the founder a run
// is safe to walk away from unless the server said it is.
//
// Pure. No fetch, no React, no database.

import { discoveryReport, isActive, toCount, toCounts, type QueueActionView, type RunDetail, type RunEvent, type RunStatus, type StartDispatch } from './run-view'

export { partialReason, runContinuation, runStopReason, type RunContinuation, type RunStopReason } from './run-reasons'

// ─── Numbers the founder actually reads ──────────────────────────────────────

export interface RunSummary {
  discovered: number
  saved: number
  verified: number
  /** A careers page said the role is probably still open — short of a board listing it. */
  likely: number
  unverified: number
  ranked: number
  rejected: number
}

function sum(counts: Record<string, number>): number {
  return Object.values(counts).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0)
}

/** The funnel, preferring what the server counted and falling back to the run's stats. */
export function runSummary(run: RunDetail): RunSummary {
  const s = run.stats ?? {}
  const discovered = toCount(run.counts.discovered ?? s.postings_seen ?? run.jobs.total)
  return {
    discovered: Math.max(discovered, run.jobs.total),
    saved: run.jobs.inserted,
    verified: run.jobs.verified_open,
    likely: run.jobs.likely_open,
    unverified: run.jobs.unverified,
    ranked: run.jobs.ranked,
    rejected: toCount(run.counts.rejected ?? sum(toCounts(s.jobs_rejected))),
  }
}

const STATUS_TITLE: Record<RunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Scout completed',
  partial: 'Partial run',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

export function statusTitle(status: RunStatus): string {
  return STATUS_TITLE[status]
}

/** The one line at the top of the monitor and of the run results view. */
export function runHeadline(run: RunDetail): string {
  const c = runSummary(run)
  switch (run.status) {
    case 'queued':
      // The row's detail carries the dispatch's own account ("asked a worker",
      // "retry 2 could not reach a worker: …") — say that, not a generic wait.
      return run.detail ? `Queued — ${run.detail}` : 'Queued — waiting for the worker to pick it up'
    case 'running':
      return run.stage ? `Running · ${run.stage}` : 'Running'
    case 'succeeded':
      return `Scout completed · ${c.discovered} discovered · ${c.saved} saved · ${c.verified} verified open · ${c.ranked} ranked`
    case 'partial':
      return `Partial run — ${c.saved} job${c.saved === 1 ? '' : 's'} saved, ${c.verified} verified`
    case 'failed':
      return `Failed — ${run.error ?? 'the run stopped before it finished'}`
    case 'cancelled':
      return 'Cancelled — nothing further was searched'
  }
}

/** "pass 2" when a run is on a later leg; null on a first pass. */
export function runPassLine(run: RunDetail): string | null {
  return run.invocation > 1 ? `pass ${run.invocation}` : null
}

/** How many times a worker has been asked to start the leg — shown only while the run is still queued. */
export function queueAttemptsLine(run: RunDetail): string | null {
  if (run.status !== 'queued' || run.attempts < 1) return null
  return run.attempts === 1 ? 'worker asked once' : `worker asked ${run.attempts} times`
}

/** One event line for something the watchdog did to the run on the way to answering a poll. */
export function queueActionLine(a: QueueActionView): string {
  const attempt = a.attempt > 0 ? ` (attempt ${a.attempt})` : ''
  switch (a.action) {
    case 'redispatched':
      return `asking a worker again${attempt}${a.message && /could not reach/.test(a.message) ? `: ${a.message}` : ''}`
    case 'failed':
      return `closed as failed${attempt}: ${a.message ?? 'no reason given'}`
    case 'reaped':
      return `closed by the watchdog: ${a.message ?? 'the worker stopped renewing its lease'}`
    case 'cancelled':
      return `cancelled: ${a.message ?? 'as requested'}`
    default:
      return a.message ? `${a.action}: ${a.message}` : a.action
  }
}

/**
 * What the enqueue said about its worker request. Only a failure is worth a
 * sentence — 'pending' is the normal case (the worker answers at the end of
 * its leg) and 'accepted' is already visible as a running run.
 */
export function dispatchNote(d: StartDispatch | null): string | null {
  if (!d || d.outcome !== 'failed') return null
  const status = d.status ? ` (HTTP ${d.status})` : ''
  return `The worker could not be reached${status}: ${d.error ?? 'no reason given'}. Attempt ${Math.max(1, d.attempt)}; the queue keeps trying.`
}

/** A small note naming which address the enqueue dispatched to. */
export function workerSourceLine(w: { source: string; baseUrl: string } | null): string | null {
  if (!w) return null
  return w.baseUrl ? `worker: ${w.source} → ${w.baseUrl}` : `worker: ${w.source}`
}

/** The last few progress lines, newest last, as the monitor shows them. */
export function recentEvents(run: RunDetail, limit = 4): RunEvent[] {
  return run.events.slice(-Math.max(1, limit))
}

/** A short label for one progress line. */
export function eventLine(event: RunEvent): string {
  const stage = event.stage ? event.stage.replace(/_/g, ' ') : null
  if (stage && event.detail) return `${stage} — ${event.detail}`
  return event.detail ?? stage ?? ''
}

/** Elapsed wall clock for a run, from its own timestamps. `now` is injectable so this stays testable. */
export function runDuration(run: RunDetail, now: number = Date.now()): string {
  const start = run.started_at ? Date.parse(run.started_at) : NaN
  if (!Number.isFinite(start)) return '—'
  const end = run.completed_at ? Date.parse(run.completed_at) : now
  const s = Math.max(0, Math.round(((Number.isFinite(end) ? end : now) - start) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

/** Seconds since the last heartbeat, or null when the run never reported one. */
export function secondsSinceHeartbeat(run: RunDetail, now: number = Date.now()): number | null {
  const t = run.heartbeat_at ? Date.parse(run.heartbeat_at) : NaN
  if (!Number.isFinite(t)) return null
  return Math.max(0, Math.round((now - t) / 1000))
}

/** A warning to show while a run is still active but has gone quiet. */
export function stalenessNote(run: RunDetail, now: number = Date.now()): string | null {
  if (!isActive(run.status)) return null
  const since = secondsSinceHeartbeat(run, now)
  if (!run.stale && (since === null || since < 120)) return null
  return since === null
    ? 'This run has not reported any progress yet.'
    : `No progress reported for ${since < 120 ? `${since}s` : `${Math.floor(since / 60)}m`}. It may have stopped; anything it stored is still in its results.`
}

/** Compact, guarded stats lines. Never assumes a key exists — a partial run's stats blob is partial. */
export function statsLines(stats: Record<string, unknown> | null): string[] {
  if (!stats) return []
  const n = (k: string) => toCount(stats[k])
  const hist = (value: unknown) => {
    const entries = Object.entries(toCounts(value)).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
    return entries.length ? entries.map(([k, v]) => `${k} ${v}`).join(', ') : 'none'
  }
  const lines = [
    `companies checked: ${n('companies_checked')} (${n('companies_with_openings')} with openings)`,
    `postings seen: ${n('postings_seen')} · resolved: ${n('postings_resolved')} · sources: ${hist(stats.sources_consulted)}`,
    `extracted: ${n('jobs_extracted')} · rejected: ${sum(toCounts(stats.jobs_rejected))} (${hist(stats.jobs_rejected)})`,
    `verification: ${hist(stats.verification)}`,
    `persisted: ${n('jobs_inserted')} new, ${n('jobs_updated')} updated · ranked: ${n('jobs_ranked')}`,
  ]
  const cost = typeof stats.cost_usd === 'number' ? stats.cost_usd : null
  if (cost !== null) lines.push(`cost: $${cost.toFixed(4)}${stats.deadline_hit === true ? ' · deadline hit' : ''}`)
  // What THIS workstream measures: how big the run was allowed to be, which
  // lane found the jobs, what it spent against its ceiling and why it stopped.
  // Without these a run that ran out of money is indistinguishable on screen
  // from one that swept the market.
  for (const note of discoveryNotes(stats)) lines.push(note)
  return lines
}

/** The run's own report lines — budget, lanes, yield, spend, stopping reason. */
export function discoveryNotes(stats: Record<string, unknown> | null | undefined): string[] {
  const notes = discoveryReport(stats)?.notes
  return Array.isArray(notes) ? notes.filter((n): n is string => typeof n === 'string').slice(0, 8) : []
}

// ─── Is the run detached from this request? ──────────────────────────────────

/**
 * The one sentence about closing the tab. Three answers, none of them a guess:
 * the server said durable, the server said not, or the server has not answered
 * yet — and "not answered yet" is said as exactly that. It used to be worded
 * like the pre-016 answer, which told a founder on a migrated database that
 * migration 016 was missing every time the page loaded a beat before the
 * environment call came back.
 */
export function tabSafetyLine(durable: boolean | null | undefined): string {
  if (durable === true) return 'The run happens on the server — you can close this tab.'
  if (durable === false) return 'This run happens inside this request, so keep the tab open until it finishes. (Applying migration 016 moves it onto the server.)'
  return 'Checking whether runs survive this request…'
}

/**
 * The line above one run's job list. A run can touch more jobs than a page
 * shows, and the header counts every one of them — so when the list is shorter
 * it says so rather than letting two numbers on the same screen contradict each
 * other.
 */
export function runJobsCountLine(shown: number, touched: number): string {
  const noun = (n: number) => `${n} job${n === 1 ? '' : 's'}`
  if (touched > shown) return `Showing ${shown} of ${noun(touched)} this run touched — best fit first`
  return `${noun(shown)} from this run`
}
