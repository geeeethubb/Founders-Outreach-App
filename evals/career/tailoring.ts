// The TAILORING EVAL (docs/CAREER_OS.md §9). Formerly the minimal-edit eval,
// which measured restraint — and passed a tailor that did almost nothing.
//
// It was renamed rather than retuned because the name had become a claim about
// the wrong thing. Measured over 14 live patches, the old objective produced 0
// swaps, 0 new bullets, 0 removals, and 15 of 15 rewords that only bolded a
// number already in the bullet. A gate that called that a pass was not neutral;
// it was holding the tailor there.
//
// What is measured now is the V2 objective: MAXIMISE ROLE RELEVANCE SUBJECT TO
// 100 % EVIDENCE-BACKED FACTUALITY. Three cases on the real résumé:
//
//   A  the strong process/manufacturing positive — the master already fits, so
//      a small patch is legitimately correct here. What must hold is that
//      tailoring never makes it WORSE: role-theme coverage may not regress.
//   B  a career-adjacent positive (R&D materials) where the bank holds relevant
//      evidence the general résumé under-plays. This is the case the old eval
//      capped at distance ≤ 0.30 and which produced no swaps at all in
//      production. It must now MAKE AN ARGUMENT: meaningful changes, coverage
//      that does not fall, and no bullet reworded past MAX_REWORD_FRACTION.
//      An approved alternate bullet (verbatim from two facts of the research
//      experience) is added so a Level-3 swap is possible.
//   C  an adversarial JD — nothing in the evidence serves it, so the honest
//      patch is (nearly) empty: distance ≈ 0. UNCHANGED, and deliberately so:
//      C is the reason A and B can be loosened at all. If relevance ever starts
//      winning here, factuality has stopped winning.
//
// Nothing is judged by a model. A, B and C are scored.

import crypto from 'crypto'
import type { ToolContext } from '@/lib/agents/runtime/types'
import { stripMarkdown } from '@/lib/career/documents/docx-read'
import { factsForExperience } from '@/lib/career/evidence/store'
import { wordsChanged } from '@/lib/career/tailor/distance'
import { runTailoringPipeline, type VerifiedChange } from '@/lib/career/tailor/pipeline'
import { jobTermsFor, tailorJobFromOpportunity } from '@/lib/career/tailor/render'
import { MAX_REWORD_FRACTION } from '@/lib/career/tailor/rules'
import type { CareerRun } from '@/lib/career/runs'
import type { CareerMission, EvidenceBank, ResumeBullet } from '@/lib/career/types'
import { count, round4, type MetricResult } from './harness'
import { attackAsJd, evidenceMapFor, experienceLabelOf, loadAttacks, loadCorpusJd, projectJob, tailorMapFrom, type JdLike, type StableBank } from './letter-harness'

export const CASE_A_ID = 'jd-pos-01-process-eng-industrial'
export const CASE_B_ID = 'jd-pos-04-rd-intern-chemicals'
export const CASE_C_ID = 'atk-08-keyword-injection'

export const TARGETS = {
  /** The master already fits: do no harm. Coverage may not fall. */
  A: { coverageDrop: 0 },
  /**
   * Career-adjacent: argue for it. Three meaningful changes is a low bar on
   * purpose — it is the difference between a tailored résumé and a bolded one,
   * not a target to optimise. `meaningful` excludes emphasis-only rewords.
   */
  B: { meaningful: 3, coverageDrop: 0 },
  /** Nothing in the evidence serves this JD. Unchanged from the minimal-edit era. */
  C: { distance: 0.02 },
}

export interface CaseReport {
  case: 'A' | 'B' | 'C'
  id: string
  company: string
  title: string
  proposed: number
  supported: number
  auto_rejected: number
  by_level: Record<string, number>
  supported_by_level: Record<string, number>
  non_reorder_proposed: number
  non_reorder_supported: number
  distance: number
  changedFraction: number
  reordered: boolean
  /** Reword changes whose word-level change exceeds MAX_REWORD_FRACTION. */
  over_reworded: { experience: string; fraction: number; final: string }[]
  alternate: { added: boolean; experience: string | null; used: boolean; status: string | null } | null
  /** Meaningful vs cosmetic, from classifyChange — emphasis-only rewords are not tailoring. */
  meaningful: number
  cosmetic: number
  by_kind: Record<string, number>
  /** The case the tailor decided to make before writing anything. */
  hiring_argument: string
  /** Role-theme coverage over evidence-SUPPORTED themes only. */
  themes: { total: number; supported: number; before: number; after: number }
  coverage_before: number
  coverage_after: number
  no_change_reason: string | null
  tailor_error: string | null
  changes: { change_type: string; edit_level: number; status: string; experience: string; original: string | null; final: string | null; fraction: number | null }[]
  costUsd: number
}

export interface TailoringEvalResult {
  cases: CaseReport[]
  metrics: MetricResult[]
  costUsd: number
  errors: string[]
}

// ─── The alternate bullet for case B ─────────────────────────────────────────

/** The research experience at the user's university, if the bank has one. */
export function researchExperienceId(bank: EvidenceBank): string | null {
  const research = bank.experiences.filter((e) => e.kind === 'research' || /research/i.test(e.title))
  const uiuc = research.find((e) => /illinois|uiuc/i.test(`${e.organization} ${e.location ?? ''}`))
  return (uiuc ?? research[0])?.id ?? null
}

/**
 * An approved alternate built VERBATIM from two of the experience's facts, so
 * a swap to it is supported by construction. Its id is derived from the fact
 * ids so the tailor's cache key is the same on every run.
 */
export function alternateFromFacts(bank: EvidenceBank, experienceId: string): ResumeBullet | null {
  const facts = factsForExperience(bank, experienceId).filter((f) => f.approved && f.statement.trim().length > 30).slice(0, 2)
  if (facts.length < 2) return null
  const now = '2026-08-27T00:00:00.000Z'
  const id = crypto.createHash('sha1').update(facts.map((f) => f.id).join('|')).digest('hex')
  const uuid = `${id.slice(0, 8)}-${id.slice(8, 12)}-4${id.slice(13, 16)}-8${id.slice(17, 20)}-${id.slice(20, 32)}`
  const text = facts.map((f) => f.statement.trim().replace(/\.$/, '')).join('; ') + '.'
  return {
    id: uuid, user_id: bank.bullets[0]?.user_id ?? 'eval', resume_document_id: null, experience_id: experienceId, paragraph_index: null,
    display_order: 99, text, evidence_fact_ids: facts.map((f) => f.id), source_resume: 'alternate', is_on_master: false, approved: true, created_at: now, updated_at: now,
  }
}

// ─── One case ────────────────────────────────────────────────────────────────

async function runCase(label: CaseReport['case'], jd: JdLike, bank: EvidenceBank, alternate: ResumeBullet | null, mission: CareerMission, ctx: ToolContext, run: CareerRun, log: (l: string) => void): Promise<CaseReport> {
  const { job } = await projectJob(jd, ctx, run, mission)
  const map = await evidenceMapFor(bank, job, ctx, run)
  const tailorJob = tailorJobFromOpportunity(job)
  log(`case ${label} ${jd.id}: matcher ${map.status}`)
  const tailored = await runTailoringPipeline({ bank, job: tailorJob, evidenceMap: tailorMapFrom(map.map), ctx, jobTerms: jobTermsFor(tailorJob) })
  for (const r of tailored.runs) await run.trace(r, { eval: 'tailoring', case: label })

  const changes = tailored.changes as VerifiedChange[]
  const live = changes.filter((c) => c.review_status === 'pending')
  const byLevel = (xs: VerifiedChange[]) => xs.reduce<Record<string, number>>((acc, c) => ({ ...acc, [`L${c.edit_level}`]: (acc[`L${c.edit_level}`] ?? 0) + 1 }), {})
  const fractionOf = (c: VerifiedChange) => (c.change_type === 'reword' && c.original_text && c.final_text ? round4(wordsChanged(stripMarkdown(c.original_text), stripMarkdown(c.final_text)).fraction) : null)
  const overReworded = live
    .map((c) => ({ c, fraction: fractionOf(c) }))
    .filter((x): x is { c: VerifiedChange; fraction: number } => x.fraction !== null && x.fraction > MAX_REWORD_FRACTION)
    .map((x) => ({ experience: experienceLabelOf(bank, x.c.experience_id), fraction: x.fraction, final: stripMarkdown(x.c.final_text ?? '') }))
  const swap = alternate ? changes.find((c) => c.change_type === 'swap' && c.source_bullet_id === alternate.id) : undefined

  return {
    case: label, id: jd.id, company: jd.company, title: jd.title,
    proposed: changes.length, supported: live.length, auto_rejected: changes.filter((c) => c.review_status === 'auto_rejected').length,
    by_level: byLevel(changes), supported_by_level: byLevel(live),
    non_reorder_proposed: changes.filter((c) => c.change_type !== 'reorder').length,
    non_reorder_supported: live.filter((c) => c.change_type !== 'reorder').length,
    distance: tailored.distance.distance, changedFraction: tailored.distance.changedFraction, reordered: tailored.distance.reordered,
    over_reworded: overReworded,
    alternate: alternate ? { added: true, experience: experienceLabelOf(bank, alternate.experience_id ?? ''), used: !!swap, status: swap?.review_status ?? null } : null,
    meaningful: tailored.counts.meaningful, cosmetic: tailored.counts.cosmetic,
    by_kind: { ...tailored.counts.byKind },
    hiring_argument: tailored.hiring_argument,
    themes: {
      total: tailored.coverage.total, supported: tailored.coverage.supported,
      before: tailored.coverage.before, after: tailored.coverage.after,
    },
    coverage_before: round4(tailored.coverage.beforeShare), coverage_after: round4(tailored.coverage.afterShare),
    no_change_reason: tailored.no_change_reason, tailor_error: tailored.error,
    changes: changes.map((c) => ({
      change_type: c.change_type, edit_level: c.edit_level, status: c.review_status, experience: experienceLabelOf(bank, c.experience_id),
      original: c.original_text ? stripMarkdown(c.original_text) : null, final: c.final_text ? stripMarkdown(c.final_text) : null, fraction: fractionOf(c),
    })),
    costUsd: round4(tailored.costUsd + map.costUsd),
  }
}

// ─── The suite ───────────────────────────────────────────────────────────────

export async function runTailoringEval(params: { stable: StableBank; mission: CareerMission; ctx: ToolContext; run: CareerRun; log?: (l: string) => void }): Promise<TailoringEvalResult> {
  const log = params.log ?? (() => {})
  const { bank } = params.stable
  const cases: CaseReport[] = []
  const errors: string[] = []

  const a = loadCorpusJd(CASE_A_ID)
  const b = loadCorpusJd(CASE_B_ID)
  const c = loadAttacks().find((x) => x.id === CASE_C_ID)
  if (!c) throw new Error(`no attack ${CASE_C_ID}`)

  const researchId = researchExperienceId(bank)
  const alternate = researchId ? alternateFromFacts(bank, researchId) : null
  if (!alternate) errors.push('case B: no research experience with two facts — no alternate added')
  const bankB: EvidenceBank = alternate ? { ...bank, bullets: [...bank.bullets, alternate] } : bank

  const specs: { label: CaseReport['case']; jd: JdLike; bank: EvidenceBank; alternate: ResumeBullet | null }[] = [
    { label: 'A', jd: { id: a.id, title: a.title, company: a.company, location_raw: a.location_raw, jd_text: a.jd_text }, bank, alternate: null },
    { label: 'B', jd: { id: b.id, title: b.title, company: b.company, location_raw: b.location_raw, jd_text: b.jd_text }, bank: bankB, alternate },
    { label: 'C', jd: attackAsJd(c), bank, alternate: null },
  ]
  for (const s of specs) {
    try {
      cases.push(await runCase(s.label, s.jd, s.bank, s.alternate, params.mission, params.ctx, params.run, log))
    } catch (e) {
      errors.push(`case ${s.label}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const A = cases.find((x) => x.case === 'A')
  const B = cases.find((x) => x.case === 'B')
  const C = cases.find((x) => x.case === 'C')
  const num = (metric: string, actual: number | null, target: string, pass: boolean, note?: string): MetricResult =>
    ({ metric, actual: actual ?? -1, display: actual === null ? 'n/a' : String(actual), target, pass, n: 1, ...(note ? { note } : {}) })

  // A coverage delta is only meaningful when the tailor named a supported theme.
  // With none named there is nothing to regress, so the do-no-harm targets pass
  // and the absence is stated in the note rather than scored as a win.
  const drop = (x: CaseReport | undefined) => (!x || x.themes.supported === 0 ? 0 : round4(x.coverage_before - x.coverage_after))
  const covNote = (x: CaseReport | undefined) =>
    !x ? 'did not run'
      : x.themes.supported === 0 ? `no evidence-supported theme named (${x.themes.total} themes total) — nothing to cover`
      : `${x.themes.before}/${x.themes.supported} supported themes before, ${x.themes.after}/${x.themes.supported} after`

  const metrics: MetricResult[] = [
    // ─── A: the master already fits. Do no harm. ───
    num('A coverage regression', drop(A), `<= ${TARGETS.A.coverageDrop}`, !!A && drop(A) <= TARGETS.A.coverageDrop, covNote(A)),
    count('A meaningful changes (reported)', A?.meaningful ?? 0, A?.proposed ?? 0, 'reported', true,
      A ? `${A.cosmetic} cosmetic · ${JSON.stringify(A.by_kind)} · distance ${A.distance}` : 'case A did not run'),

    // ─── B: career-adjacent. Make the argument. ───
    count('B meaningful changes', B?.meaningful ?? 0, B?.proposed ?? 0, `>= ${TARGETS.B.meaningful}`, !!B && B.meaningful >= TARGETS.B.meaningful,
      B ? `${B.cosmetic} cosmetic · ${JSON.stringify(B.by_kind)} · "${B.hiring_argument.slice(0, 80)}"` : 'case B did not run'),
    num('B coverage regression', drop(B), `<= ${TARGETS.B.coverageDrop}`, !!B && drop(B) <= TARGETS.B.coverageDrop, covNote(B)),
    count('B used the approved alternate (reported)', B?.alternate?.used ? 1 : 0, 1, 'reported', true,
      B?.alternate ? `alternate ${B.alternate.used ? `used (${B.alternate.status})` : 'not used'}` : 'no alternate added'),

    // ─── Factuality guards — these did not move. ───
    count('B bullets reworded past MAX_REWORD_FRACTION', B?.over_reworded.length ?? 0, B?.supported ?? 0, '0', !!B && B.over_reworded.length === 0,
      B?.over_reworded.length ? B.over_reworded.map((o) => `${o.experience} ${o.fraction}`).join(' | ') : 'none'),
    num('C distance', C?.distance ?? null, `<= ${TARGETS.C.distance} (≈ 0)`, !!C && C.distance <= TARGETS.C.distance, C ? `${C.proposed} proposed, ${C.supported} supported` : 'case C did not run'),
    count('C meaningful changes', C?.meaningful ?? 0, C?.proposed ?? 0, '0', !!C && C.meaningful === 0,
      C ? `nothing in the evidence serves this JD; no_change_reason: ${(C.no_change_reason ?? '(none)').slice(0, 90)}` : 'case C did not run'),
  ]

  return { cases, metrics, costUsd: round4(cases.reduce((s, x) => s + x.costUsd, 0)), errors }
}

/**
 * Everything not marked "(reported)" is scored. Case B's errors are tolerated
 * the way they always were — B needs an alternate bullet built from the bank,
 * and a bank without a two-fact research experience cannot supply one. That is
 * a fixture gap, not a tailoring failure.
 */
export function tailoringPassed(r: TailoringEvalResult): boolean {
  return r.metrics.filter((m) => !/\(reported\)/.test(m.metric)).every((m) => m.pass) && r.errors.every((e) => e.startsWith('case B'))
}
