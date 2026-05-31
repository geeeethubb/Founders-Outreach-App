import OpenAI from 'openai'
import type { ResearchRequest, ResearchResult, OutreachCategory } from '@/types'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const CLUB_CONTEXT = `
Founders: Illinois Entrepreneurs is the premier entrepreneurship club at the University of
Illinois at Urbana-Champaign (UIUC). The club connects ambitious UIUC students with the
startup ecosystem — top founders, investors, and operators. UIUC is a top-5 engineering
school and has produced notable tech founders including Max Levchin (PayPal), Marc Andreessen
(Netscape/a16z), and the founders of Yelp and YouTube.
`.trim()

function buildSystemPrompt(senderProfile?: ResearchRequest['senderProfile']): string {
  // Build sender context for relevance calibration
  const senderLines: string[] = []
  if (senderProfile?.name) senderLines.push(`Name: ${senderProfile.name}`)
  if (senderProfile?.role) senderLines.push(`Role: ${senderProfile.role}`)
  if (senderProfile?.major) senderLines.push(`Major: ${senderProfile.major}`)
  if (senderProfile?.graduation_year) senderLines.push(`Graduation: ${senderProfile.graduation_year}`)
  if (senderProfile?.bio) senderLines.push(`Bio: ${senderProfile.bio}`)
  if (senderProfile?.linkedin_bio_text) senderLines.push(`LinkedIn: ${senderProfile.linkedin_bio_text.slice(0, 800)}`)
  if (senderProfile?.personal_context) senderLines.push(`Personal context: ${senderProfile.personal_context}`)

  const senderSection = senderLines.length > 0
    ? `\n\nSENDER PROFILE (the person who will be reaching out):\n${senderLines.join('\n')}`
    : ''

  const relevanceGuidance = senderLines.length > 0
    ? `relevance_score: Score 0–1 based on how valuable this contact is SPECIFICALLY to the sender above.
       Consider: Does this person's work align with the sender's goals? Could they offer mentorship, jobs, investment, or speaking relevant to the sender's background?
       0.9+ = highly relevant (direct overlap with sender's goals/industry/stage)
       0.7–0.9 = strong fit (relevant domain, could add real value)
       0.5–0.7 = moderate fit (interesting but indirect connection)
       below 0.5 = weak fit for this specific sender`
    : `relevance_score: 0.9+ = major YC founder / well-known SF operator, 0.7+ = solid startup person, 0.5+ = interesting but less established`

  return `You are a world-class research analyst for ${CLUB_CONTEXT}${senderSection}

Your job: given information about a professional, produce a structured research summary that
will power a highly personalized cold outreach email. The email should feel like it was written
by someone who actually knows the person's work — not a generic form letter.

Return ONLY valid JSON matching this exact schema:
{
  "summary": "3–5 sentence narrative: who they are, what they've built, why they're notable",
  "hooks": ["3–5 specific, recent, memorable things about them"],
  "shared_context": ["2–4 connections to UIUC, Illinois, Big Ten, Midwest, CS/engineering culture, or the sender's background"],
  "relevance_score": 0.0,
  "category": "speaker|mentor|recruiter|investor|peer|partner",
  "suggested_ask": "One specific, reasonable ask tailored to this person and the sender's goals"
}

Rules:
- hooks must be SPECIFIC (company name, product, funding round, talk title — not generic)
- shared_context should be genuine overlaps; if there are none, say so honestly
- ${relevanceGuidance}
- category logic: prominent founder → speaker/mentor; startup hiring → recruiter; VC/angel → investor
- suggested_ask must match what makes sense for the sender to ask`.trim()
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
    temperature: 0.4,
    max_completion_tokens: 1200,
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
    `Research this professional for personalized outreach:`,
    `Name: ${req.name}`,
  ]

  if (req.company) parts.push(`Company: ${req.company}`)
  if (req.role) parts.push(`Role: ${req.role}`)
  if (req.linkedin_url) parts.push(`LinkedIn: ${req.linkedin_url}`)

  if (req.pasted_bio) {
    parts.push(`\n--- PASTED BIO / LINKEDIN TEXT (use this as primary source) ---`)
    parts.push(req.pasted_bio.slice(0, 3000))
    parts.push(`--- END PASTED BIO ---`)
  } else {
    parts.push(`\nUse your training knowledge about this person. Focus on:`)
    parts.push(`- Their company, product, and notable accomplishments`)
    parts.push(`- Any YC batch, funding rounds, press coverage`)
    parts.push(`- Recent launches, talks, or writings`)
    parts.push(`- Any connection to UIUC, Illinois, Big Ten schools, or Midwest`)
  }

  return parts.join('\n')
}
