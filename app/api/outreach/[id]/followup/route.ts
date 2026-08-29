import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { runFollowUp } from '@/lib/agents/followup'
import { getOutreach, patchOutreach, MigrationMissingError } from '@/lib/outreach/store'
import { checkGrounding } from '@/lib/outreach/grounding'
import { anthropicUsage, resetAnthropicUsage } from '@/lib/providers/anthropic/client'
import { resolveSender } from '@/lib/outreach/sender'

export const maxDuration = 120

/** One automatic suggested follow-up per cold outreach. Enforced here, in code. */
const MAX_FOLLOWUPS = 1

/** Below this, silence is not yet information. */
const MIN_DAYS_BEFORE_FOLLOWUP = 4

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const row = await getOutreach(user.id, params.id)
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    if (row.state !== 'sent') {
      return NextResponse.json(
        { error: `Follow-ups are for sent, unanswered outreach — this one is ${row.state}.` },
        { status: 409 }
      )
    }
    if (row.replied_at) {
      return NextResponse.json({ error: 'They replied. Use the conversation view.' }, { status: 409 })
    }
    if ((row.followup_count ?? 0) >= MAX_FOLLOWUPS) {
      return NextResponse.json(
        { error: 'This outreach has already had its one follow-up suggestion.' },
        { status: 409 }
      )
    }

    const days = row.sent_at
      ? Math.floor((Date.now() - new Date(row.sent_at).getTime()) / 86_400_000)
      : 0
    if (days < MIN_DAYS_BEFORE_FOLLOWUP) {
      return NextResponse.json(
        { error: `Only ${days} day${days === 1 ? '' : 's'} since sending — give it at least ${MIN_DAYS_BEFORE_FOLLOWUP}.` },
        { status: 409 }
      )
    }

    const service = createServiceClient()
    const { data: contact } = await service
      .from('contacts')
      .select('name, role, company')
      .eq('id', row.contact_id)
      .maybeSingle()

    const positioning = (row.positioning ?? {}) as Record<string, unknown>
    const sender = await resolveSender(user.id)

    resetAnthropicUsage()
    const result = await runFollowUp(
      {
        mission: { goal: row.mission_goal ?? 'Build relevant professional relationships', timeframe: 'Winter 2026-27' },
        sender: { name: sender.name },
        person: {
          name: contact?.name ?? 'the recipient',
          firstName: (contact?.name ?? '').split(' ')[0] || 'there',
          title: contact?.role ?? row.recipient_role,
          company: contact?.company ?? row.company_type ?? 'their company',
        },
        originalSubject: row.subject ?? '',
        originalBody: row.body_edited ?? row.body ?? '',
        daysSinceSent: days,
        originalAsk: row.cta ?? String(positioning.recommended_ask ?? 'a short conversation'),
        alternateAngle: null,
        groundedFacts: row.allowed_claims ?? [],
      },
      {
        user_id: user.id,
        run_id: null,
        budget: { maxCompanies: 0, maxPeoplePerCompany: 0, maxApolloCalls: 0, maxWebSearches: 0, maxAgentSteps: 4 },
      }
    )

    if (!result.output) {
      return NextResponse.json({ error: `Follow-up agent failed: ${result.error}` }, { status: 502 })
    }

    const suggestion = result.output
    const grounding = suggestion.body
      ? checkGrounding({
          subject: suggestion.subject ?? '',
          body: suggestion.body,
          evidence: row.allowed_claims ?? [],
          safeNames: [contact?.name ?? '', contact?.company ?? '', sender.name].filter(Boolean),
        })
      : null

    const dueAt =
      suggestion.should_follow_up && suggestion.send_after_days && row.sent_at
        ? new Date(new Date(row.sent_at).getTime() + suggestion.send_after_days * 86_400_000).toISOString()
        : null

    // The counter increments even on a "do not send" verdict. The cap is on the
    // number of times this is ASKED, otherwise a no can be re-rolled into a yes.
    await patchOutreach(user.id, params.id, {
      followup_count: (row.followup_count ?? 0) + 1,
      followup_suggestion: { ...suggestion, grounding, generated_at: new Date().toISOString() },
      followup_due_at: dueAt,
    })

    const usage = anthropicUsage()
    return NextResponse.json({
      suggestion,
      grounding,
      dueAt,
      usage: { costUsd: Number(usage.costUsd.toFixed(4)), calls: usage.calls },
    })
  } catch (error) {
    if (error instanceof MigrationMissingError) {
      return NextResponse.json({ error: error.message, migrationMissing: true }, { status: 503 })
    }
    console.error('Follow-up agent failed:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Follow-up agent failed' },
      { status: 500 }
    )
  }
}
