// Person Research Agent.
//
// Judgment problem it owns: "what does this person actually own, and is there a
// real reason they would care?"
//
// Runs only on people who survived company validation and the Apollo shortlist,
// because it is the most expensive step per prospect.

import { runAgent } from '../runtime/loop'
import { normalizeTitlePatterns } from '@/lib/scouting/titles'
import { validateClaimsAgainstEvidence } from '@/lib/research/types'
import type { ResearchClaim } from '@/lib/research/types'
import type { AgentResult, EvidenceSource, ToolContext } from '../runtime/types'
import { personResearchPrompt, type PersonResearchInput } from './prompt'

export type { PersonResearchInput }

export type PersonVerdict = 'KEEP' | 'MAYBE' | 'REJECT' | 'SEARCH_FOR_DIFFERENT_PERSON'

export interface PersonResearch {
  verdict: PersonVerdict
  /** Set only for SEARCH_FOR_DIFFERENT_PERSON. A searchable job title. */
  better_role_hypothesis: string | null
  verdict_reasoning: string
  apparent_ownership: string
  function_relevance: string
  decision_maker_assessment: string
  can_create_opportunity: boolean
  recent_initiatives: string[]
  /** The specific, non-generic overlap — or an honest statement that none exists. */
  specific_interest_hook: string | null
  claims: ResearchClaim[]
  uncertainties: string[]
  /** True when the public record was genuinely thin. A finding, not a failure. */
  thin_public_record: boolean
  downgraded_claims: number
}

const PERSON_VERDICTS: PersonVerdict[] = ['KEEP', 'MAYBE', 'REJECT', 'SEARCH_FOR_DIFFERENT_PERSON']

const OUTPUT_SCHEMA = {
  properties: {
    verdict: {
      type: 'string',
      enum: PERSON_VERDICTS,
      description:
        'SEARCH_FOR_DIFFERENT_PERSON means the company is right but this individual is not, and you can name a better role.',
    },
    better_role_hypothesis: {
      type: ['string', 'null'],
      description:
        'REQUIRED for SEARCH_FOR_DIFFERENT_PERSON. A real searchable job title, 2-5 words, no parentheses or slashes. Null otherwise.',
    },
    verdict_reasoning: { type: 'string', description: 'Why this verdict.' },
    apparent_ownership: {
      type: 'string',
      description: 'The real scope this person owns — function, site, product line, group, P&L. Not a restatement of their title.',
    },
    function_relevance: { type: 'string', description: 'How their function relates to the mission.' },
    decision_maker_assessment: {
      type: 'string',
      description: 'Could they start a project, sponsor an intern, fund a pilot, or make a referral that matters?',
    },
    can_create_opportunity: { type: 'boolean' },
    recent_initiatives: {
      type: 'array',
      items: { type: 'string' },
      description: 'Things THIS PERSON did, not things their company did. Empty is fine and common.',
    },
    specific_interest_hook: {
      type: ['string', 'null'],
      description: 'The specific non-generic overlap that would make this person read on. Null if there genuinely is none.',
    },
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          type: { type: 'string', enum: ['FACT', 'INFERENCE', 'UNKNOWN'] },
          source_url: { type: ['string', 'null'], description: 'Required for FACT. Null otherwise.' },
          source_title: { type: ['string', 'null'] },
          confidence: { type: 'number' },
          relevance: { type: ['string', 'null'] },
        },
        required: ['claim', 'type', 'source_url', 'confidence'],
      },
    },
    uncertainties: { type: 'array', items: { type: 'string' } },
    thin_public_record: {
      type: 'boolean',
      description: 'True if you found little about this person specifically. This is the normal case — report it honestly.',
    },
  },
  required: [
    'verdict', 'better_role_hypothesis', 'verdict_reasoning',
    'apparent_ownership', 'function_relevance', 'decision_maker_assessment',
    'can_create_opportunity', 'recent_initiatives', 'specific_interest_hook',
    'claims', 'uncertainties', 'thin_public_record',
  ],
}

function strings(v: unknown, limit = 8): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, limit)
}

function validate(raw: unknown, evidence: EvidenceSource[]): PersonResearch | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>

  const ownership = String(r.apparent_ownership ?? '').trim()
  if (!ownership) return null

  const { claims, downgraded } = validateClaimsAgainstEvidence(
    Array.isArray(r.claims) ? r.claims : [],
    evidence.map((e) => e.url)
  )

  const hook = typeof r.specific_interest_hook === 'string' ? r.specific_interest_hook.trim() : ''

  const stated = String(r.verdict ?? '').toUpperCase() as PersonVerdict
  let verdict: PersonVerdict = PERSON_VERDICTS.includes(stated) ? stated : 'MAYBE'

  // A re-scout request is only actionable with a searchable title attached.
  // Without one it is just a rejection wearing a more optimistic label.
  const betterRole = normalizeTitlePatterns(
    typeof r.better_role_hypothesis === 'string' ? [r.better_role_hypothesis] : [],
    1
  )[0] ?? null

  if (verdict === 'SEARCH_FOR_DIFFERENT_PERSON' && !betterRole) verdict = 'REJECT'

  return {
    verdict,
    better_role_hypothesis: verdict === 'SEARCH_FOR_DIFFERENT_PERSON' ? betterRole : null,
    verdict_reasoning: String(r.verdict_reasoning ?? '').trim(),
    apparent_ownership: ownership,
    function_relevance: String(r.function_relevance ?? '').trim(),
    decision_maker_assessment: String(r.decision_maker_assessment ?? '').trim(),
    can_create_opportunity: r.can_create_opportunity === true,
    recent_initiatives: strings(r.recent_initiatives),
    specific_interest_hook: hook.length > 0 ? hook : null,
    claims,
    uncertainties: strings(r.uncertainties),
    thin_public_record: r.thin_public_record === true,
    downgraded_claims: downgraded,
  }
}

export async function runPersonResearch(
  input: PersonResearchInput,
  ctx: ToolContext
): Promise<AgentResult<PersonResearch>> {
  return runAgent<PersonResearchInput, PersonResearch>({
    agentId: 'person_research',
    modelRole: 'reasoning',
    prompt: personResearchPrompt,
    input,
    outputSchema: OUTPUT_SCHEMA,
    validate,
    ctx,
    webSearch: true,
    maxWebSearches: 3,
    maxSteps: 5,
    maxTokens: 5000,
    cacheKeyParts: {
      person: input.person.name,
      title: input.person.title,
      company: input.person.company_name,
      linkedin: input.person.linkedin_url,
      goal: input.mission.goal,
    },
  })
}

/** Compact rendering for the ranking prompt. Kept tight — prompt budget. */
export function renderPersonResearch(r: PersonResearch): string {
  const lines = [
    `RESEARCHER VERDICT: ${r.verdict} — ${r.verdict_reasoning}`,
    `OWNS: ${r.apparent_ownership}`,
    `FUNCTION RELEVANCE: ${r.function_relevance}`,
    `CAN CREATE OPPORTUNITY: ${r.can_create_opportunity ? 'yes' : 'unclear/no'} — ${r.decision_maker_assessment}`,
  ]
  if (r.recent_initiatives.length) lines.push(`THEIR OWN RECENT WORK: ${r.recent_initiatives.slice(0, 3).join('; ')}`)
  lines.push(`SPECIFIC HOOK: ${r.specific_interest_hook ?? 'NONE FOUND — no non-generic reason identified'}`)
  const facts = r.claims.filter((c) => c.type === 'FACT').slice(0, 4)
  if (facts.length) {
    lines.push('VERIFIED FACTS:')
    for (const f of facts) lines.push(`  • ${f.claim}`)
  }
  if (r.thin_public_record) lines.push('NOTE: public record on this individual is thin.')
  return lines.join('\n')
}
