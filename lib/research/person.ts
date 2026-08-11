// Person research agent — runs only on the shortlist.
//
// Deliberately cheaper and narrower than company research: by the time a person
// reaches this stage their company has already been researched and judged
// relevant, so the only remaining questions are about THEM — what they own,
// whether they can create or refer an opportunity, and what they are working on
// now.
//
// Runs after Apollo enrichment because it needs a real full name; search-result
// stubs are obfuscated.

import OpenAI from 'openai'
import { modelFor, temperatureFor } from '@/lib/ai/models'
import { cached, cacheKey } from '@/lib/providers/cache'
import { openAIWebResearchProvider } from '@/lib/providers/web/openai-search'
import type { PersonCandidate } from '@/lib/providers/types'
import { validateClaims, type CompanyDossier, type PersonDossier } from './types'

let client: OpenAI | null = null
function openaiClient(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  return client
}

export const PERSON_RESEARCH_PROMPT_VERSION = '1.0.0'

const SYSTEM = `You are a research analyst producing a short grounded dossier on ONE person, using the web search results provided.

The person is being evaluated as a cold-outreach target for a Chemical Engineering undergraduate
with plant manufacturing experience (P&G), shipped industrial AI agents, computational catalysis
research, and consulting experience. He wants a winter internship or short project.

Answer only these questions:
1. What does this person appear to OWN — which function, team, initiative or P&L?
2. How relevant is that function to industrial AI / manufacturing / chemicals / process /
   energy / industrial consulting work?
3. Could they plausibly create a project, sponsor an intern, influence hiring, or make a
   useful referral? Be realistic about company size and their level.
4. Any recent work, talks, posts, hires or initiatives that are relevant.

════════ CLAIM TYPING — STRICT ════════
  FACT      — stated in the search results. MUST carry the source_url it came from.
  INFERENCE — reasoned, not directly stated.
  UNKNOWN   — could not determine. Expected and fine for non-public people.

Most mid-level people have almost no web presence. That is NORMAL. Return UNKNOWNs and a
low-confidence assessment rather than inventing a profile. Never attribute to this person
something you found about a different individual with a similar name.

Return ONLY valid JSON:
{
  "apparent_ownership": "what they appear to own, or 'Undetermined'",
  "function_relevance": "one sentence",
  "decision_maker_assessment": "one sentence, realistic",
  "can_create_opportunity": true,
  "recent_initiatives": ["..."],
  "claims": [ { "claim": "...", "type": "FACT", "source_url": "https://...", "source_title": "...", "confidence": 0.8 } ],
  "uncertainties": ["..."]
}`

function personKeyOf(person: PersonCandidate): string {
  return person.provenance.external_id
    ? `a:${person.provenance.external_id}`
    : `n:${person.name.toLowerCase()}|${(person.company_name ?? '').toLowerCase()}`
}

function searchPrompt(person: PersonCandidate, company: CompanyDossier | null): string {
  return [
    `Research this specific person for professional context:`,
    `Name: ${person.name}`,
    `Title: ${person.title ?? 'unknown'}`,
    `Company: ${person.company_name ?? 'unknown'}`,
    person.linkedin_url ? `LinkedIn: ${person.linkedin_url}` : '',
    company ? `The company does: ${company.what_they_do.slice(0, 250)}` : '',
    '',
    'Find, with sources:',
    '- What they own or lead at this company (function, team, initiative).',
    '- Any public talks, interviews, articles, patents, or announcements involving them.',
    '- Any indication they hire, mentor, sponsor projects, or work with students.',
    '',
    'IMPORTANT: verify any result actually refers to THIS person at THIS company.',
    'If you find nothing reliable about them specifically, say so plainly.',
  ].filter(Boolean).join('\n')
}

export interface PersonResearchResult {
  dossier: PersonDossier
  usage: { web_searches: number; llm_calls: number; tokens_in: number; tokens_out: number }
}

function emptyDossier(person: PersonCandidate, reason: string): PersonDossier {
  return {
    person_key: personKeyOf(person),
    person_name: person.name,
    apparent_ownership: 'Undetermined',
    function_relevance: `Inferred from title only: ${person.title ?? 'unknown'}`,
    decision_maker_assessment: 'Undetermined from public sources; judged on title and company size alone.',
    can_create_opportunity: true,
    recent_initiatives: [],
    claims: [],
    uncertainties: [`Person research unavailable: ${reason}`],
    research_failed: true,
  }
}

export async function researchPerson(
  person: PersonCandidate,
  company: CompanyDossier | null
): Promise<PersonResearchResult> {
  const usage = { web_searches: 0, llm_calls: 0, tokens_in: 0, tokens_out: 0 }
  const key = cacheKey('person_dossier', {
    v: PERSON_RESEARCH_PROMPT_VERSION,
    person: personKeyOf(person),
    name: person.name,
    title: person.title,
  })

  let computed = false
  const dossier = await cached<PersonDossier>(key, async () => {
    computed = true

    const web = await openAIWebResearchProvider.researchRaw({
      query: searchPrompt(person, company),
      max_results: 6,
    })
    usage.web_searches = 1

    if (web.error || !web.text) return emptyDossier(person, web.error ?? 'no results')

    const sourceList = web.citations.map((c, i) => `[${i + 1}] ${c.url}${c.title ? ` — ${c.title}` : ''}`).join('\n')

    const userPrompt = [
      `PERSON: ${person.name}`,
      `TITLE: ${person.title ?? 'unknown'}`,
      `COMPANY: ${person.company_name ?? 'unknown'}`,
      `SENIORITY BAND: ${person.seniority ?? 'unknown'}`,
      '',
      '=== WEB SEARCH RESULTS ===',
      web.text,
      '',
      '=== SOURCES (cite these exact URLs in FACT claims) ===',
      sourceList || '(none)',
    ].join('\n')

    const response = await openaiClient().chat.completions.create({
      model: modelFor('reasoning'),
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: userPrompt }],
      response_format: { type: 'json_object' },
      temperature: temperatureFor('reasoning'),
      max_completion_tokens: 2200,
    })

    usage.llm_calls = 1
    usage.tokens_in = response.usage?.prompt_tokens ?? 0
    usage.tokens_out = response.usage?.completion_tokens ?? 0

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(response.choices[0]?.message?.content ?? '{}')
    } catch {
      return emptyDossier(person, 'invalid JSON from researcher')
    }

    const allowedUrls = new Set(web.citations.map((c) => c.url))
    const claims = validateClaims(Array.isArray(parsed.claims) ? parsed.claims : []).map((c) =>
      c.type === 'FACT' && c.source_url && !allowedUrls.has(c.source_url)
        ? { ...c, type: 'INFERENCE' as const }
        : c
    )

    return {
      person_key: personKeyOf(person),
      person_name: person.name,
      apparent_ownership: String(parsed.apparent_ownership ?? 'Undetermined').trim(),
      function_relevance: String(parsed.function_relevance ?? '').trim(),
      decision_maker_assessment: String(parsed.decision_maker_assessment ?? '').trim(),
      can_create_opportunity: parsed.can_create_opportunity !== false,
      recent_initiatives: Array.isArray(parsed.recent_initiatives)
        ? parsed.recent_initiatives.map(String).slice(0, 6)
        : [],
      claims,
      uncertainties: Array.isArray(parsed.uncertainties) ? parsed.uncertainties.map(String).slice(0, 6) : [],
      research_failed: false,
    }
  // Never cache a failed dossier: a transient parse error or rate limit would
  // otherwise be replayed forever and look like a stable property of the input.
  }, false, (d) => !d.research_failed)

  if (!computed) usage.web_searches = 0
  return { dossier, usage }
}
