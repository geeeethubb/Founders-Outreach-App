// Anthropic Messages client: auth, retry, rate limiting, budget, usage/cost
// accounting, and forced-tool structured output.
//
// Credentials come ONLY from ANTHROPIC_API_KEY and never leave the server.
// Callers request a model ROLE (see lib/ai/models.ts), never a model id.
//
// This is the low-level transport. Business logic depends on the interfaces in
// lib/providers/model.ts, not on this file directly — so swapping vendors is a
// provider change, not a rewrite. See docs/ARCHITECTURE.md ADR-016.

import Anthropic from '@anthropic-ai/sdk'
import {
  anthropicModelFor,
  estimateAnthropicCost,
  modelForTier,
  type ModelRole,
  type ModelTier,
} from '@/lib/ai/models'
import { cached, cacheKey } from '../cache'

// ─── Usage accounting ────────────────────────────────────────────────────────

export interface AnthropicUsage {
  calls: number
  cachedCalls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  webSearches: number
  costUsd: number
  errors: number
  /**
   * Transient failures that were retried. Distinct from `errors`, which counts
   * calls that gave up.
   *
   * Retries were invisible before Phase 10, and that hid a real failure mode: a
   * single call silently spending four attempts at a 120s timeout looks exactly
   * like a slow model from outside, and two agent runs were killed on the
   * assumption they had hung when they were in a retry storm.
   */
  retries: number
  byRole: Record<string, number>
  /** Calls and spend per tier — makes the router auditable after the fact. */
  byTier: Record<string, { calls: number; costUsd: number }>
  escalations: { agent: string; from: string; to: string; reason: string }[]
}

function emptyUsage(): AnthropicUsage {
  return {
    calls: 0,
    cachedCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    webSearches: 0,
    costUsd: 0,
    errors: 0,
    retries: 0,
    byRole: {},
    byTier: {},
    escalations: [],
  }
}

let usage = emptyUsage()

export function anthropicUsage(): AnthropicUsage {
  return { ...usage, byRole: { ...usage.byRole }, byTier: { ...usage.byTier }, escalations: [...usage.escalations] }
}

export function resetAnthropicUsage(): void {
  usage = emptyUsage()
}

/**
 * Records a tier escalation. Escalation that nobody can see becomes the default
 * within a month, so every one is logged with its reason.
 */
export function recordEscalation(agent: string, from: string, to: string, reason: string): void {
  usage.escalations.push({ agent, from, to, reason })
}

/** Recorded by the web-research provider, which is billed per search. */
export function recordWebSearches(n: number, costUsd: number): void {
  usage.webSearches += n
  usage.costUsd += costUsd
}

// ─── Run budget ──────────────────────────────────────────────────────────────
// A hard ceiling so an agent loop can never bill without bound. Mirrors the
// Apollo and web-search budgets.

let callBudget = Number(process.env.ANTHROPIC_MAX_CALLS_PER_RUN ?? 500)

// ─── Run deadline ────────────────────────────────────────────────────────────
// The retry loop below is right to be patient with a flaky API — up to four
// attempts, each with a two-minute timeout. It is wrong to be patient PAST the
// point where the orchestrator has already given up: a scout run with a 600s
// deadline spent 4120s inside retries during an API outage, because nothing
// here knew a deadline existed. An orchestrator that has one sets it; a call
// that would retry after it returns an error instead, and the run degrades
// the way every other failure does.

// TWO shapes, because the two callers have genuinely different lifetimes.
//
// `legacyDeadline` is ONE SLOT with REPLACE semantics, and that is deliberate.
// The scout orchestrator sets it at the top of a run and clears it in finish();
// if a run exits some other way — the planner throws — the slot is left stale,
// and the next run's set() overwrites it. That self-healing is load-bearing.
// Making this a set instead cost five consecutive scout runs: one leaked
// deadline stayed in the collection for ever, `pastRunDeadline` takes the
// EARLIEST, and every later run in the process reported "run deadline passed
// during retry" before doing any work. Replace beats accumulate for a
// long-lived, single-owner slot.
//
// `scopedDeadlines` is a set, and safe as one, because the ONLY way in is
// `withAnthropicDeadline`, which removes its own entry in a `finally`. That is
// what package generation uses, and it is what makes two concurrent packages
// safe — the bug that motivated the set in the first place was one package
// clearing another's deadline through the shared slot.
let legacyDeadline: number | null = null
const scopedDeadlines = new Set<number>()

export function setAnthropicDeadline(epochMs: number | null): void {
  legacyDeadline = epochMs
}

/**
 * Arm a deadline for the duration of `fn` and remove exactly that one
 * afterwards, leaving any concurrent run's deadline in place. Cannot leak: the
 * removal is in a `finally`.
 */
export async function withAnthropicDeadline<T>(epochMs: number, fn: () => Promise<T>): Promise<T> {
  scopedDeadlines.add(epochMs)
  try {
    return await fn()
  } finally {
    scopedDeadlines.delete(epochMs)
  }
}

/** Test seam. Named so nobody mistakes it for part of the retry contract. */
export function __pastRunDeadlineForTests(): boolean {
  return pastRunDeadline()
}

/** Test seam: forget every deadline, both shapes. */
export function resetAnthropicDeadlines(): void {
  legacyDeadline = null
  scopedDeadlines.clear()
}

/**
 * The earliest deadline anything has armed. Conservative across independent
 * runs on purpose: it can only make retries stop sooner, never later, and
 * stopping sooner degrades gracefully while stopping later is the failure this
 * whole mechanism exists to prevent.
 */
function pastRunDeadline(): boolean {
  let earliest = legacyDeadline ?? Infinity
  for (const d of scopedDeadlines) if (d < earliest) earliest = d
  return Number.isFinite(earliest) && Date.now() > earliest
}

export function setAnthropicBudget(n: number): void {
  callBudget = n
}

export class AnthropicBudgetExceeded extends Error {
  constructor(limit: number) {
    super(`Anthropic call budget exceeded (${limit} live calls). Raise ANTHROPIC_MAX_CALLS_PER_RUN.`)
    this.name = 'AnthropicBudgetExceeded'
  }
}

// ─── Client ──────────────────────────────────────────────────────────────────
// Lazily constructed. A module-level `new Anthropic()` would make every pure
// function in this tree unimportable without a key — a trap V1 already hit.

let client: Anthropic | null = null

export function anthropicAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY)
}

function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')
  if (!client) {
    client = new Anthropic({
      apiKey,
      // Retries are handled here so they are visible in our own accounting.
      maxRetries: 0,
      timeout: Number(process.env.ANTHROPIC_TIMEOUT_MS ?? 120_000),
    })
  }
  return client
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function isRetryable(status: number | undefined): boolean {
  return status === 429 || status === 408 || status === 409 || (status !== undefined && status >= 500)
}

// ─── Core completion ─────────────────────────────────────────────────────────

export type AnthropicMessage = Anthropic.MessageParam
export type AnthropicTool = Anthropic.Tool

export interface CompleteParams {
  role: ModelRole
  /** Overrides role-based model choice. This is the cost lever. */
  tier?: ModelTier
  system?: string
  messages: AnthropicMessage[]
  maxTokens?: number
  temperature?: number
  tools?: unknown[]
  toolChoice?: Anthropic.MessageCreateParams['tool_choice']
  /** Server-side tools (web_search) need this beta header on some accounts. */
  extraHeaders?: Record<string, string>
}

export interface CompleteResult {
  text: string
  model: string
  stopReason: string | null
  toolUses: { id: string; name: string; input: unknown }[]
  content: Anthropic.ContentBlock[]
  usage: { inputTokens: number; outputTokens: number; costUsd: number }
  error?: string
}

/**
 * One Messages call. Retries transient failures, records usage, and never
 * throws for an expected API condition — errors come back on the result so a
 * single failed agent step degrades the run instead of halting it.
 */
export async function anthropicComplete(params: CompleteParams): Promise<CompleteResult> {
  const model = params.tier ? modelForTier(params.tier) : anthropicModelFor(params.role)
  const empty: CompleteResult = {
    text: '',
    model,
    stopReason: null,
    toolUses: [],
    content: [],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  }

  if (!anthropicAvailable()) return { ...empty, error: 'ANTHROPIC_API_KEY is not set' }
  if (usage.calls >= callBudget) throw new AnthropicBudgetExceeded(callBudget)

  const tierKey = params.tier ?? 'role:' + params.role
  usage.calls++
  usage.byRole[params.role] = (usage.byRole[params.role] ?? 0) + 1
  const tierBucket = (usage.byTier[tierKey] ??= { calls: 0, costUsd: 0 })
  tierBucket.calls++

  const maxAttempts = 4
  let lastError = ''

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      if (pastRunDeadline()) {
        usage.errors++
        return { ...empty, error: `Anthropic: run deadline passed during retry — ${lastError.slice(0, 200)}` }
      }
      usage.retries++
      const base = Math.min(16_000, 700 * Math.pow(2, attempt))
      await sleep(Math.round(base * (0.5 + Math.random() * 0.5)))
    }

    try {
      const res = await getClient().messages.create(
        {
          model,
          max_tokens: params.maxTokens ?? 2048,
          ...(params.system ? { system: params.system } : {}),
          messages: params.messages,
          ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
          ...(params.tools ? { tools: params.tools as Anthropic.MessageCreateParams['tools'] } : {}),
          ...(params.toolChoice ? { tool_choice: params.toolChoice } : {}),
        },
        params.extraHeaders ? { headers: params.extraHeaders } : undefined
      )

      const inTok = res.usage.input_tokens ?? 0
      const outTok = res.usage.output_tokens ?? 0
      const cacheRead = (res.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0
      const cacheWrite = (res.usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0
      const cost = estimateAnthropicCost(model, inTok + cacheRead, outTok)

      usage.inputTokens += inTok
      usage.outputTokens += outTok
      usage.cacheReadTokens += cacheRead
      usage.cacheWriteTokens += cacheWrite
      usage.costUsd += cost
      tierBucket.costUsd += cost

      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim()

      const toolUses = res.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, input: b.input }))

      return {
        text,
        model,
        stopReason: res.stop_reason ?? null,
        toolUses,
        content: res.content,
        usage: { inputTokens: inTok, outputTokens: outTok, costUsd: cost },
      }
    } catch (e) {
      const status = (e as { status?: number }).status
      lastError = e instanceof Error ? e.message : String(e)
      if (!isRetryable(status) && status !== undefined) {
        usage.errors++
        return { ...empty, error: `Anthropic ${status}: ${lastError.slice(0, 240)}` }
      }
      // No status means a network fault — transient by nature, keep retrying.
    }
  }

  usage.errors++
  return { ...empty, error: `Anthropic: exhausted retries — ${lastError.slice(0, 240)}` }
}

// ─── Structured output ───────────────────────────────────────────────────────
// Anthropic has no JSON mode. A single tool with a JSON Schema, forced via
// tool_choice, is the reliable equivalent: the model must emit an object that
// conforms, and we get it as parsed input rather than as text to scrape.

export interface StructuredParams<T> extends Omit<CompleteParams, 'tools' | 'toolChoice'> {
  schemaName: string
  schemaDescription: string
  schema: Record<string, unknown>
  /** Validates and narrows. Returning null makes the call a retryable failure. */
  validate: (raw: unknown) => T | null
  /** Content-addressed cache key. Omit to always call live. */
  cacheKeyParts?: Record<string, unknown>
  /** Never cache a failure — a transient error must not become permanent. */
  cacheNamespace?: string
}

export interface StructuredResult<T> {
  value: T | null
  model: string
  usage: { inputTokens: number; outputTokens: number; costUsd: number }
  error?: string
}

export async function anthropicStructured<T>(params: StructuredParams<T>): Promise<StructuredResult<T>> {
  /**
   * Invalid output is RETRYABLE here, exactly as it is in the agent loop.
   *
   * Without this, one malformed entry killed an entire judging batch, and the
   * eval lost 10 verdicts to a single bad enum value. A structured call that
   * cannot retry makes every caller's success depend on the model getting it
   * right first time.
   */
  const MAX_ATTEMPTS = 3

  const run = async (): Promise<StructuredResult<T>> => {
    let last: StructuredResult<T> | null = null
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const result = await attempt_()
      if (result.value !== null) return result
      last = result
      // A transport error will not be fixed by asking again in the same way;
      // only schema-validation failures are worth another attempt.
      if (result.error && !/schema validation|no .* tool call/i.test(result.error)) break
      // TRUNCATION IS NOT A VALIDATION FAILURE. `no ... tool call
      // (stop_reason=max_tokens)` matches the pattern above, so a reply that ran
      // out of tokens used to be re-sent VERBATIM — the same prompt, the same
      // ceiling, the same truncation, three times, at up to 8 minutes each. The
      // agent loop learned this lesson (loop.ts handles max_tokens separately);
      // this path never did. Retrying identically cannot help, so stop.
      if (result.error && /max_tokens/i.test(result.error)) break
      // Nor is there any point starting another attempt past the run's deadline.
      if (pastRunDeadline()) break
    }
    return last!
  }

  const attempt_ = async (): Promise<StructuredResult<T>> => {
    const res = await anthropicComplete({
      role: params.role,
      tier: params.tier,
      system: params.system,
      messages: params.messages,
      maxTokens: params.maxTokens,
      temperature: params.temperature,
      tools: [
        {
          name: params.schemaName,
          description: params.schemaDescription,
          input_schema: { type: 'object', ...params.schema },
        },
      ],
      toolChoice: { type: 'tool', name: params.schemaName },
    })

    if (res.error) return { value: null, model: res.model, usage: res.usage, error: res.error }

    const call = res.toolUses.find((t) => t.name === params.schemaName)
    if (!call) {
      return {
        value: null,
        model: res.model,
        usage: res.usage,
        error: `model returned no ${params.schemaName} tool call (stop_reason=${res.stopReason})`,
      }
    }

    const value = params.validate(call.input)
    if (value === null) {
      return { value: null, model: res.model, usage: res.usage, error: 'output failed schema validation' }
    }

    return { value, model: res.model, usage: res.usage }
  }

  if (!params.cacheKeyParts) return run()

  const key = cacheKey(params.cacheNamespace ?? params.schemaName, {
    ...params.cacheKeyParts,
    model: params.tier ? modelForTier(params.tier) : anthropicModelFor(params.role),
  })

  let wasCached = true
  const result = await cached<StructuredResult<T>>(
    key,
    async () => {
      wasCached = false
      return run()
    },
    false,
    // ADR-015: cache successes only. A cached failure is a permanent failure.
    (v) => v.value !== null && !v.error
  )

  if (wasCached) usage.cachedCalls++
  return result
}
