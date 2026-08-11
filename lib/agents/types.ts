// Agent contracts.
//
// An agent is a PURE FUNCTION of its input. It never reads or writes the
// database and never calls another agent — the orchestrator loads inputs and
// persists outputs. That property is what makes agents testable and keeps this
// a pipeline rather than a swarm. See docs/AGENTS.md.
//
// These are the product's RUNTIME agents (TypeScript modules), not Claude Code
// subagents. See docs/ARCHITECTURE.md §9.
//
// Scaffolding only — implementations land in Phases 4–8.

export type AgentId =
  | 'mission_strategist'
  | 'company_scout'
  | 'people_scout'
  | 'research'
  | 'ranking'
  | 'positioning'
  | 'outreach'

export const AGENT_IDS: AgentId[] = [
  'mission_strategist',
  'company_scout',
  'people_scout',
  'research',
  'ranking',
  'positioning',
  'outreach',
]

/**
 * Model selection is by ROLE, never by ID, so a model change is one edit in
 * lib/ai/models.ts rather than a hunt across the codebase.
 */
export type ModelRole = 'fast' | 'reasoning' | 'writing'

export const AGENT_MODEL_ROLES: Record<AgentId, ModelRole> = {
  mission_strategist: 'reasoning',
  company_scout: 'reasoning',
  people_scout: 'reasoning',
  research: 'reasoning',
  ranking: 'reasoning',
  positioning: 'reasoning',
  outreach: 'writing',
}

/**
 * A versioned prompt. `version` is bumped BY HAND on any semantic change and
 * recorded in `agent_runs.prompt_version` — it is what makes "why did it write
 * this?" answerable. See docs/ARCHITECTURE.md ADR-009.
 */
export interface VersionedPrompt<TInput> {
  readonly version: string
  build(input: TInput): { system: string; user: string }
}

/** Context the orchestrator supplies. Note the absence of a DB client. */
export interface AgentContext {
  user_id: string
  run_id: string | null
  task_id: string | null
  /** Row ids of the inputs — recorded in `agent_runs.input_refs`, not payloads. */
  input_refs: Record<string, string | string[]>
}

export interface AgentDefinition<TInput, TOutput> {
  readonly id: AgentId
  readonly modelRole: ModelRole
  readonly prompt: VersionedPrompt<TInput>
  /** Validates raw model output. Invalid output is a RETRYABLE failure —
   *  never something downstream code works around. */
  parse(raw: unknown): TOutput
}

export interface ToolCall {
  tool: string
  args: Record<string, unknown>
  result_summary?: string
  error?: string
}

export interface AgentResult<TOutput> {
  output: TOutput | null
  status: 'succeeded' | 'failed' | 'invalid_output'
  error: string | null
  /** Trace, persisted to `agent_runs`. See docs/ARCHITECTURE.md §5. */
  trace: {
    agent_id: AgentId
    prompt_version: string
    model: string
    model_role: ModelRole
    tools_called: ToolCall[]
    tokens_in: number | null
    tokens_out: number | null
    latency_ms: number
  }
}

// ─── Shared shapes ───────────────────────────────────────────────────────────

/**
 * The three-way typing that makes grounding enforceable. A `FACT` requires a
 * `source_url` — enforced by a database CHECK constraint, not by prompt
 * instruction. See docs/AGENTS.md §4 and docs/ARCHITECTURE.md ADR-006.
 *
 * `UNKNOWN` is a first-class output, not an absence: a thin dossier with no
 * UNKNOWN items is more likely fabricated than thorough.
 */
export type FactType = 'FACT' | 'INFERENCE' | 'UNKNOWN'

export interface ResearchFact {
  claim: string
  type: FactType
  source_url: string | null   // REQUIRED when type === 'FACT'
  source_title: string | null
  confidence: number
  relevance: string
}

export type CtaType =
  | 'conversation'
  | 'project_discussion'
  | 'advice'
  | 'referral'
  | 'introduction'
  | 'collaboration'
  | 'internship_discussion'

/**
 * Links a factual claim in a draft to the research fact supporting it.
 * A deterministic check resolves every `fact_id`, which turns hallucination
 * into a foreign-key problem. See docs/ARCHITECTURE.md ADR-011.
 */
export interface Citation {
  claim_text: string
  fact_id: string
}
