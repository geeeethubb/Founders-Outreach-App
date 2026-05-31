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

Write 3 DIFFERENT email variants (A, B, C) for the same outreach goal. Each variant must
open with a DIFFERENT type of hook:
- Variant A: Hook on a SPECIFIC accomplishment (recent launch, funding, product milestone, press)
- Variant B: Hook on SHARED CONTEXT (mutual connection, school, region, common interest)
- Variant C: Hook on VALUE PROP FOR THEM (what's in it for them: impact, network, talent pipeline)

════════════════════════════════════════
MANDATORY 5-PART EMAIL STRUCTURE
Every variant must follow this EXACT structure in this EXACT order:
════════════════════════════════════════

1. GREETING: "Hi [First Name],"

2. OPENING + PURPOSE (1–2 sentences):
   - Open with the hook (specific accomplishment / shared context / value prop)
   - Then one sentence stating WHY you're reaching out and WHAT you're looking for
   - NEVER start with "I hope this email finds you well", "My name is", or vague flattery like "inspiring work"

3. ABOUT THEM (1–2 sentences):
   - Reference something SPECIFIC from their background, company, or recent work
   - This shows you did your homework — make it feel personal, not copy-pasted

4. ABOUT THE SENDER (1–2 sentences):
   - Introduce the sender using relevant experience from their profile (LinkedIn/resume)
   - Highlight what makes the sender credible or relevant TO THIS SPECIFIC RECIPIENT
   - Draw a real connection between the sender's background and the recipient's world
   - Do NOT list a generic bio — pick the most relevant 1–2 things from the sender's background

5. THE ASK (1 sentence):
   - One clear, specific, low-commitment call to action
   - No multiple asks

Do NOT add a signature — the sender will add their own.

════════════════════════════════════════
Non-negotiable rules:
- Word count: 120–160 words for the body (excluding subject line)
- Subject line: specific, not clickbait, not generic
════════════════════════════════════════`.trim()

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
    const wordLimit = hasConcise ? '90–120 words' : '120–160 words'

    styleSection = `

=== WRITING STYLE INSTRUCTIONS ===
The user has selected these style preferences. Apply ALL of them simultaneously to every variant:

${styleInstructions}

Word count target for body: ${wordLimit}
These style rules OVERRIDE default tone but do NOT override the 5-part structure or hook requirements above.`
  } else {
    styleSection = `\n\nDefault style: conversational but professional. Body word count: 120–160 words.`
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
    const 