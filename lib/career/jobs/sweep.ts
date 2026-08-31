// The watchlist sweep — inventory, decoupled from extraction.
//
// A scout run is expensive because it thinks: a planner, web-search sessions,
// one extractor call per posting, a fit evaluation per candidate. That cost is
// what capped discovery at ~25 companies and ~40 postings a run, and it is why
// the founder's inbox held 35 jobs while 126 of their 188 watched companies had
// never been checked at all.
//
// This is the other half. A board listing is JSON over HTTP: free, fast, and
// deterministic. So the sweep visits EVERY company on the watchlist, lists what
// its board is advertising, normalizes it with the same regexes the scout uses,
// clusters it, and stores it — with the extracted columns left null. There is
// not one model call anywhere in this path, and the assertion is structural
// rather than a promise: it reuses `persistBatch` with an extraction budget of
// zero and verification off, so there is no code path from here to an agent.
//
// What that buys: inventory scales with the watchlist (hundreds of postings),
// while the money is spent afterwards, deliberately, on the highest-relevance
// rows (`extractPending`, lib/career/scout/extract.ts). Two hundred live
// postings then costs about what thirty-five used to.
//
// Three properties it must have, because a sweep is long:
//
//   1. **Per-company isolation.** One dead board, one 500, one company whose
//      careers page times out — none of them stops the other 187. Every failure
//      is caught, counted and reported by company name.
//   2. **Incremental persistence.** Postings are flushed in batches while the
//      sweep is still running, so a sweep that hits its deadline, is killed by
//      a serverless timeout, or is cancelled keeps everything it has found.
//   3. **A rotation.** Companies with a stored board first (one request each),
//      then the never-checked, then the least-recently-checked. A deadline
//      therefore cuts the expensive tail, and the next sweep starts where this
//      one stopped.
//
// Manners are non-negotiable and unchanged: public JSON APIs and public
// careers pages, robots-aware through the shared fetcher, no logins, no
// CAPTCHAs, bounded concurrency. A board that cannot be read inside those rules
// is skipped and reported — never worked around (docs/CAREER_OS.md §5).

import type { ToolContext } from '@/lib/agents/runtime/types'
import { byCheckOrder } from '../companies/intent'
import { checkCompanyForOpenings, liveCompanyFirstStore, type CompanyFirstStore, type WatchedCompany } from '../scout/company-first'
import { isAtsListingSource, persistBatch, type BatchContext, type BatchStore } from '../scout/persist'
import { directionTerms } from '../scout/direction'
import { emptyStats, type ScoutStats } from '../scout/stats'
import type { CareerMission } from '../types'
import { getPageFetcher } from '../sources/fetch'
import { getSourceRegistry } from '../sources/registry'
import type { PageFetcher, RawJobPosting, SourceRegistry } from '../sources/types'
import { normalizeCompanyName } from './normalize'
import { jobRelevance } from './relevance'
import { listWatchlist, resolveStoredIntent, updateJobVerification, upsertJobs } from './store'

// ─── Budgets ─────────────────────────────────────────────────────────────────
//
// Every number here is deliberate, and every one of them is a LISTING budget —
// nothing in this file can spend a dollar.

/**
 * Postings kept per board, after the internship filter.
 *
 * The scout's own lookup keeps 120 (tools.ts) because a session has to read
 * them. Nothing reads these; they are stored. A board listing is one cached
 * request whatever the cap, and a large employer's Summer 2027 programme can
 * post well over a hundred internships across sites, so cutting at 120 would
 * throw away inventory that cost nothing to obtain.
 */
export const SWEEP_LIST_LIMIT = 300

/**
 * Companies one sweep will visit. 1000 is "all of them, and then some": the
 * founder's list is 188 and the point of the sweep is that the watchlist is
 * never the thing that limits it. A caller with a clock (the Vercel worker)
 * passes something smaller.
 */
export const SWEEP_MAX_COMPANIES = 1000

/** Boards read at once. Modest on purpose — five ATS APIs should not notice us. */
export const SWEEP_CONCURRENCY = 6

/** Postings held in memory before a flush. Small enough that a crash loses little. */
export const SWEEP_BATCH_SIZE = 40

/** A local sweep's default wall clock: fifteen minutes, ample for 188 companies. */
export const SWEEP_DEADLINE_MS = 900_000

/** A hosted sweep stops well inside Vercel's 300s function ceiling. */
export const SWEEP_VERCEL_DEADLINE_MS = 240_000

// ─── Types ───────────────────────────────────────────────────────────────────

/** The persistence a sweep needs. `ScoutStore` satisfies it structurally. */
export interface SweepStore extends CompanyFirstStore, BatchStore {
  listWatchlist(userId: string): Promise<{ companies: Record<string, unknown>[]; error: string | null; migrationMissing: boolean }>
}

export interface SweepDeps {
  store?: SweepStore
  registry?: SourceRegistry
  fetcher?: PageFetcher
}

/**
 * The production store. Deliberately assembled here from the same functions the
 * scout uses rather than given its own persistence: a sweep and a scout run
 * must dedupe against each other, and they only can if they write through one
 * `upsertJobs`.
 */
export function liveSweepStore(): SweepStore {
  return {
    ...liveCompanyFirstStore(),
    listWatchlist: (userId) => listWatchlist(userId),
    upsertJobs,
    updateJobVerification,
  }
}

export interface SweepOptions {
  /** The mission whose geo tiers and hard constraints the postings are judged against. */
  mission: CareerMission
  /** Companies to visit. Default SWEEP_MAX_COMPANIES — i.e. all of them. */
  limit?: number
  concurrency?: number
  /** Postings kept per board after the internship filter. Default SWEEP_LIST_LIMIT. */
  listLimit?: number
  /** Unix ms. Past it nothing new starts; everything in hand is still persisted. */
  deadline?: number
  batchSize?: number
  /**
   * Skip ATS detection and visit only companies whose board is already stored.
   * The cheap daily pass; a full sweep leaves it off so new boards get found.
   */
  storedBoardsOnly?: boolean
  /** Re-list boards even if this process listed them today. */
  bypassCache?: boolean
  /** The run to stamp jobs against, so a sweep is a run you can open. */
  runId?: string | null
  /** Agent context. Carried only because persistBatch's signature needs one; nothing here calls an agent. */
  ctx?: ToolContext
  /** Shared stats, when a sweep runs inside a larger run. */
  stats?: ScoutStats
  /** Company ids to skip — a stage that has already checked them this run. */
  skipCompanyIds?: Set<string>
  onProgress?: (stage: string, detail: string) => void
}

export interface SweepCompanyOutcome {
  id: string
  name: string
  /** How the board was found, or why it was not. */
  method: string
  postings: number
  note: string
  error: string | null
}

/** One stored posting, as thin as the caller needs to list it or count it. */
export interface SweepJob {
  id: string
  title: string
  company_name: string
  location_raw: string | null
  location_tier: number | null
  season_relevance: string
  employment_type: string
  verification_status: string
  canonical_url: string | null
  source_types: string[]
  /** Deterministic relevance at store time — ordering only, never persisted. */
  relevance: number
  /** False until something fills the extracted columns in (`extractPending`). */
  extracted: boolean
}

/** The most jobs a sweep result carries back. Everything is stored either way. */
export const MAX_SWEEP_JOBS_RETURNED = 500

export interface SweepResult {
  /** Companies on the watchlist that a sweep could consider at all. */
  eligible: number
  /** Companies this sweep actually visited. */
  checked: number
  withBoard: number
  withOpenings: number
  /** Visited, no public board found inside the rules. */
  withoutBoard: number
  postingsListed: number
  /** Postings that survived normalization and the mission's hard constraints. */
  jobsStored: number
  inserted: number
  updated: number
  /** Rejections by reason — 'appears_closed', a hard constraint's label. */
  rejected: Record<string, number>
  /** What was stored, best-relevance first, capped at MAX_SWEEP_JOBS_RETURNED. */
  jobs: SweepJob[]
  /** The best relevance score in this sweep, for a one-line summary. */
  topRelevance: number
  byAts: Record<string, number>
  outcomes: SweepCompanyOutcome[]
  errors: string[]
  deadlineHit: boolean
  /** Companies left for the next sweep because the clock ran out. */
  remaining: number
  migrationMissing: boolean
}

function emptyResult(): SweepResult {
  return {
    eligible: 0, checked: 0, withBoard: 0, withOpenings: 0, withoutBoard: 0, postingsListed: 0, jobsStored: 0,
    inserted: 0, updated: 0, rejected: {}, jobs: [], topRelevance: 0, byAts: {}, outcomes: [], errors: [],
    deadlineHit: false, remaining: 0, migrationMissing: false,
  }
}

// ─── Which companies, in what order ──────────────────────────────────────────

/** A watchlist row as the sweep needs it. Intent is resolved, never read raw (ADR-039). */
export interface SweepCompany extends WatchedCompany {
  intent: string | null
}

export function toSweepCompany(row: Record<string, unknown>): SweepCompany {
  const intent = resolveStoredIntent(row)
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    domain: (row.domain as string | null) ?? null,
    careers_url: (row.careers_url as string | null) ?? null,
    ats_type: (row.ats_type as string | null) ?? null,
    ats_identifier: (row.ats_identifier as string | null) ?? null,
    watch_status: intent,
    watch_priority: (row.watch_priority as number | null) ?? null,
    last_careers_check_at: (row.last_careers_check_at as string | null) ?? null,
    intent,
  }
}

/**
 * The sweep's order, and it is not the scout's.
 *
 * `selectCompaniesToCheck` rations a small budget between the user's choices
 * and a rotating sample of guesses, because a scout run can only afford a few.
 * A sweep can afford all of them, so rationing is the wrong question — the only
 * question is which order survives a deadline best:
 *
 *   1. a stored board          one JSON request, near-certain to return postings
 *   2. never checked           the 126 rows that are the reason inventory is thin
 *   3. everything else         least recently checked first, so it rotates
 *
 * Within each group the existing `byCheckOrder` applies (priority, then
 * least-recently-checked, then name), so the order is deterministic and a
 * re-sweep visits the same companies in the same sequence.
 */
export function orderForSweep(companies: SweepCompany[], adapted: Set<string>): SweepCompany[] {
  const group = (c: SweepCompany): number => {
    if (c.ats_type && c.ats_identifier && adapted.has(c.ats_type)) return 0
    if (!c.last_careers_check_at) return 1
    return 2
  }
  return [...companies].sort((a, b) => group(a) - group(b) || byCheckOrder(a, b))
}

// ─── The sweep ───────────────────────────────────────────────────────────────

/**
 * List every resolvable board on the watchlist and store what it advertises.
 *
 * Returns what it found and what it could not reach. It never throws for an
 * expected condition: a dead board, a blocked page, a company with no public
 * ATS are all outcomes with names, and all of them appear in `outcomes` and in
 * `errors` rather than ending the sweep.
 */
export async function sweepWatchlist(userId: string, opts: SweepOptions, deps: SweepDeps = {}): Promise<SweepResult> {
  const registry = deps.registry ?? getSourceRegistry()
  const fetcher = deps.fetcher ?? getPageFetcher()
  const store = deps.store
  if (!store) throw new Error('sweepWatchlist needs a store (liveSweepStore() in production)')

  const result = emptyResult()
  const deadline = opts.deadline ?? Date.now() + SWEEP_DEADLINE_MS
  const concurrency = Math.max(1, opts.concurrency ?? SWEEP_CONCURRENCY)
  const batchSize = Math.max(1, opts.batchSize ?? SWEEP_BATCH_SIZE)
  const listLimit = opts.listLimit ?? SWEEP_LIST_LIMIT
  const stats = opts.stats ?? emptyStats()
  const progress = (stage: string, detail: string) => opts.onProgress?.(stage, detail)

  const watch = await store.listWatchlist(userId)
  if (watch.migrationMissing) return { ...result, migrationMissing: true, errors: ['migration 014_career_os.sql has not been applied'] }
  if (watch.error) result.errors.push(`watchlist: ${watch.error}`)

  const adapted = new Set(registry.adapters().map((a) => a.id as string))
  const all = watch.companies.map(toSweepCompany).filter((c) => c.name && c.intent !== 'ignored')
  const eligible = opts.skipCompanyIds ? all.filter((c) => !opts.skipCompanyIds!.has(c.id)) : all
  result.eligible = eligible.length
  const queue = orderForSweep(eligible, adapted).slice(0, Math.max(0, opts.limit ?? SWEEP_MAX_COMPANIES))
  result.remaining = eligible.length - queue.length
  progress('sweep', `${queue.length} companies (${eligible.length} on the list, ${queue.filter((c) => c.ats_type && adapted.has(c.ats_type)).length} with a stored board)`)

  // ── The batch tail, borrowed whole from the scout ───────────────────────────
  //
  // Zero extraction budget and verification OFF is what makes "no model calls"
  // structural rather than a claim: `extractAndNormalize` slices its extractable
  // list to zero, and the verifier is never reached. What the batch still does
  // is exactly what a sweep needs — cluster, mark ATS-listed postings open by
  // construction, upsert, refresh a re-seen row's verdict.
  const atsListedUrls = new Set<string>()
  const extractBudget = { left: 0 }
  const domainByName = new Map<string, string>()
  for (const c of all) if (c.domain) domainByName.set(normalizeCompanyName(c.name) ?? c.name.toLowerCase(), c.domain)
  const batch: BatchContext = {
    userId,
    mission: opts.mission,
    ctx: opts.ctx ?? { user_id: userId, run_id: opts.runId ?? null, budget: { maxCompanies: 0, maxPeoplePerCompany: 0, maxApolloCalls: 0, maxWebSearches: 0, maxAgentSteps: 0 } },
    run: { runId: opts.runId ?? null, trace: async () => null },
    store,
    stats,
    registry,
    fetcher,
    deadline,
    concurrency,
    // Off: page-based verification is a fetch per job, which is the one thing
    // that would make a 400-posting sweep expensive in requests. An ATS listing
    // is already proof the posting is open, and `npm run career:verify` owns
    // the rest.
    verify: false,
    fetchBudget: { left: 0 },
    atsListedUrls,
    domainFor: (name) => domainByName.get(normalizeCompanyName(name) ?? name.toLowerCase()) ?? null,
    pastDeadline: () => Date.now() > deadline,
  }

  const terms = directionTerms(opts.mission.preferences.direction)
  const pending: RawJobPosting[] = []
  const stored: SweepJob[] = []
  let flushing: Promise<void> = Promise.resolve()

  const flush = async (label: string): Promise<void> => {
    const raws = pending.splice(0, pending.length)
    if (raws.length === 0) return
    const out = await persistBatch(raws, batch, extractBudget)
    if (out.migrationMissing) {
      result.migrationMissing = true
      result.errors.push(...out.errors)
      return
    }
    result.errors.push(...out.errors)
    result.inserted += out.inserted
    result.updated += out.updated
    result.jobsStored += out.jobs.length
    for (const r of out.rejected) result.rejected[r.reason] = (result.rejected[r.reason] ?? 0) + 1
    for (let i = 0; i < out.jobs.length; i++) {
      const id = out.ids[i]
      const job = out.jobs[i]
      if (!id) continue
      stored.push({
        id,
        title: job.title,
        company_name: job.company_name,
        location_raw: job.location_raw,
        location_tier: job.location_tier,
        season_relevance: job.season_relevance,
        employment_type: job.employment_type,
        verification_status: job.verification_status,
        canonical_url: job.canonical_url,
        source_types: [...new Set(job.sources.map((s) => s.source_type))],
        relevance: jobRelevance(job, terms),
        // A sweep never extracts. Saying so in the row is what lets the inbox
        // show a listing-only posting honestly instead of pretending it is thin.
        extracted: job.extraction_version != null,
      })
    }
    progress('sweep', `${label}: stored ${out.jobs.length} (${out.inserted} new, ${out.updated} updated)`)
  }

  /** Serialize flushes: two concurrent upserts of the same posting would race. */
  const flushLater = (label: string) => {
    flushing = flushing.then(() => flush(label)).catch((e) => {
      result.errors.push(`persist ${label}: ${e instanceof Error ? e.message : String(e)}`)
    })
    return flushing
  }

  // ── The pool ───────────────────────────────────────────────────────────────
  let cursor = 0
  let checked = 0
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const i = cursor++
      if (i >= queue.length) return
      if (Date.now() > deadline) {
        result.deadlineHit = true
        return
      }
      const company = queue[i]
      try {
        const r = await checkCompanyForOpenings(
          userId,
          company,
          { internshipsOnly: true, limit: listLimit, storedBoardsOnly: opts.storedBoardsOnly, bypassCache: opts.bypassCache },
          { registry, fetcher, store }
        )
        // storedBoardsOnly declines rather than checks; it is not a check.
        const declined = opts.storedBoardsOnly && !r.board && r.method === 'none' && /detection was skipped/.test(r.note)
        if (!declined) {
          checked++
          stats.companies_checked++
          if (r.board) {
            result.withBoard++
            result.byAts[r.board.ats] = (result.byAts[r.board.ats] ?? 0) + 1
          } else result.withoutBoard++
          if (r.postings.length) {
            result.withOpenings++
            stats.companies_with_openings++
          }
          result.outcomes.push({ id: company.id, name: company.name, method: r.method, postings: r.postings.length, note: r.note, error: r.error })
          if (r.error) result.errors.push(`${company.name}: ${r.error}`)
        }
        for (const p of r.postings) {
          pending.push(p)
          result.postingsListed++
          stats.postings_seen++
          stats.postings_resolved++
          if (isAtsListingSource(p.source_type)) atsListedUrls.add(p.canonical_url ?? p.source_url)
        }
        if (r.postings.length) progress('sweep', `${company.name}: ${r.postings.length} internship postings (${r.method})`)
      } catch (e) {
        // One company's failure is one line, never the end of the sweep. It
        // still counts as CHECKED — we visited it, we learned nothing, and a
        // sweep that reported 197 of 200 visited would send the reader looking
        // for three companies it had in fact tried.
        const message = e instanceof Error ? e.message : String(e)
        checked++
        stats.companies_checked++
        result.errors.push(`${company.name}: ${message}`)
        result.outcomes.push({ id: company.id, name: company.name, method: 'none', postings: 0, note: 'threw', error: message })
      }
      if (pending.length >= batchSize) await flushLater(`after ${checked} companies`)
    }
  })
  await Promise.all(workers)
  await flushLater('final')
  await flushing

  result.checked = checked
  if (result.deadlineHit) {
    const left = queue.length - checked
    result.remaining += Math.max(0, left)
    result.errors.push(`sweep stopped at its deadline with ${Math.max(0, left)} of ${queue.length} companies unchecked — everything found is stored; run it again to continue`)
  }
  // Best first, and stable: two postings with the same score keep store order.
  const ordered = stored.map((j, i) => ({ j, i })).sort((a, b) => b.j.relevance - a.j.relevance || a.i - b.i).map((x) => x.j)
  result.jobs = ordered.slice(0, MAX_SWEEP_JOBS_RETURNED)
  result.topRelevance = ordered[0]?.relevance ?? 0
  progress('sweep', `${result.checked} companies · ${result.postingsListed} postings listed · ${result.inserted} new`)
  return result
}

/** One line a human can read. */
export function summarizeSweep(r: SweepResult): string[] {
  const rejected = Object.entries(r.rejected).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
  return [
    `companies: ${r.checked} checked of ${r.eligible} on the list (${r.withBoard} with a board, ${r.withoutBoard} without, ${r.remaining} left for next time)`,
    `boards: ${Object.entries(r.byAts).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`,
    `postings: ${r.postingsListed} listed · ${r.jobsStored} stored (${r.inserted} new, ${r.updated} updated)`,
    `rejected: ${rejected.length ? rejected.map(([k, n]) => `${k} ${n}`).join(', ') : 'none'}`,
    `top relevance: ${r.topRelevance}${r.deadlineHit ? ' · DEADLINE HIT' : ''}`,
  ]
}
