'use client'

import Link from 'next/link'
import type { EvidenceMapView, JobDetail } from '@/components/career/packageTypes'

function Section({ title, items, tone = 'text-slate-700' }: { title: string; items: string[]; tone?: string }) {
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
 * "Which 1–3 things about you make you interesting to THIS job?" — the
 * evidence map. The resolved version (statements, labels) rides on the
 * package view; before a package exists only the bare row (ids) is stored,
 * so counts are shown for those.
 */
export default function EvidenceTab({
  resolved,
  raw,
  busy,
  onMatch,
}: {
  resolved: EvidenceMapView | null
  raw: JobDetail['evidence_map']
  busy: boolean
  onMatch: () => void
}) {
  const map = resolved ?? raw
  if (!map) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
        <p className="text-slate-700 font-medium">Not matched against your Evidence Bank yet.</p>
        <p className="text-sm text-slate-500 mt-1 mb-3">
          The matcher picks the experiences, facts and metrics that argue for you here — and records what it must not claim.
        </p>
        <button type="button" onClick={onMatch} disabled={busy} className="px-3 py-1.5 rounded-md border border-slate-300 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50">
          {busy ? 'Matching…' : 'Match evidence'}
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {map.do_not_claim?.length > 0 && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
          <p className="text-sm font-semibold text-rose-800">The system will not claim:</p>
          <ul className="list-disc pl-5 text-sm text-rose-800 mt-1 space-y-0.5">
            {map.do_not_claim.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      )}

      {map.why_i_fit && (
        <div>
          <h3 className="text-sm font-medium text-slate-900 mb-1">Why I fit</h3>
          <p className="text-sm text-slate-700 whitespace-pre-wrap">{map.why_i_fit}</p>
        </div>
      )}
      {map.best_differentiator && (
        <div>
          <h3 className="text-sm font-medium text-slate-900 mb-1">Best differentiator</h3>
          <p className="text-sm text-slate-700">{map.best_differentiator}</p>
        </div>
      )}

      {resolved ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <h3 className="text-sm font-medium text-slate-900 mb-1">Top experiences</h3>
            <ul className="list-disc pl-5 text-sm text-slate-700 space-y-0.5">
              {resolved.top_experiences.map((e) => (
                <li key={e.id}>{e.label}</li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="text-sm font-medium text-slate-900 mb-1">Skills matched</h3>
            <div className="flex flex-wrap gap-1">
              {resolved.skills.map((s) => (
                <span key={s.id} className="text-[11px] px-1.5 py-0.5 rounded border bg-slate-50 text-slate-600 border-slate-200">
                  {s.name}
                </span>
              ))}
            </div>
          </div>
          <Section title="Facts matched" items={resolved.facts.map((f) => f.statement)} />
          <Section title="Metrics matched" items={resolved.metrics.map((m) => m.statement)} />
        </div>
      ) : (
        <p className="text-xs text-slate-500">
          {raw?.top_experience_ids.length ?? 0} experiences · {raw?.fact_ids.length ?? 0} facts · {raw?.metric_ids.length ?? 0} metrics ·{' '}
          {raw?.skill_ids.length ?? 0} skills matched — generate a package to see them resolved, or browse the{' '}
          <Link href="/dashboard/evidence" className="text-indigo-600 hover:underline">
            Evidence Bank
          </Link>
          .
        </p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Section title="Emphasize" items={map.emphasize ?? []} />
        <Section title="Gaps" items={map.gaps ?? []} tone="text-amber-800" />
      </div>

      <button type="button" onClick={onMatch} disabled={busy} className="text-xs text-indigo-600 hover:underline disabled:opacity-50">
        {busy ? 'Matching…' : 'Re-match evidence'}
      </button>
    </div>
  )
}
