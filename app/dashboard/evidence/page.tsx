'use client'

import { useCallback, useEffect, useState } from 'react'
import { approveRows, Notice, type BankResponse } from './shared'
import ExperiencesTab from './ExperiencesTab'
import SkillsTab from './SkillsTab'
import StoriesTab from './StoriesTab'
import PreferencesTab from './PreferencesTab'
import DocumentsTab from './DocumentsTab'
import CanonicalTab from './CanonicalTab'
import ReviewTab, { fetchReview, reviewCount, type ReviewResponse } from './ReviewTab'

type Tab = 'canonical' | 'experiences' | 'skills' | 'stories' | 'preferences' | 'documents' | 'review'

const TABS: { id: Tab; label: string }[] = [
  { id: 'canonical', label: 'Canonical' },
  { id: 'experiences', label: 'Experiences' },
  { id: 'skills', label: 'Skills' },
  { id: 'stories', label: 'Stories' },
  { id: 'preferences', label: 'Preferences' },
  { id: 'documents', label: 'Documents' },
  { id: 'review', label: 'Review' },
]

export default function EvidencePage() {
  const [data, setData] = useState<BankResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('canonical')
  const [review, setReview] = useState<ReviewResponse | null>(null)
  const [approvingAll, setApprovingAll] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/career/evidence')
      const body = (await res.json()) as BankResponse & { error?: string }
      if (!res.ok && !body.migrationMissing) throw new Error(body.error || `Failed (${res.status})`)
      setData(body)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  // The Review tab's count, fetched once; the tab itself refetches after every action.
  useEffect(() => {
    let cancelled = false
    fetchReview().then((r) => { if (!cancelled) setReview(r) }).catch(() => { /* the tab shows its own error */ })
    return () => { cancelled = true }
  }, [])

  async function approveAll() {
    if (!data) return
    setApprovingAll(true)
    setNotice(null)
    try {
      const b = data.bank
      let n = 0
      n += await approveRows('evidence_experiences', b.experiences.filter((x) => !x.approved).map((x) => x.id), true)
      n += await approveRows('evidence_facts', b.facts.filter((x) => !x.approved).map((x) => x.id), true)
      n += await approveRows('evidence_metrics', b.metrics.filter((x) => !x.approved).map((x) => x.id), true)
      n += await approveRows('evidence_deliverables', b.deliverables.filter((x) => !x.approved).map((x) => x.id), true)
      n += await approveRows('evidence_skills', b.skills.filter((x) => !x.approved).map((x) => x.id), true)
      n += await approveRows('evidence_stories', b.stories.filter((x) => !x.approved).map((x) => x.id), true)
      setNotice(`Approved ${n} rows.`)
      await reload()
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Approve failed')
    } finally {
      setApprovingAll(false)
    }
  }

  const counts = data?.counts
  const empty = data && !data.migrationMissing && counts && counts.experiences === 0 && counts.facts === 0

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Evidence</h1>
          <p className="mt-1 text-sm text-slate-600">
            Everything the résumé tailor and cover letter are allowed to argue from. Imported rows wait here until you approve them.
          </p>
        </div>
        {counts && (
          <div className="flex flex-wrap gap-3 text-xs text-slate-600">
            <Stat label="experiences" value={counts.experiences} />
            <Stat label="bullets" value={counts.bullets} />
            <Stat label="facts" value={`${counts.factsApproved}/${counts.facts}`} hint="approved / total" />
            <Stat label="metrics" value={counts.metrics} />
            <Stat label="skills" value={counts.skills} />
            <Stat label="stories" value={counts.stories} />
          </div>
        )}
      </div>

      {error && <div className="mb-4"><Notice kind="error">{error}</Notice></div>}
      {notice && <div className="mb-4"><Notice kind="info">{notice}</Notice></div>}

      {data?.migrationMissing && (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          The Evidence Bank is not set up yet — run <code className="rounded bg-white px-1">npm run career:seed -- --approve</code> (it tells you if the database needs a migration first).
        </div>
      )}

      {empty && (
        <div className="mb-6 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
          <div className="font-medium text-slate-900">Nothing here yet.</div>
          <p className="mt-1">
            Run <code className="rounded bg-white px-1">npm run career:seed</code> to import the master résumé, or upload a .docx under
            the Documents tab. Imported facts arrive pending; approve them once you have read them.
          </p>
        </div>
      )}

      {counts && counts.pending > 0 && (
        <div className="mb-6 flex items-center justify-between rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-900">
          <span>
            <span className="font-medium">Pending approval: {counts.pending}</span> — nothing pending is usable by the tailor.
          </span>
          <button
            type="button"
            onClick={approveAll}
            disabled={approvingAll}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {approvingAll ? 'Approving…' : 'Approve all'}
          </button>
        </div>
      )}

      <div className="mb-6 flex gap-1 border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
              tab === t.id ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            {t.id === 'review' && review ? `Review (${reviewCount(review)})` : t.label}
          </button>
        ))}
      </div>

      {loading && !data ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : data ? (
        <>
          {tab === 'canonical' && <CanonicalTab key={data.counts?.pending ?? 0} onExperiences={() => setTab('experiences')} />}
          {tab === 'experiences' && <ExperiencesTab bank={data.bank} reload={reload} />}
          {tab === 'skills' && <SkillsTab bank={data.bank} reload={reload} />}
          {tab === 'stories' && <StoriesTab bank={data.bank} reload={reload} />}
          {tab === 'preferences' && <PreferencesTab bank={data.bank} reload={reload} />}
          {tab === 'documents' && <DocumentsTab bank={data.bank} reload={reload} />}
          {tab === 'review' && <ReviewTab initial={review} onChanged={setReview} />}
        </>
      ) : null}
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5" title={hint}>
      <div className="text-base font-semibold text-slate-900">{value}</div>
      <div>{label}</div>
    </div>
  )
}
