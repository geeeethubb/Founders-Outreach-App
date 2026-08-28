// The Job Scout session — rounds until the agent stops, the target is met, or
// the budget runs out. Mirrors runDiscoverySession in market-discovery.
//
// The loop is deliberately dumb: it never second-guesses the agent's chosen
// action. Its jobs are to enforce the round cap, keep the claimed set so rounds
// cannot re-find the same posting, hold the tool budget across rounds, and stop
// when a continuing action arrives without a query to continue with.

import type { AgentResult, ToolContext } from '../runtime/types'
import type { SearchStrategy } from '../job-mission-planner'
import {
  runJobScoutRound,
  SCOUT_TERMINAL_ACTIONS,
  type CompanyToCheck,
  type JobScoutInput,
  type JobScoutRoundOutput,
  type ScoutDiagnosis,
  type ScoutedPosting,
  type ScoutRoundHistory,
} from './index'
import { buildScoutTools, type FetchPageFn, type LookupBoardFn, type ScoutToolLogEntry } from './tools'

export interface ScoutSessionTools {
  lookupBoard: LookupBoardFn
  fetchPage: FetchPageFn
  /** Per-session caps. Defaults: 12 lookups, 8 fetches. */
  maxLookups?: number
  maxFetches?: number
}

/** One round, as the session sees it. Injectable so the loop is testable without a model. */
export type RunScoutRoundFn = (
  input: JobScoutInput,
  ctx: ToolContext,
  opts: { toolUrls: Set<string> }
) => Promise<AgentResult<JobScoutRoundOutput>>

export interface JobScoutSessionParams {
  strategy: SearchStrategy
  /** renderMission() output or a summary of it. */
  mission: string
  /** Canonical URLs and "company | title" keys claimed by earlier sessions. */
  alreadyFound: string[]
  maxRounds: number
  targetCount: number
  tools: ScoutSessionTools
  onRound?: (h: ScoutRoundHistory) => void
  onStep?: (info: { step: number; elapsedMs: number; stopReason: string | null; toolCalls: string[] }) => void
  onToolCall?: (entry: ScoutToolLogEntry) => void
  /** Injectable for tests. Defaults to the live agent round. */
  runRound?: RunScoutRoundFn
  /** Passed through to the live round. */
  cache?: boolean
  /**
   * Absolute epoch ms. The orchestrator checks its deadline between
   * strategies, but a strategy is two rounds of up to ten steps each, and a
   * retry storm inside one call can cost minutes — the discovery eval saw a
   * 600s run take 3996s. Past this, no further round starts.
   */
  deadline?: number
}

export interface JobScoutSessionResult {
  postings: ScoutedPosting[]
  companiesToCheck: CompanyToCheck[]
  history: ScoutRoundHistory[]
  strategyRejected: boolean
  needsNewStrategy: boolean
  finalDiagnosis: ScoutDiagnosis | null
  agentResults: AgentResult<JobScoutRoundOutput>[]
  errors: string[]
  toolLog: ScoutToolLogEntry[]
  /** Every URL a tool returned this session — the orchestrator's resolution pool. */
  toolUrls: Set<string>
  ungroundedPostings: number
}

/** Stable key for "same posting" across rounds and sessions, without a canonical resolver. */
export function postingKey(p: { company_name: string; title: string }): string {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  return `${norm(p.company_name)} | ${norm(p.title)}`
}

function normalizeUrlKey(url: string): string {
  try {
    const p = new URL(url)
    p.hash = ''
    return p.toString().replace(/\/$/, '')
  } catch {
    return url
  }
}

export async function runJobScoutSession(params: JobScoutSessionParams, ctx: ToolContext): Promise<JobScoutSessionResult> {
  const postings: ScoutedPosting[] = []
  const companiesToCheck: CompanyToCheck[] = []
  const history: ScoutRoundHistory[] = []
  const agentResults: AgentResult<JobScoutRoundOutput>[] = []
  const errors: string[] = []
  const toolLog: ScoutToolLogEntry[] = []
  const toolUrls = new Set<string>()
  const maxLookups = params.tools.maxLookups ?? 12
  const maxFetches = params.tools.maxFetches ?? 8

  const tools = buildScoutTools({
    lookupBoard: params.tools.lookupBoard,
    fetchPage: params.tools.fetchPage,
    seen: toolUrls,
    log: toolLog,
    maxLookups,
    maxFetches,
    onCall: params.onToolCall,
  })

  const runRound: RunScoutRoundFn =
    params.runRound ??
    ((input, c, o) => runJobScoutRound(input, c, { tools, toolUrls: o.toolUrls, cache: params.cache, onStep: params.onStep }))

  // Within the session, claimed by URL only. A company+title key is applied
  // ONLY against what the caller supplied in alreadyFound — two distinct
  // "Engineering Intern" postings at one company (SF and NYC) are two jobs, and
  // collapsing them here would lose one before the canonical resolver ever
  // sees it. The orchestrator owns real deduplication (docs/CAREER_OS.md §5).
  const claimed = new Set<string>(params.alreadyFound.filter((k) => /^https?:\/\//i.test(k)).map(normalizeUrlKey))
  const claimedTitles = new Set<string>(params.alreadyFound.filter((k) => !/^https?:\/\//i.test(k)).map((k) => k.toLowerCase()))
  const claimedCompanies = new Set<string>()

  let query = params.strategy.queries[0] ?? params.strategy.name
  let strategyRejected = false
  let needsNewStrategy = false
  let finalDiagnosis: ScoutDiagnosis | null = null
  let ungroundedPostings = 0

  for (let round = 1; round <= params.maxRounds; round++) {
    const remaining = params.targetCount - postings.length
    if (remaining <= 0) break
    if (params.deadline !== undefined && Date.now() > params.deadline) {
      errors.push(`scout round ${round} (${params.strategy.name}): not started, deadline passed`)
      break
    }

    const lookupsUsed = toolLog.filter((e) => e.tool === 'lookup_ats_board').length
    const fetchesUsed = toolLog.filter((e) => e.tool === 'fetch_page').length

    const input: JobScoutInput = {
      mission: params.mission,
      strategy: params.strategy,
      alreadyFound: [...params.alreadyFound, ...postings.map((p) => p.url)],
      history,
      currentQuery: query,
      targetCount: remaining,
      roundsRemaining: params.maxRounds - round,
      budget: { lookupsLeft: Math.max(0, maxLookups - lookupsUsed), fetchesLeft: Math.max(0, maxFetches - fetchesUsed) },
    }

    const result = await runRound(input, ctx, { toolUrls })
    agentResults.push(result)

    if (!result.output) {
      errors.push(`scout round ${round} (${params.strategy.name}): ${result.error}`)
      break
    }

    const out = result.output
    finalDiagnosis = out.diagnosis
    ungroundedPostings += out.ungrounded_postings

    let kept = 0
    for (const p of out.postings) {
      const urlKey = normalizeUrlKey(p.url)
      const titleKey = postingKey(p)
      if (claimed.has(urlKey) || claimedTitles.has(titleKey)) continue
      claimed.add(urlKey)
      postings.push(p)
      kept++
    }
    for (const c of out.companies_to_check) {
      const key = c.name.toLowerCase().replace(/[^a-z0-9]+/g, '')
      if (claimedCompanies.has(key)) continue
      claimedCompanies.add(key)
      companiesToCheck.push(c)
    }

    const entry: ScoutRoundHistory = {
      round,
      query_used: query,
      postings_found: out.postings.length + out.ungrounded_postings,
      postings_kept: kept,
      postings_ungrounded: out.ungrounded_postings,
      diagnosis: out.diagnosis,
      action: out.action,
      note: out.action_reasoning.slice(0, 180),
    }
    history.push(entry)
    params.onRound?.(entry)

    if (out.action === 'REJECT_STRATEGY') {
      strategyRejected = true
      break
    }
    if (out.action === 'REQUEST_NEW_STRATEGY') {
      needsNewStrategy = true
      break
    }
    if (SCOUT_TERMINAL_ACTIONS.includes(out.action)) break

    if (!out.next_query) {
      // A continuing action with nothing to continue on. Stop rather than re-run
      // the identical query, which would burn budget for free.
      errors.push(`scout (${params.strategy.name}): action ${out.action} supplied no next_query`)
      break
    }
    query = out.next_query
  }

  return {
    postings,
    companiesToCheck,
    history,
    strategyRejected,
    needsNewStrategy,
    finalDiagnosis,
    agentResults,
    errors,
    toolLog,
    toolUrls,
    ungroundedPostings,
  }
}
