'use client'

// The company list: inspiration and memory, not the search universe.
//
// Most rows here are the scout's guesses. A few are the user's own decisions,
// and only those are preferences — so the page is organised by intent, with
// Explore kept plainly separate from Targets and Watching, and one click to
// promote or reject. A confirmed opening comes first because it is state: a
// careers check found a role open right now, whatever the user thinks of the
// company. Postings merely stored against a company are not that, and do not
// lift it above the founder's own targets.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { api } from '@/components/career/api'
import InlineNotice, { MigrationNotice } from '@/components/career/InlineNotice'
import CompanyRow from './CompanyRow'
import AddCompanyForm from './AddCompanyForm'
import { COLLAPSED_ROWS, groupCompanies, intentOf, WATCHLIST_LEAD, type CompanySection, type CompanyView } from './company-view'

export default function CompaniesPage() {
  const [companies, setCompanies] = useState<CompanyView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [migrationMissing, setMigrationMissing] = useState(false)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  /**
   * How many rows an agent had written as target/watching that this read shows
   * as Explore instead. The list route answers it; it is 0 once migration 016
   * has rewritten them, and absent on a route that does not report it.
   */
  const [reinterpreted, setReinterpreted] = useState(0)

  const load = useCallback(async () => {
    setLoading(true)
    const r = await api<{ companies: CompanyView[]; reinterpreted?: number }>('/api/career/companies')
    setLoading(false)
    if (!r.ok || !r.data) {
      setMigrationMissing(r.migrationMissing)
      setError(r.error)
      return
    }
    setError(null)
    setCompanies(r.data.companies)
    setReinterpreted(typeof r.data.reinterpreted === 'number' ? r.data.reinterpreted : 0)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  function patchRow(id: string, p: Partial<CompanyView>) {
    setCompanies((cs) => (cs ? cs.map((c) => (c.id === id ? { ...c, ...p } : c)) : cs))
  }

  const rows = companies ?? []
  const sections = groupCompanies(rows).filter((s) => s.rows.length > 0)
  const chosen = rows.filter((c) => intentOf(c) === 'target' || intentOf(c) === 'watching').length

  return (
    <div className="p-8 max-w-5xl">
      <div className="flex items-start justify-between gap-4 mb-2">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Companies</h1>
          <p className="text-sm text-slate-500 mt-1">
            {WATCHLIST_LEAD}{' '}
            <Link href="/dashboard/jobs" className="text-indigo-600 hover:underline">
              Jobs
            </Link>
          </p>
        </div>
        {!migrationMissing && <AddCompanyForm onAdded={load} />}
      </div>
      <p className="text-xs text-slate-500 mb-5">
        <strong className="text-slate-700">Target</strong> — you want to work here, checked first every run ·{' '}
        <strong className="text-slate-700">Watching</strong> — keep an eye on it · <strong className="text-slate-700">Explore</strong> — Scout&apos;s idea,
        not yours yet · <strong className="text-slate-700">Ignore</strong> — left out of every run, and reversible from the Ignored section.
        {rows.length > 0 && (
          <>
            {' '}
            You have chosen <strong className="text-slate-700">{chosen}</strong> of {rows.length}.
          </>
        )}
      </p>

      {migrationMissing && <MigrationNotice />}
      {error && !migrationMissing && <InlineNotice kind="error">{error}</InlineNotice>}
      {reinterpreted > 0 && (
        <div className="mb-4">
          <InlineNotice kind="warn">
            <strong>{reinterpreted}</strong> compan{reinterpreted === 1 ? 'y is' : 'ies are'} shown under Explore because a scout run — not you — put{' '}
            {reinterpreted === 1 ? 'it' : 'them'} on this list. Promote the ones you actually want; the rest stay suggestions.
          </InlineNotice>
        </div>
      )}

      {loading && !companies ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : companies && rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
          <p className="text-slate-700 font-medium">No companies yet.</p>
          <p className="text-sm text-slate-500 mt-1">Add the companies you want to work at, or run Scout — it proposes places worth a look and you decide which ones matter.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {sections.map((s) => (
            <Section key={s.key} section={s} expanded={!!expanded[s.key]} onToggle={() => setExpanded((e) => ({ ...e, [s.key]: !e[s.key] }))} onChange={patchRow} />
          ))}
        </div>
      )}
    </div>
  )
}

function Section({
  section,
  expanded,
  onToggle,
  onChange,
}: {
  section: CompanySection
  expanded: boolean
  onToggle: () => void
  onChange: (id: string, p: Partial<CompanyView>) => void
}) {
  const collapsed = section.collapsible && !expanded && section.rows.length > COLLAPSED_ROWS
  const shown = collapsed ? section.rows.slice(0, COLLAPSED_ROWS) : section.rows
  return (
    <section>
      <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
        {section.title} <span className="text-slate-400">· {section.rows.length}</span>
        <span className="ml-2 normal-case font-normal tracking-normal text-slate-400">{section.hint}</span>
      </h2>
      <div className="space-y-2">
        {shown.map((c) => (
          <CompanyRow key={c.id} company={c} onChange={(p) => onChange(c.id, p)} />
        ))}
      </div>
      {section.collapsible && section.rows.length > COLLAPSED_ROWS && (
        <button type="button" onClick={onToggle} className="mt-2 text-xs text-indigo-600 hover:underline">
          {collapsed ? `Show all ${section.rows.length}` : `Show fewer`}
        </button>
      )}
    </section>
  )
}
