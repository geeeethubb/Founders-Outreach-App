import OpenAI from 'openai'
import type { Contact, ContactResearch, Profile, ConversationStatus } from '@/types'
import type { ThreadTurn } from '@/lib/email/gmail'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export interface SuggestReplyResult {
  body: string      // the ready-to-send reply, plain text, no signature
  strategy: string  // one-line note on why this reply moves the deal forward
}

const STATUS_GUIDANCE: Record<string, string> = {
  open: 'They replied and the thread is live. Keep momentum: answer what they asked and steer toward a concrete next step (a short call or a clear yes).',
  meeting_booked: 'A meeting is in motion. Confirm logistics (time, place/link), express genuine enthusiasm, and remove any friction.',
  closed_positive: 'They said yes. Lock in the details and make the next step effortless.',
  closed_negative: 'They declined or pushed back. Be gracious, leave the door open for the future, and do not be pushy.',
  ghosted: 'They went quiet. Send a short, low-pressure nudge that adds a new reason to respond — not a guilt trip.',
}

export async function suggestReply(opts: {
  thread: ThreadTurn[]
  contact: Contact
  research?: ContactResearch | null
  profile?: Profile | null
  status?: ConversationStatus | null
  instruction?: string
}): Promise<SuggestReplyResult> {
  const { thread, contact, research, profile, status, instruction } = opts

  const senderName = profile?.name ?? 'the sender'
  const systemPrompt = `
You are an expert relationship-builder and closer writing on behalf of ${senderName}, an organizer for "Founders: Illinois Entrepreneurs", a student entrepreneurship club at UIUC.

Your job: write the NEXT reply in an ongoing email conversation so that ${senderName} WINS the outcome — a booked meeting, a confirmed speaker, a secured mentor, an intro, or a job lead — while sounding warm, human, and genuinely respectful of a busy person's time.

Rules:
- Reply to the LAST message in the thread. Address what they actually said — answer questions, acknowledge concerns, never ignore an objection.
- Always drive toward ONE clear, low-friction next step. If a call makes sense, propose 1–2 concrete time windows rather than "let me know when works".
- Match the recipient's tone and energy. Be concise (usually 40–110 words). No corporate filler, no "I hope this email finds you well", no over-apologizing.
- Use specifics from the thread and research to feel personal, but do not invent facts, commitments, or dates that weren't established.
- Do NOT include a subject line, greeting block formalities beyond a natural "Hi <first name>,", or a signature — ${senderName} adds their own signature.
- Plain text only.

Return ONLY valid JSON: { "body": "<the reply>", "strategy": "<one sentence on why this reply advances the conversation>" }`.trim()

  const userPrompt = buildUserPrompt({ thread, contact, research, profile, status, instruction })

  const response = await openai.chat.completions.create({
    model: 'gpt-5.4',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.7,
    max_completion_tokens: 600,
  })

  const raw = response.choices[0].message.content ?? '{}'
  try {
    const parsed = JSON.parse(raw) as { body?: string; strategy?: string }
    if (!parsed.body) throw new Error('no body')
    return { body: parsed.body.trim(), strategy: (parsed.strategy ?? '').trim() }
  } catch {
    throw new Error('Failed to generate a reply suggestion')
  }
}

function buildUserPrompt(opts: {
  thread: ThreadTurn[]
  contact: Contact
  research?: ContactResearch | null
  profile?: Profile | null
  status?: ConversationStatus | null
  instruction?: string
}): string {
  const { thread, contact, research, profile, status, instruction } = opts
  const parts: string[] = []

  parts.push(`=== RECIPIENT ===`)
  parts.push(`Name: ${contact.name}`)
  if (contact.role) parts.push(`Role: ${contact.role}`)
  if (contact.company) parts.push(`Company: ${contact.company}`)

  if (research?.summary || (research?.hooks?.length ?? 0) > 0) {
    parts.push('', `=== WHAT WE KNOW ABOUT THEM ===`)
    if (research?.summary) parts.push(research.summary)
    if (research?.hooks?.length) {
      parts.push('Hooks:')
      research.hooks.forEach((h) => parts.push(`• ${h}`))
    }
    if (research?.suggested_ask) parts.push(`Likely best ask: ${research.suggested_ask}`)
  }

  if (profile) {
    parts.push('', `=== SENDER (you are writing as them) ===`)
    if (profile.name) parts.push(`Name: ${profile.name}`)
    if (profile.role) parts.push(`Role: ${profile.role}`)
    parts.push(`Club: Founders: Illinois Entrepreneurs @ UIUC`)
    if (profile.goals?.length) parts.push(`Outreach goals: ${profile.goals.join(', ')}`)
    if (profile.bio) parts.push(`Bio: ${profile.bio}`)
    if (profile.personal_context) parts.push(`Context: ${profile.personal_context}`)
  }

  parts.push('', `=== CONVERSATION STATE ===`)
  parts.push(STATUS_GUIDANCE[status ?? 'open'] ?? STATUS_GUIDANCE.open)

  parts.push('', `=== EMAIL THREAD (oldest to newest) ===`)
  for (const t of thread) {
    const who = t.direction === 'outbound' ? `${profile?.name ?? 'Sender'} (us)` : (t.fromName || contact.name)
    parts.push(`--- ${t.direction === 'outbound' ? 'US' : 'THEM'} · ${who} ---`)
    parts.push(t.body.slice(0, 2000))
    parts.push('')
  }

  parts.push(`=== TASK ===`)
  parts.push(`Write the next reply from us to ${contact.name.split(' ')[0]}.`)
  if (instruction) {
    parts.push('', `IMPORTANT — follow this specific instruction from the sender for this reply:`)
    parts.push(instruction)
  }

  return parts.join('\n')
}
