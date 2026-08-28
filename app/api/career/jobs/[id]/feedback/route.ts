import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { isMissingSchema, recordFeedback } from '@/lib/career/jobs/store'
import { FEEDBACK_REASONS, type FeedbackReason, type FeedbackVerdict } from '@/lib/career/types'

export const dynamic = 'force-dynamic'

const VERDICTS: FeedbackVerdict[] = ['LOVE', 'INTERESTED', 'MAYBE', 'NOT_INTERESTED']

/** POST { verdict, reasons[], note? } → { feedback: { id, verdict, reasons, note }, disposition } */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = ((await request.json().catch(() => ({}))) ?? {}) as { verdict?: string; reasons?: unknown; note?: string | null }
    if (!VERDICTS.includes(body.verdict as FeedbackVerdict)) return NextResponse.json({ error: `verdict must be one of ${VERDICTS.join(', ')}` }, { status: 400 })
    const verdict = body.verdict as FeedbackVerdict
    const reasons = (Array.isArray(body.reasons) ? body.reasons : []).filter((r): r is FeedbackReason => FEEDBACK_REASONS.includes(r as FeedbackReason))
    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 2000) : null

    // Before migration 014 this select fails on the missing table; say so rather than "not found".
    const { data: job, error: lookupError } = await supabase.from('job_opportunities').select('id').eq('user_id', user.id).eq('id', params.id).maybeSingle()
    if (lookupError && isMissingSchema(lookupError.message)) return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true }, { status: 409 })
    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

    const r = await recordFeedback(user.id, params.id, verdict, reasons, note)
    if (r.error) {
      if (isMissingSchema(r.error)) return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true }, { status: 409 })
      return NextResponse.json({ error: r.error }, { status: 500 })
    }
    const disposition = verdict === 'NOT_INTERESTED' ? 'dismissed' : verdict === 'MAYBE' ? null : 'saved'
    return NextResponse.json({ feedback: { id: r.id, verdict, reasons, note }, disposition })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}
