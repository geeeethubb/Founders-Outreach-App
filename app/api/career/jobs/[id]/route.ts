import { NextRequest, NextResponse } from 'next/server'
import { recoverStalePackages } from '@/lib/career/package/recover'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { getJob } from '@/lib/career/jobs/store'
import { fitBand } from '@/lib/career/fit/dimensions'

export const dynamic = 'force-dynamic'

type Row = Record<string, unknown>

/**
 * GET → { job, sources, snapshot, fit, evidence_map, warm_paths (with contact), feedback, application, packages }
 * `job` is the bare job_opportunities row (embedded relations lifted out).
 */
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const res = await getJob(user.id, params.id)
    if (res.migrationMissing) return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true }, { status: 409 })
    if (res.error) return NextResponse.json({ error: res.error }, { status: 500 })
    if (!res.job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

    const { sources, fit, evidence_map, warm_paths, feedback, applications, latest_snapshot, ...job } = res.job as Row & {
      sources?: Row[]; fit?: Row[]; evidence_map?: Row[]; warm_paths?: Row[]; feedback?: Row[]; applications?: Row[]; latest_snapshot?: Row | null
    }
    const newest = (rows: Row[] | undefined, key: string) => [...(rows ?? [])].sort((a, b) => String(b[key] ?? '').localeCompare(String(a[key] ?? '')))[0] ?? null
    const fitRow = newest(fit, 'computed_at')
    const fitOut = fitRow ? { ...fitRow, band: fitBand(Number(fitRow.overall ?? 0)) } : null

    const db = createServiceClient()
    const contactIds = [...new Set((warm_paths ?? []).map((w) => w.contact_id as string).filter(Boolean))]
    const contacts = contactIds.length
      ? ((await db.from('contacts').select('id, name, role, company, email, linkedin_url').eq('user_id', user.id).in('id', contactIds)).data ?? []) as Row[]
      : []
    const contactById = new Map(contacts.map((c) => [c.id as string, c]))
    const paths = [...(warm_paths ?? [])]
      .sort((a, b) => Number(b.strength ?? 0) - Number(a.strength ?? 0))
      .map((w) => {
        const c = contactById.get(w.contact_id as string) ?? null
        return { ...w, contact: c ? { id: c.id, name: c.name, title: c.role, company: c.company, email: c.email, linkedin_url: c.linkedin_url } : null }
      })

    // Recover before reading. A package whose worker died is finalised HERE, on
    // the request that is about to render it, rather than waiting for a cron
    // that may not fire — which is exactly how a Rondo Energy package showed
    // "Generating…" for a day. Best-effort: a sweep that fails must never stop
    // the page from loading.
    try {
      await recoverStalePackages(user.id, { jobId: params.id })
    } catch {
      // The row stays non-terminal and the next read tries again.
    }

    // Migrations here are applied BY HAND, so there is always a window where the
    // code knows a column the database lacks. Asking for the liveness columns
    // and failing would black out the whole Package tab over a nice-to-have.
    const loadPackages = async (select: string) =>
      db
        .from('application_packages')
        .select(select)
        .eq('user_id', user.id)
        .eq('job_id', params.id)
        .order('version', { ascending: false })
    let { data: packages, error: pkgErr } = await loadPackages('id, version, status, stage, resume_filename, cover_filename, resume_docx_path, resume_pdf_path, cover_docx_path, cover_pdf_path, qa, error, created_at, updated_at, generation_started_at, generation_deadline_at, last_heartbeat_at')
    if (pkgErr) ({ data: packages } = await loadPackages('id, version, status, stage, resume_filename, cover_filename, resume_docx_path, resume_pdf_path, cover_docx_path, cover_pdf_path, qa, error, created_at, updated_at'))

    return NextResponse.json({
      job,
      sources: sources ?? [],
      snapshot: latest_snapshot ?? null,
      fit: fitOut,
      evidence_map: newest(evidence_map, 'created_at'),
      warm_paths: paths,
      feedback: [...(feedback ?? [])].sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''))),
      application: applications?.[0] ?? null,
      packages: packages ?? [],
    })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}
