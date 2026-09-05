// Stub agents and stub persistence for the People Scout orchestrator.
//
// Every collaborator `runScouting` accepts through `ScoutDeps` has an in-memory
// double here. The doubles return WELL-TYPED outputs — the same shapes each
// agent's own `validate()` would produce — so what the suite exercises is the
// orchestrator's stage order, its gates, its checkpoint and its accounting, not
// a model. Each double counts its calls, and each agent double can advance the
// injected clock, so "the deadline arrived after the second dossier" is a
// statement the test makes rather than something it waits for.
//
// A WORLD describes what the stubs will find: segments, the companies each
// segment yields, the verdict validation gives each company, the people Apollo
// returns per company, the verdict research gives each person. The cases in
// people-scout.ts build a world, break one thing, and assert on the result.

import type { AgentResult, AgentTrace } from '../../lib/agents/runtime/types'
import type { MissionStrategy, SearchSegment } from '../../lib/agents/mission-strategist'
import type { DiscoveredCompany, DiscoverySessionResult, MarketDiscoveryOutput } from '../../lib/agents/market-discovery'
import { shouldEnrich, type CompanyValidation } from '../../lib/agents/company-validation'
import type { PersonTriageOutput } from '../../lib/agents/person-triage'
import type { PersonResearch, PersonVerdict } from '../../lib/agents/person-research'
import type { RankedProspect } from '../../lib/agents/ranking'
import type { NetworkRetrievalOutput } from '../../lib/agents/network-retrieval'
import { DIMENSION_MAX, SCOUT_DIMENSIONS, computeTotal, deriveRecommendation, type ScoutComponent } from '../../lib/scouting/score'
import type { ScoutDeps } from '../../lib/scouting/orchestrator'
import type { PeopleScoutResult as ApolloScoutResult } from '../../lib/scouting/people-scout'
import type { InternalPhaseResult } from '../../lib/scouting/internal-first'
import type { ScoutedProspect } from '../../lib/scouting/prospect'
import { emptyFacets } from '../../lib/network/facets'
import type { OwnedIndex, OwnedPerson } from '../../lib/network/reuse'
import { decideSufficiency, type SearchMode } from '../../lib/network/sufficiency'
import type { RankedInternalCandidate } from '../../lib/network/rank'
import type { NetworkCandidate } from '../../lib/network/search'
import type { PersonCandidate } from '../../lib/providers/types'
import type { ResearchClaim } from '../../lib/research/types'
import { personKeyOf } from '../../lib/scouting/checkpoint'

// ─── Agent results ───────────────────────────────────────────────────────────

const AGENT_COST_USD: Record<string, number> = {
  mission_strategist: 0.12,
  market_discovery: 0.2,
  company_validation: 0.05,
  person_triage: 0.01,
  person_research: 0.2,
  ranking: 0.004,
  network_retrieval: 0.08,
}

export function agentTrace(agentId: string, over: Partial<AgentTrace> = {}): AgentTrace {
  return {
    agent_id: agentId,
    prompt_version: '0.0.0-stub',
    model: 'stub-model',
    model_role: 'reasoning',
    provider_id: 'stub',
    tools_called: [],
    web_searches: agentId === 'ranking' || agentId === 'person_triage' ? 0 : 1,
    tokens_in: 1000,
    tokens_out: 400,
    cost_usd: AGENT_COST_USD[agentId] ?? 0.01,
    latency_ms: 10,
    steps: 1,
    ...over,
  }
}

export function okResult<T>(agentId: string, output: T): AgentResult<T> {
  return { output, status: 'succeeded', error: null, evidence: [{ url: 'https://example.com/source', title: 'Source', snippet: null }], trace: agentTrace(agentId) }
}

export function failedResult<T>(agentId: string, error: string, status: AgentResult<T>['status'] = 'failed'): AgentResult<T> {
  return { output: null, status, error, evidence: [], trace: agentTrace(agentId, { cost_usd: 0, web_searches: 0 }) }
}

/** The error text a provider call refused by the run's clock produces. */
export const DEADLINE_ERROR = 'anthropic messages.create: run deadline passed before the attempt could start'
/** The error text an agent whose output failed its schema produces. */
export const SCHEMA_ERROR = 'output failed schema validation: components missing'

// ─── Valid agent outputs ─────────────────────────────────────────────────────

export function makeSegment(name: string, over: Partial<SearchSegment> = {}): SearchSegment {
  return {
    name,
    rationale: `${name} plausibly hosts the work`,
    intended_archetype: 'growth',
    search_queries: [`${name} companies`],
    title_patterns: ['VP Engineering', 'Head of Product'],
    required_domain_terms: ['process'],
    exclusions: ['staffing'],
    priority: 0.7,
    ...over,
  }
}

export function makeStrategy(segmentNames: string[]): MissionStrategy {
  return { segments: segmentNames.map((n) => makeSegment(n)), positioning_angle: 'shipped industrial AI with process depth', reasoning: 'stub' }
}

export function makeDiscovered(name: string, over: Partial<DiscoveredCompany> = {}): DiscoveredCompany {
  return {
    name,
    domain: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '')}.example`,
    what_they_do: `${name} makes process equipment`,
    why_this_segment: 'operates in the segment',
    source_url: 'https://example.com/source',
    source_verified: true,
    ...over,
  }
}

export function makeDiscoverySession(segmentName: string, companies: DiscoveredCompany[], over: Partial<DiscoverySessionResult> = {}): DiscoverySessionResult {
  const output: MarketDiscoveryOutput = { companies, diagnosis: 'HEALTHY', diagnosis_reasoning: 'stub', action: 'ACCEPT', next_query: null, action_reasoning: 'enough found' }
  return {
    companies,
    history: [{ round: 1, query_used: `${segmentName} companies`, companies_found: companies.length, companies_kept: companies.length, diagnosis: 'HEALTHY', action: 'ACCEPT', note: 'stub' }],
    hypothesisRejected: false,
    needsNewHypothesis: false,
    finalDiagnosis: 'HEALTHY',
    agentResults: [okResult('market_discovery', output)],
    errors: [],
    ...over,
  }
}

export function makeClaims(subject: string): ResearchClaim[] {
  return [
    { claim: `${subject}: a sourced fact`, type: 'FACT', source_url: 'https://example.com/source', source_title: 'Source', confidence: 0.9, relevance: 'grounds the pitch' },
    { claim: `${subject}: an inference`, type: 'INFERENCE', source_url: null, source_title: null, confidence: 0.6, relevance: null },
  ]
}

export function makeValidation(name: string, over: Partial<CompanyValidation> = {}): CompanyValidation {
  const v: CompanyValidation = {
    verdict: 'KEEP',
    identity_confirmed: true,
    identity_note: 'matched on domain',
    confirmed_domain: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '')}.example`,
    what_they_do: `${name} builds process control software for chemical plants`,
    products_services: ['process control'],
    industries_served: ['chemicals'],
    customer_types: ['plants'],
    size_stage_context: '120 people',
    employee_estimate: 120,
    archetype: 'growth',
    target_titles: ['VP Engineering', 'Head of Product', 'CTO'],
    target_titles_used_fallback: false,
    mission_relevant: true,
    relevance_reasoning: 'core business is on-mission',
    claims: makeClaims(name),
    uncertainties: ['funding stage'],
    downgraded_claims: 0,
    ...over,
  }
  if (!over.verdict && !shouldEnrich(v).pass) throw new Error(`fixture bug: an accepted validation for ${name} must pass shouldEnrich`)
  return v
}

export function makePerson(name: string, companyRef: string, over: Partial<PersonCandidate> = {}): PersonCandidate & { company_ref: string } {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const parts = name.split(' ')
  return {
    name,
    first_name: parts[0] ?? null,
    last_name: parts[1] ?? null,
    title: 'VP Engineering',
    seniority: 'vp',
    department: 'engineering',
    email: `${slug}@${companyRef.toLowerCase().replace(/[^a-z0-9]+/g, '')}.example`,
    email_status: 'verified',
    linkedin_url: `https://linkedin.com/in/${slug}`,
    location: 'Houston, TX',
    company_name: companyRef,
    company_domain: `${companyRef.toLowerCase().replace(/[^a-z0-9]+/g, '')}.example`,
    raw: { id: `apollo-${slug}` },
    provenance: { provider_id: 'apollo', external_id: `apollo-${slug}`, query_ref: {}, retrieved_at: new Date(0).toISOString() },
    ...over,
    company_ref: companyRef,
  }
}

export function makeTriage(candidateKeys: string[], shortlistSize: number): PersonTriageOutput {
  return {
    scores: candidateKeys.map((key, i) => ({ key, score: 0.9 - i * 0.1, reason: 'title owns the function' })),
    shortlist: candidateKeys.slice(0, shortlistSize),
    company_note: 'a promising slate',
  }
}

export function makeResearch(name: string, verdict: PersonVerdict = 'KEEP', betterRole: string | null = null): PersonResearch {
  return {
    verdict,
    better_role_hypothesis: verdict === 'SEARCH_FOR_DIFFERENT_PERSON' ? betterRole : null,
    verdict_reasoning: `${name} ${verdict.toLowerCase()}`,
    apparent_ownership: `${name} owns the plant software roadmap`,
    function_relevance: 'directly relevant',
    decision_maker_assessment: 'can sponsor a project',
    can_create_opportunity: true,
    recent_initiatives: ['rolled out an APC upgrade'],
    specific_interest_hook: 'agentic AI in a process plant',
    claims: makeClaims(name),
    uncertainties: [],
    thin_public_record: false,
    downgraded_claims: 0,
  }
}

/** A RankedProspect with a component for EVERY dimension, arithmetic done the way the agent's validate() does it. */
export function makeRanked(key: string, normalized: number, backgroundIds: string[] = ['bg-1']): RankedProspect {
  const components: ScoutComponent[] = SCOUT_DIMENSIONS.map((dimension) => ({
    dimension,
    normalized,
    points: normalized * DIMENSION_MAX[dimension],
    max: DIMENSION_MAX[dimension],
    explanation: `${dimension} judged at ${normalized}`,
  }))
  const total = computeTotal(components)
  return {
    candidate_key: key,
    components,
    total,
    recommendation: deriveRecommendation(total, components),
    why_they_fit: 'they own the relevant work',
    why_i_fit_them: 'shipped [bg-1]',
    resume_item_ids: backgroundIds,
    risks: 'may route through HR',
    ungrounded_ids: [],
  }
}

// ─── Internal-first shapes ───────────────────────────────────────────────────

export function makeNetworkCandidate(contactId: string, name: string, company: string): NetworkCandidate {
  return {
    contact_id: contactId,
    name,
    title: 'Director of Operations',
    company,
    email: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@${company.toLowerCase().replace(/[^a-z0-9]+/g, '')}.example`,
    linkedin_url: `https://linkedin.com/in/${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    location: 'Houston, TX',
    seniority_band: 'director',
    function_area: 'operations',
    geo_city: 'Houston',
    geo_state: 'TX',
    geo_region: 'us_south',
    industry: 'chemicals',
    sub_industry: null,
    company_type: 'midmarket',
    technical_domains: ['process control'],
    business_domains: ['chemicals'],
    opportunity_types: ['internship'],
    tags: null,
    relevance: null,
    relationship_status: 'never_contacted',
    relationship_note: null,
    evidence_level: 'researched',
    summary: `${name} runs operations at ${company}`,
    rank: 1,
  }
}

export function makeInternalCandidate(contactId: string, name: string, company: string, total = 0.8): RankedInternalCandidate {
  return {
    contact: makeNetworkCandidate(contactId, name, company),
    total,
    base: total,
    relationshipModifier: 0,
    components: { mission_fit: total, decision_access: total, user_differentiation: total },
    confidence: 0.8,
    reason: 'runs operations at an on-mission plant',
    evidence: ['stored research'],
    approach: null,
    relationship: { status: 'never_contacted', touches: 0, replies: 0, lastContactedAt: null, lastReplyAt: null, note: 'cold', scoreModifier: 0 },
    rank: 1,
  }
}

/** What runInternalPhase would return for a network holding `ranked`, under `mode`. */
export function makeInternalPhase(mode: SearchMode, ranked: RankedInternalCandidate[], targetCount: number, indexed = 200): InternalPhaseResult {
  const decision = decideSufficiency({
    mode,
    candidates: ranked.map((r) => ({ total: r.total, confidence: r.confidence })),
    targetCount,
    missingProfile: ranked.length < targetCount ? ['a founder at a process-AI startup'] : [],
    indexed,
    classified: indexed,
  })
  return {
    ranked,
    decision,
    facets: { ...emptyFacets(), indexed, classified: indexed },
    searchLog: [{ query: 'process control director', effectiveQuery: 'process control director', filters: {}, totalMatches: ranked.length, returned: ranked.length }],
    missingProfile: decision.missingProfile,
    poolAssessment: 'a mid-sized network with some plant depth',
    contactIds: ranked.map((r) => r.contact.contact_id),
    costUsd: AGENT_COST_USD.network_retrieval,
    errors: [],
  }
}

/** The ScoutedProspect scoreInternalProspects builds for one internal candidate. */
export function makeInternalProspect(c: RankedInternalCandidate, normalized = 0.8): ScoutedProspect {
  const ranked = makeRanked(c.contact.contact_id, normalized)
  return {
    ...ranked,
    person: {
      name: c.contact.name,
      first_name: c.contact.name.split(' ')[0] ?? null,
      last_name: c.contact.name.split(' ').slice(-1)[0] ?? null,
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
      provenance: { provider_id: 'database', query_ref: { internal_rank: c.rank }, retrieved_at: new Date(0).toISOString() },
    },
    company: c.contact.company ?? 'unknown company',
    companyRef: c.contact.company ?? 'unknown company',
    researchSummary: 'SOURCE: already in your database.',
    researchVerdict: null,
    source: 'existing',
    contactId: c.contact.contact_id,
    companyContext: `WHAT THEY DO: ${c.contact.company}`,
    internalReason: c.reason,
    internalEvidence: c.evidence,
    relationshipStatus: c.relationship.status,
    approach: c.approach,
  }
}

export function emptyOwned(): OwnedIndex {
  return { byApolloId: new Map(), byLinkedIn: new Map(), byEmail: new Map(), byNameCompany: new Map(), size: 0, error: null }
}

export function ownedWith(people: OwnedPerson[]): OwnedIndex {
  const idx = emptyOwned()
  for (const p of people) {
    idx.size++
    if (p.apolloId) idx.byApolloId.set(p.apolloId, p)
    if (p.linkedinUrl) idx.byLinkedIn.set(p.linkedinUrl.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, ''), p)
    if (p.email) idx.byEmail.set(p.email.toLowerCase(), p)
  }
  return idx
}

// ─── The world ───────────────────────────────────────────────────────────────

export interface WorldCompany {
  name: string
  segment: string
  /** Default KEEP. REJECT is refused by shouldEnrich. */
  verdict?: CompanyValidation['verdict']
  people: string[]
}

export interface World {
  segments: string[]
  companies: WorldCompany[]
  /** Research verdict per person name. Default KEEP. */
  verdicts?: Record<string, { verdict: PersonVerdict; betterRole?: string }>
  /** Ranking judgment per person name, 0-1. Default 0.7. */
  scores?: Record<string, number>
  /** People the re-scout pass finds, per company, when research asked for a different role. */
  replacements?: Record<string, string>
  /** The internal phase: what the network holds, and whether that is enough. */
  internal?: { candidates: { contactId: string; name: string; company: string; total?: number }[] }
  /** Contacts the user already owns, matched during ranking (a rediscovery merges). */
  owned?: OwnedPerson[]
}

export function peopleOf(world: World): (PersonCandidate & { company_ref: string })[] {
  return world.companies.flatMap((c) => c.people.map((p) => makePerson(p, c.name)))
}

// ─── Stubs with counters, clock hooks and fault switches ─────────────────────

export interface Counters {
  strategist: number
  discovery: number
  validation: number
  scoutPeople: number
  triage: number
  research: number
  ranking: number
  internalPhase: number
  scoreInternal: number
  loadOwned: number
  persistCompanies: number
  persistContacts: number
  persistFacts: number
  recordAgentRun: number
  startRun: number
  updateRun: number
  touchRun: number
}

export function emptyCounters(): Counters {
  return { strategist: 0, discovery: 0, validation: 0, scoutPeople: 0, triage: 0, research: 0, ranking: 0, internalPhase: 0, scoreInternal: 0, loadOwned: 0, persistCompanies: 0, persistContacts: 0, persistFacts: 0, recordAgentRun: 0, startRun: 0, updateRun: 0, touchRun: 0 }
}

export interface UpdateCall {
  runId: string
  patch: Record<string, unknown>
  guard: { workerId?: string | null; statuses?: string[] }
}

/** The in-memory store: every row the orchestrator would have written, and every write it asked for. */
export interface FakeStore {
  runs: Map<string, Record<string, unknown>>
  updates: UpdateCall[]
  touches: string[]
  agentRuns: Map<string, { agentId: string; status: string; runId: string | null }>
  companies: Map<string, { id: string; name: string }>
  contacts: Map<string, { id: string; name: string }>
  facts: { subject: string; claim: string; type: string }[]
}

export function emptyStore(): FakeStore {
  return { runs: new Map(), updates: [], touches: [], agentRuns: new Map(), companies: new Map(), contacts: new Map(), facts: [] }
}

export interface Faults {
  /** Replace the strategist's answer. */
  strategist?: () => AgentResult<MissionStrategy>
  /** Replace ranking for the named person. */
  rankingFor?: Record<string, () => AgentResult<RankedProspect>>
  /** persistContacts reports the schema is missing. */
  contactsMigrationMissing?: boolean
  /** Internal scoring reports these candidates (by name) as cut by the clock — on every call, or only the first. */
  internalDeadlined?: { names: string[]; onlyFirstCall?: boolean }
  /** Advance the injected clock by this many ms inside each agent call, per stage. */
  advance?: Partial<Record<'strategist' | 'discovery' | 'validation' | 'triage' | 'research' | 'ranking' | 'internal', number>>
}

export interface StubDeps {
  deps: ScoutDeps
  counters: Counters
  store: FakeStore
  /** Names of the people research was called for, in call order. */
  researched: string[]
  /** Names of the people ranking was called for, in call order. */
  rankedNames: string[]
  /** The candidate names each scoreInternal call was given, per call. */
  internalScoredNames: string[][]
}

/**
 * Build every ScoutDeps double for a world. `tick(ms)` advances the case's
 * injected clock; the `advance` fault says how far each stage moves it.
 */
export function buildStubDeps(world: World, tick: (ms: number) => void, faults: Faults = {}): StubDeps {
  const counters = emptyCounters()
  const store = emptyStore()
  const researched: string[] = []
  const rankedNames: string[] = []
  const internalScoredNames: string[][] = []
  const adv = (stage: keyof NonNullable<Faults['advance']>) => tick(faults.advance?.[stage] ?? 0)
  let seq = 0
  const nextId = (prefix: string) => `${prefix}-${++seq}`

  const companiesBySegment = new Map<string, DiscoveredCompany[]>()
  for (const c of world.companies) {
    const list = companiesBySegment.get(c.segment) ?? []
    list.push(makeDiscovered(c.name))
    companiesBySegment.set(c.segment, list)
  }
  const companyByName = new Map(world.companies.map((c) => [c.name, c]))
  const allPeople = peopleOf(world)

  const deps: ScoutDeps = {
    strategist: async () => {
      counters.strategist++
      adv('strategist')
      if (faults.strategist) return faults.strategist()
      return okResult('mission_strategist', makeStrategy(world.segments))
    },

    discovery: async (params) => {
      counters.discovery++
      adv('discovery')
      const found = companiesBySegment.get(params.segment.name) ?? []
      const session = makeDiscoverySession(params.segment.name, found)
      for (const h of session.history) params.onRound?.(h)
      return session
    },

    validation: async (input) => {
      counters.validation++
      adv('validation')
      const c = companyByName.get(input.company.name)
      return okResult('company_validation', makeValidation(input.company.name, c?.verdict ? { verdict: c.verdict, relevance_reasoning: `${c.verdict} by the world` } : {}))
    },

    scoutPeople: async (params) => {
      counters.scoutPeople++
      // The orchestrator's re-scout pass asks for ONE person per company in the
      // role research named; the main pass asks for the budget's depth. The
      // signal must not be the call count: a resumed leg re-scouts on its first call.
      const isRescout = params.maxPerCompany === 1 && params.targets.every((t) => t.titles.length === 1)
      const people = isRescout
        ? params.targets.flatMap((t) => (world.replacements?.[t.company_ref] ? [makePerson(world.replacements[t.company_ref], t.company_ref, { title: t.titles[0] ?? null })] : []))
        : params.targets.flatMap((t) => allPeople.filter((p) => p.company_ref === t.company_ref))
      const stubs = people.length
      const result: ApolloScoutResult = {
        people,
        stubsFound: stubs,
        stubsKept: stubs,
        enriched: stubs,
        creditsUsed: stubs,
        filterStats: { seen: stubs, kept: stubs, rejected: {} },
        emptyCompanies: [],
        titleMisses: [],
        candidatePool: Object.fromEntries(params.targets.map((t) => [t.company_ref, people.filter((p) => p.company_ref === t.company_ref).map((p) => `${p.first_name} — ${p.title}`)])),
        reuse: { probed: stubs, reused: 0, purchased: stubs, byMatch: {} },
        reusedContactIds: [],
        errors: [],
      }
      return result
    },

    triage: async (input) => {
      counters.triage++
      adv('triage')
      return okResult('person_triage', makeTriage(input.candidates.map((c) => c.key), input.shortlistSize))
    },

    research: async (input) => {
      counters.research++
      researched.push(input.person.name)
      adv('research')
      const v = world.verdicts?.[input.person.name]
      return okResult('person_research', makeResearch(input.person.name, v?.verdict ?? 'KEEP', v?.betterRole ?? null))
    },

    ranking: async (input) => {
      counters.ranking++
      rankedNames.push(input.candidate.name)
      adv('ranking')
      const fault = faults.rankingFor?.[input.candidate.name]
      if (fault) return fault()
      return okResult('ranking', makeRanked(input.candidate.key, world.scores?.[input.candidate.name] ?? 0.7, input.backgroundItems.map((b) => b.id).slice(0, 1)))
    },

    internalPhase: async (params) => {
      counters.internalPhase++
      adv('internal')
      const candidates = (world.internal?.candidates ?? []).map((c) => makeInternalCandidate(c.contactId, c.name, c.company, c.total ?? 0.8))
      const phase = makeInternalPhase(params.mode, candidates, params.targetCount)
      if (params.mode !== 'external_only' && params.trace) {
        const output: NetworkRetrievalOutput = {
          shortlist: candidates.map((c) => ({ contact_id: c.contact.contact_id, components: c.components, confidence: c.confidence, reason: c.reason, evidence: c.evidence, approach: c.approach })),
          missing_profile: phase.missingProfile,
          pool_assessment: phase.poolAssessment,
        }
        await params.trace(okResult('network_retrieval', output) as AgentResult<unknown>, { phase: 'internal_retrieval' })
      }
      for (const s of phase.searchLog) params.onProgress?.('network', `"${s.query}" → ${s.totalMatches} matches`)
      return phase
    },

    scoreInternal: async (params) => {
      counters.scoreInternal++
      internalScoredNames.push(params.candidates.map((c) => c.contact.name))
      const prospects: ScoutedProspect[] = []
      const deadlined: RankedInternalCandidate[] = []
      const dl = faults.internalDeadlined
      for (const c of params.candidates) {
        if (dl && dl.names.includes(c.contact.name) && (!dl.onlyFirstCall || counters.scoreInternal === 1)) {
          deadlined.push(c)
          continue
        }
        const run = okResult('ranking', makeRanked(c.contact.contact_id, 0.8))
        if (params.trace) await params.trace(run as AgentResult<unknown>, { internal_person: c.contact.name })
        prospects.push(makeInternalProspect(c, 0.8))
      }
      return { prospects, errors: [], deadlined }
    },

    loadOwned: async () => {
      counters.loadOwned++
      return world.owned?.length ? ownedWith(world.owned) : emptyOwned()
    },

    persistCompanies: async (_userId, companies) => {
      counters.persistCompanies++
      const idByKey = new Map<string, string>()
      let inserted = 0
      for (const c of companies) {
        const key = c.domain ? `d:${c.domain}` : `n:${c.name.toLowerCase()}`
        let row = store.companies.get(key)
        if (!row) {
          row = { id: nextId('co'), name: c.name }
          store.companies.set(key, row)
          inserted++
        }
        idByKey.set(key, row.id)
      }
      return { idByKey, inserted, updated: companies.length - inserted, migrationMissing: false, errors: [] }
    },

    persistContacts: async (_userId, people) => {
      counters.persistContacts++
      if (faults.contactsMigrationMissing) {
        return { idByKey: new Map<string, string>(), inserted: 0, updated: 0, migrationMissing: true, errors: ['relation "contacts" does not exist (migration 010 not applied)'] }
      }
      const idByKey = new Map<string, string>()
      let inserted = 0
      for (const p of people) {
        const key = personKeyOf(p)
        let row = store.contacts.get(key)
        if (!row) {
          row = { id: nextId('ct'), name: p.name }
          store.contacts.set(key, row)
          inserted++
        }
        idByKey.set(key, row.id)
      }
      return { idByKey, inserted, updated: people.length - inserted, migrationMissing: false, errors: [] }
    },

    persistFacts: async (p) => {
      counters.persistFacts++
      let inserted = 0
      let rejected = 0
      for (const c of p.claims) {
        // The DB constraint: a FACT without a source is rejected, not stored.
        if (c.type === 'FACT' && !c.source_url) {
          rejected++
          continue
        }
        store.facts.push({ subject: p.subjectLabel, claim: c.claim, type: c.type })
        inserted++
      }
      return { inserted, rejected, migrationMissing: false, errors: [] }
    },

    recordAgentRun: async (_userId, runId, result) => {
      counters.recordAgentRun++
      const id = nextId('ar')
      store.agentRuns.set(id, { agentId: result.trace.agent_id, status: result.status, runId })
      return { agentRunId: id, migrationMissing: false }
    },

    startRun: async (p) => {
      counters.startRun++
      const id = nextId('run')
      store.runs.set(id, { id, user_id: p.userId, label: p.label, status: 'running', kind: p.kind ?? null })
      return { runId: id, migrationMissing: false }
    },

    updateRun: async (runId, patch, guard = {}) => {
      counters.updateRun++
      store.updates.push({ runId, patch: { ...patch } as Record<string, unknown>, guard: { ...guard } })
      const row = store.runs.get(runId)
      if (row) Object.assign(row, patch.status ? { status: patch.status } : {}, patch.completed ? { completed_at: 'now' } : {})
      return { ok: true, matched: Boolean(row) }
    },

    touchRun: async (runId) => {
      counters.touchRun++
      store.touches.push(runId)
      return { ok: true, notRunning: false, cancelRequested: false, migrationMissing: false, error: null }
    },
  }

  return { deps, counters, store, researched, rankedNames, internalScoredNames }
}

// ─── A standard world ────────────────────────────────────────────────────────

/**
 * Two segments, four companies (one rejected), two people at each accepted
 * company, one internal candidate that is not enough on its own, one research
 * verdict that asks for a different person, and one replacement for it.
 */
export function standardWorld(): World {
  return {
    segments: ['Process AI', 'Specialty Chemicals'],
    companies: [
      { name: 'Acme Process', segment: 'Process AI', people: ['Alice Adams', 'Aaron Ames'] },
      { name: 'Borealis Controls', segment: 'Process AI', people: ['Bea Brown', 'Ben Bright'] },
      { name: 'Cobalt Chemicals', segment: 'Specialty Chemicals', people: ['Cara Cole', 'Carl Cross'] },
      { name: 'Dud Staffing', segment: 'Specialty Chemicals', verdict: 'REJECT', people: ['Dan Dull'] },
    ],
    verdicts: { 'Carl Cross': { verdict: 'SEARCH_FOR_DIFFERENT_PERSON', betterRole: 'Plant Manager' } },
    scores: { 'Alice Adams': 0.9, 'Aaron Ames': 0.85, 'Bea Brown': 0.8, 'Ben Bright': 0.6, 'Cara Cole': 0.75, 'Chris Chase': 0.65 },
    replacements: { 'Cobalt Chemicals': 'Chris Chase' },
    internal: { candidates: [{ contactId: 'c-int-1', name: 'Ines Inner', company: 'Inner Works', total: 0.8 }] },
  }
}
