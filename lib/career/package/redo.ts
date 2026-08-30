// Redo: a NEW package version beside whatever exists, never an edit in place.
//
// Two shapes of redo, one rule. A locked package is the record of what was
// submitted (applications.locked, ADR: submitted documents are never
// overwritten); a redo of any package therefore always inserts a new version
// and leaves the old row and its files exactly where they are.
//
//   redoPackage          the founder's "Redo package (new version)": the full
//                        path — intelligence (cached when fresh), tailoring,
//                        stop at résumé review. Costs what a package costs.
//   clonePackageVersion  a new version that reuses the OLD package's reviewed
//                        résumé patch and snapshots, positioned at
//                        resume_review so finishPackage can render it. No
//                        model call. The name-repair script builds on this.
//
// Nothing here submits anything.

import { updateApplicationDetails } from '../applications/store'
import type { ApplicationPackage } from '../types'
import { generatePackage, type PackageResult } from './orchestrator'
import { getPackage, insertPackage, nextPackageVersion, supersedePackages, updatePackage } from './persist'

const MIGRATION = 'migration 014_career_os.sql has not been applied'

export interface RedoResult extends PackageResult {
  /** The package the redo was asked on; its status is untouched when it was locked. */
  fromPackageId: string
  fromStatus: ApplicationPackage['status'] | null
}

/** A new version through the whole generate path. The old package becomes superseded unless it is locked. */
export async function redoPackage(params: { userId: string; packageId: string }): Promise<RedoResult> {
  const got = await getPackage(params.userId, params.packageId)
  const base = { fromPackageId: params.packageId, fromStatus: got.pkg?.status ?? null }
  if (got.migrationMissing) return { ...emptyResult(MIGRATION, true), ...base }
  if (!got.pkg) return { ...emptyResult('package not found'), ...base }
  if (got.pkg.status === 'generating') return { ...emptyResult('package is still generating — wait for it to finish'), ...base }
  const r = await generatePackage({ userId: params.userId, jobId: got.pkg.job_id })
  return { ...r, ...base }
}

export interface CloneResult {
  pkg: ApplicationPackage | null
  error: string | null
  migrationMissing: boolean
}

/**
 * Insert version N+1 for the job carrying the source package's résumé patch
 * and intelligence snapshots, at status resume_review. The caller then runs
 * finishPackage (with or without `letterFromStored`) to render documents.
 */
export async function clonePackageVersion(params: { userId: string; source: ApplicationPackage; runId?: string | null }): Promise<CloneResult> {
  const { source } = params
  if (!source.resume_patch_id) return { pkg: null, error: 'source package has no résumé patch to carry', migrationMissing: false }
  const sup = await supersedePackages(params.userId, source.job_id)
  if (sup.migrationMissing) return { pkg: null, error: MIGRATION, migrationMissing: true }
  const ver = await nextPackageVersion(params.userId, source.job_id)
  const ins = await insertPackage({
    user_id: params.userId, job_id: source.job_id, application_id: source.application_id, version: ver.version,
    run_id: params.runId ?? null, job_snapshot_id: source.job_snapshot_id,
  })
  if (!ins.pkg) return { pkg: null, error: ins.error ?? 'could not create the package', migrationMissing: ins.migrationMissing }
  const w = await updatePackage(ins.pkg.id, {
    resume_patch_id: source.resume_patch_id,
    company_research_snapshot: source.company_research_snapshot, fit_snapshot: source.fit_snapshot,
    evidence_map_snapshot: source.evidence_map_snapshot, warm_paths_snapshot: source.warm_paths_snapshot,
    status: 'resume_review', stage: 'resume_review', cost_usd: 0,
  })
  if (w.error) return { pkg: null, error: w.error, migrationMissing: w.migrationMissing }
  // The application points at the newest version. A locked application keeps
  // submitted_package_id — that is the record; current_package_id is only
  // "what to open next".
  if (source.application_id) await updateApplicationDetails(params.userId, source.application_id, { current_package_id: ins.pkg.id })
  return { pkg: { ...ins.pkg, resume_patch_id: source.resume_patch_id, status: 'resume_review', stage: 'resume_review' }, error: null, migrationMissing: false }
}

function emptyResult(error: string, migrationMissing = false): PackageResult {
  return {
    packageId: null, status: null, stage: null, version: null, applicationId: null, applicationState: null, resume: null,
    costUsd: 0, warnings: [], errors: [error], error, migrationMissing,
  }
}
