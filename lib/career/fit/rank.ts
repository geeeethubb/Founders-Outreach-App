// Re-ranking without a model call.
//
// The Fit Evaluator's components are stored; the total is arithmetic
// (ADR-004). So when the user edits a mission's weights or gives feedback,
// nothing needs to be asked again — every stored evaluation is re-summed
// under the current weights, the feedback modifier is recomputed from the
// current feedback rows, and the totals are written back. Instant, free, and
// `weights_used` on each row records what produced the number.

import { createServiceClient } from '@/lib/supabase/server'
import { isMissingSchema } from '../evidence/store'
import { loadFeedbackRows } from '../intelligence/load'
import { updateFitTotals } from '../intelligence/persist'
import { ensureDefaultMission, getMission } from '../missions/store'
import { applyHardConstraints } from '../jobs/filters'
import type { CareerMission, Eligibility, FitComponent, FitWeights, HardConstraint } from '../types'
import { clamp01, computeFitOverall, resolveFitWeights } from './dimensions'
import { fitGates } from './evaluate'
import { computeFeedbackAdjustment, type FeedbackRow } from './feedback'

interface FitRowLite {
  id: string
  job_id: string
  mission_id: string | null
  components: FitComponent[]
  eligibility: Eligibility
  job: { id: string; title: string; role_family: string | null; industry: string | null; company_name: string; location_tier: number | null; company_id: string | null; employment_type: string; season_relevance: string; location_country: string | null; work_mode: string } | null
}

// The job columns are what the feedback modifier and the hard-constraint gate read (evaluateFit's inputs, re-derived from rows).
const FIT_SELECT = 'id, job_id, mission_id, components, eligibility, job:job_opportunities(id, title, role_family, industry, company_name, location_tier, company_id, employment_type, season_relevance, location_country, work_mode)'

function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

async function companyTypes(ids: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  if (!ids.length) return out
  const db = createServiceClient()
  const { data } = await db.from('companies').select('id, company_type').in('id', ids)
  for (const c of (data ?? []) as { id: string; company_type: string | null }[]) out.set(c.id, c.company_type)
  return out
}

interface MissionLite {
  fit_weights: Partial<FitWeights> | null
  hard_constraints: HardConstraint[]
}

async function resum(rows: FitRowLite[], missionFor: (missionId: string | null) => Promise<MissionLite | null>, feedback: FeedbackRow[]): Promise<{ updated: number; errors: string[]; overallByJob: Record<string, number> }> {
  const errors: string[] = []
  const overallByJob: Record<string, number> = {}
  const types = await companyTypes(Array.from(new Set(rows.map((r) => r.job?.company_id).filter((x): x is string => Boolean(x)))))
  let updated = 0
  for (const r of rows) {
    const mission = await missionFor(r.mission_id)
    const weights = resolveFitWeights(mission?.fit_weights ?? null)
    const base = computeFitOverall(r.components, weights)
    // Same gates as evaluateFit: a re-sum must not un-gate what the first sum gated.
    const failures = r.job && mission ? applyHardConstraints(r.job as unknown as Parameters<typeof applyHardConstraints>[0], mission.hard_constraints).failed.map((f) => f.label) : []
    const gate = fitGates(r.eligibility, failures, r.components)
    const adj = r.job
      ? computeFeedbackAdjustment(
          { id: r.job.id, role_family: r.job.role_family, industry: r.job.industry, company_name: r.job.company_name, location_tier: r.job.location_tier, company_type: r.job.company_id ? types.get(r.job.company_id) ?? null : null },
          feedback
        ).adjustment
      : 0
    const overall = round4(Math.min(gate.cap, clamp01(base * gate.factor + adj)))
    const w = await updateFitTotals(r.id, r.job_id, { overall, weights_used: weights, feedback_adjustment: round4(adj) })
    if (w.error) errors.push(`${r.job_id}: ${w.error}`)
    else {
      updated++
      overallByJob[r.job_id] = overall
    }
  }
  return { updated, errors, overallByJob }
}

/**
 * Every evaluation for the mission (or every evaluation the user has, when
 * null), re-summed under the mission's current weights and the current
 * feedback. Zero model calls.
 */
export async function recomputeFitForMission(
  userId: string,
  missionId: string | null
): Promise<{ updated: number; errors: string[]; migrationMissing: boolean }> {
  const db = createServiceClient()
  let q = db.from('job_fit_evaluations').select(FIT_SELECT).eq('user_id', userId)
  if (missionId) q = q.eq('mission_id', missionId)
  const { data, error } = await q
  if (error) return { updated: 0, errors: [error.message], migrationMissing: isMissingSchema(error.message) }
  const rows = (data ?? []) as unknown as FitRowLite[]

  const feedback = (await loadFeedbackRows(userId)).rows
  const missions = new Map<string, CareerMission | null>()
  const fallback = await ensureDefaultMission(userId)
  const missionFor = async (id: string | null): Promise<MissionLite | null> => {
    if (!id) return fallback.mission
    if (!missions.has(id)) missions.set(id, await getMission(userId, id))
    return missions.get(id) ?? fallback.mission
  }
  const r = await resum(rows, missionFor, feedback)
  return { updated: r.updated, errors: r.errors, migrationMissing: false }
}

/** The single-job path after a feedback POST: re-sum only this job's evaluations. */
export async function applyFeedbackToJob(
  userId: string,
  jobId: string
): Promise<{ updated: number; overall: number | null; errors: string[]; migrationMissing: boolean }> {
  const db = createServiceClient()
  const { data, error } = await db.from('job_fit_evaluations').select(FIT_SELECT).eq('user_id', userId).eq('job_id', jobId)
  if (error) return { updated: 0, overall: null, errors: [error.message], migrationMissing: isMissingSchema(error.message) }
  const rows = (data ?? []) as unknown as FitRowLite[]
  if (!rows.length) return { updated: 0, overall: null, errors: [], migrationMissing: false }

  const feedback = (await loadFeedbackRows(userId)).rows
  const fallback = await ensureDefaultMission(userId)
  const missionFor = async (id: string | null): Promise<MissionLite | null> => (id ? (await getMission(userId, id)) ?? fallback.mission : fallback.mission)
  const r = await resum(rows, missionFor, feedback)
  return { updated: r.updated, overall: r.overallByJob[jobId] ?? null, errors: r.errors, migrationMissing: false }
}
