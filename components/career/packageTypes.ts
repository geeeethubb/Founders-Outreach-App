// Client-side mirror of PackageViewJSON (lib/career/package/view.ts) and the
// detail route (app/api/career/jobs/[id]). The server resolves ids to text
// before it answers, so these shapes carry statements and labels, never ids
// the UI would have to look up.

import type {
  Application, CoverLetterClaim, DocumentQaReport, JobFeedback, JobOpportunity, JobSource, ReviewStatus, VerifiedClause,
} from '@/lib/career/types'
import type { DocumentSet } from './DocLinks'

export interface FitComponentView {
  dimension: string
  label?: string
  question?: string
  score: number
  explanation: string
  evidence: string[]
}

export interface FitView {
  components: FitComponentView[]
  overall: number | null
  band: string | null
  feedback_adjustment: number
  eligibility: string
  eligibility_reasoning: string | null
  explanation: string | null
  uncertainties: string[]
  red_flags: string[]
  missing_qualifications: string[]
  confidence: number | null
}

export interface EvidenceMapView {
  why_i_fit: string | null
  top_experiences: { id: string; label: string }[]
  facts: { id: string; statement: string }[]
  metrics: { id: string; statement: string }[]
  skills: { id: string; name: string }[]
  gaps: string[]
  best_differentiator: string | null
  emphasize: string[]
  do_not_claim: string[]
}

export interface WarmPathView {
  id: string
  contact_id: string
  name: string | null
  title: string | null
  company: string | null
  relationship: string
  strength: number
  why_relevant: string | null
  suggested_action: string | null
  existing_history: string | null
  retrieval_basis: string[]
}

export interface Finding {
  kind: string
  span: string
  reason: string
  context?: string
}

export interface ChangeView {
  id: string
  bullet_id: string | null
  experience_id: string
  experience_label: string
  change_type: string
  edit_level: number
  original_text: string | null
  proposed_text: string | null
  final_text: string | null
  reason: string
  job_requirement: string
  evidence: { id: string; statement: string }[]
  confidence: number
  verification_result: string
  verification_notes: string | null
  verification_clauses: VerifiedClause[] | null
  precheck_findings: { blocking: Finding[]; warnings: Finding[] } | null
  review_status: ReviewStatus
  position: number
}

export interface ResumeView {
  patch: { id: string; status: string; no_change_reason: string | null; summary: string | null; edit_distance: number | null }
  changes: ChangeView[]
}

export interface LetterGroundingView {
  ok: boolean
  blocking: Finding[]
  warnings: Finding[]
  stats?: Record<string, number>
}

export interface LetterView {
  id: string
  version: number
  greeting: string | null
  paragraphs: string[]
  closing: string | null
  full_text: string | null
  edited_text: string | null
  word_count: number | null
  claims: CoverLetterClaim[]
  grounding: LetterGroundingView | null
  review_status: string
}

export interface PackageView {
  package: {
    id: string
    job_id: string
    application_id: string | null
    version: number
    status: string
    stage: string | null
    cost_usd: number
    error: string | null
    approved_at: string | null
    created_at: string
    updated_at: string
  }
  job: { id: string; title: string; company_name: string; canonical_url: string | null; apply_url: string | null; verification_status: string }
  company_research: {
    summary: string | null
    grounded_points: string[]
    facts: { id: string; claim: string; type: string; source_url: string | null }[]
    uncertainties: string[]
  } | null
  fit: FitView | null
  evidence_map: EvidenceMapView | null
  warm_paths: WarmPathView[]
  resume: ResumeView | null
  cover_letter: LetterView | null
  documents: DocumentSet
  qa: { resume: DocumentQaReport | null; cover_letter: DocumentQaReport | null }
  application: { id: string; state: string; locked: boolean } | null
  status: string
  stage: string | null
  cost_usd: number
  error: string | null
}

export interface PackageSummary {
  id: string
  version: number
  status: string
  stage: string | null
  resume_filename: string | null
  cover_filename: string | null
  resume_docx_path: string | null
  resume_pdf_path: string | null
  cover_docx_path: string | null
  cover_pdf_path: string | null
  qa: unknown
  error: string | null
  created_at: string
  updated_at: string
}

/** The bare rows GET /api/career/jobs/[id] returns. */
export interface JobDetail {
  job: JobOpportunity
  sources: JobSource[]
  snapshot: { captured_at: string; description_text: string | null } | null
  fit: (Omit<FitView, 'components'> & { components: FitComponentView[]; computed_at?: string }) | null
  evidence_map: {
    why_i_fit: string | null
    top_experience_ids: string[]
    fact_ids: string[]
    metric_ids: string[]
    skill_ids: string[]
    gaps: string[]
    best_differentiator: string | null
    emphasize: string[]
    do_not_claim: string[]
  } | null
  warm_paths: {
    id: string
    contact_id: string
    relationship: string
    strength: number
    why_relevant: string | null
    existing_history: string | null
    suggested_action: string | null
    retrieval_basis: string[]
    contact: { id: string; name: string; title: string | null; company: string | null; email: string | null; linkedin_url: string | null } | null
  }[]
  feedback: JobFeedback[]
  application: Application | null
  packages: PackageSummary[]
}

/** What POST /api/career/jobs/[id]/intelligence answers. Research here is a summary only; the package view carries the full research. */
export interface IntelligenceResponse {
  job_id: string
  research: { summary: string; company_type: string; industry_tags: string[]; claims: number; from_cache: boolean } | null
  fit: FitView | null
  costUsd: number
  errors: string[]
  run_id: string | null
}

export const EDIT_LEVEL_MEANING: Record<number, string> = {
  0: 'Level 0 — no change',
  1: 'Level 1 — reorder existing material',
  2: 'Level 2 — minor wording / emphasis change',
  3: 'Level 3 — swap to another approved accomplishment',
  4: 'Level 4 — new bullet built exclusively from strongly supported evidence',
}
