'use client'

import { useState } from 'react'
import Link from 'next/link'
import type { Application } from '@/lib/career/types'
import { APPLICATION_TRANSITIONS } from '@/lib/career/applications/states'
import StateBadge, { stateLabel } from '@/components/career/StateBadge'
import { api, fmtDate } from '@/components/career/api'
import { downloadHref } from '@/components/career/DocLinks'
import InlineNotice from '@/components/career/InlineNotice'

/**
 * State badge + the legal transitions from lib/career/applications/states.ts.
 * APPLIED locks the submitted documents, so it asks before it moves.
 */
export default function ApplicationTab({
  application,
  jobId,
  onChanged,
}: {
  application: Application | null
  jobId: string
  onChanged: (a: Application) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmApplied, setConfirmApplied] = useState(false)

  async function start() {
    setBusy(true)
    setError(null)
    const r = await api<{ application: Application }>('/api/career/applications', { json: { job_id: jobId, state: 'SAVED' } })
    setBusy(false)
    if (!r.ok || !r.data) return setError(r.error)
    onChanged(r.data.application)
  }

  async function move(to: string) {
    if (!application) return
    if (to === 'APPLIED' && !confirmApplied) {
      setConfirmApplied(true)
      return
    }
    setBusy(true)
    setError(null)
    setConfirmApplied(false)
    const r = await api<{ application: Application }>(`/api/career/applications/${application.id}`, { method: 'PATCH', json: { state: to } })
    setBusy(false)
    if (!r.ok || !r.data) return setError(r.error)
    onChanged(r.data.application)
  }

  if (!application) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
        <p className="text-slate-700 font-medium">Not being tracked yet.</p>
        <p className="text-sm text-slate-500 mt-1 mb-3">Generating a package or pressing Track this job starts an application record; the card&apos;s Save only shortlists the job.</p>
        <button type="button" onClick={start} disabled={busy} className="px-3 py-1.5 rounded-md border border-slate-300 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50">
          {busy ? 'Starting…' : 'Track this job'}
        </button>
        {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}
      </div>
    )
  }

  const allowed = APPLICATION_TRANSITIONS[application.state] ?? []
  const resume = downloadHref(application.submitted_resume_path)
  const cover = downloadHref(application.submitted_cover_letter_path)

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <StateBadge state={application.state} size="lg" />
        {application.locked && <span className="text-xs text-slate-500">documents locked{application.applied_at ? ` · applied ${fmtDate(application.applied_at)}` : ''}</span>}
        <Link href="/dashboard/applications" className="text-xs text-indigo-600 hover:underline ml-auto">
          Open the tracker →
        </Link>
      </div>

      {(resume || cover) && (
        <div className="text-xs text-slate-600 flex gap-3">
          <span>Submitted:</span>
          {resume && (
            <a href={resume} className="text-indigo-600 hover:underline">
              résumé
            </a>
          )}
          {cover && (
            <a href={cover} className="text-indigo-600 hover:underline">
              cover letter
            </a>
          )}
        </div>
      )}

      <div>
        <p className="text-xs font-semibold text-slate-500 mb-1.5">Move to</p>
        <div className="flex flex-wrap gap-2">
          {allowed.map((to) => (
            <button
              key={to}
              type="button"
              disabled={busy}
              onClick={() => move(to)}
              className={`px-2.5 py-1 rounded-md border text-sm disabled:opacity-50 ${
                to === 'APPLIED' ? 'border-indigo-300 bg-indigo-50 text-indigo-800 hover:bg-indigo-100' : 'border-slate-200 text-slate-700 hover:bg-slate-50'
              }`}
            >
              → {stateLabel(to)}
            </button>
          ))}
        </div>
      </div>

      {confirmApplied && (
        <InlineNotice kind="warn">
          <p className="font-medium">Mark as applied?</p>
          <p className="mt-0.5">
            This records that you submitted through the company&apos;s link and <strong>locks</strong> the current package: the résumé and cover
            letter it holds become the record of what was sent and can no longer be edited or regenerated.
          </p>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={() => move('APPLIED')} disabled={busy} className="px-2.5 py-1 rounded-md bg-indigo-600 text-white text-xs hover:bg-indigo-700 disabled:opacity-50">
              Yes, I applied
            </button>
            <button type="button" onClick={() => setConfirmApplied(false)} className="text-xs text-slate-600 hover:text-slate-900">
              Cancel
            </button>
          </div>
        </InlineNotice>
      )}

      {application.notes && (
        <p className="text-sm text-slate-600">
          <span className="font-medium text-slate-800">Notes:</span> {application.notes}
        </p>
      )}
      {application.outcome && (
        <p className="text-sm text-slate-600">
          <span className="font-medium text-slate-800">Outcome:</span> {application.outcome}
          {application.outcome_note ? ` — ${application.outcome_note}` : ''}
        </p>
      )}
      {error && <InlineNotice kind="error">{error}</InlineNotice>}
    </div>
  )
}
