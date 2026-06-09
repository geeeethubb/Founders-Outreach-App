import { createClient } from './server'
import type { Contact, Campaign, Email, Conversation, DashboardStats, Profile } from '@/types'

// ─── Profile ─────────────────────────────────────────────────────────────────

export async function getProfile(userId: string): Promise<Profile | null> {
  const supabase = createClient()
  const { data } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single()
  return data
}

export async function upsertProfile(profile: Partial<Profile> & { id: string }) {
  const supabase = createClient()
  return supabase.from('profiles').upsert(profile)
}

// ─── Contacts ────────────────────────────────────────────────────────────────

export async function getContacts(userId: string): Promise<Contact[]> {
  const supabase = createClient()
  const { data, error } = await supabase
    .from('contacts')
    .select(`*, research:contact_research(*)`)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })

  if (error) throw error
  return (data ?? []) as Contact[]
}

export async function getContact(contactId: string): Promise<Contact | null> {
  const supabase = createClient()
  const { data, error } = await supabase
    .from('contacts')
    .select(`*, research:contact_research(*)`)
    .eq('id', contactId)
    .single()

  if (error) return null
  return data as Contact
}

export async function createContact(
  contact: Omit<Contact, 'id' | 'created_at' | 'updated_at'>
) {
  const supabase = createClient()
  const { data, error } = await supabase
    .from('contacts')
    .insert(contact)
    .select()
    .single()
  if (error) throw error
  return data as Contact
}

export async function updateContactStatus(
  contactId: string,
  status: Contact['status']
) {
  const supabase = createClient()
  return supabase.from('contacts').update({ status }).eq('id', contactId)
}

export async function upsertResearch(research: {
  contact_id: string
  summary: string
  hooks: string[]
  shared_context: string[]
  relevance_score: number
  fit_reason?: string
  category: string
  suggested_ask: string
  model_used: string
}) {
  const supabase = createClient()
  return supabase
    .from('contact_research')
    .upsert({ ...research, researched_at: new Date().toISOString() })
}

// ─── Campaigns ───────────────────────────────────────────────────────────────

export async function getCampaigns(userId: string): Promise<Campaign[]> {
  const supabase = createClient()
  const { data, error } = await supabase
    .from('campaigns')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

export async function createCampaign(
  campaign: Omit<Campaign, 'id' | 'created_at' | 'total_contacts'>
) {
  const supabase = createClient()
  const { data, error } = await supabase
    .from('campaigns')
    .insert(campaign)
    .select()
    .single()
  if (error) throw error
  return data as Campaign
}

// ─── Emails ──────────────────────────────────────────────────────────────────

export async function getEmails(userId: string): Promise<Email[]> {
  const supabase = createClient()
  const { data, error } = await supabase
    .from('emails')
    .select(`*, contact:contacts(name, email, company)`)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as Email[]
}

/**
 * Most recent email actually sent to a contact — used to thread a follow-up
 * onto the original message (Re: subject + In-Reply-To / References headers).
 */
export async function getLatestSentEmail(contactId: string): Promise<{
  id: string
  subject: string | null
  body: string | null
  resend_message_id: string | null
} | null> {
  const supabase = createClient()
  const { data } = await supabase
    .from('emails')
    .select('id, subject, body, resend_message_id')
    .eq('contact_id', contactId)
    .eq('status', 'sent')
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data
}

export async function createEmail(
  email: Omit<Email, 'id' | 'created_at'>
) {
  const supabase = createClient()
  const { data, error } = await supabase
    .from('emails')
    .insert(email)
    .select()
    .single()
  if (error) throw error
  return data as Email
}

export async function updateEmailStatus(
  emailId: string,
  status: Email['status'],
  resendMessageId?: string,
  gmailThreadId?: string
) {
  const supabase = createClient()
  return supabase
    .from('emails')
    .update({
      status,
      ...(resendMessageId && { resend_message_id: resendMessageId }),
      ...(gmailThreadId && { gmail_thread_id: gmailThreadId }),
      ...(status === 'sent' && { sent_at: new Date().toISOString() }),
    })
    .eq('id', emailId)
}

// ─── Conversations ───────────────────────────────────────────────────────────

export async function getConversations(userId: string): Promise<Conversation[]> {
  const supabase = createClient()
  const { data, error } = await supabase
    .from('conversations')
    .select(`*, contact:contacts(name, email, company, status)`)
    .eq('user_id', userId)
    .order('last_message_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as Conversation[]
}

// ─── Dashboard Stats ─────────────────────────────────────────────────────────

export async function getDashboardStats(userId: string): Promise<DashboardStats> {
  const supabase = createClient()

  const [contacts, emails, conversations] = await Promise.all([
    supabase.from('contacts').select('status').eq('user_id', userId),
    supabase.from('emails').select('status').eq('user_id', userId),
    // Replies/meetings come from synced Gmail conversations (see lib/email/sync.ts).
    supabase.from('conversations').select('status, messages(direction)').eq('user_id', userId),
  ])

  const contactRows = contacts.data ?? []
  const emailRows = emails.data ?? []
  const convRows = (conversations.data ?? []) as Array<{
    status: string
    messages: Array<{ direction: string }> | null
  }>

  const sent = emailRows.filter((e) => e.status === 'sent').length
  // A reply = a conversation that has at least one inbound message.
  const replies = convRows.filter((c) => (c.messages ?? []).some((m) => m.direction === 'inbound')).length
  const meetings = convRows.filter((c) => c.status === 'meeting_booked').length

  return {
    total_contacts: contactRows.length,
    researched: contactRows.filter((c) =>
      ['researched', 'drafted', 'sent', 'replied', 'meeting'].includes(c.status)
    ).length,
    emails_sent: sent,
    replies,
    meetings,
    reply_rate: sent > 0 ? Math.round((replies / sent) * 100) : 0,
  }
}
