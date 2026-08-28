'use client'

import { FIT_DIMENSIONS, type FitDimension, type FitWeights } from '@/lib/career/types'

/**
 * Ten sliders. The sum is shown, not enforced: the server renormalizes
 * (resolveFitWeights), so what matters is the ratio — but seeing "1.20" tells
 * the user their intent will be scaled.
 */
export default function WeightsEditor({
  value,
  defaults,
  labels,
  questions,
  onChange,
}: {
  value: FitWeights
  defaults: FitWeights
  labels: Record<string, string>
  questions: Record<string, string>
  onChange: (next: FitWeights | null) => void
}) {
  const sum = FIT_DIMENSIONS.reduce((s, d) => s + (value[d] ?? 0), 0)
  const isDefault = FIT_DIMENSIONS.every((d) => Math.abs((value[d] ?? 0) - defaults[d]) < 1e-6)

  function set(d: FitDimension, n: number) {
    onChange({ ...value, [d]: n })
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-2">
        <p className="text-xs text-slate-500">
          Sum <span className={`font-medium tabular-nums ${Math.abs(sum - 1) < 0.005 ? 'text-slate-700' : 'text-amber-700'}`}>{sum.toFixed(2)}</span>
          {Math.abs(sum - 1) >= 0.005 && ' — will be scaled to 1.00 on save'}
        </p>
        <button type="button" disabled={isDefault} onClick={() => onChange(null)} className="text-xs text-indigo-600 hover:underline disabled:opacity-40 disabled:no-underline">
          Reset to defaults
        </button>
      </div>
      <div className="space-y-2">
        {FIT_DIMENSIONS.map((d) => (
          <div key={d} className="grid grid-cols-[11rem_1fr_3rem] gap-3 items-center" title={questions[d]}>
            <div>
              <div className="text-sm text-slate-800">{labels[d] ?? d}</div>
              {Math.abs((value[d] ?? 0) - defaults[d]) >= 0.005 && <div className="text-[10px] text-slate-400">default {defaults[d].toFixed(2)}</div>}
            </div>
            <input type="range" min={0} max={0.4} step={0.01} value={value[d] ?? 0} onChange={(e) => set(d, Number(e.target.value))} className="w-full accent-indigo-600" />
            <span className="text-xs tabular-nums text-slate-600 text-right">{(value[d] ?? 0).toFixed(2)}</span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-slate-400">Hover a row for the question the evaluator answers. Eligibility is not a weight — a job you cannot apply to is flagged, never down-weighted.</p>
    </div>
  )
}
