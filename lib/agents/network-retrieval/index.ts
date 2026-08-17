// Network Retrieval Agent — the internal-first entry point.
//
// Judgment problem it owns: "given a mission, which people ALREADY in the
// database matter, and what vocabulary finds them?"
//
// Nothing else owns this. The Mission Strategist plans an EXTERNAL market;
// Market Discovery searches the web; Person Triage judges a slate at one
// company for one mission. None of them can look inside a database of 897
// people who were found for other missions and decide which ones matter now.
//
// It is a real bounded agent, not a query: the first search vocabulary is
// usually wrong, and the ability to notice that ("42 matches, all of them
// consumer-goods marketers") and reformulate is the entire value. Bounded by a
// search budget the tool enforces, not by asking the model to be brief.
//
// ADR-004 holds here as everywhere: the agent emits COMPONENTS and the code
// computes the total (lib/network/rank.ts). It never emits an overall score.

import { runAgent } from '../runtime/loop'
import { normalizeModelText } from '../runtime/text'
import type { AgentResult, ToolContext } from '../runtime/types'
import { buildSearchTool, type NetworkSearchFn, type SearchLogEntry } from './tool'
import { networkRetrievalPrompt, type NetworkRetrievalInput } from './prompt'
import type { NetworkCandidate } from '@/lib/network/search'

export { networkRetrievalPrompt }
export type { NetworkRetrievalInput, SearchLogEntry, NetworkSearchFn }

export interface RetrievedCandidate {
  contact_id: string
  components: {
    mission_fit: number
    decision_access: number
    user_differentiation: number
  }
  confidence: number
  reason: string
  evidence: string[]
  /** How to approach given the relationship history. Empty for a cold contact. */
  approach: string | null
}

export interface NetworkRetrievalOutput {
  shortlist: RetrievedCandidate[]
  /** What the mission needs that the network does not contain. Feeds external discovery. */
  missing_profile: string[]
  pool_assessment: string
}

const OUTPUT_SCHEMA = {
  properties: {
    shortlist: {
      type: 'array',
      description: 'Best first. Fewer strong people beats more weak ones.',
      items: {
        type: 'object',
        properties: {
          contact_id: {
            type: 'string',
            description: 'The id at the start of a search-result line, before the " | ". Copy it exactly.',
          },
          mission_fit: { type: 'number', description: '0-1. Does their actual work intersect the mission?' },
          decision_access: { type: 'number', description: '0-1. Could they create, sponsor, or refer it?' },
          user_differentiation: { type: 'number', description: '0-1. Is this user unusually interesting to them?' },
          confidence: { type: 'number', description: '0-1. How much evidence this rests on.' },
          reason: { type: 'string', description: 'ONE short sentence. Why this person, for this mission.' },
          evidence: {
            type: 'array',
            items: { type: 'string' },
            description: 'At most 2 short quotes from their row supporting the reason.',
          },
          approach: {
            type: ['string', 'null'],
            description:
              'How to open, given the relationship history — e.g. "reconnect, you met in March" or ' +
              '"ignored a previous email; only worth writing because the ask is different now". ' +
              'null for a never-contacted person.',
          },
        },
        required: ['contact_id', 'mission_fit', 'decision_access', 'user_differentiation', 'confidence', 'reason', 'evidence', 'approach'],
      },
    },
    missing_profile: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Kinds of person this mission needs that the network does not contain. Be specific enough to search ' +
        'for externally — "operations consultants at industrial-focused firms in Chicago", not "more people".',
    },
    pool_assessment: {
      type: 'string',
      description: 'Two or three sentences: what the network actually offers for this mission.',
    },
  },
  required: ['shortlist', 'missing_profile', 'pool_assessment'],
}

function clamp01(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0
  return Math.min(1, Math.max(0, v))
}

export interface NetworkRetrievalRun {
  result: AgentResult<NetworkRetrievalOutput>
  /** Every search the agent ran. This is what makes retrieval inspectable. */
  searchLog: SearchLogEntry[]
  /** Everything any search returned, by contact id. */
  seen: Map<string, NetworkCandidate>
}

export async function runNetworkRetrieval(
  input: NetworkRetrievalInput,
  ctx: ToolContext,
  opts: {
    userId: string
    exclude?: string[]
    maxSearches?: number
    search?: NetworkSearchFn
    onSearch?: (entry: SearchLogEntry & { elapsedMs: number }) => void
    onStep?: (info: { step: number; elapsedMs: number; stopReason: string | null; toolCalls: string[] }) => void
  } = { userId: ctx.user_id }
): Promise<NetworkRetrievalRun> {
  const searchLog: SearchLogEntry[] = []
  const seen = new Map<string, NetworkCandidate>()

  const tool = buildSearchTool({
    userId: opts.userId ?? ctx.user_id,
    log: searchLog,
    seen,
    exclude: opts.exclude,
    // Six, not eight. Measured: the marginal search after the fifth returned
    // almost no contacts the earlier ones had not, and each one costs its rows
    // in every later turn's context.
    maxSearches: opts.maxSearches ?? 6,
    search: opts.search,
    onSearch: opts.onSearch,
  })

  const validate = (raw: unknown): NetworkRetrievalOutput | null => {
    if (!raw || typeof raw !== 'object') return null
    const r = raw as Record<string, unknown>
    if (!Array.isArray(r.shortlist)) return null

    const out: RetrievedCandidate[] = []
    const used = new Set<string>()
    for (const entry of r.shortlist) {
      if (!entry || typeof entry !== 'object') continue
      const c = entry as Record<string, unknown>
      const id = String(c.contact_id ?? '').trim()
      // A shortlisted id that no search returned is a hallucinated row. Dropping
      // it here is what keeps a model-invented contact from reaching a draft.
      if (!seen.has(id) || used.has(id)) continue
      used.add(id)
      out.push({
        contact_id: id,
        components: {
          mission_fit: clamp01(c.mission_fit),
          decision_access: clamp01(c.decision_access),
          user_differentiation: clamp01(c.user_differentiation),
        },
        confidence: clamp01(c.confidence),
        reason: normalizeModelText(c.reason),
        evidence: Array.isArray(c.evidence)
          ? c.evidence.map((e) => normalizeModelText(e)).filter(Boolean).slice(0, 3)
          : [],
        approach:
          c.approach === null || c.approach === undefined ? null : normalizeModelText(c.approach) || null,
      })
    }

    // An empty shortlist is a legitimate answer — it means "go look externally"
    // — so it is NOT a validation failure. It is only a failure when the agent
    // also refused to say anything about the pool.
    const assessment = normalizeModelText(r.pool_assessment)
    if (!assessment) return null

    return {
      shortlist: out,
      missing_profile: Array.isArray(r.missing_profile)
        ? r.missing_profile.map((m) => normalizeModelText(m)).filter(Boolean).slice(0, 6)
        : [],
      pool_assessment: assessment,
    }
  }

  const result = await runAgent<NetworkRetrievalInput, NetworkRetrievalOutput>({
    agentId: 'network_retrieval',
    // Standard, not cheap. This decides whether the run spends Apollo credits at
    // all; getting it wrong is more expensive than the tier difference.
    tier: 'standard',
    modelRole: 'reasoning',
    prompt: networkRetrievalPrompt,
    input,
    outputSchema: OUTPUT_SCHEMA,
    validate,
    tools: [tool as never],
    ctx,
    // The whole point is to NOT search the web. This agent looks inward.
    webSearch: false,
    maxSteps: (opts.maxSearches ?? 6) + 3,
    // A 20-person shortlist with three components, a reason and evidence each
    // genuinely does not fit in 6000 tokens. It truncated, and the loop then
    // escalated a tier and truncated again — see the max_tokens branch in
    // runtime/loop.ts. Sized to the real output, with the branch as the backstop.
    maxTokens: 12000,
    onStep: opts.onStep,
  })

  return { result, searchLog, seen }
}
