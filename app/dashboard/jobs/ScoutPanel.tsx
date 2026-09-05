'use client'

// The scout run monitor. "Run scout" queues a run and returns; everything after
// is the server's own state, polled from GET /api/career/scout/runs/[id].
//
// Every sentence on screen is something the server said — the readiness
// verdict, the 202's dispatch report, the 409's run, the row's error code and
// remedy, the watchdog's queue actions. Where it has not answered yet the
// panel says that, never a guess in either direction.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { DirectionMode } from '@/lib/career/types'
import { api } from '@/components/career/api'
import InlineNotice from '@/components/career/InlineNotice'
import ReadinessBanner, { loadScoutReadiness, readinessBlocks, type ReadinessState } from '@/components/career/ReadinessBanner'
import { scoutingLine } from './direction'
import {
  activeRunIdOf,
  durableOf,
  isActive,
  isRunId,
  isTerminal,
  legacyRunDetail,
  LOST_CONTACT_POLL_MS,
  MAX_POLL_FAILURES,
  object,
  parseQueueActions,
  parseRunDetail,
  parseStartResponse,
  POLL_MS,
  runCancelHref,
  runDetailHref,
  str,
  type RunDetail,
  type StartOutcome,
} from './run-view'
import { queueActionLine, tabSafetyLine } from './run-copy'
import { pollVerdict } from './run-reasons'
import RunState, { type StartInfo } from './ScoutRunState'
import { MODE_DESCRIPTIONS, type RunMode } from '@/lib/career/discovery/modes'

// How big a run is, is ONE choice — the mode carries the ceilings
// (lib/career/discovery/modes.ts); the only other decision is the spend.
const MODE_ORDER: RunMode[] = ['QUICK', 'BROAD', 'EXHAUSTIVE']

export interface ScoutEnvironment {
  /** The newest run the server itself calls queued or running, or null. */
  activeRunId: string | null
  /** Whether a run survives this request. null = the server did not say. */
  durable: boolean | null
}

/**
 * Whether a run is already going (a refresh resumes it instead of double-
 * spending) and whether a run outlives its request. Only `active` is read for
 * the run — the `runs` list carries a derived display status. A failure here is
 * silent by design: an unknown durability stays unknown on screen.
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

export default function ScoutPanel({
  missionId,
  direction,
  directionMode,
  initialRunId,
  durable: durableProp,
  readiness: readinessProp,
  onFinished,
  onClose,
}: {
  missionId: string | null
  /** mission.preferences.direction as the page holds it — never fetched again here. */
  direction: string | null | undefined
  /** What that direction DOES. REQUIRED: "only show me this" hides postings, and the founder is told before paying. */
  directionMode: DirectionMode | null
  /** A run to resume showing (from ?run= or the newest active run). */
  initialRunId?: string | null
  /** Whether a run outlives the request, as the SERVER said. Undefined/null = not asked yet; the panel asks for itself. */
  durable?: boolean | null
  /** The readiness verdict the page already fetched. Undefined = the panel asks for itself. */
  readiness?: ReadinessState | null
  onFinished: () => void
  onClose: () => void
}) {
  const [mode, setMode] = useState<RunMode>('BROAD')
  /** Empty means "the mode's own ceiling". A number overrides it. */
  const [spend, setSpend] = useState('')
  const [verify, setVerify] = useState(true)
  const [starting, setStarting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [runId, setRunId] = useState<string | null>(initialRunId ?? null)
  const [run, setRun] = useState<RunDetail | null>(null)
  const [startInfo, setStartInfo] = useState<StartInfo | null>(null)
  /** Lines from the watchdog (`queueActions` on the poll), newest last, deduplicated. */
  const [queueLog, setQueueLog] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [durable, setDurable] = useState<boolean | null>(durableProp ?? null)
  const [readiness, setReadiness] = useState<ReadinessState>(readinessProp ?? { phase: 'loading' })

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

  useEffect(() => {
    if (readinessProp) setReadiness(readinessProp)
  }, [readinessProp])

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

  // Can a run start here at all? Asked before the button is pressed, unless
  // the page already asked and passed the answer down.
  const recheck = useCallback((fresh: boolean) => {
    setReadiness({ phase: 'loading' })
    loadScoutReadiness('jobs', fresh).then(setReadiness)
  }, [])
  useEffect(() => {
    if (readinessProp === undefined) recheck(false)
  }, [readinessProp, recheck])

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
      let nextMs = POLL_MS
      if (!r.ok) {
        failures++
        const v = pollVerdict({ status: r.status, failures, error: r.error, maxFailures: MAX_POLL_FAILURES, pollMs: POLL_MS, lostContactPollMs: LOST_CONTACT_POLL_MS })
        if (v.message) setError(v.message)
        if (v.stop) return
        nextMs = v.nextMs
      } else {
        failures = 0
        const body = r.data ?? r.body
        const detail = parseRunDetail(body)
        const actions = parseQueueActions(body).map(queueActionLine)
        if (actions.length) setQueueLog((prev) => [...prev, ...actions.filter((a) => !prev.includes(a))].slice(-8))
        if (detail) {
          setRun(detail)
          setError(null)
          if (isTerminal(detail.status)) {
            finishedRef.current()
            return
          }
        }
      }
      timer = setTimeout(tick, nextMs)
    }

    tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [runId])

  /**
   * Start a run, or CONTINUE one that stopped short (same work, new row; the
   * server reads the previous cursor — never this request). One press, one run:
   * a second click while the POST is in flight is ignored.
   */
  const startRun = useCallback(async (continueRun?: string) => {
    if (starting) return
    setStarting(true)
    setError(null)
    setNotice(null)
    setRun(null)
    setRunId(null)
    setStartInfo(null)
    setQueueLog([])
    const maxSpendUsd = spend.trim() === '' ? undefined : Math.max(0, Number(spend))
    const r = await api<unknown>('/api/career/scout', {
      json: { missionId, mode, verify, ...(Number.isFinite(maxSpendUsd) ? { maxSpendUsd } : {}), ...(continueRun ? { continueRun } : {}) },
    })
    setStarting(false)
    const body = r.data ?? r.body
    const outcome = parseStartResponse(body, r.status)
    // The answer settles the question the header sentence asks.
    if (outcome.durable !== null) setDurable(outcome.durable)
    if (outcome.alreadyActive && outcome.runId) {
      setNotice('A scout run was already going — showing it (your chosen mode/spend was not applied).')
      if (outcome.run) setRun(outcome.run)
      setRunId(outcome.runId)
      return
    }
    if (outcome.queued && outcome.runId) {
      // The dispatch report travels with the run (RunState shows a failed one
      // beside it) rather than as an error the first successful poll would wipe.
      setStartInfo({ dispatch: outcome.dispatch, workerBase: outcome.workerBase, claimed: outcome.claimed, claimInMs: outcome.claimInMs })
      setRunId(outcome.runId)
      return
    }
    // No durable run: the (pre-016) synchronous answer, or a refusal. A refusal
    // that names a run row attaches to it — the row carries the code and remedy.
    const legacy = legacyRunDetail(body)
    if (r.ok && legacy) {
      setRun(legacy)
      finishedRef.current()
      return
    }
    setError(`${r.error ?? 'The run could not be started.'}${r.remedy ? ` — Fix: ${r.remedy}` : ''}`)
    if (outcome.runId && isRunId(outcome.runId)) setRunId(outcome.runId)
    else finishedRef.current()
  }, [missionId, mode, spend, verify, starting])

  const start = useCallback(() => startRun(), [startRun])

  /** Ask the server to stop the run. The poll keeps going: the row says when it did. */
  const cancel = useCallback(async () => {
    if (!runId || cancelling) return
    setCancelling(true)
    const r = await api<unknown>(runCancelHref(runId), { json: {} })
    setCancelling(false)
    setNotice(r.ok ? str(object(r.data ?? r.body)?.message) ?? 'Asked the run to stop.' : `Could not cancel: ${r.error ?? 'no answer'}`)
  }, [runId, cancelling])

  function reset() {
    setRun(null)
    setRunId(null)
    setError(null)
    setNotice(null)
    setStartInfo(null)
    setQueueLog([])
  }

  const watching = !!runId || !!run
  const busy = starting || (!!run && isActive(run.status)) || (!!runId && !run)
  const blocked = readinessBlocks(readiness)

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
          <p className={`text-xs mt-0.5 ${durable === false ? 'text-amber-700' : 'text-slate-500'}`}>{tabSafetyLine(durable)}</p>
        </div>
        <button type="button" onClick={onClose} className="text-xs text-slate-500 hover:text-slate-900">
          Close
        </button>
      </div>

      {!watching && !starting && (
        <>
          <div className="mt-3">
            <ReadinessBanner state={readiness} onRecheck={() => recheck(true)} />
          </div>
          <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-2">
            {MODE_ORDER.map((m) => (
              <ModeCard key={m} mode={m} selected={mode === m} onSelect={() => setMode(m)} />
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <button type="button" onClick={start} disabled={blocked} className="px-4 py-2 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
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

      {notice && (
        <div className="mt-4">
          <InlineNotice kind="info">{notice}</InlineNotice>
        </div>
      )}

      {run && <RunState run={run} startInfo={startInfo} queueLog={queueLog} onRunAgain={reset} onContinue={(id) => startRun(id)} onCancel={cancel} cancelling={cancelling} busy={busy} />}

      {error && (
        <div className="mt-4">
          <InlineNotice kind="error">
            {error}{' '}
            {!busy && (
              <button type="button" onClick={reset} className="underline">
                Start over
              </button>
            )}
          </InlineNotice>
        </div>
      )}
    </div>
  )
}

