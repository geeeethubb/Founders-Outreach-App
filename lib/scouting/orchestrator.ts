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
import { runMarketDiscovery, type DiscoveredCompany } from '@/lib/agents/market-discovery'
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
  ranked: (RankedProspect & { person: PersonCandidate; company: string })[]
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
  rejections: { company: string; reason: string }[]
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
  const rejections: { company: string; reason: string }[] = []
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
      peopleFilter: null,
      errors: [...errors, `mission_strategist failed: ${strategyRun.error}`],
    }
  }

  const strategy = strategyRun.output
  funnel.segments = strategy.segments.length
  log('strategy', `${strategy.segments.length} segments: ${strategy.segments.map((s) => s.name).join(' | ')}`)
  if (runId) await updateScoutingRun(runId, { strategy })

  // ─── 2. Market Discovery, segment by segment ───────────────────────────────
  // Sequential so each segment can be told what earlier ones already claimed —
  // cross-segment duplicates were a measured problem in Phase 3.
  const discovered: { company: DiscoveredCompany; segment: MissionStrategy['segments'][number] }[] = []
  const claimed = new Set<string>()

  for (const segment of strategy.segments) {
    const run = await runMarketDiscovery(
      {
        segment,
        mission: { goal: params.mission.goal, geography: params.mission.geography },
        alreadyFound: Array.from(claimed),
        targetCount: params.companiesPerSegment,
      },
      ctx
    )
    await trace(run, { segment: segment.name })

    if (!run.output) {
      errors.push(`market_discovery(${segment.name}): ${run.error}`)
      continue
    }
    for (const company of run.output.companies) {
      const key = companyKey({ name: company.name, domain: company.domain } as CompanyCandidate)
      if (claimed.has(key)) continue
      claimed.add(key)
      discovered.push({ company, segment })
    }
    log('discovery', `${segment.name}: ${run.output.companies.length} companies${run.output.thin_supply ? ' (thin supply)' : ''}`)
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
      rejections.push({ company: v.company.name, reason: `validation failed: ${v.error}` })
      continue
    }
    const gate = shouldEnrich(v.validation)
    if (!gate.pass) {
      funnel.companiesRejected++
      rejections.push({ company: v.company.name, reason: gate.reason })
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
      peopleFilter: null,
      errors: [...errors, 'no companies survived validation'],
    }
  }

  // ─── 5. People Scout (deterministic Apollo) ────────────────────────────────
  const titlePatterns = Array.from(new Set(strategy.segments.flatMap((s) => s.title_patterns))).slice(0, 20)
  const targets: ScoutTarget[] = accepted.map((a) => ({
    company_name: a.company.name,
    domain: normalizeDomain(a.company.domain),
    company_ref: a.company.name,
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

  // ─── 7. Ranking ────────────────────────────────────────────────────────────
  const rankedResults = await mapWithConcurrency(researched, concurrency, async (r) => {
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
    return { ...run.output, person: r.person as PersonCandidate, company: r.person.company_name ?? r.person.company_ref }
  })

  const ranked = rankedResults
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => b.total - a.total)

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
