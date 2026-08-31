// What a scout run reads and writes — and how a stored company row is READ.
//
// Split out of orchestrator.ts, which owns the loop and should not also own the
// persistence surface. Two things live here:
//
//   1. `ScoutStore`, the whole database surface one run touches, and
//      `liveScoutStore()`, the production implementation. Every collaborator is
//      injectable so the loop runs in memory under test.
//
//   2. How a `companies` row is read. This is not a formality: `watch_status`
//      alone cannot be trusted. The old build wrote `target` from planner seeds
//      and scout discoveries, so the live table holds 163 "targets" no human
//      ever chose, and migration 016 is applied BY HAND — until the founder
//      runs it, a reader that trusts the column tells the planner that its own
//      earlier guesses are the user's strong preferences. `resolveStoredIntent`
//      (lib/career/companies/watchlist.ts) applies the same correction 016's
//      UPDATE makes, on read, from `watch_source`. Every consumer here — the
//      company-first budget, the planner's four groups, the learned
//      attributes — reads THAT, never the raw column (ADR-039).
//
// No judgement here, and nothing writes intent: only the user promotes a
// company.

import { createServiceClient } from '@/lib/supabase/server'
import { learnCompanyAttributes, type CompanyIntent } from '../companies/intent'
import { resolveStoredIntent } from '../companies/watchlist'
import { loadEvidenceBank } from '../evidence/store'
import type { FeedbackRow } from '../fit/feedback'
import type { NormalizedJob } from '../jobs/normalize'
import { isMissingSchema, listJobs, listWatchlist, updateJobVerification, upsertJobs, type JobListRow, type ListJobsFilters, type UpsertJobsResult } from '../jobs/store'
import type { VerifyResult } from '../jobs/verify'
import { ensureDefaultMission, getMission } from '../missions/store'
import { startCareerRun, type CareerRun } from '../runs'
import type { CareerMission, EvidenceBank } from '../types'
import { liveCompanyFirstStore, type CompanyFirstStore, type WatchedCompany } from './company-first'
import type { PlannerWatchlist } from '@/lib/agents/job-mission-planner'

export interface ScoutStore extends CompanyFirstStore {
  getMission(userId: string, missionId: string | null): Promise<{ mission: CareerMission | null; error: string | null; migrationMissing: boolean }>
  loadBank(userId: string): Promise<{ bank: EvidenceBank; migrationMissing: boolean; errors: string[] }>
  recentFeedback(userId: string, limit: number): Promise<FeedbackRow[]>
  startRun(params: Parameters<typeof startCareerRun>[0]): Promise<CareerRun>
  listWatchlist(userId: string): Promise<{ companies: Record<string, unknown>[]; error: string | null; migrationMissing: boolean }>
  listJobs(userId: string, filters: ListJobsFilters): Promise<{ jobs: JobListRow[]; error: string | null; migrationMissing: boolean }>
  upsertJobs(userId: string, jobs: NormalizedJob[], opts: { runId?: string | null; missionId?: string | null }): Promise<UpsertJobsResult>
  /**
   * Optional: upsertJobs deliberately leaves verification columns alone on a
   * re-seen row (that is the verifier's job), so a job listed on its ATS board
   * THIS run is refreshed to VERIFIED_OPEN here — otherwise a row that went
   * STALE would stay STALE while the board still shows it.
   */
  updateJobVerification?(userId: string, id: string, result: VerifyResult, now?: Date): Promise<{ error: string | null }>
  /**
   * Optional: the companies the user said no to. `listWatchlist` excludes them
   * (they are not scouted), but the planner still needs them — as a
   * do-not-propose list and as a negative signal about what the user dislikes.
   * A store without it simply has no negative signal to give.
   */
  listIgnoredCompanies?(userId: string): Promise<{ companies: Record<string, unknown>[]; error: string | null }>
}

export function liveScoutStore(): ScoutStore {
  return {
    ...liveCompanyFirstStore(),
    async getMission(userId, missionId) {
      if (missionId) {
        const m = await getMission(userId, missionId)
        return { mission: m, error: m ? null : 'mission not found', migrationMissing: false }
      }
      const r = await ensureDefaultMission(userId)
      return { mission: r.mission, error: r.error, migrationMissing: !!r.error && /014_career_os/.test(r.error) }
    },
    loadBank: (userId) => loadEvidenceBank(userId, { approvedOnly: true }),
    async recentFeedback(userId, limit) {
      const db = createServiceClient()
      const { data } = await db
        .from('job_feedback')
        .select('job_id, verdict, reasons, note, created_at, job:job_opportunities(role_family, industry, company_name, location_tier)')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit)
      type Row = { job_id: string; verdict: FeedbackRow['verdict']; reasons: string[]; note: string | null; created_at: string; job: { role_family: string | null; industry: string | null; company_name: string | null; location_tier: number | null } | null }
      return ((data ?? []) as unknown as Row[]).map((r) => ({
        job_id: r.job_id, verdict: r.verdict, reasons: r.reasons ?? [], note: r.note, created_at: r.created_at,
        role_family: r.job?.role_family ?? null, industry: r.job?.industry ?? null, company_name: r.job?.company_name ?? null, location_tier: r.job?.location_tier ?? null,
      }))
    },
    startRun: startCareerRun,
    listWatchlist,
    async listIgnoredCompanies(userId) {
      const db = createServiceClient()
      const { data, error } = await db
        .from('companies')
        .select('id, name, domain, watch_status, watch_source, watch_priority, last_careers_check_at, company_type, industry_tags')
        .eq('user_id', userId)
        .eq('watch_status', 'ignored')
        .limit(200)
      // A database without the column is not an error worth failing a run over.
      if (error) return { companies: [], error: isMissingSchema(error.message) ? null : error.message }
      return { companies: (data ?? []) as Record<string, unknown>[], error: null }
    },
    listJobs: (userId, filters) => listJobs(userId, filters),
    upsertJobs,
    updateJobVerification,
  }
}

// ─── Reading a company row ───────────────────────────────────────────────────

/**
 * A watchlist row as a run needs it: the company, plus what the user meant by
 * it. `intent` is the RESOLVED meaning — `watch_status` carries the same value
 * so a helper that only knows the column (`selectCompaniesToCheck`,
 * `learnCompanyAttributes`) cannot read something else.
 */
export type ScoutedWatchCompany = WatchedCompany & {
  /** The resolved intent — never the raw column. Null when the row has no intent at all. */
  intent: CompanyIntent | null
  /** Who wrote the row: 'user' owns it, 'planner'/'scout' are guesses. */
  watch_source: string | null
  last_careers_check_at: string | null
  company_type: string | null
  industry_tags: string[] | null
}

/**
 * One stored row, with its intent resolved once. Every downstream reader takes
 * the answer from here, so the run behaves identically before and after
 * migration 016 is applied by hand.
 */
export function toWatched(row: Record<string, unknown>): ScoutedWatchCompany {
  const intent = resolveStoredIntent(row)
  return {
    id: String(row.id), name: String(row.name), domain: (row.domain as string | null) ?? null, careers_url: (row.careers_url as string | null) ?? null,
    ats_type: (row.ats_type as string | null) ?? null, ats_identifier: (row.ats_identifier as string | null) ?? null,
    // The resolved intent, not the column: an agent's `target` is a suggestion.
    watch_status: intent,
    intent,
    watch_source: typeof row.watch_source === 'string' ? row.watch_source : null,
    watch_priority: (row.watch_priority as number | null) ?? null,
    last_careers_check_at: (row.last_careers_check_at as string | null) ?? null,
    company_type: (row.company_type as string | null) ?? null,
    industry_tags: Array.isArray(row.industry_tags) ? (row.industry_tags as string[]) : null,
  }
}

/**
 * The company context the planner sees — four groups, because they are four
 * different kinds of evidence. Targets and Watching are the user's own choices
 * (strong); Explore is the planner's and the scout's earlier guesses (weak —
 * re-suggesting one is not a signal); Ignored is a rejection and must never be
 * proposed again. `learned` is what those choices have in common, so the next
 * plan can look for more of that KIND of company instead of the same names
 * forever.
 *
 * Only a row the USER owns can reach `targets` or `watching`: the grouping
 * reads `intent`, which `toWatched` resolved from `watch_source`. Before that
 * correction existed this function would have told the planner that 163 of its
 * own earlier guesses were the user's strong preferences.
 *
 * Pure and exported so the offline test can drive it directly.
 */
export function buildPlannerWatchlist(active: ScoutedWatchCompany[], ignored: ScoutedWatchCompany[], feedback: FeedbackRow[]): PlannerWatchlist {
  const names = (rows: ScoutedWatchCompany[], intent: CompanyIntent) => rows.filter((r) => r.intent === intent).map((r) => r.name)
  const ignoredNames = [...new Set([...names(active, 'ignored'), ...names(ignored, 'ignored'), ...ignored.filter((r) => !r.intent).map((r) => r.name)])]
  const attributes = [...active, ...ignored].map((r) => ({ name: r.name, watch_status: r.intent, company_type: r.company_type, industry_tags: r.industry_tags }))
  const signals = feedback.map((f) => ({ verdict: f.verdict, company_name: f.company_name, industry: f.industry, role_family: f.role_family }))
  return {
    targets: names(active, 'target'),
    watching: names(active, 'watching'),
    explore: names(active, 'suggested'),
    ignored: ignoredNames,
    learned: learnCompanyAttributes(attributes, signals).summary,
  }
}
