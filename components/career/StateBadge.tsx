'use client'

// Same style map idea as app/dashboard/applications/ApplicationRow.tsx, shared
// so the Jobs list and the detail page read the same as the tracker.

const STATE_STYLE: Record<string, string> = {
  DISCOVERED: 'bg-slate-50 text-slate-600 border-slate-200',
  SAVED: 'bg-slate-100 text-slate-700 border-slate-200',
  RESEARCHED: 'bg-slate-100 text-slate-700 border-slate-200',
  PREPARING: 'bg-amber-50 text-amber-800 border-amber-200',
  READY_FOR_REVIEW: 'bg-amber-50 text-amber-800 border-amber-200',
  READY_TO_APPLY: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  APPLIED: 'bg-indigo-100 text-indigo-800 border-indigo-200',
  OA: 'bg-sky-100 text-sky-800 border-sky-200',
  INTERVIEW: 'bg-violet-100 text-violet-800 border-violet-200',
  FINAL_ROUND: 'bg-fuchsia-100 text-fuchsia-800 border-fuchsia-200',
  OFFER: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  REJECTED: 'bg-rose-100 text-rose-800 border-rose-200',
  WITHDRAWN: 'bg-slate-100 text-slate-600 border-slate-200',
  CLOSED: 'bg-slate-100 text-slate-600 border-slate-200',
}

const STATE_LABEL: Record<string, string> = {
  DISCOVERED: 'Discovered',
  SAVED: 'Saved',
  RESEARCHED: 'Researched',
  PREPARING: 'Preparing',
  READY_FOR_REVIEW: 'Ready for review',
  READY_TO_APPLY: 'Ready to apply',
  APPLIED: 'Applied',
  OA: 'Online assessment',
  INTERVIEW: 'Interview',
  FINAL_ROUND: 'Final round',
  OFFER: 'Offer',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
  CLOSED: 'Closed',
}

export function stateLabel(state: string): string {
  return STATE_LABEL[state] ?? state
}

export default function StateBadge({ state, size = 'sm' }: { state: string | null | undefined; size?: 'sm' | 'lg' }) {
  if (!state) return null
  return (
    <span
      className={`font-semibold rounded-full border ${STATE_STYLE[state] ?? 'bg-slate-100 text-slate-600 border-slate-200'} ${
        size === 'lg' ? 'text-sm px-3 py-1' : 'text-[11px] px-2 py-0.5'
      }`}
    >
      {stateLabel(state)}
    </span>
  )
}
