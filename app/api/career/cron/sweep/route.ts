// GET /api/career/cron/sweep — the daily inventory pass.
//
// Runs beside the verification cron and does the other half of "is this list
// still true?": verify re-checks the postings we already have, this one finds
// the postings we do not. Between them the inbox is a picture of the market
// today rather than of the last time somebody clicked a button.
//
// It is CHEAP on purpose. Listing a board is JSON over HTTP; the sweep makes no
// model call at all, so a nightly full pass over a 190-company watchlist costs
// nothing but requests. Extraction — the one paid step — is off unless the
// caller gives it an explicit budget (`?extract=N`, small and clamped), because
// a job that runs whether or not anybody is watching must never be able to
// spend money nobody asked it to.
//
// Authorization is the shared cron secret; Vercel cron sends no cookies.

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { isMissingSchema } from '@/lib/career/jobs/store'
import { liveSweepStore, sweepWatchlist, SWEEP_MAX_COMPANIES } from '@/lib/career/jobs/sweep'
import { verifyJobs } from '@/lib/career/jobs/verify-batch'
import { ensureDefaultMission } from '@/lib/career/missions/store'
import { extractPending } from '@/lib/career/scout/extract'
import { scoutToolContext } from '@/lib/career/scout/orchestrator'
import { DEFAULT_PACKAGE_BUDGET, DEFAULT_SCOUT_BUDGET, startCareerRun } from '@/lib/career/runs'
import { finishScoutRun } from '@/lib/career/scout/run-store'
import { sweepScoutQueue } from '@/lib/career/scout/queue-watchdog'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/** Leave headroom under the function ceiling so the last user's results persist. */
const DEADLINE_MS = 250_000
/** Per user, so one large watchlist cannot eat the whole window. */
const PER_USER_MS = 110_000
/** Postings re-verified per user after the sweep. The sweep itself confirms everything it lists. */
const VERIFY_LIMIT = 25
/** The most extraction a cron run may buy, even when asked for more. */
const MAX_CRON_EXTRACT = 25

/**
 * GET (Authorization: Bearer $CRON_SECRET) → { users: [...], skipped, elapsed_ms }
 * `?extract=N` buys N extractions per user on the highest-relevance postings
 * that do not have one. Omit it and the run is free.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) return NextResponse.json({ error: 'CRON_SECRET is not set; the sweep cron is disabled' }, { status: 503 })
  if (request.headers.get('authorization') !== `Bearer ${secret}`) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const askedExtract = Number(new URL(request.url).searchParams.get('extract') ?? 0)
  const extract = Number.isFinite(askedExtract) ? Math.max(0, Math.min(MAX_CRON_EXTRACT, Math.floor(askedExtract))) : 0

  const started = Date.now()
  const db = createServiceClient()
  const { data: profiles, error } = await db.from('profiles').select('id')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const users: Record<string, unknown>[] = []
  let skipped = 0
  for (const p of (profiles ?? []) as { id: string }[]) {
    // The daily backstop for the scout queue: close runs whose worker died,
    // dispatch legs nobody dispatched, fail what nothing will ever start. Every
    // read of a run does this too; this is the pass that runs whether or not
    // anybody is watching.
    await sweepScoutQueue(p.id).catch(() => undefined)
    if (Date.now() - started > DEADLINE_MS) {
      skipped++
      continue
    }
    const deadline = Math.min(started + DEADLINE_MS, Date.now() + PER_USER_MS)
    let runId: string | null = null
    try {
      const mission = (await ensureDefaultMission(p.id)).mission
      if (!mission) {
        users.push({ user_id: p.id, error: 'no mission (migration 014 not applied?)' })
        continue
      }
      const run = await startCareerRun({ userId: p.id, kind: 'job_scout', label: 'cron sweep · watchlist', mission: { name: mission.name, kind: 'sweep' }, careerMissionId: mission.id })
      runId = run.runId
      const ctx = scoutToolContext(p.id, runId, DEFAULT_SCOUT_BUDGET)

      const sweep = await sweepWatchlist(
        p.id,
        { mission, limit: SWEEP_MAX_COMPANIES, concurrency: 6, deadline, runId, ctx },
        { store: liveSweepStore() }
      )
      if (sweep.migrationMissing) {
        if (runId) await finishScoutRun(runId, 'failed', { error: 'migration 014 missing' })
        return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true, users }, { status: 409 })
      }

      // The sweep confirms everything it LISTS. Verification is for the rows it
      // did not see this pass — the postings that have quietly closed.
      const verify = await verifyJobs(p.id, { scope: 'stale', limit: VERIFY_LIMIT, ctx: scoutToolContext(p.id, runId, DEFAULT_PACKAGE_BUDGET), run })

      let extraction: { extracted: number; candidates: number; costUsd: number } | null = null
      if (extract > 0 && Date.now() < deadline) {
        const ep = await extractPending(p.id, {
          limit: extract,
          order: 'relevance',
          direction: mission.preferences.direction,
          mission: { geo_tiers: mission.preferences.geo_tiers },
          ctx,
          run,
          deadline,
        })
        extraction = { extracted: ep.extracted, candidates: ep.candidates, costUsd: ep.costUsd }
      }

      if (runId) {
        await finishScoutRun(runId, sweep.deadlineHit ? 'partial' : 'succeeded', {
          stats: {
            kind: 'sweep',
            companies_checked: sweep.checked,
            companies_with_openings: sweep.withOpenings,
            postings_seen: sweep.postingsListed,
            jobs_inserted: sweep.inserted,
            jobs_updated: sweep.updated,
            jobs_extracted: extraction?.extracted ?? 0,
            verified: verify.checked,
            errors: sweep.errors.slice(0, 10),
          },
          error: sweep.errors[0] ?? null,
        })
      }

      users.push({
        user_id: p.id,
        run_id: runId,
        eligible: sweep.eligible,
        checked: sweep.checked,
        with_board: sweep.withBoard,
        postings_listed: sweep.postingsListed,
        inserted: sweep.inserted,
        updated: sweep.updated,
        remaining: sweep.remaining,
        verified: verify.checked,
        verification_changed: verify.changed.length,
        applications_closed: verify.applicationsClosed.length,
        extraction,
        // Never hidden: a sweep that could not read half the watchlist has to
        // say so, or "0 new jobs" reads as "the market is quiet".
        errors: sweep.errors.slice(0, 20),
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (runId) await finishScoutRun(runId, 'failed', { error: message }).catch(() => {})
      if (isMissingSchema(message)) return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true, users }, { status: 409 })
      users.push({ user_id: p.id, run_id: runId, errors: [message] })
    }
  }
  return NextResponse.json({ users, skipped, extract, elapsed_ms: Date.now() - started })
}
