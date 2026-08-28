// Evidence Matcher Agent.
//
// Judgment problem it owns: "which 1–3 experiences, which facts, which metrics
// make this person interesting for THIS job — and what must not be claimed?"
//
// Retrieval is not its job. The orchestrator picks the experiences whose
// detail is shown (principle 5: summaries for all, detail for a few); this
// agent judges the slate. Every id it returns is checked against the ids the
// code supplied, so a fact it invents cannot reach the tailor.

import { runAgent } from '../runtime/loop'
import { normalizeModelText } from '../runtime/text'
import type { AgentResult, ToolContext } from '../runtime/types'
import { evidenceMatcherPrompt, type EvidenceMatcherInput } from './prompt'

export { evidenceMatcherPrompt }
export type { EvidenceMatcherInput }

export interface EvidenceMatch {
  why_i_fit: string
  top_experience_ids: string[]
  fact_ids: string[]
  metric_ids: string[]
  skill_ids: string[]
  story_ids: string[]
  gaps: string[]
  best_differentiator: string
  emphasize: string[]
  /** The tailor's prohibitions. Empty only with `no_gaps_reason`. */
  do_not_claim: string[]
  no_gaps_reason: string | null
  /** Ids the model cited that the code never supplied. Counted, never used. */
  ungrounded_ids: number
}

export const OUTPUT_SCHEMA = {
  properties: {
    why_i_fit: { type: 'string', description: '3-5 sentences, first person, specific.' },
    top_experience_ids: { type: 'array', items: { type: 'string' }, description: '1-3 experience ids, best first.' },
    fact_ids: { type: 'array', items: { type: 'string' }, description: 'At most 10 fact ids.' },
    metric_ids: { type: 'array', items: { type: 'string' }, description: 'At most 6 metric ids.' },
    skill_ids: { type: 'array', items: { type: 'string' }, description: 'At most 10 skill ids the job actually calls for.' },
    story_ids: { type: 'array', items: { type: 'string' }, description: 'At most 2 story ids.' },
    gaps: { type: 'array', items: { type: 'string' }, description: 'What the job wants that the record shows weakly or not at all.' },
    best_differentiator: { type: 'string', description: 'One sentence: the strongest hook.' },
    emphasize: { type: 'array', items: { type: 'string' }, description: 'What the résumé should foreground for THIS job.' },
    do_not_claim: {
      type: 'array',
      items: { type: 'string' },
      description: 'Things the job asks for that the evidence does not support, in the job\'s own words. Required; see system prompt.',
    },
    no_gaps_reason: {
      type: ['string', 'null'],
      description: 'Only when do_not_claim is empty: what you checked and why nothing is unsupported.',
    },
  },
  required: [
    'why_i_fit', 'top_experience_ids', 'fact_ids', 'metric_ids', 'skill_ids', 'story_ids',
    'gaps', 'best_differentiator', 'emphasize', 'do_not_claim', 'no_gaps_reason',
  ],
}

function strings(v: unknown, limit: number): string[] {
  if (!Array.isArray(v)) return []
  return v.map((x) => normalizeModelText(x)).filter(Boolean).slice(0, limit)
}

/** Keep the ids the code supplied, in the model's order, deduped; count the rest. */
function filterIds(v: unknown, valid: Set<string>, limit: number): { kept: string[]; dropped: number } {
  const kept: string[] = []
  let dropped = 0
  if (!Array.isArray(v)) return { kept, dropped }
  const seen = new Set<string>()
  for (const x of v) {
    const id = String(x ?? '').trim()
    if (!id || seen.has(id)) continue
    if (!valid.has(id)) {
      dropped++
      continue
    }
    seen.add(id)
    if (kept.length < limit) kept.push(id)
  }
  return { kept, dropped }
}

export function makeEvidenceMatchValidator(validIds: EvidenceMatcherInput['validIds']) {
  const experiences = new Set(validIds.experience_ids)
  const facts = new Set(validIds.fact_ids)
  const metrics = new Set(validIds.metric_ids)
  const skills = new Set(validIds.skill_ids)
  const stories = new Set(validIds.story_ids)

  return (raw: unknown): EvidenceMatch | null => {
    if (!raw || typeof raw !== 'object') return null
    const r = raw as Record<string, unknown>

    const whyIFit = normalizeModelText(r.why_i_fit)
    if (!whyIFit) return null

    const exp = filterIds(r.top_experience_ids, experiences, 3)
    const fact = filterIds(r.fact_ids, facts, 10)
    const metric = filterIds(r.metric_ids, metrics, 6)
    const skill = filterIds(r.skill_ids, skills, 10)
    const story = filterIds(r.story_ids, stories, 2)

    // A match that names no real experience or no real fact has nothing for
    // the tailor to build on — and the loop can ask again cheaply.
    if (exp.kept.length === 0 || fact.kept.length === 0) return null

    const doNotClaim = strings(r.do_not_claim, 12)
    const noGapsReason =
      r.no_gaps_reason === null || r.no_gaps_reason === undefined ? null : normalizeModelText(r.no_gaps_reason) || null
    // Prohibitions are required output. Silence is not "no gaps".
    if (doNotClaim.length === 0 && !noGapsReason) return null

    return {
      why_i_fit: whyIFit,
      top_experience_ids: exp.kept,
      fact_ids: fact.kept,
      metric_ids: metric.kept,
      skill_ids: skill.kept,
      story_ids: story.kept,
      gaps: strings(r.gaps, 8),
      best_differentiator: normalizeModelText(r.best_differentiator),
      emphasize: strings(r.emphasize, 8),
      do_not_claim: doNotClaim,
      no_gaps_reason: doNotClaim.length === 0 ? noGapsReason : null,
      ungrounded_ids: exp.dropped + fact.dropped + metric.dropped + skill.dropped + story.dropped,
    }
  }
}

export async function runEvidenceMatcher(
  input: EvidenceMatcherInput,
  ctx: ToolContext,
  opts: { cacheKeyParts?: Record<string, unknown>; onStep?: (info: { step: number; elapsedMs: number; stopReason: string | null; toolCalls: string[] }) => void } = {}
): Promise<AgentResult<EvidenceMatch>> {
  return runAgent<EvidenceMatcherInput, EvidenceMatch>({
    agentId: 'evidence_matcher',
    // What it selects is what the résumé foregrounds and what the tailor is
    // forbidden to write. Worth the standard tier.
    tier: 'standard',
    modelRole: 'reasoning',
    prompt: evidenceMatcherPrompt,
    input,
    outputSchema: OUTPUT_SCHEMA,
    validate: makeEvidenceMatchValidator(input.validIds),
    ctx,
    webSearch: false,
    maxSteps: 3,
    maxTokens: 5000,
    cacheKeyParts: opts.cacheKeyParts,
    onStep: opts.onStep,
  })
}
