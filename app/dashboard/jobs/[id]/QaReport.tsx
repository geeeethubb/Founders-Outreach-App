'use client'

import type { DocumentQaReport } from '@/lib/career/types'

/** One document's QA: checks with pass/fail, blocking failures in red, warnings, page count, renderer. */
export default function QaReport({ title, qa }: { title: string; qa: DocumentQaReport | null | undefined }) {
  if (!qa) {
    return (
      <div className="rounded-md border border-slate-200 bg-white p-3">
        <p className="text-xs font-semibold text-slate-700">{title}</p>
        <p className="text-xs text-slate-400 mt-1">No QA report.</p>
      </div>
    )
  }
  const failed = qa.checks.filter((c) => !c.pass)
  const blocking = failed.filter((c) => c.blocking)
  return (
    <div className={`rounded-md border p-3 ${blocking.length ? 'border-rose-200 bg-rose-50/40' : qa.ok ? 'border-emerald-200 bg-emerald-50/30' : 'border-amber-200 bg-amber-50/30'}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-slate-700">{title}</p>
        <p className="text-[11px] text-slate-500">
          {qa.page_count ?? '?'} page{qa.page_count === 1 ? '' : 's'}
          {qa.expected_pages ? ` (expected ${qa.expected_pages})` : ''} · {qa.renderer ?? 'no renderer'}
          {typeof qa.shrink_attempts === 'number' && qa.shrink_attempts > 0 ? ` · shrink ×${qa.shrink_attempts}` : ''}
        </p>
      </div>
      <ul className="mt-1.5 space-y-0.5">
        {qa.checks.map((c) => (
          <li key={c.name} className={`text-xs flex gap-1.5 ${c.pass ? 'text-slate-600' : c.blocking ? 'text-rose-700 font-medium' : 'text-amber-700'}`}>
            <span className="shrink-0">{c.pass ? '✓' : '✗'}</span>
            <span>
              {c.name}
              {c.detail ? <span className="font-normal text-slate-500"> — {c.detail}</span> : null}
              {!c.pass && c.blocking ? ' (blocking)' : ''}
            </span>
          </li>
        ))}
      </ul>
      {qa.warnings.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {qa.warnings.map((w, i) => (
            <li key={i} className="text-xs text-amber-700">
              ⚠ {w}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
