'use client'

// Shared pieces for the Evidence page: the API shape, row helpers, and the
// few visual atoms every tab uses. Feedback is inline divs, not a toast lib.

import type { EvidenceBank } from '@/lib/career/types'

export interface BankCounts {
  experiences: number
  bullets: number
  facts: number
  factsApproved: number
  metrics: number
  skills: number
  stories: number
  preferences: number
  pending: number
  hasMaster: boolean
}

export interface BankResponse {
  bank: EvidenceBank
  counts: BankCounts
  migrationMissing: boolean
  errors: string[]
}

export type EditableTable =
  | 'evidence_experiences' | 'evidence_facts' | 'evidence_metrics' | 'evidence_deliverables'
  | 'evidence_skills' | 'evidence_stories' | 'evidence_preferences' | 'resume_bullets'

async function parse(res: Response): Promise<Record<string, unknown>> {
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : `Request failed (${res.status})`)
  return data
}

export async function insertRow(table: EditableTable, row: Record<string, unknown>): Promise<string> {
  const data = await parse(
    await fetch('/api/career/evidence/rows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table, row }),
    })
  )
  return String(data.id)
}

export async function patchRow(table: EditableTable, id: string, patch: Record<string, unknown>): Promise<void> {
  await parse(
    await fetch(`/api/career/evidence/rows/${id}?table=${table}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
  )
}

export async function removeRow(table: EditableTable, id: string): Promise<void> {
  await parse(await fetch(`/api/career/evidence/rows/${id}?table=${table}`, { method: 'DELETE' }))
}

export async function approveRows(table: Exclude<EditableTable, 'evidence_preferences'>, ids: string[], approved: boolean): Promise<number> {
  if (ids.length === 0) return 0
  const data = await parse(
    await fetch('/api/career/evidence/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table, ids, approved }),
    })
  )
  return Number(data.updated ?? 0)
}

/** `**bold**` spans as <strong>. The stored bullet text keeps the résumé's emphasis. */
export function Bold({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('**') && p.endsWith('**') ? (
          <strong key={i} className="font-semibold text-slate-900">{p.slice(2, -2)}</strong>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </>
  )
}

export function Chip({ children, tone = 'slate' }: { children: React.ReactNode; tone?: 'slate' | 'indigo' | 'emerald' | 'amber' | 'sky' | 'violet' }) {
  const tones: Record<string, string> = {
    slate: 'bg-slate-100 text-slate-600 border-slate-200',
    indigo: 'bg-indigo-50 text-indigo-700 border-indigo-200',
    emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    amber: 'bg-amber-50 text-amber-800 border-amber-200',
    sky: 'bg-sky-50 text-sky-700 border-sky-200',
    violet: 'bg-violet-50 text-violet-700 border-violet-200',
  }
  return <span className={`inline-block rounded border px-1.5 py-0.5 text-[11px] font-medium leading-4 ${tones[tone]}`}>{children}</span>
}

export function Notice({ kind, children }: { kind: 'error' | 'ok' | 'info'; children: React.ReactNode }) {
  const cls =
    kind === 'error'
      ? 'border-red-200 bg-red-50 text-red-800'
      : kind === 'ok'
        ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
        : 'border-slate-200 bg-slate-50 text-slate-700'
  return <div className={`rounded-md border px-3 py-2 text-sm ${cls}`}>{children}</div>
}

export function ApproveToggle({ approved, onChange, busy }: { approved: boolean; onChange: (v: boolean) => void; busy?: boolean }) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => onChange(!approved)}
      className={`rounded border px-2 py-0.5 text-[11px] font-medium disabled:opacity-50 ${
        approved ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100'
      }`}
      title={approved ? 'Approved — click to withdraw' : 'Pending — click to approve'}
    >
      {approved ? 'approved' : 'approve'}
    </button>
  )
}

export const KIND_TONE: Record<string, 'slate' | 'indigo' | 'emerald' | 'amber' | 'sky' | 'violet'> = {
  experience: 'indigo',
  project: 'violet',
  research: 'sky',
  education: 'emerald',
  award: 'amber',
  leadership: 'violet',
  other: 'slate',
}
