// The orchestrator.
//
// Agents are pure with respect to the database; this file is where inputs get
// loaded and outputs get persisted. It owns the stage ordering, the budget, and
// the funnel accounting.
//
// STAGE ORDER IS A COST DECISION (ADR-014):
//
//   strategy → discovery → VALIDATION → people search → enrichment → research → rank
//                          ^^^^^^^^^^                   ^^^^^^^^^^
//                          free (web)                   costs credits
//
// Validating companies before touching Apollo is what keeps a bad segment from
// spending the credit budget. Phase 6 measured 40% of discovered companies
// rejected at that gate.

import { runMissionStrategist, type MissionStrategy } from '@/lib/agents/mission-strategist'
import {
  runDiscoverySession,
  type DiscoveredCompany,
  type DiscoveryRoundHistory,
} from '@/lib/agents/market-discovery'
import { runCompanyValidation, shouldEnrich, type CompanyValidation } from '@/lib/agents/company-validation'
import { runPersonResearch, renderPersonResearch, type PersonResearch } from '@/lib/agents/person-research'
import { runRanking, type RankedProspect } from '@/lib/agents/ranking'
import {
  recordAgentRun,
  persistResearchFacts,
  startScoutingRun,
  updateScoutingRun,
} from '@/lib/agents/runtime/persist'
import type { RunBudget, ToolContext } from '@/lib/agents/runtime/types'
import { scoutPeople, type ScoutTarget } from './people-scout'
import { persistCompanies, persistContacts } from './persist'
import { mapWithConcurrency } from './concurrency'
import { companyKey } from './dedupe'
import { normalizeTitlePatterns } from './titles'
import { anthropicUsage, resetAnthropicUsage } from '@/lib/providers/anthropic/client'
import { apolloStats, resetApolloStats } from '@/lib/providers/apollo/client'
import { normalizeDomain } from '@/lib/providers/apollo/normalize'
import type { CompanyCandidate, PersonCandidate } from '@/lib/providers/types'

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
  concurrency?: number
  /** Log a line per stage. The smoke test wants to watch it work. */
  onProgress?: (stage: string, detail: string) => void
}

export interface FunnelCounts {
  segments: number
  companiesDiscovered: number
  companiesValidated: number
  companiesRejected: number
  stubsFound: number
  peopleEnriched: number
  peopleResearched: number
  prospectsRanked: number
}

export interface ScoutRunResult {
  runId: string | null
  strategy: MissionStrategy | null
  ranked: (RankedProspect & {
    person: PersonCandidate
    company: string
    /** Person-research dossier as text. What the eval judge is allowed to see. */
    researchSummary: string
    researchVerdict: string | null
  })[]
  funnel: FunnelCounts
  usage: {
    anthropic: ReturnType<typeof anthropicUsage>
    apollo: ReturnType<typeof apolloStats>
    costUsd: number
    costPerRankedProspect: number
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

export async function runScouting(params: ScoutRunParams): Promise<ScoutRunResult> {
  const log = params.onProgress ?? (() => {})
  const errors: string[] = []
  const rejections: { company: string; description: string; reason: string }[] = []
  const discoveryHistory: { segment: string; rounds: DiscoveryRoundHistory[]; rejected: boolean }[] = []
  const concurrency = params.concurrency ?? 3

  resetAnthropicUsage()
  resetApolloStats()

  let migrationMissing = false
  let agentRunsRecorded = 0
  let factsInserted = 0
  let factsRejected = 0

  const funnel: FunnelCounts = {
    segments: 0,
    companiesDiscovered: 0,
    companiesValidated: 0,
    companiesRejected: 0,
    stubsFound: 0,
    peopleEnriched: 0,
    peopleResearched: 0,
    prospectsRanked: 0,
  }

  // ─── Run row ───────────────────────────────────────────────────────────────
  const started = await startScoutingRun({
    userId: params.userId,
    label: params.label,
    mission: params.mission,
    budget: params.budget,
  })
  if (started.migrationMissing) migrationMissing = true
  if (started.error) errors.push(`scouting_runs: ${started.error.slice(0, 120)}`)
  const runId = started.runId

  const ctx: ToolContext = { user_id: params.userId, run_id: runId, budget: params.budget }

  const trace = async (result: Parameters<typeof recordAgentRun>[2], refs: Record<string, unknown>) => {
    const rec = await recordAgentRun(params.userId, runId, result, { inputRefs: refs })
    if (rec.migrationMissing) migrationMissing = true
    else if (rec.error) errors.push(`agent_runs: ${rec.error.slice(0, 100)}`)
    else agentRunsRecorded++
    return rec.agentRunId
  }

  const backgroundSummary = params.backgroundItems
    .map((b) => `  [${b.id}] ${b.summary}`)
    .join('\n')

  // ─── 1. Mission Strategist ─────────────────────────────────────────────────
  log('strategy', 'interpreting mission')
  const strategyRun = await runMissionStrategist(
    { mission: params.mission, backgroundSummary, segmentCount: params.segmentCount },
    ctx
  )
  await trace(strategyRun, { mission: params.label })

  if (!strategyRun.output) {
    if (runId) await updateScoutingRun(runId, { status: 'failed', error: strategyRun.error, completed: true })
    return {
      runId,
      strategy: null,
      ranked: [],
      funnel,
      usage: usageSnapshot(0),
      persistence: { migrationMissing, companiesInserted: 0, contactsInserted: 0, agentRunsRecorded, factsInserted, factsRejected },
      rejections,
      enrichedCompanies: [],
      candidatePool: {},
      discoveryHistory,
      peopleFilter: null,
      errors: [...errors, `mission_strategist failed: ${strategyRun.error}`],
    }
  }

  const strategy = strategyRun.output
  funnel.segments = strategy.segments.length
  log('strategy', `${strategy.segments.length} segments: ${strategy.segments.map((s) => s.name).join(' | ')}`)
  if (runId) await updateScoutingRun(runId, { strategy })

  // ─── 2. Market Discovery — an adaptive session per segment ─────────────────
  // Sequential so each segment can be told what earlier ones already claimed —
  // cross-segment duplicates were a measured problem in Phase 3.
  const discovered: { company: DiscoveredCompany; segment: MissionStrategy['segments'][number] }[] = []
  const claimed = new Set<string>()
  const claimedNames = new Set<string>()

  // Segments run CONCURRENTLY. Rounds within a segment stay sequential, because
  // each round's action depends on the previous round's diagnosis — that is the
  // adaptation. Segments do not depend on each other, and serializing them made
  // discovery the longest phase in the run by a wide margin.
  //
  // The cost is that a segment cannot see what its siblings just claimed, so
  // cross-segment duplicates are possible. The companyKey dedupe below removes
  // them, and one-person-per-company de-clumping removes the rest downstream.
  const sessions = await mapWithConcurrency(strategy.segments, concurrency, async (segment) =>
    runDiscoverySession(
      {
        segment,
        mission: { goal: params.mission.goal, geography: params.mission.geography },
        alreadyFound: Array.from(claimedNames),
        targetCount: params.companiesPerSegment,
        maxRounds: params.maxDiscoveryRounds ?? 3,
        onRound: (h) =>
          log(
            'discovery',
            `${segment.name.slice(0, 40)} r${h.round}: "${h.query_used.slice(0, 50)}" → ${h.companies_kept} new, ${h.diagnosis} → ${h.action}`
          ),
      },
      ctx
    ).then((session) => ({ segment, session }))
  )

  for (const { segment, session } of sessions) {
    for (const run of session.agentResults) await trace(run, { segment: segment.name })
    errors.push(...session.errors)

    discoveryHistory.push({
      segment: segment.name,
      rounds: session.history,
      rejected: session.hypothesisRejected || session.needsNewHypothesis,
    })

    for (const company of session.companies) {
      const key = companyKey({ name: company.name, domain: company.domain } as CompanyCandidate)
      if (claimed.has(key)) continue
      claimed.add(key)
      claimedNames.add(company.name)
      discovered.push({ company, segment })
    }

    if (session.hypothesisRejected) {
      log('discovery', `${segment.name}: hypothesis rejected by the agent (${session.finalDiagnosis})`)
    }
  }

  funnel.companiesDiscovered = discovered.length

  // ─── 3. Company Validation — the gate before any credit is spent ───────────
  const validations = await mapWithConcurrency(discovered, concurrency, async ({ company, segment }) => {
    const run = await runCompanyValidation(
      {
        company: { name: company.name, domain: company.domain, what_they_do: company.what_they_do },
        mission: { goal: params.mission.goal, geography: params.mission.geography },
        segment: { name: segment.name, required_domain_terms: segment.required_domain_terms },
      },
      ctx
    )
    const agentRunId = await trace(run, { company: company.name })
    return { company, segment, validation: run.output, agentRunId, error: run.error }
  })

  const accepted: { company: DiscoveredCompany; validation: CompanyValidation; agentRunId: string | null }[] = []
  for (const v of validations) {
    if (!v.validation) {
      errors.push(`company_validation(${v.company.name}): ${v.error}`)
      funnel.companiesRejected++
      rejections.push({
        company: v.company.name,
        description: v.company.what_they_do,
        reason: `validation failed: ${v.error}`,
      })
      continue
    }
    const gate = shouldEnrich(v.validation)
    if (!gate.pass) {
      funnel.companiesRejected++
      rejections.push({
        company: v.company.name,
        // What discovery believed, so the rejection can be judged on the company
        // rather than only on the sentence used to dismiss it.
        description: v.validation.what_they_do || v.company.what_they_do,
        reason: gate.reason,
      })
      continue
    }
    accepted.push({ company: v.company, validation: v.validation, agentRunId: v.agentRunId })
  }

  funnel.companiesValidated = accepted.length
  log('validation', `${accepted.length} accepted, ${funnel.companiesRejected} rejected`)

  // ─── 4. Persist companies + their grounded facts ───────────────────────────
  const candidates = accepted.map((a) => companyCandidateFrom(a.company, a.validation))
  const persistedCompanies = await persistCompanies(params.userId, candidates)
  if (persistedCompanies.migrationMissing) migrationMissing = true
  errors.push(...persistedCompanies.errors.slice(0, 3))

  for (const a of accepted) {
    const key = companyKey(companyCandidateFrom(a.company, a.validation))
    const companyId = persistedCompanies.idByKey.get(key) ?? null
    const facts = await persistResearchFacts({
      userId: params.userId,
      runId,
      companyId,
      subjectLabel: a.company.name,
      agentRunId: a.agentRunId,
      claims: a.validation.claims,
    })
    if (facts.migrationMissing) migrationMissing = true
    factsInserted += facts.inserted
    factsRejected += facts.rejected
  }

  if (accepted.length === 0) {
    if (runId) await updateScoutingRun(runId, { status: 'succeeded', stats: { funnel }, completed: true })
    return {
      runId,
      strategy,
      ranked: [],
      funnel,
      usage: usageSnapshot(0),
      persistence: {
        migrationMissing,
        companiesInserted: persistedCompanies.inserted,
        contactsInserted: 0,
        agentRunsRecorded,
        factsInserted,
        factsRejected,
      },
      rejections,
      enrichedCompanies: [],
      candidatePool: {},
      discoveryHistory,
      peopleFilter: null,
      errors: [...errors, 'no companies survived validation'],
    }
  }

  // ─── 5. People Scout (deterministic Apollo) ────────────────────────────────
  // Segment-level titles are the fallback; per-company researched titles win.
  const titlePatterns = normalizeTitlePatterns(strategy.segments.flatMap((s) => s.title_patterns), 20)
  const targets: ScoutTarget[] = accepted.map((a) => ({
    company_name: a.company.name,
    // Research-confirmed domain beats the discovery guess: it is what stops a
    // name-scoped Apollo query resolving to a different company entirely.
    domain: a.validation.confirmed_domain ?? normalizeDomain(a.company.domain),
    company_ref: a.company.name,
    titles: a.validation.target_titles,
  }))

  const scouted = await scoutPeople({
    targets,
    titlePatterns,
    maxPerCompany: params.budget.maxPeoplePerCompany,
    maxEnrich: params.maxProspects,
    concurrency,
  })
  funnel.stubsFound = scouted.stubsFound
  funnel.peopleEnriched = scouted.people.length
  errors.push(...scouted.errors.slice(0, 3))
  const peopleFilter = scouted.filterStats
  log('people', `${scouted.stubsFound} stubs → ${scouted.stubsKept} kept → ${scouted.people.length} enriched (${scouted.creditsUsed} credits)`)
  if (scouted.stubsFound > 0 && scouted.stubsKept === 0) {
    errors.push(
      `people filter rejected all ${scouted.stubsFound} stubs: ${JSON.stringify(peopleFilter.rejected)}`
    )
  }

  const validationByCompany = new Map(accepted.map((a) => [a.company.name, a.validation]))
  const contactRows = scouted.people.slice(0, params.maxProspects)

  const persistedContacts = await persistContacts(
    params.userId,
    contactRows,
    persistedCompanies.idByKey
  )
  if (persistedContacts.migrationMissing) migrationMissing = true
  errors.push(...persistedContacts.errors.slice(0, 3))

  // ─── 6. Person Research ────────────────────────────────────────────────────
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

  const researched = await mapWithConcurrency(contactRows, concurrency, async (person) => {
    const validation = validationByCompany.get(person.company_ref)
    const companyContext = renderCompany(validation, person.company_name ?? 'unknown company')

    const run = await runPersonResearch(
      {
        person: {
          name: person.name,
          title: person.title,
          company_name: person.company_name,
          linkedin_url: person.linkedin_url,
          location: person.location,
        },
        companyContext,
        mission: { goal: params.mission.goal },
        backgroundSummary,
      },
      ctx
    )
    const agentRunId = await trace(run, { person: person.name, company: person.company_ref })

    if (run.output) {
      const contactId = persistedContacts.idByKey.get(person.linkedin_url ?? person.email ?? person.name) ?? null
      const facts = await persistResearchFacts({
        userId: params.userId,
        runId,
        contactId,
        subjectLabel: person.name,
        agentRunId,
        claims: run.output.claims,
      })
      if (facts.migrationMissing) migrationMissing = true
      factsInserted += facts.inserted
      factsRejected += facts.rejected
    } else {
      errors.push(`person_research(${person.name}): ${run.error}`)
    }

    return { person, research: run.output, companyContext }
  })

  funnel.peopleResearched = researched.filter((r) => r.research).length
  log('research', `${funnel.peopleResearched}/${researched.length} person dossiers`)

  // ─── 6b. Re-scout ──────────────────────────────────────────────────────────
  // When research says "right company, wrong person, look for THIS role instead",
  // act on it. This is the one place a downstream agent feeds a hypothesis back
  // upstream, and it is bounded to a single extra pass: the point is to rescue a
  // good company from a bad entry point, not to search until something sticks.
  const rescoutRounds = params.maxRescoutRounds ?? 1
  const rescouted: typeof researched = []

  if (rescoutRounds > 0) {
    const requests = researched.filter(
      (r) => r.research?.verdict === 'SEARCH_FOR_DIFFERENT_PERSON' && r.research.better_role_hypothesis
    )

    // One request per company — several people at one company usually produce
    // the same suggestion, and acting on each would re-buy the same rows.
    const byCompany = new Map<string, { role: string; person: (typeof researched)[number] }>()
    for (const r of requests) {
      const ref = r.person.company_ref
      if (!byCompany.has(ref)) byCompany.set(ref, { role: r.research!.better_role_hypothesis!, person: r })
    }

    if (byCompany.size > 0) {
      const alreadyHave = new Set(contactRows.map((p) => (p.linkedin_url ?? p.email ?? p.name).toLowerCase()))
      const rescoutTargets: ScoutTarget[] = []
      for (const [ref, { role }] of byCompany) {
        const original = targets.find((t) => t.company_ref === ref)
        if (original) rescoutTargets.push({ ...original, titles: [role] })
      }

      log('rescout', `${rescoutTargets.length} companies: ${Array.from(byCompany.values()).map((v) => v.role).join(', ')}`)

      const second = await scoutPeople({
        targets: rescoutTargets,
        titlePatterns,
        maxPerCompany: 1,
        maxEnrich: Math.min(rescoutTargets.length, params.maxProspects),
        concurrency,
      })
      errors.push(...second.errors.slice(0, 2))

      const fresh = second.people.filter(
        (p) => !alreadyHave.has((p.linkedin_url ?? p.email ?? p.name).toLowerCase())
      )
      funnel.peopleEnriched += fresh.length

      if (fresh.length > 0) {
        const persistedRescout = await persistContacts(params.userId, fresh, persistedCompanies.idByKey)
        for (const [k, v] of persistedRescout.idByKey) persistedContacts.idByKey.set(k, v)

        const extra = await mapWithConcurrency(fresh, concurrency, async (person) => {
          const validation = validationByCompany.get(person.company_ref)
          const companyContext = renderCompany(validation, person.company_name ?? 'unknown company')
          const run = await runPersonResearch(
            {
              person: {
                name: person.name,
                title: person.title,
                company_name: person.company_name,
                linkedin_url: person.linkedin_url,
                location: person.location,
              },
              companyContext,
              mission: { goal: params.mission.goal },
              backgroundSummary,
            },
            ctx
          )
          const agentRunId = await trace(run, { person: person.name, rescout: true })
          if (run.output) {
            const contactId = persistedContacts.idByKey.get(person.linkedin_url ?? person.email ?? person.name) ?? null
            const facts = await persistResearchFacts({
              userId: params.userId,
              runId,
              contactId,
              subjectLabel: person.name,
              agentRunId,
              claims: run.output.claims,
            })
            factsInserted += facts.inserted
            factsRejected += facts.rejected
          }
          return { person, research: run.output, companyContext }
        })

        rescouted.push(...extra)
        funnel.peopleResearched += extra.filter((r) => r.research).length
        log('rescout', `${extra.filter((r) => r.research).length} replacement dossiers`)
      }
    }
  }

  // Drop the people research told us not to contact. Ranking exists to order
  // qualified prospects, not to rescue ones discovery got wrong.
  const qualified = [...researched, ...rescouted].filter(
    (r) => !r.research || (r.research.verdict !== 'REJECT' && r.research.verdict !== 'SEARCH_FOR_DIFFERENT_PERSON')
  )
  const disqualified = researched.length + rescouted.length - qualified.length
  if (disqualified > 0) log('research', `${disqualified} dropped by person-level verdict`)

  // ─── 7. Ranking ────────────────────────────────────────────────────────────
  const rankedResults = await mapWithConcurrency(qualified, concurrency, async (r) => {
    const personContext = r.research
      ? renderPersonResearch(r.research)
      : 'No person-level research was available. Judge on company context and title alone, and reflect that thinness in your scores.'

    const run = await runRanking(
      {
        candidate: {
          key: r.person.linkedin_url ?? r.person.email ?? r.person.name,
          name: r.person.name,
          title: r.person.title,
          company_name: r.person.company_name,
          location: r.person.location,
          email_status: r.person.email_status,
        },
        companyContext: r.companyContext,
        personContext,
        mission: { goal: params.mission.goal, timeframe: params.mission.timeframe },
        positioningAngle: strategy.positioning_angle,
        backgroundItems: params.backgroundItems,
      },
      ctx
    )
    await trace(run, { person: r.person.name })

    if (!run.output) {
      errors.push(`ranking(${r.person.name}): ${run.error}`)
      return null
    }
    return {
      ...run.output,
      person: r.person as PersonCandidate,
      company: r.person.company_name ?? r.person.company_ref,
      // Carried so the eval judge can see the RESEARCH rather than the ranking
      // agent's own justification. Showing the judge the scorer's prose would
      // make Precision@20 measure self-consistency instead of quality.
      researchSummary: personContext,
      researchVerdict: r.research?.verdict ?? null,
    }
  })

  // Order by score, then de-clump by company.
  //
  // A list with three people from one manufacturer does not read as curated
  // research; it reads as a database query. Phase 3 measured 7 of 100 slots
  // going to a second person at a company already represented. So the best
  // person at each company is placed first, and only then are the remaining
  // slots filled with runners-up — which costs a little total score and buys a
  // lot of the "a human spent hours on this" quality the north star asks for.
  const scored = rankedResults
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => b.total - a.total)

  const seenCompany = new Set<string>()
  const firstPerCompany: typeof scored = []
  const runnersUp: typeof scored = []
  for (const r of scored) {
    const key = (r.company || 'unknown').toLowerCase()
    if (seenCompany.has(key)) runnersUp.push(r)
    else {
      seenCompany.add(key)
      firstPerCompany.push(r)
    }
  }
  const ranked = [...firstPerCompany, ...runnersUp]

  funnel.prospectsRanked = ranked.length
  log('ranking', `${ranked.length} prospects scored`)

  const usage = usageSnapshot(ranked.length)

  if (runId) {
    await updateScoutingRun(runId, {
      status: 'succeeded',
      stats: { funnel, usage: { anthropic: usage.anthropic, apollo: usage.apollo, costUsd: usage.costUsd } },
      completed: true,
    })
  }

  return {
    runId,
    strategy,
    ranked,
    funnel,
    usage,
    persistence: {
      migrationMissing,
      companiesInserted: persistedCompanies.inserted,
      contactsInserted: persistedContacts.inserted,
      agentRunsRecorded,
      factsInserted,
      factsRejected,
    },
    rejections,
    enrichedCompanies: accepted.map((a) => ({
      name: a.company.name,
      description: a.validation.what_they_do,
      note: `${a.validation.verdict} — ${a.validation.relevance_reasoning}`,
    })),
    candidatePool: scouted.candidatePool,
    discoveryHistory,
    peopleFilter,
    errors,
  }
}

function usageSnapshot(rankedCount: number): ScoutRunResult['usage'] {
  const anthropic = anthropicUsage()
  const apollo = apolloStats()
  const costUsd = anthropic.costUsd
  return {
    anthropic,
    apollo,
    costUsd,
    costPerRankedProspect: rankedCount > 0 ? costUsd / rankedCount : 0,
  }
}
