'use client'

// The main view: every job the scout found, ranked by fit, answering at a
// glance whether it is worth a package. Everything on screen is server-derived
// — a refresh shows the same decisions, because none of them live here.

import { Suspense, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import type { CareerMission } from '@/lib/career/types'
import { api } from '@/components/career/api'
import InlineNotice, { MigrationNotice } from '@/components/career/InlineNotice'
import JobCard, { type JobCardData } from './JobCard'
import JobFilters, { DEFAULT_FILTERS, filtersToQuery, type JobFilterState } from './JobFilters'
import ScoutPanel from './ScoutPanel'
import AddByUrl from './AddByUrl'
import DirectionCard, { type DirectionStatus } from './DirectionCard'
import { directionDirty, directionPatch } from './direction'

const PAGE = 25

interface JobsResponse {
  jobs: JobCardData[]
  total: number
  filters: { role_families: string[]; tiers: number[]; statuses: string[] }
}

interface Counts {
  open: number
  saved: number
  warm: number
}

export default function JobsPage() {
  return (
    <Suspense fallback={<p className="p-8 text-sm text-slate-500">Loading…</p>}>
      <JobsView />
    </Suspense>
  )
}

function JobsView() {
  // `?search=` lets the watchlist link to one company's jobs; every other filter starts at its default.
  const initialSearch = useSearchParams().get('search') ?? ''
  const [mission, setMission] = useState<CareerMission | null>(null)
  const [filters, setFilters] = useState<JobFilterState>(initialSearch ? { ...DEFAULT_FILTERS, search: initialSearch } : DEFAULT_FILTERS)
  const [offset, setOffset] = useState(0)
  const [data, setData] = useState<JobsResponse | null>(null)
  const [counts, setCounts] = useState<Counts | null>(null)
  const [bankEmpty, setBankEmpty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [migrationMissing, setMigrationMissing] = useState(false)
  const [scouting, setScouting] = useState(false)
  // The direction draft lives here, not in the card: Scout now must be able to
  // save it first, so a run never plans from text the founder has not stored.
  const [direction, setDirection] = useState('')
  const [directionTouched, setDirectionTouched] = useState(false)
  const [directionSaving, setDirectionSaving] = useState(false)
  const [directionStatus, setDirectionStatus] = useState<DirectionStatus | null>(null)

  const loadJobs = useCallback(async () => {
    setLoading(true)
    const r = await api<JobsResponse>(`/api/career/jobs?${filtersToQuery(filters, PAGE, offset)}`)
    setLoading(false)
    if (!r.ok) {
      setMigrationMissing(r.migrationMissing)
      setError(r.error)
      setData(null)
      return
    }
    setError(null)
    setData(r.data)
  }, [filters, offset])

  // Header counts and the "do you have a bank yet?" check. Cheap (limit=1
  // reads carry `total`), and independent of the current filters.
  const loadContext = useCallback(async () => {
    const [m, open, saved, warm, bank] = await Promise.all([
      api<{ missions: CareerMission[]; activeId: string | null }>('/api/career/missions'),
      api<JobsResponse>('/api/career/jobs?freshness=likely&disposition=new,saved&limit=1'),
      api<JobsResponse>('/api/career/jobs?freshness=any&disposition=saved&limit=1'),
      api<JobsResponse>('/api/career/jobs?freshness=likely&disposition=new,saved&hasWarmPath=1&limit=200'),
      api<{ counts?: { experiences: number; facts: number } }>('/api/career/evidence'),
    ])
    if (m.ok && m.data) {
      const active = m.data.missions.find((x) => x.id === m.data!.activeId) ?? m.data.missions[0] ?? null
      setMission(active)
      // Only seed the textarea from the server while it is untouched; a reload after a
      // scout run must not overwrite what the founder is typing.
      setDirectionTouched((touched) => {
        if (!touched) setDirection(active?.preferences.direction ?? '')
        return touched
      })
    }
    if (open.ok && saved.ok && warm.ok) {
      setCounts({ open: open.data?.total ?? 0, saved: saved.data?.total ?? 0, warm: warm.data?.jobs.length ?? 0 })
    }
    if (bank.ok && bank.data?.counts) setBankEmpty(bank.data.counts.experiences === 0 && bank.data.counts.facts === 0)
  }, [])

  useEffect(() => {
    loadJobs()
  }, [loadJobs])
  useEffect(() => {
    loadContext()
  }, [loadContext])

  function changeFilters(next: JobFilterState) {
    setOffset(0)
    setFilters(next)
  }

  const directionIsDirty = mission ? directionDirty(direction, mission.preferences.direction) : false

  /** PATCH only preferences.direction (the store merges it over the stored row). Resolves true on success. */
  async function saveDirection(): Promise<boolean> {
    if (!mission) return false
    setDirectionSaving(true)
    setDirectionStatus(null)
    const r = await api<{ mission: CareerMission }>(`/api/career/missions/${mission.id}`, {
      method: 'PATCH',
      json: directionPatch(direction),
    })
    setDirectionSaving(false)
    if (!r.ok || !r.data?.mission) {
      setDirectionStatus({ kind: 'error', text: r.error ?? 'Save failed' })
      return false
    }
    // The server's copy is the truth: ScoutPanel and the header read it from here.
    setMission(r.data.mission)
    setDirection(r.data.mission.preferences.direction ?? '')
    setDirectionTouched(false)
    setDirectionStatus({ kind: 'ok', text: 'Saved — leads the next Scout run' })
    return true
  }

  /** Scout now: save an unsaved direction first; on failure show the error and stay closed. */
  async function openScout() {
    if (scouting) return setScouting(false)
    if (directionIsDirty && !(await saveDirection())) return
    setScouting(true)
  }

  function patchJob(id: string, patch: Partial<JobCardData>) {
    setData((prev) => (prev ? { ...prev, jobs: prev.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)) } : prev))
  }

  const total = data?.total ?? 0
  const jobs = data?.jobs ?? []

  return (
    <div className="p-8 max-w-6xl">
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Jobs</h1>
          <p className="text-sm text-slate-500 mt-1">
            Mission:{' '}
            <Link href="/dashboard/jobs/mission" className="text-indigo-600 hover:underline font-medium">
              {mission?.name ?? 'default'}
            </Link>
            {counts && (
              <>
                {' '}
                · <strong className="text-slate-700">{counts.open}</strong> open · <strong className="text-slate-700">{counts.saved}</strong> saved ·{' '}
                <strong className="text-slate-700">{counts.warm}</strong> with a warm path
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/dashboard/companies" className="text-sm text-slate-600 hover:text-slate-900">
            Companies
          </Link>
          <Link href="/dashboard/applications" className="text-sm text-slate-600 hover:text-slate-900">
            Applications
          </Link>
          <button
            type="button"
            onClick={openScout}
            disabled={migrationMissing || directionSaving}
            className="px-3 py-1.5 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
          >
            {directionSaving ? 'Saving…' : 'Scout now'}
          </button>
        </div>
      </div>

      {migrationMissing && (
        <div className="mb-4">
          <MigrationNotice />
        </div>
      )}
      {error && !migrationMissing && (
        <div className="mb-4">
          <InlineNotice kind="error">{error}</InlineNotice>
        </div>
      )}
      {bankEmpty && !migrationMissing && (
        <div className="mb-4">
          <InlineNotice kind="warn">
            The Evidence Bank is empty, so nothing can be ranked or tailored yet.{' '}
            <Link href="/dashboard/evidence" className="underline font-medium">
              Import your résumé
            </Link>{' '}
            first.
          </InlineNotice>
        </div>
      )}

      <div className="mb-4">
        <DirectionCard
          value={direction}
          onChange={(v) => {
            setDirection(v)
            setDirectionTouched(true)
            setDirectionStatus(null)
          }}
          onSave={saveDirection}
          dirty={directionIsDirty}
          saving={directionSaving}
          disabled={migrationMissing || !mission}
          status={directionStatus}
        />
      </div>

      {scouting && (
        <div className="mb-4">
          <ScoutPanel
            missionId={mission?.id ?? null}
            direction={mission?.preferences.direction}
            onFinished={() => {
              loadJobs()
              loadContext()
            }}
            onClose={() => setScouting(false)}
          />
        </div>
      )}

      <div className="mb-4">
        <AddByUrl
          onAdded={() => {
            loadJobs()
            loadContext()
          }}
        />
      </div>

      <div className="mb-4">
        <JobFilters value={filters} onChange={changeFilters} roleFamilies={data?.filters.role_families ?? []} tiers={data?.filters.tiers ?? []} />
      </div>

      {loading && !data ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : jobs.length === 0 && !error ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
          <p className="text-slate-700 font-medium">{total === 0 && filters === DEFAULT_FILTERS ? 'No jobs yet.' : 'Nothing matches these filters.'}</p>
          <p className="text-sm text-slate-500 mt-1">
            {total === 0 && filters === DEFAULT_FILTERS
              ? 'Press Scout now to plan a search from what you’re scouting for and your mission, check watched companies and search the web — or paste a posting URL above.'
              : 'Loosen the freshness or disposition filter, or reset.'}
          </p>
        </div>
      ) : (
        <>
          <p className="text-xs text-slate-500 mb-2">
            {total} job{total === 1 ? '' : 's'}
            {loading ? ' · refreshing…' : ''}
            {(filters.hasWarmPath || filters.state) && ' · counts are per page when filtering by warm path or state'}
          </p>
          <div className="space-y-3">
            {jobs.map((j) => (
              <JobCard key={j.id} job={j} onChange={(p) => patchJob(j.id, p)} onReranked={loadJobs} />
            ))}
          </div>
          <div className="mt-4 flex items-center justify-between text-xs text-slate-500">
            <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} className="px-2 py-1 rounded border border-slate-200 disabled:opacity-40">
              ← Previous
            </button>
            <span>
              {offset + 1}–{Math.min(offset + PAGE, offset + jobs.length)} of {total}
            </span>
            <button type="button" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)} className="px-2 py-1 rounded border border-slate-200 disabled:opacity-40">
              Next →
            </button>
          </div>
        </>
      )}

      <p className="mt-8 text-xs text-slate-400">
        Why did a run cost that?{' '}
        <Link href="/dashboard/runs" className="text-slate-500 hover:text-slate-900 underline">
          Runs
        </Link>
      </p>
    </div>
  )
}
