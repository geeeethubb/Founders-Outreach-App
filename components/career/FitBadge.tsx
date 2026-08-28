'use client'

import { pct } from './api'

export type Band = 'STRONG' | 'GOOD' | 'MAYBE' | 'WEAK'

const BAND_STYLE: Record<Band, string> = {
  STRONG: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  GOOD: 'bg-sky-100 text-sky-800 border-sky-200',
  MAYBE: 'bg-amber-100 text-amber-800 border-amber-200',
  WEAK: 'bg-slate-100 text-slate-600 border-slate-200',
}

/** Band + overall %. The adjustment is the feedback term folded into the total, shown only when it moved anything. */
export default function FitBadge({
  band,
  overall,
  adjustment,
  size = 'sm',
}: {
  band: Band | string | null | undefined
  overall: number | null | undefined
  adjustment?: number | null
  size?: 'sm' | 'lg'
}) {
  const style = band ? BAND_STYLE[band as Band] : undefined
  if (!style || typeof overall !== 'number') {
    return (
      <span className="text-[11px] font-medium px-2 py-0.5 rounded-full border bg-white text-slate-400 border-dashed border-slate-300">
        no fit yet
      </span>
    )
  }
  const adj = typeof adjustment === 'number' && Math.abs(adjustment) >= 0.005 ? adjustment : null
  return (
    <span
      className={`inline-flex items-center gap-1.5 font-semibold rounded-full border ${style} ${
        size === 'lg' ? 'text-sm px-3 py-1' : 'text-[11px] px-2 py-0.5'
      }`}
    >
      {band}
      <span className="font-normal opacity-80">{pct(overall)}</span>
      {adj !== null && (
        <span className="font-normal opacity-70" title="Adjustment from your feedback, folded into the overall">
          ({adj > 0 ? '+' : ''}
          {Math.round(adj * 100)})
        </span>
      )}
    </span>
  )
}

const ELIG_STYLE: Record<string, { cls: string; label: string; title: string }> = {
  QUALIFIED: { cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', label: 'Qualified', title: 'Meets the stated minimum qualifications' },
  // STRETCH is a first-class verdict, not a warning — a missing preferred qualification is not disqualification.
  STRETCH: { cls: 'bg-indigo-50 text-indigo-700 border-indigo-200', label: 'Stretch', title: 'Worth applying — some preferred qualifications missing' },
  NOT_QUALIFIED: { cls: 'bg-rose-50 text-rose-700 border-rose-200', label: 'Not qualified', title: 'A stated minimum requirement is not met' },
  UNKNOWN: { cls: 'bg-slate-50 text-slate-500 border-slate-200', label: 'Eligibility unknown', title: 'The posting did not say enough to judge' },
}

export function EligibilityChip({ value }: { value: string | null | undefined }) {
  if (!value) return null
  const s = ELIG_STYLE[value] ?? ELIG_STYLE.UNKNOWN
  return (
    <span title={s.title} className={`text-[11px] font-medium px-2 py-0.5 rounded-full border ${s.cls}`}>
      {s.label}
    </span>
  )
}
