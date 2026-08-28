// Fit Evaluator Agent.
//
// Judgment problem it owns: "along ten dimensions, how does this job fit this
// person — and can they apply at all?"
//
// It judges the evidence it is handed, exactly like lib/agents/ranking: no web
// search, no tools. The Company Researcher has already gathered what there is
// to gather, and letting this agent search would make its numbers depend on
// what it happened to find rather than on the shared research every job is
// judged against.
//
// ADR-004: components only. The total lives in lib/career/fit/evaluate.ts.

import { runAgent } from '../runtime/loop'
import { normalizeModelText } from '../runtime/text'
import { clamp01 } from '@/lib/career/fit/dimensions'
import { FIT_DIMENSIONS, type Eligibility, type FitComponent, type FitDimension, type FitJudgment } from '@/lib/career/types'
import type { AgentResult, ToolContext } from '../runtime/types'
import { fitEvaluatorPrompt, renderJobForPrompt, type FitEvaluatorInput, type FitJobInput } from './prompt'

export { fitEvaluatorPrompt, renderJobForPrompt }
export type { FitEvaluatorInput, FitJobInput }

const ELIGIBILITIES: Eligibility[] = ['QUALIFIED', 'STRETCH', 'NOT_QUALIFIED', 'UNKNOWN']

export const OUTPUT_SCHEMA = {
  properties: {
    components: {
      type: 'array',
      description: `Exactly one entry per dimension: ${FIT_DIMENSIONS.join(', ')}.`,
      items: {
        type: 'object',
        properties: {
          dimension: { type: 'string', enum: FIT_DIMENSIONS },
          score: { type: 'number', description: '0.0 to 1.0.' },
          explanation: { type: 'string', description: 'ONE sentence, grounded in the inputs.' },
          evidence: {
            type: 'array',
            items: { type: 'string' },
            description: 'At most 2 short quotes from the job or the evidence lines.',
          },
        },
        required: ['dimension', 'score', 'explanation', 'evidence'],
      },
    },
    eligibility: { type: 'string', enum: ELIGIBILITIES },
    eligibility_reasoning: {
      type: 'string',
      description: 'Which requirement decided it. NOT_QUALIFIED must quote the posting.',
    },
    explanation: { type: 'string', description: '3-4 sentences: what it is, why care, why this fit.' },
    uncertainties: { type: 'array', items: { type: 'string' } },
    red_flags: { type: 'array', items: { type: 'string' } },
    missing_qualifications: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number', description: '0 to 1.' },
  },
  required: [
    'components', 'eligibility', 'eligibility_reasoning', 'explanation',
    'uncertainties', 'red_flags', 'missing_qualifications', 'confidence',
  ],
}

function strings(v: unknown, limit: number): string[] {
  if (!Array.isArray(v)) return []
  return v.map((x) => normalizeModelText(x)).filter(Boolean).slice(0, limit)
}

/**
 * Rejects, never repairs. A missing dimension is not "score it 0.5" — it is a
 * model that did not do the job, and the loop asks it again.
 */
export function validateFitJudgment(raw: unknown): FitJudgment | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.components)) return null

  const byDimension = new Map<FitDimension, FitComponent>()
  for (const entry of r.components) {
    if (!entry || typeof entry !== 'object') return null
    const c = entry as Record<string, unknown>
    const dim = String(c.dimension ?? '') as FitDimension
    if (!FIT_DIMENSIONS.includes(dim)) return null
    // Twice is as wrong as never: the second answer would silently win.
    if (byDimension.has(dim)) return null
    if (typeof c.score !== 'number' || !Number.isFinite(c.score)) return null
    const explanation = normalizeModelText(c.explanation)
    if (!explanation) return null
    byDimension.set(dim, {
      dimension: dim,
      score: clamp01(c.score),
      explanation,
      evidence: strings(c.evidence, 2),
    })
  }
  if (byDimension.size !== FIT_DIMENSIONS.length) return null

  const eligibility = String(r.eligibility ?? '').toUpperCase() as Eligibility
  if (!ELIGIBILITIES.includes(eligibility)) return null

  const explanation = normalizeModelText(r.explanation)
  if (!explanation) return null

  return {
    components: FIT_DIMENSIONS.map((d) => byDimension.get(d)!),
    eligibility,
    eligibility_reasoning: normalizeModelText(r.eligibility_reasoning),
    explanation,
    uncertainties: strings(r.uncertainties, 8),
    red_flags: strings(r.red_flags, 8),
    missing_qualifications: strings(r.missing_qualifications, 10),
    confidence: clamp01(r.confidence),
  }
}

export async function runFitEvaluator(
  input: FitEvaluatorInput,
  ctx: ToolContext,
  opts: { cacheKeyParts?: Record<string, unknown>; onStep?: (info: { step: number; elapsedMs: number; stopReason: string | null; toolCalls: string[] }) => void } = {}
): Promise<AgentResult<FitJudgment>> {
  return runAgent<FitEvaluatorInput, FitJudgment>({
    agentId: 'fit_evaluator',
    // Standard, not cheap: ten calibrated judgments plus an eligibility verdict
    // that decides whether a job is shown at all. Getting eligibility wrong on
    // a job the user would have loved costs more than the tier difference.
    tier: 'standard',
    modelRole: 'reasoning',
    prompt: fitEvaluatorPrompt,
    input,
    outputSchema: OUTPUT_SCHEMA,
    validate: validateFitJudgment,
    ctx,
    webSearch: false,
    maxSteps: 3,
    maxTokens: 5000,
    // Cache per (job, evidence, research) identity — the caller knows the job
    // id and the description hash; the prompt version and model fold in
    // automatically. Omitted = always live.
    cacheKeyParts: opts.cacheKeyParts,
    onStep: opts.onStep,
  })
}
