import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { redoPackage } from '@/lib/career/package/redo'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * POST → a NEW package version for this package's job (intelligence + tailoring,
 * stop at résumé review). Works on any package, including a locked one: the
 * locked package and its submitted documents are never touched — the new
 * version sits beside them. Nothing is submitted anywhere.
 */
export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const r = await redoPackage({ userId: user.id, packageId: params.id })
    if (r.migrationMissing) return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true }, { status: 409 })
    if (!r.packageId) {
      const status = r.error === 'package not found' ? 404 : r.error?.startsWith('Evidence Bank') ? 400 : r.error?.includes('still generating') ? 409 : 500
      return NextResponse.json({ error: r.error ?? 'Failed', errors: r.errors }, { status })
    }
    return NextResponse.json(
      {
        package_id: r.packageId, status: r.status, stage: r.stage, version: r.version,
        from: { package_id: r.fromPackageId, status: r.fromStatus },
        application: { id: r.applicationId, state: r.applicationState },
        resume: r.resume, costUsd: r.costUsd, warnings: r.warnings, errors: r.errors, error: r.error,
      },
      { status: r.status === 'failed' ? 500 : 200 }
    )
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}
