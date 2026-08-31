'use client'

// The stage labels the package orchestrator writes, and the progress list shown
// while work is running. Split out of PackagePanel to keep it readable.
//
// Both halves of the pipeline are listed because both write `stage`, and a
// failure is now recorded against the stage that was RUNNING — so "Building the
// résumé DOCX and PDF" is a thing the failure block can honestly say.

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

const GENERATE_ORDER = ['started', 'intelligence', 'tailoring', 'resume_review']
const DOCUMENT_ORDER = ['resume_documents', 'cover_letter', 'documents']

interface Props {
  stage: string | null
  /** 'generate' stops at your review; 'documents' is everything after it. */
  phase?: 'generate' | 'documents'
}

export default function PackageProgress({ stage, phase = 'generate' }: Props) {
  const order = phase === 'documents' ? DOCUMENT_ORDER : GENERATE_ORDER
  const cur = Math.max(0, order.indexOf(stage ?? order[0]))
  return (
    <div className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-4">
      <p className="text-sm font-medium text-indigo-900">{phase === 'documents' ? 'Building documents…' : 'Generating package…'}</p>
      <ol className="mt-2 space-y-0.5 text-xs">
        {order.map((k, idx) => (
          <li key={k} className={idx < cur ? 'text-emerald-700' : idx === cur ? 'text-indigo-800 font-medium' : 'text-slate-400'}>
            {idx < cur ? '✓' : idx === cur ? '●' : '○'} {STAGE_LABEL[k]}
          </li>
        ))}
      </ol>
    </div>
  )
}
