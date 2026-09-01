import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { generateCompletePackage } from '@/lib/career/package/auto'
import { resolveRedoTarget } from '@/lib/career/package/redo'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * POST → a NEW, FINISHED package version for this package's job.
 *
 * Runs the same complete flow as a first generation, so "regenerate" does not
 * quietly drop the founder back into the four-click review path the one-click
 * flow replaced. Works on any package, including a locked one: the locked
 * package and its submitted documents are never touched — the new version sits
 * beside them. Nothing is submitted anywhere, ever.
 */
export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const target = await resolveRedoTarget(user.id, params.id)
    if (target.migrationMissing) return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true }, { status: 409 })
    if (!target.jobId) {
      const e = target.error ?? 'Failed'
      const status = e === 'package not found' ? 404 : e.includes('still generating') ? 409 : 500
      return NextResponse.json({ error: e }, { status })
    }

    const body = (await _request.json().catch(() => ({}))) as { render_pdf?: boolean }
    const r = await generateCompletePackage({ userId: user.id, jobId: target.jobId, renderPdf: body.render_pdf === true })
    if (r.migrationMissing) return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true }, { status: 409 })
    if (!r.packageId) {
      const e = r.errors[r.errors.length - 1] ?? 'Failed'
      return NextResponse.json({ error: e, errors: r.errors }, { status: e.startsWith('Evidence Bank') ? 400 : 500 })
    }
    return NextResponse.json({
      package_id: r.packageId, outcome: r.outcome, status: r.status, stage: r.stage, version: r.version,
      from: { package_id: params.id, status: target.fromStatus },
      application: { id: r.applicationId, state: null },
      attention: r.attention, resume: r.resume, letter: r.letter, documents: r.documents,
      apply_url: r.applyUrl, costUsd: r.costUsd, elapsed_ms: r.elapsedMs, warnings: r.warnings, errors: r.errors,
    })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}
