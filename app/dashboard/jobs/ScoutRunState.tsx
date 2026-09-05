'use client'

// One run, in the state it is in right now — the half of the Jobs scout panel
// that renders what the server said about a run: status, headline, the last
// events and queue actions, the dispatch report from the 202, the terminal
// reason with its remedy, results link, continuation, and the stage log.
// Nothing here fetches; ScoutPanel.tsx owns the polling and hands the run in.

import Link from 'next/link'
import InlineNotice from '@/components/career/InlineNotice'
import { isActive, isRunId, isTerminal, runResultsHref, type RunDetail, type StartOutcome } from './run-view'
import { dispatchNote, eventLine, queueAttemptsLine, recentEvents, runDuration, runHeadline, runPassLine, runSummary, stalenessNote, statsLines, workerSourceLine } from './run-copy'
import { runContinuation, runStopReason } from './run-reasons'

/** What the 202 said about getting the run started; shown beside the run. */
export type StartInfo = Pick<StartOutcome, 'dispatch' | 'workerBase' | 'claimed' | 'claimInMs'>

const STATUS_STYLE: Record<string, string> = {
  queued: 'bg-slate-100 text-slate-700 border-slate-200',
  running: 'bg-sky-50 text-sky-700 border-sky-200',
  succeeded: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  partial: 'bg-amber-50 text-amber-800 border-amber-200',
  failed: 'bg-rose-50 text-rose-700 border-rose-200',
  cancelled: 'bg-slate-100 text-slate-600 border-slate-200',
}

interface RunStateProps {
  run: RunDetail
  startInfo: StartInfo | null
  queueLog: string[]
  onRunAgain: () => void
  onContinue: (runId: string) => void
  onCancel: () => void
  cancelling: boolean
  busy: boolean
}

/** Everything the server said about one run, in the state it is in right now. */
export default function RunState({ run, startInfo, queueLog, onRunAgain, onContinue, onCancel, cancelling, busy }: RunStateProps) {
  const c = runSummary(run)
  const reason = runStopReason(run)
  const stale = stalenessNote(run)
  const events = recentEvents(run)
  const hasResults = run.jobs.total > 0 || c.saved > 0
  // A synchronous pre-016 run has no queryable id, so there is no per-run view to link to.
  const linkable = hasResults && isRunId(run.id)
  const stats = statsLines(run.stats)
  // Offered on the server's own judgement of the persisted cursor (run.resumable).
  const cont = runContinuation(run)
  const active = isActive(run.status)
  const chips = [runPassLine(run), queueAttemptsLine(run), run.cancel_requested && active ? 'stop requested' : null].filter((x): x is string => !!x)
  const worker = workerSourceLine(startInfo?.workerBase ?? null)
  const dispatchFailed = dispatchNote(startInfo?.dispatch ?? null)

  return (
    <div className="mt-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap text-sm">
        <span className={`px-1.5 py-0.5 rounded border text-xs ${STATUS_STYLE[run.status] ?? STATUS_STYLE.queued}`}>{run.status}</span>
        <span className="text-slate-800">{runHeadline(run)}</span>
        <span className="text-xs text-slate-500">· {runDuration(run)}</span>
        {chips.map((chip) => (
          <span key={chip} className="px-1.5 py-0.5 rounded border border-slate-200 bg-white text-[11px] text-slate-600">
            {chip}
          </span>
        ))}
        {active && (
          <button type="button" onClick={onCancel} disabled={cancelling || run.cancel_requested} className="ml-auto text-xs px-2.5 py-1 rounded-md border border-rose-200 text-rose-700 hover:bg-white disabled:opacity-50">
            {cancelling ? 'Cancelling…' : run.cancel_requested ? 'Stop requested' : 'Cancel'}
          </button>
        )}
        {!busy && (
          <button type="button" onClick={onRunAgain} className="ml-auto text-xs px-2.5 py-1 rounded-md border border-slate-300 text-slate-700 hover:bg-white">
            Run again
          </button>
        )}
      </div>

      {active && (
        <>
          {run.status === 'running' && run.detail && <p className="text-xs text-slate-600">{run.detail}</p>}
          {(events.length > 0 || queueLog.length > 0) && (
            <ul className="text-xs text-slate-600 space-y-0.5 rounded-md bg-white border border-slate-200 p-3">
              {events.map((e, i) => (
                <li key={`${e.at ?? i}-${i}`} className={i === events.length - 1 ? 'text-slate-900 font-medium' : ''}>
                  <span className="text-slate-400 mr-1">{i === events.length - 1 ? '▸' : '✓'}</span>
                  {eventLine(e)}
                </li>
              ))}
              {queueLog.map((line, i) => (
                <li key={`q-${i}`} className="text-amber-800">
                  <span className="text-slate-400 mr-1">⟳</span>
                  queue — {line}
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-slate-600 tabular-nums">
            {c.discovered} discovered · {c.saved} saved · {c.verified} verified open · {c.ranked} ranked
          </p>
          {worker && <p className="text-[11px] text-slate-400">{worker}{startInfo?.claimed && startInfo.claimInMs !== null ? ` · claimed in ${(startInfo.claimInMs / 1000).toFixed(1)}s` : ''}</p>}
          {dispatchFailed && <InlineNotice kind="warn">{dispatchFailed}</InlineNotice>}
          {stale && <InlineNotice kind="warn">{stale}</InlineNotice>}
        </>
      )}

      {isTerminal(run.status) && (
        <>
          {reason && (
            <InlineNotice kind={run.status === 'failed' ? 'error' : 'warn'}>
              <div>{reason.sentence}</div>
              {reason.detail && <div className="mt-1 text-xs opacity-80">{reason.detail}</div>}
              {reason.remedy && <div className="mt-1">Fix: {reason.remedy}</div>}
            </InlineNotice>
          )}
          <div className="flex items-center gap-3 flex-wrap">
            {linkable ? (
              <Link href={runResultsHref(run.id)} className="px-3 py-1.5 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700">
                View results
              </Link>
            ) : hasResults ? (
              <span className="text-xs text-slate-500">This run was not recorded as a durable run, so it has no results page — apply migration 016 and the next run will have one.</span>
            ) : (
              <span className="text-xs text-slate-500">This run stored no jobs.</span>
            )}
            <span className="text-xs text-slate-500 tabular-nums">
              {c.saved} saved · {c.verified} verified open{c.likely > 0 ? ` · ${c.likely} likely open` : ''} · {c.unverified} unverified · {c.ranked} ranked ·{' '}
              {c.rejected} rejected
            </span>
          </div>
          {cont.canContinue && isRunId(run.id) && (
            <div className="flex items-center gap-3 flex-wrap">
              <button
                type="button"
                disabled={busy}
                onClick={() => onContinue(run.id)}
                className="px-3 py-1.5 rounded-md border border-indigo-300 text-indigo-700 text-sm font-medium hover:bg-white disabled:opacity-50"
              >
                Continue this run
              </button>
              {cont.note && <span className="text-xs text-slate-500">{cont.note}</span>}
            </div>
          )}
          {stats.length > 0 && (
            <details>
              <summary className="text-xs text-slate-600 cursor-pointer">What the run did, stage by stage</summary>
              <ul className="mt-1 text-xs text-slate-700 font-mono space-y-0.5 rounded-md bg-white border border-slate-200 p-3">
                {stats.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  )
}
