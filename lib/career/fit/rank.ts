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
import type { CareerMission, FitComponent, FitWeights } from '../types'
import { clamp01, computeFitOverall, resolveFitWeights } from './dimensions'
import { computeFeedbackAdjustment, type FeedbackRow } from './feedback'

interface FitRowLite {
  id: string
  job_id: string
  mission_id: string | null
  components: FitComponent[]
  job: { id: string; role_family: string | null; industry: string | null; company_name: string; location_tier: number | null; company_id: string | null } | null
}

const FIT_SELECT = 'id, job_id, mission_id, components, job:job_opportunities(id, role_family, industry, company_name, location_tier, company_id)'

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

async function resum(rows: FitRowLite[], weightsFor: (missionId: string | null) => Promise<Partial<FitWeights> | null>, feedback: FeedbackRow[]): Promise<{ updated: number; errors: string[]; overallByJob: Record<string, number> }> {
  const errors: string[] = []
  const overallByJob: Record<string, number> = {}
  const types = await companyTypes(Array.from(new Set(rows.map((r) => r.job?.company_id).filter((x): x is string => Boolean(x)))))
  let updated = 0
  for (const r of rows) {
    const weights = resolveFitWeights(await weightsFor(r.mission_id))
    const base = computeFitOverall(r.components, weights)
    const adj = r.job
      ? computeFeedbackAdjustment(
          { id: r.job.id, role_family: r.job.role_family, industry: r.job.industry, company_name: r.job.company_name, location_tier: r.job.location_tier, company_type: r.job.company_id ? types.get(r.job.company_id) ?? null : null },
          feedback
        ).adjustment
      : 0
    const overall = round4(clamp01(base + adj))
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
  const weightsFor = async (id: string | null): Promise<Partial<FitWeights> | null> => {
    if (!id) return fallback.mission?.fit_weights ?? null
    if (!missions.has(id)) missions.set(id, await getMission(userId, id))
    return missions.get(id)?.fit_weights ?? fallback.mission?.fit_weights ?? null
  }
  const r = await resum(rows, weightsFor, feedback)
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
  const weightsFor = async (id: string | null) => (id ? (await getMission(userId, id))?.fit_weights ?? null : fallback.mission?.fit_weights ?? null)
  const r = await resum(rows, weightsFor, feedback)
  return { updated: r.updated, overall: r.overallByJob[jobId] ?? null, errors: r.errors, migrationMissing: false }
}
