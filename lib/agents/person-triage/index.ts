// Person Triage Agent — TIER 1 (cheap).
//
// Judgment problem it owns: "of the people at this company, which few are worth
// paying to research?"
//
// This is the gate that makes the funnel affordable. Deep person research costs
// roughly $0.20 each; running it on every enriched candidate was ~$12 of a ~$18
// run, and most of that was spent on people the pipeline then discarded.
//
// It sees ONE company's candidates together, which is deliberate: relative
// judgment across a real slate is far easier than absolute judgment one person
// at a time, and it needs no web search to do it.

import { runAgent } from '../runtime/loop'
import type { AgentResult, ToolContext } from '../runtime/types'
import { personTriagePrompt, type PersonTriageInput, type TriageCandidate } from './prompt'

export type { PersonTriageInput, TriageCandidate }

export interface TriageScore {
  key: string
  score: number
  reason: string
}

export interface PersonTriageOutput {
  scores: TriageScore[]
  shortlist: string[]
  company_note: string
}

const OUTPUT_SCHEMA = {
  properties: {
    scores: {
      type: 'array',
      description: 'One entry per person given, by id. Use the full 0-1 range.',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The id shown for that person.' },
          score: { type: 'number', description: '0.0 to 1.0 — likelihood of reaching a final shortlist.' },
          reason: { type: 'string', description: 'One short sentence.' },
        },
        required: ['key', 'score', 'reason'],
      },
    },
    shortlist: {
      type: 'array',
      items: { type: 'string' },
      description: 'Ids of the people most worth researching in depth, best first.',
    },
    company_note: {
      type: 'string',
      description: 'One sentence on whether this company yielded anyone genuinely promising.',
    },
  },
  required: ['scores', 'shortlist', 'company_note'],
}

function clamp01(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0
  return Math.min(1, Math.max(0, v))
}

export async function runPersonTriage(
  input: PersonTriageInput,
  ctx: ToolContext
): Promise<AgentResult<PersonTriageOutput>> {
  const validKeys = new Set(input.candidates.map((c) => c.key))

  const validate = (raw: unknown): PersonTriageOutput | null => {
    if (!raw || typeof raw !== 'object') return null
    const r = raw as Record<string, unknown>
    if (!Array.isArray(r.scores)) return null

    const scores: TriageScore[] = []
    const seen = new Set<string>()
    for (const entry of r.scores) {
      if (!entry || typeof entry !== 'object') continue
      const s = entry as Record<string, unknown>
      const key = String(s.key ?? '')
      if (!validKeys.has(key) || seen.has(key)) continue
      seen.add(key)
      scores.push({ key, score: clamp01(s.score), reason: String(s.reason ?? '').trim() })
    }

    // Every candidate must be scored. A silently skipped person would be
    // dropped from the funnel without any recorded reason, which is the
    // diagnostic hole this whole pipeline is built to avoid.
    if (scores.length !== input.candidates.length) return null

    const shortlist = Array.isArray(r.shortlist)
      ? r.shortlist.filter((k): k is string => typeof k === 'string' && validKeys.has(k))
      : []

    return {
      scores,
      // Fall back to score order rather than failing: the scores are the real
      // output, and the shortlist is just their top slice.
      shortlist: shortlist.length
        ? shortlist
        : [...scores].sort((a, b) => b.score - a.score).slice(0, input.shortlistSize).map((s) => s.key),
      company_note: String(r.company_note ?? '').trim(),
    }
  }

  return runAgent<PersonTriageInput, PersonTriageOutput>({
    agentId: 'person_triage',
    // The whole point of this agent is to be cheap. It judges metadata against a
    // researched company profile — no synthesis, no search.
    tier: 'cheap',
    modelRole: 'fast',
    prompt: personTriagePrompt,
    input,
    outputSchema: OUTPUT_SCHEMA,
    validate,
    ctx,
    webSearch: false,
    maxSteps: 3,
    maxTokens: 2500,
    cacheKeyParts: {
      company: input.company.name,
      goal: input.mission.goal,
      candidates: input.candidates.map((c) => `${c.key}|${c.title}|${c.location}`),
      shortlist: input.shortlistSize,
    },
  })
}
