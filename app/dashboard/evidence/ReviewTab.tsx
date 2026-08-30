'use client'

// Merge suggestions and conflicts from the consolidation plan. HIGH and
// POSSIBLE pairs can be merged or kept separate; CONFLICT pairs only kept
// separate. Everything writes through /api/career/evidence/review, which
// refuses before migration 015 — the tab then shows the plan read-only.

import { useCallback, useEffect, useState } from 'react'
import type { ConsolidationSummary, MergeProposal } from '@/lib/career/evidence/consolidate-types'
import type { EvidenceConflict, MergeConfidence } from '@/lib/career/types'
import { CONFIDENCE_TONE, Chip, Notice } from './shared'

export interface ReviewResponse {
  migration015: boolean
  migrationMissing?: boolean
  summary?: ConsolidationSummary
  suggestions: MergeProposal[]
  conflicts: EvidenceConflict[]
  warnings?: string[]
  errors?: string[]
  error?: string
}

export function reviewCount(r: ReviewResponse | null): number {
  if (!r) return 0
  return r.suggestions.length + r.conflicts.length
}

export async function fetchReview(): Promise<ReviewResponse> {
  const res = await fetch('/api/career/evidence/review')
  const body = (await res.json()) as ReviewResponse
  if (!res.ok) throw new Error(body.error || `Failed (${res.status})`)
  return body
}

const SECTIONS: { c: MergeConfidence; title: string; blurb: string }[] = [
  { c: 'HIGH', title: 'High confidence', blurb: 'Same organization, same role, compatible dates — or the same statement word for word.' },
  { c: 'POSSIBLE', title: 'Possible', blurb: 'Similar but not identical. Nothing merges here without you.' },
  { c: 'CONFLICT', title: 'Conflict', blurb: 'The two disagree on a number or date; they stay separate — resolve the value under Open conflicts.' },
]

export default function ReviewTab({ initial, onChanged }: { initial: ReviewResponse | null; onChanged: (r: ReviewResponse) => void }) {
  const [data, setData] = useState<ReviewResponse | null>(initial)
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const r = await fetchReview()
      setData(r)
      onChanged(r)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    }
  }, [onChanged])

  useEffect(() => { if (!initial) reload() }, [initial, reload])

  async function act(key: string, body: Record<string, unknown>, done: string) {
    setBusy(key)
    setError(null)
    setOk(null)
    try {
      const res = await fetch('/api/career/evidence/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const out = (await res.json().catch(() => ({}))) as { error?: string; result?: { merged: unknown[]; skipped: { reason: string }[]; errors: string[] } }
      if (!res.ok) throw new Error(out.error || `Request failed (${res.status})`)
      const r = out.result
      if (r) {
        const parts = [`${r.merged.length} merged`]
        if (r.skipped.length) parts.push(`${r.skipped.length} skipped (${r.skipped.map((s) => s.reason).slice(0, 2).join('; ')})`)
        if (r.errors.length) parts.push(`${r.errors.length} errors: ${r.errors.slice(0, 2).join('; ')}`)
        setOk(`${done} — ${parts.join(' · ')}`)
      } else setOk(done)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed')
    } finally {
      setBusy(null)
    }
  }

  if (!data && error) return <Notice kind="error">{error}</Notice>
  if (!data) return <div className="text-sm text-slate-500">Loading…</div>

  const high = data.suggestions.filter((p) => p.confidence === 'HIGH')
  const readOnly = !data.migration015
  const empty = data.suggestions.length === 0 && data.conflicts.length === 0

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-600">
          These look like the same thing. Merge moves the right one&apos;s facts under the left one; nothing is deleted and you can undo from a snapshot.
        </p>
        <button
          type="button"
          disabled={readOnly || high.length === 0 || busy !== null}
          onClick={() => act('all', { action: 'merge_all_high' }, 'Merged all high-confidence pairs')}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {busy === 'all' ? 'Merging…' : `Merge all high-confidence (${high.length})`}
        </button>
      </div>
      {readOnly && <Notice kind="info">Merging needs migration 015 — apply <code className="rounded bg-white px-1">supabase/migrations/015_evidence_canonical.sql</code> in the Supabase SQL editor. Suggestions are shown read-only until then.</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
      {ok && <Notice kind="ok">{ok}</Notice>}
      {data.errors && data.errors.length > 0 && <Notice kind="error">{data.errors.join(' · ')}</Notice>}
      {empty && <Notice kind="info">Nothing to review — the bank is canonical.</Notice>}

      {SECTIONS.map(({ c, title, blurb }) => {
        const rows = data.suggestions.filter((p) => p.confidence === c)
        if (rows.length === 0) return null
        return (
          <section key={c}>
            <div className="mb-2 flex items-baseline gap-2">
              <h2 className="text-sm font-semibold text-slate-900">{title} ({rows.length})</h2>
              <span className="text-xs text-slate-500">{blurb}</span>
            </div>
            <div className="space-y-3">
              {rows.map((p) => (
                <ProposalCard key={`${p.entity_type}:${p.keep_id}:${p.merge_id}`} p={p} readOnly={readOnly} busy={busy} act={act} />
              ))}
            </div>
          </section>
        )
      })}

      {data.conflicts.length > 0 && (
        <section>
          <div className="mb-2 flex items-baseline gap-2">
            <h2 className="text-sm font-semibold text-slate-900">Open conflicts ({data.conflicts.length})</h2>
            <span className="text-xs text-slate-500">Two sources, one field. Choose the value the canonical row should carry, or keep both.</span>
          </div>
          <div className="space-y-3">
            {data.conflicts.map((c) => <ConflictCard key={c.id} c={c} readOnly={readOnly} busy={busy} act={act} />)}
          </div>
        </section>
      )}

      {data.warnings && data.warnings.length > 0 && (
        <details className="text-xs text-slate-500">
          <summary className="cursor-pointer">{data.warnings.length} matcher notes</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">{data.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </details>
      )}
    </div>
  )
}

type Act = (key: string, body: Record<string, unknown>, done: string) => Promise<void>

function Side({ heading, label, tone, p }: { heading: string; label: string; tone: 'indigo' | 'slate'; p: MergeProposal }) {
  const s = p.signals as Record<string, unknown>
  const side = heading === 'Keeps' ? 'keep' : 'merge'
  const meta = [s[`${side}_kind`], s[`${side}_source`], s[`${side}_approved`] === false ? 'pending' : null].filter((x): x is string => typeof x === 'string' && x.length > 0)
  const counts = s[`${side}_counts`] as { facts?: number; metrics?: number; bullets?: number } | undefined
  return (
    <div className={`rounded-md border px-3 py-2 ${tone === 'indigo' ? 'border-indigo-200 bg-indigo-50/40' : 'border-slate-200 bg-slate-50'}`}>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{heading}</div>
      <div className="text-sm text-slate-900">{label}</div>
      {(meta.length > 0 || counts) && (
        <div className="mt-0.5 text-[11px] text-slate-500">
          {meta.join(' · ')}
          {counts && ` · ${counts.facts ?? 0} facts, ${counts.metrics ?? 0} metrics, ${counts.bullets ?? 0} bullets`}
        </div>
      )}
    </div>
  )
}

function ProposalCard({ p, readOnly, busy, act }: { p: MergeProposal; readOnly: boolean; busy: string | null; act: Act }) {
  const key = `${p.entity_type}:${p.keep_id}:${p.merge_id}`
  const pair = { entity_type: p.entity_type, keep_id: p.keep_id, merge_id: p.merge_id }
  const canMerge = p.confidence !== 'CONFLICT'
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <Chip tone={CONFIDENCE_TONE[p.confidence]}>{p.confidence}</Chip>
        <Chip>{p.entity_type}</Chip>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Side heading="Keeps" label={p.keep_label} tone="indigo" p={p} />
        <Side heading="Folds into it" label={p.merge_label} tone="slate" p={p} />
      </div>
      <dl className="mt-2 space-y-0.5 text-xs">
        <Line k="Why" v={p.why} />
        <Line k="Data preserved" v={p.data_preserved} />
        <Line k="Risk" v={p.risk} />
      </dl>
      {p.conflicts.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-amber-800">
          {p.conflicts.map((c, i) => (
            <li key={i}><span className="font-medium">{c.field}:</span> {c.candidates.map((x) => `“${x.value}” (${x.source_label})`).join(' vs ')}</li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex gap-2">
        {canMerge && (
          <button
            type="button"
            disabled={readOnly || busy !== null}
            onClick={() => act(key, { action: 'merge', pair, allowPossible: p.confidence === 'POSSIBLE' }, 'Merged')}
            className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {busy === key ? 'Working…' : 'Merge'}
          </button>
        )}
        <button
          type="button"
          disabled={readOnly || busy !== null}
          onClick={() => act(`${key}:sep`, { action: 'keep_separate', pair, confidence: p.confidence, rule: p.rule }, 'Kept separate')}
          className="rounded-md border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          Keep separate
        </button>
      </div>
    </div>
  )
}

function Line({ k, v }: { k: string; v: string }) {
  if (!v) return null
  return (
    <div className="flex gap-2">
      <dt className="w-28 shrink-0 text-slate-400">{k}</dt>
      <dd className="text-slate-700">{v}</dd>
    </div>
  )
}

function ConflictCard({ c, readOnly, busy, act }: { c: EvidenceConflict; readOnly: boolean; busy: string | null; act: Act }) {
  return (
    <div className="rounded-lg border border-amber-200 bg-white p-4">
      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <Chip tone="amber">{c.entity_type}</Chip>
        <span className="font-medium text-slate-800">{c.field}</span>
        <span className="text-slate-700">{c.entity_label ?? `id ${c.entity_id.slice(0, 8)}…`}</span>
      </div>
      <ul className="space-y-1 text-sm">
        {c.candidates.map((cand, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2">
            <span className="text-slate-900">“{cand.value}”</span>
            <span className="text-[11px] text-slate-500">{cand.source_label}</span>
            <button
              type="button"
              disabled={readOnly || busy !== null}
              onClick={() => act(`c:${c.id}:${i}`, { action: 'resolve_conflict', conflict_id: c.id, value: cand.value }, `Used “${cand.value}”`)}
              className="rounded border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
            >
              Use this
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        disabled={readOnly || busy !== null}
        onClick={() => act(`c:${c.id}:both`, { action: 'resolve_conflict', conflict_id: c.id, value: 'keep_both' }, 'Kept both values')}
        className="mt-2 rounded-md border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
      >
        Keep both
      </button>
    </div>
  )
}
