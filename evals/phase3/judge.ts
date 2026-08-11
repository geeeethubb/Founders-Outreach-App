// LLM-as-judge for Precision@20.
//
// DELIBERATELY INDEPENDENT of the scorer:
//   - different system prompt, different framing, different rubric language
//   - the judge NEVER sees the scorer's numbers, explanations, or ranking
//   - the judge is asked a different question: "would a careful advisor put this
//     person on a high-priority list?" rather than "score these dimensions"
//
// If the judge saw the scores it would anchor on them and Precision@20 would
// measure self-consistency instead of quality.

import OpenAI from 'openai'
import { modelFor, estimateCost } from '@/lib/ai/models'
import { cacheGet, cacheKey, cacheSet } from '@/lib/providers/cache'
import type { CompanyCandidate, PersonCandidate } from '@/lib/providers/types'

// Lazily constructed — see the same note in lib/scouting/score.ts.
let client: OpenAI | null = null
function openaiClient(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  return client
}

export type JudgeVerdict = 'GOOD' | 'MAYBE' | 'BAD'

export interface JudgeResult {
  candidate_id: string
  verdict: JudgeVerdict
  reasoning: string
}

export interface JudgeUsage {
  calls: number
  tokens_in: number
  tokens_out: number
  cost_estimate: number
}

export const JUDGE_PROMPT_VERSION = '1.1.0'

const JUDGE_SYSTEM = `You are a skeptical career advisor reviewing a shortlist that an automated recruiting system produced for one specific undergraduate. Your job is quality control. You are not scoring — you are deciding what deserves to stay on a high-priority outreach list.

THE STUDENT
Zuyu Liu — B.S. Chemical Engineering at UIUC (GPA 3.69, graduating May 2028).
- Quality Assurance intern at Procter & Gamble's largest global manufacturing site: built a Controlled State system ($4M+ projected savings), shipped an AI agent into site validation document approvals, designed an agentic AI adoption workflow for plant floor managers ($3M+ projected).
- Project Manager at Illinois Business Consulting: Fortune 500 manufacturing M&A screening; agentic AI workflow redesign for a Big Four firm using n8n.
- Undergraduate researcher: computational catalysis (ASE/VASP, 73k CPU-hours, hydrogen fuel cells); polymer/PET supply-chain mapping.
- Argonne National Laboratory: techno-economic analysis of capacitive de-ionization for biofuels.
- President of Founders: Illinois Entrepreneurs; ran a 400+ person AI hackathon with Y Combinator; founding team at two startups (clean energy, fashion-tech).
- U.S. Presidential Scholar (1 of 161 nationally); Y Combinator Startup School top 5%.

WHAT HE WANTS
A winter 2026-27 internship or short-term project, plus relevance to summer 2027 recruiting.
Target space: industrial AI, manufacturing, chemicals, energy/industrial technology, enterprise AI, consulting, technically ambitious startups.

YOUR VERDICT — one of three:

GOOD — genuinely worth a personalized cold email. ALL of the following hold:
  • the company operates in or sells into a space where his background is a real asset
  • this person's role plausibly touches that work
  • this person could create a project, sponsor an intern, or make a useful referral
  • a thoughtful email from this student has a realistic chance of a reply
  • you could articulate a specific reason THIS person would care about THIS student

MAYBE — plausible relevance but a material weakness: the company fit is generic, the role is
  adjacent rather than central, the person is probably unreachable, or the connection to his
  background is thin enough that the email would sound generic.

BAD — should not be on a high-priority list. Any of:
  • company is in an unrelated industry (fintech, adtech, healthcare services, retail, media,
    real estate, pure consumer apps) with no industrial/process/chemical/energy dimension
  • role is a non-technical function with no path to a technical opportunity
  • person has no authority to create or refer an opportunity
  • realistically would never respond to a cold student email
  • his background gives him no advantage over any other strong intern applicant

BE STRICT. The list is supposed to feel curated, not scraped. A prospect that is merely "not
obviously bad" is MAYBE, not GOOD. Do not reward company prestige — a famous company where his
background is irrelevant is BAD. Do not reward seniority — an SVP at a 50,000-person
corporation who would never reply is worse than a Director who would.

Return ONLY valid JSON:
{ "judgments": [ { "candidate_id": "...", "verdict": "GOOD|MAYBE|BAD", "reasoning": "one or two sentences" } ] }`

export interface JudgeInput {
  candidateId: string
  person: PersonCandidate
  company: CompanyCandidate | null
}

function renderForJudge(input: JudgeInput): string {
  const { candidateId, person, company } = input
  const parts = [
    `--- ${candidateId} ---`,
    `${person.name} — ${person.title ?? 'unknown title'}`,
    `Company: ${person.company_name ?? 'unknown'}`,
  ]
  if (company) {
    parts.push(`Employees: ${company.employee_count ?? 'unknown'}`)
    parts.push(`Industry: ${company.industry ?? 'unknown'}`)
    parts.push(`Location: ${company.hq_location ?? person.location ?? 'unknown'}`)
    if (company.description) parts.push(`Description: ${company.description.slice(0, 350)}`)
    if (company.sub_industries.length) {
      parts.push(`Keywords: ${company.sub_industries.slice(0, 10).join(', ')}`)
    }
  }
  return parts.join('\n')
}

export async function judgeBatch(batch: JudgeInput[]): Promise<{ results: JudgeResult[]; usage: JudgeUsage }> {
  const usage: JudgeUsage = { calls: 0, tokens_in: 0, tokens_out: 0, cost_estimate: 0 }
  if (batch.length === 0) return { results: [], usage }

  const userPrompt = [
    `Judge these ${batch.length} prospects. Return one verdict per candidate_id.`,
    '',
    ...batch.map(renderForJudge),
  ].join('\n\n')

  // Cached on prompt version + rendered input, so re-running after a scoring or
  // ranking change re-judges only prospects whose top-20 membership changed.
  const key = cacheKey('judge', { v: JUDGE_PROMPT_VERSION, model: modelFor('reasoning'), userPrompt })
  const hit = cacheGet<{ results: JudgeResult[] }>(key)
  if (hit) return { results: hit.results, usage }

  const response = await openaiClient().chat.completions.create({
    model: modelFor('reasoning'),
    messages: [
      { role: 'system', content: JUDGE_SYSTEM },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1,
    max_completion_tokens: 260 * batch.length + 400,
  })

  usage.calls = 1
  usage.tokens_in = response.usage?.prompt_tokens ?? 0
  usage.tokens_out = response.usage?.completion_tokens ?? 0
  usage.cost_estimate = estimateCost(usage.tokens_in, usage.tokens_out)

  let parsed: { judgments?: Record<string, unknown>[] }
  try {
    parsed = JSON.parse(response.choices[0]?.message?.content ?? '{}')
  } catch {
    return { results: [], usage }
  }

  const results: JudgeResult[] = []
  for (const j of parsed.judgments ?? []) {
    const verdict = String(j.verdict ?? '').toUpperCase()
    if (!['GOOD', 'MAYBE', 'BAD'].includes(verdict)) continue
    results.push({
      candidate_id: String(j.candidate_id ?? ''),
      verdict: verdict as JudgeVerdict,
      reasoning: String(j.reasoning ?? '').trim(),
    })
  }

  if (results.length > 0) cacheSet(key, { results })
  return { results, usage }
}
