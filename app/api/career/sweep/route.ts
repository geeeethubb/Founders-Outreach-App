// POST /api/career/sweep — list every resolvable board on the watchlist.
//
// This is the cheap half of discovery, on demand. It runs INLINE rather than
// through the enqueue/claim/worker machinery, and that is a deliberate
// difference from /api/career/scout rather than an omission:
//
//   a scout run thinks — a planner, web-search sessions, an extractor call per
//   posting — and takes minutes, so it must outlive its request. A sweep does
//   HTTP and regex. There is no model call reachable from it, so the failure
//   it has to survive is a slow board, not a slow model, and it is bounded by
//   a deadline well inside the function ceiling.
//
// It still writes a `scouting_runs` row and reports progress into it, so a
// sweep is a run you can open on /dashboard/runs with the jobs it found — the
// same vocabulary as every other run. Nothing about it lives in the browser.
//
// A sweep that runs out of clock is `partial`, keeps everything it stored, and
// says how many companies are left; calling it again continues, because the
// order is least-recently-checked first.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { liveSweepStore, sweepWatchlist, SWEEP_MAX_COMPANIES, SWEEP_VERCEL_DEADLINE_MS } from '@/lib/career/jobs/sweep'
import { ensureDefaultMission, getMission } from '@/lib/career/missions/store'
import { extractPending } from '@/lib/career/scout/extract'
import { scoutToolContext } from '@/lib/career/scout/orchestrator'
import { DEFAULT_SCOUT_BUDGET, startCareerRun } from '@/lib/career/runs'
import { reapStaleRuns } from '@/lib/career/scout/run-reaper'
import { activeJobScoutRun, finishScoutRun, recordProgress, resetProgressCache } from '@/lib/career/scout/run-store'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * Extractions one hosted sweep may buy. Deliberately small: the button is
 * "find me everything", not "read everything", and reading is what costs.
 */
const MAX_WEB_EXTRACT = 20

function clampInt(v: unknown, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fallback
  return Math.max(0, Math.min(max, n))
}

/**
 * POST { missionId?, limit?, concurrency?, extract?, storedBoardsOnly?, force? }
 *   → 200 { runId, ...sweep summary }
 *   → 409 { runId, alreadyActive } when a scout or sweep is already going
 */
export async function POST(request: NextRequest) {
  let runId: string | null = null
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>

    // "No paid work without a click" holds on the server, and so does "one
    // discovery pass at a time": two sweeps would fight over the same rows.
    if (body.force !== true) {
      await reapStaleRuns(user.id)
      const existing = await activeJobScoutRun(user.id)
      if (existing.run) {
        return NextResponse.json(
          { runId: existing.run.id, status: existing.run.status, alreadyActive: true, error: `A discovery run is already ${existing.run.status}. Watch it, or send force:true.` },
          { status: 409 }
        )
      }
    }

    const missionId = typeof body.missionId === 'string' && body.missionId ? body.missionId : null
    const mission = missionId ? await getMission(user.id, missionId) : (await ensureDefaultMission(user.id)).mission
    if (!mission) return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true }, { status: 409 })

    const limit = clampInt(body.limit, SWEEP_MAX_COMPANIES, SWEEP_MAX_COMPANIES)
    const concurrency = clampInt(body.concurrency, 10, 6) || 6
    const extract = clampInt(body.extract, MAX_WEB_EXTRACT, 0)
    const started = Date.now()
    const deadline = started + SWEEP_VERCEL_DEADLINE_MS

    const run = await startCareerRun({ userId: user.id, kind: 'job_scout', label: 'sweep · watchlist', mission: { name: mission.name, kind: 'sweep' }, careerMissionId: mission.id })
    runId = run.runId
    const ctx = scoutToolContext(user.id, runId, DEFAULT_SCOUT_BUDGET)

    // One in-flight progress write at a time; the sweep emits hundreds and
    // recordProgress throttles, so this never piles up.
    let chain: Promise<unknown> = Promise.resolve()
    const onProgress = (stage: string, detail: string) => {
      if (!runId) return
      chain = chain.then(() => recordProgress(runId as string, { stage, detail })).catch(() => {})
    }

    const result = await sweepWatchlist(
      user.id,
      { mission, limit, concurrency, deadline, storedBoardsOnly: body.storedBoardsOnly === true, runId, ctx, onProgress },
      { store: liveSweepStore() }
    )

    let extraction: { extracted: number; candidates: number; costUsd: number; errors: string[] } | null = null
    if (extract > 0 && !result.migrationMissing && Date.now() < deadline) {
      const ep = await extractPending(user.id, {
        limit: extract,
        order: 'relevance',
        direction: mission.preferences.direction,
        mission: { geo_tiers: mission.preferences.geo_tiers },
        ctx,
        run,
        deadline,
        onProgress: (d) => onProgress('extract', d),
      })
      extraction = { extracted: ep.extracted, candidates: ep.candidates, costUsd: ep.costUsd, errors: ep.errors }
    }

    await chain.catch(() => {})
    if (result.migrationMissing) {
      if (runId) await finishScoutRun(runId, 'failed', { error: 'migration 014 missing' })
      return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true, runId }, { status: 409 })
    }

    if (runId) {
      await finishScoutRun(runId, result.deadlineHit ? 'partial' : 'succeeded', {
        stats: {
          kind: 'sweep',
          companies_checked: result.checked,
          companies_with_openings: result.withOpenings,
          postings_seen: result.postingsListed,
          jobs_inserted: result.inserted,
          jobs_updated: result.updated,
          jobs: result.jobs.length,
          jobs_extracted: extraction?.extracted ?? 0,
          errors: result.errors.slice(0, 10),
        },
        error: result.errors[0] ?? null,
      })
      resetProgressCache(runId)
    }

    return NextResponse.json({
      runId,
      status: result.deadlineHit ? 'partial' : 'succeeded',
      eligible: result.eligible,
      checked: result.checked,
      withBoard: result.withBoard,
      withoutBoard: result.withoutBoard,
      withOpenings: result.withOpenings,
      postingsListed: result.postingsListed,
      inserted: result.inserted,
      updated: result.updated,
      remaining: result.remaining,
      byAts: result.byAts,
      rejected: result.rejected,
      // The page shows the best of what the sweep found; everything is stored
      // either way and the inbox is the full list.
      jobs: result.jobs.slice(0, 100),
      extraction,
      errors: result.errors,
      elapsedMs: Date.now() - started,
    })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    const message = error instanceof Error ? error.message : 'Failed'
    if (runId) await finishScoutRun(runId, 'failed', { error: message }).catch(() => {})
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
