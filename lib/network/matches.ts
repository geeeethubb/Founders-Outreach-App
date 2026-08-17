// Persistence for mission-specific internal matches.
//
// Deterministic writes, degrading gracefully without migration 013 in the same
// way as lib/scouting/persist.ts.

import { createServiceClient } from '@/lib/supabase/server'
import type { RankedInternalCandidate } from './rank'

function isMissingSchema(message: string): boolean {
  return /relation .* does not exist|column .* does not exist|schema cache/i.test(message)
}

export interface PersistMatchesResult {
  inserted: number
  migrationMissing: boolean
  errors: string[]
}

export async function persistNetworkMatches(params: {
  userId: string
  runId: string | null
  missionGoal: string
  ranked: RankedInternalCandidate[]
  /** Ids that made the final shortlist, so the rest are recorded as retrieved-only. */
  shortlisted: Set<string>
  searchQueries: string[]
}): Promise<PersistMatchesResult> {
  if (params.ranked.length === 0) return { inserted: 0, migrationMissing: false, errors: [] }

  const supabase = createServiceClient()
  const rows = params.ranked.map((r) => ({
    user_id: params.userId,
    run_id: params.runId,
    contact_id: r.contact.contact_id,
    mission_goal: params.missionGoal,
    score: Number(r.total.toFixed(4)),
    confidence: Number(r.confidence.toFixed(3)),
    reason: r.reason.slice(0, 1000),
    evidence: r.evidence.slice(0, 5),
    matched_by: params.searchQueries.slice(0, 8),
    stage: params.shortlisted.has(r.contact.contact_id) ? 'shortlisted' : 'retrieved',
    rank: r.rank,
  }))

  // Without a run_id there is no unique index to conflict on, so a plain insert
  // is correct there and an upsert would be a no-op that silently drops rows.
  const query = params.runId
    ? supabase.from('network_matches').upsert(rows, { onConflict: 'run_id,contact_id' })
    : supabase.from('network_matches').insert(rows)

  const { error } = await query
  if (error) {
    return {
      inserted: 0,
      migrationMissing: isMissingSchema(error.message),
      errors: [error.message.slice(0, 160)],
    }
  }
  return { inserted: rows.length, migrationMissing: false, errors: [] }
}
