import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { runConversation } from '@/lib/agents/conversation'
import { getOutreach, patchOutreach, transition, MigrationMissingError } from '@/lib/outreach/store'
import { latestInbound, threadMessages } from '@/lib/outreach/replies'
import { stateForClassification } from '@/lib/outreach/states'
import { checkGrounding } from '@/lib/outreach/grounding'
import { evidenceForReply } from '@/lib/outreach/evidence'
import { anthropicUsage, resetAnthropicUsage } from '@/lib/providers/anthropic/client'
import { resolveSender } from '@/lib/outreach/sender'

export const maxDuration = 120

/**
 * Interpret the newest reply and suggest a response.
 *
 * The agent classifies; the code moves state. Nothing is sent — the suggestion
 * lands in `suggested_reply` for a human to approve, per the milestone brief and
 * ARCHITECTURE §10.
 */
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
    if (!row.conversation_id) {
      return NextResponse.json(
        { error: 'No reply has been linked to this outreach yet. Sync replies first.' },
        { status: 409 }
      )
    }

    const reply = await latestInbound(row.conversation_id)
    if (!reply) {
      return NextResponse.json({ error: 'No inbound message found in this thread.' }, { status: 409 })
    }

    const service = createServiceClient()
    const { data: contact } = await service
      .from('contacts')
      .select('name, role, company')
      .eq('id', row.contact_id)
      .maybeSingle()

    const thread = await threadMessages(row.conversation_id)
    const sender = await resolveSender(user.id)

    resetAnthropicUsage()
    const result = await runConversation(
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
        thread: thread.map((m) => ({ direction: m.direction, body: m.body })),
        reply: reply.body,
        groundedFacts: row.allowed_claims ?? [],
      },
      {
        user_id: user.id,
        run_id: null,
        budget: { maxCompanies: 0, maxPeoplePerCompany: 0, maxApolloCalls: 0, maxWebSearches: 0, maxAgentSteps: 4 },
      }
    )

    if (!result.output) {
      return NextResponse.json({ error: `Could not interpret the reply: ${result.error}` }, { status: 502 })
    }

    const verdict = result.output

    // The suggested response is held to the same standard as the original. A
    // warm reply invites embellishment, which is exactly when grounding slips.
    const grounding = verdict.suggested_body
      ? checkGrounding({
          subject: verdict.suggested_subject ?? '',
          body: verdict.suggested_body,
          // Their own words count as evidence — a referral cannot be answered
          // without naming the person they just named.
          evidence: evidenceForReply(row.allowed_claims ?? [], reply.body),
          safeNames: [contact?.name ?? '', contact?.company ?? '', sender.name].filter(Boolean),
        })
      : null

    await patchOutreach(user.id, params.id, {
      reply_classification: verdict.classification,
      reply_action: verdict.action,
      reply_summary: verdict.summary,
      suggested_reply: {
        subject: verdict.suggested_subject,
        body: verdict.suggested_body,
        confidence: verdict.confidence,
        reasoning: verdict.reasoning,
        follow_up_after_days: verdict.follow_up_after_days,
        grounding,
        generated_at: new Date().toISOString(),
      },
    })

    // Classification -> state is a lookup, not a judgement (states.ts).
    const target = stateForClassification(verdict.classification, row.state)
    let state = row.state
    if (target !== row.state) {
      try {
        const moved = await transition(user.id, params.id, target, 'agent', {})
        state = moved.state
      } catch {
        // An illegal transition means the human already moved it somewhere more
        // specific. Their decision wins; the classification is still recorded.
      }
    }

    const usage = anthropicUsage()
    return NextResponse.json({
      verdict,
      grounding,
      state,
      reply: { body: reply.body.slice(0, 4000), sentAt: reply.sentAt },
      usage: { costUsd: Number(usage.costUsd.toFixed(4)), calls: usage.calls },
    })
  } catch (error) {
    if (error instanceof MigrationMissingError) {
      return NextResponse.json({ error: error.message, migrationMissing: true }, { status: 503 })
    }
    console.error('Conversation agent failed:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Conversation agent failed' },
      { status: 500 }
    )
  }
}
