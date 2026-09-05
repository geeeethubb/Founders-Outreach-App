// The internal-first phase.
//
// MISSION → STRATEGY → **EXISTING NETWORK RETRIEVAL → RANK → DECIDE** → external
//
// Extracted from the orchestrator rather than added to it: orchestrator.ts is
// already the longest file in the repo, and this phase has a genuinely separate
// contract — it answers "who do we already have, and is that enough?" and
// returns a decision the orchestrator acts on.
//
// It costs one agent call plus free SQL. That is the entire point: the cheapest
// possible answer to "do we need to spend money?" runs before anything spends.

import { runNetworkRetrieval, type SearchLogEntry } from '@/lib/agents/network-retrieval'
import { runRanking } from '@/lib/agents/ranking'
import type { AgentResult, ToolContext } from '@/lib/agents/runtime/types'
import { loadFacets, emptyFacets, type NetworkFacets } from '@/lib/network/facets'
import { loadRelationshipHistory } from '@/lib/network/relationship'
import { rankInternalCandidates, declumpByCompany, type RankedInternalCandidate } from '@/lib/network/rank'
import { decideSufficiency, type SearchMode, type SufficiencyDecision } from '@/lib/network/sufficiency'
import { persistNetworkMatches } from '@/lib/network/matches'
import { loadInternalContexts } from '@/lib/network/context'
import { mapWithConcurrency } from './concurrency'
import { currentRunClock } from '@/lib/runs/context'
import { isClockOutcome } from '@/lib/runs/errors'
import type { ScoutedProspect } from './prospect'

export interface InternalPhaseParams {
  userId: string
  runId: string | null
  mission: { goal: string; timeframe: string; geography: string; constraints: string[] }
  backgroundSummary: string
  /** Vocabulary hints from the Mission Strategist, when one has run. */
  strategyHints: string[]
  /** How many strong internal candidates would make external discovery unnecessary. */
  targetCount: number
  mode: SearchMode
  ctx: ToolContext
  maxSearches?: number
  onProgress?: (stage: string, detail: string) => void
  /** Records the agent run. Same signature the orchestrator already uses. */
  trace?: (result: AgentResult<unknown>, refs: Record<string, unknown>) => Promise<unknown>
}

export interface InternalPhaseResult {
  ranked: RankedInternalCandidate[]
  decision: SufficiencyDecision
  facets: NetworkFacets
  searchLog: SearchLogEntry[]
  missingProfile: string[]
  poolAssessment: string
  /** Contacts already surfaced internally, so external discovery can skip them. */
  contactIds: string[]
  costUsd: number
  errors: string[]
}

export async function runInternalPhase(params: InternalPhaseParams): Promise<InternalPhaseResult> {
  const log = params.onProgress ?? (() => {})
  const errors: string[] = []

  const empty = (decision: SufficiencyDecision, facets: NetworkFacets): InternalPhaseResult => ({
    ranked: [],
    decision,
    facets,
    searchLog: [],
    missingProfile: [],
    poolAssessment: '',
    contactIds: [],
    costUsd: 0,
    errors,
  })

  if (params.mode === 'external_only') {
    log('network', 'search mode is "new contacts only" — skipping the existing network')
    return empty(
      decideSufficiency({
        mode: params.mode,
        candidates: [],
        targetCount: params.targetCount,
        missingProfile: [],
        indexed: 0,
        classified: 0,
      }),
      emptyFacets()
    )
  }

  const facets = await loadFacets(params.userId)
  if (facets.error) errors.push(`network facets: ${facets.error.slice(0, 120)}`)

  if (facets.indexed === 0) {
    log('network', 'no contacts are indexed — run `npm run index:network` to use the existing network')
    errors.push('contact_index is empty: internal retrieval had nothing to search')
    return empty(
      decideSufficiency({
        mode: params.mode,
        candidates: [],
        targetCount: params.targetCount,
        missingProfile: [],
        indexed: 0,
        classified: 0,
      }),
      facets
    )
  }

  log('network', `searching ${facets.indexed} indexed contacts (${facets.classified} classified)`)

  const run = await runNetworkRetrieval(
    {
      mission: params.mission,
      backgroundSummary: params.backgroundSummary,
      pool: {
        indexed: facets.indexed,
        classified: facets.classified,
        seniorityBands: facets.seniorityBands,
        functionAreas: facets.functionAreas,
        regions: facets.regions,
        opportunityTypes: facets.opportunityTypes,
        topIndustries: facets.topIndustries,
      },
      targetCount: params.targetCount,
      // Shortlist wider than the target. Measured: asked for exactly 10, the
      // agent returned exactly 10 and the recall probe found ten more it had
      // surfaced, judged, and dropped. Ranking cannot order what it never sees.
      shortlistSize: Math.min(25, Math.max(12, params.targetCount * 2)),
      strategyHints: params.strategyHints,
    },
    params.ctx,
    { userId: params.userId, maxSearches: params.maxSearches ?? 8 }
  )

  if (params.trace) await params.trace(run.result as AgentResult<unknown>, { phase: 'internal_retrieval' })

  for (const entry of run.searchLog) {
    log('network', `"${entry.query.slice(0, 50)}" → ${entry.totalMatches} matches, ${entry.returned} shown`)
  }

  if (!run.result.output) {
    errors.push(`network_retrieval failed: ${run.result.error}`)
    // A failed retrieval must not silently become "the network is empty" — that
    // would make the run skip external discovery for the wrong reason. Treat it
    // as zero strong candidates, which forces external when the mode allows it.
    return {
      ...empty(
        decideSufficiency({
          mode: params.mode,
          candidates: [],
          targetCount: params.targetCount,
          missingProfile: [],
          indexed: facets.indexed,
          classified: facets.classified,
        }),
        facets
      ),
      searchLog: run.searchLog,
      costUsd: run.result.trace.cost_usd,
    }
  }

  const history = await loadRelationshipHistory(params.userId)
  errors.push(...history.degraded.slice(0, 2))

  const ranked = declumpByCompany(
    rankInternalCandidates(run.result.output.shortlist, run.seen, history.byContact)
  )
  // De-clumping reorders, so ranks are restamped rather than carried over.
  ranked.forEach((r, i) => {
    r.rank = i + 1
  })

  const decision = decideSufficiency({
    mode: params.mode,
    candidates: ranked.map((r) => ({ total: r.total, confidence: r.confidence })),
    targetCount: params.targetCount,
    missingProfile: run.result.output.missing_profile,
    indexed: facets.indexed,
    classified: facets.classified,
  })

  const shortlisted = new Set(ranked.slice(0, params.targetCount).map((r) => r.contact.contact_id))
  const persisted = await persistNetworkMatches({
    userId: params.userId,
    runId: params.runId,
    missionGoal: params.mission.goal,
    ranked,
    shortlisted,
    searchQueries: run.searchLog.map((s) => s.query),
  })
  if (persisted.migrationMissing) errors.push('migration 013 not applied: internal matches were not saved')
  else errors.push(...persisted.errors)

  log(
    'network',
    `${ranked.length} internal candidates, ${decision.strongCount} strong → ${decision.decision}`
  )

  return {
    ranked,
    decision,
    facets,
    searchLog: run.searchLog,
    missingProfile: run.result.output.missing_profile,
    poolAssessment: run.result.output.pool_assessment,
    contactIds: ranked.map((r) => r.contact.contact_id),
    costUsd: run.result.trace.cost_usd,
    errors,
  }
}

// ─── Scoring internal candidates on the external instrument ──────────────────

export interface ScoreInternalParams {
  userId: string
  /** Do not start a candidate the run's clock cannot fit; it is reported as `deadlined` for the next leg. */
  minAttemptMs?: number
  /** The run was asked to stop: remaining candidates are left for the next leg (or the cancel). */
  shouldStop?: () => boolean
  mission: { goal: string; timeframe: string }
  positioningAngle: string
  backgroundItems: { id: string; summary: string }[]
  candidates: RankedInternalCandidate[]
  ctx: ToolContext
  concurrency?: number
  trace?: (result: AgentResult<unknown>, refs: Record<string, unknown>) => Promise<unknown>
  onProgress?: (stage: string, detail: string) => void
}

/**
 * Put internal candidates through the SAME Ranking agent the external pipeline
 * uses, over their already-stored research.
 *
 * The alternative — carrying the retrieval agent's three components forward —
 * would put two incompatible score scales into one list. Ranking is on the
 * cheap tier with no web search (about a third of a cent per person), so
 * uniformity here costs less than the confusion of not having it.
 *
 * Everything it reads was paid for by an earlier run. This step spends model
 * tokens and zero Apollo credits.
 */
export async function scoreInternalProspects(params: ScoreInternalParams): Promise<{
  prospects: ScoutedProspect[]
  errors: string[]
  /** Candidates the run's clock (or a cancel) kept this leg from scoring. Not failures: the next leg's work. */
  deadlined: RankedInternalCandidate[]
}> {
  const errors: string[] = []
  const deadlined: RankedInternalCandidate[] = []
  if (params.candidates.length === 0) return { prospects: [], errors, deadlined }

  const log = params.onProgress ?? (() => {})
  const contexts = await loadInternalContexts(
    params.userId,
    params.candidates.map((c) => c.contact.contact_id)
  )

  const scored = await mapWithConcurrency(params.candidates, params.concurrency ?? 4, async (c) => {
    // A ranking call takes 10–40 s. One started with less than that left in
    // the run would be cut at the reserve and count for nothing — it belongs
    // to the next leg, which is what `deadlined` says.
    const clock = currentRunClock()
    if (params.shouldStop?.() || (clock && !clock.canStart(params.minAttemptMs ?? 0))) {
      deadlined.push(c)
      return null
    }
    const ctxRow = contexts.get(c.contact.contact_id)
    const companyContext = ctxRow?.companyContext ?? `WHAT THEY DO: ${c.contact.company ?? 'unknown company'}`
    const personContext =
      ctxRow?.personContext ??
      `SOURCE: already in your database.\nNo stored research beyond title and company.`

    const run = await runRanking(
      {
        candidate: {
          key: c.contact.contact_id,
          name: c.contact.name,
          title: c.contact.title,
          company_name: c.contact.company,
          location: c.contact.location,
          email_status: c.contact.email ? 'verified' : 'unavailable',
        },
        companyContext,
        // The retrieval agent's reasoning is appended as context, NOT as
        // evidence: it is an argument for surfacing this person, and ranking
        // must judge the research rather than the argument for showing it.
        personContext: `${personContext}\n\nWHY INTERNAL RETRIEVAL SURFACED THEM (an argument, not evidence): ${c.reason}`,
        mission: params.mission,
        positioningAngle: params.positioningAngle,
        backgroundItems: params.backgroundItems,
      },
      params.ctx
    )
    if (params.trace) await params.trace(run as AgentResult<unknown>, { internal_person: c.contact.name })

    if (!run.output) {
      // The clock's doing, not the model's: this candidate was never really judged.
      if (isClockOutcome(run)) {
        deadlined.push(c)
        return null
      }
      errors.push(`ranking(internal:${c.contact.name}): ${run.error}`)
      return null
    }

    const prospect: ScoutedProspect = {
      ...run.output,
      person: {
        name: c.contact.name,
        first_name: c.contact.name.split(/\s+/)[0] ?? null,
        last_name: c.contact.name.split(/\s+/).slice(-1)[0] ?? null,
        title: c.contact.title,
        seniority: c.contact.seniority_band,
        department: c.contact.function_area,
        email: c.contact.email,
        email_status: c.contact.email ? 'verified' : 'unavailable',
        linkedin_url: c.contact.linkedin_url,
        location: c.contact.location,
        company_name: c.contact.company,
        company_domain: null,
        raw: { source: 'contact_index', contact_id: c.contact.contact_id },
        provenance: {
          provider_id: 'database',
          query_ref: { internal_rank: c.rank },
          retrieved_at: new Date().toISOString(),
        },
      },
      company: c.contact.company ?? 'unknown company',
      companyRef: c.contact.company ?? 'unknown company',
      researchSummary: personContext,
      researchVerdict: null,
      source: 'existing' as const,
      contactId: c.contact.contact_id,
      companyContext,
      internalReason: c.reason,
      internalEvidence: c.evidence,
      relationshipStatus: c.relationship.status,
      approach: c.approach,
    }
    return prospect
  })

  const prospects = scored.filter((p): p is ScoutedProspect => p !== null)
  log('internal-rank', `${prospects.length}/${params.candidates.length} internal candidates scored${deadlined.length ? `, ${deadlined.length} left for the next pass` : ''}`)
  return { prospects, errors, deadlined }
}
