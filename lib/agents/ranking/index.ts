// Ranking Agent.
//
// ADR-004 made concrete: the model emits a 0–1 judgment per dimension; every
// piece of arithmetic — scaling to points, summing, banding into a
// recommendation — happens in the deterministic code imported from
// lib/scouting/score.ts. The model never sees a point value and never returns a
// total, so it cannot target one.
//
// No web search. Ranking judges the evidence it was handed; if it could go
// looking for more, a low-evidence prospect could talk its way up.

import { runAgent } from '../runtime/loop'
import {
  DIMENSION_MAX,
  SCOUT_DIMENSIONS,
  computeTotal,
  deriveRecommendation,
  type Recommendation,
  type ScoutComponent,
  type ScoutDimension,
} from '@/lib/scouting/score'
import type { AgentResult, ToolContext } from '../runtime/types'
import { rankingPrompt, type RankingInput } from './prompt'

export type { RankingInput }

export interface RankedProspect {
  candidate_key: string
  components: ScoutComponent[]
  total: number
  recommendation: Recommendation
  why_they_fit: string
  why_i_fit_them: string
  resume_item_ids: string[]
  risks: string
  /** Ids the model cited that do not exist. Surfaced, never silently dropped. */
  ungrounded_ids: string[]
}

const OUTPUT_SCHEMA = {
  properties: {
    components: {
      type: 'array',
      description: 'One entry per dimension. All dimensions are required.',
      items: {
        type: 'object',
        properties: {
          dimension: { type: 'string', enum: SCOUT_DIMENSIONS },
          score: { type: 'number', description: '0.0 to 1.0. Use the full range.' },
          explanation: { type: 'string', description: 'One sentence, grounded in the evidence given.' },
        },
        required: ['dimension', 'score', 'explanation'],
      },
    },
    why_they_fit: { type: 'string' },
    why_i_fit_them: {
      type: 'string',
      description: 'Which 1-3 background items make this person unusually interesting to contact, and why THEY would care.',
    },
    resume_item_ids: {
      type: 'array',
      items: { type: 'string' },
      description: 'Background item ids backing why_i_fit_them. Only ids from the supplied list.',
    },
    risks: { type: 'string', description: 'The strongest reason this prospect might be a waste of effort.' },
  },
  required: ['components', 'why_they_fit', 'why_i_fit_them', 'resume_item_ids', 'risks'],
}

function clamp01(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0
  return Math.min(1, Math.max(0, v))
}

export async function runRanking(
  input: RankingInput,
  ctx: ToolContext
): Promise<AgentResult<RankedProspect>> {
  const validIds = new Set(input.backgroundItems.map((b) => b.id))

  const validate = (raw: unknown): RankedProspect | null => {
    if (!raw || typeof raw !== 'object') return null
    const r = raw as Record<string, unknown>
    if (!Array.isArray(r.components)) return null

    const byDimension = new Map<ScoutDimension, { score: number; explanation: string }>()
    for (const entry of r.components) {
      if (!entry || typeof entry !== 'object') continue
      const c = entry as Record<string, unknown>
      const dim = String(c.dimension ?? '') as ScoutDimension
      if (!SCOUT_DIMENSIONS.includes(dim)) continue
      byDimension.set(dim, {
        score: clamp01(c.score),
        explanation: String(c.explanation ?? '').trim(),
      })
    }

    // A missing dimension is invalid output, not a zero. Silently scoring a
    // dimension the model never judged would corrupt the total invisibly.
    if (byDimension.size !== SCOUT_DIMENSIONS.length) return null

    // ─── Deterministic arithmetic. The model contributed only `normalized`. ──
    const components: ScoutComponent[] = SCOUT_DIMENSIONS.map((dim) => {
      const judged = byDimension.get(dim)!
      const max = DIMENSION_MAX[dim]
      return {
        dimension: dim,
        normalized: judged.score,
        points: judged.score * max,
        max,
        explanation: judged.explanation,
      }
    })

    const total = computeTotal(components)
    const recommendation = deriveRecommendation(total, components)

    const citedRaw = Array.isArray(r.resume_item_ids)
      ? r.resume_item_ids.filter((x): x is string => typeof x === 'string')
      : []
    const resumeItemIds = citedRaw.filter((id) => validIds.has(id))
    const ungroundedIds = citedRaw.filter((id) => !validIds.has(id))

    return {
      candidate_key: input.candidate.key,
      components,
      total,
      recommendation,
      why_they_fit: String(r.why_they_fit ?? '').trim(),
      why_i_fit_them: String(r.why_i_fit_them ?? '').trim(),
      resume_item_ids: resumeItemIds,
      risks: String(r.risks ?? '').trim(),
      ungrounded_ids: ungroundedIds,
    }
  }

  return runAgent<RankingInput, RankedProspect>({
    agentId: 'ranking',
    // Judging supplied evidence against fixed dimensions — no search, no synthesis.
    tier: 'cheap',
    modelRole: 'reasoning',
    prompt: rankingPrompt,
    input,
    outputSchema: OUTPUT_SCHEMA,
    validate,
    ctx,
    webSearch: false,
    maxSteps: 3,
    maxTokens: 3000,
  })
}
