// Career OS — shared domain types.
//
// These mirror supabase/migrations/014_career_os.sql row for row, plus the
// contracts that flow between modules. Every module under lib/career/ and
// every Career OS agent imports from here rather than redeclaring shapes, so a
// column rename is one edit.
//
// See docs/CAREER_OS.md for the architecture these types serve.

// ─── Missions ────────────────────────────────────────────────────────────────

export type CareerSeason = 'summer_2027' | 'winter_2026_27' | 'fall_2026' | 'spring_2027' | 'other'

export interface GeoTier {
  tier: 1 | 2 | 3
  /** Free-text locations as the user wrote them: "San Francisco / Bay Area", "New York City". */
  locations: string[]
  /** e.g. "other large, vibrant East or West Coast cities" — the planner interprets it. */
  description?: string
}

export interface CareerMissionPreferences {
  geo_tiers: GeoTier[]
  /** "high-quality startups", "growth-stage technology companies", "energy / oil & gas", … */
  company_types: string[]
  /** Optional seeds; the planner INFERS role families from the Evidence Bank when empty. */
  role_families: string[]
  industries: string[]
  /** "learning", "ownership", "intelligent colleagues", … in priority order. */
  optimize_for: string[]
  work_modes: ('remote' | 'hybrid' | 'onsite')[]
  /** Free text the planner and fit evaluator read verbatim. */
  notes?: string
  /**
   * What the user wants to scout for, in their own words — industries, roles,
   * a pivot ("life sciences / genomics research; my chemical engineering
   * background transfers"). Leads the planner; the evidence explains why the
   * person is credible for it. Empty → the planner infers from the evidence.
   */
  direction?: string | null
}

export interface HardConstraint {
  dimension: string           // 'employment_type' | 'season' | 'location_country' | 'graduation_window' | …
  operator: 'equals' | 'not_equals' | 'in' | 'not_in' | 'contains' | 'before' | 'after'
  value: string | string[]
  label: string
}

export interface CareerMission {
  id: string
  user_id: string
  name: string
  objective: string
  season: CareerSeason | string
  preferences: CareerMissionPreferences
  hard_constraints: HardConstraint[]
  fit_weights: Partial<FitWeights> | null
  status: 'draft' | 'active' | 'paused' | 'archived'
  created_at: string
  updated_at: string
}

// ─── Personal Evidence Bank ──────────────────────────────────────────────────

export type ExperienceKind = 'experience' | 'project' | 'leadership' | 'research' | 'education' | 'award' | 'other'

export interface EvidenceExperience {
  id: string
  user_id: string
  kind: ExperienceKind
  organization: string
  title: string
  start_date: string | null
  end_date: string | null
  location: string | null
  description: string | null
  display_order: number
  source: string
  approved: boolean
  created_at: string
  updated_at: string
  // 015_evidence_canonical — optional so pre-015 rows and fixtures still type-check.
  organization_id?: string | null
  organization_norm?: string | null
  title_norm?: string | null
  canonical_summary?: string | null
  summary_fact_ids?: string[]
  merge_status?: MergeStatus
  status?: RowStatus
  merged_into?: string | null
  edited_by_user?: boolean
  source_count?: number
}

/** 'active' rows are read; 'merged' rows are tombstones pointing at `merged_into`. */
export type RowStatus = 'active' | 'merged'

/** Confidence in a canonical row, from how many independent sources agree. */
export type MergeStatus = 'VERIFIED' | 'CORROBORATED' | 'CONFLICTING' | 'NEEDS_REVIEW'

export type FactCategory =
  | 'responsibility' | 'achievement' | 'metric' | 'skill' | 'tool'
  | 'context' | 'award' | 'education' | 'scope' | 'other'

export type FactSource =
  | 'master_resume' | 'alternate_resume' | 'linkedin' | 'profile'
  | 'outreach' | 'project_notes' | 'story' | 'manual'

export interface EvidenceFact {
  id: string
  user_id: string
  experience_id: string | null
  statement: string
  category: FactCategory
  source: FactSource
  source_location: string | null
  confidence: number
  approved: boolean
  created_at: string
  updated_at: string
  // 015_evidence_canonical
  status?: RowStatus
  merged_into?: string | null
  project_id?: string | null
  statement_norm?: string | null
  edited_by_user?: boolean
  support_count?: number
  fact_status?: MergeStatus
}

export interface EvidenceMetric {
  id: string
  user_id: string
  experience_id: string | null
  value: string
  unit: string | null
  context: string | null
  fact_ids: string[]
  source: string
  approved: boolean
  created_at: string
  status?: RowStatus
  merged_into?: string | null
  value_norm?: string | null
}

export interface EvidenceDeliverable {
  id: string
  user_id: string
  experience_id: string | null
  description: string
  fact_ids: string[]
  approved: boolean
  created_at: string
  status?: RowStatus
  merged_into?: string | null
}

export type SkillCategory = 'technical' | 'tool' | 'domain' | 'business' | 'language' | 'other'

export interface EvidenceSkill {
  id: string
  user_id: string
  name: string
  category: SkillCategory
  evidence_fact_ids: string[]
  approved: boolean
  created_at: string
}

export interface EvidenceStory {
  id: string
  user_id: string
  experience_id: string | null
  title: string
  situation: string | null
  task: string | null
  actions: string | null
  result: string | null
  learning: string | null
  evidence_fact_ids: string[]
  approved: boolean
  created_at: string
  updated_at: string
}

export interface EvidencePreference {
  id: string
  user_id: string
  category: string
  value: string
  weight: number
  hard_constraint: boolean
  note: string | null
  created_at: string
}

export type ResumeParagraphKind =
  | 'name' | 'contact' | 'headline' | 'section' | 'exp_title' | 'exp_org' | 'bullet' | 'text'

/** One entry per body paragraph of a résumé DOCX, in document order. */
export interface ResumeParagraphMapEntry {
  index: number
  kind: ResumeParagraphKind
  text: string
  /** Stable key for the experience this paragraph belongs to, e.g. "png-qa-intern". */
  experience_key?: string
  bullet_id?: string
}

export interface ResumeDocument {
  id: string
  user_id: string
  label: string
  is_master: boolean
  filename: string
  storage_path: string | null
  sha256: string
  byte_size: number | null
  paragraph_map: ResumeParagraphMapEntry[]
  page_count: number | null
  uploaded_at: string
}

export interface ResumeBullet {
  id: string
  user_id: string
  resume_document_id: string | null
  experience_id: string | null
  paragraph_index: number | null
  display_order: number
  /** Plain text. `**bold**` marks emphasis spans the document engine renders as bold runs. */
  text: string
  evidence_fact_ids: string[]
  source_resume: string
  is_on_master: boolean
  approved: boolean
  created_at: string
  updated_at: string
}

/** Everything the bank holds for one user, loaded once per run. */
export interface EvidenceBank {
  experiences: EvidenceExperience[]
  facts: EvidenceFact[]
  metrics: EvidenceMetric[]
  deliverables: EvidenceDeliverable[]
  skills: EvidenceSkill[]
  stories: EvidenceStory[]
  preferences: EvidencePreference[]
  bullets: ResumeBullet[]
  /** 015 entities. Empty arrays when migration 015 is not applied. */
  organizations: EvidenceOrganization[]
  sources: EvidenceSource[]
  factSources: EvidenceFactSource[]
  projects: EvidenceProject[]
  /** Experience ↔ source provenance (015). Optional so in-memory fixtures need not supply it. */
  experienceSources?: EvidenceExperienceSource[]
  masterDocument: ResumeDocument | null
}

// ─── Companies (extension of the existing `companies` row) ───────────────────

/**
 * What the user wants from a company — INTENT, never state (migration 016).
 *
 *   target     the user said they want to work here   (only a user sets this)
 *   watching   the user said keep an eye on it        (only a user sets this)
 *   suggested  the scout thinks it may be worth a look — a hypothesis
 *   ignored    the user said no
 *
 * Whether a company has an opening right now is `open_roles_count` +
 * `last_careers_check_at`. Resolve any stored value through
 * `lib/career/companies/intent.ts` rather than comparing strings.
 */
export type CompanyIntent = 'target' | 'watching' | 'suggested' | 'ignored'

/** Stored `companies.watch_status`. Includes the pre-016 'opening_available', which readers map to 'watching'. */
export type WatchStatus = CompanyIntent | 'opening_available'

/** Who put a company on the list. `watch_source` says who last set the status; this says where it came from. */
export type WatchOrigin = 'user' | 'planner' | 'scout' | 'outreach' | 'import'

export interface CompanyCareersExtension {
  careers_url: string | null
  ats_type: AtsType | null
  ats_identifier: string | null
  watch_status: WatchStatus | null
  watch_priority: number | null
  watch_note: string | null
  watch_source: 'planner' | 'user' | 'scout' | null
  /** 016. How the company first entered the list; drives the "suggested by Scout" badge. */
  watch_origin?: WatchOrigin | null
  /** 016. When the current status was set — how "the user changed it after discovery" is knowable. */
  watch_status_at?: string | null
  /** 016. Openings found at the last check. State, not preference. */
  open_roles_count?: number
  last_careers_check_at: string | null
  careers_check_note: string | null
  company_type: string | null
  industry_tags: string[]
  research_summary: string | null
  research_version: string | null
  researched_at: string | null
}

// ─── Jobs ────────────────────────────────────────────────────────────────────

export type AtsType = 'greenhouse' | 'lever' | 'ashby' | 'smartrecruiters' | 'workable' | 'other'

export type JobSourceType =
  | 'greenhouse' | 'lever' | 'ashby' | 'smartrecruiters' | 'workable'
  | 'careers_page' | 'web_search' | 'manual' | 'aggregator'

export type WorkMode = 'remote' | 'hybrid' | 'onsite' | 'unknown'
export type EmploymentType = 'internship' | 'co_op' | 'full_time' | 'part_time' | 'contract' | 'other' | 'unknown'
export type SeasonRelevance = 'summer_2027' | 'other_season' | 'unspecified' | 'unknown'

export type VerificationStatus = 'UNVERIFIED' | 'VERIFIED_OPEN' | 'LIKELY_OPEN' | 'STALE' | 'CLOSED' | 'ERROR'
export const VERIFICATION_STATUSES: VerificationStatus[] = [
  'UNVERIFIED', 'VERIFIED_OPEN', 'LIKELY_OPEN', 'STALE', 'CLOSED', 'ERROR',
]

export type JobDisposition = 'new' | 'saved' | 'dismissed'

export interface JobOpportunity {
  id: string
  user_id: string
  company_id: string | null
  company_name: string
  mission_id: string | null

  title: string
  role_family: string | null
  description_text: string | null
  description_html: string | null

  location_raw: string | null
  location_city: string | null
  location_state: string | null
  location_country: string | null
  location_tier: number | null
  work_mode: WorkMode
  employment_type: EmploymentType
  season_relevance: SeasonRelevance

  posted_at: string | null
  source_updated_at: string | null
  deadline: string | null

  canonical_url: string | null
  apply_url: string | null
  ats_type: string | null
  ats_job_id: string | null
  requisition_id: string | null

  compensation: string | null
  min_qualifications: string[]
  preferred_qualifications: string[]
  graduation_eligibility: string | null
  work_authorization: string | null
  skills: string[]
  responsibilities: string[]
  industry: string | null
  company_size_stage: string | null
  extraction_version: string | null
  extraction_confidence: number | null

  verification_status: VerificationStatus
  last_verified_at: string | null
  verification_note: string | null
  verification_method: string | null

  confidence: number | null
  duplicate_cluster_id: string | null
  is_canonical: boolean

  fit_overall: number | null
  fit_eligibility: Eligibility | null
  fit_computed_at: string | null

  disposition: JobDisposition
  first_seen_at: string
  last_seen_at: string
  discovery_run_id: string | null
  created_at: string
  updated_at: string
}

export interface JobSource {
  id: string
  job_id: string
  source_type: JobSourceType
  source_url: string | null
  external_id: string | null
  raw: Record<string, unknown> | null
  run_id: string | null
  discovered_at: string
}

export interface JobSnapshot {
  id: string
  job_id: string
  captured_at: string
  title: string | null
  company_name: string | null
  location_raw: string | null
  canonical_url: string | null
  description_text: string | null
  structured: Record<string, unknown> | null
  sha256: string | null
}

/**
 * What the Job Extractor produces from raw posting text. Deterministic code
 * folds it onto the JobOpportunity row. Everything optional except the
 * classification fields, which must always be answered — `unknown` is an answer.
 */
export interface ExtractedJobFields {
  employment_type: EmploymentType
  season_relevance: SeasonRelevance
  work_mode: WorkMode
  role_family: string | null
  location_raw: string | null
  deadline: string | null
  compensation: string | null
  min_qualifications: string[]
  preferred_qualifications: string[]
  graduation_eligibility: string | null
  work_authorization: string | null
  skills: string[]
  responsibilities: string[]
  industry: string | null
  /** True when the text says the role is filled / closed / no longer accepting. */
  appears_closed: boolean
  confidence: number
}

// ─── Fit ─────────────────────────────────────────────────────────────────────

export type FitDimension =
  | 'role_fit'
  | 'learning_upside'
  | 'ownership'
  | 'company_quality'
  | 'mission_interest_fit'
  | 'location_fit'
  | 'career_optionality'
  | 'people_mentorship'
  | 'differentiation'
  | 'application_urgency'

export const FIT_DIMENSIONS: FitDimension[] = [
  'role_fit',
  'learning_upside',
  'ownership',
  'company_quality',
  'mission_interest_fit',
  'location_fit',
  'career_optionality',
  'people_mentorship',
  'differentiation',
  'application_urgency',
]

export type FitWeights = Record<FitDimension, number>

export type Eligibility = 'QUALIFIED' | 'STRETCH' | 'NOT_QUALIFIED' | 'UNKNOWN'

export interface FitComponent {
  dimension: FitDimension
  score: number          // 0–1 from the agent
  explanation: string
  evidence: string[]
}

/** The Fit Evaluator's output. No total — code computes it (ADR-004). */
export interface FitJudgment {
  components: FitComponent[]
  eligibility: Eligibility
  eligibility_reasoning: string
  explanation: string
  uncertainties: string[]
  red_flags: string[]
  missing_qualifications: string[]
  confidence: number
}

export interface JobFitEvaluation {
  id: string
  user_id: string
  job_id: string
  mission_id: string | null
  components: FitComponent[]
  weights_used: FitWeights
  overall: number
  feedback_adjustment: number
  eligibility: Eligibility
  eligibility_reasoning: string | null
  explanation: string | null
  uncertainties: string[]
  red_flags: string[]
  missing_qualifications: string[]
  confidence: number | null
  prompt_version: string | null
  agent_run_id: string | null
  computed_at: string
}

// ─── Evidence map (personal matching) ────────────────────────────────────────

export interface JobEvidenceMap {
  id: string
  user_id: string
  job_id: string
  why_i_fit: string | null
  top_experience_ids: string[]
  fact_ids: string[]
  metric_ids: string[]
  skill_ids: string[]
  story_ids: string[]
  gaps: string[]
  best_differentiator: string | null
  emphasize: string[]
  do_not_claim: string[]
  prompt_version: string | null
  agent_run_id: string | null
  created_at: string
}

// ─── Warm paths ──────────────────────────────────────────────────────────────

export type WarmPathRelationship =
  | 'current_employee' | 'former_employee' | 'alumni' | 'founder' | 'investor'
  | 'mentor' | 'prior_outreach' | 'second_degree' | 'portfolio' | 'other'

export interface WarmPath {
  id: string
  user_id: string
  job_id: string | null
  company_id: string | null
  contact_id: string
  relationship: WarmPathRelationship
  strength: number
  why_relevant: string | null
  existing_history: string | null
  suggested_action: string | null
  retrieval_basis: string[]
  agent_run_id: string | null
  created_at: string
}

// ─── Feedback ────────────────────────────────────────────────────────────────

export type FeedbackVerdict = 'LOVE' | 'INTERESTED' | 'MAYBE' | 'NOT_INTERESTED'

export const FEEDBACK_REASONS = [
  'location', 'role', 'industry', 'company', 'work_type', 'growth', 'culture',
  'compensation', 'brand', 'too_corporate', 'too_narrow', 'too_software_heavy',
  'too_operations_heavy', 'not_technical_enough', 'eligibility', 'timing', 'other',
] as const
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number]

export interface JobFeedback {
  id: string
  user_id: string
  job_id: string
  verdict: FeedbackVerdict
  reasons: FeedbackReason[]
  note: string | null
  created_at: string
}

// ─── Applications ────────────────────────────────────────────────────────────

export type ApplicationState =
  | 'DISCOVERED' | 'SAVED' | 'RESEARCHED' | 'PREPARING' | 'READY_FOR_REVIEW'
  | 'READY_TO_APPLY' | 'APPLIED' | 'OA' | 'INTERVIEW' | 'FINAL_ROUND' | 'OFFER'
  | 'REJECTED' | 'WITHDRAWN' | 'CLOSED'

export const APPLICATION_STATES: ApplicationState[] = [
  'DISCOVERED', 'SAVED', 'RESEARCHED', 'PREPARING', 'READY_FOR_REVIEW',
  'READY_TO_APPLY', 'APPLIED', 'OA', 'INTERVIEW', 'FINAL_ROUND', 'OFFER',
  'REJECTED', 'WITHDRAWN', 'CLOSED',
]

export interface InterviewEntry {
  stage: string
  at: string | null
  notes: string | null
}

export interface Application {
  id: string
  user_id: string
  job_id: string
  company_id: string | null
  state: ApplicationState
  job_snapshot_id: string | null
  current_package_id: string | null
  submitted_package_id: string | null
  applied_at: string | null
  submitted_resume_path: string | null
  submitted_cover_letter_path: string | null
  contacts_used: string[]
  notes: string | null
  interviews: InterviewEntry[]
  outcome: string | null
  outcome_at: string | null
  outcome_note: string | null
  locked: boolean
  created_at: string
  updated_at: string
}

export type PackageStatus =
  | 'generating' | 'resume_review' | 'ready_for_review' | 'ready_to_apply'
  | 'failed' | 'superseded' | 'locked'

export interface ApplicationPackage {
  id: string
  user_id: string
  job_id: string
  application_id: string | null
  version: number
  status: PackageStatus
  stage: string | null
  run_id: string | null
  resume_patch_id: string | null
  cover_letter_id: string | null
  resume_docx_path: string | null
  resume_pdf_path: string | null
  cover_docx_path: string | null
  cover_pdf_path: string | null
  resume_filename: string | null
  cover_filename: string | null
  qa: DocumentQaReport | null
  company_research_snapshot: Record<string, unknown> | null
  fit_snapshot: Record<string, unknown> | null
  evidence_map_snapshot: Record<string, unknown> | null
  warm_paths_snapshot: Record<string, unknown> | null
  job_snapshot_id: string | null
  cost_usd: number
  error: string | null
  approved_at: string | null
  created_at: string
  updated_at: string
}

// ─── Résumé tailoring ────────────────────────────────────────────────────────

/**
 * 0  no change
 * 1  reorder existing material
 * 2  minor wording / emphasis change
 * 3  swap to another approved accomplishment
 * 4  new bullet built exclusively from strongly supported evidence
 */
export type EditLevel = 0 | 1 | 2 | 3 | 4

export type ChangeType = 'keep' | 'reorder' | 'reword' | 'swap' | 'new' | 'remove'

export type VerificationResult = 'SUPPORTED' | 'UNSUPPORTED' | 'UNCERTAIN' | 'NOT_CHECKED' | 'SKIPPED'

export type ClauseVerdict = 'SUPPORTED' | 'UNSUPPORTED' | 'UNCERTAIN'

export interface VerifiedClause {
  clause: string
  verdict: ClauseVerdict
  fact_ids: string[]
  note: string
}

export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'edited' | 'auto_rejected'

/** What the Resume Tailor proposes for one bullet, before verification. */
export interface ProposedChange {
  bullet_id: string | null
  experience_id: string
  change_type: ChangeType
  edit_level: EditLevel
  original_text: string | null
  proposed_text: string | null
  source_bullet_id: string | null
  position: number
  reason: string
  job_requirement: string
  evidence_fact_ids: string[]
  confidence: number
}

export interface ResumePatchChange extends ProposedChange {
  id: string
  patch_id: string
  verification_result: VerificationResult
  verification_notes: string | null
  verification_clauses: VerifiedClause[] | null
  precheck_findings: Record<string, unknown> | null
  review_status: ReviewStatus
  final_text: string | null
  created_at: string
  updated_at: string
}

export interface ResumePatch {
  id: string
  user_id: string
  job_id: string
  package_id: string | null
  base_resume_document_id: string | null
  status: 'proposed' | 'reviewed' | 'applied' | 'superseded'
  no_change_reason: string | null
  summary: string | null
  edit_distance: number | null
  tailor_version: string | null
  verifier_version: string | null
  agent_run_id: string | null
  created_at: string
  updated_at: string
}

// ─── Cover letters ───────────────────────────────────────────────────────────

export interface CoverLetterClaim {
  claim_text: string
  kind: 'company' | 'personal'
  research_fact_id?: string | null
  evidence_fact_id?: string | null
}

export interface CoverLetter {
  id: string
  user_id: string
  job_id: string
  package_id: string | null
  version: number
  greeting: string | null
  paragraphs: string[]
  closing: string | null
  full_text: string | null
  edited_text: string | null
  word_count: number | null
  claims: CoverLetterClaim[]
  grounding: Record<string, unknown> | null
  review_status: 'pending' | 'approved' | 'rejected' | 'edited'
  prompt_version: string | null
  agent_run_id: string | null
  created_at: string
  updated_at: string
}

// ─── Document QA ─────────────────────────────────────────────────────────────

export interface DocumentQaCheck {
  name: string
  pass: boolean
  detail: string
  /** Blocking checks stop a package from becoming READY_FOR_REVIEW. */
  blocking: boolean
}

export interface DocumentQaReport {
  ok: boolean
  document: 'resume' | 'cover_letter'
  docx_path: string | null
  pdf_path: string | null
  page_count: number | null
  expected_pages: number | null
  renderer: string | null
  checks: DocumentQaCheck[]
  warnings: string[]
  /** Set when the page-count fix loop ran. */
  shrink_attempts?: number
}

// ---------------------------------------------------------------------------
// 015_evidence_canonical — organizations, sources, provenance, projects,
// merge suggestions, conflicts, snapshots.
// ---------------------------------------------------------------------------

export type OrganizationKind = 'company' | 'university' | 'lab' | 'student_org' | 'program' | 'other'

export interface EvidenceOrganization {
  id: string
  user_id: string
  canonical_name: string
  normalized_name: string
  aliases: string[]
  kind: OrganizationKind
  company_id: string | null
  created_at: string
  updated_at: string
}

export type SourceKind =
  | 'resume' | 'linkedin_profile' | 'linkedin_post' | 'pasted_context'
  | 'notes' | 'profile_field' | 'other'

/** A thing the user gave us. Not knowledge — facts point at it. */
export interface EvidenceSource {
  id: string
  user_id: string
  kind: SourceKind
  label: string
  sha256: string | null
  content: string | null
  storage_path: string | null
  resume_document_id: string | null
  metadata: Record<string, unknown>
  imported_at: string
}

export interface EvidenceFactSource {
  id: string
  user_id: string
  fact_id: string
  source_id: string
  location: string | null
  quote: string | null
  confidence: number
  created_at: string
}

export interface EvidenceExperienceSource {
  id: string
  user_id: string
  experience_id: string
  source_id: string
  location: string | null
  title_as_written: string | null
  dates_as_written: string | null
  created_at: string
}

export interface EvidenceProject {
  id: string
  user_id: string
  experience_id: string | null
  organization_id: string | null
  name: string
  name_norm: string
  description: string | null
  fact_ids: string[]
  approved: boolean
  status: RowStatus
  merged_into: string | null
  created_at: string
  updated_at: string
}

export type MergeConfidence = 'HIGH' | 'POSSIBLE' | 'CONFLICT'
export type MergeEntityType = 'experience' | 'fact' | 'metric' | 'project'
export type MergeSuggestionStatus = 'open' | 'merged' | 'kept_separate' | 'stale'

export interface EvidenceMergeSuggestion {
  id: string
  user_id: string
  entity_type: MergeEntityType
  keep_id: string
  merge_id: string
  confidence: MergeConfidence
  rule: string | null
  signals: Record<string, unknown>
  why: string | null
  data_preserved: string | null
  risk: string | null
  status: MergeSuggestionStatus
  created_at: string
  resolved_at: string | null
}

export interface ConflictCandidate {
  value: string
  source_id: string | null
  source_label: string
}

export interface EvidenceConflict {
  id: string
  user_id: string
  entity_type: 'experience' | 'fact' | 'metric'
  entity_id: string
  /** Human name for entity_id, resolved by the review route (experience "title — org", fact statement, metric "value context"). Null when the row is gone. */
  entity_label?: string | null
  field: string
  candidates: ConflictCandidate[]
  status: 'open' | 'resolved'
  resolution: string | null
  created_at: string
  resolved_at: string | null
}
