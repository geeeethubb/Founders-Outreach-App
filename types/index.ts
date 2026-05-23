export type OutreachCategory =
  | 'speaker'
  | 'mentor'
  | 'recruiter'
  | 'investor'
  | 'peer'
  | 'partner'

export type ContactStatus =
  | 'new'
  | 'researching'
  | 'researched'
  | 'drafted'
  | 'sent'
  | 'replied'
  | 'meeting'
  | 'archived'

export type EmailStatus = 'draft' | 'scheduled' | 'sent' | 'failed'

export type ConversationStatus =
  | 'open'
  | 'meeting_booked'
  | 'closed_positive'
  | 'closed_negative'
  | 'ghosted'

export type ReplyClassification =
  | 'positive'
  | 'negative'
  | 'neutral'
  | 'auto_reply'
  | 'bounce'

export type HookType = 'accomplishment' | 'shared_context' | 'value_prop'

// ─── Database Row Types ───────────────────────────────────────────────────────

export interface Profile {
  id: string
  name: string | null
  email: string | null
  linkedin_url: string | null
  bio: string | null
  company: string | null
  role: string | null
  goals: string[] | null
  created_at: string
}

export interface Contact {
  id: string
  user_id: string
  name: string
  email: string | null
  linkedin_url: string | null
  twitter_handle: string | null
  company: string | null
  role: string | null
  location: string | null
  source: string
  status: ContactStatus
  priority: number
  tags: string[] | null
  notes: string | null
  created_at: string
  updated_at: string
  // joined
  research?: ContactResearch | null
}

export interface ContactResearch {
  id: string
  contact_id: string
  raw_linkedin: Record<string, unknown> | null
  raw_twitter: Record<string, unknown> | null
  raw_web: Record<string, unknown> | null
  summary: string | null
  hooks: string[] | null
  shared_context: string[] | null
  relevance_score: number | null
  category: OutreachCategory | null
  suggested_ask: string | null
  researched_at: string
  model_used: string | null
}

export interface Campaign {
  id: string
  user_id: string
  name: string
  goal: string | null
  status: 'active' | 'paused' | 'completed'
  total_contacts: number
  created_at: string
}

export interface Email {
  id: string
  user_id: string
  contact_id: string
  campaign_id: string | null
  template_id: string | null
  subject: string | null
  body: string | null
  variant_label: 'A' | 'B' | 'C' | null
  status: EmailStatus
  scheduled_for: string | null
  sent_at: string | null
  resend_message_id: string | null
  generation_metadata: GenerationMetadata | null
  created_at: string
  // joined
  contact?: Contact
}

export interface GenerationMetadata {
  model: string
  prompt_version: string
  hooks_used: string[]
  hook_type: HookType
  word_count: number
  outreach_goal: string
}

export interface EmailEvent {
  id: string
  email_id: string
  event_type: 'opened' | 'clicked' | 'replied' | 'bounced' | 'complained' | 'delivered'
  occurred_at: string
  metadata: Record<string, unknown> | null
}

export interface Conversation {
  id: string
  user_id: string
  contact_id: string
  email_thread_id: string | null
  status: ConversationStatus
  outcome: string | null
  last_message_at: string | null
  meeting_at: string | null
  created_at: string
  // joined
  contact?: Contact
  messages?: Message[]
}

export interface Message {
  id: string
  conversation_id: string
  direction: 'outbound' | 'inbound'
  subject: string | null
  body: string | null
  classification: ReplyClassification | null
  sent_at: string | null
  created_at: string
}

export interface Template {
  id: string
  user_id: string
  name: string | null
  category: OutreachCategory | null
  subject_template: string | null
  body_template: string | null
  variables: string[] | null
  is_active: boolean
  created_at: string
}

export interface TemplatePerformance {
  id: string
  template_id: string
  emails_sent: number
  opens: number
  replies: number
  positive_replies: number
  meetings_booked: number
  open_rate: number | null
  reply_rate: number | null
  positive_rate: number | null
  updated_at: string
}

// ─── API Payload Types ────────────────────────────────────────────────────────

export interface ResearchRequest {
  contact_id: string
  name: string
  company?: string
  role?: string
  linkedin_url?: string
  pasted_bio?: string   // user can paste raw LinkedIn text
}

export interface ResearchResult {
  summary: string
  hooks: string[]
  shared_context: string[]
  relevance_score: number
  category: OutreachCategory
  suggested_ask: string
}

export interface GenerateRequest {
  contact_id: string
  outreach_goal: 'speaker' | 'mentor' | 'jobs' | 'investor_intro'
  custom_note?: string
}

export interface EmailVariant {
  label: 'A' | 'B' | 'C'
  subject: string
  body: string
  hook_type: HookType
  hook_used: string
  word_count: number
}

export interface GenerateResult {
  variants: EmailVariant[]
}

export interface SendRequest {
  email_id: string
  to_email: string
  to_name: string
  subject: string
  body: string
  schedule_at?: string
}

// ─── UI State Types ───────────────────────────────────────────────────────────

export interface DashboardStats {
  total_contacts: number
  researched: number
  emails_sent: number
  replies: number
  meetings: number
  reply_rate: number
}
