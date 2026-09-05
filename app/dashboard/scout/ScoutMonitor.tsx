'use client'

// What the server says one People Scout run is doing, right now.
//
// Every line here is something the run row reported: its stage, its detail,
// its last events, its counts, which pass it is on, how many dispatch attempts
// a queued run has had, and what it has spent. Nothing is estimated between
// polls. The only clock is the one that renders "waiting 42s".

import { useEffect, useState } from 'react'
import type { PeopleScoutResult } from '@/lib/scouting/checkpoint'
import InlineNotice from '@/components/career/InlineNotice'
import { fmtUsd } from '@/components/career/api'
import { isActive, type ScoutRun } from './scout-run-view'
import { costSoFar, countPairs, eventLine, queuedLine, recentEvents, runElapsed, runHeadline, stalenessNote, terminalNotice } from './scout-run-copy'

const STATUS_STYLE: Record<string, string> = {
  queued: 'bg-slate-100 text-slate-700 border-slate-200',
  running: 'bg-sky-50 text-sky-700 border-sky-200',
  succeeded: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  partial: 'bg-amber-50 text-amber-800 border-amber-200',
  failed: 'bg-rose-50 text-rose-700 border-rose-200',
  cancelled: 'bg-slate-100 text-slate-600 border-slate-200',
}

export interface ContactNotice {
  message: string
  /** Polling has stopped for good (signed out, run not found). */
  stopped: boolean
}

export default function ScoutMonitor({
  run,
  result,
  contact,
  restoredNote,
  cancelling,
  cancelMessage,
  onCancel,
}: {
  run: ScoutRun
  result: PeopleScoutResult | null
  /** The poll loop lost contact, or stopped. */
  contact: ContactNotice | null
  /** "Showing your last run from …" / "A scout was already going" — set by the page. */
  restoredNote: string | null
  cancelling: boolean
  cancelMessage: string | null
  onCancel: () => void
}) {
  const active = isActive(run.status)
  // A one-second clock for the elapsed and waiting figures only; nothing else moves between polls.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(t)
  }, [active])

  const events = recentEvents(run)
  const counts = countPairs(run.counts)
  const cost = costSoFar(run, result)
  const stale = stalenessNote(run, now)
  const terminal = terminalNotice(run)
  const prospects = result ? result.prospects.length : null

  return (
    <div className="mt-6 bg-white border border-slate-200 rounded-lg p-5 space-y-3">
      {restoredNote && <InlineNotice kind="info">{restoredNote}</InlineNotice>}

      <div className="flex items-center gap-2 flex-wrap text-sm">
        <span className={`px-1.5 py-0.5 rounded border text-xs ${STATUS_STYLE[run.status] ?? STATUS_STYLE.queued}`}>{run.status}</span>
        <span className="text-slate-800">{runHeadline(run, prospects)}</span>
        {run.invocation > 1 && (
          <span className="px-1.5 py-0.5 rounded border text-xs bg-indigo-50 text-indigo-700 border-indigo-200" title="The run outlived one worker pass and continued from its checkpoint">
            pass {run.invocation}
          </span>
        )}
        <span className="text-xs text-slate-500">· {runElapsed(run, now)}</span>
        {cost !== null && <span className="text-xs text-slate-500">· {fmtUsd(cost)} so far</span>}
        {active && (
          <button
            type="button"
            onClick={onCancel}
            disabled={cancelling || run.cancel_requested}
            className="ml-auto text-xs px-2.5 py-1 rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:text-slate-400"
          >
            {cancelling ? 'Cancelling…' : run.cancel_requested ? 'Stop requested' : 'Cancel'}
          </button>
        )}
      </div>

      {run.status === 'queued' && (
        <p className="text-xs text-slate-600 tabular-nums">
          {queuedLine(run, now)}. The server re-dispatches a queued run on every poll; nothing has been spent yet.
        </p>
      )}

      {run.status === 'running' && (
        <>
          {run.detail && <p className="text-xs text-slate-700">{run.detail}</p>}
          {events.length > 0 && (
            <ul className="text-xs text-slate-600 space-y-0.5 rounded-md bg-slate-50 border border-slate-200 p-3">
              {events.map((e, i) => {
                const current = i === events.length - 1
                return (
                  <li key={`${e.at ?? i}-${i}`} className={current ? 'text-slate-900 font-medium' : 'text-slate-500'}>
                    <span className="text-slate-400 mr-1">{current ? '▸' : '✓'}</span>
                    {eventLine(e)}
                  </li>
                )
              })}
            </ul>
          )}
          {counts.length > 0 && (
            <p className="text-xs text-slate-600 tabular-nums">
              {counts.map(([k, v], i) => (
                <span key={k}>
                  {i > 0 && ' · '}
                  {v} {k.replace(/_/g, ' ')}
                </span>
              ))}
            </p>
          )}
          {result && result.prospects.length > 0 && (
            <p className="text-xs text-slate-500">{result.prospects.length} prospects ranked so far — shown below and updated as the run goes.</p>
          )}
        </>
      )}

      {run.cancel_requested && active && <InlineNotice kind="info">Stop requested. The run stops at its next step and keeps everything it has found.</InlineNotice>}
      {cancelMessage && <InlineNotice kind="info">{cancelMessage}</InlineNotice>}
      {stale && <InlineNotice kind="warn">{stale}</InlineNotice>}
      {contact && <InlineNotice kind={contact.stopped ? 'error' : 'warn'}>{contact.message}</InlineNotice>}

      {terminal && (
        <InlineNotice kind={terminal.kind}>
          <div className="font-medium">{terminal.title}</div>
          {terminal.lines.map((l, i) => (
            <div key={i} className="mt-0.5">
              {l}
            </div>
          ))}
        </InlineNotice>
      )}
      {run.status === 'succeeded' && prospects === 0 && <InlineNotice kind="warn">The run finished but ranked nobody. The decision box and the issues list below say why.</InlineNotice>}
    </div>
  )
}
