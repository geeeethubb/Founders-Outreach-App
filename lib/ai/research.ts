import OpenAI from 'openai'
import type { ResearchRequest, ResearchResult, OutreachCategory } from '@/types'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const CLUB_CONTEXT = `
Founders: Illinois Entrepreneurs is the premier entrepreneurship club at the University of
Illinois at Urbana-Champaign (UIUC). The club connects ambitious UIUC students with the
startup ecosystem — top founders, investors, and operators.
`.trim()

function buildSystemPrompt(senderProfile?: ResearchRequest['senderProfile']): string {
  const senderLines: string[] = []
  if (senderProfile?.name) senderLines.push(`Name: ${senderProfile.name}`)
  if (senderProfile?.role) senderLines.push(`Role: ${senderProfile.role}`)
  if (senderProfile?.major) senderLines.push(`Major: ${senderProfile.major}`)
  if (senderProfile?.graduation_year) senderLines.push(`Graduation: ${senderProfile.graduation_year}`)
  if (senderProfile?.bio) senderLines.push(`Bio: ${senderProfile.bio}`)
  if (senderProfile?.linkedin_bio_text) senderLines.push(`LinkedIn: ${senderProfile.linkedin_bio_text.slice(0, 600)}`)
  if (senderProfile?.personal_context) senderLines.push(`Context: ${senderProfile.personal_context}`)

  const senderSection = senderLines.length > 0
    ? `\nSENDER (who will send the outreach):\n${senderLines.join('\n')}`
    : ''

  const relevanceGuidance = senderLines.length > 0
    ? `relevance_score: 0–1 based on how valuable this contact is TO THE SENDER specifically.
       0.9+ = strong direct overlap with sender's goals/industry
       0.7–0.9 = relevant domain, real value
       0.5–0.7 = moderate fit
       below 0.5 = weak fit`
    : `relevance_score: 0.9+ = major well-known founder/investor, 0.7+ = solid startup person, below 0.5 = limited info`

  return `You are a research analyst for ${CLUB_CONTEXT}${senderSection}

Your job: produce a research summary to power personalized cold outreach. You must be ACCURATE.

════════════════════════════════════════
ANTI-HALLUCINATION RULES — NON-NEGOTIABLE:
════════════════════════════════════════
1. ONLY include facts you are HIGHLY CONFIDENT are true. If you are not sure, OMIT IT.
2. DO NOT invent or guess: funding amounts, YC batches, product names, launch dates, press mentions, tweets, or talks unless you are certain they are real.
3. If you have limited knowledge about this person, say so honestly in the summary — e.g. "Limited public information available; known as [role] at [company]."
4. hooks must be VERIFIABLE, SPECIFIC facts — not vague statements like "impressive background" or invented details.
5. If you cannot find 3 real hooks, return fewer. An empty hooks array is better than fabricated hooks.
6. shared_context: only include genuine overlaps you're confident about. If none, return an empty array.
7. suggested_ask: base it only on what you actually know about them. Do not assume things.
════════════════════════════════════════

Return ONLY valid JSON:
{
  "summary": "2–4 sentences: who they are and what they do. If limited info, say so honestly.",
  "hooks": ["Only real, specific, verifiable facts you are confident about. Fewer is better than fabricated."],
  "shared_context": ["Only genuine confirmed overlaps with UIUC/Illinois/sender background. Empty array if none."],
  "relevance_score": 0.0,
  "category": "speaker|mentor|recruiter|investor|peer|partner",
  "suggested_ask": "One reasonable ask based only on what you actually know about this person"
}

${relevanceGuidance}
Category: prominent founder/exec → speaker/mentor; VC/angel → investor; startup hiring → recruiter; peer-level → peer`.trim()
}

export async function researchContact(req: ResearchRequest): Promise<ResearchResult> {
  const systemPrompt = buildSystemPrompt(req.senderProfile)
  const userContent = buildUserPrompt(req)

  const response = await openai.chat.completions.create({
    model: 'gpt-5.4',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1, // very low — prioritise accuracy over creativity
    max_completion_tokens: 1000,
  })

  const raw = response.choices[0].message.content ?? '{}'

  try {
    const parsed = JSON.parse(raw) as ResearchResult & { category: string }
    return {
      summary: parsed.summary ?? '',
      hooks: Array.isArray(parsed.hooks) ? parsed.hooks : [],
      shared_context: Array.isArray(parsed.shared_context) ? parsed.shared_context : [],
      relevance_score: typeof parsed.relevance_score === 'number'
        ? Math.max(0, Math.min(1, parsed.relevance_score))
        : 0.5,
      category: (parsed.category as OutreachCategory) ?? 'peer',
      suggested_ask: parsed.suggested_ask ?? '',
    }
  } catch {
    throw new Error('Failed to parse research response from AI')
  }
}

function buildUserPrompt(req: ResearchRequest): string {
  const parts: string[] = [
    `Research this person for outreach:`,
    `Name: ${req.name}`,
  ]

  if (req.company) parts.push(`Company: ${req.company}`)
  if (req.role) parts.push(`Role: ${req.role}`)
  if (req.linkedin_url) parts.push(`LinkedIn: ${req.linkedin_url}`)

  if (req.pasted_bio) {
    parts.push(`\n--- PASTED PROFILE (treat as ground truth) ---`)
    parts.push(req.pasted_bio.slice(0, 3000))
    parts.push(`--- END PROFILE ---`)
    parts.push(`\nBase your research ONLY on the pasted profile above. Do not add outside information.`)
  } else {
    parts.push(`\nIMPORTANT: Only include information you are genuinely confident is accurate for this specific person.`)
    parts.push(`If this is a less-known person, be honest about the limited information rather than fabricating details.`)
    parts.push(`Focus on: confirmed company/role, any well-documented accomplishments, verified background.`)
    parts.push(`Do NOT guess at: funding amounts, YC batches, specific products, or recent events unless certain.`)
  }

  return parts.join('\n')
}
