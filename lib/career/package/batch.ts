// Several jobs → several ready-to-apply packages, a few at a time.
//
// `generateCompletePackage` turned five clicks into one. The founder's actual
// morning is not one job, though: it is the six jobs a scout run surfaced
// overnight. Doing them one at a time means sitting through six sequential
// runs of research → tailoring → verification → documents, most of which is
// waiting on someone else's API.
//
// So: a small pool, and every job independent.
//
//   ONE JOB FAILING MUST NOT STOP THE OTHERS.  A batch that aborts halfway
//   leaves the founder with three packages, no idea which three, and a bill for
//   the work that was thrown away. Every job is wrapped: a throw becomes that
//   item's `failed` state with its message, and the pool keeps going.
//
// Nothing here decides anything. `generateCompletePackage` still owns every
// gate, `assessPackage` still owns ready-vs-attention, and this module owns
// scheduling and counting — which is exactly the deterministic/agentic split.
//
// And to say it once, plainly: THIS PRODUCES DOCUMENTS. It never submits an
// application anywhere. There is no code path from a batch to an employer.

import { mapWithConcurrency } from '@/lib/scouting/concurrency'
import type { AttentionItem, AutoOutcome } from './auto'

/**
 * How many packages may be in flight.
 *
 * Two, not eight. A package is a chain of paid model calls — research,
 * fit, evidence matching, tailoring, per-bullet fact verification, the letter
 * and its grounding retry — that measured ~$0.50 and several minutes on the
 * live run in the build log. Two in flight roughly halves the wall clock, which
 * is where most of the win is, while keeping the amount of money in the air
 * bounded when the founder watches a batch go wrong and hits Ctrl-C.
 *
 * It is also honest about the machine: when `renderPdf` is on, every document
 * render funnels through one serialized Word COM queue (documents/pdf.ts), so
 * more concurrency buys queue depth, not speed.
 */
export const DEFAULT_BATCH_CONCURRENCY = 2

/**
 * The hard cap on one batch.
 *
 * At ~$0.50 a package this is about $12 of exposure from a single click — an
 * amount a person can absorb having learned something. Without a cap, "select
 * all" on a scout run that returned 300 jobs is a several-hundred-dollar
 * mis-click with no confirmation step in front of it, and no way to take it
 * back once the calls are out. 25 is also more applications than anyone
 * submits in a day, so the cap costs a real user nothing.
 */
export const MAX_BATCH_JOBS = 25

export type BatchItemState = 'queued' | 'generating' | 'ready' | 'needs_attention' | 'failed'

export interface BatchItem {
  jobId: string
  state: BatchItemState
  /** Set as soon as generation produced a package row, even on `needs_attention`. */
  packageId: string | null
  outcome: AutoOutcome | null
  attention: AttentionItem[]
  costUsd: number
  elapsedMs: number
  /** Only for `failed`: the thrown message. An attention item is not an error. */
  error: string | null
}

/** The counts a progress UI renders: "5 jobs · 2 ready · 2 generating · 1 queued". */
export interface BatchSnapshot {
  total: number
  queued: number
  generating: number
  ready: number
  needsAttention: number
  failed: number
  costUsd: number
}

/**
 * The one place a batch is counted.
 *
 * Pure and exported so the CLI, the UI and the tests cannot each invent their
 * own arithmetic and disagree about whether a batch is finished — the classic
 * way a progress bar ends up at 4/5 forever.
 */
export function summarizeBatch(items: readonly BatchItem[]): BatchSnapshot {
  const count = (state: BatchItemState): number => items.filter((i) => i.state === state).length
  return {
    total: items.length,
    queued: count('queued'),
    generating: count('generating'),
    ready: count('ready'),
    needsAttention: count('needs_attention'),
    failed: count('failed'),
    costUsd: Number(items.reduce((sum, i) => sum + i.costUsd, 0).toFixed(4)),
  }
}

export interface BatchResult {
  items: BatchItem[]
  snapshot: BatchSnapshot
  /** Packages allowed in flight, after clamping whatever the caller asked for. */
  concurrency: number
  /** Repeat ids collapsed before any work started. */
  duplicatesDropped: number
  elapsedMs: number
}

export interface PackageBatchParams {
  userId: string
  jobIds: string[]
  concurrency?: number
  /** Off by default, exactly as the single-package path: DOCX is the deliverable. */
  renderPdf?: boolean
  /**
   * Fires on every state change, plus once before any work so a UI can paint
   * the queue before the first paid call.
   *
   * The items are passed alongside the snapshot because a progress line that
   * can name the job that just finished is worth far more than a counter, and
   * a one-argument `(s) => …` handler still satisfies this type. Each update
   * is a fresh copy: a React caller that held the live array would see one
   * object identity that never changes and never re-render.
   */
  onUpdate?: (snapshot: BatchSnapshot, items: readonly BatchItem[]) => void
  /** Test seam. Production passes nothing. */
  deps?: { generate?: typeof import('./auto').generateCompletePackage }
}

/**
 * Generate a package for each job, `concurrency` at a time, and report what
 * happened to every one of them.
 *
 * Throws only for a caller mistake it cannot proceed past — too many jobs.
 * Everything that goes wrong per job is reported, never thrown, because the
 * point of a batch is the packages that DID work.
 */
export async function runPackageBatch(params: PackageBatchParams): Promise<BatchResult> {
  const started = Date.now()

  // Dedupe first, then cap: a UI that sends the same id twice has made a
  // harmless mistake, and paying twice for one job is the bug — not the cap.
  const jobIds = uniqueIds(params.jobIds)
  const duplicatesDropped = params.jobIds.length - jobIds.length
  if (jobIds.length > MAX_BATCH_JOBS) {
    throw new Error(
      `${jobIds.length} jobs requested; a batch is capped at ${MAX_BATCH_JOBS}. ` +
        `Each package costs real money and cannot be undone once sent — run this in smaller batches.`
    )
  }

  const concurrency = boundedConcurrency(params.concurrency)
  const items: BatchItem[] = jobIds.map((jobId) => ({
    jobId,
    state: 'queued',
    packageId: null,
    outcome: null,
    attention: [],
    costUsd: 0,
    elapsedMs: 0,
    error: null,
  }))

  const emit = (): void => params.onUpdate?.(summarizeBatch(items), items.map((i) => ({ ...i })))
  emit()

  if (items.length) {
    // Imported here, not at the top, so an offline caller injecting `generate`
    // never pulls in the orchestrator's database layer.
    const generate = params.deps?.generate ?? (await import('./auto')).generateCompletePackage

    await mapWithConcurrency(jobIds, concurrency, async (jobId, index) => {
      const item = items[index]
      item.state = 'generating'
      emit()

      const itemStarted = Date.now()
      try {
        const result = await generate({ userId: params.userId, jobId, renderPdf: params.renderPdf })
        item.packageId = result.packageId
        item.outcome = result.outcome
        item.attention = result.attention
        item.costUsd = result.costUsd
        // The batch's own clock, so a `failed` item is timed the same way a
        // finished one is and the two columns mean the same thing.
        item.elapsedMs = Date.now() - itemStarted
        item.state = result.outcome === 'ready_to_apply' ? 'ready' : 'needs_attention'
      } catch (e) {
        item.state = 'failed'
        item.error = e instanceof Error ? e.message : String(e)
        item.elapsedMs = Date.now() - itemStarted
        // Cost stays 0: a throw gives back no accounting, and guessing at a
        // number would make the batch total quietly wrong.
      }
      emit()
    })
  }

  return {
    items,
    snapshot: summarizeBatch(items),
    concurrency,
    duplicatesDropped,
    elapsedMs: Date.now() - started,
  }
}

/** First-seen order, blanks dropped — the order the founder picked them in. */
function uniqueIds(jobIds: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of jobIds) {
    const id = (raw ?? '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/** A 0, a -1 or a NaN from a query string must not stall or unbound the pool. */
function boundedConcurrency(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_BATCH_CONCURRENCY
  return Math.max(1, Math.min(MAX_BATCH_JOBS, Math.floor(requested)))
}
