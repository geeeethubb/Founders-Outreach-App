'use client'

import { useState } from 'react'
import { FEEDBACK_REASONS, type FeedbackReason, type FeedbackVerdict } from '@/lib/career/types'
import { api } from '@/components/career/api'

const VERDICTS: { value: FeedbackVerdict; label: string; cls: string }[] = [
  { value: 'LOVE', label: 'Love', cls: 'hover:bg-emerald-50 hover:border-emerald-300 hover:text-emerald-800' },
  { value: 'INTERESTED', label: 'Interested', cls: 'hover:bg-sky-50 hover:border-sky-300 hover:text-sky-800' },
  { value: 'MAYBE', label: 'Maybe', cls: 'hover:bg-amber-50 hover:border-amber-300 hover:text-amber-800' },
  { value: 'NOT_INTERESTED', label: 'Not interested', cls: 'hover:bg-rose-50 hover:border-rose-300 hover:text-rose-800' },
]

export interface FeedbackOutcome {
  verdict: FeedbackVerdict
  disposition: 'saved' | 'dismissed' | null
  /** How many evaluations the mission-wide recompute re-summed (null when it failed). */
  reranked: number | null
}

/**
 * Verdict → reasons picker → POST feedback → POST fit/recompute {} (mission-wide).
 * The recompute is arithmetic only (no agent, lib/career/fit/rank.ts), so it is
 * cheap to do on every verdict; the caller reloads the list so the order updates.
 */
export default function FeedbackButtons({
  jobId,
  lastVerdict,
  onDone,
}: {
  jobId: string
  lastVerdict?: string | null
  onDone: (o: FeedbackOutcome) => void
}) {
  const [picking, setPicking] = useState<FeedbackVerdict | null>(null)
  const [reasons, setReasons] = useState<FeedbackReason[]>([])
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  function toggle(r: FeedbackReason) {
    setReasons((prev) => (prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r]))
  }

  async function submit() {
    if (!picking) return
    setBusy(true)
    setErr(null)
    setMsg(null)
    const fb = await api<{ disposition: 'saved' | 'dismissed' | null }>(`/api/career/jobs/${jobId}/feedback`, {
      json: { verdict: picking, reasons, note: note.trim() || undefined },
    })
    if (!fb.ok) {
      setErr(fb.error)
      setBusy(false)
      return
    }
    const rc = await api<{ updated: number; errors: string[] }>('/api/career/fit/recompute', { json: {} })
    setBusy(false)
    const updated = rc.ok ? rc.data?.updated ?? 0 : null
    if (!rc.ok) setErr(`Feedback saved, but re-ranking failed: ${rc.error}`)
    else setMsg(`Re-ranked ${updated} job${updated === 1 ? '' : 's'}`)
    onDone({ verdict: picking, disposition: fb.data?.disposition ?? null, reranked: updated })
    setPicking(null)
    setReasons([])
    setNote('')
  }

  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {VERDICTS.map((v) => (
          <button
            key={v.value}
            type="button"
            disabled={busy}
            onClick={() => setPicking(picking === v.value ? null : v.value)}
            className={`text-xs px-2 py-1 rounded-md border transition-colors disabled:opacity-50 ${
              picking === v.value
                ? 'bg-slate-900 text-white border-slate-900'
                : lastVerdict === v.value
                  ? 'bg-slate-100 border-slate-300 text-slate-700'
                  : `bg-white border-slate-200 text-slate-600 ${v.cls}`
            }`}
            title={lastVerdict === v.value ? 'Your last verdict' : undefined}
          >
            {v.label}
          </button>
        ))}
      </div>
      {picking && (
        <div className="mt-2 rounded-md border border-slate-200 bg-slate-50 p-2.5">
          <p className="text-[11px] text-slate-500 mb-1.5">Why? (optional — this is what teaches the ranking)</p>
          <div className="flex flex-wrap gap-1">
            {FEEDBACK_REASONS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => toggle(r)}
                className={`text-[11px] px-1.5 py-0.5 rounded border ${
                  reasons.includes(r) ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'
                }`}
              >
                {r.replace(/_/g, ' ')}
              </button>
            ))}
          </div>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="A note, if the reasons do not cover it"
            className="mt-2 w-full rounded-md border border-slate-200 px-2 py-1 text-xs"
          />
          <div className="mt-2 flex items-center gap-2">
            <button type="button" onClick={submit} disabled={busy} className="text-xs px-2.5 py-1 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
              {busy ? 'Saving…' : `Record ${picking.replace('_', ' ').toLowerCase()}`}
            </button>
            <button type="button" onClick={() => setPicking(null)} className="text-xs text-slate-500 hover:text-slate-800">
              Cancel
            </button>
          </div>
        </div>
      )}
      {err && <p className="mt-1 text-xs text-rose-600">{err}</p>}
      {msg && !err && <p className="mt-1 text-xs text-emerald-700">{msg}</p>}
    </div>
  )
}
