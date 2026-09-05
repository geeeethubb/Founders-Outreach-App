// The two discovery stages of a scout run: COMPANY-FIRST and JOB-FIRST.
//
// Split out of orchestrator.ts so that file can stay the shape of the run —
// inputs, plan, checkpoints, ranking — rather than also holding two long
// stages. Both take the same `StageRun`: the collaborators, budgets and
// bookkeeping the run already owns. Neither creates a deadline, a budget or a
// store of its own, and neither decides when to persist: they hand postings to
// `keepRaw` and call `flush` at their own checkpoints.
//
// What each stage guarantees:
//
//   company-first  checks the user's own choices first and a ROTATING sample of
//                  the scout's guesses second (`selectCompaniesToCheck`), inside
//                  a share of the run's wall clock — the watchlist is an input
//                  to discovery, never its ceiling.
//
//   job-first      one scout session per strategy, persisted after EACH one, so
//                  a later strategy that throws or runs out of clock cannot take
//                  an earlier one's postings with it. Companies it discovers are
//                  written `suggested`/`scout` — a hypothesis, never a
//                  preference (ADR-039).
//
// No judgement here beyond what the injected agents make.

import { runJobScoutSession, postingKey, type JobScoutSessionParams, type JobScoutSessionResult } from '@/lib/agents/job-scout/session'
import { saturated, type YieldSample } from '../discovery/budget'
import type { SaturationPolicy } from '../discovery/modes'
import type { CompanyToCheck, FetchPageFn, LookupBoardFn } from '@/lib/agents/job-scout'
import type { SearchStrategy } from '@/lib/agents/job-mission-planner'
import type { AgentResult, ToolContext } from '@/lib/agents/runtime/types'
import { AGENT_INTENT, selectCompaniesToCheck, type CompanySelection } from '../companies/intent'
import { normalizeCompanyName, type NormalizedJob } from '../jobs/normalize'
import type { PageFetcher, RawJobPosting, SourceRegistry } from '../sources/types'
import { sweepWatchlist, type SweepResult, type SweepStore } from '../jobs/sweep'
import type { CareerMission } from '../types'
import { checkCompanyForOpenings, runCompanyFirst, type CompanyFirstStore } from './company-first'
import { resolveScoutedPosting, type FetchBudget } from './resolve'
import { bump, emptyStats, noteQuery, type ScoutStats } from './stats'
import type { ScoutedWatchCompany, ScoutStore } from './store'
import { createScoutTools } from './tools'

/** How many companies the scout may DISCOVER and check inside one run, by default. */
export const MAX_SCOUT_COMPANY_CHECKS = 10

/**
 * Postings one job-first strategy asks for, when the caller names no budget.
 *
 * This used to be the literal `12` on the session call, and it was one of the
 * two binding limits on the whole product: a strategy stopped at twelve
 * postings however much supply existed. It is now a MODE's number
 * (`RunBudget.maxPostingsPerStrategy`), and a strategy stops on saturation,
 * budget, exhaustion or the deadline — not on a counter.
 */
export const DEFAULT_POSTINGS_PER_STRATEGY = 40

/** Which half of the run found a posting. */
export type DiscoveryLane = 'company_first' | 'broad_market'

/** Everything a stage shares with the run that called it. Nothing here is stage-local. */
export interface StageRun {
  userId: string
  ctx: ToolContext
  store: ScoutStore
  registry: SourceRegistry
  fetcher: PageFetcher
  stats: ScoutStats
  errors: string[]
  /** Unix ms — the run's deadline, not a stage's share of it. */
  deadline: number
  concurrency: number
  progress: (stage: string, detail: string) => void
  /**
   * Hand a raw posting to the run's pending batch, saying which LANE found it.
   *
   * The lane is what makes "did this run search the market, or re-read the
   * watchlist?" a measured number instead of an opinion — the audit's central
   * question. Company-first (and the sweep) are `company_first`; anything a
   * search produced, including a board found by following a search result, is
   * `broad_market`.
   */
  keepRaw: (posting: RawJobPosting, lane?: DiscoveryLane) => void
  /** Checkpoint: persist everything gathered so far. False means the schema is missing (fatal). */
  flush: (label: string) => Promise<boolean>
  /** The run's deadline bookkeeping; true when the run is past it. */
  pastDeadline: (stage: string) => boolean
  traced: (res: AgentResult<unknown>, refs: Record<string, unknown>) => Promise<void>
}

// ─── (c2) Sweep ──────────────────────────────────────────────────────────────

export interface SweepStageOptions {
  mission: CareerMission
  /** Companies the sweep may visit. */
  limit: number
  /** Unix ms this stage stops at: its share of the run, never more than the run's own deadline. */
  stageDeadline: number
  runId: string | null
}

export interface SweepStageResult {
  /** False when the schema is missing and the run cannot continue. */
  ok: boolean
  jobs: SweepResult['jobs']
  postings: number
  inserted: number
  /** True when no company was left unvisited: nothing for a later pass to sweep. */
  complete: boolean
  /** True when the sweep stopped because its clock ran out — the companies it left are the next pass's work. */
  deadlineHit: boolean
}

/**
 * The free, wide pass: every company on the watchlist with a resolvable board,
 * listed through the registry and stored with the extracted columns null.
 *
 * No model call is reachable from here (lib/career/jobs/sweep.ts pins the
 * extraction budget to zero and verification off), so it costs the run nothing
 * but wall clock — and it decides what the rest of the run is choosing FROM,
 * which is why it goes first.
 *
 * It does not narrow company-first. Re-listing a board the sweep just read is
 * free (the adapters cache a listing per board per day) and the store matches
 * the second sighting to the row the sweep inserted.
 */
export async function runSweepStage(run: StageRun, opts: SweepStageOptions): Promise<SweepStageResult> {
  const empty: SweepStageResult = { ok: true, jobs: [], postings: 0, inserted: 0, complete: false, deadlineHit: false }
  run.progress('sweep', 'listing every resolvable board on the watchlist (no model calls)')
  try {
    // Its OWN stats object. The two passes see the same postings — the sweep
    // lists a board, company-first re-lists it from cache — so sharing one
    // record would count every rejection and every verdict twice and quietly
    // double the funnel the founder reads.
    const sweepStats = emptyStats()
    const sw = await sweepWatchlist(
      run.userId,
      {
        mission: opts.mission,
        limit: opts.limit,
        deadline: opts.stageDeadline,
        runId: opts.runId,
        ctx: run.ctx,
        stats: sweepStats,
        onProgress: (stage, detail) => run.progress(stage, detail),
      },
      { store: run.store as SweepStore, registry: run.registry, fetcher: run.fetcher }
    )
    if (sw.migrationMissing) return { ...empty, ok: false }
    run.errors.push(...sw.errors)
    // The sweep persisted through the same `upsertJobs`, so its rows belong to
    // this run's counts exactly as a stage's do. Merged by hand, once, so it is
    // obvious which numbers a sweep contributes.
    run.stats.companies_checked += sw.checked
    run.stats.companies_with_openings += sw.withOpenings
    run.stats.postings_seen += sw.postingsListed
    run.stats.postings_resolved += sw.postingsListed
    run.stats.jobs_inserted += sw.inserted
    run.stats.jobs_updated += sw.updated
    bump(run.stats.sources_consulted, 'sweep:postings', sw.postingsListed)
    bump(run.stats.sources_consulted, 'sweep:boards', sw.withBoard)
    // Prefixed so they are visible without colliding with the stages' own
    // counts for the same rule — nothing a sweep discards is hidden.
    for (const [reason, n] of Object.entries(sw.rejected)) bump(run.stats.jobs_rejected, `sweep:${reason}`, n)
    run.progress('sweep', `${sw.checked} companies · ${sw.postingsListed} postings · ${sw.inserted} new, ${sw.updated} updated${sw.remaining ? ` · ${sw.remaining} companies left for the next sweep` : ''}`)
    return { ok: true, jobs: sw.jobs, postings: sw.postingsListed, inserted: sw.inserted, complete: !sw.remaining, deadlineHit: Boolean(sw.deadlineHit) && sw.remaining > 0 }
  } catch (e) {
    // A sweep is an optimisation, never a precondition: a run whose sweep
    // throws still does everything it did before the sweep existed.
    run.errors.push(`sweep: ${e instanceof Error ? e.message : String(e)}`)
    return empty
  }
}

// ─── (d) Company-first ───────────────────────────────────────────────────────

export interface CompanyFirstStageOptions {
  watchlist: ScoutedWatchCompany[]
  /** How many companies this run may check at all. */
  budget: number
  /** Wall clock held back for job-first discovery — reported when the cap bites. */
  reserveMs: number
  /** Unix ms this stage stops at: the earlier of the run deadline and its own share. */
  stageDeadline: number
  /**
   * The most of the budget the rotating `Explore` sample may take. A broad run
   * passes a SMALL share on purpose: Targets are always checked and Watching
   * regularly, but the scout's own accumulated guesses are the least likely
   * place to find something the founder would otherwise miss.
   */
  exploreShare?: number
  /** Company ids an earlier invocation of this run already checked — never re-checked. */
  skip?: Set<string>
  /** Called with each company id as it is checked, so the run can persist a cursor. */
  onChecked?: (companyId: string) => void
}

export interface CompanyFirstStageResult {
  selection: CompanySelection<ScoutedWatchCompany>
  /** False when the schema is missing and the run cannot continue. */
  ok: boolean
  /** Company ids this stage checked, for the run's cursor. */
  checked: string[]
  /** True when every eligible company was reached: the stage is finished for good. */
  complete: boolean
  /** True when the lane stopped on its share of the clock with companies unchecked — the next pass's work. */
  deadlineHit: boolean
}

/**
 * Check companies by INTENT: every Target, then Watching, then a rotating
 * least-recently-checked sample of Explore. The selection is reported whatever
 * it was — including a run that checked nothing, which is a diagnostic rather
 * than silence.
 */
export async function runCompanyFirstStage(run: StageRun, opts: CompanyFirstStageOptions): Promise<CompanyFirstStageResult> {
  // A resumed run does not pay for the companies its earlier invocation
  // already checked: they are removed BEFORE selection, so the budget goes to
  // companies nobody has looked at yet rather than being spent again.
  const skip = opts.skip ?? new Set<string>()
  const remaining = skip.size ? opts.watchlist.filter((c) => !skip.has(c.id)) : opts.watchlist
  if (skip.size) run.progress('company-first', `resuming: ${skip.size} companies already checked by an earlier pass`)
  const selection = selectCompaniesToCheck(remaining, { budget: opts.budget, exploreShare: opts.exploreShare })
  run.progress('company-first', selection.reason)
  if (selection.selected.length === 0 && opts.watchlist.length > 0) {
    run.errors.push(`company-first checked nothing: ${selection.reason} (${opts.watchlist.length} companies on the list)`)
  }

  const cfStore: CompanyFirstStore = run.store
  const cf = await runCompanyFirst(
    run.userId,
    selection.selected,
    { concurrency: run.concurrency, deadline: opts.stageDeadline, maxCompanies: selection.selected.length, onProgress: (d) => run.progress('company-first', d) },
    { registry: run.registry, fetcher: run.fetcher, store: cfStore }
  )
  run.stats.companies_checked += cf.checked
  run.stats.companies_with_openings += cf.withOpenings
  run.stats.postings_seen += cf.postings.length
  run.stats.postings_resolved += cf.postings.length
  for (const p of cf.postings) run.keepRaw(p, 'company_first')
  const checked: string[] = []
  for (const c of cf.outcomes) {
    noteQuery(run.stats, `lookup: ${c.name}`)
    if (c.companyId) {
      checked.push(c.companyId)
      opts.onChecked?.(c.companyId)
    }
  }
  run.errors.push(...cf.errors)
  if (cf.deadlineHit) {
    if (Date.now() > run.deadline) run.pastDeadline('company-first (remaining companies)')
    else {
      const note = `company-first stopped at its share of the run (${Math.round(opts.reserveMs / 1000)}s reserved for job-first discovery); ${selection.selected.length - cf.checked} companies not checked`
      run.errors.push(note)
      run.progress('company-first', note)
    }
  }

  // Checkpoint 1: whatever the watchlist just produced is stored before any
  // model-driven searching begins.
  const ok = await run.flush('company-first')
  // "Complete" means there is nothing left for a later pass to check — not
  // that this pass was long. A stage cut short by its own share of the clock,
  // or holding companies it never reached, stays open in the cursor.
  const complete = !cf.deadlineHit && selection.skipped === 0
  return { selection, ok, checked, complete, deadlineHit: Boolean(cf.deadlineHit) }
}

// ─── (e) Job-first ───────────────────────────────────────────────────────────

export interface JobFirstStageOptions {
  missionText: string
  /** Planned strategies, or the deterministic fallback when the planner failed. */
  strategies: SearchStrategy[]
  maxStrategies: number
  maxRounds: number
  /** ATS lookups and page fetches the whole run may spend, shared across sessions. */
  maxAtsLookups: number
  maxPageFetches: number
  /** The run-wide page-fetch allowance, decremented here. */
  fetchBudget: FetchBudget
  /** Companies already on any list — a discovery matching one is not re-added. */
  known: Set<string>
  /** What earlier checkpoints already stored, so a session is not sent to re-find it. */
  persistedJobs: NormalizedJob[]
  session?: (params: JobScoutSessionParams, ctx: ToolContext) => Promise<JobScoutSessionResult>
  lookupBoard?: LookupBoardFn
  fetchPage?: FetchPageFn
  /** Postings one strategy aims at. Replaces the old hard-coded 12. */
  targetCount?: number
  /** When a strategy stops being worth continuing. Off (never saturates) when omitted. */
  saturation?: SaturationPolicy
  /** Companies the scout may discover and check inside this run. */
  maxScoutCompanyChecks?: number
  /** Strategies an earlier invocation of this run already executed, by name. */
  skipStrategies?: Set<string>
  /** Called with each strategy name as it finishes, so the run can persist a cursor. */
  onStrategyDone?: (name: string) => void
  /**
   * "May I start another paid strategy?" — the run's spend ceiling, asked
   * BEFORE the money is committed. A refusal stops the loop with its reason;
   * it never truncates a session already in flight.
   */
  canStart?: (estimate: { strategy: string }) => { ok: boolean; reason: string | null }
}

export interface JobFirstStageResult {
  /** False when the schema is missing and the run cannot continue. */
  ok: boolean
  /** Companies the scout proposed, in the order it proposed them. */
  discovered: CompanyToCheck[]
  /** Strategy names executed to completion this pass. */
  executed: string[]
  /** True when every strategy was executed: nothing left for a later pass. */
  complete: boolean
  /** Why the loop stopped early, if it did — saturation, budget or the deadline. */
  stopReason: string | null
  /** Marginal unique yield per strategy, in execution order. */
  yields: YieldSample[]
}

/**
 * One scout session per strategy, with a checkpoint after each. A session that
 * throws is recorded and the run continues: its predecessors' postings are
 * already in the database, and its successors have not started.
 */
export async function runJobFirstStage(run: StageRun, opts: JobFirstStageOptions): Promise<JobFirstStageResult> {
  const companiesToCheck: CompanyToCheck[] = []
  const executed: string[] = []
  const yields: YieldSample[] = []
  let stopReason: string | null = null
  const skipStrategies = opts.skipStrategies ?? new Set<string>()
  const ranked = [...opts.strategies].sort((a, b) => b.priority - a.priority).slice(0, opts.maxStrategies)
  // A resumed run does not re-execute what an earlier invocation finished.
  const strategies = skipStrategies.size ? ranked.filter((s) => !skipStrategies.has(s.name)) : ranked
  if (skipStrategies.size) run.progress('job-first', `resuming: ${skipStrategies.size} strateg${skipStrategies.size === 1 ? 'y' : 'ies'} already executed`)

  const bail = (ok: boolean): JobFirstStageResult => ({ ok, discovered: companiesToCheck, executed, complete: false, stopReason, yields })

  const existing = await run.store.listJobs(run.userId, { canonicalOnly: false, limit: 500, sort: 'recent' })
  if (existing.migrationMissing) return bail(false)
  const alreadyFound = new Set<string>()
  for (const j of existing.jobs) {
    if (j.canonical_url) alreadyFound.add(j.canonical_url)
    alreadyFound.add(postingKey(j))
  }
  for (const p of opts.persistedJobs) if (p.canonical_url) alreadyFound.add(p.canonical_url)

  const rawByUrl = new Map<string, RawJobPosting>()
  const live = createScoutTools({ registry: run.registry, fetcher: run.fetcher, stats: run.stats, rawByUrl })
  const perSessionLookups = Math.max(2, Math.floor(opts.maxAtsLookups / Math.max(1, strategies.length)))
  const perSessionFetches = Math.max(2, Math.floor(opts.maxPageFetches / 2 / Math.max(1, strategies.length)))
  const session = opts.session ?? runJobScoutSession

  for (const strategy of strategies) {
    if (run.pastDeadline(`strategy "${strategy.name}"`)) {
      stopReason = stopReason ?? 'the run reached its deadline'
      break
    }
    // Money first: a strategy is the most expensive thing this stage starts,
    // so the ceiling is asked BEFORE the session, never after it has spent.
    const allowed = opts.canStart?.({ strategy: strategy.name })
    if (allowed && !allowed.ok) {
      stopReason = allowed.reason ?? 'the run reached its spend ceiling'
      run.errors.push(`job-first stopped: ${stopReason}`)
      run.progress('job-first', `stopped: ${stopReason}`)
      break
    }
    // And then: is another strategy still worth executing at all? Saturation
    // is about the MARGIN — if the last strategies added almost nothing new,
    // the next one is unlikely to, and continuing is paying for duplicates.
    if (opts.saturation) {
      const sat = saturated(yields, opts.saturation)
      if (sat.saturated) {
        stopReason = sat.reason
        run.errors.push(`job-first stopped: ${sat.reason}`)
        run.progress('job-first', `stopped: ${sat.reason}`)
        break
      }
    }
    run.progress('job-first', `strategy: ${strategy.name}`)
    let res: JobScoutSessionResult
    try {
      res = await session(
        {
          strategy, mission: opts.missionText, alreadyFound: [...alreadyFound], maxRounds: opts.maxRounds,
          targetCount: opts.targetCount ?? DEFAULT_POSTINGS_PER_STRATEGY, deadline: run.deadline,
          tools: { lookupBoard: opts.lookupBoard ?? live.lookupBoard, fetchPage: opts.fetchPage ?? live.fetchPage, maxLookups: perSessionLookups, maxFetches: perSessionFetches },
          onRound: (h) => { noteQuery(run.stats, h.query_used); run.progress('job-first', `${strategy.name} r${h.round}: ${h.postings_kept} kept · ${h.diagnosis} → ${h.action}`) },
        },
        run.ctx
      )
    } catch (e) {
      run.errors.push(`strategy "${strategy.name}": ${e instanceof Error ? e.message : String(e)}`)
      // Whatever earlier stages found is already stored; keep going.
      continue
    }
    for (const r of res.agentResults) await run.traced(r, { strategy: strategy.name })
    for (const h of res.history) noteQuery(run.stats, h.query_used)
    run.errors.push(...res.errors)
    opts.fetchBudget.left -= res.toolLog.filter((e) => e.tool === 'fetch_page').length
    // Marginal yield of this strategy: what it returned, and how much of that
    // this run had never seen. `alreadyFound` is the run's own claimed set, so
    // "unique" means new to the run — which is the number saturation is about.
    let unique = 0
    for (const p of res.postings) {
      if (run.pastDeadline('resolving postings')) break
      const resolved = await resolveScoutedPosting(p, { registry: run.registry, fetcher: run.fetcher, stats: run.stats, fetchBudget: opts.fetchBudget, companiesToCheck, rawByUrl })
      if (resolved.posting) {
        const key = resolved.posting.canonical_url ?? resolved.posting.source_url
        if (!alreadyFound.has(key)) unique++
        run.keepRaw(resolved.posting, 'broad_market')
        alreadyFound.add(key)
        alreadyFound.add(postingKey(p))
      } else if (resolved.outcome === 'failed') run.errors.push(`resolve ${p.url}: ${resolved.note}`)
    }
    yields.push({ seen: res.postings.length, unique, label: `strategy "${strategy.name}"` })
    executed.push(strategy.name)
    opts.onStrategyDone?.(strategy.name)
    companiesToCheck.push(...res.companiesToCheck)
    // Checkpoint per strategy: a later strategy that fails, hangs or runs out
    // of clock cannot take this one's postings with it.
    if (!(await run.flush(`strategy "${strategy.name}"`))) return bail(false)
  }

  const complete = executed.length === strategies.length && stopReason === null
  const ok = await checkDiscoveredCompanies(run, companiesToCheck, opts.known, opts.maxScoutCompanyChecks ?? MAX_SCOUT_COMPANY_CHECKS)
  return { ok, discovered: companiesToCheck, executed, complete, stopReason, yields }
}

/**
 * Companies the scout found: worth a look, so they go on the list as
 * SUGGESTIONS with a scout origin — a discovery is a hypothesis, never a
 * preference. Only the user promotes one to Target (ADR-039).
 */
async function checkDiscoveredCompanies(run: StageRun, discovered: CompanyToCheck[], known: Set<string>, maxChecks: number): Promise<boolean> {
  let checks = 0
  for (const c of discovered) {
    const key = normalizeCompanyName(c.name) ?? c.name.toLowerCase()
    if (known.has(key) || checks >= maxChecks || run.pastDeadline('scout company checks')) continue
    known.add(key)
    const w = await run.store.upsertWatch(run.userId, { name: c.name, domain: c.domain, watch_status: AGENT_INTENT, watch_source: 'scout', watch_note: c.why.slice(0, 300) })
    if (!w.id) { if (w.error) run.errors.push(`watch ${c.name}: ${w.error}`); continue }
    checks++
    const r = await checkCompanyForOpenings(
      run.userId,
      { id: w.id, name: c.name, domain: c.domain, careers_url: null, ats_type: null, ats_identifier: null },
      {},
      { registry: run.registry, fetcher: run.fetcher, store: run.store }
    )
    run.stats.companies_checked++
    if (r.postings.length) run.stats.companies_with_openings++
    run.stats.postings_seen += r.postings.length
    run.stats.postings_resolved += r.postings.length
    // Broad market, not company-first: nobody put this company on a list — a
    // search found it, and its openings are that search's yield.
    for (const p of r.postings) run.keepRaw(p, 'broad_market')
    run.progress('company-first', `${c.name} (found by Scout): ${r.postings.length} openings`)
  }
  return run.flush('companies found by Scout')
}
