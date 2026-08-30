'use client'

// The application tracker.
//
// One row per job being pursued, grouped by state. Transitions are server
// round-trips validated by lib/career/applications/states.ts — the buttons
// offer only the moves the table allows from the current state, so an
// impossible move is not a click away.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import ApplicationRow, { type ApplicationView } from './ApplicationRow'

type Labels = Record<string, string>
type Transitions = Record<string, string[]>

const GROUPS: { title: string; states: string[] }[] = [
  { title: 'In progress', states: ['APPLIED', 'OA', 'INTERVIEW', 'FINAL_ROUND', 'OFFER'] },
  { title: 'Preparing', states: ['PREPARING', 'READY_FOR_REVIEW', 'READY_TO_APPLY'] },
  { title: 'Tracked', states: ['DISCOVERED', 'SAVED', 'RESEARCHED'] },
  { title: 'Closed', states: ['REJECTED', 'WITHDRAWN', 'CLOSED'] },
]

export default function ApplicationsPage() {
  const [rows, setRows] = useState<ApplicationView[]>([])
  const [labels, setLabels] = useState<Labels>({})
  const [transitions, setTransitions] = useState<Transitions>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [migrationMissing, setMigrationMissing] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/career/applications')
      const data = await res.json()
      if (!res.ok) {
        setMigrationMissing(Boolean(data.migrationMissing))
        setError(data.error ?? 'Failed to load applications')
        setRows([])
        return
      }
      setRows(data.applications ?? [])
      setLabels(data.labels ?? {})
      setTransitions(data.transitions ?? {})
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load applications')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function patch(id: string, body: Record<string, unknown>): Promise<string | null> {
    const res = await fetch(`/api/career/applications/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!res.ok) return data.error ?? 'Update failed'
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...data.application } : r)))
    return null
  }

  const counts = GROUPS.map((g) => rows.filter((r) => g.states.includes(r.state)).length)

  return (
    <div className="p-8 max-w-6xl">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Applications</h1>
          <p className="text-sm text-slate-500 mt-1">
            Every job you are pursuing, what was submitted, and where it stands. Nothing here submits anything —
            you apply through the company&apos;s link and record it.
          </p>
        </div>
        <Link href="/dashboard/jobs" className="text-sm text-indigo-600 hover:text-indigo-500 font-medium">
          Find jobs →
        </Link>
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {migrationMissing
            ? 'The Career OS tables do not exist yet. Apply supabase/migrations/014_career_os.sql in the Supabase SQL editor, then reload.'
            : error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : rows.length === 0 && !error ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
          <p className="text-slate-700 font-medium">No applications yet.</p>
          <p className="text-sm text-slate-500 mt-1">
            Generate a package or press Track this job on a job&apos;s Application tab (from <Link href="/dashboard/jobs" className="text-indigo-600">Jobs</Link>) and it appears here.
            The card&apos;s Save only shortlists.
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {GROUPS.map((g, i) => {
            const group = rows.filter((r) => g.states.includes(r.state))
            if (group.length === 0) return null
            return (
              <section key={g.title}>
                <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">
                  {g.title} <span className="text-slate-400 font-normal">· {counts[i]}</span>
                </h2>
                <div className="space-y-3">
                  {group.map((r) => (
                    <ApplicationRow
                      key={r.id}
                      row={r}
                      labels={labels}
                      allowed={transitions[r.state] ?? []}
                      onPatch={patch}
                    />
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
