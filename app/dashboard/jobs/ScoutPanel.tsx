'use client'

// The scout run monitor.
//
// Pressing "Run scout" queues a run on the server and returns; everything after
// that is the server's own state, polled from GET /api/career/scout/runs/[id].
// Nothing here estimates progress, and closing the tab no longer costs the run:
// the work is not attached to the request that started it.
//
// On a database where migration 016 is not applied the POST still answers the
// old synchronous result. That is rendered as a finished run rather than a
// second vocabulary — see legacyRunDetail().

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import type { DirectionMode } from '@/lib/career/types'
import { api } from '@/components/career/api'
import InlineNotice from '@/components/career/InlineNotice'
import { scoutingLine } from './direction'
import {
  activeRunIdOf,
  durableOf,
  isActive,
  isRunId,
  isTerminal,
  legacyRunDetail,
  MAX_POLL_FAILURES,
  parseRunDetail,
  parseStartResponse,
  POLL_MS,
  runDetailHref,
  runResultsHref,
  type RunDetail,
} from './run-view'
import { eventLine, partialReason, recentEvents, runContinuation, runDuration, runHeadline, runSummary, stalenessNote, statsLines, tabSafetyLine } from './run-copy'
import { MODE_DESCRIPTIONS, type RunMode } from '@/lib/career/discovery/modes'

// How big a run is, is ONE choice. The four sliders that used to live here
// (Strategies, Rounds, Companies, Extract) were implementation details of
// stages nobody operates, and their numbers were the product's real ceiling —
// twelve postings per strategy, twelve jobs ranked. The mode carries them now
// (lib/career/discovery/modes.ts), and the only other thing worth deciding is
// how much the run may spend.
const MODE_ORDER: RunMode[] = ['QUICK', 'BROAD', 'EXHAUSTIVE']

export interface ScoutEnvironment {
  /** The newest run the server itself calls queued or running, or null. */
  activeRunId: string | null
  /** Whether a run survives this request. null = the server did not say. */
  durable: boolean | null
}

/**
 * What the server knows about scouting right now: whether a run is already
 * going (so a refresh resumes the monitor instead of double-spending) and
 * whether a run outlives its request.
 *
 * `GET /api/career/runs?active=1` answers `{ active, durable }`. Only `active`
 * is read for the run — the `runs` list carries a derived display status where
 * a dead run reads as 'stalled', and resuming one of those would open the
 * monitor on a corpse. A failure here is silent by design: it must never break
 * the Jobs page, and an unknown durability is treated as the pre-016 answer.
 */
export async function readScoutEnvironment(): Promise<ScoutEnvironment> {
  const r = await api<unknown>('/api/career/runs?active=1&kind=job_scout&limit=1')
  if (!r.ok) return { activeRunId: null, durable: null }
  const body = r.body ?? r.data
  return { activeRunId: activeRunIdOf(body), durable: durableOf(body) }
}

function ModeCard({ mode, selected, onSelect }: { mode: RunMode; selected: boolean; onSelect: () => void }) {
  const d = MODE_DESCRIPTIONS[mode]
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`text-left rounded-lg border p-3 transition ${selected ? 'border-indigo-500 bg-white ring-1 ring-indigo-200' : 'border-slate-200 bg-white/60 hover:border-slate-300'}`}
    >
      <span className="block text-sm font-medium text-slate-900">{d.label}</span>
      <span className="block text-[11px] text-slate-600 mt-0.5">{d.blurb}</span>
      <span className="block text-[11px] text-slate-400 mt-1">
        {d.runtime} · {d.cost}
      </span>
    </button>
  )
}

const STATUS_STYLE: Record<string, string> = {
  queued: 'bg-slate-100 text-slate-700 border-slate-200',
  running: 'bg-sky-50 text-sky-700 border-sky-200',
  succeeded: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  partial: 'bg-amber-50 text-amber-800 border-amber-200',
  failed: 'bg-rose-50 text-rose-700 border-rose-200',
  cancelled: 'bg-slate-100 text-slate-600 border-slate-200',
}

export default function ScoutPanel({
  missionId,
  direction,
  directionMode,
  initialRunId,
  durable: durableProp,
  onFinished,
  onClose,
}: {
  missionId: string | null
  /** mission.preferences.direction as the page holds it — never fetched again here. */
  direction: string | null | undefined
  /**
   * What that direction DOES, resolved with `missionDirectionMode()`. REQUIRED:
   * "only show me this" hides postings, and a person about to spend money on a
   * run has to be told that before it starts, not after — so the panel cannot
   * be mounted without saying which it is.
   */
  directionMode: DirectionMode | null
  /** A run to resume showing (from ?run= or the newest active run). */
  initialRunId?: string | null
  /**
   * Whether a run outlives the request that starts it, as the SERVER said.
   * Undefined/null means "not asked yet", and the panel asks for itself rather
   * than promising the founder something it does not know.
   */
  durable?: boolean | null
  onFinished: () => void
  onClose: () => void
}) {
  const [mode, setMode] = useState<RunMode>('BROAD')
  /** Empty means "the mode's own ceiling". A number overrides it. */
  const [spend, setSpend] = useState('')
  const [verify, setVerify] = useState(true)
  const [starting, setStarting] = useState(false)
  const [runId, setRunId] = useState<string | null>(initialRunId ?? null)
  const [run, setRun] = useState<RunDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [durable, setDurable] = useState<boolean | null>(durableProp ?? null)

  // onFinished is an inline arrow on the Jobs page; holding it in a ref keeps a
  // re-render from restarting the poll loop.
  const finishedRef = useRef(onFinished)
  finishedRef.current = onFinished

  useEffect(() => {
    if (initialRunId) setRunId(initialRunId)
  }, [initialRunId])

  useEffect(() => {
    if (durableProp === true || durableProp === false) setDurable(durableProp)
  }, [durableProp])

  // Nobody told us yet whether a run survives the request, and the panel says so
  // on screen either way — so ask, once, instead of guessing.
  useEffect(() => {
    if (durableProp === true || durableProp === false) return
    let alive = true
    readScoutEnvironment().then((env) => {
      if (alive && env.durable !== null) setDurable(env.durable)
    })
    return () => {
      alive = false
    }
  }, [durableProp])

  // Poll the server while there is a run to watch. Every number on screen comes
  // from this loop; nothing is simulated between ticks.
  useEffect(() => {
    if (!runId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let failures = 0

    const tick = async () => {
      const r = await api<unknown>(runDetailHref(runId))
      if (cancelled) return
      if (!r.ok) {
        failures++
        if (failures >= MAX_POLL_FAILURES) {
          setError(`Lost contact with the run (${r.error ?? 'no answer'}). It may still be going — reload to pick it up again.`)
          return
        }
      } else {
        failures = 0
        const detail = parseRunDetail(r.data ?? r.body)
        if (detail) {
          setRun(detail)
          setError(null)
          if (isTerminal(detail.status)) {
            finishedRef.current()
            return
          }
        }
      }
      timer = setTimeout(tick, POLL_MS)
    }

    tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [runId])

  /**
   * Start a run, or CONTINUE one that stopped short.
   *
   * A continuation is the same work under a new row: the server reads the
   * previous run's cursor and skips the plan, the sweep, the companies and the
   * strategies it already paid for. The cursor is never taken from this
   * request — the browser only names the run.
   */
  const startRun = useCallback(async (continueRun?: string) => {
    // A second click while the first POST is in flight would enqueue a second
    // paid run. One press, one run.
    if (starting) return
    setStarting(true)
    setError(null)
    setRun(null)
    setRunId(null)
    const maxSpendUsd = spend.trim() === '' ? undefined : Math.max(0, Number(spend))
    const r = await api<unknown>('/api/career/scout', {
      json: { missionId, mode, verify, ...(Number.isFinite(maxSpendUsd) ? { maxSpendUsd } : {}), ...(continueRun ? { continueRun } : {}) },
    })
    setStarting(false)
    const body = r.data ?? r.body
    const outcome = parseStartResponse(body, r.status)
    // The answer settles the question the header sentence asks.
    if (outcome.durable !== null) setDurable(outcome.durable)
    if (outcome.queued && outcome.runId) {
      setRunId(outcome.runId)
      return
    }
    // No durable run: either the pre-016 synchronous path answered, or it failed.
    const legacy = legacyRunDetail(body)
    if (r.ok && legacy) {
      setRun(legacy)
      finishedRef.current()
      return
    }
    if (legacy && legacy.jobs.total > 0) setRun(legacy)
    setError(r.error ?? 'The run could not be started.')
    finishedRef.current()
  }, [missionId, mode, spend, verify, starting])

  const start = useCallback(() => startRun(), [startRun])

  function reset() {
    setRun(null)
    setRunId(null)
    setError(null)
  }

  const watching = !!runId || !!run
  const busy = starting || (!!run && isActive(run.status)) || (!!runId && !run)

  return (
    <div className="rounded-xl border border-indigo-200 bg-indigo-50/30 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-medium text-slate-900">Scout now</h2>
          <p className={`text-xs mt-0.5 ${direction?.trim() ? 'text-slate-700 font-medium' : 'text-slate-500 italic'}`}>{scoutingLine(direction, directionMode)}</p>
          <p className="text-xs text-slate-500 mt-0.5">
            Searches the market from what you&apos;re scouting for, checks the companies you chose, reads and verifies what it finds — and keeps going until
            the searches stop producing anything new, the time runs out, or it reaches the spend limit you set.
          </p>
          <p className={`text-xs mt-0.5 ${durable === true ? 'text-slate-500' : 'text-amber-700'}`}>{tabSafetyLine(durable)}</p>
        </div>
        <button type="button" onClick={onClose} className="text-xs text-slate-500 hover:text-slate-900">
          Close
        </button>
      </div>

      {!watching && !starting && (
        <>
          <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-2">
            {MODE_ORDER.map((m) => (
              <ModeCard key={m} mode={m} selected={mode === m} onSelect={() => setMode(m)} />
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <button type="button" onClick={start} className="px-4 py-2 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700">
              Run scout
            </button>
            <label className="flex items-center gap-2 text-xs text-slate-600">
              Spend at most
              <span className="flex items-center gap-1">
                $
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  value={spend}
                  onChange={(e) => setSpend(e.target.value)}
                  placeholder={MODE_DESCRIPTIONS[mode].cost.replace(/^up to about \$|^about \$/, '').split('–').pop()}
                  className="w-20 rounded border border-slate-300 px-2 py-1 text-xs"
                />
              </span>
              <span className="text-[11px] text-slate-400">the run starts no further paid work once it reaches this</span>
            </label>
          </div>
          <details className="mt-3">
            <summary className="text-xs text-slate-600 cursor-pointer">Options</summary>
            <label className="mt-3 flex items-center gap-2 text-xs text-slate-600">
              <input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} />
              Verify each posting is open (fetches the page; ambiguous pages cost a model call)
            </label>
            <p className="mt-2 text-[11px] text-slate-400">
              A Broad or Exhaustive run can outlive one pass. It saves where it got to, and if it stops at the time or the spend limit you can continue it
              from there — the next pass skips the planning, the companies and the searches it already paid for. The same run is available from the command
              line: <code>npm run career:scout</code>.
            </p>
          </details>
        </>
      )}

      {starting && <p className="mt-4 text-sm text-slate-600">Starting the run…</p>}
      {runId && !run && !starting && !error && <p className="mt-4 text-sm text-slate-600">Picking the run up…</p>}

      {run && <RunState run={run} onRunAgain={reset} onContinue={(id) => startRun(id)} busy={busy} />}

      {error && (
        <div className="mt-4">
          <InlineNotice kind="error">
            {error}{' '}
            <button type="button" onClick={reset} className="underline">
              Start over
            </button>
          </InlineNotice>
        </div>
      )}
    </div>
  )
}

/** Everything the server said about one run, in the state it is in right now. */
function RunState({ run, onRunAgain, onContinue, busy }: { run: RunDetail; onRunAgain: () => void; onContinue: (runId: string) => void; busy: boolean }) {
  const c = runSummary(run)
  const reason = partialReason(run)
  const stale = stalenessNote(run)
  const events = recentEvents(run)
  const hasResults = run.jobs.total > 0 || c.saved > 0
  // A synchronous pre-016 run has no queryable id, so there is no per-run view to link to.
  const linkable = hasResults && isRunId(run.id)
  const stats = statsLines(run.stats)
  // Offered only when the run's own report says it stopped short and its
  // cursor has somewhere to resume from — never on a finished or a saturated
  // run, where continuing would buy a second pass over an exhausted market.
  const cont = runContinuation(run)

  return (
    <div className="mt-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap text-sm">
        <span className={`px-1.5 py-0.5 rounded border text-xs ${STATUS_STYLE[run.status] ?? STATUS_STYLE.queued}`}>{run.status}</span>
        <span className="text-slate-800">{runHeadline(run)}</span>
        <span className="text-xs text-slate-500">· {runDuration(run)}</span>
        {!busy && (
          <button type="button" onClick={onRunAgain} className="ml-auto text-xs px-2.5 py-1 rounded-md border border-slate-300 text-slate-700 hover:bg-white">
            Run again
          </button>
        )}
      </div>

      {isActive(run.status) && (
        <>
          {run.detail && <p className="text-xs text-slate-600">{run.detail}</p>}
          {events.length > 0 && (
            <ul className="text-xs text-slate-600 space-y-0.5 rounded-md bg-white border border-slate-200 p-3">
              {events.map((e, i) => (
                <li key={`${e.at ?? i}-${i}`} className={i === events.length - 1 ? 'text-slate-900 font-medium' : ''}>
                  <span className="text-slate-400 mr-1">{i === events.length - 1 ? '▸' : '✓'}</span>
                  {eventLine(e)}
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-slate-600 tabular-nums">
            {c.discovered} discovered · {c.saved} saved · {c.verified} verified open · {c.ranked} ranked
          </p>
          {stale && <InlineNotice kind="warn">{stale}</InlineNotice>}
        </>
      )}

      {isTerminal(run.status) && (
        <>
          {reason && <InlineNotice kind={run.status === 'failed' ? 'error' : 'warn'}>{reason}</InlineNotice>}
          <div className="flex items-center gap-3 flex-wrap">
            {linkable ? (
              <Link href={runResultsHref(run.id)} className="px-3 py-1.5 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700">
                View results
              </Link>
            ) : hasResults ? (
              <span className="text-xs text-slate-500">
                This run was not recorded as a durable run, so it has no results page — apply migration 016 and the next run will have one.
              </span>
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
