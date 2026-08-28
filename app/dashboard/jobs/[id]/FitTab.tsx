'use client'

import { FIT_DIMENSION_LABELS, FIT_DIMENSION_QUESTIONS } from '@/lib/career/fit/dimensions'
import { FIT_DIMENSIONS, type FitDimension } from '@/lib/career/types'
import type { FitView } from '@/components/career/packageTypes'
import FitBadge, { EligibilityChip } from '@/components/career/FitBadge'
import { pct } from '@/components/career/api'

function Bar({ score }: { score: number }) {
  const w = Math.round(Math.max(0, Math.min(1, score)) * 100)
  const tone = score >= 0.75 ? 'bg-emerald-500' : score >= 0.5 ? 'bg-sky-500' : score >= 0.3 ? 'bg-amber-500' : 'bg-slate-400'
  return (
    <div className="h-2 w-full rounded bg-slate-100 overflow-hidden">
      <div className={`h-2 ${tone}`} style={{ width: `${w}%` }} />
    </div>
  )
}

function Items({ title, items, tone = 'text-slate-700' }: { title: string; items: string[]; tone?: string }) {
  if (!items?.length) return null
  return (
    <div>
      <h3 className="text-sm font-medium text-slate-900 mb-1">{title}</h3>
      <ul className={`list-disc pl-5 text-sm space-y-0.5 ${tone}`}>
        {items.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
    </div>
  )
}

/**
 * The ten components, as the agent judged them, with the overall the code
 * computed from the mission's weights. "Re-evaluate" forces a fresh judgment;
 * changing weights on the mission page re-ranks without one.
 */
export default function FitTab({ fit, busy, onReevaluate }: { fit: FitView | null; busy: boolean; onReevaluate: () => void }) {
  const button = (
    <button type="button" onClick={onReevaluate} disabled={busy} className="px-3 py-1.5 rounded-md border border-slate-300 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50">
      {busy ? 'Evaluating… (a minute or two)' : fit ? 'Re-evaluate' : 'Evaluate fit'}
    </button>
  )
  if (!fit) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
        <p className="text-slate-700 font-medium">No fit evaluation yet.</p>
        <p className="text-sm text-slate-500 mt-1 mb-3">Runs the company researcher, the fit evaluator and the evidence matcher for this job. Cached inputs are free.</p>
        {button}
      </div>
    )
  }
  const byDim = new Map(fit.components.map((c) => [c.dimension, c]))
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <FitBadge band={fit.band} overall={fit.overall} adjustment={fit.feedback_adjustment} size="lg" />
          <EligibilityChip value={fit.eligibility} />
          {typeof fit.confidence === 'number' && <span className="text-xs text-slate-500">confidence {pct(fit.confidence)}</span>}
        </div>
        {button}
      </div>
      {fit.explanation && <p className="text-sm text-slate-700">{fit.explanation}</p>}
      {fit.eligibility_reasoning && (
        <p className="text-sm text-slate-600">
          <span className="font-medium text-slate-800">Eligibility:</span> {fit.eligibility_reasoning}
        </p>
      )}

      <div className="space-y-3">
        {FIT_DIMENSIONS.map((dim: FitDimension) => {
          const c = byDim.get(dim)
          return (
            <div key={dim} className="grid grid-cols-[11rem_1fr] gap-3 items-start">
              <div title={FIT_DIMENSION_QUESTIONS[dim]}>
                <div className="text-sm text-slate-800">{FIT_DIMENSION_LABELS[dim]}</div>
                <div className="text-xs text-slate-500 tabular-nums">{c ? pct(c.score) : 'not judged'}</div>
              </div>
              <div>
                <Bar score={c?.score ?? 0} />
                {c?.explanation && <p className="text-xs text-slate-600 mt-1">{c.explanation}</p>}
                {c?.evidence?.length ? <p className="text-[11px] text-slate-400 mt-0.5">{c.evidence.join(' · ')}</p> : null}
              </div>
            </div>
          )
        })}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Items title="Missing qualifications" items={fit.missing_qualifications} />
        <Items title="Red flags" items={fit.red_flags} tone="text-rose-700" />
        <Items title="Uncertainties" items={fit.uncertainties} tone="text-slate-500" />
      </div>
    </div>
  )
}
