'use client'

import { useState } from 'react'
import type { EvidenceBank, EvidenceStory } from '@/lib/career/types'
import { ApproveToggle, Notice, insertRow, patchRow, removeRow } from './shared'

type Draft = Pick<EvidenceStory, 'title' | 'situation' | 'task' | 'actions' | 'result' | 'learning'> & { experience_id: string | null }

const EMPTY: Draft = { title: '', situation: '', task: '', actions: '', result: '', learning: '', experience_id: null }
const FIELDS: { key: keyof Omit<Draft, 'experience_id' | 'title'>; label: string }[] = [
  { key: 'situation', label: 'Situation' },
  { key: 'task', label: 'Task' },
  { key: 'actions', label: 'Actions' },
  { key: 'result', label: 'Result' },
  { key: 'learning', label: 'Learning' },
]

export default function StoriesTab({ bank, reload }: { bank: EvidenceBank; reload: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY)

  async function act(fn: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setBusy(false)
    }
  }

  function startEdit(s: EvidenceStory | null) {
    setEditing(s ? s.id : 'new')
    setDraft(
      s
        ? { title: s.title, situation: s.situation ?? '', task: s.task ?? '', actions: s.actions ?? '', result: s.result ?? '', learning: s.learning ?? '', experience_id: s.experience_id }
        : EMPTY
    )
  }

  async function save() {
    const row = { ...draft, experience_id: draft.experience_id || null }
    if (editing === 'new') await act(() => insertRow('evidence_stories', { ...row, approved: true }))
    else if (editing) await act(() => patchRow('evidence_stories', editing, row))
    setEditing(null)
  }

  const expLabel = (id: string | null) => {
    const e = bank.experiences.find((x) => x.id === id)
    return e ? `${e.title} — ${e.organization}` : null
  }

  return (
    <div className="space-y-4">
      {error && <Notice kind="error">{error}</Notice>}
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-600">STAR stories — the material behind interview answers and cover-letter paragraphs.</p>
        <button type="button" onClick={() => startEdit(null)} className="rounded bg-indigo-600 px-3 py-1 text-sm font-medium text-white">+ new story</button>
      </div>

      {editing && (
        <div className="space-y-2 rounded-lg border border-indigo-200 bg-indigo-50/40 p-4">
          <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="Title" className="w-full rounded border border-slate-300 px-2 py-1 text-sm" />
          <select value={draft.experience_id ?? ''} onChange={(e) => setDraft({ ...draft, experience_id: e.target.value || null })} className="w-full rounded border border-slate-300 px-2 py-1 text-sm">
            <option value="">(no experience)</option>
            {bank.experiences.map((e) => <option key={e.id} value={e.id}>{e.title} — {e.organization}</option>)}
          </select>
          {FIELDS.map((f) => (
            <label key={f.key} className="block text-xs text-slate-600">
              {f.label}
              <textarea value={draft[f.key] ?? ''} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} rows={2} className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm text-slate-800" />
            </label>
          ))}
          <div className="flex gap-2">
            <button type="button" disabled={busy || !draft.title.trim()} onClick={save} className="rounded bg-indigo-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-50">save</button>
            <button type="button" onClick={() => setEditing(null)} className="text-sm text-slate-500">cancel</button>
          </div>
        </div>
      )}

      {bank.stories.length === 0 && !editing && <div className="text-sm text-slate-500">No stories yet.</div>}
      {bank.stories.map((s) => (
        <div key={s.id} className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="font-medium text-slate-900">{s.title}</div>
              {expLabel(s.experience_id) && <div className="text-xs text-slate-500">{expLabel(s.experience_id)}</div>}
            </div>
            <div className="flex items-center gap-2">
              <ApproveToggle approved={s.approved} busy={busy} onChange={(v) => act(() => patchRow('evidence_stories', s.id, { approved: v }))} />
              <button type="button" onClick={() => startEdit(s)} className="text-[11px] text-slate-500 hover:text-slate-800">edit</button>
              <button type="button" onClick={() => act(() => removeRow('evidence_stories', s.id))} className="text-[11px] text-slate-400 hover:text-red-600">delete</button>
            </div>
          </div>
          <dl className="mt-2 grid gap-1 text-sm sm:grid-cols-[90px_1fr]">
            {FIELDS.filter((f) => s[f.key]).map((f) => (
              <div key={f.key} className="contents">
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">{f.label}</dt>
                <dd className="text-slate-700">{s[f.key]}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  )
}
