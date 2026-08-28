import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { loadEvidenceBank } from '@/lib/career/evidence/store'
import { isDynamicUsage } from '@/lib/http/dynamic'

export const dynamic = 'force-dynamic'

const MIGRATION_MESSAGE =
  'The Evidence Bank tables do not exist yet. Apply supabase/migrations/014_career_os.sql in the Supabase SQL editor.'

/** The whole bank, approved or not — this is the page where approval happens. */
export async function GET() {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { bank, migrationMissing, errors } = await loadEvidenceBank(user.id, { approvedOnly: false })
    if (migrationMissing) {
      return NextResponse.json({ error: MIGRATION_MESSAGE, migrationMissing: true, bank }, { status: 409 })
    }
    const pending =
      bank.facts.filter((f) => !f.approved).length +
      bank.metrics.filter((m) => !m.approved).length +
      bank.skills.filter((s) => !s.approved).length +
      bank.deliverables.filter((d) => !d.approved).length +
      bank.stories.filter((s) => !s.approved).length +
      bank.experiences.filter((e) => !e.approved).length

    return NextResponse.json({
      bank,
      migrationMissing: false,
      errors,
      counts: {
        experiences: bank.experiences.length,
        bullets: bank.bullets.length,
        facts: bank.facts.length,
        factsApproved: bank.facts.filter((f) => f.approved).length,
        metrics: bank.metrics.length,
        skills: bank.skills.length,
        stories: bank.stories.length,
        preferences: bank.preferences.length,
        pending,
        hasMaster: bank.masterDocument !== null,
      },
    })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to load evidence' }, { status: 500 })
  }
}
