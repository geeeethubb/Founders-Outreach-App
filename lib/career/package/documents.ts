// Step 2 of the package: approved changes → documents → cover letter → ready.
//
// Split out of orchestrator.ts because this half is the one that fails on a
// deployed machine, and it had to become both truthful and testable:
//
//   * TRUTHFUL — the stage the failure is recorded against is the stage that
//     was RUNNING, not the stage the row happened to hold when the request
//     arrived. `stage: pkg.stage` is why the UI once said "failed during:
//     Waiting for your review" while the real failure was a mkdir inside
//     résumé document generation.
//   * TESTABLE — every side effect arrives through `DocumentsIo`, so the
//     offline suite can fail a résumé build and assert what was persisted
//     without a database, a key, or a Word install.
//
// Retrying documents is NOT a redo. It reuses the package that already exists
// — same version, same research, same approved changes, same recorded cost —
// and restarts at the stage that failed. The redo route is the only thing that
// creates v2 (resolveRedoTarget in redo.ts + generateCompletePackage).

import { loadDocument } from '../documents/store'
import { isTempPath } from '../documents/tmp'
import { transitionApplication } from '../applications/store'
import { packageToolContext } from '../intelligence/orchestrator'
import { loadJobContext } from '../intelligence/load'
import { DEFAULT_PACKAGE_BUDGET, startCareerRun } from '../runs'
import type { ToolContext } from '@/lib/agents/runtime/types'
import type { ApplicationState, DocumentQaReport, PackageStatus } from '../types'
import { generateCoverLetter, reuseCoverLetter, type LetterDocumentsResult, type StoredLetterText } from './letter'
import { getCoverLetter, getPackage, loadResumePatch, updatePackage, updateResumePatch } from './persist'
import { generateResumeDocuments } from './resume'
import {
  changesFromRows, failed, letterResearchFor, letterSigner, MIGRATION,
  type PackageDeps, type PackageQa, type PackageResult, type PackageStage,
} from './shared'
import { explainPackageError, missingArtifacts } from './status'

// ─── Injection seam ──────────────────────────────────────────────────────────

export interface DocumentsIo {
  getPackage: typeof getPackage
  loadJobContext: typeof loadJobContext
  loadResumePatch: typeof loadResumePatch
  loadDocument: typeof loadDocument
  getCoverLetter: typeof getCoverLetter
  startCareerRun: typeof startCareerRun
  updatePackage: typeof updatePackage
  updateResumePatch: typeof updateResumePatch
  transitionApplication: typeof transitionApplication
  letterSigner: typeof letterSigner
  generateResumeDocuments: typeof generateResumeDocuments
  generateCoverLetter: typeof generateCoverLetter
  reuseCoverLetter: typeof reuseCoverLetter
}

/**
 * The real world. Note what is NOT here: no intelligence run, no tailoring
 * pipeline, no package insert. Finishing a package cannot research, cannot
 * re-tailor and cannot create a version — that is enforced by what this
 * module can reach, not by a comment.
 */
export const REAL_DOCUMENTS_IO: DocumentsIo = {
  getPackage, loadJobContext, loadResumePatch, loadDocument, getCoverLetter, startCareerRun, updatePackage,
  updateResumePatch, transitionApplication, letterSigner, generateResumeDocuments, generateCoverLetter, reuseCoverLetter,
}

// ─── Where a retry starts ────────────────────────────────────────────────────

export interface DocumentPlan {
  /** Skip the résumé render and keep the documents the earlier attempt already stored. */
  reuseResume: boolean
  /** Carry the letter text that was already written and paid for; no writer call. */
  reuseLetterText: boolean
  startStage: Extract<PackageStage, 'resume_documents' | 'cover_letter'>
  reasons: string[]
}

export interface DocumentPlanInput {
  status: PackageStatus | string
  stage: string | null
  resumeDocxPath: string | null
  /** `resume_patches.status`. Anything but 'applied' means the decisions moved since the last build. */
  patchStatus: string | null
  qa: PackageQa | null
  coverLetterId: string | null
}

/**
 * A retry resumes; it does not restart. The résumé documents are re-rendered
 * only when they are missing or stale — stale meaning the human changed a
 * decision after the last build, which the patch status records.
 */
export function planDocumentWork(input: DocumentPlanInput): DocumentPlan {
  const reasons: string[] = []
  const pastResume = input.stage === 'cover_letter' || input.stage === 'documents'
  // Never keep a résumé whose own QA is blocking: a transient render failure
  // would otherwise be frozen into the package and every retry would fail the
  // same way for ever.
  const resumeQaClean = Boolean(input.qa?.resume) && !(input.qa?.resume?.checks ?? []).some((c) => c.blocking && !c.pass)
  const reuseResume =
    input.status === 'failed' && pastResume && Boolean(input.resumeDocxPath) && input.patchStatus === 'applied' && resumeQaClean
  if (reuseResume) reasons.push('the résumé documents from the earlier attempt are kept — the failure was after them')
  const reuseLetterText = input.status === 'failed' && Boolean(input.coverLetterId)
  if (reuseLetterText) reasons.push('the cover letter already written is reused verbatim — no writer call')
  return { reuseResume, reuseLetterText, startStage: reuseResume ? 'cover_letter' : 'resume_documents', reasons }
}

// ─── Finish ──────────────────────────────────────────────────────────────────

export interface FinishPackageParams {
  userId: string
  packageId: string
  ctx?: ToolContext
  deps?: PackageDeps
  /**
   * Carry an existing letter's text into this version instead of calling the
   * writer — no model call, no cost beyond rendering. The name-repair script
   * and a no-cost redo use it; the letter's grounding and review status ride
   * along unchanged because the body is verbatim.
   */
  letterFromStored?: StoredLetterText | null
  onProgress?: (stage: PackageStage, detail: string) => void
  /**
   * Produce the DOCX and no PDF. The DOCX is the canonical résumé; a PDF costs
   * ~106 s of Word COM per render on this machine. Skipping it also skips the
   * one-page verification, which is why it is opt-in rather than the default —
   * see PDF_SKIPPED_WARNING.
   */
  skipPdf?: boolean
  /** Test seam. Production passes nothing. */
  io?: Partial<DocumentsIo>
}

export async function finishPackage(params: FinishPackageParams): Promise<PackageResult> {
  const io: DocumentsIo = { ...REAL_DOCUMENTS_IO, ...params.io }
  const progress = params.onProgress ?? (() => {})
  const warnings: string[] = []
  const errors: string[] = []
  const got = await io.getPackage(params.userId, params.packageId)
  if (got.migrationMissing) return failed(MIGRATION, true)
  if (!got.pkg) return failed('package not found')
  const pkg = got.pkg
  if (!['resume_review', 'failed', 'ready_for_review'].includes(pkg.status)) return failed(`package is ${pkg.status}; documents can only be built from resume_review`)
  if (!pkg.resume_patch_id) return failed('package has no résumé patch')

  const loaded = await io.loadJobContext(params.userId, pkg.job_id)
  if (!loaded.ctx) return failed(loaded.error, loaded.migrationMissing)
  const context = loaded.ctx
  const patch = await io.loadResumePatch(params.userId, pkg.resume_patch_id)
  if (!patch.patch) return failed(patch.error ?? 'résumé patch not found')
  const storagePath = context.bank.masterDocument?.storage_path
  const master = storagePath ? await io.loadDocument(storagePath) : null
  if (!master) return failed('master résumé file is missing from storage — re-import it')

  const run = await io.startCareerRun({
    userId: params.userId, kind: 'package', label: `package documents: ${context.job.company_name} v${pkg.version}`,
    mission: { job_id: pkg.job_id, package_id: pkg.id }, budget: DEFAULT_PACKAGE_BUDGET, careerMissionId: context.mission.id,
  })
  const ctx = params.ctx ?? packageToolContext(params.userId, run.runId)
  const costBase = Number(pkg.cost_usd ?? 0)
  // One folder per attempt: storage refuses to overwrite (upsert:false, and
  // the local mirror throws), so a re-run after a QA failure must not land on
  // the paths the failed attempt already wrote.
  const output = { kind: 'store' as const, userId: params.userId, relativePrefix: `packages/${pkg.id}/v${pkg.version}/${Date.now()}` }
  const storedQa = (pkg.qa as unknown as PackageQa | null) ?? null
  const qa: PackageQa = { resume: null, cover_letter: null }
  const setQa = () => qa as unknown as DocumentQaReport

  const plan = planDocumentWork({
    status: pkg.status, stage: pkg.stage, resumeDocxPath: pkg.resume_docx_path,
    patchStatus: patch.patch.patch.status, qa: storedQa, coverLetterId: pkg.cover_letter_id,
  })
  warnings.push(...plan.reasons)

  // The stage that is RUNNING. Persisted before the risky work that belongs to
  // it, and read by `fail` — never `pkg.stage`, which is where we came in.
  let stage: PackageStage = plan.startStage

  const fail = async (error: string): Promise<PackageResult> => {
    await io.updatePackage(pkg.id, { status: 'failed', stage, error, qa: setQa(), cost_usd: costBase + run.costUsd() })
    await run.finish('failed', { package_id: pkg.id, stage, error_kind: explainPackageError(error).kind }, error)
    return failed(error, false, {
      packageId: pkg.id, version: pkg.version, status: 'failed', stage, applicationId: pkg.application_id,
      costUsd: costBase + run.costUsd(), warnings, errors: [...errors, error],
    })
  }

  try {
    // ─── Résumé documents ───
    let resumeDocxPath = pkg.resume_docx_path
    let resumePdfPath = pkg.resume_pdf_path
    let shrinkAttempts = 0
    if (plan.reuseResume) {
      qa.resume = storedQa?.resume ?? null
      progress('cover_letter', 'reusing the résumé documents from the failed attempt')
    } else {
      stage = 'resume_documents'
      progress('resume_documents', context.job.company_name)
      await io.updatePackage(pkg.id, { stage, error: null })
      const changes = changesFromRows(patch.patch.changes)
      const resume = await io.generateResumeDocuments({ bank: context.bank, masterBuffer: master, changes, company: context.job.company_name, output, skipPdf: params.skipPdf })
      warnings.push(...resume.warnings)
      if (resume.droppedByShrink.length) warnings.push(`dropped to fit one page: ${resume.droppedByShrink.join(', ')}`)
      qa.resume = resume.qa
      shrinkAttempts = resume.shrink_attempts
      const stray = [resume.docxPath, resume.pdfPath].filter((p): p is string => isTempPath(p))
      if (stray.length) return fail(`résumé document: a produced file was left in temporary scratch (${stray.join(', ')}) instead of storage`)
      resumeDocxPath = resume.docxPath
      resumePdfPath = resume.pdfPath
      await io.updatePackage(pkg.id, {
        resume_docx_path: resume.docxPath, resume_pdf_path: resume.pdfPath, resume_filename: resume.filenames.docx, qa: setQa(),
      })
      if (resume.error) return fail(`résumé document: ${resume.error}`)
      await io.updateResumePatch(patch.patch.patch.id, { status: 'applied' })
    }

    // ─── Cover letter ───
    stage = 'cover_letter'
    progress('cover_letter', context.job.company_name)
    await io.updatePackage(pkg.id, { stage, error: null })
    const signer = await io.letterSigner(params.userId, context)
    if (signer.nameSource === 'fallback') warnings.push(`no applicant name could be resolved — the letter is signed "${signer.name}"; set your name on the profile or import a résumé with a name line`)
    const persist = { userId: params.userId, jobId: pkg.job_id, packageId: pkg.id }

    let stored: StoredLetterText | null = params.letterFromStored ?? null
    if (!stored && plan.reuseLetterText && pkg.cover_letter_id) {
      const existing = await io.getCoverLetter(params.userId, pkg.cover_letter_id)
      if (existing.letter) stored = existing.letter
    }

    let letter: { fullText: string | null; error: string | null; row: { id: string } | null; documents: LetterDocumentsResult | null; flagged: boolean; errors: string[] }
    if (stored) {
      progress('cover_letter', 'reusing the stored letter text (no writer call)')
      const reused = await io.reuseCoverLetter({ stored, user: signer, company: context.job.company_name, output, persist })
      letter = { fullText: reused.fullText, error: null, row: reused.row, documents: reused.documents, flagged: reused.flagged, errors: reused.errors }
    } else {
      const gen = await io.generateCoverLetter({
        bank: context.bank,
        job: context.job,
        research: letterResearchFor(context, pkg),
        evidenceMap: context.existing.evidenceMap ?? { why_i_fit: null, fact_ids: [], story_ids: [], top_experience_ids: [] },
        user: signer, ctx, run, deps: params.deps?.letter, output, persist,
        onStep: (s) => progress('cover_letter', `attempt ${s.attempt}: ${s.detail}`),
      })
      letter = { fullText: gen.letter.fullText, error: gen.letter.error, row: gen.row, documents: gen.documents, flagged: gen.flagged, errors: gen.errors }
    }
    errors.push(...letter.errors)
    if (letter.documents) {
      warnings.push(...letter.documents.warnings)
      qa.cover_letter = letter.documents.qa
    }
    const strayLetter = [letter.documents?.docxPath ?? null, letter.documents?.pdfPath ?? null].filter((p): p is string => isTempPath(p))
    if (strayLetter.length) return fail(`cover letter: a produced file was left in temporary scratch (${strayLetter.join(', ')}) instead of storage`)
    await io.updatePackage(pkg.id, {
      cover_letter_id: letter.row?.id ?? null,
      cover_docx_path: letter.documents?.docxPath ?? null, cover_pdf_path: letter.documents?.pdfPath ?? null,
      cover_filename: letter.documents?.filenames.docx ?? null, qa: setQa(), cost_usd: costBase + run.costUsd(),
    })
    // A LETTER FAILURE IS NOT A PACKAGE FAILURE.
    //
    // This used to `fail(...)`, and a live batch proved what that costs: the
    // cover-letter writer stopped without calling submit_result, and a package
    // whose résumé DOCX was already built, stored and passing every QA check
    // was recorded as `failed`. The founder had a usable tailored résumé and no
    // way to see it. Most applications do not require a cover letter at all.
    //
    // So the résumé survives on its own. The letter's absence is an error the
    // caller reports and `assessPackage` turns into an attention item — the
    // package is not READY, but it is not destroyed either.
    const letterFailed = !letter.fullText
    if (letterFailed) errors.push(`cover letter: ${letter.error ?? 'no letter produced'}`)
    if (letter.flagged) warnings.push('cover letter has grounding findings — review before finalizing')

    // ─── Everything that must exist, checked against what does ───
    stage = 'documents'
    await io.updatePackage(pkg.id, { stage })
    const missing = missingArtifacts({
      resumeDocxPath, resumeQaPresent: qa.resume !== null,
      coverDocxPath: letter.documents?.docxPath ?? null,
      coverQaPresent: qa.cover_letter !== null,
      coverLetterText: letter.fullText,
      // With no letter there is nothing to require of one; requiring its DOCX
      // here would reinstate the total failure this block just removed.
      letterExpected: !letterFailed,
    })
    if (missing.length) return fail(`the package is incomplete — missing ${missing.join(', ')}`)

    // ─── Blocking QA stops here, visibly ───
    const blocking = [...(qa.resume?.checks ?? []), ...(qa.cover_letter?.checks ?? [])].filter((c) => c.blocking && !c.pass)
    if (blocking.length) return fail(`document QA failed: ${blocking.map((c) => `${c.name} (${c.detail})`).join('; ')}`)

    // "Install Word" is only true when a PDF was WANTED and could not be made.
    // With --no-pdf the résumé PDF is absent by request, and telling someone to
    // install software they already have — to fix a thing they asked for — is
    // how a warning list stops being read.
    const missingPdf = !resumePdfPath || !letter.documents?.pdfPath
    if (missingPdf && !params.skipPdf) {
      warnings.push('one or more PDFs were not produced — the DOCX files are complete and stored. Install Microsoft Word or LibreOffice on the server to get PDFs.')
    } else if (missingPdf && params.skipPdf && !letter.documents?.pdfPath) {
      warnings.push('the cover-letter PDF was not produced — its DOCX is complete and stored.')
    }

    await io.updatePackage(pkg.id, { status: 'ready_for_review', stage: 'documents', error: null })
    let applicationState: ApplicationState | null = null
    if (pkg.application_id) {
      const moved = await io.transitionApplication(params.userId, pkg.application_id, 'READY_FOR_REVIEW', { actor: 'system', detail: { package_id: pkg.id } })
      if (!moved.ok) warnings.push(`application: ${moved.error}`)
      applicationState = moved.application?.state ?? null
    }
    await run.finish('succeeded', { package_id: pkg.id, shrink_attempts: shrinkAttempts, flagged_letter: letter.flagged, reused_resume: plan.reuseResume }, null)
    return {
      packageId: pkg.id, status: 'ready_for_review', stage: 'documents', version: pkg.version, applicationId: pkg.application_id, applicationState,
      resume: null, costUsd: Number((costBase + run.costUsd()).toFixed(4)), warnings, errors, error: null, migrationMissing: false,
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
}
