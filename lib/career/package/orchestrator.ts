// The application package, in three human-gated steps.
//
//   generatePackage   intelligence → tailoring → STOP at résumé review   (here)
//   finishPackage     approved changes → documents → cover letter        (documents.ts)
//   finalizePackage   the human has read everything → READY_TO_APPLY     (here)
//
// The stop after tailoring is the product: the diff is reviewed by a person
// before a single document exists, so nothing that was not approved can be
// rendered. Every stage writes `application_packages.stage` for the progress
// UI, every agent call is traced on one run of kind 'package', and a failure
// lands on the package row as `status: failed` + `error` — never silently.
//
// This module is still the front door: the document half and the shared
// vocabulary are re-exported below, so routes and scripts keep importing
// `package/orchestrator`.
//
// Nothing here submits anything. The last action is still a link.

import { ensureApplication, transitionApplication, updateApplicationDetails } from '../applications/store'
import { runJobIntelligence, packageToolContext, type IntelligenceStage } from '../intelligence/orchestrator'
import { loadJobContext } from '../intelligence/load'
import { DEFAULT_PACKAGE_BUDGET, startCareerRun } from '../runs'
import { runTailoringPipeline } from '../tailor/pipeline'
import { jobTermsFor, tailorJobFromOpportunity } from '../tailor/render'
import type { ToolContext } from '@/lib/agents/runtime/types'
import type { ApplicationPackage, ApplicationState, PackageStatus } from '../types'
import { ensureJobSnapshot, getCoverLetter, getPackage, insertPackage, insertResumePatch, nextPackageVersion, supersedePackages, updatePackage } from './persist'
import { bankIsUsable, failed, MIGRATION, tailorMapFrom, type PackageDeps, type PackageResult, type PackageStage } from './shared'

export { finishPackage, planDocumentWork, REAL_DOCUMENTS_IO } from './documents'
export type { DocumentPlan, DocumentPlanInput, DocumentsIo, FinishPackageParams } from './documents'
export {
  bankIsUsable, changesFromRows, failed, letterResearchFor, letterSigner, MIGRATION, tailorMapFrom,
} from './shared'
export type { PackageDeps, PackageQa, PackageResult, PackageStage } from './shared'

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
  const applicationState: ApplicationState = moved.application?.state ?? app.application.state

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

  // The stage that is RUNNING, so a failure is recorded against the work that
  // was actually happening rather than where the row happened to be.
  let stage: PackageStage = 'started'
  const fail = async (error: string): Promise<PackageResult> => {
    await updatePackage(pkg.id, { status: 'failed', stage, error, cost_usd: run.costUsd() })
    await run.finish('failed', { package_id: pkg.id, stage }, error)
    return failed(error, false, { packageId: pkg.id, version: pkg.version, stage, status: 'failed', applicationId: app.application?.id ?? null, applicationState, costUsd: run.costUsd(), warnings, errors: [...errors, error] })
  }

  try {
    // ─── Intelligence (stored answers reused when fresh) ───
    stage = 'intelligence'
    progress('intelligence', context.job.company_name)
    await updatePackage(pkg.id, { stage })
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
    stage = 'tailoring'
    progress('tailoring', context.job.title)
    await updatePackage(pkg.id, { stage })
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

    stage = 'resume_review'
    await updatePackage(pkg.id, { resume_patch_id: patch.patch.patch.id, status: 'resume_review', stage, cost_usd: run.costUsd() })
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
