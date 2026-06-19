import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getProfile } from '@/lib/supabase/queries'
import { generateCampaignFeedback } from '@/lib/ai/campaign-feedback'
import type { CampaignStats } from '@/types'

export const maxDuration = 60

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const campaignId = params.id

    const { data: campaign } = await supabase
      .from('campaigns')
      .select('id, name, goal')
      .eq('id', campaignId)
      .eq('user_id', user.id)
      .single()
    if (!campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })

    // Members (status + research presence), this campaign's emails, and the
    // conversations of its members — everything we need to roll up and ground.
    const [{ data: memberRows }, { data: emailRows }] = await Promise.all([
      supabase
        .from('campaign_contacts')
        .select('contact_id, contact:contacts(id, status, research:contact_research(contact_id))')
        .eq('campaign_id', campaignId),
      supabase
        .from('emails')
        .select('contact_id, status, subject, body, sent_at')
        .eq('campaign_id', campaignId)
        .eq('user_id', user.id),
    ])

    const members = (memberRows ?? []) as unknown as {
      contact_id: string
      contact: { id: string; status: string; research: unknown[] | null } | null
    }[]
    const emails = (emailRows ?? []) as {
      contact_id: string
      status: string
      subject: string | null
      body: string | null
      sent_at: string | null
    }[]

    const memberIds = members.map((m) => m.contact_id)
    const sentEmails = emails.filter((e) => e.status === 'sent')

    if (sentEmails.length === 0) {
      return NextResponse.json(
        { error: 'No sent emails in this campaign yet — send some outreach first, then come back for feedback.' },
        { status: 400 }
      )
    }

    const emailedContacts = new Set(sentEmails.map((e) => e.contact_id))

    // Pull reply data for the contacts actually emailed under this campaign.
    const { data: convRows } = memberIds.length
      ? await supabase
          .from('conversations')
          .select('contact_id, status, messages(direction, body, classification)')
          .eq('user_id', user.id)
          .in('contact_id', Array.from(emailedContacts))
      : { data: [] }

    const conversations = (convRows ?? []) as {
      contact_id: string
      status: string
      messages: { direction: string; body: string | null; classification: string | null }[] | null
    }[]

    const repliedContacts = new Set<string>()
    let positiveReplies = 0
    const replyExamples: { snippet: string; classification: string | null }[] = []
    for (const conv of conversations) {
      const inbound = (conv.messages ?? []).filter((m) => m.direction === 'inbound')
      if (inbound.length === 0) continue
      repliedContacts.add(conv.contact_id)
      if (inbound.some((m) => m.classification === 'positive')) positiveReplies++
      for (const m of inbound) {
        if (m.body && replyExamples.length < 8) {
          replyExamples.push({ snippet: m.body.replace(/\s+/g, ' ').trim(), classification: m.classification })
        }
      }
    }

    const meetings = conversations.filter((c) => c.status === 'meeting_booked').length
    const researched = members.filter((m) => (m.contact?.research?.length ?? 0) > 0).length

    const stats: CampaignStats = {
      total_contacts: members.length,
      researched,
      emails_sent: sentEmails.length,
      contacts_emailed: emailedContacts.size,
      replies: repliedContacts.size,
      positive_replies: positiveReplies,
      meetings,
      reply_rate: emailedContacts.size > 0
        ? Math.round((repliedContacts.size / emailedContacts.size) * 100)
        : 0,
    }

    // Most recent sent emails make the best sample.
    const emailSamples = [...sentEmails]
      .sort((a, b) => (b.sent_at ?? '').localeCompare(a.sent_at ?? ''))
      .slice(0, 12)
      .map((e) => ({ subject: e.subject, body: e.body }))

    const profile = await getProfile(user.id)

    const feedback = await generateCampaignFeedback({
      campaign: { name: campaign.name, goal: campaign.goal },
      stats,
      emailSamples,
      replyExamples,
      profile,
    })

    return NextResponse.json({ feedback, stats })
  } catch (error) {
    console.error('Campaign feedback error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to generate feedback' },
      { status: 500 }
    )
  }
}
