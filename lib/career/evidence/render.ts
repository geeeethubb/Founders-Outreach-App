// Renderings of the Evidence Bank for prompts and for the deterministic gates.
//
// Principle 5: NEVER dump the résumé. Prompts receive summaries; only selected
// items contribute full detail. Two audiences, two renderings:
//
//   the WRITER / TAILOR asks "what may I argue from?"  → summaries + the facts
//                                                          for the experiences chosen
//   the GATE asks "is this claim true?"                → the widest honest pool:
//                                                          every approved fact,
//                                                          metric, bullet, and the
//                                                          identity lines
//
// Collapsing the two fails both ways (ADR-023).

import { stripMarkdown } from '../documents/docx-read'
import { bulletsForExperience, factsForExperience, metricsForExperience } from './store'
import type { EvidenceBank, EvidenceExperience, EvidenceFact } from '../types'

export function experienceLabel(e: EvidenceExperience): string {
  const dates = [e.start_date, e.end_date].filter(Boolean).join(' – ')
  return `${e.title} — ${e.organization}${dates ? ` (${dates})` : ''}`
}

/** One line per experience. What the planner, the fit evaluator and the matcher see first. */
export function renderExperienceSummaries(bank: EvidenceBank, opts: { maxFactsEach?: number } = {}): string {
  const max = opts.maxFactsEach ?? 2
  const lines: string[] = []
  for (const e of bank.experiences) {
    const facts = factsForExperience(bank, e.id)
      .filter((f) => f.category === 'achievement' || f.category === 'responsibility' || f.category === 'scope')
      .slice(0, max)
      .map((f) => f.statement)
    const detail = facts.length ? `: ${facts.join(' · ')}` : e.description ? `: ${e.description}` : ''
    lines.push(`[${e.id}] (${e.kind}) ${experienceLabel(e)}${detail}`)
  }
  return lines.join('\n')
}

/** Full facts, metrics and current bullets for ONE experience. Cite-by-id format. */
export function renderExperienceDetail(bank: EvidenceBank, experienceId: string): string {
  const e = bank.experiences.find((x) => x.id === experienceId)
  if (!e) return ''
  const lines: string[] = [`EXPERIENCE [${e.id}] ${experienceLabel(e)}${e.location ? ` · ${e.location}` : ''}`]
  const facts = factsForExperience(bank, e.id)
  if (facts.length) {
    lines.push('  FACTS (cite by id):')
    for (const f of facts) lines.push(`    [${f.id}] (${f.category}) ${f.statement}`)
  }
  const metrics = metricsForExperience(bank, e.id)
  if (metrics.length) {
    lines.push('  METRICS:')
    for (const m of metrics) lines.push(`    [${m.id}] ${m.value}${m.unit ? ` ${m.unit}` : ''}${m.context ? ` — ${m.context}` : ''} (facts: ${m.fact_ids.join(', ') || 'none'})`)
  }
  const bullets = bulletsForExperience(bank, e.id)
  if (bullets.length) {
    lines.push('  CURRENT RÉSUMÉ BULLETS (on master unless marked alternate):')
    for (const b of bullets) {
      lines.push(`    [${b.id}]${b.is_on_master ? '' : ' (alternate, approved)'} ${stripMarkdown(b.text)}  (facts: ${b.evidence_fact_ids.join(', ') || 'none'})`)
    }
  }
  return lines.join('\n')
}

export function renderSkills(bank: EvidenceBank): string {
  if (!bank.skills.length) return '(no skills recorded)'
  return bank.skills.map((s) => `[${s.id}] ${s.name} (${s.category})`).join('; ')
}

export function renderStories(bank: EvidenceBank, opts: { max?: number } = {}): string {
  const rows = bank.stories.slice(0, opts.max ?? 8)
  if (!rows.length) return '(no stories recorded)'
  return rows
    .map((s) => `[${s.id}] ${s.title}: ${[s.situation, s.task, s.actions, s.result, s.learning].filter(Boolean).join(' → ')}`)
    .join('\n')
}

export function renderPreferences(bank: EvidenceBank): string {
  if (!bank.preferences.length) return '(no preferences recorded)'
  return bank.preferences
    .map((p) => `${p.category}: ${p.value}${p.hard_constraint ? ' [HARD]' : ` (weight ${p.weight})`}`)
    .join('\n')
}

// ─── Verification pools ──────────────────────────────────────────────────────

export interface EvidencePool {
  /** Every line a claim may be checked against. */
  lines: string[]
  /** The fact ids in scope, for cite-by-id validation. */
  factIds: Set<string>
}

/**
 * The gate's pool for ONE experience: its facts, metrics, all its approved
 * bullets (master and alternates), the experience's identity lines, and the
 * user's approved skills. Skills are global because a tool named in a bullet
 * ("n8n") is often recorded once as a skill rather than repeated per fact.
 */
export function buildExperiencePool(bank: EvidenceBank, experienceId: string): EvidencePool {
  const e = bank.experiences.find((x) => x.id === experienceId)
  const lines: string[] = []
  const factIds = new Set<string>()
  if (e) {
    lines.push(experienceLabel(e))
    if (e.location) lines.push(e.location)
    if (e.description) lines.push(e.description)
  }
  for (const f of factsForExperience(bank, experienceId)) {
    lines.push(f.statement)
    factIds.add(f.id)
  }
  for (const m of metricsForExperience(bank, experienceId)) {
    lines.push([m.value, m.unit, m.context].filter(Boolean).join(' '))
  }
  for (const b of bulletsForExperience(bank, experienceId)) lines.push(stripMarkdown(b.text))
  for (const s of bank.skills) lines.push(s.name)
  return { lines, factIds }
}

/** The whole bank as one pool — for the cover letter's personal claims. */
export function buildBankPool(bank: EvidenceBank): EvidencePool {
  const lines: string[] = []
  const factIds = new Set<string>()
  for (const e of bank.experiences) {
    lines.push(experienceLabel(e))
    if (e.location) lines.push(e.location)
    if (e.description) lines.push(e.description)
  }
  for (const f of bank.facts) {
    lines.push(f.statement)
    factIds.add(f.id)
  }
  for (const m of bank.metrics) lines.push([m.value, m.unit, m.context].filter(Boolean).join(' '))
  for (const b of bank.bullets) lines.push(stripMarkdown(b.text))
  for (const s of bank.skills) lines.push(s.name)
  for (const st of bank.stories) {
    for (const part of [st.title, st.situation, st.task, st.actions, st.result, st.learning]) if (part) lines.push(part)
  }
  return { lines, factIds }
}

/** Facts by id, for rendering a verifier's supporting evidence. */
export function factsById(bank: EvidenceBank, ids: string[]): EvidenceFact[] {
  const set = new Set(ids)
  return bank.facts.filter((f) => set.has(f.id))
}
