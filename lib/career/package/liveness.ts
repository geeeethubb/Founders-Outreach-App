// Is this generating package alive, or did its worker die?
//
// Pure, and shared by everyone who asks — the recovery sweep, the API, the
// screen. When the UI and the reaper answer this question with two different
// pieces of code they disagree, and the founder watches a spinner for a row the
// server already considers dead. That is the shape of the Rondo bug: not a
// wrong answer, but nobody asking.
//
// The rule is deliberately blunt. A generating package carries an absolute
// deadline; past it, plus a grace period, the row is stale — whatever it says
// about itself, whatever stage it claims to be in. There is no "but it might
// still be working": the deadline IS the promise, and a worker that has broken
// it has already failed the only guarantee that matters.

import { GENERATION_DEADLINE_MS } from './deadline'

/** Statuses from which a package can still move on its own. */
export const NON_TERMINAL_STATUSES = ['generating', 'resume_review'] as const

/**
 * How far past its deadline a package is given before being declared dead.
 *
 * Small on purpose. Unlike a scout run — which legitimately goes quiet for
 * minutes inside one long agent call — a generating package has a hard 5-minute
 * SLA, and the whole point is that nobody waits appreciably longer than that.
 */
export const DEADLINE_GRACE_MS = 30_000

/**
 * For rows written before migration 019, which carry no deadline at all: judge
 * them on how long they have been untouched. Generous, because `updated_at`
 * moves for reasons other than progress, and a false positive here would kill
 * a live run.
 */
export const LEGACY_STALE_MS = 15 * 60 * 1000

export interface PackageLivenessRow {
  status: string
  stage?: string | null
  generation_started_at?: string | null
  generation_deadline_at?: string | null
  last_heartbeat_at?: string | null
  updated_at?: string | null
  created_at?: string | null
}

export type LivenessVerdict =
  | { state: 'terminal' }
  | { state: 'alive'; elapsedMs: number; remainingMs: number }
  | { state: 'stale'; elapsedMs: number; overdueMs: number; reason: string }

function ms(v: string | null | undefined): number | null {
  if (!v) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

/**
 * The one verdict. `terminal` means nothing to do; `alive` means it is inside
 * its promise; `stale` means whoever is reading this may finalise it.
 */
export function packageLiveness(row: PackageLivenessRow, now = Date.now()): LivenessVerdict {
  if (!(NON_TERMINAL_STATUSES as readonly string[]).includes(row.status)) return { state: 'terminal' }

  const started = ms(row.generation_started_at) ?? ms(row.created_at)
  const deadline = ms(row.generation_deadline_at)
  const elapsedMs = started === null ? 0 : Math.max(0, now - started)

  if (deadline !== null) {
    const overdueMs = now - (deadline + DEADLINE_GRACE_MS)
    if (overdueMs > 0) {
      const beat = ms(row.last_heartbeat_at)
      const quiet = beat === null ? 'never sent a heartbeat' : `last heartbeat ${Math.round((now - beat) / 1000)}s ago`
      return {
        state: 'stale',
        elapsedMs,
        overdueMs,
        reason: `generation passed its ${Math.round(GENERATION_DEADLINE_MS / 1000)}s deadline ${Math.round(overdueMs / 1000)}s ago (${quiet})`,
      }
    }
    return { state: 'alive', elapsedMs, remainingMs: Math.max(0, deadline - now) }
  }

  // Pre-019 row: no deadline was ever recorded, so fall back to silence. This is
  // the branch that catches the packages already stuck in the database today.
  const touched = ms(row.updated_at) ?? started
  if (touched !== null && now - touched > LEGACY_STALE_MS) {
    return {
      state: 'stale',
      elapsedMs,
      overdueMs: now - touched - LEGACY_STALE_MS,
      reason: `no deadline was recorded and nothing has touched this package for ${Math.round((now - touched) / 60000)} minutes`,
    }
  }
  return { state: 'alive', elapsedMs, remainingMs: GENERATION_DEADLINE_MS }
}

/**
 * What a stale package becomes.
 *
 * `resume_review` is the interesting case: it has a résumé patch and cost real
 * money, so it is not a failure — it is work that stopped one step short of its
 * documents, and `finishPackage` can still complete it. Calling that 'failed'
 * would throw away something the founder paid for.
 */
export function recoveryFor(row: PackageLivenessRow): { status: 'failed'; resumable: boolean } {
  return { status: 'failed', resumable: row.status === 'resume_review' || row.stage === 'resume_review' }
}

/** The message a person reads. Names the stage it died in, because that is the actionable part. */
export function staleMessage(row: PackageLivenessRow, verdict: Extract<LivenessVerdict, { state: 'stale' }>): string {
  const where = row.stage ? ` during ${String(row.stage).replace(/_/g, ' ')}` : ''
  return `Generation stopped before completing${where} — ${verdict.reason}. Nothing was lost: retry to pick up from what finished.`
}
