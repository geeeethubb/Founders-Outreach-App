'use client'

// The main view: every job the scout found, ranked by fit, answering at a
// glance whether it is worth a package. Everything on screen is server-derived
// — a refresh shows the same decisions, because none of them live here.

import { Suspense, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import type { CareerMission, DirectionMode } from '@/lib/career/types'
import { missionDirectionMode } from '@/lib/career/types'
import { api } from '@/components/career/api'
import InlineNotice, { MigrationNotice } from '@/components/career/InlineNotice'
import { loadScoutReadiness, readinessBlocks, readinessBlockText, type ReadinessState } from '@/components/career/ReadinessBanner'
import JobCard, { type JobCardData } from './JobCard'
import JobFilters, { DEFAULT_FILTERS, filtersToQuery, isDefaultFilters, type JobFilterState } from './JobFilters'
import ScoutPanel, { readScoutEnvironment } from './ScoutPanel'
import RunResults from './RunResults'
import AddByUrl from './AddByUrl'
import DirectionCard, { type DirectionStatus } from './DirectionCard'
import { directionDialDirty, directionModeFor, directionPatch } from './direction'

// 50 rows a page: at 400 postings, 25 makes sixteen pages of scrolling.
const PAGE = 50

interface JobsResponse {
  jobs: JobCardData[]
  /** How many postings this page is drawn from — after relevance, before paging. */
  total: number
  matched?: number
  /** What the server scored, counted and hid. The header says nothing this did not. */
  relevance?: {
    filter: 'strong' | 'possible' | 'any'
    view: 'all' | 'needs_look'
    direction: string | null
    counts: { total: number; strong: number; possible: number; off: number; needsLook: number }
    headline: string
    truncated: boolean
    windowed: boolean
  }
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
  // `?run=` is a different surface entirely: one run's results, uncurated (RunResults).
  const searchParams = useSearchParams()
  const initialSearch = searchParams.get('search') ?? ''
  const runParam = searchParams.get('run')
  const [mission, setMission] = useState<CareerMission | null>(null)
  /** A run still going when the page loaded — the monitor picks it back up, and it is cleared the moment that run lands. */
  const [resumeRunId, setResumeRunId] = useState<string | null>(null)
  /** Whether a scout run outlives its request, as the server said. null = not asked yet. */
  const [scoutDurable, setScoutDurable] = useState<boolean | null>(null)
  /** Whether a run can start here at all, as the server said. Read once; the panel shows the same answer. */
  const [scoutReadiness, setScoutReadiness] = useState<ReadinessState>({ phase: 'loading' })
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
  // What that direction DOES — "search harder for this" or "only show me this".
  // Half of the dial, and the half that decides whether a paid run hides things,
  // so it is saved with the text and shown in the Scout panel before a run.
  const [directionMode, setDirectionMode] = useState<Exclude<DirectionMode, 'off'>>('boost')
  const [directionTouched, setDirectionTouched] = useState(false)
  const [directionSaving, setDirectionSaving] = useState(false)
  const [directionStatus, setDirectionStatus] = useState<DirectionStatus | null>(null)

  // The query, not the filter object: `dense` is a display choice and must not
  // cost a round trip.
  const query = filtersToQuery(filters, PAGE, offset)

  const loadJobs = useCallback(async () => {
    // In run view the list belongs to RunResults, which fetches it unfiltered.
    if (runParam) {
      setLoading(false)
      return
    }
    setLoading(true)
    const r = await api<JobsResponse>(`/api/career/jobs?${query}`)
    setLoading(false)
    if (!r.ok) {
      setMigrationMissing(r.migrationMissing)
      setError(r.error)
      setData(null)
      return
    }
    setError(null)
    setData(r.data)
  }, [query, runParam])

  // Header counts and the "do you have a bank yet?" check. Cheap (limit=1
  // reads carry `total`), and independent of the current filters.
  const loadContext = useCallback(async () => {
    const [m, open, saved, warm, bank] = await Promise.all([
      api<{ missions: CareerMission[]; activeId: string | null }>('/api/career/missions'),
      // Inventory counts, deliberately unfiltered by relevance: the header's
      // "N open" must not move when the relevance control does.
      api<JobsResponse>('/api/career/jobs?freshness=open&relevance=any&disposition=new,saved&limit=1'),
      api<JobsResponse>('/api/career/jobs?freshness=any&relevance=any&disposition=saved&limit=1'),
      api<JobsResponse>('/api/career/jobs?freshness=open&relevance=any&disposition=new,saved&hasWarmPath=1&limit=200'),
      api<{ counts?: { experiences: number; facts: number } }>('/api/career/evidence'),
    ])
    if (m.ok && m.data) {
      const active = m.data.missions.find((x) => x.id === m.data!.activeId) ?? m.data.missions[0] ?? null
      setMission(active)
      // Only seed the textarea from the server while it is untouched; a reload after a
      // scout run must not overwrite what the founder is typing.
      setDirectionTouched((touched) => {
        if (!touched) {
          setDirection(active?.preferences.direction ?? '')
          setDirectionMode(directionModeFor(active?.preferences.direction ?? '', active?.preferences.direction_mode ?? null))
        }
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

  // A run started in another tab — or before a refresh — is still the server's
  // run. Pick it back up and open the monitor on it, so the founder never has
  // to wonder whether pressing Scout again would double-spend. Only a run the
  // server itself calls queued or running is resumed.
  useEffect(() => {
    if (runParam) return
    let alive = true
    loadScoutReadiness('jobs').then((state) => {
      if (alive) setScoutReadiness(state)
    })
    readScoutEnvironment().then((env) => {
      if (!alive) return
      setScoutDurable(env.durable)
      if (!env.activeRunId) return
      setResumeRunId(env.activeRunId)
      setScouting(true)
    })
    return () => {
      alive = false
    }
  }, [runParam])

  function changeFilters(next: JobFilterState) {
    // Changing density is not changing the query — keep the reader's place.
    const onlyDensity = next.dense !== filters.dense && filtersToQuery(next, PAGE, offset) === query
    if (!onlyDensity) setOffset(0)
    setFilters(next)
  }

  const directionIsDirty = directionDialDirty(direction, directionMode, mission?.preferences)

  /** PATCH only the direction and its mode (the store merges it over the stored row). Resolves true on success. */
  async function saveDirection(): Promise<boolean> {
    if (!mission) return false
    setDirectionSaving(true)
    setDirectionStatus(null)
    const r = await api<{ mission: CareerMission }>(`/api/career/missions/${mission.id}`, {
      method: 'PATCH',
      json: directionPatch(direction, directionMode),
    })
    setDirectionSaving(false)
    if (!r.ok || !r.data?.mission) {
      setDirectionStatus({ kind: 'error', text: r.error ?? 'Save failed' })
      return false
    }
    // The server's copy is the truth: ScoutPanel and the header read it from here.
    setMission(r.data.mission)
    setDirection(r.data.mission.preferences.direction ?? '')
    setDirectionMode(directionModeFor(r.data.mission.preferences.direction ?? '', r.data.mission.preferences.direction_mode ?? null))
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

  const matched = data?.matched ?? data?.total ?? 0
  const jobs = data?.jobs ?? []
  const rel = data?.relevance ?? null

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
            {counts && !runParam && (
              <>
                {' '}
                · <strong className="text-slate-700">{counts.open}</strong> open · <strong className="text-slate-700">{counts.saved}</strong> saved ·{' '}
                <strong className="text-slate-700">{counts.warm}</strong> with a warm path
              </>
            )}
            {runParam && ' · showing one scout run'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/dashboard/companies" className="text-sm text-slate-600 hover:text-slate-900">
            Companies
          </Link>
          <Link href="/dashboard/applications" className="text-sm text-slate-600 hover:text-slate-900">
            Applications
          </Link>
          {runParam ? (
            <Link href="/dashboard/jobs" className="px-3 py-1.5 rounded-md border border-slate-300 text-slate-700 text-sm font-medium hover:bg-white">
              Back to all jobs
            </Link>
          ) : (
            <button
              type="button"
              onClick={openScout}
              // A run already going is still shown: the panel opens on it even when a new one could not start.
              disabled={migrationMissing || directionSaving || (readinessBlocks(scoutReadiness) && !scouting && !resumeRunId)}
              title={readinessBlockText(scoutReadiness) ?? undefined}
              className="px-3 py-1.5 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
            >
              {directionSaving ? 'Saving…' : 'Scout now'}
            </button>
          )}
        </div>
      </div>
      {!runParam && readinessBlocks(scoutReadiness) && !scouting && (
        <p className="-mt-3 mb-4 text-xs text-rose-700">{readinessBlockText(scoutReadiness)}</p>
      )}

      {runParam && <RunResults runId={runParam} />}

      {!runParam && (
        <>
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
          mode={directionMode}
          onModeChange={(next) => {
            setDirectionMode(next)
            setDirectionTouched(true)
            setDirectionStatus(null)
          }}
        />
      </div>

      {scouting && (
        <div className="mb-4">
          <ScoutPanel
            missionId={mission?.id ?? null}
            direction={mission?.preferences.direction}
            directionMode={mission ? missionDirectionMode(mission.preferences) : null}
            initialRunId={resumeRunId}
            durable={scoutDurable}
            readiness={scoutReadiness}
            onFinished={() => {
              loadJobs()
              loadContext()
              // The resumed run has landed. Keeping its id would re-seed a
              // remounted panel with a finished run instead of the start form.
              setResumeRunId(null)
            }}
            onClose={() => {
              setScouting(false)
              setResumeRunId(null)
            }}
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
        <JobFilters
          value={filters}
          onChange={changeFilters}
          roleFamilies={data?.filters.role_families ?? []}
          tiers={data?.filters.tiers ?? []}
          needsLook={rel?.counts.needsLook}
          direction={rel?.direction ?? mission?.preferences.direction ?? null}
        />
      </div>

      {loading && !data ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : jobs.length === 0 && !error ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
          <p className="text-slate-700 font-medium">
            {rel && rel.counts.total > 0
              ? `Nothing on direction — ${rel.counts.off} posting${rel.counts.off === 1 ? '' : 's'} are off-direction.`
              : isDefaultFilters(filters)
                ? 'No jobs yet.'
                : 'Nothing matches these filters.'}
          </p>
          <p className="text-sm text-slate-500 mt-1">
            {rel && rel.counts.total > 0
              ? 'Widen the relevance filter to “Everything”, or edit what you’re scouting for above — relevance is scored against it and nothing was deleted.'
              : isDefaultFilters(filters)
              ? 'Press Scout now to plan a search from what you’re scouting for and your mission, check watched companies and search the web — or paste a posting URL above.'
              : 'Loosen the freshness or disposition filter, or reset.'}
          </p>
        </div>
      ) : (
        <>
          {/* The one line that must never lie: how many exist, how many are
              strong, how many are on screen, and what is being hidden. */}
          <p className="text-xs text-slate-500 mb-2">
            {rel ? rel.headline : `${matched} job${matched === 1 ? '' : 's'}`}
            {filters.view === 'needs_look' && ' · needs a look'}
            {loading ? ' · refreshing…' : ''}
            {rel?.windowed && ' · warm-path / state filters narrow the first 200 by relevance, so this count is that window'}
            {rel?.truncated && ' · more postings exist than one census reads'}
          </p>
          <div className={filters.dense ? 'space-y-1.5' : 'space-y-3'}>
            {jobs.map((j) => (
              <JobCard key={j.id} job={j} onChange={(p) => patchJob(j.id, p)} onReranked={loadJobs} dense={filters.dense} />
            ))}
          </div>
          <div className="mt-4 flex items-center justify-between text-xs text-slate-500">
            <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} className="px-2 py-1 rounded border border-slate-200 disabled:opacity-40">
              ← Previous
            </button>
            <span>
              {offset + 1}–{offset + jobs.length} of {matched}
            </span>
            <button type="button" disabled={offset + PAGE >= matched} onClick={() => setOffset(offset + PAGE)} className="px-2 py-1 rounded border border-slate-200 disabled:opacity-40">
              Next →
            </button>
          </div>
        </>
      )}
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
