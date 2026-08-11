// Phase 3 relevance scorer.
//
// ADR-004 in practice: the model emits a 0–1 judgment PER DIMENSION plus an
// explanation and grounding ids. All arithmetic — scaling to points, summing,
// deriving the recommendation band — happens in deterministic TypeScript below.
// The model never sees the point values and never returns a total, so it cannot
// reverse-engineer a target score and back-fill components to reach it.

import OpenAI from 'openai'
import { modelFor, temperatureFor, estimateCost } from '@/lib/ai/models'
import { clampScore } from '@/lib/scoring/compute'
import { cacheGet, cacheKey, cacheSet } from '@/lib/providers/cache'
import type { CompanyCandidate, PersonCandidate } from '@/lib/providers/types'
import { renderCompanyDossier, renderPersonDossier, type CompanyDossier, type PersonDossier } from '@/lib/research/types'

// Lazily constructed: the deterministic exports in this file (computeTotal,
// deriveRecommendation) must be importable and testable without an API key.
// Instantiating at module scope made `import` itself throw.
let client: OpenAI | null = null
function openaiClient(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  return client
}

// ─── Dimensions ──────────────────────────────────────────────────────────────

export type ScoutDimension =
  | 'opportunity_fit'
  | 'background_relevance'
  | 'decision_influence'
  | 'differentiation'
  | 'accessibility'

export const DIMENSION_MAX: Record<ScoutDimension, number> = {
  opportunity_fit: 25,
  background_relevance: 25,
  decision_influence: 20,
  differentiation: 15,
  accessibility: 15,
}

export const SCOUT_DIMENSIONS = Object.keys(DIMENSION_MAX) as ScoutDimension[]

export const DIMENSION_QUESTION: Record<ScoutDimension, string> = {
  opportunity_fit:
    'How likely is this company/person combination to plausibly create a strong winter 2026-27 or summer 2027 opportunity?',
  background_relevance:
    "How strongly does the user's ACTUAL experience overlap with this person's work and this company's domain?",
  decision_influence:
    'Can this person plausibly create, shape, sponsor, or refer the user into an opportunity?',
  differentiation:
    "Would the user's background be unusually interesting to THIS person, versus a generic strong student applicant?",
  accessibility:
    'How realistic is it that this specific person would take a thoughtful cold conversation from an undergraduate?',
}

// ─── Output shapes ───────────────────────────────────────────────────────────

export interface ScoutComponent {
  dimension: ScoutDimension
  /** 0–1 from the model. */
  normalized: number
  /** Points, computed in code: normalized * DIMENSION_MAX. */
  points: number
  max: number
  explanation: string
}

export type Recommendation = 'STRONG' | 'MAYBE' | 'WEAK'

export interface ScoutScore {
  candidate_id: string
  components: ScoutComponent[]
  total: number
  why_they_fit: string
  why_i_fit_them: string
  /** Resume item ids backing `why_i_fit_them`. Validated against the profile. */
  resume_item_ids: string[]
  risks: string
  recommendation: Recommendation
  /** Set by validation when the model cited an id that does not exist. */
  ungrounded_ids: string[]
}

export interface ScoringUsage {
  calls: number
  tokens_in: number
  tokens_out: number
  cost_estimate: number
}

// ─── Deterministic arithmetic ────────────────────────────────────────────────

export function computeTotal(components: ScoutComponent[]): number {
  const raw = components.reduce((sum, c) => sum + c.points, 0)
  return Math.round(Math.min(100, Math.max(0, raw)))
}

/**
 * Recommendation bands are derived from the total in CODE, not chosen by the
 * model. Two prospects with the same score always get the same label.
 *
 * The `decision_influence` floor exists because a high total built on domain
 * fit alone is a trap: someone genuinely interesting who cannot create or refer
 * an opportunity does not advance the mission.
 */
export function deriveRecommendation(total: number, components: ScoutComponent[]): Recommendation {
  const influence = components.find((c) => c.dimension === 'decision_influence')
  const influenceRatio = influence ? influence.points / influence.max : 0

  if (total >= 75 && influenceRatio >= 0.5) return 'STRONG'
  if (total >= 55) return 'MAYBE'
  return 'WEAK'
}

function buildComponents(raw: Record<string, { score?: number; explanation?: string }>): ScoutComponent[] {
  return SCOUT_DIMENSIONS.map((dimension) => {
    const entry = raw?.[dimension] ?? {}
    const normalized = clampScore(typeof entry.score === 'number' ? entry.score : 0)
    const max = DIMENSION_MAX[dimension]
    return {
      dimension,
      normalized,
      points: Math.round(normalized * max * 10) / 10,
      max,
      explanation: (entry.explanation ?? '').trim(),
    }
  })
}

// ─── Prompt ──────────────────────────────────────────────────────────────────

// v4.0.0 — iteration 2. Two changes driven by iteration 1 failure analysis:
//   (a) SCORE COMPRESSION: every component in the top 20 landed between 0.84
//       and 0.98, so ranking inside the top was effectively random. Added an
//       explicit spread requirement and a worked anchor per band.
//   (b) PROCESS vs DISCRETE: the judge rejected "AI for manufacturing"
//       generalists as interchangeable. The user's edge is chemical/process
//       industries and quality systems, not generic Industry 4.0, so
//       background_relevance and differentiation now discriminate on that axis.
// v4.1.0 — iteration 3. The remaining top-20 rejections were all ADJACENT-BUT-
// OFF-MISSION verticals scored at 22–24.5/25 on background relevance: pharma
// (CONTINUUS), food safety (Novolyze), life-science ingredients (Mironova),
// metallurgy (BANIQL). Process depth transfers there, but they are not what the
// mission asked for, so background_relevance is now capped at 0.7 for them.
// v5.0.0 — Phase 6. Scoring now receives grounded, sourced company and person
// dossiers. The first Phase 6 run showed the research was CORRECT (Avid
// Engineers really is MEP/building systems; Semco Carbon really is graphite
// machining) but the scorer still ranked them 79-89 — it had the evidence and
// did not act on it. This version makes the researched CORE BUSINESS decisive.
export const SCORER_PROMPT_VERSION = '5.0.0'

function systemPrompt(profileBlock: string, missionBlock: string): string {
  return `You are a recruiting scout evaluating whether specific people are worth cold-outreach effort for ONE specific undergraduate.

${missionBlock}

════════ THE USER ════════
${profileBlock}

════════ YOUR TASK ════════
For each prospect, judge FIVE dimensions independently. Score each from 0.0 to 1.0.
You do NOT compute a total. You do NOT assign a recommendation. Code does that.

1. opportunity_fit — ${DIMENSION_QUESTION.opportunity_fit}
2. background_relevance — ${DIMENSION_QUESTION.background_relevance}
3. decision_influence — ${DIMENSION_QUESTION.decision_influence}
4. differentiation — ${DIMENSION_QUESTION.differentiation}
5. accessibility — ${DIMENSION_QUESTION.accessibility}

════════ CALIBRATION — READ CAREFULLY ════════

⚠ MANDATORY SPREAD. You are ranking, not grading. If most of a batch lands in one narrow band
the output is worthless — it produces a random ordering. Within EVERY batch you must actually
use the range: some prospects below 0.4, some above 0.85. Reserve 0.9+ for the genuinely
exceptional. "Plausibly relevant" is 0.5, NOT 0.85. Being in roughly the right industry is a
0.5, not a 0.9.

⚠ THE SINGLE MOST IMPORTANT DISTINCTION — PROCESS vs DISCRETE:
The user's edge is CHEMICAL and PROCESS industries: chemicals, petrochemicals, energy,
materials, pharma/CPG formulation, refining, batch/continuous production, and the quality and
validation systems around them. He has ALSO shipped agentic AI, which is rare in that world.
He does NOT have a special edge in discrete manufacturing (robotics, machining, assembly,
CNC, warehouse automation) or in generic "Industry 4.0 / OEE dashboards / predictive
maintenance" — dozens of strong students look identical there.
A company doing AI for chemical plants, refineries, process control, or lab/quality workflows
is a MUCH better fit than one doing AI for factory-floor OEE, even though both say
"AI for manufacturing".

opportunity_fit:
  0.9+  Company plainly does work the user is qualified for AND is the kind of place that
        takes on interns or short projects (startup, growth-stage, active industrial innovation).
  0.6   Right industry, but unclear whether this specific org would host a winter project.
  0.35  Adjacent industry, weak path to a real project.
  0.2-  Could not plausibly host a winter project for a ChemE undergraduate.

⚠ WHEN RESEARCHED COMPANY CONTEXT IS PRESENT, IT OVERRIDES EVERYTHING ELSE.
The Apollo industry label and keywords are lexical noise; the researched "WHAT THEY DO" is
what the company actually sells. Judge on that, and be decisive about the CORE business:

  • Core business is buildings, MEP, HVAC, facilities, commissioning, construction, real
    estate or architecture → background_relevance ≤ 0.45, even if they serve "industrial
    facilities". Building systems are not process engineering.
  • Core business is EHS/environmental/safety compliance, restructuring, headcount reduction,
    org design, or generic "operational excellence" with no process/plant depth
    → background_relevance ≤ 0.5.
  • Core business is IT staffing, ERP/software implementation, or reselling someone else's
    supply-chain product → background_relevance ≤ 0.45.
  • Core business is niche contract machining/fabrication with no process chemistry, no R&D
    and no digital dimension → opportunity_fit ≤ 0.45; a job shop rarely creates a
    student project.
  • Research explicitly said mission_relevant = false → opportunity_fit ≤ 0.3 AND
    background_relevance ≤ 0.3. Do not rescue it.

Conversely, when the research shows chemicals, process manufacturing, materials, energy
production, industrial AI/software sold into plants, or genuine process/operations
consulting as the CORE business, score it confidently high. That is the whole point of
having researched it.

background_relevance — REAL overlap, not vague adjacency. Be strict:
  0.9+  ON-MISSION vertical AND process depth: industrial AI, manufacturing operations,
        chemicals/petrochemicals, energy and industrial technology, enterprise AI with an
        industrial wedge, industrial/operations consulting, or a technically ambitious
        startup in those spaces.
  0.7   ADJACENT vertical with real process depth but OFF the mission's stated targets —
        pharma/biotech, food safety, life-science ingredients, metallurgy/mining, medical
        devices, agriculture. His process skills transfer, but this is not what he asked for,
        and the domain knowledge gap is real. Cap these at 0.7 however process-heavy they look.
  0.6   Industrial but DISCRETE manufacturing (robotics, machining, assembly, CNC, warehouse
        automation), or general industrial AI with no process dimension.
  0.4   General enterprise software / general ops / tangential technical domain.
  0.2-  Fintech, adtech, healthcare services, retail, media, consumer apps. NO real overlap.
  Do NOT credit "they use AI" as overlap — nearly every company does. Credit CHEMICAL,
  PROCESS, ENERGY, MATERIALS or QUALITY-SYSTEM specificity IN AN ON-MISSION VERTICAL.
  If the company description is thin or generic, that is evidence AGAINST a specific fit —
  score it at or below 0.55 rather than assuming a niche that is not stated.

decision_influence — can they create, shape, sponsor or refer?
  0.9+  Founder/CEO of a small company, or a VP/Head/Director who directly owns the relevant
        function and can create a project or make a referral.
  0.6   Senior, relevant function, but would likely route through a formal process.
  0.35  So large an org that they would forward the email to HR.
  0.2-  No authority over hiring, projects or budget in a relevant area.

differentiation — would THIS person find THIS background unusual? Be harsh here:
  0.9+  The ChemE-depth + shipped-industrial-AI + founder combination is directly, specifically
        valuable to what THIS company is building. They would read it and want to talk.
  0.6   Genuinely strong, but they see many strong technical students with a similar shape.
  0.35  Background is fine but confers no advantage over any other ambitious undergraduate.
  0.2-  Irrelevant to them.
  A generic "AI for manufacturing" startup sees a LOT of manufacturing-AI-interested students.
  That is a 0.5–0.6, not a 0.9. Reserve 0.9 for a real, statable, company-specific edge.

accessibility — will they actually reply to a cold email from an undergraduate?
  0.9+  Founder/exec at a company under ~100 people; publicly engaged; used to student contact.
  0.7   Leader at a 100–500 person company.
  0.5   Director/VP at a mid-size firm — plausible but a real gamble.
  0.3   Senior leader at a 5,000+ person company.
  0.15- Executive at a 20,000+ person corporation. They do not read cold student mail.
  Company size is the dominant factor. Be honest and pessimistic.

════════ GROUNDING — STRICT ════════
"why_i_fit_them" MUST reference specific resume items by their bracketed id.
"resume_item_ids" MUST list exactly the ids you referenced.
ONLY use ids that appear in the resume list above. Never invent an experience, a company,
a skill, or a number the user does not actually have. If the overlap is weak, say so plainly
and score background_relevance low — do NOT manufacture a connection.

════════ OUTPUT ════════
Return ONLY valid JSON:
{
  "prospects": [
    {
      "candidate_id": "<echo the id given>",
      "opportunity_fit":       { "score": 0.0, "explanation": "one specific sentence" },
      "background_relevance":  { "score": 0.0, "explanation": "one specific sentence" },
      "decision_influence":    { "score": 0.0, "explanation": "one specific sentence" },
      "differentiation":       { "score": 0.0, "explanation": "one specific sentence" },
      "accessibility":         { "score": 0.0, "explanation": "one specific sentence" },
      "why_they_fit": "2-3 sentences on why this company/person could produce an opportunity",
      "why_i_fit_them": "2-3 sentences citing resume ids in [brackets]",
      "resume_item_ids": ["id1", "id2"],
      "risks": "1-2 sentences on what makes this prospect weaker"
    }
  ]
}`
}

export function renderProspectForPrompt(
  candidateId: string,
  person: PersonCandidate,
  company: CompanyCandidate | null,
  companyDossier?: CompanyDossier | null,
  personDossier?: PersonDossier | null
): string {
  const parts = [
    `--- CANDIDATE ${candidateId} ---`,
    `Name: ${person.name}`,
    `Title: ${person.title ?? 'unknown'}`,
    `Seniority band: ${person.seniority ?? 'unknown'}`,
    `Location: ${person.location ?? 'unknown'}`,
    `Company: ${person.company_name ?? 'unknown'}`,
  ]
  if (company) {
    parts.push(`Company employees: ${company.employee_count ?? 'unknown'}`)
    parts.push(`Company industry (Apollo label): ${company.industry ?? 'unknown'}`)
    parts.push(`Company location: ${company.hq_location ?? 'unknown'}`)
    if (company.founded_year) parts.push(`Founded: ${company.founded_year}`)
  }

  // Grounded research supersedes the Apollo label. Phase 3 scored from a company
  // name plus a keyword list and could not tell an industrial consultancy from a
  // golf-club advisory; this block is the fix.
  if (companyDossier && !companyDossier.research_failed) {
    parts.push('', '=== RESEARCHED COMPANY CONTEXT (grounded, sourced) ===')
    parts.push(renderCompanyDossier(companyDossier))
  } else {
    parts.push('', '=== COMPANY RESEARCH: UNAVAILABLE ===')
    parts.push('No grounded context could be retrieved. Judge conservatively: absence of')
    parts.push('evidence is NOT evidence of relevance. Cap background_relevance at 0.55.')
    if (company?.description) parts.push(`Apollo description only: ${company.description.slice(0, 300)}`)
    if (company?.sub_industries.length) parts.push(`Apollo keywords only: ${company.sub_industries.slice(0, 10).join(', ')}`)
  }

  if (personDossier && !personDossier.research_failed) {
    parts.push('', '=== RESEARCHED PERSON CONTEXT (grounded, sourced) ===')
    parts.push(renderPersonDossier(personDossier))
  }

  return parts.join('\n')
}

// ─── Scoring call ────────────────────────────────────────────────────────────

export interface ScoreBatchInput {
  candidateId: string
  person: PersonCandidate
  company: CompanyCandidate | null
  /** Phase 6: grounded dossiers. When present, scoring reasons over evidence. */
  companyDossier?: CompanyDossier | null
  personDossier?: PersonDossier | null
}

export interface ScoreBatchResult {
  scores: ScoutScore[]
  usage: ScoringUsage
}

/**
 * Score a batch. Batching gives the model relative calibration — scoring one
 * prospect in isolation drifts badly toward the middle of the range.
 *
 * Results are cached on the rendered prompt + prompt version, so re-running the
 * eval after a non-scoring change (filters, ranking, judge) costs nothing. Bump
 * SCORER_PROMPT_VERSION to invalidate.
 */
export async function scoreBatch(
  batch: ScoreBatchInput[],
  profileBlock: string,
  missionBlock: string,
  validResumeIds: string[]
): Promise<ScoreBatchResult> {
  const usage: ScoringUsage = { calls: 0, tokens_in: 0, tokens_out: 0, cost_estimate: 0 }
  if (batch.length === 0) return { scores: [], usage }

  const userPrompt = [
    `Evaluate these ${batch.length} prospects. Return one entry per candidate_id.`,
    '',
    ...batch.map((b) => renderProspectForPrompt(b.candidateId, b.person, b.company, b.companyDossier, b.personDossier)),
  ].join('\n\n')

  const key = cacheKey('score', { v: SCORER_PROMPT_VERSION, model: modelFor('reasoning'), userPrompt })
  const hit = cacheGet<{ scores: ScoutScore[] }>(key)
  if (hit) return { scores: hit.scores, usage }

  const response = await openaiClient().chat.completions.create({
    model: modelFor('reasoning'),
    messages: [
      { role: 'system', content: systemPrompt(profileBlock, missionBlock) },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
    temperature: temperatureFor('reasoning'),
    max_completion_tokens: 900 * batch.length + 500,
  })

  usage.calls = 1
  usage.tokens_in = response.usage?.prompt_tokens ?? 0
  usage.tokens_out = response.usage?.completion_tokens ?? 0
  usage.cost_estimate = estimateCost(usage.tokens_in, usage.tokens_out)

  const raw = response.choices[0]?.message?.content ?? '{}'
  let parsed: { prospects?: Record<string, unknown>[] }
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { scores: [], usage }
  }

  const validIds = new Set(validResumeIds)
  const scores: ScoutScore[] = []

  for (const entry of parsed.prospects ?? []) {
    const candidateId = String(entry.candidate_id ?? '')
    if (!candidateId) continue

    const components = buildComponents(entry as Record<string, { score?: number; explanation?: string }>)
    const total = computeTotal(components)

    const citedRaw = Array.isArray(entry.resume_item_ids) ? entry.resume_item_ids.map(String) : []
    // Deterministic grounding validation — an id the model invented is caught here,
    // not by hoping the prompt held.
    const cited = citedRaw.filter((id) => validIds.has(id))
    const ungrounded = citedRaw.filter((id) => !validIds.has(id))

    scores.push({
      candidate_id: candidateId,
      components,
      total,
      why_they_fit: String(entry.why_they_fit ?? '').trim(),
      why_i_fit_them: String(entry.why_i_fit_them ?? '').trim(),
      resume_item_ids: cited,
      risks: String(entry.risks ?? '').trim(),
      recommendation: deriveRecommendation(total, components),
      ungrounded_ids: ungrounded,
    })
  }

  // Only cache a batch that actually produced results — caching an empty parse
  // failure would make the failure permanent and invisible.
  if (scores.length > 0) cacheSet(key, { scores })
  return { scores, usage }
}
