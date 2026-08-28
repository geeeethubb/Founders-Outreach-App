// An Evidence Bank in memory, from the real résumé, with no database.
//
// The seed path (seed.ts → persist.ts) turns an ImportProposal into rows and
// gets ids back from Postgres. Evals and the no-DB CLI need the same bank —
// the same experiences, bullets, facts, metrics, skills, and the same
// paragraph map with bullet ids stamped — without a database to hand out
// ids. This mints them with crypto.randomUUID and resolves fact_refs exactly
// the way persistProposal does, so a pipeline run on this bank exercises the
// identical code paths as a run on the stored one.
//
// Everything lands approved: the caller chose to run on this résumé.

import crypto from 'crypto'
import type { ToolContext } from '@/lib/agents/runtime/types'
import type { ResumeModel } from '../documents/resume-model'
import type { EvidenceBank, ResumeDocument, ResumeParagraphMapEntry } from '../types'
import { importFromResume, type ExtraSourceText, type ImportProposal } from './import'

export interface MemoryBankParams {
  userId: string
  docx: Buffer
  filename: string
  ctx?: ToolContext
  extraSources?: ExtraSourceText[]
  /** Structural rows only (experiences, bullets); no importer call. Tests use this. */
  skipAgent?: boolean
  onStep?: (info: { step: number; elapsedMs: number; stopReason: string | null; toolCalls: string[] }) => void
}

export interface MemoryBankResult {
  bank: EvidenceBank
  proposal: ImportProposal
  model: ResumeModel
  costUsd: number
  /** The importer's failure, when it failed; the structural bank is still returned. */
  agentError: string | null
}

export async function buildMemoryBank(params: MemoryBankParams): Promise<MemoryBankResult> {
  const proposal = await importFromResume(params.userId, params.docx, {
    filename: params.filename,
    extraSources: params.extraSources,
    ctx: params.ctx,
    skipAgent: params.skipAgent,
    onStep: params.onStep,
  })
  if (!proposal.model) throw new Error('importFromResume returned no résumé model')
  const bank = bankFromProposal(params.userId, proposal, { docx: params.docx, filename: params.filename, model: proposal.model })
  return { bank, proposal, model: proposal.model, costUsd: Number((proposal.trace?.cost_usd ?? 0).toFixed(4)), agentError: proposal.agentError }
}

/** Pure: proposal → bank with fresh ids. Mirrors persistProposal's resolution rules. */
export function bankFromProposal(
  userId: string,
  proposal: ImportProposal,
  doc: { docx: Buffer; filename: string; model: ResumeModel }
): EvidenceBank {
  const now = new Date().toISOString()
  const id = (): string => crypto.randomUUID()
  const documentId = id()

  // 1. Experiences by key.
  const experienceId = new Map<string, string>()
  const experiences = proposal.experiences.map((e) => {
    const eid = id()
    experienceId.set(e.key, eid)
    return {
      id: eid, user_id: userId, kind: e.kind, organization: e.organization, title: e.title,
      start_date: e.start_date, end_date: e.end_date, location: e.location, description: e.summary ?? e.description,
      display_order: e.display_order, source: e.source, approved: true, created_at: now, updated_at: now,
    }
  })

  // 2. Facts; fact_refs index into proposal.facts.
  const factIds = proposal.facts.map(() => id())
  const facts = proposal.facts.map((f, i) => ({
    id: factIds[i], user_id: userId, experience_id: experienceId.get(f.experience_key) ?? null, statement: f.statement,
    category: f.category, source: f.source, source_location: f.source_location, confidence: f.confidence,
    approved: true, created_at: now, updated_at: now,
  }))
  const resolve = (refs: number[]) => refs.map((i) => factIds[i]).filter((x): x is string => Boolean(x))

  // 3. Bullets; a bullet cites the facts that cite its paragraph.
  const factsByParagraph = new Map<number, string[]>()
  proposal.facts.forEach((f, i) => {
    if (f.paragraph_index === null) return
    factsByParagraph.set(f.paragraph_index, [...(factsByParagraph.get(f.paragraph_index) ?? []), factIds[i]])
  })
  const bullets = proposal.bullets.map((b) => ({
    id: id(), user_id: userId, resume_document_id: documentId, experience_id: experienceId.get(b.experience_key) ?? null,
    paragraph_index: b.paragraph_index, display_order: b.display_order, text: b.text,
    evidence_fact_ids: factsByParagraph.get(b.paragraph_index) ?? [], source_resume: 'master', is_on_master: true,
    approved: true, created_at: now, updated_at: now,
  }))

  const metrics = proposal.metrics.map((m) => ({
    id: id(), user_id: userId, experience_id: experienceId.get(m.experience_key) ?? null, value: m.value, unit: m.unit,
    context: m.context, fact_ids: resolve(m.fact_refs), source: m.source, approved: true, created_at: now,
  }))
  const deliverables = proposal.deliverables.map((d) => ({
    id: id(), user_id: userId, experience_id: experienceId.get(d.experience_key) ?? null, description: d.description,
    fact_ids: resolve(d.fact_refs), approved: true, created_at: now,
  }))
  const skills = proposal.skills.map((s) => ({
    id: id(), user_id: userId, name: s.name, category: s.category, evidence_fact_ids: resolve(s.fact_refs), approved: true, created_at: now,
  }))

  // 4. The master document, with each bullet paragraph stamped by bullet id.
  const bulletByParagraph = new Map(bullets.map((b) => [b.paragraph_index, b.id]))
  const paragraph_map: ResumeParagraphMapEntry[] = doc.model.map.map((entry) => {
    const bid = bulletByParagraph.get(entry.index)
    return bid ? { ...entry, bullet_id: bid } : { ...entry }
  })
  const masterDocument: ResumeDocument = {
    id: documentId, user_id: userId, label: 'master', is_master: true, filename: doc.filename, storage_path: null,
    sha256: crypto.createHash('sha256').update(doc.docx).digest('hex'), byte_size: doc.docx.length, paragraph_map,
    page_count: 1, uploaded_at: now,
  }

  return { experiences, facts, metrics, deliverables, skills, stories: [], preferences: [], bullets, masterDocument }
}
