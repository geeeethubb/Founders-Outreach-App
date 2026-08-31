// Pieces both halves of the package pipeline need: the stage vocabulary, the
// result shape, and the few small loaders that generate and finish both call.
//
// It exists so `orchestrator.ts` (generate) and `documents.ts` (finish) can
// each stay readable without importing one another — a cycle whose only
// symptom would be an undefined function at module-init time in a bundler.
// Everything here is re-exported from `orchestrator.ts`, which is still the
// name every route and script imports.

import type { CompanyResearch } from '@/lib/agents/company-researcher'
import { letterPointsFromFacts, type JobContext } from '../intelligence/load'
import { groundedPoints } from '../research/company'
import type { CompanyResearchForLetter } from '../letter/pipeline'
import type { LetterDeps } from '../letter/pipeline'
import type { TailorDeps, VerifiedChange } from '../tailor/pipeline'
import type { EvidenceMapForTailor } from '../tailor/render'
import { resolveApplicantName } from '../identity'
import { contactFromParagraphMap } from './letter'
import { loadProfile, type LetterSigner } from './persist'
import type { ChangeWithId } from './resume'
import type { ApplicationPackage, ApplicationState, DocumentQaReport, PackageStatus, ResumePatchChange } from '../types'

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

export const MIGRATION = 'migration 014_career_os.sql has not been applied'

export function failed(error: string, migrationMissing = false, extra: Partial<PackageResult> = {}): PackageResult {
  return {
    packageId: null, status: null, stage: null, version: null, applicationId: null, applicationState: null, resume: null,
    costUsd: 0, warnings: [], errors: [error], error, migrationMissing, ...extra,
  }
}

/** The tailor needs a map; without a matcher result it gets an honest empty one. */
export function tailorMapFrom(map: { why_i_fit: string | null; emphasize: string[]; do_not_claim: string[]; top_experience_ids: string[] } | null): EvidenceMapForTailor {
  return map ?? { why_i_fit: null, emphasize: [], do_not_claim: [], top_experience_ids: [] }
}

export function bankIsUsable(ctx: JobContext): string | null {
  if (!ctx.bank.masterDocument) return 'Evidence Bank is empty — import and approve your résumé first'
  if (!ctx.bank.bullets.some((b) => b.is_on_master && b.approved)) return 'Evidence Bank is empty — import and approve your résumé first'
  return null
}

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

/**
 * Who signs. The name goes through resolveApplicantName — profiles.name is
 * the email local-part for anyone the signup trigger named, and the first
 * live letter opened "zuyu.alex06" because this used to trust it first.
 */
export async function letterSigner(userId: string, ctx: JobContext): Promise<LetterSigner> {
  const profile = await loadProfile(userId)
  const contact = contactFromParagraphMap(ctx.bank.masterDocument?.paragraph_map ?? [])
  const { name, source } = resolveApplicantName({ profileName: profile.name, bank: ctx.bank })
  return { name, nameSource: source, email: contact.email ?? profile.email ?? '', phone: contact.phone ?? '', linkedin: contact.linkedin ?? profile.linkedin_url }
}
