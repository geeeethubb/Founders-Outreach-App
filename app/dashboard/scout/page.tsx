'use client'

// The People Scout page.
//
// A run is a row the server owns. This page asks whether scouting can run
// here (GET /api/scout/readiness), attaches to whatever run is already going
// (GET /api/scout/runs?active=1), starts one (POST /api/scout) and then polls
// it (GET /api/scout/runs/[id]) until it is terminal. Every number on screen
// is something the server reported. Nothing is simulated between polls, and
// nothing about a run is kept in this browser: a refresh, a second tab or a
// closed laptop all reattach to the same row. The only thing localStorage
// keeps is the form.

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import type { PeopleScoutResult } from '@/lib/scouting/checkpoint'
import { api } from '@/components/career/api'
import InlineNotice from '@/components/career/InlineNotice'
import ReadinessNotice from '@/components/career/ReadinessNotice'
import ScoutForm, { type CampaignOption } from './ScoutForm'
import ScoutMonitor, { type ContactNotice } from './ScoutMonitor'
import ScoutResults from './ScoutResults'
import {
  describePollFailure,
  isActive,
  isTerminal,
  MAX_POLL_FAILURES,
  nextPollDelayMs,
  parseFormPrefs,
  parsePeopleReadiness,
  parseRunDetail,
  parseRunsList,
  parseStartResponse,
  runCancelHref,
  runDetailHref,
  shouldRequestResult,
  type PeopleReadiness,
  type ScoutFormPrefs,
  type ScoutRun,
  type ScoutRunStatus,
} from './scout-run-view'
import { relativeTime } from './scout-run-copy'

const DEFAULT_GOAL =
  'Find people who could realistically lead to a strong winter 2026-27 internship or short-term ' +
  'project at the intersection of industrial AI, manufacturing, and chemical or process ' +
  'engineering — people who would also matter for summer 2027 recruiting.'

const DEFAULT_PREFS: ScoutFormPrefs = { goal: DEFAULT_GOAL, geography: 'United States', segments: 2, depth: 7, searchMode: 'internal_first', campaignId: '' }

/** The form is the only thing this browser remembers. Results live on the server. */
const FORM_KEY = 'scout:form'
/** The pre-durable page cached whole results here; cleared so a stale result can never show. */
const LEGACY_RESULT_KEY = 'scout:last'

function readPrefs(): ScoutFormPrefs {
  try {
    localStorage.removeItem(LEGACY_RESULT_KEY)
    return parseFormPrefs(localStorage.getItem(FORM_KEY), DEFAULT_PREFS)
  } catch {
    return DEFAULT_PREFS
  }
}

function writePrefs(p: ScoutFormPrefs) {
  try {
    localStorage.setItem(FORM_KEY, JSON.stringify(p))
  } catch {
    // Private window or storage full — the form still works, it just won't be remembered.
  }
}

interface StartError {
  message: string
  code: string | null
  remedy: string | null
}

export default function ScoutPage() {
  const [prefs, setPrefs] = useState<ScoutFormPrefs>(DEFAULT_PREFS)
  const [campaigns, setCampaigns] = useState<CampaignOption[]>([])

  const [readiness, setReadiness] = useState<PeopleReadiness | null>(null)
  const [readinessLoading, setReadinessLoading] = useState(true)
  const [readinessError, setReadinessError] = useState<string | null>(null)

  const [runId, setRunId] = useState<string | null>(null)
  const [run, setRun] = useState<ScoutRun | null>(null)
  const [result, setResult] = useState<PeopleScoutResult | null>(null)
  const [contact, setContact] = useState<ContactNotice | null>(null)
  const [restoredNote, setRestoredNote] = useState<string | null>(null)
  const [attachError, setAttachError] = useState<string | null>(null)

  const [starting, setStarting] = useState(false)
  const startingRef = useRef(false)
  const [startError, setStartError] = useState<StartError | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [cancelMessage, setCancelMessage] = useState<string | null>(null)

  const updatePrefs = useCallback((next: ScoutFormPrefs) => {
    setPrefs(next)
    writePrefs(next)
  }, [])

  const checkReadiness = useCallback(async (fresh = false) => {
    setReadinessLoading(true)
    const r = await api<unknown>(`/api/scout/readiness${fresh ? '?fresh=1' : ''}`)
    setReadinessLoading(false)
    if (!r.ok) {
      setReadinessError(`${r.error ?? 'no answer'}${r.code ? ` [${r.code}]` : ''}`)
      return
    }
    const parsed = parsePeopleReadiness(r.data ?? r.body)
    if (!parsed) {
      setReadinessError('the server answered something other than a readiness report')
      return
    }
    setReadinessError(null)
    setReadiness(parsed)
  }, [])

  // ─── Mount: the form, the campaigns, readiness, and whatever run exists ────
  useEffect(() => {
    setPrefs(readPrefs())
    api<{ campaigns?: CampaignOption[] }>('/api/campaigns/references').then((r) => setCampaigns(r.ok && r.data?.campaigns ? r.data.campaigns : []))
    void checkReadiness()

    let alive = true
    ;(async () => {
      const r = await api<unknown>('/api/scout/runs?active=1&limit=1')
      if (!alive) return
      if (!r.ok) {
        setAttachError(`Could not check for a run already going: ${r.error ?? 'no answer'}${r.code ? ` [${r.code}]` : ''}${r.remedy ? ` — ${r.remedy}` : ''}`)
        return
      }
      const { active, last } = parseRunsList(r.data ?? r.body)
      if (active) {
        setRun(active)
        setRunId(active.id)
        return
      }
      if (!last) return
      // The newest finished run, with its result, from the server — never from this browser.
      const d = await api<unknown>(runDetailHref(last.id, true))
      if (!alive) return
      const detail = d.ok ? parseRunDetail(d.data ?? d.body) : null
      if (!detail) {
        setAttachError(`Your last run could not be loaded: ${d.error ?? 'unreadable answer'}`)
        return
      }
      setRun(detail)
      setResult(detail.result)
      setRestoredNote(`Showing your last run from ${relativeTime(detail.completed_at ?? detail.started_at)} · Scout again to replace it.`)
      // A run the list called finished but the detail calls active: poll it.
      if (isActive(detail.status)) setRunId(detail.id)
    })()
    return () => {
      alive = false
    }
  }, [checkReadiness])

  // ─── Poll the run while there is one to watch ──────────────────────────────
  useEffect(() => {
    if (!runId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let failures = 0
    let polls = 0
    let known: ScoutRunStatus | null = null

    const schedule = (ms: number) => {
      timer = setTimeout(tick, ms)
    }

    const tick = async () => {
      polls++
      const withResult = shouldRequestResult(polls, known)
      const r = await api<unknown>(runDetailHref(runId, withResult))
      if (cancelled) return
      if (!r.ok) {
        failures++
        const f = describePollFailure(r.status, r.error)
        if (f.stop) {
          setContact({ message: f.message, stopped: true })
          return
        }
        if (failures >= MAX_POLL_FAILURES) setContact({ message: f.message, stopped: false })
        schedule(nextPollDelayMs(failures))
        return
      }
      const detail = parseRunDetail(r.data ?? r.body)
      if (!detail) {
        failures++
        if (failures >= MAX_POLL_FAILURES) setContact({ message: describePollFailure(r.status, 'the answer was not a run').message, stopped: false })
        schedule(nextPollDelayMs(failures))
        return
      }
      failures = 0
      setContact(null)
      known = detail.status
      setRun(detail)
      if (detail.result) setResult(detail.result)
      if (isTerminal(detail.status)) {
        // The result payload comes with the terminal poll, or with one more poll right now.
        if (detail.result || withResult) return
        schedule(0)
        return
      }
      schedule(nextPollDelayMs(0))
    }

    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [runId])

  // ─── Start ─────────────────────────────────────────────────────────────────
  const start = useCallback(async () => {
    // One press, one run: a second click while the POST is in flight must not enqueue a second paid run.
    if (startingRef.current) return
    startingRef.current = true
    setStarting(true)
    setStartError(null)
    setCancelMessage(null)
    const r = await api<unknown>('/api/scout', {
      json: {
        goal: prefs.goal,
        geography: prefs.geography,
        segments: prefs.segments,
        maxDeepResearch: prefs.depth,
        searchMode: prefs.searchMode,
        ...(prefs.campaignId ? { campaignId: prefs.campaignId } : {}),
      },
    })
    startingRef.current = false
    setStarting(false)
    const outcome = parseStartResponse(r.status, r.data ?? r.body)
    if (outcome.kind === 'started') {
      setRestoredNote(null)
      setContact(null)
      setResult(null)
      setRun(null)
      setRunId(outcome.runId)
      return
    }
    if (outcome.kind === 'conflict') {
      setRestoredNote('A scout was already going — showing it.')
      setContact(null)
      setResult(null)
      if (outcome.run) setRun(outcome.run)
      setRunId(outcome.runId)
      return
    }
    setStartError({ message: r.error ?? outcome.message, code: r.code, remedy: r.remedy })
    // A refused start is the readiness check's business too; refresh it so the notice matches.
    if (r.status === 503) void checkReadiness(true)
  }, [prefs, checkReadiness])

  // ─── Cancel ────────────────────────────────────────────────────────────────
  const cancel = useCallback(async () => {
    if (!runId || cancelling) return
    setCancelling(true)
    const r = await api<{ cancelled?: boolean; status?: string; requested?: boolean; message?: string }>(runCancelHref(runId), { method: 'POST' })
    setCancelling(false)
    if (!r.ok) {
      setCancelMessage(`Cancel failed: ${r.error ?? 'no answer'}${r.code ? ` [${r.code}]` : ''}`)
      return
    }
    setCancelMessage(r.data?.message ?? (r.data?.requested ? 'Stop requested; the run stops at its next step.' : 'Cancelled.'))
  }, [runId, cancelling])

  const runActive = !!run && isActive(run.status)
  // Attached to a run we have not read yet (unless polling has stopped for good).
  const attaching = !!runId && !run && !contact?.stopped
  const locked = starting || runActive || attaching
  const canStart = !locked && !readinessLoading && (readiness ? readiness.ready : true) && prefs.goal.trim().length > 0
  const startLabel = starting ? 'Starting…' : runActive || attaching ? 'Scouting…' : readiness && !readiness.ready ? 'Scouting unavailable' : 'Scout Opportunities'

  return (
    <div className="p-8 max-w-5xl">
      <h1 className="text-2xl font-semibold text-slate-900">Scout</h1>
      <p className="text-sm text-slate-600 mt-1">
        Describe what you are looking for. The system finds the companies, picks who to contact inside them, researches the shortlist, and ranks the
        result. Drafts land in{' '}
        <Link href="/dashboard/outreach" className="text-indigo-600 hover:underline">
          Outreach
        </Link>
        .
      </p>

      <div className="mt-4">
        <ReadinessNotice readiness={readiness} loading={readinessLoading} error={readinessError} onRecheck={() => void checkReadiness(true)} />
      </div>

      <ScoutForm value={prefs} onChange={updatePrefs} campaigns={campaigns} locked={locked} canStart={canStart} startLabel={startLabel} onStart={() => void start()} />

      {startError && (
        <div className="mt-4">
          <InlineNotice kind="error">
            <div className="font-medium">
              {startError.message}
              {startError.code ? <span className="ml-1 font-mono text-xs opacity-70">[{startError.code}]</span> : null}
            </div>
            {startError.remedy && <div className="mt-1">Fix: {startError.remedy}</div>}
          </InlineNotice>
        </div>
      )}

      {attachError && (
        <div className="mt-4">
          <InlineNotice kind="warn">{attachError}</InlineNotice>
        </div>
      )}

      {attaching && !contact && <p className="mt-4 text-sm text-slate-600">Picking the run up…</p>}
      {attaching && contact && (
        <div className="mt-4">
          <InlineNotice kind={contact.stopped ? 'error' : 'warn'}>{contact.message}</InlineNotice>
        </div>
      )}

      {run && (
        <ScoutMonitor run={run} result={result} contact={contact} restoredNote={restoredNote} cancelling={cancelling} cancelMessage={cancelMessage} onCancel={() => void cancel()} />
      )}

      {result && <ScoutResults key={run?.id ?? result.runId ?? 'result'} result={result} goal={prefs.goal} campaignId={prefs.campaignId} />}
    </div>
  )
}
