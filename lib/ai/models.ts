// Central model registry. See docs/ARCHITECTURE.md ADR-008.
//
// Callers request a ROLE, never a model ID, so changing models is one edit here
// rather than a hunt across the codebase. V1 hardcodes 'gpt-5.4' in 10 places;
// those migrate to this registry as each phase touches them.

export type ModelRole = 'fast' | 'reasoning' | 'writing'

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

/** Resolve a role to a concrete model id, env-overridable. */
export function modelFor(role: ModelRole): string {
  return process.env[ENV_KEYS[role]] || DEFAULTS[role]
}

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
