// Central model registry. See docs/ARCHITECTURE.md ADR-008.
//
// Callers request a ROLE, never a model ID, so changing models is one edit here
// rather than a hunt across the codebase. V1 hardcodes 'gpt-5.4' in 10 places;
// those migrate to this registry as each phase touches them.
//
// Two vendors are registered. OpenAI serves the legacy V1 code paths; Anthropic
// serves all agentic scouting and research from Phase 7 onward (ADR-016).

export type ModelRole = 'fast' | 'reasoning' | 'writing'
export type ModelVendor = 'openai' | 'anthropic'

const DEFAULTS: Record<ModelRole, string> = {
  fast: 'gpt-5.4',
  reasoning: 'gpt-5.4',
  writing: 'gpt-5.4',
}

const ENV_KEYS: Record<ModelRole, string> = {
  fast: 'OPENAI_MODEL_FAST',
  reasoning: 'OPENAI_MODEL_REASONING',
  writing: 'OPENAI_MODEL_WRITING',
}

/** Resolve a role to a concrete OpenAI model id, env-overridable. */
export function modelFor(role: ModelRole): string {
  return process.env[ENV_KEYS[role]] || DEFAULTS[role]
}

// ─── Anthropic ───────────────────────────────────────────────────────────────
// `fast` runs the high-volume cheap passes (triage, filtering). `reasoning`
// runs judgment: validation, research synthesis, ranking.

const ANTHROPIC_DEFAULTS: Record<ModelRole, string> = {
  fast: 'claude-haiku-4-5-20251001',
  reasoning: 'claude-sonnet-5',
  writing: 'claude-sonnet-5',
}

const ANTHROPIC_ENV_KEYS: Record<ModelRole, string> = {
  fast: 'ANTHROPIC_MODEL_FAST',
  reasoning: 'ANTHROPIC_MODEL_REASONING',
  writing: 'ANTHROPIC_MODEL_WRITING',
}

/** Resolve a role to a concrete Anthropic model id, env-overridable. */
export function anthropicModelFor(role: ModelRole): string {
  return process.env[ANTHROPIC_ENV_KEYS[role]] || ANTHROPIC_DEFAULTS[role]
}

/**
 * USD per 1M tokens, matched by model-id prefix. Approximate by design — this
 * exists to make runaway usage visible and to compute cost-per-good-prospect,
 * not to reconcile an invoice.
 */
const ANTHROPIC_PRICING: { prefix: string; in: number; out: number }[] = [
  { prefix: 'claude-opus', in: 15, out: 75 },
  { prefix: 'claude-sonnet', in: 3, out: 15 },
  { prefix: 'claude-haiku', in: 1, out: 5 },
]

export function estimateAnthropicCost(model: string, tokensIn: number, tokensOut: number): number {
  const row = ANTHROPIC_PRICING.find((p) => model.startsWith(p.prefix)) ?? ANTHROPIC_PRICING[1]
  return (tokensIn / 1_000_000) * row.in + (tokensOut / 1_000_000) * row.out
}

/** Anthropic charges web search per 1k searches, separately from tokens. */
export const ANTHROPIC_WEB_SEARCH_COST_PER_CALL = 10 / 1000

/**
 * Sampling defaults by role. Judgment work should be near-deterministic;
 * only writing benefits from variance.
 */
export function temperatureFor(role: ModelRole): number {
  switch (role) {
    case 'fast':
      return 0.1
    case 'reasoning':
      return 0.2
    case 'writing':
      return 0.8
  }
}

/**
 * Rough USD cost estimate for observability. Deliberately approximate — it
 * exists to catch runaway usage, not to reconcile a bill.
 */
export function estimateCost(tokensIn: number, tokensOut: number): number {
  const IN_PER_1K = 0.00125
  const OUT_PER_1K = 0.01
  return (tokensIn / 1000) * IN_PER_1K + (tokensOut / 1000) * OUT_PER_1K
}
