// Writes for the intelligence stages. Deterministic, idempotent, degrading.
//
// Every function returns an error string instead of throwing and reports
// `migrationMissing` when 014 is absent. Upserts key on the unique indexes
// migration 014 declares: job_fit_evaluations (job_id, mission_id),
// job_evidence_maps (job_id), warm_paths (job_id, contact_id).

import { createServiceClient } from '@/lib/supabase/server'
import { persistResearchFacts } from '@/lib/agents/runtime/persist'
import type { CompanyResearch } from '@/lib/agents/company-researcher'
import type { EvidenceMatch } from '@/lib/agents/evidence-matcher'
import type { JudgedPath } from '@/lib/agents/network-pathfinder'
import type { PathfinderCandidate } from '@/lib/agents/network-pathfinder/prompt'
import { researchClaimsToFactRows } from '../research/company'
import { isMissingSchema } from '../evidence/store'
import type { FitEvaluationRow } from '../fit/evaluate'
import type { JobEvidenceMap, JobFitEvaluation, WarmPath } from '../types'

export interface WriteResult {
  error: string | null
  migrationMissing: boolean
}

const NIL_UUID = '00000000-0000-0000-0000-000000000000'

function fail(message: string): WriteResult {
  return { error: message, migrationMissing: isMissingSchema(message) }
}

// ─── Company research ────────────────────────────────────────────────────────

/**
 * Claims → research_facts (the DB CHECK rejects an unsourced FACT), then the
 * summary and classification onto the companies row. This agent's prior facts
 * for the company are removed first: the fit evaluator and the letter read
 * "what we know", not a history of what we knew.
 */
export async function persistCompanyResearch(params: {
  userId: string
  runId: string | null
  companyId: string
  companyName: string
  agentRunId: string | null
  research: CompanyResearch
  promptVersion: string
}): Promise<WriteResult & { inserted: number; rejected: number }> {
  const db = createServiceClient()
  // Only THIS agent's earlier facts are replaced. The outreach researcher
  // writes to the same table for the same company, and its facts are not
  // ours to discard. Resolve from the company's facts outward (a few dozen
  // rows) rather than from every company_researcher run the user ever made —
  // an `in (…)` of a thousand uuids is a 37KB query string PostgREST rejects.
  const { data: priorFacts, error: readErr } = await db
    .from('research_facts')
    .select('id, agent_run_id')
    .eq('user_id', params.userId)
    .eq('company_id', params.companyId)
    .not('agent_run_id', 'is', null)
  if (readErr) return { ...fail(readErr.message), inserted: 0, rejected: 0 }
  const prior = (priorFacts ?? []) as { id: string; agent_run_id: string }[]
  const runIds = Array.from(new Set(prior.map((f) => f.agent_run_id)))
  let staleIds: string[] = []
  if (runIds.length) {
    const { data: runs } = await db.from('agent_runs').select('id').in('id', runIds).eq('agent_id', 'company_researcher')
    const ours = new Set(((runs ?? []) as { id: string }[]).map((r) => r.id))
    staleIds = prior.filter((f) => ours.has(f.agent_run_id)).map((f) => f.id)
  }

  // Insert first, delete after: a failed insert must not leave the company
  // with nothing where a month-old answer used to be.
  const facts = await persistResearchFacts({
    userId: params.userId,
    runId: params.runId,
    companyId: params.companyId,
    subjectLabel: params.companyName,
    agentRunId: params.agentRunId,
    claims: researchClaimsToFactRows(params.research),
  })
  if (facts.migrationMissing) return { error: facts.errors[0] ?? 'research_facts missing', migrationMissing: true, inserted: 0, rejected: 0 }
  if (staleIds.length && (facts.inserted > 0 || researchClaimsToFactRows(params.research).length === 0)) {
    const { error: delErr } = await db.from('research_facts').delete().in('id', staleIds)
    if (delErr) return { ...fail(delErr.message), inserted: facts.inserted, rejected: facts.rejected }
  }

  const r = params.research
  const { error } = await db
    .from('companies')
    .update({
      research_summary: r.summary,
      company_type: r.company_type,
      industry_tags: r.industry_tags,
      research_version: params.promptVersion,
      researched_at: new Date().toISOString(),
    } as never)
    .eq('id', params.companyId)
  if (error) return { ...fail(error.message), inserted: facts.inserted, rejected: facts.rejected }
  return { error: facts.errors[0] ?? null, migrationMissing: false, inserted: facts.inserted, rejected: facts.rejected }
}

// ─── Fit ─────────────────────────────────────────────────────────────────────

export async function upsertFitEvaluation(row: FitEvaluationRow): Promise<WriteResult & { row: JobFitEvaluation | null }> {
  const db = createServiceClient()
  // The unique index is on (job_id, coalesce(mission_id, NIL)); PostgREST's
  // on_conflict needs real columns, so find-then-write instead.
  let q = db.from('job_fit_evaluations').select('id').eq('job_id', row.job_id)
  q = row.mission_id ? q.eq('mission_id', row.mission_id) : q.is('mission_id', null)
  const { data: existing, error: readErr } = await q.maybeSingle()
  if (readErr) return { ...fail(readErr.message), row: null }

  const body = { ...row, computed_at: new Date().toISOString() }
  const write = existing
    ? db.from('job_fit_evaluations').update(body as never).eq('id', (existing as { id: string }).id).select('*').single()
    : db.from('job_fit_evaluations').insert(body as never).select('*').single()
  const { data, error } = await write
  if (error) return { ...fail(error.message), row: null }

  const denorm = await db
    .from('job_opportunities')
    .update({ fit_overall: row.overall, fit_eligibility: row.eligibility, fit_computed_at: body.computed_at } as never)
    .eq('id', row.job_id)
  return { error: denorm.error?.message ?? null, migrationMissing: false, row: data as JobFitEvaluation }
}

/** Re-sum only: overall, weights, adjustment. Components untouched. */
export async function updateFitTotals(
  id: string,
  jobId: string,
  patch: { overall: number; weights_used: Record<string, number>; feedback_adjustment: number }
): Promise<WriteResult> {
  const db = createServiceClient()
  const { error } = await db.from('job_fit_evaluations').update(patch as never).eq('id', id)
  if (error) return fail(error.message)
  const { error: jErr } = await db.from('job_opportunities').update({ fit_overall: patch.overall } as never).eq('id', jobId)
  return jErr ? fail(jErr.message) : { error: null, migrationMissing: false }
}

export function missionKey(missionId: string | null): string {
  return missionId ?? NIL_UUID
}

// ─── Evidence map ────────────────────────────────────────────────────────────

/**
 * The job_evidence_maps insert body. Pure, so a test can pin the column set:
 * `ungrounded_ids` and `no_gaps_reason` are the agent's bookkeeping, not
 * columns, and PostgREST rejects the whole row (PGRST204) for an unknown key.
 */
export function evidenceMapRow(params: {
  userId: string
  jobId: string
  match: EvidenceMatch
  promptVersion: string
  agentRunId: string | null
}): Record<string, unknown> {
  const { ungrounded_ids: _dropped, no_gaps_reason: _reason, ...columns } = params.match
  return {
    user_id: params.userId,
    job_id: params.jobId,
    ...columns,
    prompt_version: params.promptVersion,
    agent_run_id: params.agentRunId,
  }
}

export async function upsertEvidenceMap(params: {
  userId: string
  jobId: string
  match: EvidenceMatch
  promptVersion: string
  agentRunId: string | null
}): Promise<WriteResult & { row: JobEvidenceMap | null }> {
  const db = createServiceClient()
  const row = evidenceMapRow(params)
  const { data, error } = await db
    .from('job_evidence_maps')
    .upsert(row as never, { onConflict: 'job_id' })
    .select('*')
    .single()
  if (error) return { ...fail(error.message), row: null }
  return { error: null, migrationMissing: false, row: data as JobEvidenceMap }
}

// ─── Warm paths ──────────────────────────────────────────────────────────────

/** Replace the job's paths wholesale: the pathfinder judged the whole slate, so the old rows are its previous opinion. */
export async function replaceWarmPaths(params: {
  userId: string
  jobId: string
  companyId: string | null
  paths: JudgedPath[]
  candidates: PathfinderCandidate[]
  agentRunId: string | null
}): Promise<WriteResult & { rows: WarmPath[] }> {
  const db = createServiceClient()
  const { error: delErr } = await db.from('warm_paths').delete().eq('user_id', params.userId).eq('job_id', params.jobId)
  if (delErr) return { ...fail(delErr.message), rows: [] }
  if (params.paths.length === 0) return { error: null, migrationMissing: false, rows: [] }

  const basisOf = new Map(params.candidates.map((c) => [c.contact_id, c.retrieval_basis]))
  const rows = params.paths.map((p) => ({
    user_id: params.userId,
    job_id: params.jobId,
    company_id: params.companyId,
    contact_id: p.contact_id,
    relationship: p.relationship,
    strength: Math.round(Math.min(1, Math.max(0, p.strength)) * 100) / 100,
    why_relevant: p.why_relevant,
    existing_history: p.existing_history,
    suggested_action: p.suggested_action,
    retrieval_basis: basisOf.get(p.contact_id) ?? [],
    agent_run_id: params.agentRunId,
  }))
  const { data, error } = await db.from('warm_paths').insert(rows as never[]).select('*')
  if (error) return { ...fail(error.message), rows: [] }
  return { error: null, migrationMissing: false, rows: (data ?? []) as WarmPath[] }
}
