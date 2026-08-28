// Resume Fact Verifier Agent.
//
// Judgment problem it owns: "is every factual clause in this proposed bullet
// supported by the Evidence Bank?"
//
// One change per call, so a verdict cannot bleed from one bullet into the
// next. Standard tier; the loop escalates to premium only when the schema is
// not satisfied, never to get a friendlier answer.
//
// The overall verdict is recomputed from the clauses in code and must match
// what the model said. The model does not get to summarise its own findings
// loosely — "mostly supported" is not a verdict this schema can express.

import { runAgent } from '../runtime/loop'
import { normalizeModelText } from '../runtime/text'
import type { AgentResult, ToolContext } from '../runtime/types'
import type { ClauseVerdict, VerifiedClause } from '@/lib/career/types'
import { resumeFactVerifierPrompt, type ResumeFactVerifierInput } from './prompt'

export type { ResumeFactVerifierInput } from './prompt'

export type VerifierOverall = 'SUPPORTED' | 'UNSUPPORTED' | 'UNCERTAIN'

export interface ResumeFactVerifierOutput {
  clauses: VerifiedClause[]
  overall: VerifierOverall
  notes: string
  /** Fact ids the model cited that the code never supplied. Stripped, counted. */
  dropped_fact_ids: number
}

const VERDICTS: ClauseVerdict[] = ['SUPPORTED', 'UNSUPPORTED', 'UNCERTAIN']

export const OUTPUT_SCHEMA = {
  properties: {
    clauses: {
      type: 'array',
      minItems: 1,
      description: 'One entry per atomic factual clause of the proposed bullet.',
      items: {
        type: 'object',
        properties: {
          clause: { type: 'string', description: 'The clause, quoted or closely paraphrased.' },
          verdict: { type: 'string', enum: VERDICTS },
          fact_ids: { type: 'array', items: { type: 'string' }, description: 'Ids of facts or metrics that support it. Empty if none.' },
          note: { type: 'string', description: 'One line: what supports it, or what is missing / stretched.' },
        },
        required: ['clause', 'verdict', 'fact_ids', 'note'],
      },
    },
    overall: {
      type: 'string',
      enum: VERDICTS,
      description: 'Strictest verdict present. UNSUPPORTED if any clause is; else UNCERTAIN if any is; else SUPPORTED.',
    },
    notes: { type: 'string' },
  },
  required: ['clauses', 'overall', 'notes'],
}

export function overallFromClauses(clauses: { verdict: ClauseVerdict }[]): VerifierOverall {
  if (clauses.some((c) => c.verdict === 'UNSUPPORTED')) return 'UNSUPPORTED'
  if (clauses.some((c) => c.verdict === 'UNCERTAIN')) return 'UNCERTAIN'
  return 'SUPPORTED'
}

/** Exported so the offline test can exercise it. Rejects, never repairs. */
export function validateVerifierOutput(raw: unknown, input: ResumeFactVerifierInput): ResumeFactVerifierOutput | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.clauses) || r.clauses.length === 0) return null

  const known = new Set<string>([...input.facts.map((f) => f.id), ...input.metrics.map((m) => m.id)])
  let dropped = 0
  const clauses: VerifiedClause[] = []
  for (const c of r.clauses) {
    if (!c || typeof c !== 'object') return null
    const x = c as Record<string, unknown>
    const clause = normalizeModelText(x.clause)
    const verdict = String(x.verdict ?? '') as ClauseVerdict
    if (!clause || !VERDICTS.includes(verdict)) return null
    const ids: string[] = []
    for (const id of Array.isArray(x.fact_ids) ? x.fact_ids : []) {
      if (typeof id !== 'string') continue
      if (known.has(id)) ids.push(id)
      else dropped++
    }
    clauses.push({ clause, verdict, fact_ids: Array.from(new Set(ids)), note: normalizeModelText(x.note) })
  }

  const computed = overallFromClauses(clauses)
  const stated = String(r.overall ?? '')
  if (stated !== computed) return null

  return { clauses, overall: computed, notes: normalizeModelText(r.notes), dropped_fact_ids: dropped }
}

/**
 * The strict Level 4 bar, applied by the pipeline: SUPPORTED overall, and
 * every clause cites at least one fact id. A bullet that has never been on the
 * résumé gets no credit for entailment from prose.
 */
export function meetsLevel4Bar(out: ResumeFactVerifierOutput): boolean {
  return out.overall === 'SUPPORTED' && out.clauses.every((c) => c.fact_ids.length > 0)
}

export async function runResumeFactVerifier(
  input: ResumeFactVerifierInput,
  ctx: ToolContext,
  opts: { onStep?: (info: { step: number; elapsedMs: number; stopReason: string | null; toolCalls: string[] }) => void } = {}
): Promise<AgentResult<ResumeFactVerifierOutput>> {
  return runAgent<ResumeFactVerifierInput, ResumeFactVerifierOutput>({
    agentId: 'resume_fact_verifier',
    tier: 'standard',
    modelRole: 'reasoning',
    prompt: resumeFactVerifierPrompt,
    input,
    outputSchema: OUTPUT_SCHEMA,
    validate: (raw) => validateVerifierOutput(raw, input),
    ctx,
    webSearch: false,
    maxSteps: 3,
    maxTokens: 3000,
    // Per bullet, not per patch: the same proposed text against the same
    // evidence is the same audit, whichever tailoring run asked for it.
    cacheKeyParts: {
      experience: input.experience_label,
      original: input.original_text,
      proposed: input.proposed_text,
      level: input.edit_level,
      facts: input.facts.map((f) => `${f.id}:${f.statement}`),
      metrics: input.metrics.map((m) => `${m.id}:${m.value}${m.unit ?? ''}${m.context ?? ''}`),
      bullets: input.other_bullets,
      skills: input.skills,
    },
    onStep: opts.onStep,
  })
}
