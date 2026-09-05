// Where a People Scout run has GOT TO, and what it has produced so far.
//
// A hosted worker lives 300 seconds; a full-depth People Scout measured 527.
// So a run is not one execution — it is a row plus a CHECKPOINT saying which
// stages are finished and what they produced, written at every stage boundary
// and (throttled) inside the long stages. The next invocation reads it and
// CONTINUES: it does not pay for the strategy, the discovery, the validations
// or the research dossiers a previous leg already bought.
//
// Two shapes live here:
//
//   PeopleScoutCheckpoint  the resume state. Never returned to a poll.
//   PeopleScoutResult      the payload the Scout page renders — the SAME shape
//                          the synchronous API used to answer with, written
//                          progressively so a run that stops short still shows
//                          the prospects it found (principle 11).
//
// Both are versioned. A checkpoint a newer deployment cannot read is a
// 'partial with Continue', never a crash after the claim.
//
// Heavy fields are bounded: a person's Apollo payload is reduced to its id (the
// only part a later stage reads), and research is kept as the RENDERED text the
// ranking prompt consumes plus the two verdict fields the re-scout reads —
// the claims themselves already live in research_facts with their sources.

import type { MissionStrategy } from '@/lib/agents/mission-strategist'
import type { DiscoveredCompany, DiscoveryRoundHistory } from '@/lib/agents/market-discovery'
import type { CompanyValidation } from '@/lib/agents/company-validation'
import type { PersonCandidate } from '@/lib/providers/types'
import type { ScoutedProspect } from './prospect'
import type { SufficiencyDecision } from '@/lib/network/sufficiency'
import type { SearchLogEntry } from '@/lib/agents/network-retrieval'
import type { RankedInternalCandidate } from '@/lib/network/rank'

export const PEOPLE_SCOUT_CHECKPOINT_VERSION = 1

/** Stage names, in run order. 'done' means nothing is left. */
export const PEOPLE_SCOUT_STAGES = ['strategy', 'internal', 'discovery', 'validation', 'people', 'triage', 'research', 'rescout', 'rank', 'done'] as const
export type PeopleScoutStage = (typeof PEOPLE_SCOUT_STAGES)[number]

export interface FunnelCounts {
  segments: number
  /** Contacts the internal index held at the moment the run started. */
  networkIndexed: number
  /** Internal candidates the retrieval agent shortlisted. */
  internalRetrieved: number
  /** Of those, how many cleared the strong bar. */
  internalStrong: number
  companiesDiscovered: number
  companiesValidated: number
  companiesRejected: number
  stubsFound: number
  peopleEnriched: number
  /** People resolved from the database instead of an Apollo credit. */
  peopleReused: number
  peopleTriaged: number
  peopleResearched: number
  prospectsRanked: number
}

export function emptyFunnel(): FunnelCounts {
  return {
    segments: 0,
    networkIndexed: 0,
    internalRetrieved: 0,
    internalStrong: 0,
    companiesDiscovered: 0,
    companiesValidated: 0,
    companiesRejected: 0,
    stubsFound: 0,
    peopleEnriched: 0,
    peopleReused: 0,
    peopleTriaged: 0,
    peopleResearched: 0,
    prospectsRanked: 0,
  }
}

export interface InternalSummary {
  decision: SufficiencyDecision
  poolAssessment: string
  missingProfile: string[]
  searchLog: SearchLogEntry[]
  indexed: number
  classified: number
  costUsd: number
}

/** A person as the checkpoint carries them: the candidate, with the provider payload reduced to its id. */
export type CheckpointPerson = PersonCandidate & { company_ref: string }

export interface ResearchNote {
  ok: boolean
  /** The rendered dossier the ranking prompt reads; null when research failed. */
  personContext: string | null
  verdict: string | null
  betterRole: string | null
  companyContext: string
  error?: string | null
  /** The call ran out the run's clock. A continuation asks again, once. */
  timedOut?: boolean
  /** How many legs have tried this person. */
  tries: number
}

export interface UsageTotals {
  costUsd: number
  calls: number
  cachedCalls: number
  webSearches: number
  apolloCalls: number
  apolloCredits: number
  latencyMs: number
  retries: number
  errors: number
}

export function emptyUsage(): UsageTotals {
  return { costUsd: 0, calls: 0, cachedCalls: 0, webSearches: 0, apolloCalls: 0, apolloCredits: 0, latencyMs: 0, retries: 0, errors: 0 }
}

export interface PeopleScoutCheckpoint {
  v: typeof PEOPLE_SCOUT_CHECKPOINT_VERSION
  stages: PeopleScoutStage[]
  /** How many legs have executed this run. */
  attempts: number
  updated_at: string | null

  strategy: MissionStrategy | null
  /**
   * The existing-network phase. `pending` holds the retrieved candidates a
   * leg did not get to score before its clock ran out; the next leg scores
   * exactly those and never pays for retrieval again.
   */
  internal: { summary: InternalSummary; prospects: ScoutedProspect[]; runExternal: boolean; pending?: RankedInternalCandidate[] } | null

  /** Discovery, per segment, so a leg cut off mid-discovery resumes the segments it did not reach. */
  discovered: { company: DiscoveredCompany; segmentName: string }[]
  discoverySegmentsDone: string[]
  discoveryHistory: { segment: string; rounds: DiscoveryRoundHistory[]; rejected: boolean }[]

  /** Validation, per company. */
  validationDone: string[]
  accepted: { company: DiscoveredCompany; segmentName: string; validation: CompanyValidation; agentRunId: string | null }[]
  rejections: { company: string; description: string; reason: string }[]
  companyIdByKey: Record<string, string>

  /** People Scout (Apollo), one shot. */
  people: CheckpointPerson[]
  peopleStats: {
    stubsFound: number
    stubsKept: number
    reused: number
    creditsUsed: number
    filter: { seen: number; kept: number; rejected: Record<string, number> } | null
    candidatePool: Record<string, string[]>
  } | null
  contactIdByKey: Record<string, string>

  /** Triage, per company; the shortlist that advances. */
  triageDone: string[]
  toResearch: string[]

  /** Research, per person key. */
  research: Record<string, ResearchNote>
  /** The re-scout pass: extra people found from a SEARCH_FOR_DIFFERENT_PERSON verdict. */
  rescoutDone: boolean
  rescouted: CheckpointPerson[]

  /** Ranking, per person key. */
  ranked: Record<string, ScoutedProspect>

  funnel: FunnelCounts
  errors: string[]
  costByAgent: Record<string, { calls: number; costUsd: number; webSearches: number }>
  usage: UsageTotals
  apolloCallsAvoided: number
  persistence: {
    migrationMissing: boolean
    companiesInserted: number
    contactsInserted: number
    agentRunsRecorded: number
    factsInserted: number
    factsRejected: number
  }
  background: { source: 'bank' | 'fixture'; items: number; warning: string | null } | null
}

export function emptyCheckpoint(): PeopleScoutCheckpoint {
  return {
    v: PEOPLE_SCOUT_CHECKPOINT_VERSION,
    stages: [],
    attempts: 0,
    updated_at: null,
    strategy: null,
    internal: null,
    discovered: [],
    discoverySegmentsDone: [],
    discoveryHistory: [],
    validationDone: [],
    accepted: [],
    rejections: [],
    companyIdByKey: {},
    people: [],
    peopleStats: null,
    contactIdByKey: {},
    triageDone: [],
    toResearch: [],
    research: {},
    rescoutDone: false,
    rescouted: [],
    ranked: {},
    funnel: emptyFunnel(),
    errors: [],
    costByAgent: {},
    usage: emptyUsage(),
    apolloCallsAvoided: 0,
    persistence: { migrationMissing: false, companiesInserted: 0, contactsInserted: 0, agentRunsRecorded: 0, factsInserted: 0, factsRejected: 0 },
    background: null,
  }
}

/**
 * A checkpoint read back from a row. Unreadable (a different version, a
 * foreign shape) means "start over" — reported, never thrown: a newer
 * deployment continuing an older run must degrade to a fresh pass, not crash
 * after it has claimed the row.
 */
export function readCheckpoint(value: unknown): { checkpoint: PeopleScoutCheckpoint; fresh: boolean; note: string | null } {
  if (!value || typeof value !== 'object') return { checkpoint: emptyCheckpoint(), fresh: true, note: null }
  const v = value as Partial<PeopleScoutCheckpoint>
  if (v.v !== PEOPLE_SCOUT_CHECKPOINT_VERSION) {
    return { checkpoint: emptyCheckpoint(), fresh: true, note: `the run's checkpoint was written by another version (v${String(v.v)}); starting the run over` }
  }
  const base = emptyCheckpoint()
  const cp: PeopleScoutCheckpoint = {
    ...base,
    ...v,
    v: PEOPLE_SCOUT_CHECKPOINT_VERSION,
    stages: Array.isArray(v.stages) ? (v.stages.filter((s) => (PEOPLE_SCOUT_STAGES as readonly string[]).includes(String(s))) as PeopleScoutStage[]) : [],
    funnel: { ...base.funnel, ...(v.funnel ?? {}) },
    usage: { ...base.usage, ...(v.usage ?? {}) },
    persistence: { ...base.persistence, ...(v.persistence ?? {}) },
    research: v.research && typeof v.research === 'object' ? v.research : {},
    ranked: v.ranked && typeof v.ranked === 'object' ? v.ranked : {},
    errors: Array.isArray(v.errors) ? v.errors.slice(-60) : [],
  }
  return { checkpoint: cp, fresh: cp.stages.length === 0, note: null }
}

/** The person's key everywhere in this run: the same one the orchestrator has always used. */
export function personKeyOf(p: { linkedin_url?: string | null; email?: string | null; name: string }): string {
  return p.linkedin_url ?? p.email ?? p.name
}

/** A candidate as the checkpoint stores it: the provider payload reduced to its id. */
export function toCheckpointPerson(p: PersonCandidate & { company_ref: string }): CheckpointPerson {
  const rawId = (p.raw as { id?: unknown } | undefined)?.id
  return { ...p, raw: rawId !== undefined ? { id: rawId } : {} }
}

// ─── The result the page renders ─────────────────────────────────────────────

export interface ProspectView {
  key: string
  name: string
  title: string | null
  company: string
  location: string | null
  email: string | null
  emailStatus: string
  linkedin: string | null
  score: number
  recommendation: 'STRONG' | 'MAYBE' | 'WEAK'
  source: 'existing' | 'new' | 'existing_rediscovered'
  contactId: string | null
  relationshipStatus: string | null
  approach: string | null
  internalReason: string | null
  whyCompany: string | null
  whyThem: string
  whyYou: string
  backgroundIds: string[]
  risks: string
  researchSummary: string
  components: { dimension: string; normalized: number; points: number; max: number; explanation: string }[]
}

/** A person the run researched but did not get to rank before it stopped — shown, never discarded. */
export interface UnrankedView {
  key: string
  name: string
  title: string | null
  company: string
  linkedin: string | null
  email: string | null
  researchSummary: string | null
  verdict: string | null
  reason: 'not_ranked' | 'research_failed'
}

export interface PeopleScoutResult {
  v: 1
  runId: string | null
  searchMode: string
  backgroundSource: { source: 'bank' | 'fixture'; items: number; warning: string | null } | null
  internal: {
    headline: string
    decision: SufficiencyDecision['decision']
    reasons: string[]
    strongCount: number
    targetCount: number
    indexed: number
    classified: number
    poolAssessment: string
    missingProfile: string[]
    searches: { query: string; matches: number; shown: number }[]
  } | null
  funnel: FunnelCounts
  prospects: ProspectView[]
  unranked: UnrankedView[]
  usage: {
    costUsd: number
    apolloCredits: number
    apolloCallsAvoided: number
    webSearches: number
    modelCalls: number
    latencyMs: number
    byAgent: Record<string, { calls: number; costUsd: number; webSearches: number }>
  }
  errors: string[]
  /** Which stages are finished; the page uses it to say "researched, not yet ranked". */
  stages: string[]
  complete: boolean
  updated_at: string
}
