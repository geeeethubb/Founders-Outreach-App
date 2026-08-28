'use client'

// The job detail: seven sections, one job. The detail route answers with bare
// rows; the package view (when a package exists) answers with resolved text.
// Both are loaded here and handed down — every tab is a pure render of what
// the server said, so a refresh never loses a decision.

import { Suspense, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import type { Application } from '@/lib/career/types'
import { api } from '@/components/career/api'
import type { IntelligenceResponse, JobDetail, PackageView } from '@/components/career/packageTypes'
import FitBadge, { EligibilityChip } from '@/components/career/FitBadge'
import StateBadge from '@/components/career/StateBadge'
import VerificationBadge, { type VerifyOutcome } from '@/components/career/VerificationBadge'
import InlineNotice, { MigrationNotice } from '@/components/career/InlineNotice'
import JobTab from './JobTab'
import FitTab from './FitTab'
import ResearchTab from './ResearchTab'
import EvidenceTab from './EvidenceTab'
import WarmPathsTab from './WarmPathsTab'
import PackagePanel from './PackagePanel'
import ApplicationTab from './ApplicationTab'

const TABS = [
  { id: 'job', label: 'Job' },
  { id: 'fit', label: 'Fit' },
  { id: 'research', label: 'Company research' },
  { id: 'evidence', label: 'Your evidence' },
  { id: 'paths', label: 'Warm paths' },
  { id: 'package', label: 'Package' },
  { id: 'application', label: 'Application' },
] as const
type TabId = (typeof TABS)[number]['id']

type Force = { research?: boolean; fit?: boolean; match?: boolean; paths?: boolean }

export default function JobDetailPage({ params }: { params: { id: string } }) {
  return (
    <Suspense fallback={<p className="p-8 text-sm text-slate-500">Loading…</p>}>
      <JobDetail id={params.id} />
    </Suspense>
  )
}

function JobDetail({ id }: { id: string }) {
  const router = useRouter()
  const search = useSearchParams()
  const tabParam = search.get('tab')
  const tab: TabId = (TABS.find((t) => t.id === tabParam)?.id ?? 'job') as TabId

  const [detail, setDetail] = useState<JobDetail | null>(null)
  const [view, setView] = useState<PackageView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [migrationMissing, setMigrationMissing] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const [intel, setIntel] = useState<IntelligenceResponse | null>(null)
  const [intelBusy, setIntelBusy] = useState(false)
  const [intelError, setIntelError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const r = await api<JobDetail>(`/api/career/jobs/${id}`)
    setLoading(false)
    if (!r.ok || !r.data) {
      setMigrationMissing(r.migrationMissing)
      setNotFound(r.status === 404)
      setError(r.error)
      return
    }
    setError(null)
    setDetail(r.data)
    // The newest package carries the resolved view (statements, labels, letter, documents).
    const latest = r.data.packages[0]
    if (latest) {
      const v = await api<PackageView>(`/api/career/packages/${latest.id}`)
      setView(v.ok ? v.data : null)
    } else {
      setView(null)
    }
  }, [id])

  useEffect(() => {
    load()
  }, [load])

  function setTab(next: TabId) {
    router.replace(`/dashboard/jobs/${id}?tab=${next}`)
  }

  /** One intelligence call serves four tabs; the force flags say which judgment to redo. */
  async function runIntelligence(force: Force) {
    setIntelBusy(true)
    setIntelError(null)
    const r = await api<IntelligenceResponse>(`/api/career/jobs/${id}/intelligence`, { json: { force } })
    setIntelBusy(false)
    if (!r.ok || !r.data) {
      setIntelError(r.error)
      return
    }
    setIntel(r.data)
    if (r.data.errors?.length) setIntelError(r.data.errors.join(' · '))
    await load()
  }

  function onVerified(o: VerifyOutcome) {
    setDetail((d) =>
      d
        ? {
            ...d,
            job: { ...d.job, verification_status: o.status as JobDetail['job']['verification_status'], verification_note: o.note, last_verified_at: o.last_verified_at },
          }
        : d
    )
  }

  function onApplicationChanged(a: Application) {
    setDetail((d) => (d ? { ...d, application: a } : d))
  }

  if (loading) return <p className="p-8 text-sm text-slate-500">Loading…</p>

  if (!detail) {
    return (
      <div className="p-8 max-w-4xl space-y-4">
        <Link href="/dashboard/jobs" className="text-sm text-slate-500 hover:text-slate-900">
          ← Jobs
        </Link>
        {migrationMissing ? (
          <MigrationNotice />
        ) : notFound ? (
          <InlineNotice kind="warn">This job does not exist or is not yours.</InlineNotice>
        ) : (
          <InlineNotice kind="error">{error ?? 'Could not load the job.'}</InlineNotice>
        )}
      </div>
    )
  }

  const j = detail.job
  const fit = view?.fit ?? detail.fit ?? null
  const research = view?.company_research ?? null

  return (
    <div className="p-8 max-w-6xl">
      <Link href="/dashboard/jobs" className="text-sm text-slate-500 hover:text-slate-900">
        ← Jobs
      </Link>

      <div className="mt-2 mb-5 flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-slate-900">{j.title}</h1>
          <p className="text-sm text-slate-600 mt-0.5">
            {j.company_name}
            {j.location_raw ? ` · ${j.location_raw}` : ''}
            {j.location_tier ? ` · tier ${j.location_tier}` : ''}
          </p>
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <FitBadge band={fit?.band} overall={fit?.overall} adjustment={fit?.feedback_adjustment} />
            <EligibilityChip value={fit?.eligibility} />
            <VerificationBadge status={j.verification_status} note={j.verification_note} lastVerifiedAt={j.last_verified_at} jobId={j.id} onVerified={onVerified} />
            {detail.application && <StateBadge state={detail.application.state} />}
            {j.disposition !== 'new' && <span className="text-[11px] text-slate-500">{j.disposition}</span>}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {(j.apply_url ?? j.canonical_url) && (
            <a
              href={j.apply_url ?? j.canonical_url ?? '#'}
              target="_blank"
              rel="noreferrer"
              className="px-3 py-1.5 rounded-md border border-slate-300 text-sm text-slate-700 hover:bg-slate-50"
            >
              Open posting ↗
            </a>
          )}
          <button
            type="button"
            onClick={() => setTab('package')}
            className="px-3 py-1.5 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700"
          >
            {detail.packages.length ? 'Package' : 'Generate package'}
          </button>
        </div>
      </div>

      {intelError && (
        <div className="mb-4">
          <InlineNotice kind="error">{intelError}</InlineNotice>
        </div>
      )}
      {intel && !intelError && intel.costUsd > 0 && (
        <p className="mb-4 text-[11px] text-slate-400">last intelligence run cost ${intel.costUsd.toFixed(4)}</p>
      )}

      <div className="border-b border-slate-200 mb-5 flex gap-1 overflow-x-auto">
        {TABS.map((t) => {
          const count =
            t.id === 'paths' ? detail.warm_paths.length : t.id === 'package' ? detail.packages.length : t.id === 'fit' && fit ? null : null
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`px-3 py-2 text-sm whitespace-nowrap border-b-2 -mb-px ${
                tab === t.id ? 'border-indigo-600 text-indigo-700 font-medium' : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              {t.label}
              {count ? <span className="ml-1 text-[11px] text-slate-400">{count}</span> : null}
            </button>
          )
        })}
      </div>

      {tab === 'job' && <JobTab detail={detail} onVerified={onVerified} />}
      {tab === 'fit' && <FitTab fit={fit} busy={intelBusy} onReevaluate={() => runIntelligence({ fit: true })} />}
      {tab === 'research' && (
        <ResearchTab
          research={research}
          summaryOnly={intel?.research ?? null}
          companyName={j.company_name}
          busy={intelBusy}
          onResearch={() => runIntelligence({ research: true })}
        />
      )}
      {tab === 'evidence' && (
        <EvidenceTab resolved={view?.evidence_map ?? null} raw={detail.evidence_map} busy={intelBusy} onMatch={() => runIntelligence({ match: true })} />
      )}
      {tab === 'paths' && <WarmPathsTab paths={detail.warm_paths} busy={intelBusy} onFind={() => runIntelligence({ paths: true })} />}
      {tab === 'package' && (
        <PackagePanel
          jobId={j.id}
          job={j}
          packages={detail.packages}
          view={view}
          onReload={load}
          onView={(v) => setView(v)}
          onApplicationChanged={onApplicationChanged}
          application={detail.application}
        />
      )}
      {tab === 'application' && <ApplicationTab application={detail.application} jobId={j.id} onChanged={onApplicationChanged} />}
    </div>
  )
}
