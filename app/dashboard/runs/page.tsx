'use client'

// Developer view of Career OS runs. "Why did this run cost that?" is answered
// here and nowhere else: every agent call is traced to a run (CLAUDE.md
// principle 12 applied to money), and this page just lays the rows out.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { api, fmtUsd } from '@/components/career/api'
import InlineNotice, { MigrationNotice } from '@/components/career/InlineNotice'
import RunRow, { type RunView } from './RunRow'

const KINDS: { value: string; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'job_scout', label: 'Job scouts' },
  { value: 'job_verify', label: 'Verifications' },
  { value: 'package', label: 'Packages' },
  { value: 'evidence_import', label: 'Evidence imports' },
]

export default function RunsPage() {
  const [kind, setKind] = useState<string>('')
  const [limit, setLimit] = useState(20)
  const [runs, setRuns] = useState<RunView[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [migrationMissing, setMigrationMissing] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const q = new URLSearchParams({ limit: String(limit) })
    if (kind) q.set('kind', kind)
    const r = await api<{ runs: RunView[] }>(`/api/career/runs?${q}`)
    setLoading(false)
    if (!r.ok || !r.data) {
      setMigrationMissing(r.migrationMissing)
      setError(r.error)
      return
    }
    setError(null)
    setRuns(r.data.runs)
  }, [kind, limit])

  useEffect(() => {
    load()
  }, [load])

  const total = (runs ?? []).reduce((s, r) => s + r.cost_usd, 0)

  return (
    <div className="p-8 max-w-5xl">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Runs</h1>
          <p className="text-sm text-slate-500 mt-1">
            Career OS runs only (job scouts, verifications, packages, evidence imports) with the agent calls that made each cost what it did. People-search Scout runs are not listed here.{' '}
            <Link href="/dashboard/jobs" className="text-indigo-600 hover:underline">
              Jobs
            </Link>
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <select value={kind} onChange={(e) => setKind(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1">
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} className="rounded-md border border-slate-300 px-2 py-1">
            {[20, 50, 100].map((n) => (
              <option key={n} value={n}>
                last {n}
              </option>
            ))}
          </select>
          <button type="button" onClick={load} disabled={loading} className="px-2 py-1 rounded-md border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {migrationMissing && <MigrationNotice />}
      {error && !migrationMissing && <InlineNotice kind="error">{error}</InlineNotice>}

      {runs && (
        <>
          <p className="text-xs text-slate-500 mb-2">
            {runs.length} run{runs.length === 1 ? '' : 's'} shown · {fmtUsd(total)} in agent calls · {runs.filter((r) => r.status === 'failed').length} failed
          </p>
          {runs.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
              <p className="text-slate-700 font-medium">No runs yet.</p>
              <p className="text-sm text-slate-500 mt-1">Scout, verify a job, import a résumé or generate a package and it shows up here.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {runs.map((r) => (
                <RunRow key={r.id} run={r} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
