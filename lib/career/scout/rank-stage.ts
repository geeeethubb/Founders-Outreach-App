// (g) RANK — the paid pass over what the run just stored.
//
// Split out of orchestrator.ts, which had grown past the size this repo keeps
// files to. Two things live here and nothing else:
//
//   collectRunJobs   one entry per STORED ROW. Two stages can see the same
//                    posting (the store matched the second sighting to the
//                    first row), so it is ranked once and reported once,
//                    under the id the store gave it.
//
//   runRankStage     how many of those get a fit number, and what happens
//                    when the run cannot afford it. HOW MANY is the mode's
//                    `maxFullFit` capped by what the ceiling can still buy —
//                    it used to be a hard-coded twelve, which meant a run
//                    could discover four hundred postings and judge twelve.
//
// A batch that cannot start is REPORTED, never silently skipped: an unranked
// list that looks like a ranked one is exactly the failure ADR-010 is about.

import type { NormalizedJob } from '../jobs/normalize'
import type { SweepJob } from '../jobs/sweep'
import type { CareerMission, VerificationStatus } from '../types'
import { selectJobsToRank } from './direction'
import type { JobScoutDeps, JobScoutResultJob } from './types'

/** How many fit evaluations run at once, and how much clock one needs. */
export const RANK_CONCURRENCY = 3
export const RANK_DEADLINE_RESERVE_MS = 20_000
export const RANK_MIN_WINDOW_MS = 30_000

export type RankFn = NonNullable<JobScoutDeps['rank']>

/** A row the sweep stored: already relevance-ordered, with no NormalizedJob in hand. */
export type SweptJob = SweepJob

export interface CollectedJobs {
  /** The stage rows, with their stored ids, in discovery order. */
  rankJobs: NormalizedJob[]
  rankIds: string[]
  /** Sweep rows no stage re-found, in the order the sweep produced them. */
  sweepOnly: string[]
  /** Every distinct row this run touched, as the API returns them. */
  resultJobs: JobScoutResultJob[]
}

/**
 * Every distinct stored row this run touched, deduplicated by the id the store
 * gave it — the sweep's rows included.
 */
export function collectRunJobs(input: {
  persistedJobs: NormalizedJob[]
  idByJob: Map<NormalizedJob, string>
  sweepJobs: SweptJob[]
}): CollectedJobs {
  const rankJobs: NormalizedJob[] = []
  const rankIds: string[] = []
  const sweepOnly: string[] = []
  const resultJobs: JobScoutResultJob[] = []
  const seen = new Set<string>()

  for (const job of input.persistedJobs) {
    const id = input.idByJob.get(job)
    if (id) {
      if (seen.has(id)) continue
      seen.add(id)
      rankJobs.push(job)
      rankIds.push(id)
    }
    resultJobs.push({
      id, title: job.title, company_name: job.company_name, location_raw: job.location_raw, location_tier: job.location_tier,
      season_relevance: job.season_relevance, employment_type: job.employment_type, verification_status: job.verification_status,
      canonical_url: job.canonical_url, source_types: [...new Set(job.sources.map((s) => s.source_type))],
    })
  }

  for (const j of input.sweepJobs) {
    if (seen.has(j.id)) continue
    seen.add(j.id)
    sweepOnly.push(j.id)
    resultJobs.push({
      id: j.id, title: j.title, company_name: j.company_name, location_raw: j.location_raw, location_tier: j.location_tier,
      season_relevance: j.season_relevance, employment_type: j.employment_type, verification_status: j.verification_status as VerificationStatus,
      canonical_url: j.canonical_url, source_types: j.source_types,
    })
  }

  return { rankJobs, rankIds, sweepOnly, resultJobs }
}

export interface RankStageInput {
  userId: string
  mission: CareerMission
  jobs: CollectedJobs
  /** The mode's `maxFullFit`. */
  maxFullFit: number
  /** Fit evaluations the spend ceiling can still buy. 0 means the run is out of money. */
  affordable: number
  /** The ledger's refusal in words, used when `affordable` is 0. */
  refusalReason: string | null
  /** Milliseconds of the deadline left for ranking, reserve already deducted. */
  windowMs: number
  /** A CLI --direction was applied to this run only, so fit must not be persisted against it. */
  directionOverridden: boolean
  rank?: RankFn
  progress: (stage: string, detail: string) => void
}

export interface RankStageResult {
  ranked: number
  costUsd: number
  errors: string[]
  /** Set when nothing was ranked, and why — never silence. */
  skipped: string | null
  /** Set when the reason was money, so the run reports a budget stop. */
  budgetStopped: string | null
}

const none = (skipped: string | null = null, budgetStopped: string | null = null): RankStageResult => ({
  ranked: 0, costUsd: 0, errors: skipped ? [skipped] : [], skipped, budgetStopped,
})

/**
 * Rank the best of what this run stored, or say why it did not.
 *
 * Stored evaluations at the current prompt version are reused inside the
 * batch, so only jobs without one cost anything.
 */
export async function runRankStage(i: RankStageInput): Promise<RankStageResult> {
  const { rankIds, rankJobs, sweepOnly } = i.jobs
  if (rankIds.length === 0 && sweepOnly.length === 0) return none()

  if (i.directionOverridden) {
    // Fit rows are persisted under the stored mission's id and reused at the
    // same prompt version; judging them against a direction that was never
    // saved would pollute every later run. Say so rather than rank quietly
    // against the wrong direction.
    const skip =
      'ranking skipped: --direction is not applied to fit (fit rows are stored against the saved mission — save the direction on the Jobs page to rank against it)'
    i.progress('rank', skip)
    return none(skip)
  }
  if (i.windowMs < RANK_MIN_WINDOW_MS) {
    return none(`ranking skipped: ${Math.max(0, Math.round(i.windowMs / 1000))}s left of the deadline`)
  }
  if (i.affordable === 0) {
    // Discovery is allowed to eat the whole ceiling — but then it must SAY
    // that ranking did not happen, rather than returning an unranked list
    // that looks like a ranked one.
    const reason = i.refusalReason ?? 'the run reached its spend ceiling'
    i.progress('rank', `skipped: ${reason}`)
    return none(`ranking skipped: ${reason}`, reason)
  }

  // The stages' rows are chosen by `selectJobsToRank` (which can see the whole
  // NormalizedJob); the sweep's are already relevance-ordered and top up
  // whatever room is left. A run whose inventory came entirely from the sweep
  // still ranks the best of it.
  const cap = Math.max(1, Math.min(i.maxFullFit, i.affordable))
  const toRank = selectJobsToRank(rankJobs, rankIds, cap, i.mission.preferences.direction)
  for (const id of sweepOnly) {
    if (toRank.length >= cap) break
    toRank.push(id)
  }
  i.progress('rank', `${toRank.length} jobs`)

  const runBatch = i.rank
  if (!runBatch) return none('ranking skipped: no ranking implementation was provided')
  try {
    const r = await runBatch(i.userId, toRank, {
      concurrency: RANK_CONCURRENCY, deadlineMs: i.windowMs, skip: { research: true }, label: `post-scout ranking · ${i.mission.name}`,
    })
    const errors = [...r.errors]
    if (r.skipped.length) errors.unshift(`ranking: ${r.skipped.length} job(s) not started before the deadline`)
    return {
      ranked: Object.values(r.results).filter((x) => x.fit !== null).length,
      costUsd: Number(r.costUsd.toFixed(4)),
      errors,
      skipped: null,
      budgetStopped: null,
    }
  } catch (e) {
    return { ranked: 0, costUsd: 0, errors: [`ranking: ${e instanceof Error ? e.message : String(e)}`], skipped: null, budgetStopped: null }
  }
}
