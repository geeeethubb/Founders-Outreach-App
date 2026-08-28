'use client'

// The company watchlist: who the scout checks first, and what it found there
// last time. Three states, one line to explain them. Every edit is a PATCH
// and the row re-renders from the answer.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { api } from '@/components/career/api'
import InlineNotice, { MigrationNotice } from '@/components/career/InlineNotice'
import CompanyRow, { WATCH_STATUSES, type CompanyView } from './CompanyRow'
import AddCompanyForm from './AddCompanyForm'

const STATUS_META: Record<string, { title: string; hint: string }> = {
  opening_available: { title: 'Opening available', hint: 'an internship is open right now' },
  target: { title: 'Target', hint: 'you want to work here — checked first, every scout run' },
  watching: { title: 'Watching', hint: 'worth checking periodically' },
}

export default function CompaniesPage() {
  const [companies, setCompanies] = useState<CompanyView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [migrationMissing, setMigrationMissing] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const r = await api<{ companies: CompanyView[] }>('/api/career/companies')
    setLoading(false)
    if (!r.ok || !r.data) {
      setMigrationMissing(r.migrationMissing)
      setError(r.error)
      return
    }
    setError(null)
    setCompanies(r.data.companies)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  function patchRow(id: string, p: Partial<CompanyView>) {
    setCompanies((cs) => (cs ? cs.map((c) => (c.id === id ? { ...c, ...p } : c)) : cs))
  }

  const rows = companies ?? []
  const byPriority = (a: CompanyView, b: CompanyView) => (a.watch_priority ?? 99) - (b.watch_priority ?? 99) || a.name.localeCompare(b.name)
  const groups = ['opening_available', 'target', 'watching'].map((s) => ({ status: s, rows: rows.filter((c) => (c.watch_status ?? 'target') === s).sort(byPriority) }))
  const other = rows.filter((c) => !WATCH_STATUSES.includes((c.watch_status ?? 'target') as (typeof WATCH_STATUSES)[number]))

  return (
    <div className="p-8 max-w-5xl">
      <div className="flex items-start justify-between gap-4 mb-2">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Companies</h1>
          <p className="text-sm text-slate-500 mt-1">
            The watchlist the scout checks before it searches the web.{' '}
            <Link href="/dashboard/jobs" className="text-indigo-600 hover:underline">
              Jobs
            </Link>
          </p>
        </div>
        {!migrationMissing && <AddCompanyForm onAdded={load} />}
      </div>
      <p className="text-xs text-slate-500 mb-5">
        <strong className="text-slate-700">Target</strong> — you want to work here · <strong className="text-slate-700">Watching</strong> — worth checking ·{' '}
        <strong className="text-slate-700">Opening available</strong> — an internship is open now. Ignore removes a company from every run.
      </p>

      {migrationMissing && <MigrationNotice />}
      {error && !migrationMissing && <InlineNotice kind="error">{error}</InlineNotice>}

      {loading && !companies ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : companies && rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
          <p className="text-slate-700 font-medium">Nothing watched yet.</p>
          <p className="text-sm text-slate-500 mt-1">Add the companies you want to work at, or run Scout — it seeds the watchlist from its own plan.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map((g) =>
            g.rows.length === 0 ? null : (
              <section key={g.status}>
                <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
                  {STATUS_META[g.status].title} <span className="text-slate-400">· {g.rows.length}</span>
                  <span className="ml-2 normal-case font-normal tracking-normal text-slate-400">{STATUS_META[g.status].hint}</span>
                </h2>
                <div className="space-y-2">
                  {g.rows.map((c) => (
                    <CompanyRow key={c.id} company={c} onChange={(p) => patchRow(c.id, p)} onRemoved={() => setCompanies((cs) => (cs ? cs.filter((x) => x.id !== c.id) : cs))} />
                  ))}
                </div>
              </section>
            )
          )}
          {other.length > 0 && (
            <section>
              <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Other</h2>
              <div className="space-y-2">
                {other.map((c) => (
                  <CompanyRow key={c.id} company={c} onChange={(p) => patchRow(c.id, p)} onRemoved={() => setCompanies((cs) => (cs ? cs.filter((x) => x.id !== c.id) : cs))} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  )
}
