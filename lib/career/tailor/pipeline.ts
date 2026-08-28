// The tailoring pipeline. Pure: takes a loaded bank, returns verified changes.
// The orchestrator persists (resume_patches / resume_patch_changes) and the
// document engine consumes finalBulletsFor().
//
// Per proposed change, in order, each gate able to end the story:
//
//   shape      ids exist, fact ids belong to the experience  (tailor validate)
//   precheck   numbers, tools, entities, superlatives, stuffed keywords
//              — a blocking finding rejects WITHOUT asking the verifier
//   verifier   an independent agent, one change per call, clause by clause
//
// The safe outcome is always the original bullet. UNCERTAIN keeps it,
// UNSUPPORTED keeps it, a verifier error keeps it. Only SUPPORTED reaches the
// human as 'pending', and Level 4 additionally needs every clause to cite a
// fact. Nothing is discarded silently: a rejected change stays in the list
// with its reason, so the review screen can say what the tailor tried.

import { runResumeTailor, type ResumeTailorInput, type ResumeTailorOutput, type RejectedChange } from '@/lib/agents/resume-tailor'
import {
  meetsLevel4Bar,
  runResumeFactVerifier,
  type ResumeFactVerifierInput,
  type ResumeFactVerifierOutput,
} from '@/lib/agents/resume-fact-verifier'
import type { TailorJob } from '@/lib/agents/resume-tailor/prompt'
import type { AgentResult, ToolContext } from '@/lib/agents/runtime/types'
import { buildExperiencePool } from '../evidence/render'
import { bulletsForExperience } from '../evidence/store'
import { patchDistance, type PatchDistance } from './distance'
import { isEmphasisOnly, precheckChange, summarizeFindings, type Finding } from './precheck'
import { buildTailorInput, buildVerifierInput, jobTermsFor, type EvidenceMapForTailor } from './render'
import type { EvidenceBank, ProposedChange, ReviewStatus, VerificationResult, VerifiedClause } from '../types'

export interface PrecheckFindings {
  blocking: Finding[]
  warnings: Finding[]
}

/** A proposed change after the gates. Mirrors resume_patch_changes minus the row ids. */
export interface VerifiedChange extends ProposedChange {
  verification_result: VerificationResult
  verification_notes: string | null
  verification_clauses: VerifiedClause[] | null
  precheck_findings: PrecheckFindings | null
  review_status: ReviewStatus
  final_text: string | null
}

export interface TailorDeps {
  tailor: (input: ResumeTailorInput, ctx: ToolContext) => Promise<AgentResult<ResumeTailorOutput>>
  verifier: (input: ResumeFactVerifierInput, ctx: ToolContext) => Promise<AgentResult<ResumeFactVerifierOutput>>
}

const DEFAULT_DEPS: TailorDeps = {
  tailor: (input, ctx) => runResumeTailor(input, ctx),
  verifier: (input, ctx) => runResumeFactVerifier(input, ctx),
}

export interface TailoringResult {
  changes: VerifiedChange[]
  rejected: RejectedChange[]
  no_change_reason: string | null
  summary: string
  distance: PatchDistance
  runs: AgentResult<unknown>[]
  costUsd: number
  tailor_version: string | null
  verifier_version: string | null
  /** Set when the tailor itself failed; changes is then empty and the master stands. */
  error: string | null
}

export interface TailoringParams {
  bank: EvidenceBank
  job: TailorJob
  evidenceMap: EvidenceMapForTailor
  ctx: ToolContext
  /** Defaults to the job's own requirement vocabulary. */
  jobTerms?: string[]
  deps?: Partial<TailorDeps>
  onStep?: (info: { stage: 'tailor' | 'verify'; detail: string }) => void
}

function rejectedChange(c: ProposedChange, result: VerificationResult, notes: string, findings: PrecheckFindings | null): VerifiedChange {
  return {
    ...c,
    verification_result: result,
    verification_notes: notes,
    verification_clauses: null,
    precheck_findings: findings,
    review_status: 'auto_rejected',
    final_text: c.original_text,
  }
}

/**
 * Run one change through precheck and, when it changes text, the verifier.
 * The unit the API re-uses for an edited bullet.
 */
export async function verifyChange(
  bank: EvidenceBank,
  change: ProposedChange,
  ctx: ToolContext,
  opts: { deps?: Partial<TailorDeps>; jobTerms?: string[]; runs?: AgentResult<unknown>[] } = {}
): Promise<VerifiedChange> {
  const deps = { ...DEFAULT_DEPS, ...opts.deps }
  const pool = buildExperiencePool(bank, change.experience_id)

  // No factual content changes: reorder, remove, or a swap to text that is
  // already approved verbatim. SUPPORTED by construction.
  const textChanges = change.change_type === 'reword' || change.change_type === 'new'
  const swapUnchanged =
    change.change_type === 'swap' &&
    !!change.proposed_text &&
    pool.lines.some((l) => l.trim() === (change.proposed_text ?? '').replace(/\*\*/g, '').trim())
  if (!textChanges && (change.change_type !== 'swap' || swapUnchanged)) {
    return {
      ...change,
      verification_result: 'SUPPORTED',
      verification_notes: change.change_type === 'swap' ? 'Approved alternate, text unchanged.' : 'No factual change.',
      verification_clauses: null,
      precheck_findings: null,
      review_status: 'pending',
      final_text: change.change_type === 'remove' ? null : change.change_type === 'swap' ? change.proposed_text : change.original_text,
    }
  }

  const pre = precheckChange(change, pool, change.original_text, opts.jobTerms ?? [])
  const findings: PrecheckFindings = { blocking: pre.blocking, warnings: pre.warnings }
  if (!pre.ok) {
    return rejectedChange(change, 'UNSUPPORTED', `Blocked before verification — ${summarizeFindings(pre.blocking)}. Verifier skipped.`, findings)
  }

  // Emphasis only: the words are the original's, and the pre-check has just
  // confirmed the bold sits on a metric. There is nothing for a verifier to
  // audit, and the first live run spent three verifier calls confirming that.
  if (isEmphasisOnly(change.original_text, change.proposed_text)) {
    return {
      ...change,
      verification_result: 'SUPPORTED',
      verification_notes: 'Emphasis only; wording unchanged.',
      verification_clauses: null,
      precheck_findings: findings,
      review_status: 'pending',
      final_text: change.proposed_text,
    }
  }

  const input = buildVerifierInput(bank, change.experience_id, change.original_text, change.proposed_text ?? '', change.edit_level)
  if (!input) return rejectedChange(change, 'UNSUPPORTED', 'Experience not found in the bank.', findings)

  const run = await deps.verifier(input, ctx)
  opts.runs?.push(run as AgentResult<unknown>)
  if (run.status !== 'succeeded' || !run.output) {
    return rejectedChange(change, 'NOT_CHECKED', `Verifier did not return a verdict (${run.error ?? run.status}); original kept.`, findings)
  }

  const out = run.output
  const failing = out.clauses.filter((c) => c.verdict !== 'SUPPORTED')
  const warningNote = pre.warnings.length ? ` Pre-check warnings: ${summarizeFindings(pre.warnings)}.` : ''

  if (out.overall !== 'SUPPORTED') {
    return {
      ...rejectedChange(
        change,
        out.overall,
        `${out.overall}: ${failing.map((c) => `"${c.clause}" (${c.verdict}${c.note ? ` — ${c.note}` : ''})`).join('; ')}.${warningNote}`,
        findings
      ),
      verification_clauses: out.clauses,
    }
  }
  if (change.edit_level === 4 && !meetsLevel4Bar(out)) {
    const uncited = out.clauses.filter((c) => c.fact_ids.length === 0)
    return {
      ...rejectedChange(
        change,
        'UNCERTAIN',
        `Level 4 requires every clause to cite a fact; uncited: ${uncited.map((c) => `"${c.clause}"`).join('; ')}.${warningNote}`,
        findings
      ),
      verification_clauses: out.clauses,
    }
  }

  return {
    ...change,
    verification_result: 'SUPPORTED',
    verification_notes: `${out.notes || 'Every clause supported.'}${warningNote}`.trim(),
    verification_clauses: out.clauses,
    precheck_findings: findings,
    review_status: 'pending',
    final_text: change.proposed_text,
  }
}

export async function runTailoringPipeline(params: TailoringParams): Promise<TailoringResult> {
  const deps = { ...DEFAULT_DEPS, ...params.deps }
  const input = buildTailorInput(params.bank, params.job, params.evidenceMap)
  const jobTerms = params.jobTerms ?? jobTermsFor(params.job)
  const runs: AgentResult<unknown>[] = []

  params.onStep?.({ stage: 'tailor', detail: `${input.experiences.length} experiences` })
  const tailorRun = await deps.tailor(input, params.ctx)
  runs.push(tailorRun as AgentResult<unknown>)

  const empty = (error: string | null): TailoringResult => ({
    changes: [],
    rejected: [],
    no_change_reason: error ? null : 'The tailor proposed no changes.',
    summary: '',
    distance: { distance: 0, changedFraction: 0, reordered: false },
    runs,
    costUsd: cost(runs),
    tailor_version: tailorRun.trace.prompt_version,
    verifier_version: null,
    error,
  })

  if (tailorRun.status !== 'succeeded' || !tailorRun.output) {
    return empty(`tailor ${tailorRun.status}: ${tailorRun.error ?? 'no output'}`)
  }
  const out = tailorRun.output

  const changes: VerifiedChange[] = []
  let verifierVersion: string | null = null
  for (const c of out.changes) {
    params.onStep?.({ stage: 'verify', detail: `${c.change_type} L${c.edit_level} ${c.bullet_id ?? 'new'}` })
    const before = runs.length
    const v = await verifyChange(params.bank, c, params.ctx, { deps, jobTerms, runs })
    if (runs.length > before) verifierVersion = runs[runs.length - 1].trace.prompt_version
    changes.push(v)
  }

  const final = finalBulletsFor(params.bank, changes)
  const master = params.bank.experiences.flatMap((e) => bulletsForExperience(params.bank, e.id).filter((b) => b.is_on_master && b.approved).map((b) => b.text))
  const distance = patchDistance(master, final.flatMap((f) => f.bullets))

  return {
    changes,
    rejected: out.rejected,
    no_change_reason: out.no_change_reason,
    summary: out.summary,
    distance,
    runs,
    costUsd: cost(runs),
    tailor_version: tailorRun.trace.prompt_version,
    verifier_version: verifierVersion,
    error: null,
  }
}

function cost(runs: AgentResult<unknown>[]): number {
  return Number(runs.reduce((s, r) => s + (r.trace?.cost_usd ?? 0), 0).toFixed(4))
}

// ─── Review ──────────────────────────────────────────────────────────────────

export interface ReviewDecision {
  /** Index into the changes array, or the persisted row id when the change carries one. */
  index?: number
  id?: string
  action: 'approve' | 'reject' | 'edit'
  /** For edit: the human's text, `**` allowed. */
  text?: string
}

/**
 * Verify a human's edit as if the tailor had proposed it. The gate runs on the
 * text that will actually be in the document — editing is exactly how an
 * unsupported claim gets back into a bullet that already passed.
 */
export async function verifyEditedText(
  bank: EvidenceBank,
  change: ProposedChange,
  text: string,
  ctx: ToolContext,
  opts: { deps?: Partial<TailorDeps>; jobTerms?: string[] } = {}
): Promise<VerifiedChange> {
  const level = change.change_type === 'new' ? 4 : 2
  const edited: ProposedChange = {
    ...change,
    change_type: change.change_type === 'new' ? 'new' : 'reword',
    edit_level: level,
    proposed_text: text,
  }
  return verifyChange(bank, edited, ctx, opts)
}

/**
 * Apply approve / reject / edit. Pure over the array; the caller persists.
 *
 * Approve is refused for anything not SUPPORTED — the human's route past an
 * UNSUPPORTED verdict is to edit, which re-verifies. An edit needs
 * `verifyEdit` (normally verifyEditedText bound to the bank); without it the
 * edit is refused rather than accepted unverified.
 */
export async function applyReviewDecisions(
  changes: (VerifiedChange & { id?: string })[],
  decisions: ReviewDecision[],
  opts: { verifyEdit?: (change: VerifiedChange, text: string) => Promise<VerifiedChange> } = {}
): Promise<{ changes: VerifiedChange[]; refused: { decision: ReviewDecision; reason: string }[] }> {
  const next = changes.map((c) => ({ ...c }))
  const refused: { decision: ReviewDecision; reason: string }[] = []

  for (const d of decisions) {
    const i = d.id !== undefined ? next.findIndex((c) => c.id === d.id) : d.index ?? -1
    const c = next[i]
    if (!c) {
      refused.push({ decision: d, reason: 'no such change' })
      continue
    }
    if (d.action === 'reject') {
      c.review_status = 'rejected'
      c.final_text = c.original_text
      continue
    }
    if (d.action === 'approve') {
      if (c.verification_result !== 'SUPPORTED') {
        refused.push({ decision: d, reason: `cannot approve a ${c.verification_result} change — edit it instead` })
        continue
      }
      c.review_status = 'approved'
      continue
    }
    const text = (d.text ?? '').trim()
    if (!text) {
      refused.push({ decision: d, reason: 'edit requires text' })
      continue
    }
    if (!opts.verifyEdit) {
      refused.push({ decision: d, reason: 'edits must be verified before they can be applied' })
      continue
    }
    const verified = await opts.verifyEdit(c, text)
    next[i] = {
      ...verified,
      review_status: verified.verification_result === 'SUPPORTED' ? 'edited' : 'auto_rejected',
      final_text: verified.verification_result === 'SUPPORTED' ? text : c.original_text,
    }
  }

  return { changes: next, refused }
}

// ─── Final bullets ───────────────────────────────────────────────────────────

export interface ExperienceBullets {
  experience_id: string
  /** Markdown (`**` for bold), in final order. */
  bullets: string[]
}

const LIVE: ReadonlySet<ReviewStatus> = new Set<ReviewStatus>(['pending', 'approved', 'edited'])

/**
 * The bullets each experience will carry after the patch — the document
 * engine's input. Pending changes count by default (the preview); pass
 * `onlyApproved` for the document that ships. Rejected and auto-rejected
 * changes never do.
 */
export function finalBulletsFor(
  bank: EvidenceBank,
  changes: VerifiedChange[],
  opts: { onlyApproved?: boolean } = {}
): ExperienceBullets[] {
  const live = (c: VerifiedChange) =>
    opts.onlyApproved ? c.review_status === 'approved' || c.review_status === 'edited' : LIVE.has(c.review_status)

  return bank.experiences.map((e) => {
    const master = bulletsForExperience(bank, e.id).filter((b) => b.is_on_master && b.approved)
    const mine = changes.filter((c) => c.experience_id === e.id && live(c))
    const byBullet = new Map(mine.filter((c) => c.bullet_id).map((c) => [c.bullet_id as string, c]))

    const entries: { text: string; position: number; order: number }[] = []
    master.forEach((b, i) => {
      const c = byBullet.get(b.id)
      if (c?.change_type === 'remove') return
      const text = c && c.final_text !== null && c.final_text !== undefined ? c.final_text : b.text
      entries.push({ text, position: c ? c.position : i, order: i })
    })
    mine
      .filter((c) => c.change_type === 'new' && c.final_text)
      .forEach((c, k) => entries.push({ text: c.final_text as string, position: c.position, order: master.length + k }))

    entries.sort((a, b) => a.position - b.position || a.order - b.order)
    return { experience_id: e.id, bullets: entries.map((x) => x.text) }
  })
}
