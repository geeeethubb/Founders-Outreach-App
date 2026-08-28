// The application package, in three human-gated steps.
//
//   generatePackage   intelligence → tailoring → STOP at résumé review
//   finishPackage     approved changes → documents → cover letter → READY_FOR_REVIEW
//   finalizePackage   the human has read everything → READY_TO_APPLY
//
// The stop after tailoring is the product: the diff is reviewed by a person
// before a single document exists, so nothing that was not approved can be
// rendered. Every stage writes `application_packages.stage` for the progress
// UI, every agent call is traced on one run of kind 'package', and a failure
// lands on the package row as `status: failed` + `error` — never silently.
//
// Nothing here submits anything. The last action is still a link.

import { loadDocument } from '../documents/store'
import { ensureApplication, transitionApplication, updateApplicationDetails } from '../applications/store'
import { runJobIntelligence, packageToolContext, type IntelligenceStage } from '../intelligence/orchestrator'
import { letterPointsFromFacts, loadJobContext, type JobContext } from '../intelligence/load'
import { groundedPoints } from '../research/company'
import type { CompanyResearch } from '@/lib/agents/company-researcher'
import type { CompanyResearchForLetter } from '../letter/pipeline'
import { DEFAULT_PACKAGE_BUDGET, startCareerRun, type CareerRun } from '../runs'
import { runTailoringPipeline, type TailorDeps, type VerifiedChange } from '../tailor/pipeline'
import { jobTermsFor, tailorJobFromOpportunity, type EvidenceMapForTailor } from '../tailor/render'
import type { LetterDeps } from '../letter/pipeline'
import type { ToolContext } from '@/lib/agents/runtime/types'
import type { ApplicationPackage, ApplicationState, DocumentQaReport, PackageStatus, ResumePatchChange } from '../types'
import { contactFromParagraphMap, generateCoverLetter } from './letter'
import {
  ensureJobSnapshot, getCoverLetter, getPackage, insertPackage, insertResumePatch, loadProfile, loadResumePatch, nextPackageVersion,
  supersedePackages, updatePackage, updateResumePatch, type LetterSigner,
} from './persist'
import { generateResumeDocuments, type ChangeWithId } from './resume'

export type PackageStage =
  | 'started' | 'intelligence' | 'tailoring' | 'resume_review' | 'resume_documents' | 'cover_letter' | 'documents' | 'finalized'

export interface PackageQa {
  resume: DocumentQaReport | null
  cover_letter: DocumentQaReport | null
}

export interface PackageResult {
  packageId: string | null
  status: PackageStatus | null
  stage: PackageStage | null
  version: number | null
  applicationId: string | null
  applicationState: ApplicationState | null
  resume: { proposed: number; supported: number; autoRejected: number; noChangeReason: string | null; summary: string } | null
  costUsd: number
  warnings: string[]
  errors: string[]
  error: string | null
  migrationMissing: boolean
}

export interface PackageDeps {
  tailor?: Partial<TailorDeps>
  letter?: Partial<LetterDeps>
}

const MIGRATION = 'migration 014_career_os.sql has not been applied'

function failed(error: string, migrationMissing = false, extra: Partial<PackageResult> = {}): PackageResult {
  return {
    packageId: null, status: null, stage: null, version: null, applicationId: null, applicationState: null, resume: null,
    costUsd: 0, warnings: [], errors: [error], error, migrationMissing, ...extra,
  }
}

/** The tailor needs a map; without a matcher result it gets an honest empty one. */
function tailorMapFrom(map: { why_i_fit: string | null; emphasize: string[]; do_not_claim: string[]; top_experience_ids: string[] } | null): EvidenceMapForTailor {
  return map ?? { why_i_fit: null, emphasize: [], do_not_claim: [], top_experience_ids: [] }
}

export function bankIsUsable(ctx: JobContext): string | null {
  if (!ctx.bank.masterDocument) return 'Evidence Bank is empty — import and approve your résumé first'
  if (!ctx.bank.bullets.some((b) => b.is_on_master && b.approved)) return 'Evidence Bank is empty — import and approve your résumé first'
  return null
}

// ─── Step 1: generate ────────────────────────────────────────────────────────

export async function generatePackage(params: {
  userId: string
  jobId: string
  ctx?: ToolContext
  deps?: PackageDeps
  onProgress?: (stage: PackageStage | IntelligenceStage, detail: string) => void
}): Promise<PackageResult> {
  const progress = params.onProgress ?? (() => {})
  const warnings: string[] = []
  const errors: string[] = []

  const loaded = await loadJobContext(params.userId, params.jobId)
  if (!loaded.ctx) return failed(loaded.error, loaded.migrationMissing)
  const context = loaded.ctx
  const unusable = bankIsUsable(context)
  if (unusable) return failed(unusable)
  if (context.job.verification_status === 'CLOSED') warnings.push('This posting is marked CLOSED; generating anyway')

  // Application first, so the package has a parent to hang from.
  const app = await ensureApplication(params.userId, params.jobId, { initialState: 'SAVED', companyId: context.job.company_id })
  if (app.migrationMissing) return failed(MIGRATION, true)
  if (!app.application) return failed(app.error ?? 'could not create the application')
  const moved = await transitionApplication(params.userId, app.application.id, 'PREPARING', { actor: 'system', detail: { reason: 'package generation' } })
  if (!moved.ok) warnings.push(`application stays ${app.application.state}: ${moved.error}`)
  let applicationState: ApplicationState = moved.application?.state ?? app.application.state

  const run = await startCareerRun({
    userId: params.userId, kind: 'package', label: `package: ${context.job.company_name} — ${context.job.title}`,
    mission: { job_id: params.jobId, mission_id: context.mission.id }, budget: DEFAULT_PACKAGE_BUDGET, careerMissionId: context.mission.id,
  })
  const ctx = params.ctx ?? packageToolContext(params.userId, run.runId)

  const sup = await supersedePackages(params.userId, params.jobId)
  if (sup.error) errors.push(`supersede: ${sup.error}`)
  const ver = await nextPackageVersion(params.userId, params.jobId)
  const snap = await ensureJobSnapshot(context.job, context.existing.latestSnapshot)
  if (snap.error) warnings.push(`snapshot: ${snap.error}`)
  const ins = await insertPackage({ user_id: params.userId, job_id: params.jobId, application_id: app.application.id, version: ver.version, run_id: run.runId, job_snapshot_id: snap.id })
  if (!ins.pkg) {
    await run.finish('failed', {}, ins.error)
    return failed(ins.error ?? 'could not create the package', ins.migrationMissing, { applicationId: app.application.id, applicationState })
  }
  const pkg = ins.pkg
  await updateApplicationDetails(params.userId, app.application.id, { current_package_id: pkg.id })

  const fail = async (error: string): Promise<PackageResult> => {
    await updatePackage(pkg.id, { status: 'failed', error, cost_usd: run.costUsd() })
    await run.finish('failed', { package_id: pkg.id }, error)
    return failed(error, false, { packageId: pkg.id, version: pkg.version, status: 'failed', applicationId: app.application?.id ?? null, applicationState, costUsd: run.costUsd(), warnings, errors: [...errors, error] })
  }

  try {
    // ─── Intelligence (stored answers reused when fresh) ───
    progress('intelligence', context.job.company_name)
    await updatePackage(pkg.id, { stage: 'intelligence' })
    const intel = await runJobIntelligence({ userId: params.userId, jobId: params.jobId, ctx, run, context, onProgress: progress })
    errors.push(...intel.errors)
    await updatePackage(pkg.id, {
      company_research_snapshot: intel.research ? (intel.research as unknown as Record<string, unknown>) : null,
      fit_snapshot: intel.fit ? { judgment: intel.fit.judgment, evaluation: intel.fit.evaluation } : null,
      evidence_map_snapshot: intel.evidenceMap ? (intel.evidenceMap as unknown as Record<string, unknown>) : null,
      warm_paths_snapshot: { paths: intel.warmPaths },
      cost_usd: run.costUsd(),
    })

    // ─── Tailoring ───
    progress('tailoring', context.job.title)
    await updatePackage(pkg.id, { stage: 'tailoring' })
    const tailorJob = tailorJobFromOpportunity(context.job)
    const tailored = await runTailoringPipeline({
      bank: context.bank, job: tailorJob, evidenceMap: tailorMapFrom(intel.evidenceMap), ctx, jobTerms: jobTermsFor(tailorJob), deps: params.deps?.tailor,
      onStep: (s) => progress('tailoring', `${s.stage}: ${s.detail}`),
    })
    let agentRunId: string | null = null
    for (const r of tailored.runs) agentRunId = (await run.trace(r, { job_id: params.jobId, package_id: pkg.id })) ?? agentRunId
    if (tailored.error) errors.push(tailored.error)

    const patch = await insertResumePatch({
      userId: params.userId, jobId: params.jobId, packageId: pkg.id, baseDocumentId: context.bank.masterDocument?.id ?? null,
      noChangeReason: tailored.no_change_reason, summary: tailored.summary, editDistance: tailored.distance.distance,
      tailorVersion: tailored.tailor_version, verifierVersion: tailored.verifier_version, agentRunId, changes: tailored.changes,
    })
    if (!patch.patch) return fail(`resume patch persist: ${patch.error}`)
    if (patch.error) errors.push(`resume patch changes: ${patch.error}`)

    await updatePackage(pkg.id, { resume_patch_id: patch.patch.patch.id, status: 'resume_review', stage: 'resume_review', cost_usd: run.costUsd() })
    await run.finish('succeeded', { package_id: pkg.id, changes: tailored.changes.length, errors }, null)

    return {
      packageId: pkg.id, status: 'resume_review', stage: 'resume_review', version: pkg.version,
      applicationId: app.application.id, applicationState,
      resume: {
        proposed: tailored.changes.length,
        supported: tailored.changes.filter((c) => c.verification_result === 'SUPPORTED').length,
        autoRejected: tailored.changes.filter((c) => c.review_status === 'auto_rejected').length,
        noChangeReason: tailored.no_change_reason, summary: tailored.summary,
      },
      costUsd: Number(run.costUsd().toFixed(4)), warnings, errors, error: null, migrationMissing: false,
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
}

// ─── Step 2: finish (after the résumé review) ────────────────────────────────

export function changesFromRows(rows: ResumePatchChange[]): ChangeWithId[] {
  return rows.map((r) => ({
    ...(r as unknown as VerifiedChange),
    id: r.id,
    precheck_findings: (r.precheck_findings as VerifiedChange['precheck_findings']) ?? null,
    confidence: Number(r.confidence ?? 0),
  }))
}

/**
 * What the letter may cite: stored research_facts rows (by id) when the job
 * has a companies row; otherwise the grounded points of the research snapshot
 * the package captured. A job with no company row has no facts table entry,
 * and a letter with zero citable points is a letter with no reason to write.
 */
export function letterResearchFor(ctx: JobContext, pkg: Pick<ApplicationPackage, 'company_research_snapshot'>): CompanyResearchForLetter {
  const points = letterPointsFromFacts(ctx.existing.research.facts)
  const snap = pkg.company_research_snapshot as unknown as CompanyResearch | null
  const summary = ctx.existing.research.summary ?? snap?.summary ?? ''
  if (points.length || !snap || !Array.isArray(snap.why_interesting_for_intern)) return { points, summary }
  return { points: groundedPoints(snap).map((p) => ({ id: p.id, text: p.text })), summary }
}

export async function letterSigner(userId: string, ctx: JobContext): Promise<LetterSigner> {
  const profile = await loadProfile(userId)
  const contact = contactFromParagraphMap(ctx.bank.masterDocument?.paragraph_map ?? [])
  const name = profile.name ?? ctx.bank.masterDocument?.paragraph_map.find((e) => e.kind === 'name')?.text ?? 'Applicant'
  return { name, email: contact.email ?? profile.email ?? '', phone: contact.phone ?? '', linkedin: contact.linkedin ?? profile.linkedin_url }
}

export async function finishPackage(params: {
  userId: string
  packageId: string
  ctx?: ToolContext
  deps?: PackageDeps
  onProgress?: (stage: PackageStage, detail: string) => void
}): Promise<PackageResult> {
  const progress = params.onProgress ?? (() => {})
  const warnings: string[] = []
  const errors: string[] = []
  const got = await getPackage(params.userId, params.packageId)
  if (got.migrationMissing) return failed(MIGRATION, true)
  if (!got.pkg) return failed('package not found')
  const pkg = got.pkg
  if (!['resume_review', 'failed', 'ready_for_review'].includes(pkg.status)) return failed(`package is ${pkg.status}; documents can only be built from resume_review`)
  if (!pkg.resume_patch_id) return failed('package has no résumé patch')

  const loaded = await loadJobContext(params.userId, pkg.job_id)
  if (!loaded.ctx) return failed(loaded.error, loaded.migrationMissing)
  const context = loaded.ctx
  const patch = await loadResumePatch(params.userId, pkg.resume_patch_id)
  if (!patch.patch) return failed(patch.error ?? 'résumé patch not found')
  const storagePath = context.bank.masterDocument?.storage_path
  const master = storagePath ? await loadDocument(storagePath) : null
  if (!master) return failed('master résumé file is missing from storage — re-import it')

  const run = await startCareerRun({
    userId: params.userId, kind: 'package', label: `package documents: ${context.job.company_name} v${pkg.version}`,
    mission: { job_id: pkg.job_id, package_id: pkg.id }, budget: DEFAULT_PACKAGE_BUDGET, careerMissionId: context.mission.id,
  })
  const ctx = params.ctx ?? packageToolContext(params.userId, run.runId)
  const costBase = Number(pkg.cost_usd ?? 0)
  // One folder per attempt: storage refuses to overwrite (upsert:false, and
  // the local mirror throws), so a re-run after a QA failure must not land on
  // the paths the failed attempt already wrote.
  const output = { kind: 'store' as const, userId: params.userId, relativePrefix: `packages/${pkg.id}/v${pkg.version}/${Date.now()}` }
  const qa: PackageQa = { resume: null, cover_letter: null }
  const setQa = () => qa as unknown as DocumentQaReport

  const fail = async (error: string): Promise<PackageResult> => {
    await updatePackage(pkg.id, { status: 'failed', stage: pkg.stage, error, qa: setQa(), cost_usd: costBase + run.costUsd() })
    await run.finish('failed', { package_id: pkg.id }, error)
    return failed(error, false, { packageId: pkg.id, version: pkg.version, status: 'failed', applicationId: pkg.application_id, costUsd: costBase + run.costUsd(), warnings, errors: [...errors, error] })
  }

  try {
    // ─── Résumé documents ───
    progress('resume_documents', context.job.company_name)
    await updatePackage(pkg.id, { stage: 'resume_documents', error: null })
    const changes = changesFromRows(patch.patch.changes)
    const resume = await generateResumeDocuments({ bank: context.bank, masterBuffer: master, changes, company: context.job.company_name, output })
    warnings.push(...resume.warnings)
    if (resume.droppedByShrink.length) warnings.push(`dropped to fit one page: ${resume.droppedByShrink.join(', ')}`)
    qa.resume = resume.qa
    await updatePackage(pkg.id, {
      resume_docx_path: resume.docxPath, resume_pdf_path: resume.pdfPath, resume_filename: resume.filenames.docx, qa: setQa(),
    })
    if (resume.error) return fail(`résumé document: ${resume.error}`)
    await updateResumePatch(patch.patch.patch.id, { status: 'applied' })

    // ─── Cover letter ───
    progress('cover_letter', context.job.company_name)
    await updatePackage(pkg.id, { stage: 'cover_letter' })
    const signer = await letterSigner(params.userId, context)
    const letter = await generateCoverLetter({
      bank: context.bank,
      job: context.job,
      research: letterResearchFor(context, pkg),
      evidenceMap: context.existing.evidenceMap ?? { why_i_fit: null, fact_ids: [], story_ids: [], top_experience_ids: [] },
      user: signer, ctx, run, deps: params.deps?.letter, output,
      persist: { userId: params.userId, jobId: pkg.job_id, packageId: pkg.id },
      onStep: (s) => progress('cover_letter', `attempt ${s.attempt}: ${s.detail}`),
    })
    errors.push(...letter.errors)
    if (letter.documents) {
      warnings.push(...letter.documents.warnings)
      qa.cover_letter = letter.documents.qa
    }
    await updatePackage(pkg.id, {
      cover_letter_id: letter.row?.id ?? null,
      cover_docx_path: letter.documents?.docxPath ?? null, cover_pdf_path: letter.documents?.pdfPath ?? null,
      cover_filename: letter.documents?.filenames.docx ?? null, qa: setQa(), cost_usd: costBase + run.costUsd(),
    })
    if (!letter.letter.fullText) return fail(`cover letter: ${letter.letter.error ?? 'no letter produced'}`)
    if (letter.flagged) warnings.push('cover letter has grounding findings — review before finalizing')

    // ─── Blocking QA stops here, visibly ───
    const blocking = [...(qa.resume?.checks ?? []), ...(qa.cover_letter?.checks ?? [])].filter((c) => c.blocking && !c.pass)
    if (blocking.length) return fail(`document QA failed: ${blocking.map((c) => `${c.name} (${c.detail})`).join('; ')}`)

    await updatePackage(pkg.id, { status: 'ready_for_review', stage: 'documents', error: null })
    let applicationState: ApplicationState | null = null
    if (pkg.application_id) {
      const moved = await transitionApplication(params.userId, pkg.application_id, 'READY_FOR_REVIEW', { actor: 'system', detail: { package_id: pkg.id } })
      if (!moved.ok) warnings.push(`application: ${moved.error}`)
      applicationState = moved.application?.state ?? null
    }
    await run.finish('succeeded', { package_id: pkg.id, shrink_attempts: resume.shrink_attempts, flagged_letter: letter.flagged }, null)
    return {
      packageId: pkg.id, status: 'ready_for_review', stage: 'documents', version: pkg.version, applicationId: pkg.application_id, applicationState,
      resume: null, costUsd: Number((costBase + run.costUsd()).toFixed(4)), warnings, errors, error: null, migrationMissing: false,
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
}

// ─── Step 3: finalize ────────────────────────────────────────────────────────

export async function finalizePackage(params: { userId: string; packageId: string; acknowledgeLetter?: boolean }): Promise<{
  ok: boolean; status: PackageStatus | null; applicationState: ApplicationState | null; error: string | null; migrationMissing: boolean
}> {
  const got = await getPackage(params.userId, params.packageId)
  if (got.migrationMissing) return { ok: false, status: null, applicationState: null, error: MIGRATION, migrationMissing: true }
  if (!got.pkg) return { ok: false, status: null, applicationState: null, error: 'package not found', migrationMissing: false }
  const pkg: ApplicationPackage = got.pkg
  if (pkg.status !== 'ready_for_review') return { ok: false, status: pkg.status, applicationState: null, error: `package is ${pkg.status}, not ready_for_review`, migrationMissing: false }

  if (pkg.cover_letter_id && !params.acknowledgeLetter) {
    const letter = await getCoverLetter(params.userId, pkg.cover_letter_id)
    const status = letter.letter?.review_status
    if (status !== 'approved' && status !== 'edited') {
      return { ok: false, status: pkg.status, applicationState: null, error: `cover letter is ${status ?? 'missing'} — approve or edit it first (or pass acknowledge)`, migrationMissing: false }
    }
  }

  const w = await updatePackage(pkg.id, { status: 'ready_to_apply', stage: 'finalized', approved_at: new Date().toISOString() })
  if (w.error) return { ok: false, status: pkg.status, applicationState: null, error: w.error, migrationMissing: w.migrationMissing }
  let applicationState: ApplicationState | null = null
  if (pkg.application_id) {
    const moved = await transitionApplication(params.userId, pkg.application_id, 'READY_TO_APPLY', { actor: 'user', detail: { package_id: pkg.id } })
    applicationState = moved.application?.state ?? null
  }
  return { ok: true, status: 'ready_to_apply', applicationState, error: null, migrationMissing: false }
}
