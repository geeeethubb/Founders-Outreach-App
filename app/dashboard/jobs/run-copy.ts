// What a run says to the founder — the words and the numbers on screen.
//
// The other half of the run monitor: `run-view.ts` turns whatever the endpoint
// answered into a `RunDetail`, and this file turns a `RunDetail` into the
// sentences and counts the Scout panel, the run results view and the Runs page
// render. Split from it only because one file holding both had grown past the
// size this repo keeps files to; the boundary is parsing vs. presentation.
//
// Every sentence here is about something the server actually reported. Nothing
// estimates progress, nothing counts down, and nothing tells the founder a run
// is safe to walk away from unless the server said it is.
//
// Pure. No fetch, no React, no database.

import { isActive, toCount, toCounts, type RunDetail, type RunEvent, type RunStatus } from './run-view'

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
      return 'Queued — waiting for the worker to pick it up'
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

/**
 * Why a run ended early, in words the founder can act on. Never "whatever it
 * stored is already in the list": the run's own results view is one click away.
 */
export function partialReason(run: RunDetail): string | null {
  if (!run.partial && run.status !== 'partial' && run.status !== 'failed' && run.status !== 'cancelled') return null
  if (run.error) return run.error
  if (run.stats?.deadline_hit === true) return 'It ran out of time before working through everything it planned, so the later strategies never ran.'
  if (run.stale) return 'The run stopped reporting progress and was closed out at what it had already stored.'
  if (run.status === 'cancelled') return 'The run was cancelled.'
  return 'Some stages did not finish. Everything it did store is shown in this run’s results.'
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

// ─── The discovery report ────────────────────────────────────────────────────

/** `stats.discovery`, as the orchestrator writes it, or null. */
function discovery(stats: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  const d = stats?.discovery
  return d && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : null
}

/** The run's own report lines — budget, lanes, yield, spend, stopping reason. */
export function discoveryNotes(stats: Record<string, unknown> | null | undefined): string[] {
  const notes = discovery(stats)?.notes
  return Array.isArray(notes) ? notes.filter((n): n is string => typeof n === 'string').slice(0, 8) : []
}

export interface RunContinuation {
  /** There is work left and a later pass would not redo what is done. */
  canContinue: boolean
  /** 'complete' | 'deadline' | 'budget' | 'saturated', or null on a run that predates the report. */
  stopped: string | null
  /** One line for the button's neighbour: why continuing is worth a click. */
  note: string | null
}

/**
 * Can this run be picked up where it stopped?
 *
 * Only when the run's own report says it stopped short AND its cursor is not
 * marked done. A saturated run is finished — the sources had nothing new left
 * — and offering to continue it would sell a second pass over an exhausted
 * market. A run with no report at all (pre-modes, or a legacy CLI run) is not
 * continuable: there is nothing to continue FROM, and starting one that
 * silently re-ran everything at full price is the failure this replaces.
 */
export function runContinuation(run: RunDetail): RunContinuation {
  const d = discovery(run.stats)
  const stopped = typeof d?.stopped === 'string' ? d.stopped : null
  const cursor = d?.cursor && typeof d.cursor === 'object' ? (d.cursor as Record<string, unknown>) : null
  const stages = Array.isArray(cursor?.stages) ? (cursor?.stages as unknown[]).filter((s): s is string => typeof s === 'string') : []
  if (!stopped || stages.includes('done')) return { canContinue: false, stopped, note: null }
  if (stopped === 'budget') {
    return { canContinue: true, stopped, note: 'It stopped at its spend limit. Continuing picks up where it stopped — raise the limit to go further.' }
  }
  if (stopped === 'deadline') {
    return { canContinue: true, stopped, note: 'It ran out of time. Continuing picks up at the strategies and companies it never reached.' }
  }
  return { canContinue: false, stopped, note: null }
}

// ─── Is the run detached from this request? ──────────────────────────────────

/**
 * The one sentence about closing the tab. An unknown answer is worded like the
 * pre-016 one, because the expensive mistake is telling the founder a run
 * survives a closed tab when it is executing inside the request that started it
 * and its model calls are already paid for.
 */
export function tabSafetyLine(durable: boolean | null | undefined): string {
  return durable === true
    ? 'The run happens on the server — you can close this tab.'
    : 'This run happens inside this request, so keep the tab open until it finishes. (Applying migration 016 moves it onto the server.)'
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
