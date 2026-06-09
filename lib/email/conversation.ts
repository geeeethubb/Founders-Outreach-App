import { createClient } from '@/lib/supabase/server'
import { getEmailAccount, scopeCanReadReplies } from '@/lib/email/accounts'
import { getAccessToken } from '@/lib/google/oauth'
import { getThreadView, type ThreadView } from '@/lib/email/gmail'
import type { Contact, ContactResearch, Conversation } from '@/types'

export type ConversationWithContact = Conversation & {
  contact: Contact & { research?: ContactResearch | ContactResearch[] | null }
}

export interface ConversationContext {
  conversation?: ConversationWithContact
  thread?: ThreadView | null
  accessToken?: string
  accountEmail?: string
  error?: string
  status?: number
}

/** Single contact-research row, whether Supabase returned an object or array. */
export function contactResearch(contact: { research?: ContactResearch | ContactResearch[] | null }): ContactResearch | null {
  const r = contact.research
  if (!r) return null
  return Array.isArray(r) ? (r[0] ?? null) : r
}

/**
 * Load a conversation the user owns, plus their Gmail access token and the live
 * thread (when an email_thread_id is set). Callers that only need the thread for
 * context can ignore `error`; callers that need to send must check `accessToken`.
 */
export async function loadConversationContext(
  userId: string,
  conversationId: string
): Promise<ConversationContext> {
  const supabase = createClient()
  const { data: conversation } = await supabase
    .from('conversations')
    .select('*, contact:contacts(*, research:contact_research(*))')
    .eq('id', conversationId)
    .eq('user_id', userId)
    .maybeSingle()

  if (!conversation) return { error: 'Conversation not found', status: 404 }
  const conv = conversation as ConversationWithContact

  const account = await getEmailAccount(userId)
  if (!account) return { conversation: conv, error: 'Connect your Gmail in Settings.', status: 403 }
  if (!scopeCanReadReplies(account.scope)) {
    return { conversation: conv, error: 'Reconnect Gmail in Settings to grant read access.', status: 403 }
  }

  let accessToken: string
  try {
    accessToken = await getAccessToken(account.refreshToken)
  } catch {
    return { conversation: conv, error: 'Gmail authorization failed — reconnect in Settings.', status: 401 }
  }

  let thread: ThreadView | null = null
  if (conv.email_thread_id) {
    thread = await getThreadView(accessToken, conv.email_thread_id, account.email)
  }

  return { conversation: conv, thread, accessToken, accountEmail: account.email }
}
