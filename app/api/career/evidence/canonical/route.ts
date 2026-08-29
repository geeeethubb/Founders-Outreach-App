import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { loadEvidenceBank } from '@/lib/career/evidence/store'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { buildCanonicalView } from './build'

export const dynamic = 'force-dynamic'

/**
 * The bank grouped by organization → role → projects / key facts / metrics.
 * Approved and pending rows are both included (the tab badges pending);
 * tombstones are excluded by the loader. Works on a 014-only database:
 * `migration015: false` and the grouping falls back to normalized org names.
 */
export async function GET() {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { bank, migrationMissing, canonical, errors } = await loadEvidenceBank(user.id, { approvedOnly: false })
    if (migrationMissing) {
      return NextResponse.json(
        { error: 'Apply supabase/migrations/014_career_os.sql first.', migrationMissing: true, migration015: false, organizations: [], unattached: { facts: [], skills: 0, stories: 0 } },
        { status: 409 }
      )
    }
    const view = buildCanonicalView(bank)
    return NextResponse.json({ migration015: canonical, migrationMissing: false, errors, ...view })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to build canonical view' }, { status: 500 })
  }
}
