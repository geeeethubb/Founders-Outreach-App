import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { listOutreach, MigrationMissingError } from '@/lib/outreach/store'
import { buildFunnel, type FunnelRow } from '@/lib/outreach/funnel'
import type { OutreachState } from '@/lib/outreach/states'

/**
 * The review queue and the funnel.
 *
 * `?funnel=1` adds the analytics; the queue itself is the default because that
 * is what the page opens on.
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const url = new URL(request.url)
    const statesParam = url.searchParams.get('states')
    const states = statesParam ? (statesParam.split(',') as OutreachState[]) : undefined

    const rows = await listOutreach(user.id, { states })

    const body: Record<string, unknown> = {
      outreach: rows.map((r) => ({
        id: r.id,
        contactId: r.contact_id,
        state: r.state,
        name: r.contact?.name ?? 'Unknown',
        email: r.contact?.email ?? null,
        title: r.contact?.role ?? r.recipient_role,
        company: r.contact?.company ?? r.company_type,
        subject: r.subject,
        body: r.body_edited ?? r.body,
        originalBody: r.body,
        edited: r.body_edited !== null,
        wordCount: r.word_count,
        angle: r.angle,
        proofPointIds: r.proof_point_ids,
        cta: r.cta,
        grounding: r.grounding,
        score: r.score,
        sentAt: r.sent_at,
        sendError: r.send_error,
        repliedAt: r.replied_at,
        replyClassification: r.reply_classification,
        replyAction: r.reply_action,
        replySummary: r.reply_summary,
        suggestedReply: r.suggested_reply,
        followupCount: r.followup_count,
        followupSuggestion: r.followup_suggestion,
        outcome: r.outcome,
        outcomeNote: r.outcome_note,
        positioning: r.positioning,
        createdAt: r.created_at,
      })),
    }

    if (url.searchParams.get('funnel')) {
      const all = states ? await listOutreach(user.id) : rows
      const scouted = Number(url.searchParams.get('scouted') ?? 0)
      body.funnel = buildFunnel(all as unknown as FunnelRow[], scouted)
    }

    return NextResponse.json(body)
  } catch (error) {
    if (error instanceof MigrationMissingError) {
      return NextResponse.json({ error: error.message, migrationMissing: true }, { status: 503 })
    }
    console.error('Outreach list failed:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not load outreach' },
      { status: 500 }
    )
  }
}
