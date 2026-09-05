// Agent runtime contracts.
//
// An agent here is still a pure function of its input in the sense that matters:
// it does not read or write the database and does not call another agent. What
// it CAN do is call tools — web search and provider lookups — because gathering
// evidence is the job. The orchestrator loads inputs and persists outputs.
//
// See docs/AGENTS.md and docs/ARCHITECTURE.md ADR-016.

import type { ModelRole } from '@/lib/ai/models'
import type { ScoutErrorCode } from '@/lib/runs/errors'

/** A client-side tool the agent may call. Executed by us, not by the model. */
export interface AgentTool<TArgs = Record<string, unknown>> {
  name: string
  description: string
  /** JSON Schema for the tool's arguments. */
  input_schema: Record<string, unknown>
  execute(args: TArgs, ctx: ToolContext): Promise<ToolOutcome>
}

export interface ToolOutcome {
  ok: boolean
  /** Serialized back to the model. Keep it small — this re-enters the prompt. */
  result: unknown
  /** One line for the trace. Never the full payload. */
  summary: string
}

export interface ToolContext {
  user_id: string
  run_id: string | null
  /** Per-run caps the tools must respect. */
  budget: RunBudget
}

export interface RunBudget {
  maxCompanies: number
  maxPeoplePerCompany: number
  maxApolloCalls: number
  maxWebSearches: number
  maxAgentSteps: number
}

/**
 * A source URL the model actually cited, harvested from citation objects on its
 * own text blocks. This is the evidence pool: a FACT the agent submits must
 * cite a URL that appears here, or it is downgraded. Prose that merely *looks*
 * like a URL never lands in this list.
 */
export interface EvidenceSource {
  url: string
  title: string | null
  snippet: string | null
}

export interface ToolCallTrace {
  tool: string
  args: Record<string, unknown>
  result_summary?: string
  error?: string
}

export interface AgentTrace {
  agent_id: string
  prompt_version: string
  model: string
  model_role: ModelRole
  provider_id: string
  tools_called: ToolCallTrace[]
  web_searches: number
  tokens_in: number
  tokens_out: number
  cost_usd: number
  latency_ms: number
  steps: number
  /** Replayed from disk. Its cost was paid by an earlier run, so it reads zero. */
  from_cache?: boolean
}

export interface AgentResult<TOutput> {
  output: TOutput | null
  status: 'succeeded' | 'failed' | 'invalid_output'
  error: string | null
  /**
   * Why it failed, when the cause was the RUN rather than the model: the
   * clock (RUN_DEADLINE), a cancel (CANCELLED), or the provider. A caller that
   * treats a failure as "this item is broken" must not do so for these — the
   * item was never really attempted and belongs to the next leg.
   */
  errorCode?: ScoutErrorCode | null
  /** Every URL the model cited during the run, in first-seen order. */
  evidence: EvidenceSource[]
  trace: AgentTrace
}

/** A versioned prompt. Bump `version` on ANY semantic change (ADR-009). */
export interface VersionedPrompt<TInput> {
  readonly version: string
  build(input: TInput): { system: string; user: string }
}
