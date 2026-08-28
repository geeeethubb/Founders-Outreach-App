import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { runJobIntelligence, type IntelligenceForce } from '@/lib/career/intelligence/orchestrator'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const MIGRATION = { error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true }

/**
 * POST { force?: { research?, fit?, match?, paths? } } → research summary, fit,
 * evidence map and warm paths for one job. Stored answers are reused unless forced.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = (await request.json().catch(() => ({}))) as { force?: IntelligenceForce }
    const force: IntelligenceForce = {}
    for (const k of ['research', 'fit', 'match', 'paths'] as const) if (body.force?.[k] === true) force[k] = true

    const r = await runJobIntelligence({ userId: user.id, jobId: params.id, force })
    if (r.migrationMissing) return NextResponse.json(MIGRATION, { status: 409 })
    if (!r.context) return NextResponse.json({ error: r.errors[0] ?? 'Failed' }, { status: r.errors[0] === 'job not found' ? 404 : 500 })

    return NextResponse.json({
      job_id: params.id,
      research: r.research
        ? { summary: r.research.summary, company_type: r.research.company_type, industry_tags: r.research.industry_tags, claims: r.research.claims.length, from_cache: r.researchFromCache }
        : null,
      fit: r.fit
        ? { overall: r.fit.evaluation.overall, band: r.fit.evaluation.band, feedback_adjustment: r.fit.evaluation.feedback_adjustment, eligibility: r.fit.judgment.eligibility, components: r.fit.judgment.components, explanation: r.fit.judgment.explanation, from_store: r.fitFromStore }
        : null,
      evidence_map: r.evidenceMapRow ?? r.evidenceMap,
      warm_paths: r.warmPathRows.length ? r.warmPathRows : r.warmPaths,
      costUsd: r.costUsd,
      errors: r.errors,
      run_id: r.runId,
    })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}
