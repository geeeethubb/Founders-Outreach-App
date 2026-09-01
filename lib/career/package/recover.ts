// Finalising packages whose worker is gone.
//
// This is the piece that was missing when a Rondo Energy package sat at
// 'generating' for a day. The system had a reaper, but `run-reaper.ts` skips
// any run whose kind is not 'job_scout', and no reaper for the package row
// existed at all. So the only thing that could ever move a generating package
// was the process generating it — and that process was dead.
//
// Two design choices worth stating:
//
//   IT RUNS ON READ. Recovery is swept whenever the packages for a job are
//   loaded, not only from a cron. A cron that has not fired yet is exactly the
//   situation the founder was in, staring at a spinner. Reading the job page is
//   the moment they care, so that is the moment it gets fixed.
//
//   IT NEVER DELETES WORK. A stale 'resume_review' package has a résumé patch
//   that cost real money; it stopped one step short of its documents. It is
//   marked failed-but-resumable so `finishPackage` can still complete it, not
//   thrown away.

import { createServiceClient } from '@/lib/supabase/server'
import { isMissingSchema } from '../evidence/store'
import type { ApplicationPackage } from '../types'
import { NON_TERMINAL_STATUSES, packageLiveness, recoveryFor, staleMessage } from './liveness'

export interface RecoveredPackage {
  packageId: string
  jobId: string
  previousStatus: string
  stage: string | null
  message: string
  resumable: boolean
  elapsedMs: number
}

export interface RecoverResult {
  recovered: RecoveredPackage[]
  checked: number
  error: string | null
  migrationMissing: boolean
}

/** Bounded so a sweep on a page load can never become the slow thing on that page. */
const SWEEP_LIMIT = 25

/**
 * Finalise every stale non-terminal package for this user. Idempotent: a row
 * already terminal is skipped, and two concurrent sweeps converge on the same
 * state because the update is conditional on the status still being
 * non-terminal.
 *
 * `jobId` narrows the sweep to one job — the common case, called from the job
 * page — while omitting it sweeps the account, which is what the cron does.
 */
export async function recoverStalePackages(
  userId: string,
  opts: { jobId?: string; now?: number; db?: ReturnType<typeof createServiceClient> } = {}
): Promise<RecoverResult> {
  const db = opts.db ?? createServiceClient()
  const now = opts.now ?? Date.now()

  // Two shapes, because migration 019 is applied by hand: with the liveness
  // columns a package is judged on its own deadline; without them, on silence.
  // A sweep that refused to run on a pre-019 database would leave exactly the
  // rows that are stuck today stuck for ever.
  const sweep = async (select: string) => {
    let q = db
      .from('application_packages')
      .select(select)
      .eq('user_id', userId)
      .in('status', NON_TERMINAL_STATUSES as unknown as string[])
      .order('created_at', { ascending: false })
      .limit(SWEEP_LIMIT)
    if (opts.jobId) q = q.eq('job_id', opts.jobId)
    return q
  }

  let { data, error } = await sweep('id, job_id, run_id, status, stage, created_at, updated_at, generation_started_at, generation_deadline_at, last_heartbeat_at')
  if (error) ({ data, error } = await sweep('id, job_id, run_id, status, stage, created_at, updated_at'))
  if (error) return { recovered: [], checked: 0, error: error.message, migrationMissing: isMissingSchema(error.message) }

  const rows = (data ?? []) as unknown as ApplicationPackage[]
  const recovered: RecoveredPackage[] = []

  for (const row of rows) {
    const verdict = packageLiveness(row as never, now)
    if (verdict.state !== 'stale') continue
    const { resumable } = recoveryFor(row as never)
    const message = staleMessage(row as never, verdict)

    // Conditional on the status we read: if the real worker came back to life
    // between the select and here, its write wins and this one matches nothing.
    const { data: updated, error: wErr } = await db
      .from('application_packages')
      .update({
        status: 'failed',
        error: message,
        last_error: message,
        generation_finished_at: new Date(now).toISOString(),
      } as never)
      .eq('id', row.id)
      .in('status', NON_TERMINAL_STATUSES as unknown as string[])
      .select('id')

    if (wErr) {
      // A pre-019 database has no last_error / generation_finished_at. Recovery
      // is more important than the extra columns, so fall back to what has
      // existed since 014 — a package stuck for ever is the worse failure.
      const { error: fallbackErr } = await db
        .from('application_packages')
        .update({ status: 'failed', error: message } as never)
        .eq('id', row.id)
        .in('status', NON_TERMINAL_STATUSES as unknown as string[])
      if (fallbackErr) continue
    } else if (!updated || updated.length === 0) {
      continue // someone else finished it first
    }

    recovered.push({
      packageId: row.id,
      jobId: row.job_id,
      previousStatus: row.status,
      stage: row.stage ?? null,
      message,
      resumable,
      elapsedMs: verdict.elapsedMs,
    })

    // The run row that owns this package is dead too. Left 'running' it keeps
    // the Runs list lying and blocks nothing else from being judged stale.
    if ((row as unknown as { run_id?: string | null }).run_id) {
      await db
        .from('scouting_runs')
        .update({ status: 'failed', error: message, completed_at: new Date(now).toISOString() } as never)
        .eq('id', (row as unknown as { run_id: string }).run_id)
        .eq('status', 'running')
    }
  }

  return { recovered, checked: rows.length, error: null, migrationMissing: false }
}
