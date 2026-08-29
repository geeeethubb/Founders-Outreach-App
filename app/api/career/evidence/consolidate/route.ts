import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { loadEvidenceBank } from '@/lib/career/evidence/store'
import { buildConsolidationPlan } from '@/lib/career/evidence/consolidate'
import { applyConsolidation, loadSuppressedPairs } from '@/lib/career/evidence/consolidate-apply'
import { renderPlanReport } from '@/lib/career/evidence/consolidate-report'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { guardPlan } from '../review/guard'

export const dynamic = 'force-dynamic'
// A full apply snapshots the bank and backfills provenance; give it room.
export const maxDuration = 120

const MIGRATION_015_MESSAGE = 'Apply supabase/migrations/015_evidence_canonical.sql in the Supabase SQL editor first'

/**
 * `{ dryRun: true }` → the plan as JSON plus the same text report the CLI
 * prints (works before 015, read-only). `{ dryRun: false }` → the HIGH part of
 * the plan is applied with the bank-wide backfill, exactly like
 * `npm run evidence:consolidate -- --apply`. Never touches POSSIBLE or
 * CONFLICT pairs; those go through /api/career/evidence/review one by one.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const raw = (await request.json().catch(() => ({}))) as Record<string, unknown>
    if (typeof raw.dryRun !== 'boolean') return NextResponse.json({ error: 'dryRun (boolean) is required' }, { status: 400 })
    const dryRun = raw.dryRun

    const { bank, migrationMissing, canonical, errors } = await loadEvidenceBank(user.id, { approvedOnly: false, includeTombstones: true })
    if (migrationMissing) return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first.', migrationMissing: true }, { status: 409 })

    const suppressed = canonical ? (await loadSuppressedPairs(user.id)).pairs : []
    // Same guard as the Review tab: unsafe HIGH experience pairs are held as POSSIBLE.
    const plan = guardPlan(buildConsolidationPlan(bank, { suppressed, migration015: canonical }), bank)

    if (dryRun) {
      return NextResponse.json({ dryRun: true, migration015: canonical, plan, report: renderPlanReport(plan), errors })
    }
    if (!canonical) return NextResponse.json({ error: MIGRATION_015_MESSAGE, migration015: false }, { status: 400 })

    const result = await applyConsolidation(user.id, plan, { reason: 'evidence page: consolidate' })
    const failed = result.errors.length > 0 && result.merged.length === 0 && result.summaries_refreshed === 0
    return NextResponse.json({ dryRun: false, migration015: true, result, errors }, { status: failed ? 500 : 200 })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Consolidation failed' }, { status: 500 })
  }
}
