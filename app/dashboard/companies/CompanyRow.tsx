'use client'

// One company on the watchlist.
//
// The three buttons are the only way a company becomes a preference: Target and
// Watch are explicit user choices, Ignore is an explicit refusal, and nothing an
// agent does can write any of them (lib/career/companies/intent.ts). A row the
// scout suggested says so plainly, and stays a suggestion until it is clicked.

import { useState } from 'react'
import Link from 'next/link'
import { formatRelativeTime } from '@/lib/utils'
import { api } from '@/components/career/api'
import { clampPriority, INTENT_LABEL, PRIORITY_MAX, PRIORITY_MIN, type CompanyIntent } from '@/lib/career/companies/intent'
import { intentOf, mergeCompanyPatch, openRoles, originLabel, type CompanyView } from './company-view'

export type { CompanyView }

/** The intents a click may write. `suggested` is the agents' value and is never set from here. */
export const USER_CHOICES: { intent: CompanyIntent; label: string; title: string }[] = [
  { intent: 'target', label: 'Target', title: 'You want to work here — checked first, every run' },
  { intent: 'watching', label: 'Watch', title: 'Keep an eye on it — checked regularly' },
  { intent: 'ignored', label: 'Ignore', title: 'Leave it out of every run' },
]

const INTENT_STYLE: Record<CompanyIntent, string> = {
  target: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  watching: 'bg-sky-50 text-sky-700 border-sky-200',
  suggested: 'bg-slate-50 text-slate-600 border-slate-200',
  ignored: 'bg-slate-100 text-slate-500 border-slate-200',
}

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

export default function CompanyRow({ company, onChange }: { company: CompanyView; onChange: (c: Partial<CompanyView>) => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [check, setCheck] = useState<CheckResult | null>(null)
  const [editingNote, setEditingNote] = useState(false)
  const [note, setNote] = useState(company.watch_note ?? '')

  const intent = intentOf(company)
  const openings = openRoles(company)

  async function patch(body: Record<string, unknown>, tag = 'patch') {
    setBusy(tag)
    setErr(null)
    const r = await api<{ ok: true; company: Record<string, unknown> | null; intent?: string | null }>(`/api/career/companies/${company.id}`, { method: 'PATCH', json: body })
    setBusy(null)
    if (!r.ok || !r.data) return setErr(r.error)
    // The server's row is the truth for intent and origin; the page's own counts
    // are not in that answer and must survive the merge.
    onChange(mergeCompanyPatch(company, r.data.company ?? (body as Record<string, unknown>)))
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
      open_roles_count: Math.max(company.open_roles_count ?? 0, r.data.openings),
    })
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-slate-900">{company.name}</span>
            <span className={`text-[11px] px-1.5 py-0.5 rounded border ${INTENT_STYLE[intent]}`}>{INTENT_LABEL[intent]}</span>
            {openings > 0 && (
              <span className="text-[11px] px-1.5 py-0.5 rounded border bg-emerald-50 text-emerald-700 border-emerald-200" title="A role is open at this company right now">
                open now
              </span>
            )}
            {company.domain && <span className="text-xs text-slate-400">{company.domain}</span>}
            {company.ats_type && company.ats_type !== 'other' && (
              <span className="text-[11px] px-1.5 py-0.5 rounded border bg-sky-50 text-sky-700 border-sky-200" title={company.ats_identifier ?? undefined}>
                {company.ats_type}
              </span>
            )}
            <span className="text-[11px] text-slate-400">{originLabel(company)}</span>
          </div>
          <div className="mt-1 flex items-center gap-3 flex-wrap text-xs text-slate-500">
            {company.careers_url ? (
              <a href={company.careers_url} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">
                careers ↗
              </a>
            ) : (
              <span className="text-slate-400">no careers URL</span>
            )}
            <Link href={`/dashboard/jobs?search=${encodeURIComponent(company.name)}`} className={openings > 0 ? 'text-emerald-700 hover:underline font-medium' : 'text-slate-400'}>
              {openings} open role{openings === 1 ? '' : 's'}
              {company.jobs_total > openings ? ` · ${company.jobs_total} seen` : ''}
            </Link>
            <span>
              {company.last_careers_check_at ? `checked ${formatRelativeTime(company.last_careers_check_at).toLowerCase()}` : 'never checked'}
              {company.careers_check_note ? ` — ${company.careers_check_note}` : ''}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs shrink-0">
          <div className="flex rounded-md border border-slate-300 overflow-hidden">
            {USER_CHOICES.map((c) => {
              const active = intent === c.intent
              return (
                <button
                  key={c.intent}
                  type="button"
                  title={c.title}
                  disabled={busy !== null || active}
                  onClick={() => patch({ watch_status: c.intent }, c.intent)}
                  className={`px-2 py-1 border-r border-slate-200 last:border-r-0 ${
                    active ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:bg-slate-50 disabled:opacity-50'
                  }`}
                >
                  {busy === c.intent ? '…' : c.label}
                </button>
              )
            })}
          </div>
          <label className="flex items-center gap-1 text-slate-500" title="Priority — higher is checked first (0–100)">
            P
            <input
              type="number"
              min={PRIORITY_MIN}
              max={PRIORITY_MAX}
              defaultValue={company.watch_priority ?? ''}
              disabled={busy !== null}
              onBlur={(e) => {
                const v = clampPriority(e.target.value)
                if (v !== (company.watch_priority ?? null)) patch({ watch_priority: v })
              }}
              className="w-14 rounded-md border border-slate-300 px-1.5 py-1"
            />
          </label>
          <button type="button" disabled={busy !== null} onClick={runCheck} className="px-2 py-1 rounded-md border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            {busy === 'check' ? 'Checking…' : 'Check now'}
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
