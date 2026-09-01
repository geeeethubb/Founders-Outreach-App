'use client'

/**
 * What a finished package looks like when nothing is wrong: a short checklist,
 * the documents, and the link to go apply.
 *
 * The old panel showed the same information as four review sections the founder
 * had to walk through in order. Nothing here is a step — every line is a fact
 * about work that is already done, and the only buttons are the three actions a
 * person actually takes: download, open the posting, say they applied.
 *
 * `assessPackage` is imported rather than reimplemented: the server used it to
 * decide whether to finalise, and if this component judged readiness by its own
 * rules the badge and the status could disagree.
 */

import { assessPackage, applyUrlFor, letterBlockingCount, type AttentionItem } from '@/lib/career/package/assessment'
import type { DocumentQaReport } from '@/lib/career/types'

interface PackageLike {
  status: string | null
  documents: {
    resume_docx: { path: string; href: string; filename: string } | null
    resume_pdf: { path: string; href: string; filename: string } | null
    cover_docx: { path: string; href: string; filename: string } | null
    cover_pdf: { path: string; href: string; filename: string } | null
  }
  qa: { resume: DocumentQaReport | null; cover_letter: DocumentQaReport | null }
  cover_letter: { word_count: number | null; grounding: unknown; review_status: string } | null
  resume: { changes: { review_status: string }[] } | null
  job: { apply_url: string | null; canonical_url?: string | null }
}

export interface SummaryLine {
  ok: boolean
  label: string
}

/**
 * The checklist, derived from the package rather than narrated by it. A line is
 * only shown when the thing it describes was actually attempted — a package
 * with no cover letter should not display a grey "cover letter" row implying
 * something is missing.
 */
export function summaryLines(view: PackageLike): SummaryLine[] {
  const lines: SummaryLine[] = []
  const changes = view.resume?.changes ?? []
  const applied = changes.filter((c) => c.review_status === 'approved' || c.review_status === 'edited').length
  const rejected = changes.filter((c) => c.review_status === 'auto_rejected' || c.review_status === 'rejected').length

  lines.push({ ok: Boolean(view.documents.resume_docx), label: view.documents.resume_docx ? 'Résumé tailored' : 'Résumé document missing' })

  if (changes.length === 0) {
    lines.push({ ok: true, label: 'No changes needed — master résumé used as written' })
  } else {
    lines.push({ ok: true, label: `${applied} of ${changes.length} proposed change${changes.length === 1 ? '' : 's'} applied` })
    const pending = changes.filter((c) => c.review_status === 'pending').length
    if (pending > 0) {
      // The one class automation may not decide. Silence here is how a verified
      // new bullet disappeared from a finished package with nobody asked.
      lines.push({ ok: false, label: `${pending} change${pending === 1 ? '' : 's'} awaiting your decision` })
    }
    if (rejected > 0) {
      // Stated as a positive: the verifier doing its job is the reassuring
      // event, not a defect. The original wording is what shipped.
      lines.push({ ok: true, label: `${rejected} unsupported change${rejected === 1 ? '' : 's'} omitted — original wording kept` })
    }
  }

  const resumeQaOk = view.qa.resume ? (view.qa.resume.checks ?? []).every((c) => c.pass || !c.blocking) : false
  if (view.qa.resume) lines.push({ ok: resumeQaOk, label: resumeQaOk ? 'Fact check and document QA passed' : 'Document QA failed' })

  if (view.cover_letter) {
    const blocking = letterBlockingCount(view.cover_letter.grounding)
    lines.push({
      ok: blocking === 0,
      label: blocking === 0
        ? `Cover letter generated and grounded${view.cover_letter.word_count ? ` (${view.cover_letter.word_count} words)` : ''}`
        : `Cover letter has ${blocking} unsupported claim${blocking === 1 ? '' : 's'}`,
    })
  }

  return lines
}

/** The same decision the server made, from the same function. */
export function attentionFor(view: PackageLike): AttentionItem[] {
  return assessPackage({
    hardError: null,
    resumeDocxPath: view.documents.resume_docx?.path ?? null,
    resumeQa: view.qa.resume,
    letter: view.cover_letter
      ? { blockingGrounding: letterBlockingCount(view.cover_letter.grounding), qa: view.qa.cover_letter }
      : null,
    letterRowMissing: !view.cover_letter && Boolean(view.documents.cover_docx),
    pendingChanges: (view.resume?.changes ?? []).filter((c) => c.review_status === 'pending').length,
    applyUrl: applyUrlFor({ apply_url: view.job.apply_url, canonical_url: view.job.canonical_url ?? null } as never),
  }).attention
}

export function PackageChecklist({ view }: { view: PackageLike }) {
  const lines = summaryLines(view)
  return (
    <ul className="mt-2 space-y-1">
      {lines.map((l, i) => (
        <li key={i} className="flex items-start gap-2 text-sm">
          <span aria-hidden className={l.ok ? 'text-emerald-600' : 'text-amber-600'}>
            {l.ok ? '✓' : '!'}
          </span>
          <span className={l.ok ? 'text-slate-700' : 'text-amber-900'}>{l.label}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * What is wrong, why it matters, and what to do — never "review 7 stages".
 * Shown only when something actually needs a person.
 */
export function AttentionPanel({ items }: { items: AttentionItem[] }) {
  if (!items.length) return null
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
      <p className="text-base font-semibold text-amber-900">Needs attention</p>
      <ul className="mt-2 space-y-3">
        {items.map((a) => (
          <li key={a.code}>
            <p className="text-sm font-medium text-amber-900">{a.what}</p>
            <p className="text-xs text-amber-800 mt-0.5">{a.why}</p>
            <p className="text-xs text-slate-700 mt-1">
              <span className="font-medium">What to do:</span> {a.action}
            </p>
          </li>
        ))}
      </ul>
    </div>
  )
}
