'use client'

// What a failed package says to the person who paid for it.
//
// The raw text of an infrastructure failure ("ENOENT: no such file or
// directory, mkdir '.career-out/tmp/pkg-…'") tells the founder nothing except
// that something they were charged for broke — and, worse, it arrives right
// after they approved résumé changes, so it reads like their changes caused
// it. The headline is therefore a sentence, the reassurance is explicit, and
// the raw error is kept verbatim one disclosure away (it is also on the run).

import InlineNotice from '@/components/career/InlineNotice'
import { explainPackageError } from '@/lib/career/package/status'
import { STAGE_LABEL } from './PackageProgress'

interface Props {
  stage: string | null
  error: string | null
  /** Retry is only offered when there is a reviewed patch to build from. */
  canRetry: boolean
  /**
   * Whether a cover letter already exists on this package. It decides what the
   * retry sentence may promise: a retry reuses the letter verbatim only when
   * one was written (planDocumentWork's `reuseLetterText`). After a failure
   * inside the RÉSUMÉ documents — the failure this screen exists for — there is
   * no letter yet, so the retry does pay for the writer once. Saying "nothing
   * charged again" there would be false.
   */
  letterWritten: boolean
  busy: boolean
  onRetry: () => void
  onRedo: () => void
}

export default function PackageFailure({ stage, error, canRetry, letterWritten, busy, onRetry, onRedo }: Props) {
  const explained = explainPackageError(error)
  const where = stage ? STAGE_LABEL[stage] ?? stage : null

  return (
    <InlineNotice kind="error">
      <p className="font-medium">{explained.headline}</p>
      {where && <p className="mt-0.5 text-xs opacity-80">Failed during: {where}.</p>}
      {explained.reassurance && <p className="mt-1">{explained.reassurance}</p>}
      {error && explained.kind !== 'unknown' && (
        <details className="mt-1.5">
          <summary className="text-xs cursor-pointer opacity-80">Technical detail</summary>
          <pre className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-snug opacity-90">{error}</pre>
        </details>
      )}
      <div className="mt-2 flex gap-2">
        {canRetry && explained.retryDocuments && (
          <button type="button" disabled={busy} onClick={onRetry} className="px-2.5 py-1 rounded-md bg-indigo-600 text-white text-xs hover:bg-indigo-700 disabled:opacity-50">
            {busy ? 'Building…' : 'Retry documents'}
          </button>
        )}
        <button type="button" disabled={busy} onClick={onRedo} className="px-2.5 py-1 rounded-md border border-rose-300 text-xs text-rose-800 hover:bg-rose-100 disabled:opacity-50">
          Redo package (new version)
        </button>
      </div>
      {canRetry && explained.retryDocuments && (
        <p className="mt-1 text-[11px] opacity-80">
          Retrying rebuilds the documents on this same version and resumes where it stopped — no new research and no re-tailoring.
          {letterWritten
            ? ' The cover letter already written is reused word for word, so nothing is charged again.'
            : ' The cover letter has not been written yet, so writing it is the one model call this still costs.'}
        </p>
      )}
    </InlineNotice>
  )
}
