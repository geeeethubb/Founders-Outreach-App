import OpenAI from 'openai'
import type { Contact, ContactResearch, EmailVariant, GenerateRequest, EmailStyle, Profile } from '@/types'
import { EMAIL_STYLES } from '@/types'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const GOAL_CONFIGS: Record<
  GenerateRequest['outreach_goal'],
  { label: string; ask_guidance: string }
> = {
  speaker: {
    label: 'Speaker / Event',
    ask_guidance:
      'Invite them to speak at a Founders Illinois event or fireside chat. The ask: a 30–45 min virtual or in-person talk, no compensation expected, just a chance to inspire ambitious UIUC students. Keep it easy — offer flexible scheduling.',
  },
  mentor: {
    label: 'Mentor / Advisor',
    ask_guidance:
      "Ask if they would mentor 1–2 UIUC student founders. The ask: a 30-min introductory call to see if there's a fit, with no long-term commitment implied upfront.",
  },
  jobs: {
    label: 'Internship / Jobs',
    ask_guidance:
      'Ask if their company is hiring interns or early employees, and if they would consider UIUC students. The ask: share a brief portfolio of our top members OR a 15-min call to discuss fit. UIUC CS/Eng students are highly competitive (Google, Jane Street, top YC startup alumni).',
  },
  investor_intro: {
    label: 'Investor Introduction',
    ask_guidance:
      'Ask for a brief intro call or connection on behalf of a UIUC student-led startup. The ask: a 20-min call OR an intro to a relevant investor in their network. Be specific about what the startup does.',
  },
  personal_career: {
    label: 'Personal Opportunity',
    ask_guidance:
      'This is a PERSONAL outreach from the sender — not on behalf of the club. The sender is a UIUC student reaching out for their own career: internships, project collaborations, professional mentorship, or job opportunities. Write in first person as an ambitious student. The ask should be specific and low-commitment: a 20-min coffee chat, a referral, a look at their resume, or an internship inquiry. Highlight the sender\'s own skills, drive, and UIUC background — not the club. Make it feel genuine and personal, not a mass email.',
  },
}

function buildSystemPrompt(styles: EmailStyle[]): string {
  const baseRules = `
You are an expert cold email writer for Founders: Illinois Entrepreneurs at UIUC.

Write 3 DIFFERENT email variants (A, B, C) for the same outreach goal. Each variant should
open with a DIFFERENT type of hook:
- Variant A: Hook on a SPECIFIC accomplishment (recent launch, funding, product milestone, press)
- Variant B: Hook on SHARED CONTEXT (mutual connection, school, region, common interest)
- Variant C: Hook on VALUE PROP FOR THEM (what's in it for them: impact, network, talent pipeline)

Non-negotiable rules for every variant:
1. NEVER start with "I hope this email finds you well" or "My name is" — those are immediate deletes
2. NEVER use vague flattery ("I've been following your journey", "inspiring work")
3. ALWAYS reference something SPECIFIC about the person in the first sentence
4. One clear CTA at the end — no multiple asks
5. Sign from: [Your Name], Founders: Illinois Entrepreneurs @ UIUC
6. Subject line: specific, not clickbait, not generic`.trim()

  // Build style instructions section
  let styleSection = ''
  if (styles && styles.length > 0) {
    const styleConfigs = styles
      .map((s) => EMAIL_STYLES.find((c) => c.id === s))
      .filter(Boolean)

    const styleInstructions = styleConfigs
      .map((c) => `• ${c!.label} (${c!.emoji}): ${c!.promptInstruction}`)
      .join('\n')

    // Word count adjustments based on styles
    const hasConcise = styles.includes('concise')
    const hasInformal = styles.includes('informal')
    const wordLimit = hasConcise ? '60–80 words' : '100–130 words'

    styleSection = `

=== WRITING STYLE INSTRUCTIONS ===
The user has selected these style preferences. Apply ALL of them simultaneously to every variant:

${styleInstructions}

Word count target for these styles: ${wordLimit}
These style rules OVERRIDE default tone but do NOT override the hook/personalization requirements above.`
  } else {
    styleSection = `\n\nDefault style: conversational but professional, 100–130 words per variant.`
  }

  const outputFormat = `

Return ONLY valid JSON:
{
  "variants": [
    {
      "label": "A",
      "subject": "...",
      "body": "...",
      "hook_type": "accomplishment",
      "hook_used": "brief description of the specific hook used"
    },
    {
      "label": "B",
      "subject": "...",
      "body": "...",
      "hook_type": "shared_context",
      "hook_used": "..."
    },
    {
      "label": "C",
      "subject": "...",
      "body": "...",
      "hook_type": "value_prop",
      "hook_used": "..."
    }
  ]
}`

  return baseRules + styleSection + outputFormat
}

export async function generateEmailVariants(
  contact: Contact,
  research: ContactResearch,
  req: GenerateRequest,
  senderName: string,
  senderProfile?: Profile | null
): Promise<EmailVariant[]> {
  const goalConfig = GOAL_CONFIGS[req.outreach_goal]
  const systemPrompt = buildSystemPrompt(req.styles ?? [])
  const userPrompt = buildUserPrompt(contact, research, goalConfig, senderName, req.custom_note, senderProfile)

  const response = await openai.chat.completions.create({
    model: 'gpt-5.4',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.8,
    max_completion_tokens: 1800,
  })

  const raw = response.choices[0].message.content ?? '{}'

  try {
    const parsed = JSON.parse(raw) as {
      variants: Array<{
        label: string
        subject: string
        body: string
        hook_type: string
        hook_used: string
      }>
    }

    return parsed.variants.map((v) => ({
      label: v.label as 'A' | 'B' | 'C',
      subject: v.subject,
      body: v.body,
      hook_type: v.hook_type as EmailVariant['hook_type'],
      hook_used: v.hook_used,
      word_count: v.body.split(/\s+/).length,
    }))
  } catch {
    throw new Error('Failed to parse email generation response')
  }
}

function buildUserPrompt(
  contact: Contact,
  research: ContactResearch,
  goal: (typeof GOAL_CONFIGS)[keyof typeof GOAL_CONFIGS],
  senderName: string,
  customNote?: string,
  senderProfile?: Profile | null
): string {
  const parts: string[] = [
    `Generate 3 email variants for this outreach:`,
    ``,
    `=== RECIPIENT ===`,
    `Name: ${contact.name}`,
  ]

  if (contact.company) parts.push(`Company: ${contact.company}`)
  if (contact.role) parts.push(`Role: ${contact.role}`)
  if (contact.location) parts.push(`Location: ${contact.location}`)

  parts.push(``, `=== RESEARCH SUMMARY ===`)
  parts.push(research.summary ?? 'No summary available.')

  if (research.hooks && research.hooks.length > 0) {
    parts.push(``, `Specific hooks to use:`)
    r