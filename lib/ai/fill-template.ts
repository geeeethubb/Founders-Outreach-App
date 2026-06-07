import OpenAI from 'openai'
import type { Contact, ContactResearch, Profile, Template } from '@/types'
import { getLatestSentEmail } from '@/lib/supabase/queries'
import { followupSubject } from '@/lib/utils'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export interface PreviousEmail {
  subject: string | null
  body: string | null
}

export async function fillEmailTemplate(
  template: Pick<Template, 'subject_template' | 'body_template' | 'name'>,
  contact: Contact,
  research: ContactResearch | null,
  senderName: string,
  senderProfile?: Profile | null,
  previousEmail?: PreviousEmail | null
): Promise<{ subject: string; body: string }> {
  const systemPrompt = buildSystemPrompt(!!previousEmail)
  const userPrompt = buildUserPrompt(template, contact, research, senderName, senderProfile, previousEmail)

  const response = await openai.chat.completions.create({
    model: 'gpt-5.4',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.7,
    max_completion_tokens: 1200,
  })

  const raw = response.choices[0].message.content ?? '{}'
  try {
    const parsed = JSON.parse(raw) as { subject: string; body: string }
    return parsed
  } catch {
    throw new Error('Failed to parse template fill response')
  }
}

/**
 * Build an outbound email from a template for one contact, handling both
 * "initial" and "followup" template types.
 *
 * For follow-ups we thread onto the most recent email actually sent to this
 * contact: the AI is given that email's text, the subject becomes "Re: …", and
 * `replyToEmailId` is returned so the draft can be linked for header threading
 * at send time. If there's nothing to follow up on, returns { ok: false }.
 */
export async function buildEmailFromTemplate(opts: {
  template: Pick<Template, 'subject_template' | 'body_template' | 'name' | 'type'>
  contact: Contact
  research: ContactResearch | null
  senderName: string
  senderProfile?: Profile | null
}): Promise<
  | { ok: true; subject: string; body: string; replyToEmailId: string | null }
  | { ok: false; reason: string }
> {
  const { template, contact, research, senderName, senderProfile } = opts

  if (template.type === 'followup') {
    const prev = await getLatestSentEmail(contact.id)
    if (!prev) {
      return { ok: false, reason: 'No prior email to follow up on' }
    }
    const filled = await fillEmailTemplate(template, contact, research, senderName, senderProfile, {
      subject: prev.subject,
      body: prev.body,
    })
    return {
      ok: true,
      subject: followupSubject(prev.subject),
      body: filled.body,
      replyToEmailId: prev.id,
    }
  }

  const filled = await fillEmailTemplate(template, contact, research, senderName, senderProfile)
  return { ok: true, subject: filled.subject, body: filled.body, replyToEmailId: null }
}

function buildSystemPrompt(isFollowUp: boolean): string {
  const followUpRules = isFollowUp
    ? `

THIS IS A FOLLOW-UP to an email the sender already sent this recipient (shown below under
"PREVIOUS EMAIL YOU SENT"). The recipient did not reply yet.
- Reference the original note naturally in roughly one line (e.g. "circling back on my note about…").
- Do NOT restate the original email in full — they already have it in the thread.
- Keep it short, warm, and low-pressure. Add a small fresh reason to reply if the template asks for one.
- Any placeholder that mentions "previous email" must be filled from the PREVIOUS EMAIL section.`
    : ''

  return `You are filling in placeholders in a cold email template. The template is the sender's personal writing style — preserve it exactly.

RULES:
1. Keep EVERYTHING outside of [square brackets] word-for-word — do not rephrase, reorder, or change anything
2. Replace each [placeholder instruction] with specific, natural content that flows seamlessly
3. Use the contact research to make replacements highly specific — no generic filler
4. Match the tone and length implied by the placeholder text
5. If a placeholder says "relevant to their experience" — use 1–2 specific facts from their research
6. If a placeholder says "my accomplishments" — pick the most relevant things from the sender's background
7. No [brackets] may remain in the output under any circumstances
8. Do NOT add a signature — the sender writes their own in the template${followUpRules}

Return ONLY valid JSON:
{ "subject": "...", "body": "..." }`
}

function buildUserPrompt(
  template: Pick<Template, 'subject_template' | 'body_template' | 'name'>,
  contact: Contact,
  research: ContactResearch | null,
  senderName: string,
  senderProfile?: Profile | null,
  previousEmail?: PreviousEmail | null
): string {
  const parts: string[] = []

  parts.push(`=== TEMPLATE TO FILL: "${template.name}" ===`)
  if (template.subject_template) {
    parts.push(`Subject line template: ${template.subject_template}`)
  } else {
    parts.push(`Subject line: Write a specific, non-generic subject line based on the recipient and context`)
  }
  parts.push(`\nBody template:\n${template.body_template}`)

  parts.push(`\n=== RECIPIENT ===`)
  parts.push(`Name: ${contact.name}`)
  if (contact.company) parts.push(`Company: ${contact.company}`)
  if (contact.role) parts.push(`Role: ${contact.role}`)
  if (contact.location) parts.push(`Location: ${contact.location}`)

  if (research) {
    parts.push(`\n=== AI RESEARCH ON RECIPIENT ===`)
    if (research.summary) parts.push(research.summary)
    if (research.hooks && research.hooks.length > 0) {
      parts.push(`\nKey talking points:`)
      research.hooks.forEach((h) => parts.push(`• ${h}`))
    }
    if (research.shared_context && research.shared_context.length > 0) {
      parts.push(`\nShared context / connections:`)
      research.shared_context.forEach((c) => parts.push(`• ${c}`))
    }
    if (research.suggested_ask) {
      parts.push(`\nSuggested specific ask: ${research.suggested_ask}`)
    }
  } else {
    parts.push(`\n(No research available — use what you know from their name, role, and company)`)
  }

  if (previousEmail && (previousEmail.subject || previousEmail.body)) {
    parts.push(`\n=== PREVIOUS EMAIL YOU SENT (the one this follow-up replies to) ===`)
    if (previousEmail.subject) parts.push(`Subject: ${previousEmail.subject}`)
    if (previousEmail.body) parts.push(`Body:\n${previousEmail.body}`)
  }

  parts.push(`\n=== SENDER ===`)
  parts.push(`Name: ${senderName}`)
  if (senderProfile) {
    if (senderProfile.role) parts.push(`Role: ${senderProfile.role}`)
    if (senderProfile.major) parts.push(`Major: ${senderProfile.major}`)
    if (senderProfile.graduation_year) parts.push(`Graduation: ${senderProfile.graduation_year}`)
    if (senderProfile.bio) parts.push(`Bio: ${senderProfile.bio}`)
    if (senderProfile.linkedin_bio_text || senderProfile.resume_text || senderProfile.personal_context) {
      parts.push(`\n=== SENDER BACKGROUND (for filling "my accomplishments" placeholders) ===`)
      parts.push(`Pick the most relevant 1–2 facts that connect to THIS recipient's world.`)
      if (senderProfile.linkedin_bio_text) {
        parts.push(`LinkedIn:\n${senderProfile.linkedin_bio_text.slice(0, 1500)}`)
      }
      if (senderProfile.resume_text) {
        parts.push(`Resume:\n${senderProfile.resume_text.slice(0, 2000)}`)
      }
      if (senderProfile.personal_context) {
        parts.push(`Additional context: ${senderProfile.personal_context}`)
      }
    }
  }

  return parts.join('\n')
}
