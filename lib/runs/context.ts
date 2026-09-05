// The run a piece of code is executing on behalf of, carried implicitly.
//
// A provider client sits ten frames below the orchestrator and cannot be handed
// the run's clock by hand at every call site — and the clock used to live in a
// module-level slot instead, which two concurrent runs in one process (Vercel's
// Fluid compute puts many requests on one instance; a package build runs beside
// a scout) overwrote for each other. Five consecutive scout runs once failed
// instantly because a run that died left its expired deadline in that slot.
//
// AsyncLocalStorage fixes this structurally: the context follows the promise
// chain of ONE invocation, through every await and into a `waitUntil`
// continuation, and is invisible to every other request. Nothing to clear,
// nothing to leak.
//
// What travels with the run:
//   - the clock (lib/runs/deadline.ts)
//   - identity for the logs (run id, kind, invocation number)
//   - per-run provider accounting, so usage and spend are the run's own
//   - a cancellation flag the worker sets when the row says so
//
// Node runtime only. Every route that imports a provider client already is.

import { AsyncLocalStorage } from 'node:async_hooks'
import { RunClock } from './deadline'
import type { ScoutKind } from './log'

export interface ProviderUsageSlots {
  /** Opaque per-run accounting owned by each provider client. Keyed by provider id. */
  [provider: string]: unknown
}

export interface RunContext {
  runId: string | null
  kind: ScoutKind
  invocation: number
  clock: RunClock
  /** Per-run provider usage objects, created lazily by each client. */
  usage: ProviderUsageSlots
  /** Set by the worker when the row asks the run to stop. Read between expensive steps. */
  cancelRequested: boolean
  /** A short label for logs — the run's label, or the CLI's name. */
  label?: string | null
}

const storage = new AsyncLocalStorage<RunContext>()

export interface RunContextInput {
  runId?: string | null
  kind?: ScoutKind
  invocation?: number
  clock: RunClock
  label?: string | null
}

export function createRunContext(input: RunContextInput): RunContext {
  return {
    runId: input.runId ?? null,
    kind: input.kind ?? 'unknown',
    invocation: input.invocation ?? 1,
    clock: input.clock,
    usage: {},
    cancelRequested: false,
    label: input.label ?? null,
  }
}

/** Run `fn` with `ctx` as the ambient run for everything it awaits. */
export function withRunContext<T>(ctx: RunContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn)
}

/** Convenience: a fresh context for a budget, run, and gone. */
export function withRunBudget<T>(input: Omit<RunContextInput, 'clock'> & { budgetMs: number; now?: () => number }, fn: (ctx: RunContext) => Promise<T>): Promise<T> {
  const ctx = createRunContext({ ...input, clock: RunClock.forBudget(input.budgetMs, { now: input.now }) })
  return storage.run(ctx, () => fn(ctx))
}

/** The ambient run, or null when code is running outside any run (a CLI helper, a test). */
export function currentRunContext(): RunContext | null {
  return storage.getStore() ?? null
}

/** The ambient clock, or null. Provider clients size their attempts from this. */
export function currentRunClock(): RunClock | null {
  return storage.getStore()?.clock ?? null
}

/**
 * How long ONE network request may take right now: its own ceiling, or what
 * the ambient run has left before its finalisation reserve — whichever is
 * smaller. Zero means "do not start". Outside a run the ceiling stands.
 *
 * Every fetch in the product sizes itself from this, so a chain of probes that
 * begins near a run's deadline collapses into immediate refusals instead of a
 * sequence of fifteen-second waits that outlives the function.
 */
export function ambientTimeoutMs(ceilingMs: number, minMs = 1_500): number {
  const clock = storage.getStore()?.clock
  return clock ? clock.attemptTimeoutMs(ceilingMs, minMs) : ceilingMs
}

/** A per-run slot for a provider's accounting, created on first use. Null outside a run. */
export function runUsageSlot<T>(provider: string, create: () => T): T | null {
  const ctx = storage.getStore()
  if (!ctx) return null
  if (!(provider in ctx.usage)) ctx.usage[provider] = create()
  return ctx.usage[provider] as T
}

/** True when the worker has been asked to stop this run. */
export function runCancelRequested(): boolean {
  return storage.getStore()?.cancelRequested === true
}

export function requestRunCancel(): void {
  const ctx = storage.getStore()
  if (ctx) ctx.cancelRequested = true
}
