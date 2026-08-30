'use client'

import { useState } from 'react'
import type { EvidenceBank, EvidenceExperience, EvidenceFact, FactCategory } from '@/lib/career/types'
import { ApproveToggle, Bold, Chip, KIND_TONE, Notice, approveRows, insertRow, patchRow, removeRow } from './shared'

const CATEGORIES: FactCategory[] = ['responsibility', 'achievement', 'metric', 'skill', 'tool', 'context', 'award', 'education', 'scope', 'other']

export default function ExperiencesTab({ bank, reload }: { bank: EvidenceBank; reload: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

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

  if (bank.experiences.length === 0) return <div className="text-sm text-slate-500">No experiences yet.</div>

  return (
    <div className="space-y-4">
      {error && <Notice kind="error">{error}</Notice>}
      {bank.experiences.map((e) => (
        <ExperienceCard key={e.id} e={e} bank={bank} busy={busy} act={act} />
      ))}
    </div>
  )
}

function ExperienceCard({
  e, bank, busy, act,
}: { e: EvidenceExperience; bank: EvidenceBank; busy: string | null; act: (id: string, fn: () => Promise<unknown>) => Promise<void> }) {
  const bullets = bank.bullets.filter((b) => b.experience_id === e.id).sort((a, b) => a.display_order - b.display_order)
  const facts = bank.facts.filter((f) => f.experience_id === e.id)
  const metrics = bank.metrics.filter((m) => m.experience_id === e.id)
  const pending = facts.filter((f) => !f.approved).map((f) => f.id)
  const [adding, setAdding] = useState(false)
  const [statement, setStatement] = useState('')
  const [category, setCategory] = useState<FactCategory>('achievement')
  const [editingHeader, setEditingHeader] = useState(false)
  const dates = [e.start_date, e.end_date].filter(Boolean).join(' – ')

  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 px-4 py-3">
        {editingHeader ? (
          <HeaderEditor
            e={e}
            busy={busy === `hdr-${e.id}`}
            onCancel={() => setEditingHeader(false)}
            onSave={(patch) => act(`hdr-${e.id}`, async () => { await patchRow('evidence_experiences', e.id, patch); setEditingHeader(false) })}
          />
        ) : (
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium text-slate-900">{e.title}</span>
              <Chip tone={KIND_TONE[e.kind] ?? 'slate'}>{e.kind}</Chip>
              <button type="button" onClick={() => setEditingHeader(true)} className="text-[11px] text-slate-500 hover:text-slate-800">edit</button>
            </div>
            <div className="text-sm text-slate-600">
              {e.organization}
              {dates ? ` · ${dates}` : ''}
              {e.location ? ` · ${e.location}` : ''}
            </div>
            {e.description && <div className="mt-1 text-xs text-slate-500">{e.description}</div>}
          </div>
        )}
        <div className="flex items-center gap-2">
          {pending.length > 0 && (
            <button
              type="button"
              disabled={busy === e.id}
              onClick={() => act(e.id, () => approveRows('evidence_facts', pending, true))}
              className="rounded border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700 hover:bg-indigo-100"
            >
              approve {pending.length} facts
            </button>
          )}
          <ApproveToggle approved={e.approved} busy={busy === e.id} onChange={(v) => act(e.id, () => patchRow('evidence_experiences', e.id, { approved: v }))} />
        </div>
      </div>

      {bullets.length > 0 && (
        <div className="border-b border-slate-100 px-4 py-3">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Résumé bullets</div>
          <ul className="space-y-1.5">
            {bullets.map((b) => (
              <li key={b.id} className="flex items-start gap-2 text-sm text-slate-700">
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300" />
                <span className="flex-1"><Bold text={b.text} /></span>
                <Chip tone={b.evidence_fact_ids.length ? 'sky' : 'amber'}>{b.evidence_fact_ids.length} facts</Chip>
                {b.paragraph_index !== null && <Chip>¶{b.paragraph_index}</Chip>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="px-4 py-3">
        <div className="mb-1 flex items-center justify-between">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Facts ({facts.length})</div>
          <button type="button" onClick={() => setAdding((v) => !v)} className="text-[11px] font-medium text-indigo-600 hover:underline">
            {adding ? 'cancel' : '+ add fact'}
          </button>
        </div>
        {adding && (
          <div className="mb-2 flex flex-wrap gap-2">
            <input
              value={statement}
              onChange={(ev) => setStatement(ev.target.value)}
              placeholder="One atomic claim, numbers as on the résumé"
              className="min-w-[280px] flex-1 rounded border border-slate-300 px-2 py-1 text-sm"
            />
            <select value={category} onChange={(ev) => setCategory(ev.target.value as FactCategory)} className="rounded border border-slate-300 px-2 py-1 text-sm">
              {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
            </select>
            <button
              type="button"
              disabled={!statement.trim() || busy === `add-${e.id}`}
              onClick={() =>
                act(`add-${e.id}`, async () => {
                  await insertRow('evidence_facts', { experience_id: e.id, statement, category, source: 'manual', source_location: 'evidence page', confidence: 1, approved: true })
                  setStatement('')
                  setAdding(false)
                })
              }
              className="rounded bg-indigo-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
            >
              save
            </button>
          </div>
        )}
        {facts.length === 0 ? (
          <div className="text-xs text-slate-500">No facts imported for this experience.</div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {facts.map((f) => <FactRow key={f.id} f={f} busy={busy} act={act} />)}
          </ul>
        )}
      </div>

      {metrics.length > 0 && (
        <div className="border-t border-slate-100 px-4 py-3">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Metrics</div>
          <div className="flex flex-wrap gap-2">
            {metrics.map((m) => (
              <div key={m.id} className="flex items-center gap-2 rounded border border-slate-200 bg-slate-50 px-2 py-1 text-xs">
                <span className="font-semibold text-slate-900">{m.value}</span>
                {m.unit && <span className="text-slate-600">{m.unit}</span>}
                {m.context && <span className="text-slate-500">— {m.context}</span>}
                <ApproveToggle approved={m.approved} busy={busy === m.id} onChange={(v) => act(m.id, () => patchRow('evidence_metrics', m.id, { approved: v }))} />
                <button type="button" onClick={() => act(m.id, () => removeRow('evidence_metrics', m.id))} className="text-slate-400 hover:text-red-600" title="delete">×</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

type HeaderPatch = Pick<EvidenceExperience, 'title' | 'organization' | 'start_date' | 'end_date' | 'location'>

/**
 * Title, organization, dates and location as text inputs. Saves through the
 * allow-listed rows route, which stamps edited_by_user so a later import does
 * not overwrite the fix. Dates stay free text in the importer's M/YYYY form.
 */
function HeaderEditor({ e, busy, onCancel, onSave }: { e: EvidenceExperience; busy: boolean; onCancel: () => void; onSave: (patch: HeaderPatch) => void }) {
  const [d, setD] = useState<HeaderPatch>({
    title: e.title, organization: e.organization, start_date: e.start_date ?? '', end_date: e.end_date ?? '', location: e.location ?? '',
  })
  const field = (key: keyof HeaderPatch, placeholder: string, cls = '') => (
    <input
      value={d[key] ?? ''}
      onChange={(ev) => setD({ ...d, [key]: ev.target.value })}
      placeholder={placeholder}
      className={`rounded border border-slate-300 px-2 py-1 text-sm ${cls}`}
    />
  )
  const valid = d.title.trim().length > 0 && d.organization.trim().length > 0
  return (
    <div className="flex-1 space-y-2">
      <div className="flex flex-wrap gap-2">
        {field('title', 'Title', 'min-w-[200px] flex-1')}
        {field('organization', 'Organization', 'min-w-[200px] flex-1')}
      </div>
      <div className="flex flex-wrap gap-2">
        {field('start_date', 'Start (e.g. 5/2025)', 'w-36')}
        {field('end_date', 'End (e.g. 8/2025 or Present)', 'w-44')}
        {field('location', 'Location', 'min-w-[160px] flex-1')}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy || !valid}
          onClick={() => onSave({
            title: d.title.trim(), organization: d.organization.trim(),
            start_date: d.start_date?.trim() || null, end_date: d.end_date?.trim() || null, location: d.location?.trim() || null,
          })}
          className="rounded bg-indigo-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'save'}
        </button>
        <button type="button" onClick={onCancel} className="text-xs text-slate-500">cancel</button>
        <span className="text-[11px] text-slate-400">Your edit wins over later imports.</span>
      </div>
    </div>
  )
}

function FactRow({ f, busy, act }: { f: EvidenceFact; busy: string | null; act: (id: string, fn: () => Promise<unknown>) => Promise<void> }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(f.statement)
  return (
    <li className="flex items-start gap-2 py-1.5 text-sm">
      <div className="flex-1">
        {editing ? (
          <div className="flex gap-2">
            <input value={text} onChange={(ev) => setText(ev.target.value)} className="flex-1 rounded border border-slate-300 px-2 py-1 text-sm" />
            <button
              type="button"
              onClick={() => act(f.id, async () => { await patchRow('evidence_facts', f.id, { statement: text }); setEditing(false) })}
              className="rounded bg-indigo-600 px-2 py-1 text-xs font-medium text-white"
            >
              save
            </button>
            <button type="button" onClick={() => { setEditing(false); setText(f.statement) }} className="text-xs text-slate-500">cancel</button>
          </div>
        ) : (
          <span className="text-slate-800">{f.statement}</span>
        )}
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
          <Chip tone="slate">{f.category}</Chip>
          {f.source_location && <span>{f.source_location}</span>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <ApproveToggle approved={f.approved} busy={busy === f.id} onChange={(v) => act(f.id, () => patchRow('evidence_facts', f.id, { approved: v }))} />
        <button type="button" onClick={() => setEditing((v) => !v)} className="text-[11px] text-slate-500 hover:text-slate-800">edit</button>
        <button type="button" onClick={() => act(f.id, () => removeRow('evidence_facts', f.id))} className="text-[11px] text-slate-400 hover:text-red-600">delete</button>
      </div>
    </li>
  )
}
