'use client'

import type { DocumentQaReport } from '@/lib/career/types'
import DocLinks, { type DocumentSet } from '@/components/career/DocLinks'
import QaReport from './QaReport'

/** Download links plus the QA report per document. A blocking failure is the reason a build was refused — it is shown, not summarized. */
export default function PackageDocuments({
  documents,
  qa,
}: {
  documents: DocumentSet
  qa: { resume: DocumentQaReport | null; cover_letter: DocumentQaReport | null }
}) {
  const blocking = [qa.resume, qa.cover_letter].some((r) => r && r.checks.some((c) => !c.pass && c.blocking))
  return (
    <section>
      <h2 className="text-sm font-semibold text-slate-900 mb-2">Documents</h2>
      <DocLinks documents={documents} />
      {blocking && <p className="mt-2 text-xs text-rose-700 font-medium">A blocking QA check failed — the package cannot be finalized until it passes.</p>}
      <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
        <QaReport title="Résumé QA" qa={qa.resume} />
        <QaReport title="Cover letter QA" qa={qa.cover_letter} />
      </div>
    </section>
  )
}
