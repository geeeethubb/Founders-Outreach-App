'use client'

import type { PackageView } from '@/components/career/packageTypes'

type Research = NonNullable<PackageView['company_research']>

/**
 * Company research. The full grounded view (facts with source URLs) comes
 * from a package snapshot; before a package exists only the researcher's
 * summary is available, from the last intelligence run on this page.
 */
export default function ResearchTab({
  research,
  summaryOnly,
  companyName,
  busy,
  onResearch,
}: {
  research: Research | null
  summaryOnly: { summary: string; company_type: string; industry_tags: string[]; claims: number; from_cache: boolean } | null
  companyName: string
  busy: boolean
  onResearch: () => void
}) {
  const button = (
    <button type="button" onClick={onResearch} disabled={busy} className="px-3 py-1.5 rounded-md border border-slate-300 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50">
      {busy ? 'Researching…' : research || summaryOnly ? 'Refresh research' : 'Research this company'}
    </button>
  )

  if (!research && !summaryOnly) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
        <p className="text-slate-700 font-medium">No research yet for {companyName}.</p>
        <p className="text-sm text-slate-500 mt-1 mb-3">Web research with cited facts — every claim the cover letter can make about the company comes from here.</p>
        {button}
      </div>
    )
  }

  const facts = research?.facts ?? []
  const factRows = facts.filter((f) => f.type === 'FACT')
  const inferences = facts.filter((f) => f.type !== 'FACT')

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-slate-700 whitespace-pre-wrap">{research?.summary ?? summaryOnly?.summary ?? ''}</p>
        {button}
      </div>
      {summaryOnly && (
        <p className="text-xs text-slate-500">
          {summaryOnly.company_type}
          {summaryOnly.industry_tags?.length ? ` · ${summaryOnly.industry_tags.join(', ')}` : ''} · {summaryOnly.claims} claims
          {summaryOnly.from_cache ? ' · from stored research' : ' · fresh'}
          {!research && ' · generate a package to see the cited facts and intern-program signals'}
        </p>
      )}

      {research && research.grounded_points.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-slate-900 mb-1">Why this is interesting for an intern</h3>
          <ul className="list-disc pl-5 text-sm text-slate-700 space-y-0.5">
            {research.grounded_points.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      {factRows.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-slate-900 mb-1">Sourced facts</h3>
          <ul className="text-sm text-slate-700 space-y-1">
            {factRows.map((f) => (
              <li key={f.id} className="flex gap-2">
                <span className="text-emerald-600 shrink-0">●</span>
                <span>
                  {f.claim}
                  {f.source_url && (
                    <>
                      {' '}
                      <a href={f.source_url} target="_blank" rel="noreferrer" className="text-xs text-indigo-600 hover:underline break-all">
                        source ↗
                      </a>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {inferences.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-slate-900 mb-1">Inferences (not citable in a letter)</h3>
          <ul className="text-sm text-slate-600 space-y-1">
            {inferences.map((f) => (
              <li key={f.id} className="flex gap-2">
                <span className="text-slate-400 shrink-0">○</span>
                <span>{f.claim}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {research && research.uncertainties.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-slate-900 mb-1">Uncertainties</h3>
          <ul className="list-disc pl-5 text-sm text-slate-500 space-y-0.5">
            {research.uncertainties.map((u, i) => (
              <li key={i}>{u}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
