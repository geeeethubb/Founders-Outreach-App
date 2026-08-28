// Loading everything the intelligence stages read, in one place.
//
// The orchestrator is a sequence of agents; this file is the sequence of
// queries that feed them. Nothing here judges: it loads a job with its
// company, the approved Evidence Bank, the active mission and whatever prior
// intelligence is stored, then projects the job into the shapes the agents
// take (`FitJobInput`, `CompanyResearcherInput`, `RetrievalJob`).
//
// DEGRADES: every read reports `migrationMissing` when 014 is absent.

import { createServiceClient } from '@/lib/supabase/server'
import type { CompanyResearch, CompanyResearcherInput } from '@/lib/agents/company-researcher'
import type { FitJobInput } from '@/lib/agents/fit-evaluator'
import type { ResearchClaim } from '@/lib/research/types'
import { isMissingSchema, loadEvidenceBank } from '../evidence/store'
import { ensureDefaultMission } from '../missions/store'
import { getJob } from '../jobs/store'
import type { FeedbackRow } from '../fit/feedback'
import type {
  CareerMission,
  CompanyCareersExtension,
  EvidenceBank,
  JobEvidenceMap,
  JobFitEvaluation,
  JobOpportunity,
  JobSnapshot,
  WarmPath,
} from '../types'

export const DESCRIPTION_EXCERPT_MAX = 3000

/** The `companies` row as the career layer reads it: identity plus the 014 extension columns. */
export interface CompanyRow extends Partial<CompanyCareersExtension> {
  id: string
  name: string
  domain: string | null
  website_url?: string | null
  normalized_name?: string | null
}

export interface StoredResearchFact {
  id: string
  claim: string
  type: 'FACT' | 'INFERENCE' | 'UNKNOWN'
  source_url: string | null
  source_title: string | null
  confidence: number | null
  relevance: string | null
  created_at: string
}

export interface JobContext {
  job: JobOpportunity
  company: CompanyRow | null
  mission: CareerMission
  /** Approved rows only. */
  bank: EvidenceBank
  existing: {
    fit: JobFitEvaluation | null
    evidenceMap: JobEvidenceMap | null
    research: { summary: string | null; facts: StoredResearchFact[] }
    warmPaths: WarmPath[]
    latestSnapshot: JobSnapshot | null
  }
  errors: string[]
}

export type LoadJobContextResult =
  | { ctx: JobContext; error: null; migrationMissing: false }
  | { ctx: null; error: string; migrationMissing: boolean }

export async function loadJobContext(userId: string, jobId: string): Promise<LoadJobContextResult> {
  const errors: string[] = []
  const got = await getJob(userId, jobId)
  if (got.migrationMissing) return { ctx: null, error: 'migration 014_career_os.sql has not been applied', migrationMissing: true }
  if (got.error) return { ctx: null, error: got.error, migrationMissing: false }
  if (!got.job) return { ctx: null, error: 'job not found', migrationMissing: false }

  const raw = got.job
  const job = raw as unknown as JobOpportunity
  const fits = (raw.fit as JobFitEvaluation[] | undefined) ?? []
  const maps = (raw.evidence_map as JobEvidenceMap[] | undefined) ?? []
  const warmPaths = (raw.warm_paths as WarmPath[] | undefined) ?? []
  const latestSnapshot = (raw.latest_snapshot as JobSnapshot | null | undefined) ?? null

  const [bankRes, missionRes, company] = await Promise.all([
    loadEvidenceBank(userId, { approvedOnly: true }),
    ensureDefaultMission(userId),
    loadCompany(job.company_id),
  ])
  if (bankRes.migrationMissing) return { ctx: null, error: 'migration 014_career_os.sql has not been applied', migrationMissing: true }
  errors.push(...bankRes.errors)
  if (!missionRes.mission) return { ctx: null, error: missionRes.error ?? 'no mission', migrationMissing: false }

  const facts = company ? await loadResearchFacts(userId, company.id) : []

  // Prefer the evaluation for the active mission; fall back to any.
  const fit = fits.find((f) => f.mission_id === missionRes.mission?.id) ?? fits[0] ?? null

  return {
    ctx: {
      job,
      company,
      mission: missionRes.mission,
      bank: bankRes.bank,
      existing: {
        fit,
        evidenceMap: maps[0] ?? null,
        research: { summary: company?.research_summary ?? null, facts },
        warmPaths,
        latestSnapshot,
      },
      errors,
    },
    error: null,
    migrationMissing: false,
  }
}

export async function loadCompany(companyId: string | null | undefined): Promise<CompanyRow | null> {
  if (!companyId) return null
  const db = createServiceClient()
  const { data } = await db.from('companies').select('*').eq('id', companyId).maybeSingle()
  return (data as CompanyRow | null) ?? null
}

export async function loadResearchFacts(userId: string, companyId: string): Promise<StoredResearchFact[]> {
  const db = createServiceClient()
  const { data } = await db
    .from('research_facts')
    .select('id, claim, type, source_url, source_title, confidence, relevance, created_at')
    .eq('user_id', userId)
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(60)
  return (data ?? []) as StoredResearchFact[]
}

// ─── Projections ─────────────────────────────────────────────────────────────

/** The job as the Fit Evaluator and the Evidence Matcher see it. */
export function fitJobInputFrom(job: JobOpportunity): FitJobInput {
  return {
    title: job.title,
    company: job.company_name,
    location_raw: job.location_raw,
    location_tier: job.location_tier,
    work_mode: String(job.work_mode ?? 'unknown'),
    employment_type: String(job.employment_type ?? 'unknown'),
    season_relevance: String(job.season_relevance ?? 'unknown'),
    posted_at: job.posted_at,
    deadline: job.deadline,
    description_excerpt: (job.description_text ?? '').slice(0, DESCRIPTION_EXCERPT_MAX),
    min_qualifications: job.min_qualifications ?? [],
    preferred_qualifications: job.preferred_qualifications ?? [],
    graduation_eligibility: job.graduation_eligibility,
    work_authorization: job.work_authorization,
    skills: job.skills ?? [],
    responsibilities: job.responsibilities ?? [],
    industry: job.industry,
    company_size_stage: job.company_size_stage,
  }
}

/** What the researcher is told before it searches. The posting's own words about the company are the seed. */
export function researchInputFrom(job: JobOpportunity, company: CompanyRow | null, mission: Pick<CareerMission, 'preferences'>): CompanyResearcherInput {
  const known: string[] = []
  if (job.industry) known.push(`Industry per posting: ${job.industry}.`)
  if (job.company_size_stage) known.push(`Size/stage per posting: ${job.company_size_stage}.`)
  if (company?.company_type) known.push(`Type on file: ${company.company_type}.`)
  const desc = (job.description_text ?? '').slice(0, 600).replace(/\s+/g, ' ').trim()
  if (desc) known.push(`Posting opens: "${desc}"`)
  return {
    company: {
      name: job.company_name,
      domain: company?.domain ?? null,
      careers_url: company?.careers_url ?? null,
      what_we_know: known.join(' '),
    },
    job_title: job.title,
    mission_interests: `${mission.preferences.optimize_for.join(' > ')} · ${mission.preferences.company_types.join(', ')}`,
    depth: 'standard',
  }
}

/**
 * Stored research, re-shaped so the same renderers serve a fresh result and
 * a month-old one. Points are not reconstructed — a stored FACT is the unit
 * the letter cites, by research_facts row id.
 */
export function researchFromStored(summary: string | null, company: CompanyRow | null, facts: StoredResearchFact[]): CompanyResearch | null {
  if (!summary && facts.length === 0) return null
  const claims: ResearchClaim[] = facts.map((f) => ({
    claim: f.claim,
    type: f.type,
    source_url: f.source_url,
    source_title: f.source_title,
    confidence: f.confidence ?? 0.5,
    relevance: f.relevance ?? null,
  }))
  return {
    what_they_do: summary ?? '',
    company_type: (company?.company_type as CompanyResearch['company_type']) ?? 'other',
    industry_tags: company?.industry_tags ?? [],
    size_stage: null,
    why_interesting_for_intern: facts
      .filter((f) => f.type === 'FACT' && f.source_url)
      .slice(0, 6)
      .map((f) => ({ point: f.claim, claim_refs: [facts.indexOf(f)], grounded: true })),
    technical_challenges: [],
    recent_developments: [],
    intern_program_signals: [],
    leadership: [],
    claims,
    uncertainties: [],
    summary: summary ?? '',
    downgraded_claims: 0,
    ungrounded_points: 0,
  }
}

/** Letter-citable points from stored facts: FACT rows with a URL, by row id. */
export function letterPointsFromFacts(facts: StoredResearchFact[], max = 8): { id: string; text: string }[] {
  return facts
    .filter((f) => f.type === 'FACT' && f.source_url)
    .slice(0, max)
    .map((f) => ({ id: f.id, text: f.claim }))
}

// ─── Feedback rows ───────────────────────────────────────────────────────────

/** job_feedback joined with the attributes computeFeedbackAdjustment compares on. */
export async function loadFeedbackRows(
  userId: string,
  opts: { limit?: number } = {}
): Promise<{ rows: FeedbackRow[]; error: string | null; migrationMissing: boolean }> {
  const db = createServiceClient()
  const { data, error } = await db
    .from('job_feedback')
    .select('job_id, verdict, reasons, note, created_at, job:job_opportunities(role_family, industry, company_name, location_tier, company_id)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(opts.limit ?? 200)
  if (error) return { rows: [], error: error.message, migrationMissing: isMissingSchema(error.message) }

  type Raw = {
    job_id: string
    verdict: FeedbackRow['verdict']
    reasons: string[] | null
    note: string | null
    created_at: string
    job: { role_family: string | null; industry: string | null; company_name: string; location_tier: number | null; company_id: string | null } | null
  }
  const raws = (data ?? []) as unknown as Raw[]

  // company_type lives on companies; one lookup for the distinct ids.
  const companyIds = Array.from(new Set(raws.map((r) => r.job?.company_id).filter((x): x is string => Boolean(x))))
  const typeOf = new Map<string, string | null>()
  if (companyIds.length) {
    const { data: comps } = await db.from('companies').select('id, company_type').in('id', companyIds)
    for (const c of (comps ?? []) as { id: string; company_type: string | null }[]) typeOf.set(c.id, c.company_type)
  }

  return {
    rows: raws.map((r) => ({
      job_id: r.job_id,
      verdict: r.verdict,
      reasons: r.reasons ?? [],
      role_family: r.job?.role_family ?? null,
      industry: r.job?.industry ?? null,
      company_name: r.job?.company_name ?? null,
      location_tier: r.job?.location_tier ?? null,
      company_type: r.job?.company_id ? typeOf.get(r.job.company_id) ?? null : null,
      note: r.note,
      created_at: r.created_at,
    })),
    error: null,
    migrationMissing: false,
  }
}
