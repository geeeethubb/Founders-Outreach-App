'use client'

import { useState } from 'react'
import type { EvidenceBank, SkillCategory } from '@/lib/career/types'
import { ApproveToggle, Chip, Notice, approveRows, insertRow, patchRow, removeRow } from './shared'

const CATEGORIES: SkillCategory[] = ['technical', 'tool', 'domain', 'business', 'language', 'other']

export default function SkillsTab({ bank, reload }: { bank: EvidenceBank; reload: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [category, setCategory] = useState<SkillCategory>('technical')

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusy(id)
    setError(null)
    try {
      await fn()
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setBusy(null)
    }
  }

  const pending = bank.skills.filter((s) => !s.approved).map((s) => s.id)
  const byCategory = CATEGORIES.map((c) => ({ c, rows: bank.skills.filter((s) => s.category === c) })).filter((g) => g.rows.length)

  return (
    <div className="space-y-4">
      {error && <Notice kind="error">{error}</Notice>}
      <div className="flex flex-wrap items-center gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Add a skill as the résumé names it" className="min-w-[240px] rounded border border-slate-300 px-2 py-1 text-sm" />
        <select value={category} onChange={(e) => setCategory(e.target.value as SkillCategory)} className="rounded border border-slate-300 px-2 py-1 text-sm">
          {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
        </select>
        <button
          type="button"
          disabled={!name.trim() || busy === 'add'}
          onClick={() => act('add', async () => { await insertRow('evidence_skills', { name, category, approved: true }); setName('') })}
          className="rounded bg-indigo-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
        >
          add
        </button>
        {pending.length > 0 && (
          <button type="button" onClick={() => act('all', () => approveRows('evidence_skills', pending, true))} className="ml-auto rounded border border-indigo-200 bg-indigo-50 px-2 py-1 text-xs font-medium text-indigo-700">
            approve all {pending.length} pending
          </button>
        )}
      </div>
      {bank.skills.length === 0 && <div className="text-sm text-slate-500">No skills yet.</div>}
      {byCategory.map((g) => (
        <div key={g.c}>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{g.c}</div>
          <div className="flex flex-wrap gap-2">
            {g.rows.map((s) => (
              <div key={s.id} className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${s.approved ? 'border-slate-200 bg-white' : 'border-amber-200 bg-amber-50'}`}>
                <span className="font-medium text-slate-800">{s.name}</span>
                <Chip>{s.evidence_fact_ids.length} facts</Chip>
                <ApproveToggle approved={s.approved} busy={busy === s.id} onChange={(v) => act(s.id, () => patchRow('evidence_skills', s.id, { approved: v }))} />
                <button type="button" onClick={() => act(s.id, () => removeRow('evidence_skills', s.id))} className="text-slate-400 hover:text-red-600" title="delete">×</button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
