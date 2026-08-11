// The agent tool loop.
//
// One shape serves every agent: give the model Anthropic's server-side
// `web_search` tool, zero or more of our client-side tools, and exactly one
// `submit_result` tool carrying the agent's output schema. The loop ends when
// the model calls `submit_result` — so "finish" is itself a typed, validated
// action rather than a parse of free text.
//
// Two properties this buys, both structural rather than exhortative:
//
//   1. Output is schema-valid or the run is a retryable failure (ADR-007).
//   2. Every source URL is harvested from a real citation object attached to the
//      model's own text, never from prose. That list is the evidence pool a
//      FACT must cite (ADR-006).

import type Anthropic from '@anthropic-ai/sdk'
import { anthropicComplete, recordWebSearches } from '@/lib/providers/anthropic/client'
import { anthropicModelFor, ANTHROPIC_WEB_SEARCH_COST_PER_CALL } from '@/lib/ai/models'
import { cached, cacheKey } from '@/lib/providers/cache'
import type { ModelRole } from '@/lib/ai/models'
import type {
  AgentResult,
  AgentTool,
  EvidenceSource,
  ToolCallTrace,
  ToolContext,
  VersionedPrompt,
} from './types'

const WEB_SEARCH_TOOL_TYPE = process.env.ANTHROPIC_WEB_SEARCH_TOOL ?? 'web_search_20250305'
const SUBMIT = 'submit_result'

export interface RunAgentParams<TInput, TOutput> {
  agentId: string
  modelRole: ModelRole
  prompt: VersionedPrompt<TInput>
  input: TInput
  /** JSON Schema (object body) for the agent's final output. */
  outputSchema: Record<string, unknown>
  /** Validates and narrows the submitted output. null = invalid, retryable. */
  validate: (raw: unknown, evidence: EvidenceSource[]) => TOutput | null
  tools?: AgentTool<never>[]
  ctx: ToolContext
  /** Server-side web search. Off for agents that should only reason. */
  webSearch?: boolean
  maxWebSearches?: number
  maxSteps?: number
  maxTokens?: number
  /**
   * Identity of this agent's INPUT. Supplying it makes the result reusable
   * across runs. Omit to always call live.
   *
   * The prompt version and model are folded in automatically, so bumping a
   * prompt invalidates every cached result derived from it — which is what
   * keeps "reuse unchanged work" from quietly meaning "reuse stale work".
   */
  cacheKeyParts?: Record<string, unknown>
}

interface CitationLike {
  url?: string
  title?: string
  cited_text?: string
}

function httpUrl(u: string | undefined): string | null {
  if (!u) return null
  try {
    const p = new URL(u)
    return p.protocol === 'http:' || p.protocol === 'https:' ? p.toString() : null
  } catch {
    return null
  }
}

interface SearchResultLike {
  type?: string
  url?: string
  title?: string
}

interface BlockLike {
  type: string
  citations?: CitationLike[] | null
  content?: SearchResultLike[] | unknown
}

/**
 * Build the evidence pool from what the model ACTUALLY retrieved.
 *
 * Two sources, both structural — prose is never scanned for links:
 *
 *   web_search_tool_result   the search results themselves. This is the pool
 *                            that matters: an agent whose final answer arrives
 *                            as a `submit_result` tool call emits no cited text
 *                            at all, so relying on citations alone leaves the
 *                            pool empty and downgrades every genuine FACT.
 *   text block citations     stronger evidence when present — the model tied a
 *                            specific sentence to a specific page.
 */
function harvestEvidence(content: Anthropic.ContentBlock[], into: EvidenceSource[], seen: Set<string>): void {
  const add = (rawUrl: string | undefined, title: string | null, snippet: string | null) => {
    const url = httpUrl(rawUrl)
    if (!url || seen.has(url)) return
    seen.add(url)
    into.push({ url, title, snippet })
  }

  for (const block of content as unknown as BlockLike[]) {
    if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const r of block.content as SearchResultLike[]) {
        if (r?.type === 'web_search_result') add(r.url, r.title ?? null, null)
      }
      continue
    }
    if (block.type !== 'text') continue
    for (const c of block.citations ?? []) {
      add(c.url, c.title ?? null, c.cited_text ?? null)
    }
  }
}

/** Tool results re-enter the prompt, so cap what a misbehaving tool can inject. */
function serializeToolResult(value: unknown, limit = 6000): string {
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    text = String(value)
  }
  return text.length > limit ? `${text.slice(0, limit)}\n…[truncated]` : text
}

export async function runAgent<TInput, TOutput>(
  params: RunAgentParams<TInput, TOutput>
): Promise<AgentResult<TOutput>> {
  if (!params.cacheKeyParts) return runAgentLive(params)

  const key = cacheKey(`agent_${params.agentId}`, {
    ...params.cacheKeyParts,
    prompt_version: params.prompt.version,
    model: anthropicModelFor(params.modelRole),
  })

  let wasCached = true
  const result = await cached<AgentResult<TOutput>>(
    key,
    async () => {
      wasCached = false
      return runAgentLive(params)
    },
    false,
    // ADR-015: successes only. A cached failure is a permanent failure, and a
    // cached rate-limit error would outlive the rate limit by weeks.
    (r) => r.status === 'succeeded' && r.output !== null
  )

  // A replayed result cost nothing this run. Reporting its original cost again
  // would inflate every cost-per-prospect figure the evals depend on.
  return wasCached
    ? { ...result, trace: { ...result.trace, cost_usd: 0, tokens_in: 0, tokens_out: 0, web_searches: 0, from_cache: true } }
    : result
}

async function runAgentLive<TInput, TOutput>(
  params: RunAgentParams<TInput, TOutput>
): Promise<AgentResult<TOutput>> {
  const started = Date.now()
  const { system, user } = params.prompt.build(params.input)
  const model = anthropicModelFor(params.modelRole)
  const maxSteps = params.maxSteps ?? params.ctx.budget.maxAgentSteps ?? 8
  const toolsById = new Map<string, AgentTool<never>>((params.tools ?? []).map((t) => [t.name, t]))

  const evidence: EvidenceSource[] = []
  const seenUrls = new Set<string>()
  const toolsCalled: ToolCallTrace[] = []

  // Per-call accumulation, NOT a delta against the global counter. Agents run
  // concurrently, so overlapping deltas double-count: a smoke run summed $1.33
  // across agent_runs against a true total of $0.92.
  let tokensIn = 0
  let tokensOut = 0
  let costUsd = 0
  let webSearches = 0
  let steps = 0

  const tools: unknown[] = []
  if (params.webSearch !== false) {
    tools.push({
      type: WEB_SEARCH_TOOL_TYPE,
      name: 'web_search',
      max_uses: params.maxWebSearches ?? params.ctx.budget.maxWebSearches ?? 5,
    })
  }
  for (const t of params.tools ?? []) {
    tools.push({ name: t.name, description: t.description, input_schema: t.input_schema })
  }
  tools.push({
    name: SUBMIT,
    description:
      'Submit your final answer. Call this exactly once, when you have gathered enough evidence. ' +
      'You cannot answer any other way — text outside this tool call is ignored.',
    input_schema: { type: 'object', ...params.outputSchema },
  })

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: user }]

  const finish = (
    output: TOutput | null,
    status: AgentResult<TOutput>['status'],
    error: string | null
  ): AgentResult<TOutput> => ({
    output,
    status,
    error,
    evidence,
    trace: {
      agent_id: params.agentId,
      prompt_version: params.prompt.version,
      model,
      model_role: params.modelRole,
      provider_id: 'anthropic',
      tools_called: toolsCalled,
      web_searches: webSearches,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: costUsd,
      latency_ms: Date.now() - started,
      steps,
    },
  })

  while (steps < maxSteps) {
    steps++

    const res = await anthropicComplete({
      role: params.modelRole,
      system,
      messages,
      maxTokens: params.maxTokens ?? 4000,
      tools,
    })

    tokensIn += res.usage.inputTokens
    tokensOut += res.usage.outputTokens
    costUsd += res.usage.costUsd

    if (res.error) return finish(null, 'failed', res.error)

    harvestEvidence(res.content, evidence, seenUrls)

    // Server-side searches are billed per request, separately from tokens, and
    // they happen inside the model's turn — so nothing else can count them.
    const searchesThisTurn = res.content.filter(
      (b) =>
        (b as { type: string; name?: string }).type === 'server_tool_use' &&
        (b as { name?: string }).name === 'web_search'
    ).length
    if (searchesThisTurn > 0) {
      const searchCost = searchesThisTurn * ANTHROPIC_WEB_SEARCH_COST_PER_CALL
      webSearches += searchesThisTurn
      costUsd += searchCost
      recordWebSearches(searchesThisTurn, searchCost)
    }

    const submit = res.toolUses.find((t) => t.name === SUBMIT)
    if (submit) {
      const value = params.validate(submit.input, evidence)
      toolsCalled.push({
        tool: SUBMIT,
        args: {},
        result_summary: value === null ? 'schema validation failed' : 'accepted',
        ...(value === null ? { error: 'invalid output' } : {}),
      })
      if (value !== null) return finish(value, 'succeeded', null)

      // Invalid output is RETRYABLE, not a dead run (ADR-007). Discarding it
      // outright threw away a whole discovery round — every company found and
      // every search paid for — because one enum value was wrong. Hand the
      // model its own rejected output and let it correct itself.
      //
      // EVERY tool_use in the assistant turn needs a tool_result immediately
      // after it, including the rejected submit_result and any client tools the
      // model called alongside it. Replying with a bare text message instead is
      // a hard 400 from the API, which is how this path first failed.
      if (steps < maxSteps) {
        messages.push({ role: 'assistant', content: res.content })
        messages.push({
          role: 'user',
          content: res.toolUses.map<Anthropic.ToolResultBlockParam>((t) => ({
            type: 'tool_result',
            tool_use_id: t.id,
            is_error: true,
            content:
              t.name === SUBMIT
                ? `Rejected: this did not satisfy the schema. Re-read the tool's input_schema — every ` +
                  `required field must be present, enum fields must use one of the listed values exactly, ` +
                  `and fields you have no answer for must still appear (use null or an empty array). ` +
                  `Call ${SUBMIT} again with the same findings, corrected. Do not search again.`
                : `Skipped: ${SUBMIT} was called in the same turn and was rejected.`,
          })),
        })
        continue
      }
      return finish(null, 'invalid_output', 'submitted output failed schema validation')
    }

    // Client-side tools the model asked for this turn.
    const clientCalls = res.toolUses.filter((t) => t.name !== SUBMIT)

    if (clientCalls.length === 0) {
      // The model stopped without submitting. Nudge once; a second miss is a
      // real failure rather than something to paper over.
      if (steps >= maxSteps - 1) {
        return finish(null, 'failed', `agent ended after ${steps} steps without calling ${SUBMIT}`)
      }
      messages.push({ role: 'assistant', content: res.content })
      messages.push({
        role: 'user',
        content: `You have not submitted an answer yet. Call the ${SUBMIT} tool now with your best current conclusion, based on the evidence you have gathered. Do not search further.`,
      })
      continue
    }

    messages.push({ role: 'assistant', content: res.content })

    const results: Anthropic.ToolResultBlockParam[] = []
    for (const call of clientCalls) {
      const tool = toolsById.get(call.name)
      if (!tool) {
        toolsCalled.push({ tool: call.name, args: {}, error: 'unknown tool' })
        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          is_error: true,
          content: `Unknown tool "${call.name}".`,
        })
        continue
      }

      try {
        const outcome = await tool.execute(call.input as never, params.ctx)
        toolsCalled.push({
          tool: call.name,
          args: (call.input ?? {}) as Record<string, unknown>,
          result_summary: outcome.summary,
          ...(outcome.ok ? {} : { error: outcome.summary }),
        })
        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          is_error: !outcome.ok,
          content: serializeToolResult(outcome.result),
        })
      } catch (e) {
        // A failing tool degrades this agent's evidence, it does not halt the
        // run — the model is told and can proceed or conclude UNKNOWN.
        const message = e instanceof Error ? e.message : String(e)
        toolsCalled.push({ tool: call.name, args: {}, error: message })
        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          is_error: true,
          content: `Tool failed: ${message}`,
        })
      }
    }

    messages.push({ role: 'user', content: results })
  }

  return finish(null, 'failed', `agent exceeded ${maxSteps} steps without calling ${SUBMIT}`)
}

export { ANTHROPIC_WEB_SEARCH_COST_PER_CALL }
