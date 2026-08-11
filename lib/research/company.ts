// Company research agent — grounded, sourced, mission-scoped.
//
// This is the direct answer to the two dominant Phase 3 failure modes:
//   DOMAIN DRIFT   — Apollo's lexical keyword tags returned golf-club and
//                    hospitality advisories under "operations consulting".
//   THIN CONTEXT   — 0 of 140 companies had a description; scoring saw only a
//                    name and a keyword list.
//
// One web-grounded call per company answers "what does this company actually
// do, and is it relevant to this mission?" with citations, so ranking reasons
// over evidence instead of over a keyword match.

import OpenAI from 'openai'
import { modelFor, temperatureFor } from '@/lib/ai/models'
import { cached, cacheKey } from '@/lib/providers/cache'
import { openAIWebResearchProvider } from '@/lib/providers/web/openai-search'
import type { CompanyCandidate } from '@/lib/providers/types'
import { companyKey } from '@/lib/scouting/dedupe'
import { validateClaims, type CompanyDossier } from './types'

let client: OpenAI | null = null
function openaiClient(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  return client
}

// v1.1.0 — first probe wrongly rejected Sunburst Chemicals, a real chemicals
// manufacturer, for "lacking an AI dimension". The user is a chemical engineer:
// industrial and chemical operators are the corporate-innovation lane, not an
// edge case. Relevance now keys on the industrial/process world, not on AI.
export const COMPANY_RESEARCH_PROMPT_VERSION = '1.1.0'

/** Mission framing kept short — it is repeated on every company call. */
const MISSION_CONTEXT = `
The person we are researching FOR is a Chemical Engineering undergraduate with:
- Real manufacturing plant experience (Procter & Gamble, largest global site): process
  control, quality systems, validation
- Shipped agentic AI into live industrial quality/operations workflows
- Computational catalysis and techno-economic analysis (Argonne National Laboratory)
- Consulting: Fortune 500 manufacturing M&A screening, Big Four workflow redesign
- Startup founder energy (leads a university entrepreneurship org)

He is looking for a winter 2026-27 internship or short project, and summer 2027 relevance,
at the intersection of: industrial AI, manufacturing, chemicals/chemical engineering,
energy/industrial technology, enterprise AI, consulting, or technically ambitious startups.
`.trim()

const SYSTEM = `You are a research analyst producing a grounded dossier on a company, using the web search results provided.

${MISSION_CONTEXT}

Your job is to determine WHAT THIS COMPANY ACTUALLY DOES and whether it is genuinely relevant
to that mission — not whether it matched a keyword.

════════ CLAIM TYPING — STRICT ════════
Every claim you output is typed:
  FACT      — stated in the search results. MUST carry the source_url it came from.
  INFERENCE — reasoned from the results, not directly stated. source_url optional.
  UNKNOWN   — you could not determine this. A first-class output, not a failure.

NEVER type something FACT unless the search results actually say it and you give the URL.
A thin or unhelpful search result should produce UNKNOWNs, not invented facts.

════════ RELEVANCE — BE HONEST AND STRICT, BUT NOT NARROW ════════

⚠ AI IS NOT REQUIRED. The user is a CHEMICAL ENGINEER first. A company that operates
chemical plants, manufactures products, runs process operations, or does industrial
engineering is SQUARELY IN SCOPE even if it has no AI, no software and no digital story —
his P&G process/quality/validation experience applies directly. Do not reject an industrial
or chemical operator for "lacking an AI dimension"; that is a false negative and it is the
single most damaging mistake you can make here.

Set mission_relevant = TRUE when ANY of these is true:
  • It manufactures or processes physical goods (chemicals, materials, CPG, industrial products)
  • It operates process plants, refineries, energy or materials production
  • It sells software, AI or analytics INTO manufacturing / process / energy industries
  • It consults on operations, manufacturing, supply chain, process or industrial strategy
  • It is a technically ambitious startup in energy, materials, climate, chemistry or hard tech
  • It does industrial engineering, automation, instrumentation or quality systems work

Set mission_relevant = FALSE only when the company is genuinely OUTSIDE that world, however
its keywords matched. Reject:
  • hospitality, golf, clubs, resorts, restaurants, travel
  • real estate, mortgage, insurance, wealth management, general financial advisory
  • retail, e-commerce, consumer apps, media, publishing, marketing, advertising
  • staffing, recruiting, job boards, training and certification providers
  • generic small-business/IT consulting with no industrial, process or manufacturing practice
  • healthcare delivery, clinics, hospitals; pure clinical/biotech services with no
    process-manufacturing dimension
  • conferences, trade associations, non-operating trade bodies

When genuinely uncertain, prefer TRUE and record the doubt in relevance_reasoning — a wrong
rejection removes the prospect permanently and invisibly, whereas a wrong inclusion is caught
downstream by scoring.

domain_evidence flags must reflect what the search results actually support — not guesses.
A chemicals manufacturer with no software should set chemicals_process and manufacturing
true and industrial_ai false. That combination is still mission_relevant.

Return ONLY valid JSON:
{
  "what_they_do": "2-3 plain sentences. What do they actually sell or do?",
  "products_services": ["..."],
  "industries_served": ["..."],
  "customer_types": ["..."],
  "domain_evidence": {
    "industrial_ai": false, "manufacturing": false, "chemicals_process": false,
    "energy_materials": false, "consulting": false, "enterprise_software": false
  },
  "size_stage_context": "stage/size/funding/ownership if known, else null",
  "mission_relevant": true,
  "relevance_reasoning": "one or two sentences, honest",
  "claims": [
    { "claim": "...", "type": "FACT", "source_url": "https://...", "source_title": "...", "confidence": 0.9 }
  ],
  "uncertainties": ["what you could not determine"]
}`

function searchPrompt(company: CompanyCandidate): string {
  const hints = [
    company.domain ? `website ${company.domain}` : null,
    company.industry ? `industry label "${company.industry}"` : null,
    company.hq_location ? `located ${company.hq_location}` : null,
  ].filter(Boolean).join(', ')

  return [
    `Research the company "${company.name}"${hints ? ` (${hints})` : ''}.`,
    '',
    'Find and report, with sources:',
    '1. What the company actually does — its products or services, in concrete terms.',
    '2. Which industries and customer types it serves.',
    '3. Whether it works in or sells into: industrial AI, manufacturing, chemicals or process',
    '   industries, energy or materials, industrial technology, or industrial/operations consulting.',
    '4. Company size, stage, funding or ownership if available.',
    '5. Any recent notable initiatives, products or announcements.',
    '',
    'If the company is small or obscure and you cannot find reliable information, say so plainly',
    'rather than guessing. Do not confuse it with a similarly-named company — verify the domain.',
  ].join('\n')
}

export interface CompanyResearchResult {
  dossier: CompanyDossier
  usage: { web_searches: number; llm_calls: number; tokens_in: number; tokens_out: number }
}

function emptyDossier(company: CompanyCandidate, reason: string): CompanyDossier {
  return {
    company_key: companyKey(company),
    company_name: company.name,
    domain: company.domain,
    what_they_do: company.description ?? '',
    products_services: [],
    industries_served: [],
    customer_types: [],
    domain_evidence: {
      industrial_ai: false, manufacturing: false, chemicals_process: false,
      energy_materials: false, consulting: false, enterprise_software: false,
    },
    size_stage_context: null,
    // Unknown is NOT the same as irrelevant. A research failure must not silently
    // eliminate a company — the scorer is told coverage is missing and discounts
    // accordingly, which is honest rather than punitive.
    mission_relevant: true,
    relevance_reasoning: `Research unavailable (${reason}); relevance undetermined.`,
    claims: [],
    uncertainties: [`Company research failed: ${reason}`],
    research_failed: true,
  }
}

/**
 * Research one company. Cached on (company key, prompt version) so eval
 * iterations that change only scoring cost nothing.
 */
export async function researchCompany(company: CompanyCandidate): Promise<CompanyResearchResult> {
  const usage = { web_searches: 0, llm_calls: 0, tokens_in: 0, tokens_out: 0 }
  const key = cacheKey('company_dossier', {
    v: COMPANY_RESEARCH_PROMPT_VERSION,
    company: companyKey(company),
    name: company.name,
  })

  let computed = false
  const dossier = await cached<CompanyDossier>(key, async () => {
    computed = true

    const web = await openAIWebResearchProvider.researchRaw({
      query: searchPrompt(company),
      max_results: 8,
    })
    usage.web_searches = 1

    if (web.error || !web.text) {
      return emptyDossier(company, web.error ?? 'no results')
    }

    const sourceList = web.citations
      .map((c, i) => `[${i + 1}] ${c.url}${c.title ? ` — ${c.title}` : ''}`)
      .join('\n')

    const userPrompt = [
      `COMPANY: ${company.name}`,
      company.domain ? `DOMAIN: ${company.domain}` : '',
      company.industry ? `APOLLO INDUSTRY LABEL: ${company.industry}` : '',
      company.employee_count != null ? `APOLLO EMPLOYEE COUNT: ${company.employee_count}` : '',
      company.sub_industries.length ? `APOLLO KEYWORDS: ${company.sub_industries.slice(0, 15).join(', ')}` : '',
      '',
      '=== WEB SEARCH RESULTS ===',
      web.text,
      '',
      '=== SOURCES (cite these exact URLs in FACT claims) ===',
      sourceList || '(none)',
    ].filter(Boolean).join('\n')

    const response = await openaiClient().chat.completions.create({
      model: modelFor('reasoning'),
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: userPrompt }],
      response_format: { type: 'json_object' },
      temperature: temperatureFor('reasoning'),
      max_completion_tokens: 3200,
    })

    usage.llm_calls = 1
    usage.tokens_in = response.usage?.prompt_tokens ?? 0
    usage.tokens_out = response.usage?.completion_tokens ?? 0

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(response.choices[0]?.message?.content ?? '{}')
    } catch {
      return emptyDossier(company, 'invalid JSON from researcher')
    }

    const evidence = (parsed.domain_evidence ?? {}) as Record<string, unknown>
    const flag = (k: string) => evidence[k] === true

    // Only URLs the search actually returned may back a FACT. This closes the
    // loop: the model cannot cite a plausible-looking URL it invented.
    const allowedUrls = new Set(web.citations.map((c) => c.url))
    const claims = validateClaims(Array.isArray(parsed.claims) ? parsed.claims : []).map((c) =>
      c.type === 'FACT' && c.source_url && !allowedUrls.has(c.source_url)
        ? { ...c, type: 'INFERENCE' as const }
        : c
    )

    return {
      company_key: companyKey(company),
      company_name: company.name,
      domain: company.domain,
      what_they_do: String(parsed.what_they_do ?? '').trim(),
      products_services: asStrings(parsed.products_services),
      industries_served: asStrings(parsed.industries_served),
      customer_types: asStrings(parsed.customer_types),
      domain_evidence: {
        industrial_ai: flag('industrial_ai'),
        manufacturing: flag('manufacturing'),
        chemicals_process: flag('chemicals_process'),
        energy_materials: flag('energy_materials'),
        consulting: flag('consulting'),
        enterprise_software: flag('enterprise_software'),
      },
      size_stage_context: typeof parsed.size_stage_context === 'string' ? parsed.size_stage_context : null,
      mission_relevant: parsed.mission_relevant !== false,
      relevance_reasoning: String(parsed.relevance_reasoning ?? '').trim(),
      claims,
      uncertainties: asStrings(parsed.uncertainties),
      research_failed: false,
    }
  // Never cache a failed dossier: a transient parse error or rate limit would
  // otherwise be replayed forever and look like a stable property of the input.
  }, false, (d) => !d.research_failed)

  if (!computed) usage.web_searches = 0
  return { dossier, usage }
}

function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 12) : []
}
