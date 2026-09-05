// The harness kernel.ts and kernel-edges.ts share: a fake executor of either
// kind wired into runWorkerLeg with the in-memory RunStoreDb, a recording
// dispatch stub, and the row helpers the assertions read.
//
// Not a suite. It sets no env and asserts nothing.

import { runWorkerLeg, type LegExecutor, type LegInput, type LegOutcome, type WorkerDeps, type WorkerResponse } from '../../lib/runs/worker'
import { enqueueScoutRun, type DurableScoutKind } from '../../lib/career/scout/run-store'
import type { DispatchSettled, WorkerBase } from '../../lib/career/scout/worker-target'
import { createFakeRunStoreDb, type FakeRunStoreDb, type Row } from './fake-db'

export const BUDGET_MS = 3_000

export const TARGET: WorkerBase = { baseUrl: 'http://fake.test', source: 'default', ignoredHeaderHost: null, headers: {}, problem: null, vercel: { onVercel: false, env: null, deploymentId: null } }

export type Dispatch = NonNullable<WorkerDeps['dispatch']>

export interface Harness {
  db: FakeRunStoreDb
  deps: WorkerDeps
  dispatches: { runId: string; token: string }[]
  executions: LegInput[]
}

export type Leg = Promise<WorkerResponse>

export function harness(kind: DurableScoutKind, execute: (input: LegInput, h: Harness) => Promise<LegOutcome>, opts: { dispatch?: (h: Harness) => Dispatch; now?: () => number; budgetMs?: number } = {}): Harness {
  const db = createFakeRunStoreDb()
  const h: Harness = { db, deps: { db, executors: {}, target: TARGET, budgetMs: opts.budgetMs ?? BUDGET_MS, now: opts.now }, dispatches: [], executions: [] }
  const executor: LegExecutor = {
    kind,
    async execute(input) {
      h.executions.push(input)
      return execute(input, h)
    },
  }
  h.deps.executors = { [kind]: executor }
  h.deps.dispatch =
    opts.dispatch?.(h) ??
    (async (_t, runId, token) => {
      h.dispatches.push({ runId, token })
      return { dispatched: true, outcome: 'pending', status: null, error: null, latencyMs: 0 }
    })
  return h
}

/** What a dispatch stub answers when the worker is "still starting". */
export const pending: DispatchSettled & { dispatched: boolean } = { dispatched: true, outcome: 'pending', status: null, error: null, latencyMs: 0 }

export async function enqueue(h: Harness, kind: DurableScoutKind, over: { runDeadlineMs?: number; user?: string } = {}) {
  const q = await enqueueScoutRun(over.user ?? 'u1', { kind, params: { goal: 'g' }, label: `${kind} test`, runDeadlineMs: over.runDeadlineMs }, h.db)
  if (!q.runId || !q.claimToken) throw new Error(`enqueue failed: ${q.error}`)
  return { runId: q.runId, token: q.claimToken }
}

export const events = (row: Row) => ((row.progress as { events?: { stage: string; detail: string }[] })?.events ?? [])

/** Start a leg without awaiting it. */
export const startLeg = (h: Harness, runId: string, token: string): Leg => runWorkerLeg({ runId, token }, Date.now(), h.deps)
