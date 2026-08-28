import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { loadDocument } from '@/lib/career/documents/store'
import { seedEvidenceFromDocx, seedEvidenceFromText, summarizeSeed } from '@/lib/career/evidence/seed'
import { isDynamicUsage } from '@/lib/http/dynamic'
import type { FactSource, ResumeDocument } from '@/lib/career/types'

export const dynamic = 'force-dynamic'
// One importer run over a full résumé is a long single model turn.
export const maxDuration = 300

const TEXT_SOURCES: FactSource[] = ['linkedin', 'profile', 'manual', 'alternate_resume', 'project_notes']

/**
 * `{ mode: 'master', approve?, includeProfile? }` re-imports from the stored
 * master document. `{ mode: 'text', text, source?, approve? }` imports pasted
 * text. Nothing here reads the founder's local Zuyu_Resume.docx — the master
 * has to have been uploaded (or seeded by `npm run career:seed`) first.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = (await request.json().catch(() => ({}))) as {
      mode?: string
      text?: string
      source?: string
      approve?: boolean
      includeProfile?: boolean
    }
    const approve = body.approve === true

    if (body.mode === 'text') {
      const text = String(body.text ?? '').trim()
      if (text.length < 40) return NextResponse.json({ error: 'Paste at least a few lines of text.' }, { status: 400 })
      const source = TEXT_SOURCES.includes(body.source as FactSource) ? (body.source as FactSource) : 'manual'
      const result = await seedEvidenceFromText(user.id, text, source, { approve })
      if (result.migrationMissing) {
        return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first.', migrationMissing: true }, { status: 409 })
      }
      return NextResponse.json({ ok: result.ok, counts: result.counts, dropped: result.dropped, costUsd: result.costUsd, errors: result.errors, summary: summarizeSeed(result) })
    }

    if (body.mode !== 'master') return NextResponse.json({ error: "mode must be 'master' or 'text'" }, { status: 400 })

    const service = createServiceClient()
    const { data: docs, error } = await service
      .from('resume_documents')
      .select('*')
      .eq('user_id', user.id)
      .eq('is_master', true)
      .order('uploaded_at', { ascending: false })
      .limit(1)
    if (error) {
      const missing = /relation .* does not exist|schema cache|could not find/i.test(error.message)
      return NextResponse.json(
        { error: missing ? 'Apply supabase/migrations/014_career_os.sql first.' : error.message, migrationMissing: missing },
        { status: missing ? 409 : 500 }
      )
    }
    const master = (docs ?? [])[0] as ResumeDocument | undefined
    if (!master?.storage_path) {
      return NextResponse.json({ error: 'No master résumé stored yet. Upload one, or run npm run career:seed.' }, { status: 400 })
    }
    const buffer = await loadDocument(master.storage_path)
    if (!buffer) return NextResponse.json({ error: `Master document bytes not found at ${master.storage_path}.` }, { status: 404 })

    const result = await seedEvidenceFromDocx(user.id, buffer, {
      approve,
      includeProfile: body.includeProfile === true,
      filename: master.filename,
    })
    if (result.migrationMissing) {
      return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first.', migrationMissing: true }, { status: 409 })
    }
    return NextResponse.json({ ok: result.ok, counts: result.counts, dropped: result.dropped, costUsd: result.costUsd, errors: result.errors, summary: summarizeSeed(result) })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Import failed' }, { status: 500 })
  }
}
