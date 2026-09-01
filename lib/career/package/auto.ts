// One click: job → tailored résumé → cover letter → validated DOCX → READY TO APPLY.
//
// The package pipeline always ran every safety check automatically. What it did
// NOT do was act on the result: it stopped at `resume_review`, waited for a
// human to press "approve all safe" (a DETERMINISTIC rule, not a judgement),
// waited again to build documents, waited again to approve a letter that had
// already passed its grounding gate, and waited a fourth time to finalize.
// Five clicks, four of which only confirmed that code had already said yes.
//
// This module removes the confirmations and keeps every check. Nothing here
// relaxes a gate: `safeToApprove` is the same deterministic predicate the
// button used, the Fact Verifier still rules on every rewritten bullet, the
// letter still has to pass `gateCoverLetter`, and document QA still has to
// pass. The only change is who presses the button when they all say yes.
//
// The ready/needs-attention DECISION lives in ./assessment — pure, and
// importable by the UI so the screen and the server cannot disagree.

import type { PackageStage } from './shared'
import type { DocumentQaReport, JobOpportunity, PackageStatus } from '../types'
import {
  applyUrlFor,
  assessPackage,
  letterBlockingCount,
  resumeChangeSummary,
  type AttentionItem,
  type AutoPackageCounts,
} from './assessment'

export * from './assessment'

// ─── The one call ────────────────────────────────────────────────────────────

export type AutoOutcome = 'ready_to_apply' | 'needs_attention'

export interface AutoPackageResult {
  packageId: string | null
  outcome: AutoOutcome
  status: PackageStatus | null
  stage: PackageStage | null
  version: number | null
  applicationId: string | null
  attention: AttentionItem[]
  resume: AutoPackageCounts & { summary: string; noChangeReason: string | null }
  letter: { present: boolean; wordCount: number | null; blockingGrounding: number } | null
  documents: { resumeDocx: string | null; resumePdf: string | null; coverDocx: string | null; coverPdf: string | null }
  applyUrl: string | null
  costUsd: number
  elapsedMs: number
  /** Non-fatal, reported. A recoverable issue is a warning, never an outcome. */
  warnings: string[]
  errors: string[]
  migrationMissing: boolean
}

export interface AutoPackageParams {
  userId: string
  jobId: string
  /**
   * DOCX is the deliverable, so no PDF is rendered by default: it costs ~106 s
   * of Word COM per document and nothing downstream needs it. Page fit is
   * verified by counting rendered pages, so QA records that the one-page check
   * did not run — see PDF_SKIPPED_WARNING.
   */
  renderPdf?: boolean
  onProgress?: (stage: string, detail: string) => void
  /** Test seam. Production passes nothing. */
  deps?: {
    generatePackage?: typeof import('./orchestrator').generatePackage
    reviewResumeChanges?: typeof import('./review').reviewResumeChanges
    finishPackage?: typeof import('./orchestrator').finishPackage
    finalizePackage?: typeof import('./orchestrator').finalizePackage
  }
}

/**
 * Generate → auto-approve what the gates already passed → build documents →
 * finalize. One call, and the caller gets READY TO APPLY or a specific reason
 * it is not.
 *
 * Each step degrades rather than aborts. `finishPackage` failing still leaves a
 * package row with its résumé patch, and the assessment reports what is missing
 * instead of throwing away the work already paid for.
 */
export async function generateCompletePackage(params: AutoPackageParams): Promise<AutoPackageResult> {
  const started = nowMs()
  const progress = params.onProgress ?? (() => {})
  const { generatePackage, finishPackage, finalizePackage } = await import('./orchestrator')
  const { reviewResumeChanges } = await import('./review')
  const { getCoverLetter, getPackage } = await import('./persist')
  const { getJob } = await import('../jobs/store')

  const gen = params.deps?.generatePackage ?? generatePackage
  const review = params.deps?.reviewResumeChanges ?? reviewResumeChanges
  const finish = params.deps?.finishPackage ?? finishPackage
  const finalize = params.deps?.finalizePackage ?? finalizePackage

  const warnings: string[] = []
  const errors: string[] = []
  let costUsd = 0

  const bail = (error: string, extra: Partial<AutoPackageResult> = {}): AutoPackageResult => ({
    packageId: null, outcome: 'needs_attention', status: null, stage: null, version: null, applicationId: null,
    attention: assessPackage({ hardError: error, resumeDocxPath: null, resumeQa: null, letter: null, applyUrl: null }).attention,
    resume: { proposed: 0, applied: 0, rejected: 0, summary: '', noChangeReason: null },
    letter: null,
    documents: { resumeDocx: null, resumePdf: null, coverDocx: null, coverPdf: null },
    applyUrl: null, costUsd, elapsedMs: nowMs() - started, warnings, errors: [...errors, error],
    migrationMissing: false, ...extra,
  })

  // 1 — intelligence + tailoring + fact verification.
  progress('generate', 'research, evidence match, tailoring and fact verification')
  const g = await gen({ userId: params.userId, jobId: params.jobId, onProgress: (s, d) => progress(s, d) })
  costUsd += g.costUsd
  warnings.push(...g.warnings)
  errors.push(...g.errors)
  if (g.migrationMissing) return { ...bail(g.error ?? 'migration missing'), migrationMissing: true }
  if (!g.packageId) return bail(g.error ?? 'package generation produced no package')

  // 2 — approve everything the gates already passed. Deterministic: pending AND
  // SUPPORTED. Nothing here is a judgement about a bullet's quality.
  progress('review', 'approving changes that passed verification')
  const r = await review({ userId: params.userId, packageId: g.packageId, approveAllSafe: true })
  if (r.error) errors.push(`auto-approve: ${r.error}`)
  // Per-change row writes fail individually into `errors` while `error` stays
  // null. Dropping those made the summary claim changes the document does not
  // contain — safe in direction (the résumé is more conservative, never less)
  // but false, and a false count is how a person stops trusting the rest.
  for (const e of r.errors) errors.push(`auto-approve: ${e}`)
  const proposed = r.changes.length
  const applied = r.changes.filter((c) => c.review_status === 'approved' || c.review_status === 'edited').length
  const rejected = r.changes.filter((c) => c.review_status === 'auto_rejected' || c.review_status === 'rejected').length
  const pending = r.changes.filter((c) => c.review_status === 'pending').length
  const counts: AutoPackageCounts = { proposed, applied, rejected, pending }

  // 3 — documents and the letter.
  progress('documents', 'building the DOCX and writing the cover letter')
  const f = await finish({ userId: params.userId, packageId: g.packageId, skipPdf: params.renderPdf !== true, onProgress: (s, d) => progress(s, d) })
  costUsd += f.costUsd
  warnings.push(...f.warnings)
  errors.push(...f.errors)

  // 4 — assess from what was actually SAVED, not from what a run returned.
  const pkgRow = await getPackage(params.userId, g.packageId)
  const pkg = pkgRow.pkg
  const job = await getJob(params.userId, params.jobId)
  const applyUrl = job.job ? applyUrlFor(job.job as unknown as JobOpportunity) : null

  let letter: AutoPackageResult['letter'] = null
  let letterBlocking = 0
  let letterQa: DocumentQaReport | null = null
  // A letter DOCX can exist while its row does not: finishPackage stores the
  // document even when the insert failed. The row is where the grounding
  // verdict lives, so "no row" must mean "unverified", never "no letter".
  let letterRowMissing = Boolean(pkg?.cover_docx_path)
  if (pkg?.cover_letter_id) {
    const got = await getCoverLetter(params.userId, pkg.cover_letter_id)
    if (got.error) errors.push(`cover letter read: ${got.error}`)
    if (got.letter) {
      letterRowMissing = false
      letterBlocking = letterBlockingCount(got.letter.grounding)
      letterQa = (pkg.qa as { cover_letter?: DocumentQaReport } | null)?.cover_letter ?? null
      letter = { present: true, wordCount: got.letter.word_count ?? null, blockingGrounding: letterBlocking }
    }
  }
  if (!pkg?.cover_docx_path) letterRowMissing = false

  const assessment = assessPackage({
    hardError: f.error ?? null,
    resumeDocxPath: pkg?.resume_docx_path ?? null,
    resumeQa: (pkg?.qa as { resume?: DocumentQaReport } | null)?.resume ?? null,
    letter: letter ? { blockingGrounding: letterBlocking, qa: letterQa } : null,
    letterRowMissing,
    // The résumé exists and passed QA; only the letter is missing. Reported as
    // its own attention item rather than as a failed package.
    letterFailed: !letter && !pkg?.cover_docx_path && errors.some((e) => e.startsWith('cover letter:')),
    pendingChanges: pending,
    applyUrl,
  })

  // 5 — finalize only when every gate said yes. `acknowledgeLetter` is how this
  // path tells finalize the letter was cleared by its GATE rather than by a
  // person: the check above is stricter than the one finalize would run, since
  // it also fails the package on a blocking QA check.
  let status: PackageStatus | null = f.status ?? pkg?.status ?? null
  if (assessment.ready) {
    progress('finalize', 'all checks passed')
    const fin = await finalize({ userId: params.userId, packageId: g.packageId, acknowledgeLetter: true, actor: 'system' })
    if (fin.ok) status = fin.status
    else {
      errors.push(`finalize: ${fin.error ?? 'unknown'}`)
      assessment.ready = false
      assessment.attention.push({
        code: 'generation_failed',
        what: 'The package passed every check but could not be marked ready.',
        why: fin.error ?? 'finalize refused',
        action: 'Retry generation; the documents that were produced are still attached to this package.',
      })
    }
  }

  return {
    packageId: g.packageId,
    outcome: assessment.ready ? 'ready_to_apply' : 'needs_attention',
    status,
    stage: f.stage ?? g.stage ?? null,
    version: g.version ?? null,
    applicationId: g.applicationId ?? null,
    attention: assessment.attention,
    resume: { ...counts, summary: resumeChangeSummary(counts), noChangeReason: g.resume?.noChangeReason ?? null },
    letter,
    documents: {
      resumeDocx: pkg?.resume_docx_path ?? null,
      resumePdf: pkg?.resume_pdf_path ?? null,
      coverDocx: pkg?.cover_docx_path ?? null,
      coverPdf: pkg?.cover_pdf_path ?? null,
    },
    applyUrl,
    costUsd: Number(costUsd.toFixed(4)),
    elapsedMs: nowMs() - started,
    warnings,
    errors,
    migrationMissing: false,
  }
}

/** Wall clock, isolated so the rest of this module stays testable. */
function nowMs(): number {
  return Date.now()
}
