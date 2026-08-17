// The internal-retrieval eval.
//
// The question it answers: **can Outreach OS mine an existing network of ~900
// contacts for a new mission, without the founder sorting them by hand?**
//
// It measures the real pipeline: the real classifier over the real database,
// the real retrieval agent with real reformulation, the real ranking agent, and
// the real sufficiency decision. The one substitution is the full-text backend
// (see local-index.ts), which is disclosed in every report.
//
// Judging is done by evals/agentic/judge.ts — the SAME independent judge that
// produced Phase 7's Precision@20. Reusing it is deliberate: internal
// candidates are then measured on the identical instrument as externally
// discovered ones, so "is mining the network as good as buying strangers?" is a
// question the numbers can actually answer.

import { judgeProspects, isGood, type JudgeVerdict } from '@/evals/agentic/judge'
import { runNetworkRetrieval } from '@/lib/agents/network-retrieval'
import { runRanking } from '@/lib/agents/ranking'
import type { ToolContext } from '@/lib/agents/runtime/types'
import { anthropicUsage, resetAnthropicUsage } from '@/lib/providers/anthropic/client'
import { buildIndexRows, type IndexRow } from '@/lib/network/indexer'
import { loadRelationshipHistory, type RelationshipHistory } from '@/lib/network/relationship'
import { rankInternalCandidates, declumpByCompany } from '@/lib/network/rank'
import { decideSufficiency, type SufficiencyDecision } from '@/lib/network/sufficiency'
import { loadInternalContexts } from '@/lib/network/context'
import { mapWithConcurrency } from '@/lib/scouting/concurrency'
import { LocalNetworkIndex, type Identity } from './local-index'
import { NETWORK_EVAL_MISSIONS, type NetworkEvalMission } from './missions'

export interface MissionResult {
  mission: NetworkEvalMission
  /** Contacts in the index — the pool the agent could reach. */
  poolSize: number
  /** Distinct contacts any search surfaced. The cheap-retrieval survivors. */
  retrievalPool: number
  /** Searches the agent ran, with what each returned. */
  searches: { query: string; totalMatches: number; returned: number }[]
  shortlisted: number
  top20: {
    name: string
    title: string | null
    company: string | null
    score: number
    relationship: string
    verdict: JudgeVerdict | 'UNJUDGED'
    reasoning: string
  }[]
  precisionAt20: number
  badRateAt20: number
  verdictCounts: Record<string, number>
  /** GOOD people the search surfaced and the agent did NOT shortlist. */
  missed: { name: string; title: string | null; company: string | null; verdict: JudgeVerdict }[]
  decision: SufficiencyDecision
  missingProfile: string[]
  poolAssessment: string
  costUsd: number
  judgeCostUsd: number
  errors: string[]
}

export interface NetworkEvalResult {
  backend: 'postgres' | 'local'
  indexed: number
  classified: number
  indexCostUsd: number
  indexModelCalls: number
  missions: MissionResult[]
  totals: {
    precisionAt20: number
    badRateAt20: number
    apolloCreditsAvoided: number
    externalRunsAvoided: number
    retrievalCostUsd: number
    judgeCostUsd: number
  }
}

export interface RunNetworkEvalParams {
  userId: string
  backgroundItems: { id: string; summary: string }[]
  /** Apollo credits a full external run would have spent. Used for the savings figure. */
  creditsPerExternalRun?: number
  missions?: NetworkEvalMission[]
  /** Cap classification during a first exploratory pass. */
  maxClassify?: number
  concurrency?: number
  onProgress?: (message: string) => void
}

export async function runNetworkEval(params: RunNetworkEvalParams): Promise<NetworkEvalResult> {
  const log = params.onProgress ?? (() => {})
  const missions = params.missions ?? NETWORK_EVAL_MISSIONS
  const concurrency = params.concurrency ?? 4
  const creditsPerExternalRun = params.creditsPerExternalRun ?? 25

  // ─── 1. Build the index (real classifier, real contacts) ───
  resetAnthropicUsage()
  log('building the contact index…')
  const built = await buildIndexRows({
    userId: params.userId,
    maxClassify: params.maxClassify,
    onProgress: (m) => log(`  ${m}`),
  })
  const indexCostUsd = anthropicUsage().costUsd
  const indexModelCalls = anthropicUsage().calls
  log(
    `index: ${built.rows.length} rows, ${built.classified} newly classified, ` +
      `$${indexCostUsd.toFixed(4)}, ${indexModelCalls} calls`
  )

  const index = new LocalNetworkIndex(built.rows, built.identities as Map<string, Identity>)
  const classified = built.rows.filter((r) => r.classified_at || r.classifier_version).length
  const facets = summarizeFacets(built.rows)
  const history = await loadRelationshipHistory(params.userId)

  const backgroundSummary = params.backgroundItems.map((b) => `  [${b.id}] ${b.summary}`).join('\n')

  const results: MissionResult[] = []

  for (const mission of missions) {
    log(`\n─── ${mission.label} ───`)
    resetAnthropicUsage()

    const ctx: ToolContext = {
      user_id: params.userId,
      run_id: null,
      budget: { maxCompanies: 0, maxPeoplePerCompany: 0, maxApolloCalls: 0, maxWebSearches: 0, maxAgentSteps: 14 },
    }

    const run = await runNetworkRetrieval(
      {
        mission: {
          goal: mission.goal,
          timeframe: mission.timeframe,
          geography: mission.geography,
          constraints: mission.constraints,
        },
        backgroundSummary,
        pool: {
          indexed: built.rows.length,
          classified,
          seniorityBands: facets.seniority,
          functionAreas: facets.functions,
          regions: facets.regions,
          opportunityTypes: facets.opportunities,
          topIndustries: facets.industries,
        },
        targetCount: mission.targetCount,
        shortlistSize: Math.min(25, Math.max(12, mission.targetCount * 2)),
        strategyHints: [],
      },
      ctx,
      {
        userId: params.userId,
        maxSearches: 6,
        search: index.search,
        onSearch: (e) =>
          log(`    search "${e.query.slice(0, 52)}" → ${e.totalMatches} above floor, ${e.returned} shown`),
        onStep: (s) =>
          log(
            `    step ${s.step} — ${Math.round(s.elapsedMs / 1000)}s, ${s.stopReason ?? '?'}` +
              (s.toolCalls.length ? `, called ${s.toolCalls.join('+')}` : '')
          ),
      }
    )

    const errors: string[] = []
    if (!run.result.output) {
      errors.push(`retrieval failed: ${run.result.error}`)
      results.push(emptyMissionResult(mission, built.rows.length, run, errors))
      continue
    }

    const ranked = declumpByCompany(
      rankInternalCandidates(run.result.output.shortlist, run.seen, history.byContact)
    )
    ranked.forEach((r, i) => {
      r.rank = i + 1
    })

    const decision = decideSufficiency({
      mode: 'internal_first',
      candidates: ranked.map((r) => ({ total: r.total, confidence: r.confidence })),
      targetCount: mission.targetCount,
      missingProfile: run.result.output.missing_profile,
      indexed: built.rows.length,
      classified,
    })

    // ─── Score the top slice on the production instrument ───
    const top = ranked.slice(0, 20)
    const contexts = await loadInternalContexts(params.userId, top.map((r) => r.contact.contact_id))

    const scored = await mapWithConcurrency(top, concurrency, async (c) => {
      const ctxRow = contexts.get(c.contact.contact_id)
      const personContext = ctxRow?.personContext ?? 'No stored research beyond title and company.'
      const companyContext = ctxRow?.companyContext ?? `WHAT THEY DO: ${c.contact.company ?? 'unknown'}`
      const r = await runRanking(
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
          personContext,
          mission: { goal: mission.goal, timeframe: mission.timeframe },
          positioningAngle: '',
          backgroundItems: params.backgroundItems,
        },
        ctx
      )
      return { candidate: c, total: r.output?.total ?? Math.round(c.total * 100), personContext, companyContext }
    })

    // ─── Judge ───
    // The judge sees the RESEARCH, never the retrieval agent's reasoning or its
    // scores. Showing it either would make precision measure self-consistency.
    const judged = await judgeProspects(
      mission.goal,
      backgroundSummary,
      scored.map((s) => ({
        candidate_id: s.candidate.contact.contact_id,
        name: s.candidate.contact.name,
        title: s.candidate.contact.title,
        company: s.candidate.contact.company ?? 'unknown',
        company_description: s.companyContext.slice(0, 900),
        person_summary: s.personContext.slice(0, 1400),
        location: s.candidate.contact.location,
      }))
    )
    if (judged.error) errors.push(`judge: ${judged.error}`)
    const verdictById = new Map(judged.results.map((j) => [j.candidate_id, j]))

    const top20 = scored.map((s) => {
      const j = verdictById.get(s.candidate.contact.contact_id)
      return {
        name: s.candidate.contact.name,
        title: s.candidate.contact.title,
        company: s.candidate.contact.company,
        score: s.total,
        relationship: s.candidate.relationship.status,
        verdict: (j?.verdict ?? 'UNJUDGED') as JudgeVerdict | 'UNJUDGED',
        reasoning: j?.reasoning ?? '',
      }
    })

    const verdictCounts: Record<string, number> = {}
    for (const t of top20) verdictCounts[t.verdict] = (verdictCounts[t.verdict] ?? 0) + 1
    const judgedCount = top20.filter((t) => t.verdict !== 'UNJUDGED').length
    const goodCount = top20.filter((t) => t.verdict !== 'UNJUDGED' && isGood(t.verdict as JudgeVerdict)).length
    const badCount = top20.filter((t) => t.verdict === 'BAD').length

    // ─── Recall probe: did retrieval surface good people and then drop them? ───
    const shortlistedIds = new Set(ranked.map((r) => r.contact.contact_id))
    const notShortlisted = Array.from(run.seen.values())
      .filter((c) => !shortlistedIds.has(c.contact_id))
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 12)

    let missed: MissionResult['missed'] = []
    // The recall probe is eval instrumentation, not part of the product path.
    // Charging it to `retrieval cost` overstated the real per-mission figure by
    // most of a dollar in the first run.
    let probeCostUsd = 0
    if (notShortlisted.length > 0) {
      const missedContexts = await loadInternalContexts(params.userId, notShortlisted.map((c) => c.contact_id))
      const missedJudged = await judgeProspects(
        mission.goal,
        backgroundSummary,
        notShortlisted.map((c) => ({
          candidate_id: c.contact_id,
          name: c.name,
          title: c.title,
          company: c.company ?? 'unknown',
          company_description: missedContexts.get(c.contact_id)?.companyContext.slice(0, 900) ?? '',
          person_summary: missedContexts.get(c.contact_id)?.personContext.slice(0, 1400) ?? c.summary ?? '',
          location: c.location,
        }))
      )
      probeCostUsd = missedJudged.costUsd
      const byId = new Map(notShortlisted.map((c) => [c.contact_id, c]))
      missed = missedJudged.results
        .filter((j) => isGood(j.verdict))
        .map((j) => {
          const c = byId.get(j.candidate_id)!
          return { name: c.name, title: c.title, company: c.company, verdict: j.verdict }
        })
    }

    const usage = anthropicUsage()
    results.push({
      mission,
      poolSize: built.rows.length,
      retrievalPool: run.seen.size,
      searches: run.searchLog.map((s) => ({ query: s.query, totalMatches: s.totalMatches, returned: s.returned })),
      shortlisted: ranked.length,
      top20,
      precisionAt20: judgedCount > 0 ? goodCount / judgedCount : 0,
      badRateAt20: judgedCount > 0 ? badCount / judgedCount : 0,
      verdictCounts,
      missed,
      decision,
      missingProfile: run.result.output.missing_profile,
      poolAssessment: run.result.output.pool_assessment,
      // Product-path cost only: retrieval agent + ranking. Judging and the
      // recall probe are the eval measuring itself.
      costUsd: Math.max(0, usage.costUsd - judged.costUsd - probeCostUsd),
      judgeCostUsd: judged.costUsd + probeCostUsd,
      errors,
    })

    log(
      `  ${ranked.length} shortlisted · P@20 ${(results[results.length - 1].precisionAt20 * 100).toFixed(0)}% · ` +
        `${decision.decision} · $${(usage.costUsd - judged.costUsd).toFixed(3)}`
    )
  }

  const judgedMissions = results.filter((r) => r.top20.length > 0)
  const avg = (pick: (r: MissionResult) => number) =>
    judgedMissions.length ? judgedMissions.reduce((s, r) => s + pick(r), 0) / judgedMissions.length : 0

  const externalAvoided = results.filter((r) => r.decision.decision === 'INTERNAL_SUFFICIENT').length

  return {
    backend: 'local',
    indexed: built.rows.length,
    classified,
    indexCostUsd,
    indexModelCalls,
    missions: results,
    totals: {
      precisionAt20: avg((r) => r.precisionAt20),
      badRateAt20: avg((r) => r.badRateAt20),
      apolloCreditsAvoided: externalAvoided * creditsPerExternalRun,
      externalRunsAvoided: externalAvoided,
      retrievalCostUsd: results.reduce((s, r) => s + r.costUsd, 0),
      judgeCostUsd: results.reduce((s, r) => s + r.judgeCostUsd, 0),
    },
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function summarizeFacets(rows: IndexRow[]) {
  const count = (pick: (r: IndexRow) => string | string[] | null) => {
    const m = new Map<string, number>()
    for (const r of rows) {
      const v = pick(r)
      const list = Array.isArray(v) ? v : v ? [v] : []
      for (const item of list) {
        if (!item || item === 'unknown') continue
        m.set(item, (m.get(item) ?? 0) + 1)
      }
    }
    return Array.from(m.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 14)
      .map(([k, n]) => `${k} (${n})`)
  }
  return {
    seniority: count((r) => r.seniority_band),
    functions: count((r) => r.function_area),
    regions: count((r) => r.geo_region),
    opportunities: count((r) => r.opportunity_types),
    industries: count((r) => r.industry),
  }
}

function emptyMissionResult(
  mission: NetworkEvalMission,
  poolSize: number,
  run: { seen: Map<string, unknown>; searchLog: { query: string; totalMatches: number; returned: number }[]; result: { trace: { cost_usd: number } } },
  errors: string[]
): MissionResult {
  return {
    mission,
    poolSize,
    retrievalPool: run.seen.size,
    searches: run.searchLog.map((s) => ({ query: s.query, totalMatches: s.totalMatches, returned: s.returned })),
    shortlisted: 0,
    top20: [],
    precisionAt20: 0,
    badRateAt20: 0,
    verdictCounts: {},
    missed: [],
    decision: {
      decision: 'EXTERNAL_DISCOVERY_NEEDED',
      runExternal: true,
      strongCount: 0,
      usableCount: 0,
      targetCount: mission.targetCount,
      shortfall: mission.targetCount,
      reasons: ['retrieval failed'],
      missingProfile: [],
    },
    missingProfile: [],
    poolAssessment: '',
    costUsd: run.result.trace.cost_usd,
    judgeCostUsd: 0,
    errors,
  }
}

export type { RelationshipHistory }
