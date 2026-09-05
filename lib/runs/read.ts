// Reading a durable run as its owner — the poll.
//
// This is the only thing a scout page polls while a run is going. It is
// deliberately more than a SELECT, because a poll is the moment we know a
// human is watching and it is the cheapest place to self-heal:
//
//   - a running run whose lease lapsed is REAPED (a real write), so the page
//     stops showing a run that will never move again;
//   - a queued run that nothing has dispatched — a lost first dispatch, or a
//     leg handed back to the queue by a worker that then died — is
//     DISPATCHED from here. The 3-second poll is the primary chain link; the
//     self-dispatch from a finishing leg is the optimisation.
//
// The claim token is never in the response.

import { sweepScoutQueue, type QueueAction } from '@/lib/career/scout/queue-watchdog'
import { getRunJobCounts, getScoutRun, toRunView, type ScoutRunView } from '@/lib/career/scout/run-store'
import { resolveWorkerBase, type WorkerBase } from '@/lib/career/scout/worker-target'
import { scoutError, type ScoutError } from './errors'

type HeaderBag = { get(name: string): string | null }

export interface ReadRunOptions {
  headers?: HeaderBag | null
  /** Include the heavy `result` column (People Scout). */
  withResult?: boolean
  target?: WorkerBase
}

export type ReadRunOutcome =
  | { kind: 'ok'; run: ScoutRunView; actions: QueueAction[] }
  | { kind: 'error'; error: ScoutError }

export async function readScoutRun(userId: string, runId: string, opts: ReadRunOptions = {}): Promise<ReadRunOutcome> {
  const target = opts.target ?? resolveWorkerBase(opts.headers ?? null)
  // Sweep first (reap + queue), so the row we read back is already the truth.
  const swept = await sweepScoutQueue(userId, { target })
  if (swept.migrationMissing) {
    return { kind: 'error', error: scoutError('SCHEMA_MIGRATION', 'The database predates the durable-run migrations.', { remedy: 'Apply supabase/migrations/016, 020 and 021 in the Supabase SQL editor.' }) }
  }
  const { run, migrationMissing, error } = await getScoutRun(userId, runId, undefined, { full: opts.withResult === true })
  if (migrationMissing) return { kind: 'error', error: scoutError('SCHEMA_MIGRATION', 'The database predates the durable-run migrations.', { remedy: 'Apply supabase/migrations/016, 020 and 021 in the Supabase SQL editor.' }) }
  if (error) return { kind: 'error', error: scoutError('DATABASE', error) }
  if (!run) return { kind: 'error', error: scoutError('NOT_FOUND', 'Run not found', { retryable: false }) }
  const counts = (run.kind ?? 'job_scout') === 'job_scout' ? await getRunJobCounts(userId, run.id) : undefined
  const view = toRunView(run, counts)
  if (!opts.withResult) view.result = null
  return { kind: 'ok', run: view, actions: swept.actions.filter((a) => a.runId === run.id) }
}
