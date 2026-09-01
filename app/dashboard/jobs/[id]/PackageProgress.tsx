'use client'

import { useEffect, useState } from 'react'

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
  /** When this attempt began, so the screen can show elapsed time honestly. */
  startedAt?: string | null
}

/** The same five minutes the server promises. Shown so the wait has a known end. */
const MAX_SECONDS = 300

function mmss(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60)
  const sec = Math.max(0, totalSeconds % 60)
  return `${m}m ${String(sec).padStart(2, '0')}s`
}

export default function PackageProgress({ stage, phase = 'generate', startedAt = null }: Props) {
  const order = phase === 'documents' ? DOCUMENT_ORDER : GENERATE_ORDER
  const cur = Math.max(0, order.indexOf(stage ?? order[0]))

  // A spinner with no elapsed time is what let a package look busy for three
  // days. The clock ticks locally so it keeps moving between polls.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const startedMs = startedAt ? Date.parse(startedAt) : NaN
  const elapsed = Number.isFinite(startedMs) ? Math.max(0, Math.floor((now - startedMs) / 1000)) : null
  const overdue = elapsed !== null && elapsed > MAX_SECONDS

  return (
    <div className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-4">
      <p className="text-sm font-medium text-indigo-900">{phase === 'documents' ? 'Building documents…' : 'Generating package…'}</p>
      {elapsed !== null && (
        <p className={`text-xs mt-0.5 ${overdue ? 'text-amber-800' : 'text-indigo-800'}`}>
          {mmss(elapsed)} elapsed · maximum generation time ~5 min
          {overdue && ' — past the limit; this will be marked failed and offered for retry on the next refresh.'}
        </p>
      )}
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
