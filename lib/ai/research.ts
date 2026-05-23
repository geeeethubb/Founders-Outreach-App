import OpenAI from 'openai'
import type { ResearchRequest, ResearchResult, OutreachCategory } from '@/types'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const CLUB_CONTEXT = `
Founders: Illinois Entrepreneurs is the premier entrepreneurship club at the University of
Illinois at Urbana-Champaign (UIUC). The club connects ambitious UIUC students with the
startup ecosystem — top founders, investors, and operators. UIUC is a top-5 engineering
school and has produced notable tech founders including Max Levchin (PayPal), Marc Andreessen
(Netscape/a16z), and the founders of Yelp and YouTube. The club hosts speaker events,
hackathons, and 1:1 mentorship programs. Members are exceptional CS, engineering, and
business students actively building startups or seeking to break into the Bay Area ecosystem.
`.trim()

const SYSTEM_PROMPT = `
You are a world-class research analyst for ${CLUB_CONTEXT}

Your job: given information about a professional, produce a structured research summary that
will power a highly personalized cold outreach email from the club. The email should feel like
it was written by a sharp, well-informed student who actually knows the person's work — not
a generic form letter.

Return ONLY valid JSON matching this exact schema:
{
  "summary": "3–5 sentence narrative: who they are, what they've built, why they're notable",
  "hooks": ["3–5 specific, recent, memorable things about them"],
  "shared_context": ["2–4 connections to UIUC, Illinois, Big Ten, Midwest, CS/engineering culture, or student-relevant topics"],
  "relevance_score": 0.0,
  "category": "speaker|mentor|recruiter|investor|peer|partner",
  "suggested_ask": "One specific, reasonable ask tailored to this person"
}

Rules:
- hooks must be SPECIFIC (company name, product, funding round, talk title, tweet — not generic)
- shared_context should be genuine overlaps, not forced; if there are none, say so honestly
- relevance_score: 0.9+ = major YC founder / well-known SF operator, 0.7+ = solid startup person, 0.5+ = interesting but less established
- category logic: if they're a prominent founder → speaker/mentor; if at a startup hiring → recruiter; if VC/angel → investor
- suggested_ask must match what makes sense for a UIUC student club to ask (e.g., "30-min Zoom for our founder speaker series", "mentor 2–3 UIUC student founders for a semester")
`.trim()

export async function researchContact(req: ResearchRequest): Promise<ResearchResult> {
  const userContent = buildUserPrompt(req)

  // Use gpt-4.1 — OpenAI's latest model, strong knowledge of YC founders, SF ecosystem
  const response = await openai.chat.completions.create({
    model: 'gpt-4.1',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.4,
    max_tokens: 1200,
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
    parts.push(req.pasted_bio.slice(0, 3000)) // cap at 3k chars
    parts.push(`--- END PASTED BIO ---`)
  } else {
    parts.push(`\nUse your training knowledge about this person. Focus on:`)
    parts.push(`- Their company, product, and notable accomplishments`)
    parts.push(`- Any YC batch (e.g., W21, S23), funding rounds, press coverage`)
    parts.push(`- Recent launches, tweets, talks, or writings`)
    parts.push(`- Any connection to UIUC, Illinois, Big Ten schools, or Midwest`)
  }

  return parts.join('\n')
}
