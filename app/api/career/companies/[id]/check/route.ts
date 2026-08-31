import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { isMissingSchema, upsertJobs } from '@/lib/career/jobs/store'
import { resolveStoredIntent } from '@/lib/career/companies/watchlist'
import { clusterJobs } from '@/lib/career/jobs/dedupe'
import { ensureDefaultMission } from '@/lib/career/missions/store'
import { DEFAULT_PACKAGE_BUDGET, startCareerRun } from '@/lib/career/runs'
import { checkCompanyForOpenings, type WatchedCompany } from '@/lib/career/scout/company-first'
import { extractAndNormalize } from '@/lib/career/scout/extract'
import { scoutToolContext } from '@/lib/career/scout/orchestrator'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * POST → { openings, open_roles_count, jobs_inserted, jobs_updated, rejected: [{reason,title,company}],
 *         board: {ats, identifier, board_url}|null, method, note, intent, errors }
 *
 * Re-checks one company's board now and stores the internship postings it
 * lists. It records openings as STATE (`open_roles_count`,
 * `last_careers_check_at`) and never touches what the company means to the
 * user: a check cannot promote a company, and cannot demote a target
 * (migration 016).
 */
export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const db = createServiceClient()
    const { data, error } = await db.from('companies').select('id, name, domain, careers_url, ats_type, ats_identifier, watch_status, watch_source, watch_priority').eq('user_id', user.id).eq('id', params.id).maybeSingle()
    if (error) {
      if (isMissingSchema(error.message)) return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true }, { status: 409 })
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'Company not found' }, { status: 404 })
    const company = data as unknown as WatchedCompany

    const m = await ensureDefaultMission(user.id)
    if (!m.mission) {
      if (m.error && /014_career_os/.test(m.error)) return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true }, { status: 409 })
      return NextResponse.json({ error: m.error ?? 'no mission' }, { status: 500 })
    }

    const check = await checkCompanyForOpenings(user.id, company, { internshipsOnly: true, bypassCache: true })
    const errors: string[] = check.error ? [check.error] : []
    let inserted = 0
    let updated = 0
    let rejected: { reason: string; title: string; company: string }[] = []

    if (check.postings.length) {
      const run = await startCareerRun({ userId: user.id, kind: 'job_scout', label: `company check · ${company.name}`, mission: { name: m.mission.name }, careerMissionId: m.mission.id })
      const ctx = scoutToolContext(user.id, run.runId, DEFAULT_PACKAGE_BUDGET)
      const ex = await extractAndNormalize(check.postings, { mission: m.mission, ctx, run, maxExtract: 20, concurrency: 4 })
      errors.push(...ex.errors)
      rejected = ex.rejected.map((r) => ({ reason: r.reason, title: r.title, company: r.company }))
      const jobs = clusterJobs(ex.jobs).merged
      const now = new Date().toISOString()
      for (const job of jobs) {
        job.verification_status = 'VERIFIED_OPEN'
        job.last_verified_at = now
        job.verification_method = 'ats_listing'
        job.verification_note = 'listed on the company ATS board'
      }
      const up = await upsertJobs(user.id, jobs, { runId: run.runId, missionId: m.mission.id })
      errors.push(...up.errors)
      inserted = up.inserted
      updated = up.updated
      await run.finish(up.migrationMissing ? 'failed' : 'succeeded', { openings: check.postings.length, jobs_inserted: inserted, jobs_updated: updated, rejected: rejected.length })
      if (up.migrationMissing) return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true }, { status: 409 })
    }

    return NextResponse.json({
      openings: check.postings.length,
      // What the watchlist now stores for this company. Intent is untouched.
      open_roles_count: check.error ? null : check.postings.length,
      jobs_inserted: inserted,
      jobs_updated: updated,
      rejected,
      board: check.board ? { ats: check.board.ats, identifier: check.board.identifier, board_url: check.board.board_url ?? null } : null,
      method: check.method,
      note: check.note,
      // Echoed so the page can prove the point: the check ran and the company
      // means exactly what it meant before.
      intent: resolveStoredIntent(company as unknown as Record<string, unknown>),
      errors,
    })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}
