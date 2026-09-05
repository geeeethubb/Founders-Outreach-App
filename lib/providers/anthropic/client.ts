// Anthropic Messages client: auth, retry, rate limiting, budget, usage/cost
// accounting, and forced-tool structured output.
//
// Credentials come ONLY from ANTHROPIC_API_KEY and never leave the server.
// Callers request a model ROLE (see lib/ai/models.ts), never a model id.
//
// This is the low-level transport. Business logic depends on the interfaces in
// lib/providers/model.ts, not on this file directly — so swapping vendors is a
// provider change, not a rewrite. See docs/ARCHITECTURE.md ADR-016.
//
// EVERY ATTEMPT IS SIZED FROM THE RUN'S CLOCK. A request's timeout is the
// provider ceiling (120s, or 300s when the model runs web searches) or what is
// left of the run before its finalisation reserve — whichever is smaller. An
// attempt that would not get MIN_ATTEMPT_MS is not started; a backoff sleep
// that would eat the next attempt is refused. So a child request can never
// outlive the run that made it, and a retry storm can never outlive a deadline.
// The clock arrives through the run context (lib/runs/context.ts): nothing
// here is a module-global slot that two runs could overwrite for each other.

import Anthropic from '@anthropic-ai/sdk'
import {
  anthropicModelFor,
  estimateAnthropicCost,
  modelForTier,
  type ModelRole,
  type ModelTier,
} from '@/lib/ai/models'
import { cached, cacheKey } from '../cache'
import { createRunContext, currentRunClock, currentRunContext, runUsageSlot, withRunContext } from '@/lib/runs/context'
import { RunClock, sleepWithin } from '@/lib/runs/deadline'
import { classifyError, type ScoutErrorCode } from '@/lib/runs/errors'
import { scoutLog } from '@/lib/runs/log'

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

/**
 * Usage is PER RUN when a run context is active, and process-wide otherwise.
 *
 * The process-wide object is what a CLI or an eval reads after `resetAnthropicUsage()`.
 * Inside a worker the run's own slot is used, so two runs on one warm instance
 * cannot add each other's calls to their own totals — or, worse, exhaust a
 * call budget that a dozen earlier requests on the same instance had been
 * quietly filling.
 */
let processUsage = emptyUsage()

function currentUsage(): AnthropicUsage {
  return runUsageSlot<AnthropicUsage>('anthropic', emptyUsage) ?? processUsage
}

export function anthropicUsage(): AnthropicUsage {
  const u = currentUsage()
  return { ...u, byRole: { ...u.byRole }, byTier: { ...u.byTier }, escalations: [...u.escalations] }
}

export function resetAnthropicUsage(): void {
  const slot = runUsageSlot<AnthropicUsage>('anthropic', emptyUsage)
  if (slot) {
    // Zero in place, so an in-flight call keeps writing to a live object.
    Object.assign(slot, emptyUsage())
    return
  }
  processUsage = emptyUsage()
}

/**
 * Records a tier escalation. Escalation that nobody can see becomes the default
 * within a month, so every one is logged with its reason.
 */
export function recordEscalation(agent: string, from: string, to: string, reason: string): void {
  currentUsage().escalations.push({ agent, from, to, reason })
}

/** Recorded by the web-research provider, which is billed per search. */
export function recordWebSearches(n: number, costUsd: number): void {
  const u = currentUsage()
  u.webSearches += n
  u.costUsd += costUsd
}

// ─── Run budget ──────────────────────────────────────────────────────────────
// A hard ceiling so an agent loop can never bill without bound. Mirrors the
// Apollo and web-search budgets. The COUNTER is per run (see currentUsage); the
// ceiling is per process.

let callBudget = Number(process.env.ANTHROPIC_MAX_CALLS_PER_RUN ?? 500)

export function setAnthropicBudget(n: number): void {
  callBudget = n
}

export class AnthropicBudgetExceeded extends Error {
  constructor(limit: number) {
    super(`Anthropic call budget exceeded (${limit} live calls). Raise ANTHROPIC_MAX_CALLS_PER_RUN.`)
    this.name = 'AnthropicBudgetExceeded'
  }
}

// ─── Run deadline ────────────────────────────────────────────────────────────
//
// There is no deadline slot in this module any more. The clock a call sizes
// itself from is the ambient run's (lib/runs/context.ts), carried by
// AsyncLocalStorage through every await of one invocation and invisible to
// every other. A module slot cost five consecutive scout runs once (a leaked,
// expired deadline poisoned every later run in the process) and would let two
// concurrent runs on one instance disarm each other; a context cannot leak,
// because it ends with the promise chain it belongs to.

/**
 * Arm a deadline for the duration of `fn`.
 *
 * Package generation's entry point. If a run context already exists (the
 * package is being built inside a scout worker), the earlier of the two
 * deadlines wins and the outer run's identity and usage slots are kept, so the
 * inner work is still accounted to the run that paid for it.
 */
export async function withAnthropicDeadline<T>(epochMs: number, fn: () => Promise<T>): Promise<T> {
  const outer = currentRunContext()
  const hardDeadlineAt = outer ? Math.min(outer.clock.hardDeadlineAt, epochMs) : epochMs
  // The caller's deadline is already a WORK deadline (package/deadline.ts keeps
  // its own finalisation reserve), so this clock reserves nothing of its own.
  const clock = new RunClock({ hardDeadlineAt, finalizeReserveMs: 0 })
  const ctx = outer
    ? { ...outer, clock }
    : createRunContext({ clock, kind: 'package', label: 'anthropic-deadline' })
  return withRunContext(ctx, fn)
}

/** Test seam. True when the ambient run has no time left for another attempt. */
export function __pastRunDeadlineForTests(): boolean {
  const clock = currentRunClock()
  return clock ? clock.attemptTimeoutMs(DEFAULT_REQUEST_TIMEOUT_MS) === 0 : false
}

// ─── Client ──────────────────────────────────────────────────────────────────
// Lazily constructed. A module-level `new Anthropic()` would make every pure
// function in this tree unimportable without a key — a trap V1 already hit.

let client: Anthropic | null = null

export function anthropicAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY)
}

/**
 * How long ONE request may take, at most.
 *
 * 120s is right for an ordinary completion and far too short for one that uses
 * server-side web search: the connection is held open while Anthropic runs the
 * searches, so the wall clock covers the model AND every search it decides to
 * make. The mission planner (webSearch, maxSteps 6) exceeded 120s on every one
 * of four attempts, in five consecutive live scout runs and again from the CLI
 * with no queue involved — so every run fell back to deterministic strategies
 * and discovered nothing. At 300s the same planner returns 8 strategies and 31
 * seeds, and the run persists postings. It was slow, not hung.
 *
 * These are CEILINGS. The actual timeout of an attempt is the smaller of the
 * ceiling and what the run has left (see `attemptTimeoutMs`).
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = Number(process.env.ANTHROPIC_TIMEOUT_MS ?? 120_000)
export const SEARCH_REQUEST_TIMEOUT_MS = Number(process.env.ANTHROPIC_SEARCH_TIMEOUT_MS ?? 300_000)

/** Does this request hand work to Anthropic's own search tool? */
export function usesWebSearch(tools: unknown): boolean {
  return Array.isArray(tools) && tools.some((t) => typeof (t as { type?: unknown })?.type === 'string' && /web_search/.test(String((t as { type: string }).type)))
}

/**
 * The timeout THIS attempt gets: the provider ceiling, or what the run has
 * left before its finalisation reserve — whichever is smaller. Zero means "do
 * not start": there is not enough time for the attempt to be worth the money.
 * Outside a run (a CLI helper, a test) the ceiling stands.
 */
export function attemptTimeoutMs(ceilingMs: number, clock: RunClock | null = currentRunClock()): number {
  return clock ? clock.attemptTimeoutMs(ceilingMs) : ceilingMs
}

function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')
  if (!client) {
    client = new Anthropic({
      apiKey,
      // Retries are handled here so they are visible in our own accounting.
      maxRetries: 0,
      timeout: DEFAULT_REQUEST_TIMEOUT_MS,
    })
  }
  return client
}

/** Test seam: replace the SDK client (a fake `messages.create`). */
export function __setAnthropicClientForTests(fake: Anthropic | null): void {
  client = fake
}

/** Retryable: transient conditions only. 4xx other than 408/409/429 will never succeed. */
export function isRetryableStatus(status: number | undefined): boolean {
  return status === 429 || status === 408 || status === 409 || status === 529 || (status !== undefined && status >= 500)
}

const MAX_ATTEMPTS = 4

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
  /** For the log line: which stage of the run is asking. */
  stage?: string
}

export interface CompleteResult {
  text: string
  model: string
  stopReason: string | null
  toolUses: { id: string; name: string; input: unknown }[]
  content: Anthropic.ContentBlock[]
  usage: { inputTokens: number; outputTokens: number; costUsd: number }
  error?: string
  /** Stable classification of `error`, for the run row and the UI. */
  errorCode?: ScoutErrorCode
  /** How many attempts this call made, successful or not. */
  attempts?: number
}

function errorStatus(e: unknown): number | undefined {
  const s = (e as { status?: unknown }).status
  return typeof s === 'number' ? s : undefined
}

function isTimeoutError(e: unknown): boolean {
  const name = (e as { name?: unknown }).name
  const message = e instanceof Error ? e.message : String(e)
  return name === 'APIConnectionTimeoutError' || name === 'AbortError' || /timed? ?out|timeout/i.test(message)
}

/**
 * One Messages call. Retries transient failures, records usage, and never
 * throws for an expected API condition — errors come back on the result so a
 * single failed agent step degrades the run instead of halting it.
 *
 * The budget it obeys is the RUN's: `remaining_ms` in every log line is the
 * run's remaining work time, and the request timeout is derived from it.
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
  const usage = currentUsage()

  if (!anthropicAvailable()) return { ...empty, error: 'ANTHROPIC_API_KEY is not set', errorCode: 'CONFIGURATION', attempts: 0 }
  if (usage.calls >= callBudget) throw new AnthropicBudgetExceeded(callBudget)

  const tierKey = params.tier ?? 'role:' + params.role
  usage.calls++
  usage.byRole[params.role] = (usage.byRole[params.role] ?? 0) + 1
  const tierBucket = (usage.byTier[tierKey] ??= { calls: 0, costUsd: 0 })
  tierBucket.calls++

  const search = usesWebSearch(params.tools)
  const ceiling = search ? SEARCH_REQUEST_TIMEOUT_MS : DEFAULT_REQUEST_TIMEOUT_MS
  const operation = search ? 'messages.create+web_search' : 'messages.create'
  const fail = (code: ScoutErrorCode, message: string, attempts: number): CompleteResult => {
    usage.errors++
    scoutLog({ event: 'provider_failed', provider: 'anthropic', operation, stage: params.stage ?? null, attempt: attempts, error_code: code, error: message.slice(0, 200) }, 'warn')
    return { ...empty, error: message, errorCode: code, attempts }
  }

  let lastError = ''
  let lastCode: ScoutErrorCode = 'PROVIDER_ERROR'

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const clock = currentRunClock()
    if (attempt > 1) {
      usage.retries++
      const base = Math.min(16_000, 700 * Math.pow(2, attempt - 1))
      const want = Math.round(base * (0.5 + Math.random() * 0.5))
      // A sleep that would leave no room for the next attempt is refused: the
      // run is better off finalising with what it has than sleeping into the
      // reserve and being killed mid-request.
      const slept = await sleepWithin(clock, want)
      if (!slept) {
        return fail('RUN_DEADLINE', `Anthropic: run deadline passed before retry ${attempt} — ${lastError.slice(0, 200)}`, attempt - 1)
      }
    }

    // Sized from the run's clock, on EVERY attempt including the first.
    const timeout = attemptTimeoutMs(ceiling, clock)
    if (timeout === 0) {
      return fail(
        'RUN_DEADLINE',
        `Anthropic: not started — ${Math.round((clock?.remainingForWorkMs() ?? 0) / 1000)}s left in the run is not enough for a ${operation} attempt` +
          (lastError ? ` (previous: ${lastError.slice(0, 160)})` : ''),
        attempt - 1
      )
    }

    const startedAt = Date.now()
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
        {
          timeout,
          ...(params.extraHeaders ? { headers: params.extraHeaders } : {}),
        }
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

      scoutLog({
        event: 'provider_ok',
        provider: 'anthropic',
        operation,
        stage: params.stage ?? null,
        attempt,
        status: res.stop_reason ?? 'ok',
        latency_ms: Date.now() - startedAt,
        cost_usd: cost,
        timeout_ms: timeout,
      })

      return {
        text,
        model,
        stopReason: res.stop_reason ?? null,
        toolUses,
        content: res.content,
        usage: { inputTokens: inTok, outputTokens: outTok, costUsd: cost },
        attempts: attempt,
      }
    } catch (e) {
      const status = errorStatus(e)
      const timedOut = isTimeoutError(e)
      lastError = e instanceof Error ? e.message : String(e)
      lastCode = timedOut ? 'PROVIDER_TIMEOUT' : status === 429 || status === 529 ? 'PROVIDER_RATE_LIMIT' : status !== undefined ? (status >= 500 ? 'PROVIDER_ERROR' : classifyError(e, 'PROVIDER_ERROR')) : 'PROVIDER_TIMEOUT'
      const retryable = timedOut || status === undefined || isRetryableStatus(status)
      scoutLog(
        {
          event: retryable && attempt < MAX_ATTEMPTS ? 'provider_retry' : 'provider_error',
          provider: 'anthropic',
          operation,
          stage: params.stage ?? null,
          attempt,
          http_status: status ?? null,
          latency_ms: Date.now() - startedAt,
          timeout_ms: timeout,
          error_code: lastCode,
          error: lastError.slice(0, 200),
        },
        'warn'
      )
      if (!retryable) {
        return fail(lastCode, `Anthropic ${status}: ${lastError.slice(0, 240)}`, attempt)
      }
      // A timeout that consumed the run's remaining window is a deadline, not
      // a provider fault — say so, and do not sleep into the reserve.
      if (timedOut && clock && clock.inReserve()) {
        return fail('RUN_DEADLINE', `Anthropic: the request ran out the run's clock (${Math.round(timeout / 1000)}s attempt) — ${lastError.slice(0, 160)}`, attempt)
      }
    }
  }

  return fail(lastCode, `Anthropic: exhausted retries — ${lastError.slice(0, 240)}`, MAX_ATTEMPTS)
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
  errorCode?: ScoutErrorCode
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
  const MAX_VALIDATION_ATTEMPTS = 3

  const run = async (): Promise<StructuredResult<T>> => {
    let last: StructuredResult<T> | null = null
    for (let attempt = 0; attempt < MAX_VALIDATION_ATTEMPTS; attempt++) {
      // Nothing starts inside the run's reserve — including the FIRST attempt.
      const clock = currentRunClock()
      if (clock && clock.attemptTimeoutMs(DEFAULT_REQUEST_TIMEOUT_MS) === 0) {
        return last ?? { value: null, model: params.tier ? modelForTier(params.tier) : anthropicModelFor(params.role), usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, error: 'run deadline: no time left for a structured call', errorCode: 'RUN_DEADLINE' }
      }
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
      stage: params.stage,
      tools: [
        {
          name: params.schemaName,
          description: params.schemaDescription,
          input_schema: { type: 'object', ...params.schema },
        },
      ],
      toolChoice: { type: 'tool', name: params.schemaName },
    })

    if (res.error) return { value: null, model: res.model, usage: res.usage, error: res.error, errorCode: res.errorCode }

    const call = res.toolUses.find((t) => t.name === params.schemaName)
    if (!call) {
      return {
        value: null,
        model: res.model,
        usage: res.usage,
        error: `model returned no ${params.schemaName} tool call (stop_reason=${res.stopReason})`,
        errorCode: 'PROVIDER_INVALID_RESPONSE',
      }
    }

    const value = params.validate(call.input)
    if (value === null) {
      return { value: null, model: res.model, usage: res.usage, error: 'output failed schema validation', errorCode: 'PROVIDER_INVALID_RESPONSE' }
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

  if (wasCached) currentUsage().cachedCalls++
  return result
}
