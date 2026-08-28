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
import { runResumeImporter, RESUME_SOURCE_LABEL, type ResumeImporterInput, type ResumeImporterOutput } from '@/lib/agents/resume-importer'
import type { AgentTrace, ToolContext } from '@/lib/agents/runtime/types'
import type { FactCategory, FactSource, SkillCategory } from '../types'
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

// ─── Proposed rows ───────────────────────────────────────────────────────────

export interface ProposedFact {
  experience_key: string
  statement: string
  category: FactCategory
  source: FactSource
  source_location: string
  paragraph_index: number | null
  confidence: number
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

export interface ImportProposal {
  experiences: ProposedExperience[]
  bullets: ProposedBullet[]
  facts: ProposedFact[]
  metrics: ProposedMetric[]
  skills: ProposedSkill[]
  deliverables: ProposedDeliverable[]
  dropped: {
    unverifiable: number
    metrics: number
    skills: number
    misfiled: number
    experiences: number
  }
  trace: AgentTrace | null
  /** Set when the agent failed; the deterministic parts (experiences, bullets) are still filled. */
  agentError: string | null
  model: ResumeModel | null
}

// ─── Folding agent output onto proposals ─────────────────────────────────────

function foldOutput(
  proposal: ImportProposal,
  output: ResumeImporterOutput,
  opts: { filename: string; extra: ExtraSourceText[]; textSource: FactSource | null }
): void {
  const sourceFor = new Map<string, FactSource>(opts.extra.map((s) => [s.label, s.source]))
  const known = new Map(proposal.experiences.map((e) => [e.key, e]))

  for (const x of output.experiences) {
    let exp = known.get(x.experience_key)
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

  proposal.dropped = {
    unverifiable: output.dropped_unverifiable,
    metrics: output.dropped_metrics,
    skills: output.dropped_skills,
    misfiled: output.dropped_misfiled,
    experiences: output.dropped_experiences,
  }
}

function emptyProposal(model: ResumeModel | null): ImportProposal {
  return {
    experiences: [],
    bullets: [],
    facts: [],
    metrics: [],
    skills: [],
    deliverables: [],
    dropped: { unverifiable: 0, metrics: 0, skills: 0, misfiled: 0, experiences: 0 },
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
 * Pasted text → proposal. No paragraph map, so each line is a paragraph and
 * the agent proposes the experience blocks (validated to carry organization
 * and title). `source` is what lands in `evidence_facts.source`.
 */
export async function importFromText(
  userId: string,
  text: string,
  source: FactSource,
  opts: Omit<ImportOptions, 'skipAgent'> & { label?: string } = {}
): Promise<ImportProposal> {
  const proposal = emptyProposal(null)
  const label = opts.label ?? `pasted.${source}`
  const extra: ExtraSourceText[] = [{ label, source, text }, ...(opts.extraSources ?? [])]
  const input: ResumeImporterInput = {
    experiences: [],
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
  foldOutput(proposal, result.output, { filename: label, extra, textSource: source })
  return proposal
}
