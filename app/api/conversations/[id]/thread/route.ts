import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { loadConversationContext } from '@/lib/email/conversation'
import type { ThreadTurn } from '@/lib/email/gmail'

// The full email chain for a conversation, for the detail view. Prefers the live
// Gmail thread; falls back to stored messages when Gmail is unavailable.
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ctx = await loadConversationContext(user.id, params.id)
  if (!ctx.conversation) return NextResponse.json({ error: ctx.error }, { status: ctx.status ?? 404 })

  if (ctx.thread && ctx.thread.turns.length > 0) {
    return NextResponse.json({ turns: ctx.thread.turns, source: 'gmail' })
  }

  // Fallback: render what we stored (inbound replies + any logged outbound).
  const { data: msgs } = await supabase
    .from('messages')
    .select('id, direction, subject, body, sent_at')
    .eq('conversation_id', params.id)
    .order('sent_at', { ascending: true })

  const turns: ThreadTurn[] = (msgs ?? []).map((m) => ({
    id: m.id,
    direction: (m.direction as 'inbound' | 'outbound') ?? 'inbound',
    fromName: '',
    fromEmail: '',
    subject: m.subject ?? '',
    date: m.sent_at,
    body: m.body ?? '',
  }))

  return NextResponse.json({ turns, source: 'db', warning: ctx.error })
}
