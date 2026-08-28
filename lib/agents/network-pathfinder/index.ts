// Network Pathfinder Agent.
//
// Judgment problem it owns: "of these contacts with a plausible connection to
// this company, who is a real warm path, how strong, and what is the right
// ask?" Candidates are retrieved by code (lib/career/network/candidates.ts);
// this agent only judges the slate, so a contact_id it returns must be one it
// was shown — anything else is a hallucinated person and is stripped.

import { runAgent } from '../runtime/loop'
import { normalizeModelText } from '../runtime/text'
import { clamp01 } from '@/lib/career/fit/dimensions'
import type { WarmPathRelationship } from '@/lib/career/types'
import type { AgentResult, ToolContext } from '../runtime/types'
import { networkPathfinderPrompt, type NetworkPathfinderInput, type PathfinderCandidate } from './prompt'

export { networkPathfinderPrompt }
export type { NetworkPathfinderInput, PathfinderCandidate }

const RELATIONSHIPS: WarmPathRelationship[] = [
  'current_employee', 'former_employee', 'alumni', 'founder', 'investor',
  'mentor', 'prior_outreach', 'second_degree', 'portfolio', 'other',
]

export interface JudgedPath {
  contact_id: string
  relationship: WarmPathRelationship
  strength: number
  why_relevant: string
  suggested_action: string
  existing_history: string | null
}

export interface PathfinderOutput {
  paths: JudgedPath[]
  note: string
  /** contact_ids the model returned that were not on the slate. */
  stripped_ids: number
}

export const OUTPUT_SCHEMA = {
  properties: {
    paths: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          contact_id: { type: 'string', description: 'Copied exactly from the candidate line.' },
          relationship: { type: 'string', enum: RELATIONSHIPS },
          strength: { type: 'number', description: '0 to 1.' },
          why_relevant: { type: 'string', description: 'One sentence.' },
          suggested_action: { type: 'string', description: 'Concrete, imperative, one line.' },
          existing_history: { type: ['string', 'null'] },
        },
        required: ['contact_id', 'relationship', 'strength', 'why_relevant', 'suggested_action', 'existing_history'],
      },
    },
    note: { type: 'string', description: 'Two sentences on the slate as a whole.' },
  },
  required: ['paths', 'note'],
}

export function makePathfinderValidator(candidates: PathfinderCandidate[]) {
  const slate = new Set(candidates.map((c) => c.contact_id))

  return (raw: unknown): PathfinderOutput | null => {
    if (!raw || typeof raw !== 'object') return null
    const r = raw as Record<string, unknown>
    if (!Array.isArray(r.paths)) return null
    const note = normalizeModelText(r.note)
    if (!note) return null

    const paths: JudgedPath[] = []
    const used = new Set<string>()
    let stripped = 0
    for (const entry of r.paths) {
      if (!entry || typeof entry !== 'object') continue
      const p = entry as Record<string, unknown>
      const id = String(p.contact_id ?? '').trim()
      if (!slate.has(id)) {
        stripped++
        continue
      }
      if (used.has(id)) continue
      const relationship = String(p.relationship ?? '') as WarmPathRelationship
      // Enum exact. A relationship the schema does not know is a model that
      // did not read the schema; let the loop correct it.
      if (!RELATIONSHIPS.includes(relationship)) return null
      const why = normalizeModelText(p.why_relevant)
      const action = normalizeModelText(p.suggested_action)
      if (!why || !action) return null
      used.add(id)
      paths.push({
        contact_id: id,
        relationship,
        strength: clamp01(p.strength),
        why_relevant: why,
        suggested_action: action,
        existing_history:
          p.existing_history === null || p.existing_history === undefined
            ? null
            : normalizeModelText(p.existing_history) || null,
      })
    }

    // An empty path list is a legitimate answer ("nobody here is a real path").
    return { paths, note, stripped_ids: stripped }
  }
}

export async function runNetworkPathfinder(
  input: NetworkPathfinderInput,
  ctx: ToolContext,
  opts: { cacheKeyParts?: Record<string, unknown>; onStep?: (info: { step: number; elapsedMs: number; stopReason: string | null; toolCalls: string[] }) => void } = {}
): Promise<AgentResult<PathfinderOutput>> {
  return runAgent<NetworkPathfinderInput, PathfinderOutput>({
    agentId: 'network_pathfinder',
    // Reading fifteen rows the code already qualified. Cheap.
    tier: 'cheap',
    modelRole: 'reasoning',
    prompt: networkPathfinderPrompt,
    input: { ...input, candidates: input.candidates.slice(0, 15) },
    outputSchema: OUTPUT_SCHEMA,
    validate: makePathfinderValidator(input.candidates.slice(0, 15)),
    ctx,
    webSearch: false,
    maxSteps: 3,
    maxTokens: 4000,
    cacheKeyParts: opts.cacheKeyParts,
    onStep: opts.onStep,
  })
}
