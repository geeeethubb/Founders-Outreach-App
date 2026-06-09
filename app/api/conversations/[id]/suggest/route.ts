import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { loadConversationContext, contactResearch } from '@/lib/email/conversation'
import { getProfile } from '@/lib/supabase/queries'
import { suggestReply } from '@/lib/ai/suggest-reply'
import type { ThreadTurn } from '@/lib/email/gmail'

// AI-draft the next reply, using the full email chain + contact research + the
// user's profile/goals as context. Optional { instruction } steers the draft.
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ctx = await loadConversationContext(user.id, params.id)
  if (!ctx.conversation) return NextResponse.json({ error: ctx.error }, { status: ctx.status ?? 404 })

  // Prefer the live Gmail thread; fall back to stored messages for context.
  let turns: ThreadTurn[] = ctx.thread?.turns ?? []
  if (turns.length === 0) {
    const { data: msgs } = await supabase
      .from('messages')
      .select('id, direction, subject, body, sent_at')
      .eq('conversation_id', params.id)
      .order('sent_at', { ascending: true })
    turns = (msgs ?? []).map((m) => ({
      id: m.id,
      direction: (m.direction as 'inbound' | 'outbound') ?? 'inbound',
      fromName: '',
      fromEmail: '',
      subject: m.subject ?? '',
      date: m.sent_at,
      body: m.body ?? '',
    }))
  }

  if (turns.length === 0) {
    return NextResponse.json({ error: 'No messages in this conversation yet to base a reply on.' }, { status: 400 })
  }

  let instruction: string | undefined
  try {
    const json = (await request.json()) as { instruction?: string }
    instruction = json.instruction?.trim() || undefined
  } catch {
    // no body — fine
  }

  const profile = await getProfile(user.id)

  try {
    const result = await suggestReply({
      thread: turns,
      contact: ctx.conversation.contact,
      research: contactResearch(ctx.conversation.contact),
      profile,
      status: ctx.conversation.status,
      instruction,
    })
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to generate a reply' },
      { status: 500 }
    )
  }
}
