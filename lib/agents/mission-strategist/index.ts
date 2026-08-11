// Mission Strategist Agent.
//
// Judgment problem it owns: "given this goal and this person, where should we
// even be looking?" That is genuinely interpretive — it is why this is an agent
// and not a config file of search terms.
//
// Pure with respect to the database. The orchestrator persists the output.

import { runAgent } from '../runtime/loop'
import type { AgentResult, ToolContext } from '../runtime/types'
import { missionStrategistPrompt, type MissionStrategistInput } from './prompt'

export type { MissionStrategistInput }

export interface SearchSegment {
  name: string
  rationale: string
  search_queries: string[]
  title_patterns: string[]
  required_domain_terms: string[]
  exclusions: string[]
  priority: number
}

export interface MissionStrategy {
  segments: SearchSegment[]
  positioning_angle: string
  reasoning: string
}

const OUTPUT_SCHEMA = {
  properties: {
    segments: {
      type: 'array',
      description: 'Distinct market segments to search. No two may return overlapping companies.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short segment name.' },
          rationale: {
            type: 'string',
            description: 'Why this segment plausibly yields a real opportunity for THIS person.',
          },
          search_queries: {
            type: 'array',
            items: { type: 'string' },
            description: 'Web search queries that surface actual operating companies in this segment.',
          },
          title_patterns: {
            type: 'array',
            items: { type: 'string' },
            description: 'Job titles of people who own the relevant work. Appropriate seniority, not maximum.',
          },
          required_domain_terms: {
            type: 'array',
            items: { type: 'string' },
            description: 'Words that must plausibly describe a company for it to belong to this segment.',
          },
          exclusions: {
            type: 'array',
            items: { type: 'string' },
            description: 'Adjacent-but-wrong organization types a naive search would return.',
          },
          priority: {
            type: 'number',
            description: 'Expected yield of GOOD conversations, 0 to 1.',
          },
        },
        required: ['name', 'rationale', 'search_queries', 'title_patterns', 'required_domain_terms', 'exclusions', 'priority'],
      },
    },
    positioning_angle: {
      type: 'string',
      description: 'The 1-3 things about this background that make the person unusually interesting, not merely qualified.',
    },
    reasoning: { type: 'string', description: 'Why this set of segments, briefly.' },
  },
  required: ['segments', 'positioning_angle', 'reasoning'],
}

function clamp01(n: unknown): number {
  const v = typeof n === 'number' ? n : 0.5
  return Math.min(1, Math.max(0, v))
}

function strings(v: unknown, limit = 12): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, limit)
}

/** Structural validation. Invalid output is a retryable failure, not something to patch around. */
function validate(raw: unknown): MissionStrategy | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.segments) || r.segments.length === 0) return null

  const segments: SearchSegment[] = []
  for (const entry of r.segments) {
    if (!entry || typeof entry !== 'object') continue
    const s = entry as Record<string, unknown>
    const name = String(s.name ?? '').trim()
    const queries = strings(s.search_queries, 6)
    const titles = strings(s.title_patterns, 10)
    // A segment with no name, no way to find companies, or no one to contact is
    // not a partial result — it is unusable.
    if (!name || queries.length === 0 || titles.length === 0) continue

    segments.push({
      name,
      rationale: String(s.rationale ?? '').trim(),
      search_queries: queries,
      title_patterns: titles,
      required_domain_terms: strings(s.required_domain_terms, 12),
      exclusions: strings(s.exclusions, 12),
      priority: clamp01(s.priority),
    })
  }

  if (segments.length === 0) return null

  const positioning = String(r.positioning_angle ?? '').trim()
  if (!positioning) return null

  return { segments, positioning_angle: positioning, reasoning: String(r.reasoning ?? '').trim() }
}

export async function runMissionStrategist(
  input: MissionStrategistInput,
  ctx: ToolContext
): Promise<AgentResult<MissionStrategy>> {
  return runAgent<MissionStrategistInput, MissionStrategy>({
    agentId: 'mission_strategist',
    modelRole: 'reasoning',
    prompt: missionStrategistPrompt,
    input,
    outputSchema: OUTPUT_SCHEMA,
    validate,
    ctx,
    webSearch: true,
    maxWebSearches: 3,
    maxSteps: 5,
    maxTokens: 6000,
  })
}
