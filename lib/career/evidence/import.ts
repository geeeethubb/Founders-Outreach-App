// Evidence import — orchestration between a résumé and the importer agent.
//
// Produces PROPOSED rows, never persisted here: the seed and the API decide
// whether to write them and with which `approved` flag. Every proposed fact
// carries provenance the way the table demands it — `source` and a
// `source_location` like "Zuyu_Resume.docx ¶6" — so nothing downstream has to
// reconstruct where a claim came from.
//
// Two entry points: a DOCX with a paragraph map (the master résumé), and free
// text with none (pasted résumé / LinkedIn text, profile fields), where each
// line is a paragraph and the agent proposes the experience blocks itself.

import { readDocx, type DocxFile } from '../documents/docx-read'
import { buildResumeModel, type ResumeModel } from '../documents/resume-model'
import { runResumeImporter, RESUME_SOURCE_LABEL, type ImporterExperienceInput, type ResumeImporterInput, type ResumeImporterOutput } from '@/lib/agents/resume-importer'
import type { AgentTrace, ToolContext } from '@/lib/agents/runtime/types'
import type { EvidenceBank, EvidenceExperience, FactCategory, FactSource, SkillCategory } from '../types'
import {
  deriveBullets,
  deriveExperiences,
  extraSourcesFromProfile,
  importerExperiences,
  linesOf,
  toExtraSources,
  type ExtraSourceText,
  type ProposedBullet,
  type ProposedExperience,
} from './derive'

export { deriveBullets, deriveExperiences, extraSourcesFromProfile, linesOf }
export type { ExtraSourceText, ProposedBullet, ProposedExperience }

/**
 * Text mode: the bank's active rows with their active facts, shaped for
 * `importFromText({ existing })`. Pure; the caller loads the bank.
 */
export function existingFromBank(bank: Pick<EvidenceBank, 'experiences' | 'facts'>): ExistingExperienceInput[] {
  const active = <T extends { status?: string | null }>(rows: T[]) => rows.filter((r) => r.status !== 'merged')
  const facts = active(bank.facts)
  return active(bank.experiences).map((e) => ({
    id: e.id,
    kind: e.kind,
    organization: e.organization,
    title: e.title,
    start_date: e.start_date,
    end_date: e.end_date,
    location: e.location,
    facts: facts.filter((f) => f.experience_id === e.id).map((f) => ({ id: f.id, statement: f.statement, support_count: f.support_count ?? 1 })),
  }))
}

// ─── Proposed rows ───────────────────────────────────────────────────────────

export interface ProposedFact {
  experience_key: string
  statement: string
  category: FactCategory
  source: FactSource
  source_location: string
  paragraph_index: number | null
  confidence: number
  /**
   * The bank fact the importer says this sentence restates (validated
   * against the input by the agent's checks). planPersist verifies it again
   * against the bank before turning it into a reuse.
   */
  corroborates?: string | null
}

export interface ProposedMetric {
  experience_key: string
  value: string
  unit: string | null
  context: string | null
  /** Indexes into ImportProposal.facts. */
  fact_refs: number[]
  source: FactSource
}

export interface ProposedSkill {
  name: string
  category: SkillCategory
  fact_refs: number[]
}

export interface ProposedDeliverable {
  experience_key: string
  description: string
  fact_refs: number[]
}

export interface ProposedProject {
  experience_key: string
  name: string
  description: string | null
  /** Indexes into ImportProposal.facts. */
  fact_refs: number[]
}

/** An active bank fact the importer is shown under its experience (text mode). */
export interface ExistingFactInput {
  id: string
  statement: string
  support_count?: number | null
}

/** The slice of a bank row the importer is shown in text mode. */
export type ExistingExperienceInput = Pick<EvidenceExperience, 'id' | 'kind' | 'organization' | 'title' | 'start_date' | 'end_date'> & {
  location?: string | null
  /** The row's active facts; existingExperienceInputs caps and orders them. */
  facts?: ExistingFactInput[]
}

/** How many of a row's facts the importer sees, most-supported first. */
export const EXISTING_FACTS_PER_EXPERIENCE = 20

export interface ImportProposal {
  experiences: ProposedExperience[]
  bullets: ProposedBullet[]
  facts: ProposedFact[]
  metrics: ProposedMetric[]
  skills: ProposedSkill[]
  deliverables: ProposedDeliverable[]
  /** Named work the text names (validated); persisted into evidence_projects when 015 exists. */
  projects: ProposedProject[]
  dropped: {
    unverifiable: number
    metrics: number
    skills: number
    misfiled: number
    experiences: number
    projects: number
    /** `corroborates` claims the checks rejected (the facts were kept). */
    corroborations?: number
  }
  /** One line per rejected `corroborates` claim, from the agent's validator. */
  corroborationNotes?: string[]
  trace: AgentTrace | null
  /** Set when the agent failed; the deterministic parts (experiences, bullets) are still filled. */
  agentError: string | null
  model: ResumeModel | null
}

// ─── Folding agent output onto proposals ─────────────────────────────────────

export function foldOutput(
  proposal: ImportProposal,
  output: ResumeImporterOutput,
  opts: { filename: string; extra: ExtraSourceText[]; textSource: FactSource | null; existing?: ExistingExperienceInput[] }
): void {
  const sourceFor = new Map<string, FactSource>(opts.extra.map((s) => [s.label, s.source]))
  const known = new Map(proposal.experiences.map((e) => [e.key, e]))
  const existing = new Map((opts.existing ?? []).map((e) => [e.id, e]))
  const baseOf = new Map<string, number>()

  for (const x of output.experiences) {
    let exp = known.get(x.experience_key)
    const row = exp ? undefined : existing.get(x.experience_key)
    if (!exp && row) {
      // Filed under a bank row. The block carries the role as THIS text
      // states it (or the row's own values when the text gave none) plus the
      // id as a hint; planPersist verifies the hint before reusing the row.
      const w = x.new_experience
      exp = {
        key: x.experience_key,
        kind: w?.kind && w.kind !== 'other' ? w.kind : row.kind,
        organization: w?.organization ?? row.organization,
        title: w?.title ?? row.title,
        location: w?.location ?? row.location ?? null,
        start_date: w?.start_date ?? row.start_date,
        end_date: w?.end_date ?? row.end_date,
        description: null,
        display_order: proposal.experiences.length,
        source: opts.textSource ?? 'manual',
        bulletParagraphIndexes: [],
        identityParagraphIndex: null,
        summary: null,
        existingId: row.id,
      }
      proposal.experiences.push(exp)
      known.set(exp.key, exp)
    }
    if (!exp) {
      // Text mode: the agent proposed the block. validate() already required
      // an organization and a title.
      if (!x.new_experience) continue
      exp = {
        key: x.experience_key,
        kind: x.new_experience.kind,
        organization: x.new_experience.organization,
        title: x.new_experience.title,
        location: x.new_experience.location,
        start_date: x.new_experience.start_date,
        end_date: x.new_experience.end_date,
        description: null,
        display_order: proposal.experiences.length,
        source: opts.textSource ?? 'manual',
        bulletParagraphIndexes: [],
        identityParagraphIndex: null,
        summary: null,
      }
      proposal.experiences.push(exp)
      known.set(exp.key, exp)
    }
    exp.summary = x.summary || exp.summary

    const base = proposal.facts.length
    baseOf.set(exp.key, base)
    for (const f of x.facts) {
      const fromResume = f.source_label === RESUME_SOURCE_LABEL
      proposal.facts.push({
        experience_key: exp.key,
        statement: f.statement,
        category: f.category,
        source: fromResume ? 'master_resume' : sourceFor.get(f.source_label) ?? opts.textSource ?? 'manual',
        source_location: fromResume ? `${opts.filename} ¶${f.paragraph_index}` : `${f.source_label} L${f.paragraph_index}`,
        paragraph_index: fromResume ? f.paragraph_index : null,
        confidence: f.confidence,
        corroborates: f.corroborates ?? null,
      })
    }
    const lift = (r: number[]) => r.map((i) => base + i)
    for (const m of x.metrics) {
      proposal.metrics.push({
        experience_key: exp.key,
        value: m.value,
        unit: m.unit,
        context: m.context,
        fact_refs: lift(m.fact_refs),
        source: exp.source,
      })
    }
    for (const s of x.skills) {
      // Skills are global (one row per name per user); merge refs across experiences.
      const existing = proposal.skills.find((k) => k.name.toLowerCase() === s.name.toLowerCase())
      if (existing) existing.fact_refs.push(...lift(s.fact_refs))
      else proposal.skills.push({ name: s.name, category: s.category, fact_refs: lift(s.fact_refs) })
    }
    for (const d of x.deliverables) {
      proposal.deliverables.push({ experience_key: exp.key, description: d.description, fact_refs: lift(d.fact_refs) })
    }
  }

  for (const p of output.projects ?? []) {
    const exp = known.get(p.experience_key)
    const base = baseOf.get(p.experience_key)
    if (!exp || base === undefined) continue
    proposal.projects.push({ experience_key: exp.key, name: p.name, description: p.description, fact_refs: p.fact_refs.map((i) => base + i) })
  }

  proposal.dropped = {
    unverifiable: output.dropped_unverifiable,
    metrics: output.dropped_metrics,
    skills: output.dropped_skills,
    misfiled: output.dropped_misfiled,
    experiences: output.dropped_experiences,
    projects: output.dropped_projects ?? 0,
    corroborations: output.dropped_corroborations ?? 0,
  }
  proposal.corroborationNotes = output.corroboration_notes ?? []
}

function emptyProposal(model: ResumeModel | null): ImportProposal {
  return {
    experiences: [],
    bullets: [],
    facts: [],
    metrics: [],
    skills: [],
    deliverables: [],
    projects: [],
    dropped: { unverifiable: 0, metrics: 0, skills: 0, misfiled: 0, experiences: 0, projects: 0 },
    trace: null,
    agentError: null,
    model,
  }
}

export function defaultToolContext(userId: string): ToolContext {
  return {
    user_id: userId,
    run_id: null,
    budget: { maxCompanies: 0, maxPeoplePerCompany: 0, maxApolloCalls: 0, maxWebSearches: 0, maxAgentSteps: 3 },
  }
}

export interface ImportOptions {
  filename?: string
  extraSources?: ExtraSourceText[]
  ctx?: ToolContext
  /** Skip the agent: experiences and bullets only — the structural rows, with no facts. */
  skipAgent?: boolean
  onStep?: (info: { step: number; elapsedMs: number; stopReason: string | null; toolCalls: string[] }) => void
}

/**
 * Master résumé → proposal. The structural parts (experiences, bullets) are
 * deterministic and always present; the agent adds facts, metrics, skills and
 * deliverables, and its failure is reported on `agentError` rather than thrown.
 */
export async function importFromResume(
  userId: string,
  docx: DocxFile | Buffer,
  opts: ImportOptions = {}
): Promise<ImportProposal> {
  const file = Buffer.isBuffer(docx) ? await readDocx(docx) : docx
  const model = buildResumeModel(file)
  const proposal = emptyProposal(model)
  proposal.experiences = deriveExperiences(model)
  proposal.bullets = deriveBullets(model, proposal.experiences)
  if (opts.skipAgent) return proposal

  const extra = opts.extraSources ?? []
  const input: ResumeImporterInput = {
    experiences: importerExperiences(model, proposal.experiences),
    extra_sources: toExtraSources(extra),
    allow_new_experiences: false,
  }
  const result = await runResumeImporter(input, opts.ctx ?? defaultToolContext(userId), { onStep: opts.onStep })
  proposal.trace = result.trace
  if (!result.output) {
    proposal.agentError = result.error ?? `importer ${result.status}`
    return proposal
  }
  foldOutput(proposal, result.output, { filename: opts.filename ?? 'resume.docx', extra, textSource: null })
  return proposal
}

/**
 * The bank's active experiences as the importer sees them: key = row id, no
 * paragraphs, and up to EXISTING_FACTS_PER_EXPERIENCE of the row's facts
 * (most-supported first, then the bank's order) so a sentence that restates
 * one can say so instead of becoming a second wording.
 */
export function existingExperienceInputs(existing: ExistingExperienceInput[]): ImporterExperienceInput[] {
  return existing.map((e) => {
    const facts = [...(e.facts ?? [])]
      .map((f, i) => ({ f, i }))
      .sort((a, b) => (b.f.support_count ?? 1) - (a.f.support_count ?? 1) || a.i - b.i)
      .slice(0, EXISTING_FACTS_PER_EXPERIENCE)
      .map(({ f }) => ({ id: f.id, statement: f.statement }))
    return {
      key: e.id,
      title: e.title,
      organization: e.organization,
      location: e.location ?? null,
      start_date: e.start_date,
      end_date: e.end_date,
      section: e.kind,
      bullets: [],
      existing_id: e.id,
      ...(facts.length ? { existing_facts: facts } : {}),
    }
  })
}

/**
 * Pasted text → proposal. No paragraph map, so each line is a paragraph. The
 * agent is shown the bank's existing experiences (`opts.existing`, loaded by
 * the caller — this module never reads the database) and files facts under
 * them, proposing a new block only when none fits. `source` is what lands in
 * `evidence_facts.source`.
 */
export async function importFromText(
  userId: string,
  text: string,
  source: FactSource,
  opts: Omit<ImportOptions, 'skipAgent'> & { label?: string; existing?: ExistingExperienceInput[] } = {}
): Promise<ImportProposal> {
  const proposal = emptyProposal(null)
  const label = opts.label ?? `pasted.${source}`
  const extra: ExtraSourceText[] = [{ label, source, text }, ...(opts.extraSources ?? [])]
  const existing = opts.existing ?? []
  const input: ResumeImporterInput = {
    experiences: existingExperienceInputs(existing),
    extra_sources: toExtraSources(extra),
    allow_new_experiences: true,
  }
  if (input.extra_sources.length === 0) {
    proposal.agentError = 'no text to import'
    return proposal
  }
  const result = await runResumeImporter(input, opts.ctx ?? defaultToolContext(userId), { onStep: opts.onStep })
  proposal.trace = result.trace
  if (!result.output) {
    proposal.agentError = result.error ?? `importer ${result.status}`
    return proposal
  }
  foldOutput(proposal, result.output, { filename: label, extra, textSource: source, existing })
  return proposal
}
