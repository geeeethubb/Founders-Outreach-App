'use client'

// What one scout run produced — every job it touched, curated by nothing.
//
// The inbox at /dashboard/jobs is a curated list: it hides jobs that are not
// verified-or-likely open and ones already dismissed. That is right for daily
// use and wrong for "show me what that run found", so this view asks the API
// for the run's jobs with no defaults applied and says so on screen. The two
// surfaces are deliberately different objects: this one is bordered, titled by
// the run, and has one way back.

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { api } from '@/components/career/api'
import InlineNotice from '@/components/career/InlineNotice'
import JobCard, { type JobCardData } from './JobCard'
import { isActive, isTerminal, MAX_POLL_FAILURES, parseRunDetail, POLL_MS, runDetailHref, runJobsQuery, type RunDetail } from './run-view'
import { partialReason, runDuration, runHeadline, runJobsCountLine, runSummary, statsLines } from './run-copy'

const STATUS_STYLE: Record<string, string> = {
  queued: 'bg-slate-100 text-slate-700 border-slate-200',
  running: 'bg-sky-50 text-sky-700 border-sky-200',
  succeeded: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  partial: 'bg-amber-50 text-amber-800 border-amber-200',
  failed: 'bg-rose-50 text-rose-700 border-rose-200',
  cancelled: 'bg-slate-100 text-slate-600 border-slate-200',
}

interface RunJobsResponse {
  jobs: JobCardData[]
  /** Every job the run touched — not the size of this page. */
  total: number
  run?: { id: string; ids: number; shown?: number; truncated?: number } | null
}

function Stat({ label, value, tone = '' }: { label: string; value: number; tone?: string }) {
  return (
    <span className="text-xs text-slate-600">
      <strong className={`tabular-nums ${tone || 'text-slate-900'}`}>{value}</strong> {label}
    </span>
  )
}

export default function RunResults({ runId }: { runId: string }) {
  const [run, setRun] = useState<RunDetail | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [data, setData] = useState<RunJobsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadJobs = useCallback(async () => {
    setLoading(true)
    const r = await api<RunJobsResponse>(`/api/career/jobs?${runJobsQuery(runId)}`)
    setLoading(false)
    if (!r.ok || !r.data) {
      setError(r.error)
      return
    }
    setError(null)
    setData(r.data)
  }, [runId])

  useEffect(() => {
    loadJobs()
  }, [loadJobs])

  // The run may still be going when this view is opened from the monitor, so it
  // polls with the same loop and refreshes the list once the run lands.
  const reloadRef = useRef(loadJobs)
  reloadRef.current = loadJobs
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let failures = 0
    const tick = async () => {
      const r = await api<unknown>(runDetailHref(runId))
      if (cancelled) return
      if (!r.ok) {
        // A run detail that cannot be read is not fatal: the jobs list stands on
        // its own. One blip is not an outage either — keep polling, and only say
        // so after the same number of misses the monitor tolerates.
        failures++
        if (failures >= MAX_POLL_FAILURES) {
          setRunError(r.error)
          return
        }
      } else {
        failures = 0
        const detail = parseRunDetail(r.data ?? r.body)
        if (detail) {
          setRun(detail)
          setRunError(null)
          if (isTerminal(detail.status)) {
            reloadRef.current()
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

  function patchJob(id: string, patch: Partial<JobCardData>) {
    setData((prev) => (prev ? { ...prev, jobs: prev.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)) } : prev))
  }

  const jobs = data?.jobs ?? []
  const c = run ? runSummary(run) : null
  const reason = run ? partialReason(run) : null
  const stats = run ? statsLines(run.stats) : []

  return (
    <div className="rounded-xl border-2 border-indigo-200 bg-white">
      <div className="border-b border-indigo-100 bg-indigo-50/50 px-4 py-3">
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="font-medium text-slate-900">Results from one scout run</h2>
          {run && <span className={`px-1.5 py-0.5 rounded border text-xs ${STATUS_STYLE[run.status] ?? STATUS_STYLE.queued}`}>{run.status}</span>}
          {run && <span className="text-xs text-slate-500">{runDuration(run)}</span>}
          <Link href="/dashboard/jobs" className="ml-auto text-sm text-indigo-600 hover:underline font-medium">
            ← Back to all jobs
          </Link>
        </div>
        {run && <p className="text-sm text-slate-700 mt-1">{runHeadline(run)}</p>}
        {c && (
          <div className="mt-2 flex items-center gap-x-4 gap-y-1 flex-wrap">
            <Stat label="discovered" value={c.discovered} />
            <Stat label="saved" value={c.saved} />
            <Stat label="verified open" value={c.verified} tone="text-emerald-700" />
            {/* Its own status, not a kind of unverified — shown only when the run produced any. */}
            {c.likely > 0 && <Stat label="likely open" value={c.likely} tone="text-emerald-600" />}
            <Stat label="unverified" value={c.unverified} tone="text-amber-700" />
            <Stat label="ranked" value={c.ranked} />
            <Stat label="rejected" value={c.rejected} tone="text-slate-500" />
          </div>
        )}
        <p className="text-xs text-slate-500 mt-2">
          Everything this run stored, including postings it could not verify and ones it has not ranked yet — the inbox&apos;s freshness and disposition
          filters are not applied here.
        </p>
      </div>

      <div className="p-4 space-y-3">
        {reason && <InlineNotice kind={run?.status === 'failed' ? 'error' : 'warn'}>{reason}</InlineNotice>}
        {runError && <InlineNotice kind="warn">The run&apos;s own record could not be read ({runError}). The jobs below are still this run&apos;s.</InlineNotice>}
        {error && <InlineNotice kind="error">{error}</InlineNotice>}

        {loading && !data ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : jobs.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center">
            <p className="text-slate-700 font-medium">This run stored no jobs.</p>
            <p className="text-sm text-slate-500 mt-1">
              {run && isActive(run.status)
                ? 'It is still going — this list fills in as it stores postings.'
                : 'Nothing it found survived the mission’s hard constraints, or it stopped before it could store anything.'}
            </p>
          </div>
        ) : (
          <>
            <p className="text-xs text-slate-500">
              {runJobsCountLine(jobs.length, Math.max(jobs.length, data?.total ?? 0))}
              {loading ? ' · refreshing…' : ''}
            </p>
            {jobs.map((j) => (
              <JobCard key={j.id} job={j} onChange={(p) => patchJob(j.id, p)} onReranked={loadJobs} />
            ))}
          </>
        )}

        {stats.length > 0 && (
          <details>
            <summary className="text-xs text-slate-600 cursor-pointer">What the run did, stage by stage</summary>
            <ul className="mt-1 text-xs text-slate-700 font-mono space-y-0.5 rounded-md bg-slate-50 border border-slate-200 p-3">
              {stats.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </details>
        )}
        <p className="text-[11px] text-slate-400 font-mono">run {runId}</p>
      </div>
    </div>
  )
}
