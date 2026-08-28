'use client'

import { useState } from 'react'
import type { EvidenceBank, EvidencePreference } from '@/lib/career/types'
import { Notice, insertRow, patchRow, removeRow } from './shared'

export default function PreferencesTab({ bank, reload }: { bank: EvidenceBank; reload: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [category, setCategory] = useState('location')
  const [value, setValue] = useState('')

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

  const categories = [...new Set(bank.preferences.map((p) => p.category))].sort()

  return (
    <div className="space-y-4">
      {error && <Notice kind="error">{error}</Notice>}
      <p className="text-sm text-slate-600">
        Soft preferences carry a weight the ranking reads. A hard constraint eliminates rather than penalizes — feedback never changes it.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input value={category} onChange={(e) => setCategory(e.target.value)} list="pref-categories" placeholder="category" className="w-40 rounded border border-slate-300 px-2 py-1 text-sm" />
        <datalist id="pref-categories">
          {['location', 'company_type', 'optimize_for', 'industry', 'role', 'work_mode', 'values'].map((c) => <option key={c} value={c} />)}
        </datalist>
        <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="value" className="min-w-[240px] rounded border border-slate-300 px-2 py-1 text-sm" />
        <button
          type="button"
          disabled={!value.trim() || !category.trim() || busy === 'add'}
          onClick={() => act('add', async () => { await insertRow('evidence_preferences', { category, value, weight: 0.5, hard_constraint: false }); setValue('') })}
          className="rounded bg-indigo-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
        >
          add
        </button>
      </div>
      {bank.preferences.length === 0 && <div className="text-sm text-slate-500">No preferences yet — the seed writes the mission defaults here.</div>}
      {categories.map((c) => (
        <div key={c} className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{c}</div>
          <table className="w-full text-sm">
            <tbody>
              {bank.preferences.filter((p) => p.category === c).map((p) => (
                <PreferenceRow key={p.id} p={p} busy={busy === p.id} act={act} />
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}

function PreferenceRow({ p, busy, act }: { p: EvidencePreference; busy: boolean; act: (id: string, fn: () => Promise<unknown>) => Promise<void> }) {
  const [weight, setWeight] = useState(Number(p.weight))
  return (
    <tr className="border-b border-slate-50 last:border-0">
      <td className="px-4 py-2 text-slate-800">
        {p.value}
        {p.note && <span className="ml-2 text-xs text-slate-400">{p.note}</span>}
      </td>
      <td className="w-56 px-4 py-2">
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={weight}
            disabled={p.hard_constraint || busy}
            onChange={(e) => setWeight(Number(e.target.value))}
            onMouseUp={() => weight !== Number(p.weight) && act(p.id, () => patchRow('evidence_preferences', p.id, { weight }))}
            onTouchEnd={() => weight !== Number(p.weight) && act(p.id, () => patchRow('evidence_preferences', p.id, { weight }))}
            className="w-32"
          />
          <span className="w-10 text-xs tabular-nums text-slate-600">{p.hard_constraint ? '—' : weight.toFixed(2)}</span>
        </div>
      </td>
      <td className="w-32 px-4 py-2">
        <label className="flex items-center gap-1.5 text-xs text-slate-600">
          <input type="checkbox" checked={p.hard_constraint} disabled={busy} onChange={(e) => act(p.id, () => patchRow('evidence_preferences', p.id, { hard_constraint: e.target.checked }))} />
          hard
        </label>
      </td>
      <td className="w-16 px-4 py-2 text-right">
        <button type="button" disabled={busy} onClick={() => act(p.id, () => removeRow('evidence_preferences', p.id))} className="text-[11px] text-slate-400 hover:text-red-600">delete</button>
      </td>
    </tr>
  )
}
