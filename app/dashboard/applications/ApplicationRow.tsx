'use client'

import { useState } from 'react'
import Link from 'next/link'

export interface ApplicationView {
  id: string
  job_id: string
  state: string
  applied_at: string | null
  locked: boolean
  notes: string | null
  interviews: { stage: string; at: string | null; notes: string | null }[]
  outcome: string | null
  outcome_note: string | null
  submitted_resume_path: string | null
  submitted_cover_letter_path: string | null
  updated_at: string
  job?: {
    id: string
    title: string
    company_name: string
    location_raw: string | null
    canonical_url: string | null
    apply_url: string | null
    verification_status: string
    deadline: string | null
    fit_overall: number | null
  } | null
  package?: {
    id: string
    version: number
    status: string
    resume_filename: string | null
    cover_filename: string | null
    resume_pdf_path: string | null
    cover_pdf_path: string | null
  } | null
}

const STATE_STYLE: Record<string, string> = {
  APPLIED: 'bg-indigo-100 text-indigo-800 border-indigo-200',
  OA: 'bg-sky-100 text-sky-800 border-sky-200',
  INTERVIEW: 'bg-violet-100 text-violet-800 border-violet-200',
  FINAL_ROUND: 'bg-fuchsia-100 text-fuchsia-800 border-fuchsia-200',
  OFFER: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  REJECTED: 'bg-rose-100 text-rose-800 border-rose-200',
  WITHDRAWN: 'bg-slate-100 text-slate-600 border-slate-200',
  CLOSED: 'bg-slate-100 text-slate-600 border-slate-200',
  READY_TO_APPLY: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  READY_FOR_REVIEW: 'bg-amber-50 text-amber-800 border-amber-200',
  PREPARING: 'bg-amber-50 text-amber-800 border-amber-200',
}

function downloadHref(path: string | null): string | null {
  return path ? `/api/career/documents/download?path=${encodeURIComponent(path)}` : null
}

export default function ApplicationRow({
  row,
  labels,
  allowed,
  onPatch,
}: {
  row: ApplicationView
  labels: Record<string, string>
  allowed: string[]
  onPatch: (id: string, body: Record<string, unknown>) => Promise<string | null>
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState(row.notes ?? '')
  const [stage, setStage] = useState('')

  async function move(to: string) {
    const note = to === 'REJECTED' || to === 'WITHDRAWN' ? window.prompt('Note (optional):') ?? null : null
    setBusy(true)
    setError(await onPatch(row.id, { state: to, note }))
    setBusy(false)
  }

  async function saveNotes() {
    setBusy(true)
    setError(await onPatch(row.id, { notes }))
    setBusy(false)
  }

  async function addInterview() {
    if (!stage.trim()) return
    setBusy(true)
    setError(await onPatch(row.id, { interviews: [...(row.interviews ?? []), { stage: stage.trim(), at: new Date().toISOString(), notes: null }] }))
    setStage('')
    setBusy(false)
  }

  const resume = downloadHref(row.submitted_resume_path ?? row.package?.resume_pdf_path ?? null)
  const cover = downloadHref(row.submitted_cover_letter_path ?? row.package?.cover_pdf_path ?? null)
  const applyUrl = row.job?.apply_url ?? row.job?.canonical_url ?? null

  return (
    <div className="rounded-xl border border-slate-200 bg-white">
      <div className="flex items-center gap-4 px-4 py-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Link href={`/dashboard/jobs/${row.job_id}`} className="font-medium text-slate-900 hover:text-indigo-600 truncate">
              {row.job?.title ?? 'Untitled role'}
            </Link>
            <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${STATE_STYLE[row.state] ?? 'bg-slate-100 text-slate-600 border-slate-200'}`}>
              {labels[row.state] ?? row.state}
            </span>
            {row.locked && <span className="text-[11px] text-slate-400">· documents locked</span>}
          </div>
          <p className="text-sm text-slate-500 truncate">
            {row.job?.company_name}
            {row.job?.location_raw ? ` · ${row.job.location_raw}` : ''}
            {row.applied_at ? ` · applied ${row.applied_at.slice(0, 10)}` : ''}
            {row.job?.verification_status === 'CLOSED' ? ' · posting closed' : ''}
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          {resume && <a className="text-indigo-600 hover:underline" href={resume}>Résumé PDF</a>}
          {cover && <a className="text-indigo-600 hover:underline" href={cover}>Cover letter PDF</a>}
          {applyUrl && (
            <a className="text-slate-600 hover:underline" href={applyUrl} target="_blank" rel="noreferrer">
              Posting ↗
            </a>
          )}
          <button onClick={() => setOpen((o) => !o)} className="text-slate-500 hover:text-slate-900">
            {open ? 'Hide' : 'Details'}
          </button>
        </div>
      </div>

      {open && (
        <div className="border-t border-slate-100 px-4 py-3 space-y-3 text-sm">
          <div className="flex flex-wrap gap-2">
            {allowed.map((to) => (
              <button
                key={to}
                disabled={busy}
                onClick={() => move(to)}
                className="px-2.5 py-1 rounded-md border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                → {labels[to] ?? to}
              </button>
            ))}
          </div>
          {row.outcome && (
            <p className="text-slate-600">
              Outcome: <span className="font-medium">{row.outcome}</span>
              {row.outcome_note ? ` — ${row.outcome_note}` : ''}
            </p>
          )}
          <div>
            <p className="text-xs font-semibold text-slate-500 mb-1">Interviews</p>
            {(row.interviews ?? []).length === 0 ? (
              <p className="text-slate-400 text-xs">None recorded.</p>
            ) : (
              <ul className="text-slate-700 space-y-0.5">
                {row.interviews.map((i, idx) => (
                  <li key={idx}>
                    {i.stage}
                    {i.at ? <span className="text-slate-400"> · {i.at.slice(0, 10)}</span> : null}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex gap-2 mt-2">
              <input
                value={stage}
                onChange={(e) => setStage(e.target.value)}
                placeholder="e.g. Phone screen with hiring manager"
                className="flex-1 rounded-md border border-slate-200 px-2 py-1 text-sm"
              />
              <button onClick={addInterview} disabled={busy || !stage.trim()} className="px-2.5 py-1 rounded-md bg-slate-900 text-white text-xs disabled:opacity-50">
                Add
              </button>
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-500 mb-1">Notes</p>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-slate-200 px-2 py-1 text-sm"
            />
            <button onClick={saveNotes} disabled={busy} className="mt-1 px-2.5 py-1 rounded-md border border-slate-200 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50">
              Save notes
            </button>
          </div>
          {error && <p className="text-rose-600 text-xs">{error}</p>}
        </div>
      )}
    </div>
  )
}
