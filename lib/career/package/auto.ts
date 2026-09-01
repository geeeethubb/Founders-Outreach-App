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

import {
  GenerationDeadline,
  emptyMetrics,
  logStage,
  type GenerationMetrics,
} from './deadline'
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
  /**
   * The shared clock. Tests inject one with a two-second budget to exercise the
   * timeout paths without waiting five minutes.
   */
  deadline?: GenerationDeadline
  /** Shorthand for a custom total budget when no deadline object is supplied. */
  totalMs?: number
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
async function runGeneration(
  params: AutoPackageParams,
  deadline: GenerationDeadline,
  metrics: GenerationMetrics,
  claim: (packageId: string) => void
): Promise<AutoPackageResult> {
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

  // ONE clock for the whole generation. Every stage asks it what is left; no
  // stage gets its own five minutes. See deadline.ts for why this is absolute
  // rather than per-stage.

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
  const g = await gen({ userId: params.userId, jobId: params.jobId, deadline, onProgress: (s, d) => progress(s, d) })
  costUsd += g.costUsd
  warnings.push(...g.warnings)
  errors.push(...g.errors)
  if (g.migrationMissing) return { ...bail(g.error ?? 'migration missing'), migrationMissing: true }
  if (!g.packageId) return bail(g.error ?? 'package generation produced no package')
  // From here the wrapper's `finally` can finalise this row even if we never
  // return normally. This is the line that makes "never stuck at generating"
  // true rather than aspirational.
  claim(g.packageId)
  await beat(g.packageId, 'tailoring', deadline, metrics)
  logStage(g.packageId, 'generate', deadline, metrics, g.stage ?? '')

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
  //
  // Checked against the clock BEFORE starting: document generation plus a cover
  // letter is the most expensive remaining step, and beginning it with thirty
  // seconds left produces nothing except a package that blows the deadline. The
  // résumé patch is already saved, so stopping here loses no paid work — the
  // package lands in resume_review and a retry finishes it for the price of the
  // documents alone.
  if (deadline.remainingMs() < MIN_DOCUMENTS_MS) {
    const detail = `only ${Math.round(deadline.remainingMs() / 1000)}s left; documents were not started`
    logStage(g.packageId, 'documents_skipped', deadline, metrics, detail)
    errors.push(`documents: ${detail} — the résumé changes are saved; retry to build the documents`)
    return {
      packageId: g.packageId, outcome: 'needs_attention', status: 'resume_review', stage: 'resume_review',
      version: g.version ?? null, applicationId: g.applicationId ?? null,
      attention: assessPackage({
        hardError: null, resumeDocxPath: null, resumeQa: null, letter: null,
        applyUrl: 'pending', pendingChanges: counts.pending ?? 0,
      }).attention,
      resume: { ...counts, summary: resumeChangeSummary(counts), noChangeReason: g.resume?.noChangeReason ?? null },
      letter: null,
      documents: { resumeDocx: null, resumePdf: null, coverDocx: null, coverPdf: null },
      applyUrl: null, costUsd: Number(costUsd.toFixed(4)), elapsedMs: deadline.elapsedMs(),
      warnings, errors, migrationMissing: false,
    }
  }
  progress('documents', 'building the DOCX and writing the cover letter')
  await beat(g.packageId, 'documents', deadline, metrics)
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


// ─── Heartbeats ──────────────────────────────────────────────────────────────

/**
 * Documents plus a cover letter need roughly this long. Starting them with less
 * left produces nothing and blows the deadline; stopping instead keeps the
 * résumé patch, which is already paid for and saved.
 */
const MIN_DOCUMENTS_MS = 60_000

/**
 * "I am still here, and this is what I am doing."
 *
 * Best-effort by design: a heartbeat that throws must never be the reason a
 * generation fails. A pre-019 database simply has nowhere to put it, and the
 * reaper falls back to judging such rows on `updated_at`.
 */
async function beat(packageId: string, stage: string, deadline: GenerationDeadline, metrics: GenerationMetrics): Promise<void> {
  try {
    const { updatePackage } = await import('./persist')
    const now = new Date(deadline.now()).toISOString()
    await updatePackage(packageId, {
      last_heartbeat_at: now,
      stage_started_at: now,
      generation_started_at: new Date(deadline.startedAt).toISOString(),
      generation_deadline_at: new Date(deadline.deadlineAt).toISOString(),
      generation_metrics: { ...metrics, ...deadline.snapshot() },
    } as never)
  } catch {
    // Liveness is an optimisation of recovery, never a precondition for work.
  }
}

// ─── The guarantee ───────────────────────────────────────────────────────────

/**
 * Generate a complete package, and ALWAYS reach a terminal state.
 *
 * This wrapper is the whole point of the incident fix. `runGeneration` above is
 * the happy path and its degradations; this is what happens when the happy path
 * does not return — a throw from a stage that has no try/catch of its own, an
 * unhandled rejection deep in a provider, a deadline blown past.
 *
 * Three properties it guarantees, in order of how badly they were missing:
 *
 *   1. THE ROW NEVER STAYS 'generating'. Whatever happens — return, throw, or
 *      deadline — the `finally` writes a terminal status. Before this, the only
 *      thing that could move a generating package was the process generating it.
 *   2. THE DEADLINE IS ABSOLUTE. `Promise.race` against the clock means a stage
 *      that hangs cannot hold the pipeline past five minutes, even though the
 *      hung work itself cannot be cancelled (see withDeadline's caveat).
 *   3. THE FAILURE IS LEGIBLE. The real error is captured and persisted, not
 *      swallowed into a spinner.
 *
 * What it deliberately does NOT do is kill the underlying work. JavaScript
 * cannot abandon an `await`. If a provider call is genuinely wedged, this
 * returns on time and the orphaned work finishes into a void — which is why the
 * database-level reaper in ./recover.ts exists as the backstop.
 */
export async function generateCompletePackage(params: AutoPackageParams): Promise<AutoPackageResult> {
  const deadline = params.deadline ?? new GenerationDeadline({ totalMs: params.totalMs })
  const metrics = emptyMetrics()
  const startedIso = new Date(deadline.startedAt).toISOString()

  // Captured the moment the row exists, so the `finally` can finalise a package
  // whose id never made it back to us through a normal return.
  let ownedPackageId: string | null = null
  const claim = (id: string) => {
    ownedPackageId = id
  }

  let result: AutoPackageResult | null = null
  let thrown: unknown = null
  let timedOut = false

  // ARM THE PROVIDER'S OWN DEADLINE. This is the single most important line for
  // the five-minute guarantee, and it was the one genuinely missing piece.
  //
  // anthropic/client.ts already retries a failed call four times at a 120s
  // timeout each — and a timeout throws with `status === undefined`, which its
  // retry policy treats as "transient, keep going". So ONE logical LLM call is
  // worth up to 8.2 minutes, and a package makes up to 76 of them: a measured
  // worst case of ten and a half hours, against a route that promises 300s.
  //
  // The client has always had a deadline check that turns a retry into a clean
  // error — `setAnthropicDeadline` — but its ONLY caller was the scout
  // orchestrator. The package path never armed it, so `pastRunDeadline()`
  // always returned false and the retries were unbounded. Arming it here is
  // what makes every downstream call give up when this generation is out of
  // time, instead of politely retrying past it.
  const { withAnthropicDeadline } = await import('@/lib/providers/anthropic/client')

  try {
    result = await Promise.race([
      withAnthropicDeadline(deadline.deadlineAt, () => runGeneration(params, deadline, metrics, claim)),
      new Promise<never>((_, reject) => {
        const t = setTimeout(() => {
          timedOut = true
          reject(new Error(`package generation exceeded its ${Math.round(deadline.totalMs / 1000)}s deadline`))
        }, deadline.remainingMs())
        // Never hold the process open for the deadline timer alone.
        if (typeof (t as unknown as { unref?: () => void }).unref === 'function') (t as unknown as { unref: () => void }).unref()
      }),
    ])
    return result
  } catch (e) {
    thrown = e
    const message = e instanceof Error ? e.message : String(e)
    logStage(ownedPackageId ?? 'unknown', timedOut ? 'timed_out' : 'crashed', deadline, metrics, message)
    return {
      packageId: ownedPackageId,
      outcome: 'needs_attention',
      status: 'failed',
      stage: null,
      version: null,
      applicationId: null,
      attention: assessPackage({
        hardError: timedOut
          ? `Generation ran past its ${Math.round(deadline.totalMs / 1000)}-second limit and was stopped. Anything already finished was saved.`
          : message,
        resumeDocxPath: null,
        resumeQa: null,
        letter: null,
        applyUrl: null,
      }).attention,
      resume: { proposed: 0, applied: 0, rejected: 0, summary: '', noChangeReason: null },
      letter: null,
      documents: { resumeDocx: null, resumePdf: null, coverDocx: null, coverPdf: null },
      applyUrl: null,
      costUsd: 0,
      elapsedMs: deadline.elapsedMs(),
      warnings: [],
      errors: [message],
      migrationMissing: false,
    }
  } finally {
    // THE INVARIANT. Nothing below may throw — a failure to record the failure
    // must not become a second failure — so every write is best-effort and the
    // whole block is wrapped.
    try {
      const id = ownedPackageId
      const stillRunning = thrown !== null || (result !== null && result.status === 'generating')
      if (id && stillRunning) {
        const { updatePackage } = await import('./persist')
        const message = timedOut
          ? `Generation ran past its ${Math.round(deadline.totalMs / 1000)}-second limit and was stopped before finishing.`
          : thrown instanceof Error
            ? thrown.message
            : 'Generation stopped unexpectedly.'
        await updatePackage(id, {
          status: 'failed',
          error: message,
          last_error: message,
          generation_started_at: startedIso,
          generation_finished_at: new Date(deadline.now()).toISOString(),
          generation_metrics: { ...metrics, ...deadline.snapshot() },
        } as never)
      }
    } catch {
      // Deliberately silent: the caller already has the real error, and the
      // reaper will finalise the row on the next read if this write failed.
    }
  }
}
