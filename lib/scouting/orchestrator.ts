// The People Scout orchestrator.
//
// Agents are pure with respect to the database; this file is where inputs get
// loaded and outputs get persisted. It owns the stage ordering, the budget, and
// the funnel accounting.
//
// STAGE ORDER IS A COST DECISION (ADR-014):
//
//   strategy → internal → discovery → VALIDATION → people search → triage
//            → research → rank
//                          ^^^^^^^^^^                ^^^^^^^^^^^^^^^
//                          free (web)                costs credits / dollars
//
// Validating companies before touching Apollo is what keeps a bad segment from
// spending the credit budget. Phase 6 measured 40% of discovered companies
// rejected at that gate.
//
// ONE RUN, MANY LEGS (ADR-043). A hosted worker lives 300 seconds; a full-depth
// run measured 527. So every stage here reads the run's CLOCK before it starts
// work, every long stage checks it per item, and everything a stage produces
// is written to the run's CHECKPOINT (lib/scouting/checkpoint.ts) as it lands.
// A leg that runs out of clock returns `continuable`; the next leg resumes from
// the checkpoint and pays for nothing twice. The result the page renders is
// written progressively too, so a run that stops short still shows what it
// found (principle 11).
//
// Every collaborator is injectable (ScoutDeps) so the whole loop runs in
// memory under test with stub agents and a stub store. Production callers pass
// nothing and get the live modules.

import { runMissionStrategist, type MissionStrategy } from '@/lib/agents/mission-strategist'
import { runDiscoverySession, type DiscoveredCompany, type DiscoveryRoundHistory } from '@/lib/agents/market-discovery'
import { runCompanyValidation, shouldEnrich, type CompanyValidation } from '@/lib/agents/company-validation'
import { runPersonResearch, renderPersonResearch } from '@/lib/agents/person-research'
import { runRanking } from '@/lib/agents/ranking'
import { runPersonTriage, type TriageScore } from '@/lib/agents/person-triage'
import { recordAgentRun, persistResearchFacts, startScoutingRun, updateScoutingRun } from '@/lib/agents/runtime/persist'
import type { AgentResult, RunBudget, ToolContext } from '@/lib/agents/runtime/types'
import { scoutPeople, type ScoutTarget } from './people-scout'
import { persistCompanies, persistContacts } from './persist'
import { mapWithConcurrency } from './concurrency'
import { companyKey } from './dedupe'
import { normalizeTitlePatterns } from './titles'
import { runInternalPhase, scoreInternalProspects } from './internal-first'
import type { ProspectSource, ScoutedProspect } from './prospect'
import type { RankedInternalCandidate } from '@/lib/network/rank'
import { isClockOutcome } from '@/lib/runs/errors'
import { loadOwnedIndex, findOwned, type OwnedIndex } from '@/lib/network/reuse'
import { summarizeDecision, type SearchMode } from '@/lib/network/sufficiency'
import { anthropicUsage, resetAnthropicUsage } from '@/lib/providers/anthropic/client'
import { apolloStats, resetApolloStats } from '@/lib/providers/apollo/client'
import { normalizeDomain } from '@/lib/providers/apollo/normalize'
import type { CompanyCandidate, PersonCandidate } from '@/lib/providers/types'
import { createRunContext, currentRunContext, runCancelRequested, withRunContext } from '@/lib/runs/context'
import { LOCAL_INVOCATION_BUDGET_MS, RunClock } from '@/lib/runs/deadline'
import { scoutLog } from '@/lib/runs/log'
import { touchScoutRun } from '@/lib/career/scout/run-store'
import {
  emptyCheckpoint,
  personKeyOf,
  toCheckpointPerson,
  type CheckpointPerson,
  type FunnelCounts,
  type InternalSummary,
  type PeopleScoutCheckpoint,
  type PeopleScoutResult,
  type PeopleScoutStage,
  type ProspectView,
  type UnrankedView,
} from './checkpoint'

export type { FunnelCounts, InternalSummary } from './checkpoint'

export interface Mission {
  goal: string
  timeframe: string
  geography: string
  constraints: string[]
}

export interface BackgroundItem {
  id: string
  summary: string
}

/** Every collaborator the run uses, so the whole loop runs in memory under test. */
export interface ScoutDeps {
  strategist?: typeof runMissionStrategist
  discovery?: typeof runDiscoverySession
  validation?: typeof runCompanyValidation
  triage?: typeof runPersonTriage
  research?: typeof runPersonResearch
  ranking?: typeof runRanking
  scoutPeople?: typeof scoutPeople
  internalPhase?: typeof runInternalPhase
  scoreInternal?: typeof scoreInternalProspects
  loadOwned?: typeof loadOwnedIndex
  persistCompanies?: typeof persistCompanies
  persistContacts?: typeof persistContacts
  persistFacts?: typeof persistResearchFacts
  recordAgentRun?: typeof recordAgentRun
  startRun?: typeof startScoutingRun
  updateRun?: typeof updateScoutingRun
  touchRun?: typeof touchScoutRun
}

export interface ScoutRunParams {
  userId: string
  label: string
  mission: Mission
  backgroundItems: BackgroundItem[]
  budget: RunBudget
  segmentCount: number
  companiesPerSegment: number
  /** Cap on person-research + ranking, the most expensive per-prospect steps. */
  maxProspects: number
  /** Bounded autonomy for each discovery session. */
  maxDiscoveryRounds?: number
  /** Re-scout attempts when person research asks for a different role. */
  maxRescoutRounds?: number
  /** Hard cap on DEEP person research — the dominant per-run cost. */
  maxDeepResearch?: number
  /** How many people per company advance past triage. */
  researchPerCompany?: number
  concurrency?: number
  /**
   * Where prospects may come from. Default `internal_first`: search the
   * existing network, and only spend on external discovery when it is not
   * enough. See lib/network/sufficiency.ts.
   */
  searchMode?: SearchMode
  /** How many strong internal candidates make external discovery unnecessary. */
  internalTarget?: number
  /** Cap on internal searches the retrieval agent may run. */
  maxInternalSearches?: number
  /** Log a line per stage. The smoke test wants to watch it work. */
  onProgress?: (stage: string, detail: string, counts?: Record<string, number>) => void

  // ─── Durable-run mode (the worker). Absent for the CLI, the evals and the smoke test.
  /** An existing run row to ATTACH to. The row's status is then the worker's, never this function's. */
  runId?: string | null
  /** The leg's worker id; every row write is fenced on it. */
  workerId?: string | null
  /** Where the previous leg stopped. */
  checkpoint?: PeopleScoutCheckpoint | null
  /** Called whenever the checkpoint moves. The worker persists it, throttled. */
  onCheckpoint?: (checkpoint: PeopleScoutCheckpoint) => void
  /** Called whenever the result the page renders changes. */
  onResult?: (result: PeopleScoutResult) => void
  /** True once the run should stop at the next step (cancel, lost row). */
  shouldStop?: () => boolean
  /** Where the "who you are" side came from, for the result payload. */
  background?: { source: 'bank' | 'fixture'; items: number; warning: string | null } | null
  /** Wall clock for THIS invocation when no run context is ambient (CLI). Default: twenty minutes. */
  deadlineMs?: number
  deps?: ScoutDeps
}

export type ScoutStopReason = 'complete' | 'deadline' | 'cancelled' | 'failed'

export interface ScoutRunResult {
  runId: string | null
  strategy: MissionStrategy | null
  ranked: ScoutedProspect[]
  /** The internal-first phase, always present so "why did/didn't it search externally" is answerable. */
  internal: InternalSummary
  funnel: FunnelCounts
  usage: {
    anthropic: ReturnType<typeof anthropicUsage>
    apollo: ReturnType<typeof apolloStats>
    costUsd: number
    costPerRankedProspect: number
    /** Where the money actually went. The first question after any run. */
    byAgent: Record<string, { calls: number; costUsd: number; webSearches: number }>
    latencyMs: number
    /** Apollo enrichments avoided by reusing a stored contact. */
    apolloCallsAvoided: number
  }
  persistence: {
    migrationMissing: boolean
    companiesInserted: number
    contactsInserted: number
    agentRunsRecorded: number
    factsInserted: number
    factsRejected: number
  }
  rejections: { company: string; description: string; reason: string }[]
  /** Companies that passed validation and reached Apollo. Feeds discovery precision. */
  enrichedCompanies: { name: string; description: string; note: string }[]
  /** Every person Apollo surfaced per company. Feeds the best-person eval. */
  candidatePool: Record<string, string[]>
  /** Every discovery round: query, diagnosis, action. Feeds the recovery eval. */
  discoveryHistory: { segment: string; rounds: DiscoveryRoundHistory[]; rejected: boolean }[]
  /** Why people were dropped before enrichment. "0 enriched" must be explainable. */
  peopleFilter: { seen: number; kept: number; rejected: Record<string, number> } | null
  errors: string[]
  // ─── Durable-run outcome.
  /** Why this leg stopped. `deadline` with `continuable` means "the next leg resumes here". */
  stopped: ScoutStopReason
  partial: boolean
  continuable: boolean
  checkpoint: PeopleScoutCheckpoint
  /** The payload the page renders. */
  payload: PeopleScoutResult
}

function companyCandidateFrom(d: DiscoveredCompany, v: CompanyValidation | null): CompanyCandidate {
  return {
    name: d.name,
    domain: normalizeDomain(d.domain),
    description: v?.what_they_do ?? d.what_they_do ?? null,
    industry: v?.industries_served?.[0] ?? null,
    sub_industries: v?.industries_served?.slice(1) ?? [],
    employee_count: null,
    employee_range: null,
    stage: null,
    founded_year: null,
    hq_location: null,
    country: null,
    website_url: d.domain ? `https://${normalizeDomain(d.domain)}` : null,
    linkedin_url: null,
    raw: { discovery: d as unknown as Record<string, unknown> },
    provenance: {
      provider_id: 'anthropic_web',
      query_ref: { source_url: d.source_url },
      retrieved_at: new Date().toISOString(),
    },
  }
}

/** Minimum work time a stage needs to be worth starting. Below it, the leg hands over instead. */
const STAGE_MIN_MS: Record<string, number> = {
  strategy: 45_000,
  internal: 30_000,
  discovery: 45_000,
  validation: 25_000,
  people: 15_000,
  triage: 15_000,
  research: 30_000,
  rescout: 30_000,
  rank: 40_000,
}

/** How many legs may retry ONE person's research after the clock cut it off. */
const RESEARCH_MAX_TRIES = 2

const renderCompany = (v: CompanyValidation | undefined, fallback: string): string => {
  if (!v) return fallback
  const lines = [`WHAT THEY DO: ${v.what_they_do}`]
  if (v.products_services.length) lines.push(`PRODUCTS/SERVICES: ${v.products_services.join('; ')}`)
  if (v.industries_served.length) lines.push(`INDUSTRIES: ${v.industries_served.join(', ')}`)
  if (v.size_stage_context) lines.push(`SIZE/STAGE: ${v.size_stage_context}`)
  lines.push(`RELEVANCE: ${v.relevance_reasoning}`)
  const facts = v.claims.filter((c) => c.type === 'FACT').slice(0, 5)
  if (facts.length) lines.push(`VERIFIED FACTS:\n${facts.map((f) => `  • ${f.claim}`).join('\n')}`)
  if (v.uncertainties.length) lines.push(`UNKNOWNS: ${v.uncertainties.slice(0, 3).join('; ')}`)
  return lines.join('\n')
}

export async function runScouting(params: ScoutRunParams): Promise<ScoutRunResult> {
  // One clock for the leg. Inside a worker it is the ambient run context's;
  // from the CLI it is created here, generously.
  const outer = currentRunContext()
  if (outer) return runScoutingLeg(params, outer.clock)
  const clock = RunClock.forBudget(params.deadlineMs ?? LOCAL_INVOCATION_BUDGET_MS)
  const ctx = createRunContext({ clock, kind: 'people', label: params.label, runId: params.runId ?? null })
  return withRunContext(ctx, () => runScoutingLeg(params, clock))
}

async function runScoutingLeg(params: ScoutRunParams, clock: RunClock): Promise<ScoutRunResult> {
  const d = params.deps ?? {}
  const strategist = d.strategist ?? runMissionStrategist
  const discovery = d.discovery ?? runDiscoverySession
  const validation = d.validation ?? runCompanyValidation
  const triage = d.triage ?? runPersonTriage
  const research = d.research ?? runPersonResearch
  const ranking = d.ranking ?? runRanking
  const scout = d.scoutPeople ?? scoutPeople
  const internalPhase = d.internalPhase ?? runInternalPhase
  const scoreInternal = d.scoreInternal ?? scoreInternalProspects
  const loadOwned = d.loadOwned ?? loadOwnedIndex
  const persistCos = d.persistCompanies ?? persistCompanies
  const persistPeople = d.persistContacts ?? persistContacts
  const persistFacts = d.persistFacts ?? persistResearchFacts
  const recordRun = d.recordAgentRun ?? recordAgentRun
  const startRun = d.startRun ?? startScoutingRun
  const updateRun = d.updateRun ?? updateScoutingRun
  const touchRun = d.touchRun ?? touchScoutRun

  const log = params.onProgress ?? (() => {})
  const concurrency = params.concurrency ?? 3
  const researchPerCompany = params.researchPerCompany ?? 2
  const searchMode: SearchMode = params.searchMode ?? 'internal_first'
  const internalTarget = params.internalTarget ?? Math.max(6, Math.min(15, params.maxProspects))
  const runStartedAt = Date.now()
  const shouldStop = () => runCancelRequested() || (params.shouldStop?.() ?? false)

  // This leg's provider accounting starts at zero; the checkpoint carries the run's total.
  resetAnthropicUsage()
  resetApolloStats()

  const cp: PeopleScoutCheckpoint = params.checkpoint ?? emptyCheckpoint()
  cp.attempts += 1
  if (params.background) cp.background = params.background
  const errors = cp.errors
  const funnel = cp.funnel
  const stages = new Set<PeopleScoutStage>(cp.stages)
  const done = (s: PeopleScoutStage) => stages.has(s)
  const finishStage = (s: PeopleScoutStage) => {
    stages.add(s)
    cp.stages = [...stages]
    checkpoint()
  }
  const checkpoint = () => {
    cp.stages = [...stages]
    cp.updated_at = new Date().toISOString()
    params.onCheckpoint?.(cp)
  }
  const triageScores = new Map<string, TriageScore>()

  // ─── Run row ───────────────────────────────────────────────────────────────
  // Attached (the worker): the row exists, its status is the worker's. Owned
  // (the CLI, the evals): create it, heartbeat it, and close it at the end.
  let runId: string | null = params.runId ?? null
  const attached = Boolean(params.runId)
  let heartbeat: ReturnType<typeof setInterval> | null = null
  if (!attached) {
    const started = await startRun({ userId: params.userId, label: params.label, mission: params.mission, budget: params.budget, kind: 'outreach' })
    if (started.migrationMissing) cp.persistence.migrationMissing = true
    if (started.error) errors.push(`scouting_runs: ${started.error.slice(0, 120)}`)
    runId = started.runId
    if (runId) {
      // A live CLI run must never look dead to the reaper: renew its lease like a worker would.
      const id = runId
      heartbeat = setInterval(() => void touchRun(id).catch(() => undefined), 30_000)
      heartbeat.unref?.()
      await touchRun(id).catch(() => undefined)
    }
  }
  const rowGuard = attached && params.workerId ? { workerId: params.workerId, statuses: ['running'] } : {}
  const patchRow = async (patch: Parameters<typeof updateScoutingRun>[1]) => {
    if (!runId) return
    await updateRun(runId, patch, rowGuard).catch(() => undefined)
  }
  if (cp.attempts === 1) await patchRow({ searchMode })

  const ctx: ToolContext = { user_id: params.userId, run_id: runId, budget: params.budget }

  const trace = async (result: AgentResult<unknown>, refs: Record<string, unknown>) => {
    const a = (cp.costByAgent[result.trace.agent_id] ??= { calls: 0, costUsd: 0, webSearches: 0 })
    a.calls++
    a.costUsd += result.trace.cost_usd
    a.webSearches += result.trace.web_searches
    const rec = await recordRun(params.userId, runId, result, { inputRefs: refs })
    if (rec.migrationMissing) cp.persistence.migrationMissing = true
    else if (rec.error) errors.push(`agent_runs: ${rec.error.slice(0, 100)}`)
    else cp.persistence.agentRunsRecorded++
    return rec.agentRunId
  }

  const backgroundSummary = params.backgroundItems.map((b) => `  [${b.id}] ${b.summary}`).join('\n')
  const progress = (stage: string, detail: string) => {
    scoutLog({ event: 'stage', stage, detail })
    log(stage, detail, {
      companies: funnel.companiesValidated,
      people: funnel.peopleEnriched,
      researched: funnel.peopleResearched,
      ranked: Object.keys(cp.ranked).length + (cp.internal?.prospects.length ?? 0),
    })
  }

  // ─── The gates ─────────────────────────────────────────────────────────────
  // A stage is started only with enough clock to be worth starting; a leg
  // that cannot fit the next stage hands over rather than beginning it and
  // paying for half. Inside the long stages the same question is asked per
  // item, with the item's own minimum.
  type Stop = { stopped: 'deadline' | 'cancelled'; stage: string }
  const gate = (stage: keyof typeof STAGE_MIN_MS): Stop | null => {
    if (shouldStop()) return { stopped: 'cancelled', stage }
    if (!clock.canStart(STAGE_MIN_MS[stage])) return { stopped: 'deadline', stage }
    return null
  }
  const itemGate = (minMs: number): boolean => !shouldStop() && clock.canStart(minMs)

  // ─── The answer, built from the checkpoint at any point ────────────────────
  const finish = (stopped: ScoutStopReason, note?: string): ScoutRunResult => {
    if (heartbeat) clearInterval(heartbeat)
    if (note) errors.push(note)
    const complete = stopped === 'complete'
    if (complete) stages.add('done')
    // Fold this leg's provider usage into the run's running total.
    const a = anthropicUsage()
    const ap = apolloStats()
    cp.usage.costUsd += a.costUsd
    cp.usage.calls += a.calls
    cp.usage.cachedCalls += a.cachedCalls
    cp.usage.webSearches += a.webSearches
    cp.usage.retries += a.retries
    cp.usage.errors += a.errors
    cp.usage.apolloCalls += ap.calls
    cp.usage.apolloCredits += ap.enrichmentCredits
    cp.usage.latencyMs += Date.now() - runStartedAt
    const ranked = assembleRanked(cp)
    funnel.prospectsRanked = ranked.length
    checkpoint()
    const payload = buildPeopleScoutResult(cp, { runId, searchMode, complete, accepted: cp.accepted })
    params.onResult?.(payload)
    const continuable = stopped === 'deadline' || (stopped === 'cancelled' && false)
    const internal: InternalSummary = cp.internal?.summary ?? emptyInternal(searchMode, internalTarget)
    const result: ScoutRunResult = {
      runId,
      strategy: cp.strategy,
      ranked,
      internal,
      funnel,
      usage: {
        anthropic: a,
        apollo: ap,
        costUsd: cp.usage.costUsd,
        costPerRankedProspect: ranked.length > 0 ? cp.usage.costUsd / ranked.length : 0,
        byAgent: cp.costByAgent,
        latencyMs: cp.usage.latencyMs,
        apolloCallsAvoided: cp.apolloCallsAvoided,
      },
      persistence: { ...cp.persistence },
      rejections: cp.rejections,
      enrichedCompanies: cp.accepted.map((x) => ({ name: x.company.name, description: x.validation.what_they_do, note: `${x.validation.verdict} — ${x.validation.relevance_reasoning}` })),
      candidatePool: cp.peopleStats?.candidatePool ?? {},
      discoveryHistory: cp.discoveryHistory,
      peopleFilter: cp.peopleStats?.filter ?? null,
      errors,
      stopped,
      partial: !complete && stopped !== 'failed',
      continuable,
      checkpoint: cp,
      payload,
    }
    scoutLog({ event: 'leg_result', stage: cp.stages[cp.stages.length - 1] ?? null, status: stopped, cost_usd: cp.usage.costUsd, detail: `${ranked.length} ranked` })
    return result
  }
  const stopAt = (s: Stop): ScoutRunResult => {
    progress(s.stage, s.stopped === 'cancelled' ? 'stopped: cancelled' : `stopped: not enough time left for ${s.stage} in this pass — continuing in the next`)
    return finish(s.stopped)
  }
  // Own-row mode closes its row itself. The worker owns the status when attached.
  const closeOwnRow = async (r: ScoutRunResult) => {
    if (attached || !runId) return r
    const status = r.stopped === 'complete' ? 'succeeded' : r.stopped === 'failed' ? 'failed' : r.stopped === 'cancelled' ? 'cancelled' : 'partial'
    await updateRun(runId, {
      status,
      stats: { funnel: r.funnel, usage: { anthropic: r.usage.anthropic, apollo: r.usage.apollo, costUsd: r.usage.costUsd }, stopped: r.stopped },
      error: r.stopped === 'failed' ? (r.errors[r.errors.length - 1] ?? null) : null,
      completed: true,
    }).catch(() => undefined)
    return r
  }

  try {
    // ─── 1. Mission Strategist ─────────────────────────────────────────────
    if (!done('strategy')) {
      const g = gate('strategy')
      if (g) return closeOwnRow(stopAt(g))
      progress('strategy', 'interpreting mission')
      const strategyRun = await strategist({ mission: params.mission, backgroundSummary, segmentCount: params.segmentCount }, ctx)
      await trace(strategyRun as AgentResult<unknown>, { mission: params.label })
      if (!strategyRun.output) {
        // A provider deadline is the clock's doing, not the strategist's: the next leg asks again.
        if (isClockOutcome(strategyRun)) {
          errors.push(`mission_strategist: ${strategyRun.error}`)
          return closeOwnRow(finish('deadline'))
        }
        return closeOwnRow(finish('failed', `mission_strategist failed: ${strategyRun.error}`))
      }
      cp.strategy = strategyRun.output
      funnel.segments = cp.strategy.segments.length
      progress('strategy', `${cp.strategy.segments.length} segments: ${cp.strategy.segments.map((s) => s.name).join(' | ')}`)
      await patchRow({ strategy: cp.strategy })
      finishStage('strategy')
    }
    const strategy = cp.strategy!

    // ─── 1b. EXISTING NETWORK FIRST ────────────────────────────────────────
    // Before a single credit is spent: who do we already have?
    if (!done('internal')) {
      const g = gate('internal')
      if (g) return closeOwnRow(stopAt(g))
      // A leg cut off while SCORING resumes here with the phase's summary and
      // the candidates it did not reach, so retrieval is never paid for twice.
      const resumed = cp.internal?.pending?.length ? cp.internal : null
      const phase = resumed ? null : await internalPhase({
        userId: params.userId,
        runId,
        mission: params.mission,
        backgroundSummary,
        strategyHints: strategy.segments.flatMap((s) => [s.name, ...s.title_patterns.slice(0, 3)]).slice(0, 12),
        targetCount: internalTarget,
        mode: searchMode,
        ctx,
        maxSearches: params.maxInternalSearches ?? 8,
        onProgress: (s, dtl) => progress(s, dtl),
        trace: trace as never,
      })
      let summary: InternalSummary
      let runExternal: boolean
      let candidates: RankedInternalCandidate[]
      let scoredSoFar: ScoutedProspect[]
      if (phase) {
        errors.push(...phase.errors)
        funnel.networkIndexed = phase.facets.indexed
        funnel.internalRetrieved = phase.ranked.length
        funnel.internalStrong = phase.decision.strongCount
        summary = {
          decision: phase.decision,
          poolAssessment: phase.poolAssessment,
          missingProfile: phase.missingProfile,
          searchLog: phase.searchLog,
          indexed: phase.facets.indexed,
          classified: phase.facets.classified,
          costUsd: phase.costUsd,
        }
        runExternal = phase.decision.runExternal
        candidates = phase.ranked.slice(0, params.maxProspects)
        scoredSoFar = []
        progress('decision', summarizeDecision(phase.decision))
        for (const reason of phase.decision.reasons) progress('decision', reason)
        await patchRow({ internalDecision: summary })
        // Checkpoint the candidates BEFORE scoring: a leg that dies here resumes scoring, not retrieval.
        cp.internal = { summary, prospects: [], runExternal, pending: candidates }
        checkpoint()
      } else {
        summary = resumed!.summary
        runExternal = resumed!.runExternal
        candidates = resumed!.pending ?? []
        scoredSoFar = resumed!.prospects
        progress('internal-rank', `resuming: ${candidates.length} internal candidate(s) left to score`)
      }

      // Score the internal candidates on the same instrument the external
      // pipeline uses, so the two can be merged into one honest ranking.
      const scored = candidates.length
        ? await scoreInternal({
            userId: params.userId,
            mission: { goal: params.mission.goal, timeframe: params.mission.timeframe },
            positioningAngle: strategy.positioning_angle,
            backgroundItems: params.backgroundItems,
            candidates,
            ctx,
            concurrency,
            minAttemptMs: STAGE_MIN_MS.rank,
            shouldStop,
            trace: trace as never,
            onProgress: (s, dtl) => progress(s, dtl),
          })
        : { prospects: [] as ScoutedProspect[], errors: [] as string[], deadlined: [] as RankedInternalCandidate[] }
      errors.push(...scored.errors)
      cp.internal = { summary, prospects: [...scoredSoFar, ...scored.prospects.map(compactProspect)], runExternal, pending: scored.deadlined }
      params.onResult?.(buildPeopleScoutResult(cp, { runId, searchMode, complete: false, accepted: cp.accepted }))
      if (scored.deadlined.length > 0) {
        // The clock, not the model, stopped these: the leg hands back and the
        // next one scores exactly them. A "succeeded" run that silently
        // skipped two candidates would be the wrong answer.
        progress('internal-rank', `${cp.internal.prospects.length} scored, ${scored.deadlined.length} left for the next pass`)
        return closeOwnRow(stopAt({ stopped: shouldStop() ? 'cancelled' : 'deadline', stage: 'internal' }))
      }
      finishStage('internal')
    }

    // ─── The internal-first stop ───────────────────────────────────────────
    // This is the branch that saves the money. Nothing below here has run, so
    // no web search, no Apollo search, and no enrichment has been paid for.
    if (!cp.internal!.runExternal) return closeOwnRow(finish('complete'))

    // Everything the user already owns, loaded once per leg (cheap, and it
    // changes as the run persists contacts). Used to skip enrichment for people
    // we have already bought, and to label rediscoveries as such.
    const owned: OwnedIndex = await loadOwned(params.userId)
    if (owned.error) errors.push(`owned index: ${owned.error.slice(0, 100)}`)

    // ─── 2. Market Discovery — an adaptive session per segment ─────────────
    // Segments run CONCURRENTLY; rounds within a segment stay sequential,
    // because each round's action depends on the previous round's diagnosis.
    if (!done('discovery')) {
      const g = gate('discovery')
      if (g) return closeOwnRow(stopAt(g))
      const claimed = new Set(cp.discovered.map((x) => companyKey({ name: x.company.name, domain: x.company.domain } as CompanyCandidate)))
      const claimedNames = new Set(cp.discovered.map((x) => x.company.name))
      const pending = strategy.segments.filter((s) => !cp.discoverySegmentsDone.includes(s.name))
      let skipped = 0
      await mapWithConcurrency(pending, concurrency, async (segment) => {
        if (!itemGate(STAGE_MIN_MS.discovery)) {
          skipped++
          return
        }
        const session = await discovery(
          {
            segment,
            mission: { goal: params.mission.goal, geography: params.mission.geography },
            alreadyFound: Array.from(claimedNames),
            targetCount: params.companiesPerSegment,
            maxRounds: params.maxDiscoveryRounds ?? 3,
            onRound: (h) => progress('discovery', `${segment.name.slice(0, 40)} r${h.round}: "${h.query_used.slice(0, 50)}" → ${h.companies_kept} new, ${h.diagnosis} → ${h.action}`),
          },
          ctx
        )
        for (const run of session.agentResults) await trace(run as AgentResult<unknown>, { segment: segment.name })
        errors.push(...session.errors)
        // A session that ended on the clock is retried by the next leg, not recorded as done.
        const cutByClock = session.errors.some((e) => isClockOutcome({ error: e })) && session.companies.length === 0
        cp.discoveryHistory.push({ segment: segment.name, rounds: session.history, rejected: session.hypothesisRejected || session.needsNewHypothesis })
        for (const company of session.companies) {
          const key = companyKey({ name: company.name, domain: company.domain } as CompanyCandidate)
          if (claimed.has(key)) continue
          claimed.add(key)
          claimedNames.add(company.name)
          cp.discovered.push({ company, segmentName: segment.name })
        }
        if (session.hypothesisRejected) progress('discovery', `${segment.name}: hypothesis rejected by the agent (${session.finalDiagnosis})`)
        if (cutByClock) skipped++
        else cp.discoverySegmentsDone.push(segment.name)
        funnel.companiesDiscovered = cp.discovered.length
        checkpoint()
      })
      if (skipped > 0) return closeOwnRow(stopAt({ stopped: shouldStop() ? 'cancelled' : 'deadline', stage: 'discovery' }))
      funnel.companiesDiscovered = cp.discovered.length
      finishStage('discovery')
    }

    // ─── 3. Company Validation — the gate before any credit is spent ───────
    if (!done('validation')) {
      const g = gate('validation')
      if (g) return closeOwnRow(stopAt(g))
      const segmentByName = new Map(strategy.segments.map((s) => [s.name, s]))
      const pending = cp.discovered.filter((x) => !cp.validationDone.includes(x.company.name))
      let skipped = 0
      await mapWithConcurrency(pending, concurrency, async ({ company, segmentName }) => {
        if (!itemGate(STAGE_MIN_MS.validation)) {
          skipped++
          return
        }
        const segment = segmentByName.get(segmentName)
        const run = await validation(
          {
            company: { name: company.name, domain: company.domain, what_they_do: company.what_they_do },
            mission: { goal: params.mission.goal, geography: params.mission.geography },
            segment: { name: segmentName, required_domain_terms: segment?.required_domain_terms ?? [] },
          },
          ctx
        )
        const agentRunId = await trace(run as AgentResult<unknown>, { company: company.name })
        if (!run.output) {
          if (isClockOutcome(run)) {
            skipped++
            return
          }
          errors.push(`company_validation(${company.name}): ${run.error}`)
          funnel.companiesRejected++
          cp.rejections.push({ company: company.name, description: company.what_they_do, reason: `validation failed: ${run.error}` })
        } else {
          const gateResult = shouldEnrich(run.output)
          if (!gateResult.pass) {
            funnel.companiesRejected++
            cp.rejections.push({ company: company.name, description: run.output.what_they_do || company.what_they_do, reason: gateResult.reason })
          } else {
            cp.accepted.push({ company, segmentName, validation: run.output, agentRunId })
          }
        }
        cp.validationDone.push(company.name)
        funnel.companiesValidated = cp.accepted.length
        checkpoint()
      })
      if (skipped > 0) return closeOwnRow(stopAt({ stopped: shouldStop() ? 'cancelled' : 'deadline', stage: 'validation' }))
      funnel.companiesValidated = cp.accepted.length
      progress('validation', `${cp.accepted.length} accepted, ${funnel.companiesRejected} rejected`)

      // ─── 4. Persist companies + their grounded facts ───────────────────────
      const candidates = cp.accepted.map((a) => companyCandidateFrom(a.company, a.validation))
      const persisted = await persistCos(params.userId, candidates)
      if (persisted.migrationMissing) cp.persistence.migrationMissing = true
      errors.push(...persisted.errors.slice(0, 3))
      cp.persistence.companiesInserted += persisted.inserted
      for (const [k, v] of persisted.idByKey) cp.companyIdByKey[k] = v
      for (const a of cp.accepted) {
        const key = companyKey(companyCandidateFrom(a.company, a.validation))
        const facts = await persistFacts({ userId: params.userId, runId, companyId: cp.companyIdByKey[key] ?? null, subjectLabel: a.company.name, agentRunId: a.agentRunId, claims: a.validation.claims })
        if (facts.migrationMissing) cp.persistence.migrationMissing = true
        cp.persistence.factsInserted += facts.inserted
        cp.persistence.factsRejected += facts.rejected
      }
      finishStage('validation')
      if (cp.accepted.length === 0) {
        // Not empty-handed: whatever the existing network produced still stands.
        return closeOwnRow(finish('complete', 'no companies survived validation'))
      }
    }

    // ─── 5. People Scout (deterministic Apollo) ────────────────────────────
    const titlePatterns = normalizeTitlePatterns(strategy.segments.flatMap((s) => s.title_patterns), 20)
    const targets: ScoutTarget[] = cp.accepted.map((a) => ({
      company_name: a.company.name,
      // Research-confirmed domain beats the discovery guess.
      domain: a.validation.confirmed_domain ?? normalizeDomain(a.company.domain),
      company_ref: a.company.name,
      titles: a.validation.target_titles,
      archetype: a.validation.archetype,
    }))
    const missionLocations = params.mission.geography ? [params.mission.geography] : []
    const companyIdMap = new Map(Object.entries(cp.companyIdByKey))

    if (!done('people')) {
      const g = gate('people')
      if (g) return closeOwnRow(stopAt(g))
      const scouted = await scout({
        targets,
        titlePatterns,
        locations: missionLocations,
        maxPerCompany: params.budget.maxPeoplePerCompany,
        maxEnrich: params.maxProspects,
        concurrency,
        owned,
      })
      funnel.stubsFound = scouted.stubsFound
      funnel.peopleEnriched = scouted.people.length
      funnel.peopleReused = scouted.reuse.reused
      cp.apolloCallsAvoided += scouted.reuse.reused
      errors.push(...scouted.errors.slice(0, 3))
      progress('people', `${scouted.stubsFound} stubs → ${scouted.stubsKept} kept → ${scouted.people.length} resolved (${scouted.reuse.reused} reused from the database, ${scouted.creditsUsed} credits spent)`)
      if (scouted.stubsFound > 0 && scouted.stubsKept === 0) errors.push(`people filter rejected all ${scouted.stubsFound} stubs: ${JSON.stringify(scouted.filterStats.rejected)}`)
      const rows = scouted.people.slice(0, params.maxProspects)
      const persistedContacts = await persistPeople(params.userId, rows, companyIdMap)
      if (persistedContacts.migrationMissing) cp.persistence.migrationMissing = true
      errors.push(...persistedContacts.errors.slice(0, 3))
      cp.persistence.contactsInserted += persistedContacts.inserted
      for (const [k, v] of persistedContacts.idByKey) cp.contactIdByKey[k] = v
      cp.people = rows.map(toCheckpointPerson)
      cp.peopleStats = {
        stubsFound: scouted.stubsFound,
        stubsKept: scouted.stubsKept,
        reused: scouted.reuse.reused,
        creditsUsed: scouted.creditsUsed,
        filter: scouted.filterStats,
        candidatePool: scouted.candidatePool,
      }
      finishStage('people')
    }

    const validationByCompany = new Map(cp.accepted.map((a) => [a.company.name, a.validation]))
    const contactRows = cp.people

    // ─── 5b. Triage — the gate that makes deep research affordable ─────────
    if (!done('triage')) {
      const g = gate('triage')
      if (g) return closeOwnRow(stopAt(g))
      const pending = cp.accepted.filter((a) => !cp.triageDone.includes(a.company.name))
      let skipped = 0
      await mapWithConcurrency(pending, concurrency, async (a) => {
        if (!itemGate(STAGE_MIN_MS.triage)) {
          skipped++
          return
        }
        const atCompany = contactRows.filter((p) => p.company_ref === a.company.name)
        let picked: CheckpointPerson[] = []
        if (atCompany.length === 1) picked = atCompany
        else if (atCompany.length > 1) {
          const run = await triage(
            {
              company: { name: a.company.name, what_they_do: a.validation.what_they_do, archetype: a.validation.archetype, size_stage: a.validation.size_stage_context, relevance: a.validation.relevance_reasoning },
              mission: { goal: params.mission.goal, geography: params.mission.geography },
              backgroundSummary,
              candidates: atCompany.map((p) => ({ key: personKeyOf(p), name: p.name, title: p.title, seniority: p.seniority, department: p.department, location: p.location, email_status: p.email_status })),
              shortlistSize: researchPerCompany,
            },
            ctx
          )
          await trace(run as AgentResult<unknown>, { company: a.company.name })
          if (!run.output) {
            if (isClockOutcome(run)) {
              skipped++
              return
            }
            // Triage failing must not silently drop a company's people. Fall back
            // to the deterministic title ordering People Scout already applied.
            errors.push(`person_triage(${a.company.name}): ${run.error}`)
            picked = atCompany.slice(0, researchPerCompany)
          } else {
            const byKey = new Map(atCompany.map((p) => [personKeyOf(p), p]))
            picked = run.output.shortlist.map((k) => byKey.get(k)).filter((p): p is CheckpointPerson => Boolean(p)).slice(0, researchPerCompany)
            for (const s of run.output.scores) triageScores.set(s.key, s)
          }
        }
        for (const p of picked) if (!cp.toResearch.includes(personKeyOf(p))) cp.toResearch.push(personKeyOf(p))
        cp.triageDone.push(a.company.name)
        checkpoint()
      })
      if (skipped > 0) return closeOwnRow(stopAt({ stopped: shouldStop() ? 'cancelled' : 'deadline', stage: 'triage' }))
      cp.toResearch = cp.toResearch.slice(0, params.maxDeepResearch ?? 15)
      funnel.peopleTriaged = cp.toResearch.length
      progress('triage', `${contactRows.length} enriched → ${cp.toResearch.length} advanced to deep research (${contactRows.length - cp.toResearch.length} judged not worth researching)`)
      finishStage('triage')
    }

    const peopleByKey = new Map<string, CheckpointPerson>([...cp.people, ...cp.rescouted].map((p) => [personKeyOf(p), p]))

    // ─── 6. Person Research — shortlist only ───────────────────────────────
    const researchOne = async (person: CheckpointPerson, refs: Record<string, unknown>): Promise<'done' | 'skipped'> => {
      const validationRow = validationByCompany.get(person.company_ref)
      const companyContext = renderCompany(validationRow, person.company_name ?? 'unknown company')
      const key = personKeyOf(person)
      const prior = cp.research[key]
      const run = await research(
        {
          person: { name: person.name, title: person.title, company_name: person.company_name, linkedin_url: person.linkedin_url, location: person.location },
          companyContext,
          mission: { goal: params.mission.goal },
          backgroundSummary,
        },
        ctx
      )
      const agentRunId = await trace(run as AgentResult<unknown>, refs)
      if (run.output) {
        const contactId = cp.contactIdByKey[key] ?? null
        const facts = await persistFacts({ userId: params.userId, runId, contactId, subjectLabel: person.name, agentRunId, claims: run.output.claims })
        if (facts.migrationMissing) cp.persistence.migrationMissing = true
        cp.persistence.factsInserted += facts.inserted
        cp.persistence.factsRejected += facts.rejected
        cp.research[key] = { ok: true, personContext: renderPersonResearch(run.output), verdict: run.output.verdict, betterRole: run.output.better_role_hypothesis, companyContext, tries: (prior?.tries ?? 0) + 1 }
        funnel.peopleResearched++
        return 'done'
      }
      const timedOut = isClockOutcome(run)
      cp.research[key] = { ok: false, personContext: null, verdict: null, betterRole: null, companyContext, error: run.error, timedOut, tries: (prior?.tries ?? 0) + 1 }
      if (timedOut) return 'skipped'
      errors.push(`person_research(${person.name}): ${run.error}`)
      return 'done'
    }
    const needsResearch = (key: string): boolean => {
      const r = cp.research[key]
      if (!r) return true
      return !r.ok && r.timedOut === true && r.tries < RESEARCH_MAX_TRIES
    }

    if (!done('research')) {
      const g = gate('research')
      if (g) return closeOwnRow(stopAt(g))
      const pending = cp.toResearch.filter(needsResearch).map((k) => peopleByKey.get(k)).filter((p): p is CheckpointPerson => Boolean(p))
      let skipped = 0
      await mapWithConcurrency(pending, concurrency, async (person) => {
        if (!itemGate(STAGE_MIN_MS.research)) {
          skipped++
          return
        }
        const r = await researchOne(person, { person: person.name, company: person.company_ref })
        if (r === 'skipped') skipped++
        checkpoint()
      })
      if (skipped > 0 && cp.toResearch.some(needsResearch)) return closeOwnRow(stopAt({ stopped: shouldStop() ? 'cancelled' : 'deadline', stage: 'research' }))
      progress('research', `${funnel.peopleResearched}/${cp.toResearch.length} person dossiers`)
      finishStage('research')
      params.onResult?.(buildPeopleScoutResult(cp, { runId, searchMode, complete: false, accepted: cp.accepted }))
    }

    // ─── 6b. Re-scout ──────────────────────────────────────────────────────
    // When research says "right company, wrong person, look for THIS role
    // instead", act on it — bounded to a single extra pass.
    if (!done('rescout')) {
      const rounds = params.maxRescoutRounds ?? 1
      if (rounds > 0 && !cp.rescoutDone) {
        const g = gate('rescout')
        if (g) return closeOwnRow(stopAt(g))
        const requests = cp.toResearch.map((k) => ({ key: k, note: cp.research[k], person: peopleByKey.get(k) })).filter((x) => x.note?.verdict === 'SEARCH_FOR_DIFFERENT_PERSON' && x.note.betterRole && x.person)
        const byCompany = new Map<string, string>()
        for (const r of requests) if (!byCompany.has(r.person!.company_ref)) byCompany.set(r.person!.company_ref, r.note!.betterRole!)
        if (byCompany.size > 0) {
          const alreadyHave = new Set(contactRows.map((p) => personKeyOf(p).toLowerCase()))
          const rescoutTargets: ScoutTarget[] = []
          for (const [ref, role] of byCompany) {
            const original = targets.find((t) => t.company_ref === ref)
            if (original) rescoutTargets.push({ ...original, titles: [role] })
          }
          progress('rescout', `${rescoutTargets.length} companies: ${Array.from(byCompany.values()).join(', ')}`)
          const second = await scout({ targets: rescoutTargets, titlePatterns, locations: missionLocations, maxPerCompany: 1, maxEnrich: Math.min(rescoutTargets.length, params.maxProspects), concurrency, owned })
          errors.push(...second.errors.slice(0, 2))
          cp.apolloCallsAvoided += second.reuse.reused
          const fresh = second.people.filter((p) => !alreadyHave.has(personKeyOf(p).toLowerCase()))
          funnel.peopleEnriched += fresh.length
          if (fresh.length > 0) {
            const persistedRescout = await persistPeople(params.userId, fresh, companyIdMap)
            if (persistedRescout.migrationMissing) cp.persistence.migrationMissing = true
            errors.push(...persistedRescout.errors.slice(0, 3))
            cp.persistence.contactsInserted += persistedRescout.inserted
            for (const [k, v] of persistedRescout.idByKey) cp.contactIdByKey[k] = v
            cp.rescouted.push(...fresh.map(toCheckpointPerson))
            for (const p of fresh) {
              peopleByKey.set(personKeyOf(p), toCheckpointPerson(p))
              if (!cp.toResearch.includes(personKeyOf(p))) cp.toResearch.push(personKeyOf(p))
            }
          }
        }
        cp.rescoutDone = true
        checkpoint()
      }
      // Research the re-scouted people (a resumable loop like the main one).
      const pending = cp.rescouted.filter((p) => needsResearch(personKeyOf(p)))
      let skipped = 0
      await mapWithConcurrency(pending, concurrency, async (person) => {
        if (!itemGate(STAGE_MIN_MS.research)) {
          skipped++
          return
        }
        const r = await researchOne(person, { person: person.name, rescout: true })
        if (r === 'skipped') skipped++
        checkpoint()
      })
      if (skipped > 0 && cp.rescouted.some((p) => needsResearch(personKeyOf(p)))) return closeOwnRow(stopAt({ stopped: shouldStop() ? 'cancelled' : 'deadline', stage: 'rescout' }))
      if (cp.rescouted.length) progress('rescout', `${cp.rescouted.filter((p) => cp.research[personKeyOf(p)]?.ok).length} replacement dossiers`)
      finishStage('rescout')
    }

    // ─── 7. Ranking ────────────────────────────────────────────────────────
    // Drop the people research told us not to contact. Ranking exists to
    // order qualified prospects, not to rescue ones discovery got wrong.
    const qualifiedKeys = cp.toResearch.filter((k) => {
      const r = cp.research[k]
      return !r || !r.ok || (r.verdict !== 'REJECT' && r.verdict !== 'SEARCH_FOR_DIFFERENT_PERSON')
    })
    if (!done('rank')) {
      const g = gate('rank')
      if (g) return closeOwnRow(stopAt(g))
      const pending = qualifiedKeys.filter((k) => !cp.ranked[k]).map((k) => peopleByKey.get(k)).filter((p): p is CheckpointPerson => Boolean(p))
      let skipped = 0
      await mapWithConcurrency(pending, concurrency, async (person) => {
        if (!itemGate(STAGE_MIN_MS.rank)) {
          skipped++
          return
        }
        const key = personKeyOf(person)
        const note = cp.research[key]
        const personContext = note?.ok && note.personContext ? note.personContext : 'No person-level research was available. Judge on company context and title alone, and reflect that thinness in your scores.'
        const companyContext = note?.companyContext ?? renderCompany(validationByCompany.get(person.company_ref), person.company_name ?? 'unknown company')
        const run = await ranking(
          {
            candidate: { key, name: person.name, title: person.title, company_name: person.company_name, location: person.location, email_status: person.email_status },
            companyContext,
            personContext,
            mission: { goal: params.mission.goal, timeframe: params.mission.timeframe },
            positioningAngle: strategy.positioning_angle,
            backgroundItems: params.backgroundItems,
          },
          ctx
        )
        await trace(run as AgentResult<unknown>, { person: person.name })
        if (!run.output) {
          if (isClockOutcome(run)) {
            skipped++
            return
          }
          errors.push(`ranking(${person.name}): ${run.error}`)
          return
        }
        // Was this person already ours? External discovery finding someone we
        // already had is a MERGE, never a duplicate.
        const match = findOwned(owned, { apolloId: person.provenance.external_id ?? null, linkedinUrl: person.linkedin_url, email: person.email, name: person.name, company: person.company_name })
        const contactId = match.person?.contactId ?? cp.contactIdByKey[key] ?? null
        const source: ProspectSource = match.person ? 'existing_rediscovered' : 'new'
        cp.ranked[key] = compactProspect({
          ...run.output,
          person: person as PersonCandidate,
          company: person.company_name ?? person.company_ref,
          companyRef: person.company_ref,
          researchSummary: personContext,
          researchVerdict: note?.verdict ?? null,
          source,
          contactId,
          companyContext,
        })
        checkpoint()
        params.onResult?.(buildPeopleScoutResult(cp, { runId, searchMode, complete: false, accepted: cp.accepted }))
      })
      if (skipped > 0 && qualifiedKeys.some((k) => !cp.ranked[k])) return closeOwnRow(stopAt({ stopped: shouldStop() ? 'cancelled' : 'deadline', stage: 'rank' }))
      finishStage('rank')
    }

    const ranked = assembleRanked(cp)
    progress('ranking', `${ranked.length} prospects scored — ${ranked.filter((r) => r.source === 'new').length} new, ${ranked.filter((r) => r.source !== 'new').length} from the existing network`)
    return closeOwnRow(finish('complete'))
  } catch (e) {
    // A throw inside a stage is a failed LEG with everything so far kept. The
    // worker records the code; the CLI closes its own row.
    const message = e instanceof Error ? e.message : String(e)
    scoutLog({ event: 'leg_threw', error: message.slice(0, 300) }, 'error')
    return closeOwnRow(finish('failed', `unexpected error: ${message.slice(0, 300)}`))
  } finally {
    if (heartbeat) clearInterval(heartbeat)
  }
}

// ─── Assembling the answer ───────────────────────────────────────────────────

/** A prospect as the checkpoint stores it: the provider payload reduced to its id. */
function compactProspect(p: ScoutedProspect): ScoutedProspect {
  const rawId = (p.person.raw as { id?: unknown } | undefined)?.id
  return { ...p, person: { ...p.person, raw: rawId !== undefined ? { id: rawId } : {} } }
}

function emptyInternal(searchMode: SearchMode, internalTarget: number): InternalSummary {
  return {
    decision: {
      decision: searchMode === 'external_only' ? 'INTERNAL_SKIPPED' : 'EXTERNAL_DISCOVERY_NEEDED',
      runExternal: searchMode !== 'internal_only',
      strongCount: 0,
      usableCount: 0,
      targetCount: internalTarget,
      shortfall: internalTarget,
      reasons: ['The internal phase did not run.'],
      missingProfile: [],
    },
    poolAssessment: '',
    missingProfile: [],
    searchLog: [],
    indexed: 0,
    classified: 0,
    costUsd: 0,
  }
}

/**
 * MERGE internal and external, then order by score and de-clump by company.
 *
 * External discovery can surface someone the internal phase already
 * shortlisted; keeping both would put one human in the list twice. The
 * internal entry wins, because it carries the relationship history. Then the
 * best person at each company is placed first, and only then are the
 * remaining slots filled with runners-up — a list with three people from one
 * manufacturer reads as a database query, not as curated research.
 */
export function assembleRanked(cp: PeopleScoutCheckpoint): ScoutedProspect[] {
  const internal = cp.internal?.prospects ?? []
  const internalByContact = new Map(internal.filter((p) => p.contactId).map((p) => [p.contactId as string, p]))
  const deduped: ScoutedProspect[] = [...internal]
  for (const p of Object.values(cp.ranked)) {
    if (p.contactId && internalByContact.has(p.contactId)) {
      internalByContact.get(p.contactId)!.source = 'existing_rediscovered'
      continue
    }
    deduped.push(p)
  }
  const scored = deduped.sort((a, b) => b.total - a.total)
  const seenCompany = new Set<string>()
  const first: ScoutedProspect[] = []
  const rest: ScoutedProspect[] = []
  for (const r of scored) {
    const key = (r.company || 'unknown').toLowerCase()
    if (seenCompany.has(key)) rest.push(r)
    else {
      seenCompany.add(key)
      first.push(r)
    }
  }
  return [...first, ...rest]
}

/** The payload the Scout page renders — the SAME shape the synchronous API used to answer with. */
export function buildPeopleScoutResult(
  cp: PeopleScoutCheckpoint,
  opts: { runId: string | null; searchMode: string; complete: boolean; accepted: PeopleScoutCheckpoint['accepted'] }
): PeopleScoutResult {
  const ranked = assembleRanked(cp)
  const rankedKeys = new Set(Object.keys(cp.ranked))
  const internal = cp.internal?.summary ?? null
  const byRef = new Map(opts.accepted.map((a) => [a.company.name, a.validation.what_they_do]))
  const prospects: ProspectView[] = ranked.map((p) => ({
    key: p.candidate_key,
    name: p.person.name,
    title: p.person.title,
    company: p.company,
    location: p.person.location,
    email: p.person.email,
    emailStatus: p.person.email_status,
    linkedin: p.person.linkedin_url,
    score: p.total,
    recommendation: p.recommendation,
    source: p.source,
    contactId: p.contactId,
    relationshipStatus: p.relationshipStatus ?? null,
    approach: p.approach ?? null,
    internalReason: p.internalReason ?? null,
    whyCompany: byRef.get(p.companyRef) ?? p.companyContext ?? null,
    whyThem: p.why_they_fit,
    whyYou: p.why_i_fit_them,
    backgroundIds: p.resume_item_ids,
    risks: p.risks,
    researchSummary: p.researchSummary,
    components: p.components.map((c) => ({ dimension: c.dimension, normalized: c.normalized, points: Math.round(c.points), max: c.max, explanation: c.explanation })),
  }))
  // People the run paid to research but did not get to rank: shown, never discarded.
  const people = new Map<string, CheckpointPerson>([...cp.people, ...cp.rescouted].map((p) => [personKeyOf(p), p]))
  const unranked: UnrankedView[] = cp.toResearch
    .filter((k) => !rankedKeys.has(k))
    .map((k) => ({ key: k, person: people.get(k), note: cp.research[k] }))
    .filter((x) => x.person && x.note && (x.note.verdict === null || (x.note.verdict !== 'REJECT' && x.note.verdict !== 'SEARCH_FOR_DIFFERENT_PERSON')))
    .map((x) => ({
      key: x.key,
      name: x.person!.name,
      title: x.person!.title,
      company: x.person!.company_name ?? x.person!.company_ref,
      linkedin: x.person!.linkedin_url,
      email: x.person!.email,
      researchSummary: x.note!.personContext,
      verdict: x.note!.verdict,
      reason: x.note!.ok ? 'not_ranked' : 'research_failed',
    }))
  return {
    v: 1,
    runId: opts.runId,
    searchMode: opts.searchMode,
    backgroundSource: cp.background,
    internal: internal
      ? {
          headline: summarizeDecision(internal.decision),
          decision: internal.decision.decision,
          reasons: internal.decision.reasons,
          strongCount: internal.decision.strongCount,
          targetCount: internal.decision.targetCount,
          indexed: internal.indexed,
          classified: internal.classified,
          poolAssessment: internal.poolAssessment,
          missingProfile: internal.missingProfile,
          searches: internal.searchLog.map((s) => ({ query: s.query, matches: s.totalMatches, shown: s.returned })),
        }
      : null,
    funnel: { ...cp.funnel, prospectsRanked: ranked.length },
    prospects,
    unranked,
    usage: {
      costUsd: Number(cp.usage.costUsd.toFixed(2)),
      apolloCredits: cp.usage.apolloCredits,
      apolloCallsAvoided: cp.apolloCallsAvoided,
      webSearches: cp.usage.webSearches,
      modelCalls: cp.usage.calls,
      latencyMs: cp.usage.latencyMs,
      byAgent: cp.costByAgent,
    },
    errors: cp.errors.slice(-20),
    stages: [...cp.stages],
    complete: opts.complete,
    updated_at: new Date().toISOString(),
  }
}
