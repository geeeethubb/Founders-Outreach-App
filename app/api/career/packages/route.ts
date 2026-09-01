import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { generateCompletePackage } from '@/lib/career/package/auto'
import { generatePackage } from '@/lib/career/package/orchestrator'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * POST { job_id } → a finished application package.
 *
 * Everything runs: extraction and research if the job needs them, evidence
 * matching, tailoring, fact verification, auto-approval of every change the
 * gates passed, the DOCX, the cover letter and its grounding gate, document QA,
 * and finalisation. The answer is `outcome: 'ready_to_apply' | 'needs_attention'`
 * — the two states a person can act on.
 *
 * This used to stop at résumé review and hand back a package needing four more
 * clicks, every one of which confirmed a decision code had already made. The
 * checks are unchanged; only the confirmations are gone.
 *
 * `{ stop_at_review: true }` keeps the old stepwise behaviour for the manual
 * edit flow, which still posts to …/resume and …/letter to change things by
 * hand. `{ render_pdf: true }` adds a PDF; the DOCX is the default output.
 *
 * The work can outlast the request. The route creates the package row before it
 * starts, so a 504 still leaves a row the panel can poll — never a dead end
 * where the only option is to pay for a second run.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = (await request.json().catch(() => ({}))) as {
      job_id?: string
      stop_at_review?: boolean
      render_pdf?: boolean
    }
    if (!body.job_id) return NextResponse.json({ error: 'job_id is required' }, { status: 400 })

    if (body.stop_at_review === true) {
      const r = await generatePackage({ userId: user.id, jobId: body.job_id })
      if (r.migrationMissing) return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true }, { status: 409 })
      if (!r.packageId) return NextResponse.json({ error: r.error ?? 'Failed', errors: r.errors }, { status: errorStatus(r.error) })
      return NextResponse.json(
        {
          package_id: r.packageId, status: r.status, stage: r.stage, version: r.version,
          application: { id: r.applicationId, state: r.applicationState },
          resume: r.resume, costUsd: r.costUsd, warnings: r.warnings, errors: r.errors, error: r.error,
        },
        { status: r.status === 'failed' ? 500 : 200 }
      )
    }

    const r = await generateCompletePackage({ userId: user.id, jobId: body.job_id, renderPdf: body.render_pdf === true })
    if (r.migrationMissing) return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true }, { status: 409 })
    if (!r.packageId) {
      return NextResponse.json({ error: r.errors[r.errors.length - 1] ?? 'Failed', errors: r.errors, attention: r.attention }, { status: errorStatus(r.errors[r.errors.length - 1] ?? null) })
    }

    // 200 even for needs_attention: the package EXISTS and carries real work —
    // usually a complete résumé — and the client renders `attention` rather than
    // an error banner. A non-2xx here would throw away documents already paid for.
    return NextResponse.json({
      package_id: r.packageId,
      outcome: r.outcome,
      status: r.status,
      stage: r.stage,
      version: r.version,
      application: { id: r.applicationId, state: null },
      attention: r.attention,
      resume: r.resume,
      letter: r.letter,
      documents: r.documents,
      apply_url: r.applyUrl,
      costUsd: r.costUsd,
      elapsed_ms: r.elapsedMs,
      warnings: r.warnings,
      errors: r.errors,
    })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}

function errorStatus(error: string | null): number {
  if (error === 'job not found') return 404
  if (error?.startsWith('Evidence Bank')) return 400
  return 500
}
