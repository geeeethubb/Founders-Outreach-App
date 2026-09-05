// What a People Scout run is asked to do — sanitised once, executed later.
//
// The request body is untrusted and the row is executed minutes later by a
// different invocation, so the parameters are clamped here, persisted on the
// run row, and read back by the worker through the same function. The caps
// are the PRODUCT's caps (a run's depth), not a platform ceiling: a hosted run
// that outgrows one invocation is continued by the next leg from its
// checkpoint, so nothing here is sized to 300 seconds.

import { isSearchMode, type SearchMode } from '@/lib/network/sufficiency'

export interface PeopleScoutParams {
  goal: string
  geography: string
  timeframe: string
  constraints: string[]
  segmentCount: number
  companiesPerSegment: number
  maxProspects: number
  maxDeepResearch: number
  researchPerCompany: number
  maxDiscoveryRounds: number
  maxRescoutRounds: number
  concurrency: number
  searchMode: SearchMode
  internalTarget: number
  maxInternalSearches: number
  /** The campaign whose voice drafts should match; carried for the page, not used by the run. */
  campaignId: string | null
  label: string
}

export const PEOPLE_SCOUT_CAPS = {
  segments: 3,
  companiesPerSegment: 6,
  maxProspects: 40,
  maxDeepResearch: 15,
  internalTarget: 15,
} as const

const DEFAULT_CONSTRAINTS = [
  'undergraduate student, so the ask is an internship, a short project, advice, or a referral',
  'must be a person who could plausibly reply to a well-written cold email',
]

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fallback
  return Math.max(min, Math.min(max, n))
}

function str(v: unknown, max = 2000): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

/** Never throws. An empty goal is the one thing that makes a request invalid; the caller checks `goal`. */
export function sanitizePeopleScoutParams(body: Record<string, unknown> | null | undefined): PeopleScoutParams {
  const b = body ?? {}
  const constraints = Array.isArray(b.constraints) ? (b.constraints as unknown[]).map((c) => str(c, 300)).filter(Boolean).slice(0, 8) : DEFAULT_CONSTRAINTS
  return {
    goal: str(b.goal, 4000),
    geography: str(b.geography, 200) || 'United States',
    timeframe: str(b.timeframe, 200) || 'Winter 2026-27',
    constraints: constraints.length ? constraints : DEFAULT_CONSTRAINTS,
    segmentCount: clampInt(b.segments ?? b.segmentCount, 1, PEOPLE_SCOUT_CAPS.segments, 2),
    companiesPerSegment: clampInt(b.companiesPerSegment, 2, PEOPLE_SCOUT_CAPS.companiesPerSegment, 4),
    maxProspects: clampInt(b.maxProspects, 5, PEOPLE_SCOUT_CAPS.maxProspects, 25),
    maxDeepResearch: clampInt(b.maxDeepResearch, 2, PEOPLE_SCOUT_CAPS.maxDeepResearch, 7),
    researchPerCompany: clampInt(b.researchPerCompany, 1, 3, 2),
    maxDiscoveryRounds: clampInt(b.maxDiscoveryRounds, 1, 3, 2),
    maxRescoutRounds: clampInt(b.maxRescoutRounds, 0, 1, 0),
    concurrency: clampInt(b.concurrency, 1, 5, 5),
    searchMode: isSearchMode(b.searchMode) ? b.searchMode : 'internal_first',
    internalTarget: clampInt(b.internalTarget, 4, PEOPLE_SCOUT_CAPS.internalTarget, 8),
    maxInternalSearches: clampInt(b.maxInternalSearches, 2, 8, 6),
    campaignId: typeof b.campaignId === 'string' && b.campaignId ? b.campaignId.slice(0, 80) : null,
    label: str(b.label, 120) || `people scout · ${new Date().toISOString().slice(0, 16)}`,
  }
}

/** Reads a persisted `params` payload back into the shape the worker executes. */
export function readPeopleScoutParams(params: unknown): PeopleScoutParams {
  return sanitizePeopleScoutParams((params ?? {}) as Record<string, unknown>)
}
