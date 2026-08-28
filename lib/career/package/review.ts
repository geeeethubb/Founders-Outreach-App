// The two human reviews a package goes through: the résumé diff and the letter.
//
// Résumé: decisions are applied by applyReviewDecisions (pure, from the
// tailoring pipeline) with the human's edits re-verified through the same
// gate the tailor's proposals went through. "Approve all safe" is a
// deterministic rule — pending, SUPPORTED, edit level ≤ 3 — never a model's
// opinion of what is safe; a Level-4 addition always needs an explicit yes.
//
// Letter: an edit is re-gated against the same pools the draft was gated
// against. Blocking findings keep the letter pending and are returned; the
// human can approve only a letter the gate passed.

import { runResumeFactVerifier } from '@/lib/agents/resume-fact-verifier'
import type { ToolContext } from '@/lib/agents/runtime/types'
import { buildBankPool } from '../evidence/render'
import { loadJobContext } from '../intelligence/load'
import { packageToolContext } from '../intelligence/orchestrator'
import { gateCoverLetter, type LetterGrounding } from '../letter/grounding'
import { countWords } from '@/lib/agents/cover-letter-writer'
import { DEFAULT_PACKAGE_BUDGET, startCareerRun } from '../runs'
import { applyReviewDecisions, verifyEditedText, type ReviewDecision, type TailorDeps, type VerifiedChange } from '../tailor/pipeline'
import { jobTermsFor, tailorJobFromOpportunity } from '../tailor/render'
import type { CoverLetter, ResumePatchChange } from '../types'
import { generateCoverLetter, regenerateLetterDocuments, splitLetterText } from './letter'
import { changesFromRows, letterResearchFor, letterSigner } from './orchestrator'
import { getCoverLetter, getPackage, loadResumePatch, updateCoverLetter, updatePackage, updatePatchChange, updateResumePatch } from './persist'
import type { ChangeWithId } from './resume'

const MIGRATION = 'migration 014_career_os.sql has not been applied'

export interface ResumeReviewInput {
  userId: string
  packageId: string
  decisions?: ReviewDecision[]
  approveAllSafe?: boolean
  ctx?: ToolContext
  deps?: Partial<TailorDeps>
}

export interface ResumeReviewResult {
  changes: ChangeWithId[]
  refused: { decision: ReviewDecision; reason: string }[]
  updated: number
  errors: string[]
  error: string | null
  migrationMissing: boolean
}

export const APPROVE_ALL_SAFE_MAX_LEVEL = 3

/** Package statuses whose résumé diff and letter may still be reviewed. */
const REVIEWABLE = new Set<string>(['resume_review', 'ready_for_review', 'failed'])

/** Pure: which changes "approve all safe" approves. */
export function safeToApprove(changes: VerifiedChange[]): ReviewDecision[] {
  return changes
    .map((c, index) => ({ c, index }))
    .filter(({ c }) => c.review_status === 'pending' && c.verification_result === 'SUPPORTED' && c.edit_level <= APPROVE_ALL_SAFE_MAX_LEVEL)
    .map(({ c, index }) => ((c as ChangeWithId).id ? { id: (c as ChangeWithId).id, action: 'approve' as const } : { index, action: 'approve' as const }))
}

/** Which columns changed between the stored row and the reviewed change. */
function reviewPatch(before: ChangeWithId, after: VerifiedChange): Partial<ResumePatchChange> | null {
  const keys: (keyof VerifiedChange)[] = [
    'review_status', 'final_text', 'proposed_text', 'change_type', 'edit_level', 'verification_result', 'verification_notes', 'verification_clauses', 'precheck_findings',
  ]
  const patch: Record<string, unknown> = {}
  for (const k of keys) if (JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)) patch[k] = after[k] ?? null
  return Object.keys(patch).length ? (patch as Partial<ResumePatchChange>) : null
}

export async function reviewResumeChanges(input: ResumeReviewInput): Promise<ResumeReviewResult> {
  const errors: string[] = []
  const got = await getPackage(input.userId, input.packageId)
  if (got.migrationMissing) return { changes: [], refused: [], updated: 0, errors, error: MIGRATION, migrationMissing: true }
  if (!got.pkg) return { changes: [], refused: [], updated: 0, errors, error: 'package not found', migrationMissing: false }
  if (!got.pkg.resume_patch_id) return { changes: [], refused: [], updated: 0, errors, error: 'package has no résumé patch', migrationMissing: false }
  // locked/superseded are history; ready_to_apply and generating have no
  // review to hold — a finalized package's documents would silently drift
  // from its changes, and a generating one has no complete patch yet.
  if (!REVIEWABLE.has(got.pkg.status)) return { changes: [], refused: [], updated: 0, errors, error: `package is ${got.pkg.status}`, migrationMissing: false }

  const patch = await loadResumePatch(input.userId, got.pkg.resume_patch_id)
  if (!patch.patch) return { changes: [], refused: [], updated: 0, errors, error: patch.error ?? 'patch not found', migrationMissing: false }
  const before = changesFromRows(patch.patch.changes)

  const decisions = input.approveAllSafe ? safeToApprove(before) : input.decisions ?? []
  const needsVerifier = decisions.some((d) => d.action === 'edit')

  let verifyEdit: ((c: VerifiedChange, text: string) => Promise<VerifiedChange>) | undefined
  let finish: (() => Promise<void>) | null = null
  if (needsVerifier) {
    const loaded = await loadJobContext(input.userId, got.pkg.job_id)
    if (!loaded.ctx) return { changes: before, refused: [], updated: 0, errors, error: loaded.error, migrationMissing: loaded.migrationMissing }
    const context = loaded.ctx
    const run = await startCareerRun({
      userId: input.userId, kind: 'package', label: `résumé edit verification: ${context.job.company_name}`,
      mission: { package_id: got.pkg.id }, budget: DEFAULT_PACKAGE_BUDGET, careerMissionId: context.mission.id,
    })
    const ctx = input.ctx ?? packageToolContext(input.userId, run.runId)
    const jobTerms = jobTermsFor(tailorJobFromOpportunity(context.job))
    // Trace the verifier by wrapping it: verifyEditedText has no runs[] seam.
    const verifier: TailorDeps['verifier'] = async (vin, vctx) => {
      const r = await (input.deps?.verifier ?? runResumeFactVerifier)(vin, vctx)
      await run.trace(r, { package_id: got.pkg?.id ?? null, stage: 'edit_verification' })
      return r
    }
    verifyEdit = (c, text) => verifyEditedText(context.bank, c, text, ctx, { deps: { ...input.deps, verifier }, jobTerms })
    finish = () => run.finish('succeeded', { package_id: got.pkg?.id ?? null }, null)
  }

  const applied = await applyReviewDecisions(before, decisions, { verifyEdit })
  let updated = 0
  for (let i = 0; i < applied.changes.length; i++) {
    const p = reviewPatch(before[i], applied.changes[i])
    if (!p || !before[i].id) continue
    const w = await updatePatchChange(before[i].id as string, p)
    if (w.error) errors.push(`change ${before[i].id}: ${w.error}`)
    else updated++
  }
  if (updated) await updateResumePatch(patch.patch.patch.id, { status: 'reviewed' })
  if (finish) await finish()

  const changes = applied.changes.map((c, i) => ({ ...c, id: before[i].id }))
  return { changes, refused: applied.refused, updated, errors, error: null, migrationMissing: false }
}

// ─── Cover letter ────────────────────────────────────────────────────────────

export interface LetterReviewInput {
  userId: string
  packageId: string
  action: 'approve' | 'reject' | 'edit' | 'regenerate'
  text?: string
  ctx?: ToolContext
}

export interface LetterReviewResult {
  letter: CoverLetter | null
  grounding: LetterGrounding | null
  /** Set when an edit or an approval was refused by the gate. */
  refused: string | null
  documents: { docxPath: string | null; pdfPath: string | null } | null
  errors: string[]
  error: string | null
  migrationMissing: boolean
}

function blockingCount(g: unknown): number {
  const b = (g as { blocking?: unknown[] } | null)?.blocking
  return Array.isArray(b) ? b.length : 0
}

export async function reviewCoverLetter(input: LetterReviewInput): Promise<LetterReviewResult> {
  const errors: string[] = []
  const none: LetterReviewResult = { letter: null, grounding: null, refused: null, documents: null, errors, error: null, migrationMissing: false }
  const got = await getPackage(input.userId, input.packageId)
  if (got.migrationMissing) return { ...none, error: MIGRATION, migrationMissing: true }
  if (!got.pkg) return { ...none, error: 'package not found' }
  const pkg = got.pkg
  if (!REVIEWABLE.has(pkg.status)) return { ...none, error: `package is ${pkg.status}` }

  const loaded = await loadJobContext(input.userId, pkg.job_id)
  if (!loaded.ctx) return { ...none, error: loaded.error, migrationMissing: loaded.migrationMissing }
  const context = loaded.ctx
  const signer = await letterSigner(input.userId, context)
  const output = { kind: 'store' as const, userId: input.userId, relativePrefix: `packages/${pkg.id}/v${pkg.version}/letter-${Date.now()}` }

  // ─── regenerate: a new version through the whole pipeline ───
  if (input.action === 'regenerate') {
    const run = await startCareerRun({
      userId: input.userId, kind: 'package', label: `cover letter regenerate: ${context.job.company_name}`,
      mission: { package_id: pkg.id }, budget: DEFAULT_PACKAGE_BUDGET, careerMissionId: context.mission.id,
    })
    const gen = await generateCoverLetter({
      bank: context.bank, job: context.job,
      research: letterResearchFor(context, pkg),
      evidenceMap: context.existing.evidenceMap ?? { why_i_fit: null, fact_ids: [], story_ids: [], top_experience_ids: [] },
      user: signer, ctx: input.ctx ?? packageToolContext(input.userId, run.runId), run, output,
      persist: { userId: input.userId, jobId: pkg.job_id, packageId: pkg.id },
    })
    errors.push(...gen.errors)
    await run.finish('succeeded', { package_id: pkg.id }, gen.letter.error)
    if (!gen.row) return { ...none, error: gen.letter.error ?? 'no letter produced' }
    await updatePackage(pkg.id, {
      cover_letter_id: gen.row.id, cover_docx_path: gen.documents?.docxPath ?? null, cover_pdf_path: gen.documents?.pdfPath ?? null,
      cover_filename: gen.documents?.filenames.docx ?? null, cost_usd: Number(pkg.cost_usd ?? 0) + gen.costUsd,
    })
    return { ...none, letter: gen.row, grounding: gen.letter.grounding, documents: gen.documents ? { docxPath: gen.documents.docxPath, pdfPath: gen.documents.pdfPath } : null }
  }

  if (!pkg.cover_letter_id) return { ...none, error: 'package has no cover letter yet' }
  const cur = await getCoverLetter(input.userId, pkg.cover_letter_id)
  if (!cur.letter) return { ...none, error: cur.error ?? 'cover letter not found' }
  const letter = cur.letter

  if (input.action === 'reject') {
    const w = await updateCoverLetter(letter.id, { review_status: 'rejected' })
    return { ...none, letter: { ...letter, review_status: 'rejected' }, error: w.error }
  }

  if (input.action === 'approve') {
    if (blockingCount(letter.grounding) > 0) return { ...none, letter, refused: 'the letter has blocking grounding findings — edit it first' }
    const w = await updateCoverLetter(letter.id, { review_status: 'approved' })
    return { ...none, letter: { ...letter, review_status: 'approved' }, error: w.error }
  }

  // ─── edit: re-gate the human's text against the same pools ───
  const text = (input.text ?? '').trim()
  if (!text) return { ...none, letter, refused: 'edit requires text' }
  const parts = splitLetterText(text, signer.name)
  const facts = context.existing.research.facts
  const grounding = gateCoverLetter(parts.paragraphs.join('\n\n'), {
    companyPool: [context.job.company_name, context.existing.research.summary ?? '', ...facts.map((f) => f.claim)],
    personalPool: buildBankPool(context.bank),
    safeNames: [signer.name, context.job.company_name, context.job.title, context.job.location_raw ?? ''],
  })
  const status: CoverLetter['review_status'] = grounding.ok ? 'edited' : 'pending'
  const patch: Partial<CoverLetter> = { edited_text: text, grounding: grounding as unknown as Record<string, unknown>, word_count: countWords(parts.paragraphs.join(' ')), review_status: status }
  const w = await updateCoverLetter(letter.id, patch)
  if (w.error) return { ...none, letter, grounding, error: w.error }
  const updated: CoverLetter = { ...letter, ...patch } as CoverLetter
  if (!grounding.ok) return { ...none, letter: updated, grounding, refused: `${grounding.blocking.length} blocking finding(s) — the letter stays pending` }

  const docs = await regenerateLetterDocuments({ letter: updated, user: signer, company: context.job.company_name, output })
  errors.push(...docs.warnings)
  await updatePackage(pkg.id, { cover_docx_path: docs.docxPath, cover_pdf_path: docs.pdfPath, cover_filename: docs.filenames.docx })
  return { ...none, letter: updated, grounding, documents: { docxPath: docs.docxPath, pdfPath: docs.pdfPath } }
}
