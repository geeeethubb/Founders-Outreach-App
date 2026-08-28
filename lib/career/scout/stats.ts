// Scout run statistics — the funnel, as numbers.
//
// A scout that reports "12 jobs" and nothing else cannot be debugged. Every
// stage records what went in and what came out, and every rejection carries
// its reason, so the founder can read a run and know whether the planner,
// the surface, the extractor or the constraints are the reason the list is
// short. `summarizeStats` renders the same numbers for scripts and the UI.

import { VERIFICATION_STATUSES, type VerificationStatus } from '../types'

export interface ScoutStats {
  /** Every web query the planner and scout used, plus tool lookups by company. */
  queries: string[]
  /** Postings seen per source type: greenhouse, lever, careers_page, web_search, … */
  sources_consulted: Record<string, number>
  companies_checked: number
  companies_with_openings: number
  postings_seen: number
  postings_resolved: number
  jobs_extracted: number
  /** Count per hard-constraint label (plus 'appears_closed'). */
  jobs_rejected: Record<string, number>
  clusters: number
  duplicates_removed: number
  verification: Record<VerificationStatus, number>
  jobs_inserted: number
  jobs_updated: number
  cost_usd: number
  latency_ms: number
  web_searches: number
  model_calls: number
  deadline_hit: boolean
}

export function emptyStats(): ScoutStats {
  const verification = {} as Record<VerificationStatus, number>
  for (const s of VERIFICATION_STATUSES) verification[s] = 0
  return {
    queries: [],
    sources_consulted: {},
    companies_checked: 0,
    companies_with_openings: 0,
    postings_seen: 0,
    postings_resolved: 0,
    jobs_extracted: 0,
    jobs_rejected: {},
    clusters: 0,
    duplicates_removed: 0,
    verification,
    jobs_inserted: 0,
    jobs_updated: 0,
    cost_usd: 0,
    latency_ms: 0,
    web_searches: 0,
    model_calls: 0,
    deadline_hit: false,
  }
}

/** Increment a counter in a record, creating it on first sight. */
export function bump(record: Record<string, number>, key: string, by = 1): void {
  record[key] = (record[key] ?? 0) + by
}

/** Record a query once; the list is for reading, not for counting. */
export function noteQuery(stats: ScoutStats, query: string): void {
  const q = query.trim()
  if (q && !stats.queries.includes(q)) stats.queries.push(q)
}

function histogram(record: Record<string, number>): string {
  const entries = Object.entries(record).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
  return entries.length ? entries.map(([k, n]) => `${k} ${n}`).join(', ') : 'none'
}

/** Human lines, in funnel order. */
export function summarizeStats(stats: ScoutStats): string[] {
  const rejected = Object.values(stats.jobs_rejected).reduce((a, b) => a + b, 0)
  const lines = [
    `queries: ${stats.queries.length} · web searches: ${stats.web_searches} · model calls: ${stats.model_calls}`,
    `companies checked: ${stats.companies_checked} (${stats.companies_with_openings} with openings)`,
    `postings seen: ${stats.postings_seen} · resolved: ${stats.postings_resolved} · sources: ${histogram(stats.sources_consulted)}`,
    `extracted: ${stats.jobs_extracted} · rejected: ${rejected}${rejected ? ` (${histogram(stats.jobs_rejected)})` : ''}`,
    `clusters: ${stats.clusters} · duplicates removed: ${stats.duplicates_removed}`,
    `verification: ${histogram(stats.verification)}`,
    `persisted: ${stats.jobs_inserted} new, ${stats.jobs_updated} updated`,
    `cost: $${stats.cost_usd.toFixed(4)} · ${(stats.latency_ms / 1000).toFixed(1)}s${stats.deadline_hit ? ' · DEADLINE HIT' : ''}`,
  ]
  return lines
}
