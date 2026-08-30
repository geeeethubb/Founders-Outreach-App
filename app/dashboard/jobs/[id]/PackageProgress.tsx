'use client'

// The stage labels the package orchestrator writes, and the progress list shown
// while a package is being generated. Split out of PackagePanel to keep it readable.

export const STAGE_LABEL: Record<string, string> = {
  started: 'Starting',
  intelligence: 'Researching the company, judging fit, matching your evidence',
  tailoring: 'Tailoring the résumé and verifying every change',
  resume_review: 'Waiting for your review',
  resume_documents: 'Building the résumé DOCX and PDF',
  cover_letter: 'Writing and grounding the cover letter',
  documents: 'Building the cover letter documents and running QA',
  finalized: 'Finalized',
}

const ORDER = ['started', 'intelligence', 'tailoring', 'resume_review']

export default function PackageProgress({ stage }: { stage: string | null }) {
  const cur = ORDER.indexOf(stage ?? 'started')
  return (
    <div className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-4">
      <p className="text-sm font-medium text-indigo-900">Generating package…</p>
      <ol className="mt-2 space-y-0.5 text-xs">
        {ORDER.map((k, idx) => (
          <li key={k} className={idx < cur ? 'text-emerald-700' : idx === cur ? 'text-indigo-800 font-medium' : 'text-slate-400'}>
            {idx < cur ? '✓' : idx === cur ? '●' : '○'} {STAGE_LABEL[k]}
          </li>
        ))}
      </ol>
    </div>
  )
}
