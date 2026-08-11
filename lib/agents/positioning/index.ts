// Positioning Agent.
//
// Judgment problem it owns: "for THIS recipient, what is the most compelling
// version of this candidate?"
//
// The hard part is subtraction. Ranking already established that a prospect is
// worth contacting and, in doing so, cited whatever background looked relevant —
// on the measured prototype run it cited five items for one prospect. Five items
// is not a position, it is a résumé. This agent picks at most three and names
// what to leave out.
//
// No web search: it reasons over research the pipeline already paid for
// (ADR-021). If it needs a fact nobody gathered, it says so in `risks` rather
// than going and buying it.

import { runAgent } from '../runtime/loop'
import type { AgentResult, ToolContext } from '../runtime/types'
import { positioningPrompt, type BackgroundItem, type PositioningInput } from './prompt'

export type { PositioningInput, BackgroundItem }

export interface ProofPoint {
  background_id: string
  why_it_matters: string
}

export interface Positioning {
  positioning_thesis: string
  top_proof_points: ProofPoint[]
  recipient_priorities: string[]
  why_me: string
  why_now: string
  do_not_mention: { item: string; reason: string }[]
  recommended_ask: string
  confidence: number
  risks: string
  /** Ids the model cited that do not exist. Surfaced, never silently dropped. */
  ungrounded_ids: string[]
}

const OUTPUT_SCHEMA = {
  properties: {
    positioning_thesis: {
      type: 'string',
      description:
        'One sentence anchored on a CONCRETE PARTICULAR of this recipient — a named programme, system, site, decision or stated priority. Not a job-type category. It must break if you swap in someone with the same title at a competitor.',
    },
    top_proof_points: {
      type: 'array',
      description: 'AT MOST THREE. Two is often better. Cite background ids from the list given.',
      items: {
        type: 'object',
        properties: {
          background_id: { type: 'string', description: 'An id from the supplied background list.' },
          why_it_matters: { type: 'string', description: 'Why THIS recipient specifically would care.' },
        },
        required: ['background_id', 'why_it_matters'],
      },
    },
    recipient_priorities: {
      type: 'array',
      items: { type: 'string' },
      description: 'What is plausibly on this person\'s plate, from their research — not their job title.',
    },
    why_me: { type: 'string', description: 'The credibility that makes them willing to spend 20 minutes.' },
    why_now: {
      type: 'string',
      description: 'A real timing reason. If there is none, say so rather than inventing urgency.',
    },
    do_not_mention: {
      type: 'array',
      description: 'Things that would dilute this argument, look naive to this recipient, or invite a losing comparison.',
      items: {
        type: 'object',
        properties: {
          item: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['item', 'reason'],
      },
    },
    recommended_ask: { type: 'string', description: 'The smallest step still worth their time.' },
    confidence: { type: 'number', description: '0 to 1. Lower it honestly when the angle is thin.' },
    risks: { type: 'string', description: 'Why this positioning might not land.' },
  },
  required: [
    'positioning_thesis', 'top_proof_points', 'recipient_priorities', 'why_me',
    'why_now', 'do_not_mention', 'recommended_ask', 'confidence', 'risks',
  ],
}

function strings(v: unknown, limit = 6): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, limit)
}

export async function runPositioning(
  input: PositioningInput,
  ctx: ToolContext
): Promise<AgentResult<Positioning>> {
  const validIds = new Set(input.background.map((b) => b.id))

  const validate = (raw: unknown): Positioning | null => {
    if (!raw || typeof raw !== 'object') return null
    const r = raw as Record<string, unknown>

    const thesis = String(r.positioning_thesis ?? '').trim()
    if (!thesis) return null

    const cited = Array.isArray(r.top_proof_points) ? r.top_proof_points : []
    const proof: ProofPoint[] = []
    const ungrounded: string[] = []
    const seen = new Set<string>()

    for (const entry of cited) {
      if (!entry || typeof entry !== 'object') continue
      const p = entry as Record<string, unknown>
      const id = String(p.background_id ?? '').trim()
      if (!id || seen.has(id)) continue
      seen.add(id)
      // Grounding is enforced here, not requested in the prompt: an invented id
      // cannot reach the draft stage and be presented as a real credential.
      if (!validIds.has(id)) {
        ungrounded.push(id)
        continue
      }
      proof.push({ background_id: id, why_it_matters: String(p.why_it_matters ?? '').trim() })
    }

    // A position with no evidence behind it is an assertion. Reject and retry.
    if (proof.length === 0) return null

    // An empty ask makes the brief unactionable — the judge caught one and
    // marked the whole brief down for it.
    const ask = String(r.recommended_ask ?? '').trim()
    if (!ask) return null

    const doNot = Array.isArray(r.do_not_mention)
      ? r.do_not_mention
          .filter((d): d is Record<string, unknown> => Boolean(d) && typeof d === 'object')
          .map((d) => ({ item: String(d.item ?? '').trim(), reason: String(d.reason ?? '').trim() }))
          .filter((d) => d.item.length > 0)
          .slice(0, 6)
      : []

    const confidence =
      typeof r.confidence === 'number' && Number.isFinite(r.confidence)
        ? Math.min(1, Math.max(0, r.confidence))
        : 0.5

    return {
      positioning_thesis: thesis,
      // Hard cap. The instruction is "at most three"; the code is what makes it true.
      top_proof_points: proof.slice(0, 3),
      recipient_priorities: strings(r.recipient_priorities),
      why_me: String(r.why_me ?? '').trim(),
      why_now: String(r.why_now ?? '').trim(),
      do_not_mention: doNot,
      recommended_ask: ask,
      confidence,
      risks: String(r.risks ?? '').trim(),
      ungrounded_ids: ungrounded,
    }
  }

  return runAgent<PositioningInput, Positioning>({
    agentId: 'positioning',
    // Judgment about what to cut is the whole task, and it runs once per
    // shortlisted prospect — a small number by the time it is reached.
    tier: 'standard',
    modelRole: 'reasoning',
    prompt: positioningPrompt,
    input,
    outputSchema: OUTPUT_SCHEMA,
    validate,
    ctx,
    // Reuses research the pipeline already bought. If a fact is missing it says
    // so in `risks` rather than paying to go and find it.
    webSearch: false,
    maxSteps: 3,
    maxTokens: 3000,
    cacheKeyParts: {
      person: input.person.name,
      company: input.person.company,
      goal: input.mission.goal,
      // Research and background are inputs: if either changes, the position must
      // be recomputed rather than replayed.
      research: input.personContext.slice(0, 400),
      background: input.background.map((b) => b.id).join(','),
    },
  })
}

/** Compact rendering for the outreach prompt and the UI. */
export function renderPositioning(p: Positioning, byId: Map<string, BackgroundItem>): string {
  const proof = p.top_proof_points
    .map((pp) => `  • [${pp.background_id}] ${byId.get(pp.background_id)?.title ?? pp.background_id} — ${pp.why_it_matters}`)
    .join('\n')

  return [
    `THESIS: ${p.positioning_thesis}`,
    `WHY ME: ${p.why_me}`,
    `WHY NOW: ${p.why_now}`,
    `PROOF POINTS (use only these):\n${proof}`,
    p.recipient_priorities.length ? `THEIR PRIORITIES: ${p.recipient_priorities.join('; ')}` : '',
    p.do_not_mention.length ? `DO NOT MENTION: ${p.do_not_mention.map((d) => `${d.item} (${d.reason})`).join('; ')}` : '',
    `ASK: ${p.recommended_ask}`,
  ]
    .filter(Boolean)
    .join('\n')
}
