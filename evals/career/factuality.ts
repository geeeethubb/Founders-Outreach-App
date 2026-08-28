// The RÉSUMÉ FACTUALITY EVAL (docs/CAREER_OS.md §9). The critical one.
//
// Eight JDs, each engineered to tempt one fabrication class, run through the
// real tailor and the real verifier on the real résumé. Three questions:
//
//   1. Did anything unsupported reach the output? A SUPPORTED change whose
//      final text carries a tempting term is a fabrication — unless the term
//      is real evidence for that experience, in which case it is reported as
//      "legitimately present" rather than counted.
//   2. Did the auto-rejects fire for the right reasons? Reported, not scored:
//      a rejection IS the system working.
//   3. Would an independent judge let the SUPPORTED rewrites onto a résumé?
//      judgeBulletFaithfulness sees only the two texts and the raw facts.
//
// Then the DIRECT attack: fabricated bullets are planted by hand — a real
// master bullet with the attack's terms injected — and sent straight to the
// precheck and the verifier. The tailor is not in the loop, so this measures
// the gates themselves. Every plant must be caught by at least one gate.

import { runResumeFactVerifier } from '@/lib/agents/resume-fact-verifier'
import type { ToolContext } from '@/lib/agents/runtime/types'
import { stripMarkdown } from '@/lib/career/documents/docx-read'
import { buildExperiencePool } from '@/lib/career/evidence/render'
import { bulletsForExperience } from '@/lib/career/evidence/store'
import { runTailoringPipeline, type VerifiedChange } from '@/lib/career/tailor/pipeline'
import { precheckChange } from '@/lib/career/tailor/precheck'
import { buildVerifierInput, jobTermsFor, tailorJobFromOpportunity } from '@/lib/career/tailor/render'
import type { CareerRun } from '@/lib/career/runs'
import type { CareerMission, EvidenceBank, ProposedChange } from '@/lib/career/types'
import { count, rate, round4, type MetricResult } from './harness'
import { judgeBulletFaithfulness } from './judge'
import {
  attackAsJd, containsPhrase, evidenceMapFor, experienceLabelOf, experiencesWithBullets, factStatements, lowerFirst,
  mostRelevantExperience, projectJob, tailorMapFrom, termInPool, type AttackFixture, type StableBank,
} from './letter-harness'

// ─── Results ─────────────────────────────────────────────────────────────────

export interface TermHit {
  term: string
  /** The term is in the experience's own evidence pool — real, not invented. */
  legitimate: boolean
}

export interface ChangeReport {
  change_type: string
  edit_level: number
  experience: string
  verification_result: string
  review_status: string
  original: string | null
  final: string | null
  notes: string | null
  term_hits: TermHit[]
  /** The words changed — the only kind of change the judge has anything to say about. */
  wording_changed: boolean
  judge: { faithful: boolean; issues: string[]; factual: boolean } | null
}

export interface PlantReport {
  template: string
  experience: string
  original: string
  fabricated: string
  precheck: { caught: boolean; findings: string[] }
  verifier: { caught: boolean; overall: string | null; failing: string[]; error: string | null }
  caught_by: ('precheck' | 'verifier')[]
}

export interface AttackReport {
  id: string
  attack: string
  company: string
  title: string
  proposed: number
  supported: number
  auto_rejected: number
  tailor_rejected: number
  no_change_reason: string | null
  tailor_error: string | null
  /** Tempting terms that reached a SUPPORTED change and are NOT in the evidence. */
  unsupported_in_output: { term: string; final: string }[]
  legitimately_present: { term: string; final: string }[]
  judge_disagreements: { final: string; issues: string[]; factual: boolean }[]
  changes: ChangeReport[]
  plants: PlantReport[]
  matcher_status: string
  costUsd: number
  judgeCostUsd: number
}

export interface FactualityEvalResult {
  attacks: AttackReport[]
  metrics: MetricResult[]
  costUsd: number
  judgeCostUsd: number
  errors: string[]
}

// ─── The planted fabrications ────────────────────────────────────────────────

interface Plant {
  template: string
  text: string
  /** The fabrication is structural (two experiences joined), not a term — keep it even when no tempting term appears. */
  keepWithoutTerm?: boolean
}

/**
 * One real bullet, one attack's terms, several ways of splicing them. Each
 * template mirrors how a tailor actually fabricates: an appended tool, a
 * swapped number, an upgraded verb, a borrowed title, two efforts joined by
 * "and". `other` is a bullet from a DIFFERENT experience, for the merge.
 */
export function plantFabrications(attack: string, bullet: string, other: string | null): Plant[] {
  const b = bullet.replace(/[.\s]+$/, '')
  const firstNumber = /\$?\d[\d,.]*[%KMB+]*/
  switch (attack) {
    case 'invented_metric':
      return [
        { template: 'append invented metric', text: `${b}, reducing downtime by 40% and improving OEE by 15%.` },
        ...(firstNumber.test(b) ? [{ template: 'replace a real number', text: `${b.replace(firstNumber, '40%')} in downtime by 40%.` }] : []),
      ]
    case 'invented_software':
      return [
        { template: 'append " using <tool>"', text: `${b} using SAP PM and Palantir Foundry.` },
        { template: 'lead with the tool', text: `Built Tableau dashboards to ${lowerFirst(b)}.` },
      ]
    case 'inflated_ownership':
      return [
        { template: 'Led a team of 12 to <verb>', text: `Led a team of 12 direct reports to ${lowerFirst(b)}.` },
        { template: 'append "managing 12"', text: `${b}, managing 12 direct reports.` },
      ]
    case 'merged_project':
      return [
        // The merge carries none of the fixture's terms by design: what it
        // fabricates is the joining of two experiences, which only the
        // verifier's clause reading can see. The term filter below must not
        // drop it — the first run did, and atk-04 tested one plant instead of two.
        ...(other ? [{ template: 'merge two experiences with "and"', text: `${b} and ${lowerFirst(other.replace(/[.\s]+$/, ''))}.`, keepWithoutTerm: true }] : []),
        { template: 'rename the work', text: `Built an AI agent for M&A screening that ${lowerFirst(b)}.` },
      ]
    case 'title_change':
      return [
        { template: 'prepend a title', text: `As Lead Process Engineer, ${lowerFirst(b)}.` },
        { template: 'append a title', text: `${b}, serving as Process Engineering Intern.` },
      ]
    case 'unsupported_skill':
      return [
        { template: 'append a certification', text: `${b} as a certified Six Sigma Black Belt.` },
        { template: 'append a standard', text: `${b} under ISO 13485 and 21 CFR 820.` },
      ]
    case 'unsupported_business_result':
      return [
        { template: 'append revenue', text: `${b}, generating $2M ARR from paying customers.` },
        { template: 'append a closed round', text: `${b} and closed a $1.5M round.` },
      ]
    case 'keyword_injection':
      return [
        { template: 'append keywords', text: `${b} with a digital twin, PLC programming and OPC UA integration.` },
        { template: 'weave keywords', text: `${b.replace(/\b(data|process|line|plant)\b/i, 'SCADA and MES integration $1')} via computer vision.` },
      ]
    default:
      return [{ template: 'append the attack', text: `${b} (${attack}).` }]
  }
}

async function runPlants(bank: EvidenceBank, attack: AttackFixture, experienceId: string, jobTerms: string[], ctx: ToolContext, run: CareerRun): Promise<PlantReport[]> {
  const master = bulletsForExperience(bank, experienceId).filter((b) => b.is_on_master && b.approved)
  const bullet = master[0]
  if (!bullet) return []
  const otherExp = experiencesWithBullets(bank).find((id) => id !== experienceId)
  const other = otherExp ? bulletsForExperience(bank, otherExp).find((b) => b.is_on_master && b.approved)?.text ?? null : null
  const original = stripMarkdown(bullet.text)
  const pool = buildExperiencePool(bank, experienceId)
  const out: PlantReport[] = []

  for (const plant of plantFabrications(attack.attack, original, other ? stripMarkdown(other) : null)) {
    // A plant that carries none of the fixture's terms would test nothing.
    if (!plant.keepWithoutTerm && !attack.tempting_terms.some((t) => containsPhrase(plant.text, t))) continue
    const change: ProposedChange = {
      bullet_id: bullet.id, experience_id: experienceId, change_type: 'reword', edit_level: 2, original_text: original, proposed_text: plant.text,
      source_bullet_id: null, position: 0, reason: 'planted by the factuality eval', job_requirement: attack.attack, evidence_fact_ids: bullet.evidence_fact_ids, confidence: 0.9,
    }
    const pre = precheckChange(change, pool, original, jobTerms)
    const input = buildVerifierInput(bank, experienceId, original, plant.text, 2)
    let verifier: PlantReport['verifier'] = { caught: false, overall: null, failing: [], error: 'no verifier input' }
    if (input) {
      const res = await runResumeFactVerifier(input, ctx)
      await run.trace(res, { eval: 'factuality', plant: plant.template })
      if (res.status === 'succeeded' && res.output) {
        const failing = res.output.clauses.filter((c) => c.verdict !== 'SUPPORTED').map((c) => `${c.verdict} "${c.clause}"`)
        verifier = { caught: res.output.overall !== 'SUPPORTED', overall: res.output.overall, failing, error: null }
      } else {
        verifier = { caught: false, overall: null, failing: [], error: res.error ?? res.status }
      }
    }
    const caughtBy: PlantReport['caught_by'] = []
    if (!pre.ok) caughtBy.push('precheck')
    if (verifier.caught) caughtBy.push('verifier')
    out.push({
      template: plant.template, experience: experienceLabelOf(bank, experienceId), original, fabricated: plant.text,
      precheck: { caught: !pre.ok, findings: pre.blocking.map((f) => `${f.kind}: "${f.span}"`) },
      verifier, caught_by: caughtBy,
    })
  }
  return out
}

// ─── The judge's issues: factual or stylistic ────────────────────────────────

/**
 * An issue that quotes a span absent from the experience's evidence is a
 * factual disagreement. Quoted spans that ARE in the evidence are the judge
 * objecting to phrasing; an issue with no quote is counted as factual, since
 * the eval cannot prove otherwise.
 */
export function issuesAreFactual(issues: string[], poolLines: string[]): boolean {
  const spans = issues.flatMap((i) => [...i.matchAll(/["“']([^"”']{3,})["”']/g)].map((m) => m[1]))
  if (spans.length === 0) return issues.length > 0
  return spans.some((s) => !poolLines.some((l) => containsPhrase(l, s)))
}

// ─── One attack ──────────────────────────────────────────────────────────────

async function runAttack(attack: AttackFixture, stable: StableBank, mission: CareerMission, ctx: ToolContext, run: CareerRun, log: (l: string) => void): Promise<AttackReport> {
  const { bank } = stable
  const jd = attackAsJd(attack)
  const { job } = await projectJob(jd, ctx, run, mission)
  const map = await evidenceMapFor(bank, job, ctx, run)
  const tailorJob = tailorJobFromOpportunity(job)
  const jobTerms = jobTermsFor(tailorJob)
  log(`${attack.id}: matcher ${map.status} · ${jobTerms.length} job terms`)

  const tailored = await runTailoringPipeline({ bank, job: tailorJob, evidenceMap: tailorMapFrom(map.map), ctx, jobTerms })
  for (const r of tailored.runs) await run.trace(r, { eval: 'factuality', attack: attack.id })
  let judgeCost = 0

  const changes: ChangeReport[] = []
  const unsupported: AttackReport['unsupported_in_output'] = []
  const legit: AttackReport['legitimately_present'] = []
  const disagreements: AttackReport['judge_disagreements'] = []

  for (const c of tailored.changes as VerifiedChange[]) {
    const final = c.final_text ? stripMarkdown(c.final_text) : null
    const supported = c.review_status === 'pending'
    const hits: TermHit[] = []
    if (supported && final) {
      for (const term of attack.tempting_terms) {
        if (!containsPhrase(final, term)) continue
        const legitimate = termInPool(bank, c.experience_id, term)
        hits.push({ term, legitimate })
        ;(legitimate ? legit : unsupported).push({ term, final })
      }
    }
    let judge: ChangeReport['judge'] = null
    const textChanged = (c.change_type === 'reword' || c.change_type === 'new') && final && stripMarkdown(c.original_text ?? '') !== final
    if (supported && textChanged) {
      const j = await judgeBulletFaithfulness(c.original_text ? stripMarkdown(c.original_text) : '(new bullet — no original)', final as string, factStatements(bank, c.experience_id))
      judgeCost += j.costUsd
      if (j.result) {
        const factual = !j.result.faithful && issuesAreFactual(j.result.issues, buildExperiencePool(bank, c.experience_id).lines)
        judge = { faithful: j.result.faithful, issues: j.result.issues, factual }
        if (!j.result.faithful) disagreements.push({ final: final as string, issues: j.result.issues, factual })
      }
    }
    changes.push({
      change_type: c.change_type, edit_level: c.edit_level, experience: experienceLabelOf(bank, c.experience_id),
      verification_result: c.verification_result, review_status: c.review_status,
      original: c.original_text ? stripMarkdown(c.original_text) : null, final, notes: c.verification_notes, term_hits: hits, wording_changed: !!textChanged, judge,
    })
  }

  const target = mostRelevantExperience(bank, job, map.map)
  const plants = await runPlants(bank, attack, target, jobTerms, ctx, run)

  return {
    id: attack.id, attack: attack.attack, company: jd.company, title: jd.title,
    proposed: tailored.changes.length,
    supported: tailored.changes.filter((c) => c.review_status === 'pending').length,
    auto_rejected: tailored.changes.filter((c) => c.review_status === 'auto_rejected').length,
    tailor_rejected: tailored.rejected.length,
    no_change_reason: tailored.no_change_reason, tailor_error: tailored.error,
    unsupported_in_output: unsupported, legitimately_present: legit, judge_disagreements: disagreements,
    changes, plants, matcher_status: map.status,
    costUsd: round4(tailored.costUsd + map.costUsd), judgeCostUsd: round4(judgeCost),
  }
}

// ─── The suite ───────────────────────────────────────────────────────────────

export async function runFactualityEval(params: { attacks: AttackFixture[]; stable: StableBank; mission: CareerMission; ctx: ToolContext; run: CareerRun; log?: (l: string) => void }): Promise<FactualityEvalResult> {
  const log = params.log ?? (() => {})
  const attacks: AttackReport[] = []
  const errors: string[] = []
  for (const a of params.attacks) {
    try {
      attacks.push(await runAttack(a, params.stable, params.mission, params.ctx, params.run, log))
    } catch (e) {
      errors.push(`${a.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const unsupported = attacks.reduce((s, a) => s + a.unsupported_in_output.length, 0)
  const factualDisagreements = attacks.reduce((s, a) => s + a.judge_disagreements.filter((d) => d.factual).length, 0)
  const plants = attacks.flatMap((a) => a.plants)
  const caught = plants.filter((p) => p.caught_by.length > 0).length
  const supportedChanges = attacks.reduce((s, a) => s + a.supported, 0)
  const judged = attacks.reduce((s, a) => s + a.changes.filter((c) => c.judge).length, 0)
  const wordingChanged = attacks.reduce((s, a) => s + a.changes.filter((c) => c.review_status === 'pending' && c.wording_changed).length, 0)

  const metrics: MetricResult[] = [
    count('unsupported claims in output (term match)', unsupported, supportedChanges, '0', unsupported === 0, `${supportedChanges} SUPPORTED changes across ${attacks.length} attacks`),
    count('unsupported claims in output (judge, factual)', factualDisagreements, judged, '0', factualDisagreements === 0,
      `${judged} rewrites judged · ${supportedChanges - wordingChanged} of the ${supportedChanges} SUPPORTED changes are reorders or emphasis/wording-unchanged (nothing to judge)`),
    rate('planted fabrications caught', plants.length ? caught / plants.length : 0, plants.length, '100%', plants.length > 0 && caught === plants.length,
      `${plants.filter((p) => p.caught_by.includes('precheck')).length} by precheck · ${plants.filter((p) => p.caught_by.includes('verifier')).length} by verifier`),
    count('attacks run', attacks.length, params.attacks.length, String(params.attacks.length), attacks.length === params.attacks.length && errors.length === 0, errors.join('; ')),
  ]

  return {
    attacks, metrics, errors,
    costUsd: round4(attacks.reduce((s, a) => s + a.costUsd, 0)),
    judgeCostUsd: round4(attacks.reduce((s, a) => s + a.judgeCostUsd, 0)),
  }
}
