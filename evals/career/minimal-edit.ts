// The MINIMAL-EDIT EVAL (docs/CAREER_OS.md §9). The tailor is told to be
// restrained; this MEASURES it. Three cases on the real résumé:
//
//   A  the strong process/manufacturing positive — the master already fits,
//      so the patch should be small: distance ≤ 0.08, ≤ 3 non-reorder changes.
//   B  a positive far from the master's ordering (R&D materials) — small,
//      targeted changes: distance ≤ 0.30, changedFraction ≤ 0.35, and no
//      bullet reworded past MAX_REWORD_FRACTION unless swapped. One approved
//      alternate bullet (built verbatim from two facts of the research
//      experience) is added to the bank so a Level-3 swap is possible; whether
//      the tailor used it is reported.
//   C  an adversarial JD — nothing in the evidence serves it, so the honest
//      patch is (nearly) empty: distance ≈ 0.
//
// Nothing is judged. A and C are scored; B reports.

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
  A: { distance: 0.08, nonReorder: 3 },
  B: { distance: 0.3, changedFraction: 0.35 },
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
  no_change_reason: string | null
  tailor_error: string | null
  changes: { change_type: string; edit_level: number; status: string; experience: string; original: string | null; final: string | null; fraction: number | null }[]
  costUsd: number
}

export interface MinimalEditResult {
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
  for (const r of tailored.runs) await run.trace(r, { eval: 'minimal-edit', case: label })

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
    no_change_reason: tailored.no_change_reason, tailor_error: tailored.error,
    changes: changes.map((c) => ({
      change_type: c.change_type, edit_level: c.edit_level, status: c.review_status, experience: experienceLabelOf(bank, c.experience_id),
      original: c.original_text ? stripMarkdown(c.original_text) : null, final: c.final_text ? stripMarkdown(c.final_text) : null, fraction: fractionOf(c),
    })),
    costUsd: round4(tailored.costUsd + map.costUsd),
  }
}

// ─── The suite ───────────────────────────────────────────────────────────────

export async function runMinimalEditEval(params: { stable: StableBank; mission: CareerMission; ctx: ToolContext; run: CareerRun; log?: (l: string) => void }): Promise<MinimalEditResult> {
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

  const metrics: MetricResult[] = [
    num('A distance', A?.distance ?? null, `<= ${TARGETS.A.distance}`, !!A && A.distance <= TARGETS.A.distance, A ? `changed ${A.changedFraction}, reordered ${A.reordered}` : 'case A did not run'),
    count('A non-reorder changes proposed', A?.non_reorder_proposed ?? 0, A?.proposed ?? 0, `<= ${TARGETS.A.nonReorder}`, !!A && A.non_reorder_proposed <= TARGETS.A.nonReorder, A ? `${A.non_reorder_supported} of them SUPPORTED` : ''),
    num('B distance (reported)', B?.distance ?? null, `<= ${TARGETS.B.distance}`, !!B && B.distance <= TARGETS.B.distance, B ? `changedFraction ${B.changedFraction} (<= ${TARGETS.B.changedFraction}: ${B.changedFraction <= TARGETS.B.changedFraction})` : 'case B did not run'),
    count('B bullets reworded past MAX_REWORD_FRACTION (reported)', B?.over_reworded.length ?? 0, B?.supported ?? 0, '0', !!B && B.over_reworded.length === 0, B?.alternate ? `alternate ${B.alternate.used ? `used (${B.alternate.status})` : 'not used'}` : 'no alternate'),
    num('C distance', C?.distance ?? null, `<= ${TARGETS.C.distance} (≈ 0)`, !!C && C.distance <= TARGETS.C.distance, C ? `${C.proposed} proposed, ${C.supported} supported` : 'case C did not run'),
  ]

  return { cases, metrics, costUsd: round4(cases.reduce((s, x) => s + x.costUsd, 0)), errors }
}

/** A and C are scored; B is reported. */
export function minimalEditPassed(r: MinimalEditResult): boolean {
  return r.metrics.filter((m) => !/\(reported\)/.test(m.metric)).every((m) => m.pass) && r.errors.every((e) => e.startsWith('case B'))
}
