// The package view: one JSON the review screen renders.
//
// Everything the human needs to decide is resolved here — fact ids become
// statements, experience ids become labels, contact ids become names, storage
// paths become download URLs — so the UI never has to know a table exists.
// `shapePackageView` is pure over rows (tested); `packageView` loads them.

import { createServiceClient } from '@/lib/supabase/server'
import { experienceLabel } from '../evidence/render'
import { FIT_DIMENSION_LABELS, FIT_DIMENSION_QUESTIONS, fitBand } from '../fit/dimensions'
import { loadJobContext, type JobContext } from '../intelligence/load'
import type {
  Application, ApplicationPackage, CoverLetter, EvidenceBank, FitComponent, FitDimension, FitJudgment, JobEvidenceMap, JobFitEvaluation,
  JobOpportunity, ResumePatch, ResumePatchChange, WarmPath,
} from '../types'
import type { PackageQa } from './orchestrator'
import { getCoverLetter, getPackage, loadResumePatch } from './persist'

export function downloadUrl(storagePath: string | null): string | null {
  return storagePath ? `/api/career/documents/download?path=${encodeURIComponent(storagePath)}` : null
}

export interface DocumentLink {
  path: string
  filename: string
  download_url: string
}

function link(storagePath: string | null, filename: string | null): DocumentLink | null {
  if (!storagePath) return null
  const name = filename ?? storagePath.split('/').pop() ?? 'document'
  return { path: storagePath, filename: name, download_url: downloadUrl(storagePath) as string }
}

export interface PackageViewInput {
  pkg: ApplicationPackage
  job: JobOpportunity
  bank: EvidenceBank
  fit: JobFitEvaluation | null
  evidenceMap: JobEvidenceMap | null
  research: { summary: string | null; facts: { id: string; claim: string; type: string; source_url: string | null }[]; snapshot: Record<string, unknown> | null }
  warmPaths: (WarmPath & { contact?: { name: string; role: string | null; company: string | null } | null })[]
  patch: { patch: ResumePatch; changes: ResumePatchChange[] } | null
  letter: CoverLetter | null
  application: Application | null
}

export function shapePackageView(input: PackageViewInput): Record<string, unknown> {
  const { pkg, job, bank, fit, evidenceMap, research, patch, letter, application } = input
  const factText = new Map(bank.facts.map((f) => [f.id, f.statement]))
  const metricText = new Map(bank.metrics.map((m) => [m.id, [m.value, m.unit, m.context].filter(Boolean).join(' ')]))
  const skillName = new Map(bank.skills.map((s) => [s.id, s.name]))
  const expLabel = new Map(bank.experiences.map((e) => [e.id, experienceLabel(e)]))
  const evidence = (ids: string[]) => ids.map((id) => ({ id, statement: factText.get(id) ?? metricText.get(id) ?? '(not in the approved bank)' }))

  const snapshot = research.snapshot as { why_interesting_for_intern?: { point: string; grounded: boolean }[]; uncertainties?: string[]; summary?: string } | null
  const qa = (pkg.qa as unknown as PackageQa | null) ?? { resume: null, cover_letter: null }
  const judgment = (pkg.fit_snapshot as { judgment?: FitJudgment } | null)?.judgment ?? null
  const components: FitComponent[] = fit?.components ?? judgment?.components ?? []

  return {
    package: {
      id: pkg.id, job_id: pkg.job_id, application_id: pkg.application_id, version: pkg.version, status: pkg.status, stage: pkg.stage,
      cost_usd: Number(pkg.cost_usd ?? 0), error: pkg.error, approved_at: pkg.approved_at, created_at: pkg.created_at, updated_at: pkg.updated_at,
    },
    job: {
      id: job.id, title: job.title, company_name: job.company_name, location_raw: job.location_raw, canonical_url: job.canonical_url,
      apply_url: job.apply_url, verification_status: job.verification_status, deadline: job.deadline, employment_type: job.employment_type,
      season_relevance: job.season_relevance, work_mode: job.work_mode,
    },
    company_research: {
      summary: research.summary ?? snapshot?.summary ?? null,
      grounded_points: (snapshot?.why_interesting_for_intern ?? []).filter((p) => p.grounded).map((p) => p.point),
      facts: research.facts.map((f) => ({ id: f.id, claim: f.claim, type: f.type, source_url: f.source_url })),
      uncertainties: snapshot?.uncertainties ?? [],
    },
    fit: fit || judgment
      ? {
          components: components.map((c) => ({
            dimension: c.dimension, label: FIT_DIMENSION_LABELS[c.dimension as FitDimension] ?? c.dimension,
            question: FIT_DIMENSION_QUESTIONS[c.dimension as FitDimension] ?? '', score: c.score, explanation: c.explanation, evidence: c.evidence,
          })),
          overall: fit ? Number(fit.overall) : null,
          band: fit ? fitBand(Number(fit.overall)) : null,
          feedback_adjustment: fit ? Number(fit.feedback_adjustment) : 0,
          eligibility: fit?.eligibility ?? judgment?.eligibility ?? null,
          eligibility_reasoning: fit?.eligibility_reasoning ?? judgment?.eligibility_reasoning ?? null,
          explanation: fit?.explanation ?? judgment?.explanation ?? null,
          uncertainties: fit?.uncertainties ?? judgment?.uncertainties ?? [],
          red_flags: fit?.red_flags ?? judgment?.red_flags ?? [],
          missing_qualifications: fit?.missing_qualifications ?? judgment?.missing_qualifications ?? [],
          confidence: fit?.confidence ?? judgment?.confidence ?? null,
        }
      : null,
    evidence_map: evidenceMap
      ? {
          why_i_fit: evidenceMap.why_i_fit,
          top_experiences: evidenceMap.top_experience_ids.map((id) => ({ id, label: expLabel.get(id) ?? id })),
          facts: evidence(evidenceMap.fact_ids),
          metrics: evidenceMap.metric_ids.map((id) => ({ id, statement: metricText.get(id) ?? id })),
          skills: evidenceMap.skill_ids.map((id) => ({ id, name: skillName.get(id) ?? id })),
          gaps: evidenceMap.gaps, best_differentiator: evidenceMap.best_differentiator, emphasize: evidenceMap.emphasize, do_not_claim: evidenceMap.do_not_claim,
        }
      : null,
    warm_paths: input.warmPaths.map((w) => ({
      id: w.id, contact_id: w.contact_id, name: w.contact?.name ?? null, title: w.contact?.role ?? null, company: w.contact?.company ?? null,
      relationship: w.relationship, strength: Number(w.strength), why_relevant: w.why_relevant, suggested_action: w.suggested_action,
      existing_history: w.existing_history, retrieval_basis: w.retrieval_basis,
    })),
    resume: patch
      ? {
          patch: { id: patch.patch.id, status: patch.patch.status, no_change_reason: patch.patch.no_change_reason, summary: patch.patch.summary, edit_distance: patch.patch.edit_distance === null ? null : Number(patch.patch.edit_distance) },
          changes: patch.changes.map((c) => ({
            id: c.id, bullet_id: c.bullet_id, experience_id: c.experience_id, experience_label: expLabel.get(c.experience_id) ?? null,
            change_type: c.change_type, edit_level: c.edit_level, original_text: c.original_text, proposed_text: c.proposed_text, final_text: c.final_text,
            reason: c.reason, job_requirement: c.job_requirement, evidence: evidence(c.evidence_fact_ids ?? []), confidence: c.confidence === null ? null : Number(c.confidence),
            verification_result: c.verification_result, verification_notes: c.verification_notes, verification_clauses: c.verification_clauses,
            precheck_findings: c.precheck_findings, review_status: c.review_status, position: c.position,
          })),
        }
      : null,
    cover_letter: letter
      ? {
          id: letter.id, version: letter.version, greeting: letter.greeting, paragraphs: letter.paragraphs, closing: letter.closing, full_text: letter.full_text,
          edited_text: letter.edited_text, word_count: letter.word_count, claims: letter.claims, grounding: letter.grounding, review_status: letter.review_status,
        }
      : null,
    documents: {
      resume_docx: link(pkg.resume_docx_path, pkg.resume_filename),
      resume_pdf: link(pkg.resume_pdf_path, pkg.resume_filename?.replace(/\.docx$/, '.pdf') ?? null),
      cover_docx: link(pkg.cover_docx_path, pkg.cover_filename),
      cover_pdf: link(pkg.cover_pdf_path, pkg.cover_filename?.replace(/\.docx$/, '.pdf') ?? null),
    },
    qa: { resume: qa.resume ?? null, cover_letter: qa.cover_letter ?? null },
    application: application ? { id: application.id, state: application.state, locked: application.locked } : null,
    status: pkg.status,
    stage: pkg.stage,
    cost_usd: Number(pkg.cost_usd ?? 0),
    error: pkg.error,
  }
}

export async function packageView(userId: string, packageId: string): Promise<{ view: Record<string, unknown> | null; error: string | null; migrationMissing: boolean }> {
  const got = await getPackage(userId, packageId)
  if (got.migrationMissing) return { view: null, error: 'migration 014_career_os.sql has not been applied', migrationMissing: true }
  if (!got.pkg) return { view: null, error: 'package not found', migrationMissing: false }
  const pkg = got.pkg

  const loaded = await loadJobContext(userId, pkg.job_id)
  if (!loaded.ctx) return { view: null, error: loaded.error, migrationMissing: loaded.migrationMissing }
  const ctx: JobContext = loaded.ctx

  const [patch, letter, application, contacts] = await Promise.all([
    pkg.resume_patch_id ? loadResumePatch(userId, pkg.resume_patch_id) : Promise.resolve({ patch: null }),
    pkg.cover_letter_id ? getCoverLetter(userId, pkg.cover_letter_id) : Promise.resolve({ letter: null }),
    pkg.application_id ? loadApplication(userId, pkg.application_id) : Promise.resolve(null),
    loadContacts(ctx.existing.warmPaths.map((w) => w.contact_id)),
  ])

  return {
    view: shapePackageView({
      pkg, job: ctx.job, bank: ctx.bank, fit: ctx.existing.fit, evidenceMap: ctx.existing.evidenceMap,
      research: { summary: ctx.existing.research.summary, facts: ctx.existing.research.facts, snapshot: pkg.company_research_snapshot },
      warmPaths: ctx.existing.warmPaths.map((w) => ({ ...w, contact: contacts.get(w.contact_id) ?? null })),
      patch: patch.patch, letter: letter.letter, application,
    }),
    error: null,
    migrationMissing: false,
  }
}

async function loadApplication(userId: string, id: string): Promise<Application | null> {
  const db = createServiceClient()
  const { data } = await db.from('applications').select('*').eq('user_id', userId).eq('id', id).maybeSingle()
  return (data as Application | null) ?? null
}

async function loadContacts(ids: string[]): Promise<Map<string, { name: string; role: string | null; company: string | null }>> {
  const out = new Map<string, { name: string; role: string | null; company: string | null }>()
  if (!ids.length) return out
  const db = createServiceClient()
  const { data } = await db.from('contacts').select('id, name, role, company').in('id', ids)
  for (const c of (data ?? []) as { id: string; name: string; role: string | null; company: string | null }[]) out.set(c.id, { name: c.name, role: c.role, company: c.company })
  return out
}
