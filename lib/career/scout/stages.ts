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
import type { CompanyToCheck, FetchPageFn, LookupBoardFn } from '@/lib/agents/job-scout'
import type { SearchStrategy } from '@/lib/agents/job-mission-planner'
import type { AgentResult, ToolContext } from '@/lib/agents/runtime/types'
import { AGENT_INTENT, selectCompaniesToCheck, type CompanySelection } from '../companies/intent'
import { normalizeCompanyName, type NormalizedJob } from '../jobs/normalize'
import type { PageFetcher, RawJobPosting, SourceRegistry } from '../sources/types'
import { checkCompanyForOpenings, runCompanyFirst, type CompanyFirstStore } from './company-first'
import { resolveScoutedPosting, type FetchBudget } from './resolve'
import { noteQuery, type ScoutStats } from './stats'
import type { ScoutedWatchCompany, ScoutStore } from './store'
import { createScoutTools } from './tools'

/** How many companies the scout may DISCOVER and check inside one run. */
export const MAX_SCOUT_COMPANY_CHECKS = 10

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
  /** Hand a raw posting to the run's pending batch. */
  keepRaw: (posting: RawJobPosting) => void
  /** Checkpoint: persist everything gathered so far. False means the schema is missing (fatal). */
  flush: (label: string) => Promise<boolean>
  /** The run's deadline bookkeeping; true when the run is past it. */
  pastDeadline: (stage: string) => boolean
  traced: (res: AgentResult<unknown>, refs: Record<string, unknown>) => Promise<void>
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
}

export interface CompanyFirstStageResult {
  selection: CompanySelection<ScoutedWatchCompany>
  /** False when the schema is missing and the run cannot continue. */
  ok: boolean
}

/**
 * Check companies by INTENT: every Target, then Watching, then a rotating
 * least-recently-checked sample of Explore. The selection is reported whatever
 * it was — including a run that checked nothing, which is a diagnostic rather
 * than silence.
 */
export async function runCompanyFirstStage(run: StageRun, opts: CompanyFirstStageOptions): Promise<CompanyFirstStageResult> {
  const selection = selectCompaniesToCheck(opts.watchlist, { budget: opts.budget })
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
  for (const p of cf.postings) run.keepRaw(p)
  for (const c of cf.outcomes) noteQuery(run.stats, `lookup: ${c.name}`)
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
  return { selection, ok }
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
}

export interface JobFirstStageResult {
  /** False when the schema is missing and the run cannot continue. */
  ok: boolean
  /** Companies the scout proposed, in the order it proposed them. */
  discovered: CompanyToCheck[]
}

/**
 * One scout session per strategy, with a checkpoint after each. A session that
 * throws is recorded and the run continues: its predecessors' postings are
 * already in the database, and its successors have not started.
 */
export async function runJobFirstStage(run: StageRun, opts: JobFirstStageOptions): Promise<JobFirstStageResult> {
  const companiesToCheck: CompanyToCheck[] = []
  const strategies = [...opts.strategies].sort((a, b) => b.priority - a.priority).slice(0, opts.maxStrategies)

  const existing = await run.store.listJobs(run.userId, { canonicalOnly: false, limit: 500, sort: 'recent' })
  if (existing.migrationMissing) return { ok: false, discovered: companiesToCheck }
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
    if (run.pastDeadline(`strategy "${strategy.name}"`)) break
    run.progress('job-first', `strategy: ${strategy.name}`)
    let res: JobScoutSessionResult
    try {
      res = await session(
        {
          strategy, mission: opts.missionText, alreadyFound: [...alreadyFound], maxRounds: opts.maxRounds, targetCount: 12, deadline: run.deadline,
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
    for (const p of res.postings) {
      if (run.pastDeadline('resolving postings')) break
      const resolved = await resolveScoutedPosting(p, { registry: run.registry, fetcher: run.fetcher, stats: run.stats, fetchBudget: opts.fetchBudget, companiesToCheck, rawByUrl })
      if (resolved.posting) {
        run.keepRaw(resolved.posting)
        alreadyFound.add(resolved.posting.canonical_url ?? resolved.posting.source_url)
        alreadyFound.add(postingKey(p))
      } else if (resolved.outcome === 'failed') run.errors.push(`resolve ${p.url}: ${resolved.note}`)
    }
    companiesToCheck.push(...res.companiesToCheck)
    // Checkpoint per strategy: a later strategy that fails, hangs or runs out
    // of clock cannot take this one's postings with it.
    if (!(await run.flush(`strategy "${strategy.name}"`))) return { ok: false, discovered: companiesToCheck }
  }

  const ok = await checkDiscoveredCompanies(run, companiesToCheck, opts.known)
  return { ok, discovered: companiesToCheck }
}

/**
 * Companies the scout found: worth a look, so they go on the list as
 * SUGGESTIONS with a scout origin — a discovery is a hypothesis, never a
 * preference. Only the user promotes one to Target (ADR-039).
 */
async function checkDiscoveredCompanies(run: StageRun, discovered: CompanyToCheck[], known: Set<string>): Promise<boolean> {
  let checks = 0
  for (const c of discovered) {
    const key = normalizeCompanyName(c.name) ?? c.name.toLowerCase()
    if (known.has(key) || checks >= MAX_SCOUT_COMPANY_CHECKS || run.pastDeadline('scout company checks')) continue
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
    for (const p of r.postings) run.keepRaw(p)
    run.progress('company-first', `${c.name} (found by Scout): ${r.postings.length} openings`)
  }
  return run.flush('companies found by Scout')
}
