'use client'

import { useState } from 'react'
import Link from 'next/link'
import { formatRelativeTime } from '@/lib/utils'
import { api } from '@/components/career/api'

export interface CompanyView {
  id: string
  name: string
  domain: string | null
  website_url: string | null
  careers_url: string | null
  ats_type: string | null
  ats_identifier: string | null
  watch_status: string | null
  watch_priority: number | null
  watch_note: string | null
  watch_source: string | null
  last_careers_check_at: string | null
  careers_check_note: string | null
  company_type: string | null
  industry_tags: string[] | null
  jobs_total: number
  open_internships: number
}

export const WATCH_STATUSES = ['target', 'watching', 'opening_available'] as const

interface CheckResult {
  openings: number
  jobs_inserted: number
  jobs_updated: number
  rejected: { reason: string; title: string; company: string }[]
  board: { ats: string; identifier: string; board_url: string } | null
  method: string
  note: string
  errors: string[]
}

/** One watched company. Status and priority edit in place (PATCH); a check is a real board read (POST …/check). */
export default function CompanyRow({ company, onChange, onRemoved }: { company: CompanyView; onChange: (c: Partial<CompanyView>) => void; onRemoved: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [check, setCheck] = useState<CheckResult | null>(null)
  const [editingNote, setEditingNote] = useState(false)
  const [note, setNote] = useState(company.watch_note ?? '')

  async function patch(body: Record<string, unknown>) {
    setBusy('patch')
    setErr(null)
    const r = await api<{ ok: true; company: Partial<CompanyView> }>(`/api/career/companies/${company.id}`, { method: 'PATCH', json: body })
    setBusy(null)
    if (!r.ok || !r.data) return setErr(r.error)
    onChange(r.data.company)
    setEditingNote(false)
  }

  async function runCheck() {
    setBusy('check')
    setErr(null)
    setCheck(null)
    const r = await api<CheckResult>(`/api/career/companies/${company.id}/check`, { method: 'POST' })
    setBusy(null)
    if (!r.ok || !r.data) return setErr(r.error)
    setCheck(r.data)
    onChange({
      last_careers_check_at: new Date().toISOString(),
      careers_check_note: r.data.note,
      open_internships: company.open_internships + r.data.jobs_inserted,
      ...(r.data.board ? { ats_type: r.data.board.ats, ats_identifier: r.data.board.identifier } : {}),
    })
  }

  async function ignore() {
    setBusy('ignore')
    setErr(null)
    const r = await api<{ ok: true }>(`/api/career/companies/${company.id}`, { method: 'DELETE' })
    setBusy(null)
    if (!r.ok) return setErr(r.error)
    onRemoved()
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-slate-900">{company.name}</span>
            {company.domain && <span className="text-xs text-slate-400">{company.domain}</span>}
            {company.ats_type && company.ats_type !== 'other' && (
              <span className="text-[11px] px-1.5 py-0.5 rounded border bg-sky-50 text-sky-700 border-sky-200" title={company.ats_identifier ?? undefined}>
                {company.ats_type}
              </span>
            )}
            {company.watch_source === 'scout' && <span className="text-[11px] text-slate-400" title="Added by the scout, not by you">via scout</span>}
          </div>
          <div className="mt-1 flex items-center gap-3 flex-wrap text-xs text-slate-500">
            {company.careers_url ? (
              <a href={company.careers_url} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">
                careers ↗
              </a>
            ) : (
              <span className="text-slate-400">no careers URL</span>
            )}
            <Link href={`/dashboard/jobs?search=${encodeURIComponent(company.name)}`} className={company.open_internships > 0 ? 'text-emerald-700 hover:underline font-medium' : 'text-slate-400'}>
              {company.open_internships} open internship{company.open_internships === 1 ? '' : 's'}
              {company.jobs_total > company.open_internships ? ` · ${company.jobs_total} total` : ''}
            </Link>
            <span>
              {company.last_careers_check_at ? `checked ${formatRelativeTime(company.last_careers_check_at).toLowerCase()}` : 'never checked'}
              {company.careers_check_note ? ` — ${company.careers_check_note}` : ''}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs shrink-0">
          <select value={company.watch_status ?? 'target'} disabled={busy !== null} onChange={(e) => patch({ watch_status: e.target.value })} className="rounded-md border border-slate-300 px-1.5 py-1">
            {WATCH_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace('_', ' ')}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1 text-slate-500" title="Priority: lower checks first">
            P
            <input
              type="number"
              min={1}
              max={9}
              defaultValue={company.watch_priority ?? ''}
              disabled={busy !== null}
              onBlur={(e) => {
                const v = e.target.value === '' ? null : Number(e.target.value)
                if (v !== (company.watch_priority ?? null)) patch({ watch_priority: v })
              }}
              className="w-12 rounded-md border border-slate-300 px-1.5 py-1"
            />
          </label>
          <button type="button" disabled={busy !== null} onClick={runCheck} className="px-2 py-1 rounded-md border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            {busy === 'check' ? 'Checking…' : 'Check now'}
          </button>
          <button type="button" disabled={busy !== null} onClick={ignore} className="px-2 py-1 rounded-md border border-slate-200 text-slate-400 hover:text-rose-600 disabled:opacity-50" title="Stop watching (kept, marked ignored)">
            Ignore
          </button>
        </div>
      </div>

      <div className="mt-1.5 text-xs">
        {editingNote ? (
          <div className="flex gap-2">
            <input value={note} onChange={(e) => setNote(e.target.value)} className="flex-1 rounded-md border border-slate-300 px-2 py-1" placeholder="Why this company?" />
            <button type="button" disabled={busy !== null} onClick={() => patch({ watch_note: note.trim() || null })} className="px-2 py-1 rounded-md bg-indigo-600 text-white disabled:opacity-50">
              Save
            </button>
            <button type="button" onClick={() => setEditingNote(false)} className="text-slate-500">
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setEditingNote(true)} className="text-left text-slate-600 hover:text-slate-900">
            {company.watch_note ? company.watch_note : <span className="text-slate-400">add a note</span>}
          </button>
        )}
      </div>

      {check && (
        <div className="mt-2 rounded-md border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700">
          <span className="font-medium">{check.openings}</span> openings via {check.method}
          {check.board ? ` (${check.board.ats} · ${check.board.identifier})` : ''} · {check.jobs_inserted} new · {check.jobs_updated} updated
          {check.rejected.length > 0 && ` · ${check.rejected.length} rejected`}
          {check.note && <span className="text-slate-500"> — {check.note}</span>}
          {check.errors.length > 0 && (
            <ul className="mt-1 text-rose-700">
              {check.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-[11px] text-slate-400">Board listings are cached for the day; a second check today returns the same listing.</p>
        </div>
      )}
      {err && <p className="mt-1.5 text-xs text-rose-600">{err}</p>}
    </div>
  )
}
