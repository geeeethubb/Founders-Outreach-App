import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { seedEvidenceFromDocx, summarizeSeed } from '@/lib/career/evidence/seed'
import { isDynamicUsage } from '@/lib/http/dynamic'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const MAX_BYTES = 5 * 1024 * 1024

/**
 * Multipart: `file` (.docx), `as_master` ('true' | 'false'), `approve`,
 * `include_profile` ('true' also imports the My Profile free text as a second source).
 * Saves the document, then seeds experiences, bullets and the importer's
 * proposals from it. An alternate (as_master=false) is stored but its bullets
 * are not marked on-master.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const form = await request.formData()
    const file = form.get('file')
    if (!(file instanceof File)) return NextResponse.json({ error: "multipart field 'file' required" }, { status: 400 })
    if (!file.name.toLowerCase().endsWith('.docx')) return NextResponse.json({ error: 'Only .docx is accepted.' }, { status: 400 })
    if (file.size > MAX_BYTES) return NextResponse.json({ error: 'File is larger than 5 MB.' }, { status: 413 })
    const asMaster = String(form.get('as_master') ?? 'true') !== 'false'
    const approve = String(form.get('approve') ?? 'false') === 'true'
    const includeProfile = String(form.get('include_profile') ?? 'false') === 'true'

    if (!asMaster) {
      return NextResponse.json({ error: 'Alternate résumés are not imported yet — upload as master.' }, { status: 400 })
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    const result = await seedEvidenceFromDocx(user.id, buffer, { approve, includeProfile, filename: file.name })
    if (result.migrationMissing) {
      return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first.', migrationMissing: true }, { status: 409 })
    }
    return NextResponse.json({ ok: result.ok, counts: result.counts, dropped: result.dropped, costUsd: result.costUsd, errors: result.errors, summary: summarizeSeed(result) })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Upload failed' }, { status: 500 })
  }
}
