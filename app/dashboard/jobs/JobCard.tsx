'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { JobCard as JobCardData } from '@/app/api/career/jobs/route'
import FitBadge, { EligibilityChip } from '@/components/career/FitBadge'
import VerificationBadge, { type VerifyOutcome } from '@/components/career/VerificationBadge'
import StateBadge from '@/components/career/StateBadge'
import { api, daysUntil, fmtDate } from '@/components/career/api'
import { formatRelativeTime } from '@/lib/utils'
import FeedbackButtons, { type FeedbackOutcome } from './FeedbackButtons'

export type { JobCardData }

const TIER_STYLE: Record<number, string> = {
  1: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  2: 'bg-sky-50 text-sky-700 border-sky-200',
  3: 'bg-slate-50 text-slate-500 border-slate-200',
}

function Chip({ children, className = 'bg-slate-50 text-slate-600 border-slate-200', title }: { children: React.ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={`text-[11px] px-1.5 py-0.5 rounded border ${className}`}>
      {children}
    </span>
  )
}

/** Deadline → a hint the eye can act on. Code, not a model: it is date arithmetic. */
function urgency(deadline: string | null): { text: string; cls: string } | null {
  const d = daysUntil(deadline)
  if (d === null) return null
  if (d < 0) return { text: 'deadline passed', cls: 'text-rose-600' }
  if (d === 0) return { text: 'due today', cls: 'text-rose-600 font-medium' }
  if (d <= 7) return { text: `${d}d left`, cls: 'text-amber-700 font-medium' }
  return { text: `${d}d left`, cls: 'text-slate-500' }
}

/**
 * One job, answering six questions at a glance: WHAT · WHY CARE · WHY FIT ·
 * IS IT OPEN · WHEN · WHO. Every mutation goes to a route and the parent's
 * copy of the row is patched from the response — never from optimism.
 */
export default function JobCard({ job, onChange }: { job: JobCardData; onChange: (patch: Partial<JobCardData>) => void }) {
  const router = useRouter()
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const urg = urgency(job.deadline)
  const tier = job.location_tier ?? null

  async function setDisposition(disposition: 'new' | 'saved' | 'dismissed') {
    setBusy('disposition')
    setErr(null)
    const r = await api<{ disposition: string }>(`/api/career/jobs/${job.id}/disposition`, { json: { disposition } })
    setBusy(null)
    if (!r.ok) return setErr(r.error)
    onChange({ disposition: (r.data?.disposition as JobCardData['disposition'] | undefined) ?? disposition })
  }

  async function generatePackage() {
    // An application already exists ⇒ a package probably does too; the detail
    // page shows it and offers "new version" there. Do not spend on a click.
    if (job.application_id) return router.push(`/dashboard/jobs/${job.id}?tab=package`)
    setBusy('package')
    setErr(null)
    const r = await api<{ package_id: string; status: string; error: string | null; errors: string[] }>('/api/career/packages', { json: { job_id: job.id } })
    setBusy(null)
    if (!r.ok && !r.body?.package_id) return setErr(r.error)
    router.push(`/dashboard/jobs/${job.id}?tab=package`)
  }

  function onFeedback(o: FeedbackOutcome) {
    onChange({
      ...(o.disposition ? { disposition: o.disposition } : {}),
      ...(o.fitOverall !== null ? { fit_overall: o.fitOverall } : {}),
    })
  }

  function onVerified(o: VerifyOutcome) {
    onChange({ verification_status: o.status as JobCardData['verification_status'], verification_note: o.note, last_verified_at: o.last_verified_at })
  }

  const dismissed = job.disposition === 'dismissed'

  return (
    <div className={`rounded-xl border bg-white ${dismissed ? 'border-slate-200 opacity-60' : 'border-slate-200'}`}>
      <div className="px-4 py-3">
        {/* WHAT */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Link href={`/dashboard/jobs/${job.id}`} className="font-medium text-slate-900 hover:text-indigo-600">
                {job.title}
              </Link>
              <span className="text-sm text-slate-600">· {job.company_name}</span>
              {job.application_state && <StateBadge state={job.application_state} />}
              {job.disposition === 'saved' && <Chip className="bg-indigo-50 text-indigo-700 border-indigo-200">saved</Chip>}
              {dismissed && <Chip>dismissed</Chip>}
            </div>
            <div className="mt-1 flex items-center gap-1.5 flex-wrap text-xs text-slate-500">
              {job.location_raw && <span>{job.location_raw}</span>}
              {tier && <Chip className={TIER_STYLE[tier] ?? TIER_STYLE[3]}>tier {tier}</Chip>}
              {job.work_mode && job.work_mode !== 'unknown' && <Chip>{job.work_mode}</Chip>}
              {job.employment_type && job.employment_type !== 'unknown' && <Chip>{job.employment_type.replace('_', '-')}</Chip>}
              {job.season_relevance === 'summer_2027' && <Chip className="bg-emerald-50 text-emerald-700 border-emerald-200">summer 2027</Chip>}
              {job.season_relevance === 'other_season' && <Chip className="bg-amber-50 text-amber-700 border-amber-200">other season</Chip>}
              {job.role_family && <Chip>{job.role_family}</Chip>}
            </div>
          </div>
          {/* WHY FIT */}
          <div className="flex flex-col items-end gap-1 shrink-0">
            <FitBadge band={job.fit_band} overall={job.fit_overall} />
            <EligibilityChip value={job.fit_eligibility} />
          </div>
        </div>

        {/* WHY CARE */}
        {job.fit_explanation ? (
          <p
            className={`mt-2 text-sm text-slate-700 ${expanded ? '' : 'line-clamp-2'} cursor-pointer`}
            onClick={() => setExpanded((e) => !e)}
            title={expanded ? 'Collapse' : 'Expand'}
          >
            {job.fit_explanation}
          </p>
        ) : (
          <p className="mt-2 text-xs text-slate-400">Not evaluated yet — open the job and press Re-evaluate, or generate a package.</p>
        )}

        {/* IS IT OPEN · WHEN · WHO */}
        <div className="mt-2 flex items-center gap-x-4 gap-y-1 flex-wrap text-xs text-slate-500">
          <VerificationBadge
            status={job.verification_status}
            note={job.verification_note}
            lastVerifiedAt={job.last_verified_at}
            jobId={job.id}
            onVerified={onVerified}
          />
          <span>
            {job.posted_at ? `posted ${fmtDate(job.posted_at)}` : `seen ${formatRelativeTime(job.first_seen_at).toLowerCase()}`}
          </span>
          {job.deadline && (
            <span>
              deadline {fmtDate(job.deadline)} {urg && <span className={urg.cls}>· {urg.text}</span>}
            </span>
          )}
          <Link
            href={`/dashboard/jobs/${job.id}?tab=paths`}
            className={`px-1.5 py-0.5 rounded border ${
              job.warm_path_count > 0 ? 'bg-violet-50 text-violet-700 border-violet-200 hover:bg-violet-100' : 'bg-white text-slate-400 border-slate-200'
            }`}
            title="People you already know who can help"
          >
            {job.warm_path_count > 0 ? `${job.warm_path_count} warm path${job.warm_path_count === 1 ? '' : 's'}` : 'no warm path'}
          </Link>
        </div>
      </div>

      {/* Actions */}
      <div className="border-t border-slate-100 px-4 py-2.5 flex items-start justify-between gap-3 flex-wrap">
        <FeedbackButtons jobId={job.id} onDone={onFeedback} />
        <div className="flex items-center gap-2 text-xs">
          {job.disposition !== 'saved' ? (
            <button type="button" disabled={busy !== null} onClick={() => setDisposition('saved')} className="px-2 py-1 rounded-md border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50">
              Save
            </button>
          ) : (
            <button type="button" disabled={busy !== null} onClick={() => setDisposition('new')} className="px-2 py-1 rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-50">
              Unsave
            </button>
          )}
          {!dismissed ? (
            <button type="button" disabled={busy !== null} onClick={() => setDisposition('dismissed')} className="px-2 py-1 rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-50">
              Dismiss
            </button>
          ) : (
            <button type="button" disabled={busy !== null} onClick={() => setDisposition('new')} className="px-2 py-1 rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-50">
              Restore
            </button>
          )}
          <button
            type="button"
            disabled={busy !== null || job.verification_status === 'CLOSED'}
            onClick={generatePackage}
            title={job.verification_status === 'CLOSED' ? 'The posting is closed' : 'Tailor the résumé and draft a cover letter for this job'}
            className="px-2.5 py-1 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {busy === 'package' ? 'Starting… (a few minutes)' : job.application_id ? 'Open package' : 'Generate package'}
          </button>
        </div>
      </div>
      {err && <p className="px-4 pb-2 text-xs text-rose-600">{err}</p>}
    </div>
  )
}
