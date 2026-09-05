// The People Scout's result payload, read from an untrusted row.
//
// GET /api/scout/runs/[id]?result=1 carries the PeopleScoutResult the worker
// wrote progressively. A payload written by an older leg, or cut short, must
// still render: every array and number is defaulted here, and a prospect that
// is not one is dropped rather than crashing the page. The generic helpers at
// the top are shared with scout-run-view.ts.
//
// Pure. No fetch, no React, no storage.

import type { FunnelCounts, PeopleScoutResult, ProspectView, UnrankedView } from '@/lib/scouting/checkpoint'

// ─── Untrusted-payload helpers ───────────────────────────────────────────────

export function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

export function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function num(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

export function toCounts(value: unknown): Record<string, number> {
  const o = object(value)
  if (!o) return {}
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(o)) {
    const n = typeof v === 'number' ? v : Number(v)
    if (Number.isFinite(n)) out[k] = n
  }
  return out
}

// ─── The result payload ──────────────────────────────────────────────────────

export function emptyFunnelCounts(): FunnelCounts {
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

const RECOMMENDATIONS = new Set(['STRONG', 'MAYBE', 'WEAK'])
const SOURCES = new Set(['existing', 'new', 'existing_rediscovered'])

function toProspect(value: unknown): ProspectView | null {
  const o = object(value)
  const name = str(o?.name)
  if (!o || !name) return null
  const components = Array.isArray(o.components)
    ? o.components
        .map((c) => object(c))
        .filter((c): c is Record<string, unknown> => !!c && typeof c.dimension === 'string')
        .map((c) => ({ dimension: String(c.dimension), normalized: num(c.normalized), points: num(c.points), max: num(c.max), explanation: str(c.explanation) ?? '' }))
    : []
  return {
    key: str(o.key) ?? str(o.linkedin) ?? str(o.email) ?? name,
    name,
    title: str(o.title),
    company: str(o.company) ?? 'unknown company',
    location: str(o.location),
    email: str(o.email),
    emailStatus: str(o.emailStatus) ?? 'unknown',
    linkedin: str(o.linkedin),
    score: num(o.score),
    recommendation: RECOMMENDATIONS.has(String(o.recommendation)) ? (o.recommendation as ProspectView['recommendation']) : 'WEAK',
    source: SOURCES.has(String(o.source)) ? (o.source as ProspectView['source']) : 'new',
    contactId: str(o.contactId),
    relationshipStatus: str(o.relationshipStatus),
    approach: str(o.approach),
    internalReason: str(o.internalReason),
    whyCompany: str(o.whyCompany),
    whyThem: str(o.whyThem) ?? '',
    whyYou: str(o.whyYou) ?? '',
    backgroundIds: strings(o.backgroundIds),
    risks: str(o.risks) ?? '',
    researchSummary: str(o.researchSummary) ?? '',
    components,
  }
}

function toUnranked(value: unknown): UnrankedView | null {
  const o = object(value)
  const name = str(o?.name)
  if (!o || !name) return null
  return {
    key: str(o.key) ?? name,
    name,
    title: str(o.title),
    company: str(o.company) ?? 'unknown company',
    linkedin: str(o.linkedin),
    email: str(o.email),
    researchSummary: str(o.researchSummary),
    verdict: str(o.verdict),
    reason: o.reason === 'research_failed' ? 'research_failed' : 'not_ranked',
  }
}

type InternalView = NonNullable<PeopleScoutResult['internal']>

function toInternal(value: unknown): PeopleScoutResult['internal'] {
  const o = object(value)
  if (!o) return null
  const decision = str(o.decision)
  return {
    headline: str(o.headline) ?? '',
    decision: (decision === 'INTERNAL_SUFFICIENT' || decision === 'EXTERNAL_DISCOVERY_NEEDED' || decision === 'INTERNAL_SKIPPED' ? decision : 'INTERNAL_SKIPPED') as InternalView['decision'],
    reasons: strings(o.reasons),
    strongCount: num(o.strongCount),
    targetCount: num(o.targetCount),
    indexed: num(o.indexed),
    classified: num(o.classified),
    poolAssessment: str(o.poolAssessment) ?? '',
    missingProfile: strings(o.missingProfile),
    searches: Array.isArray(o.searches)
      ? o.searches
          .map((s) => object(s))
          .filter((s): s is Record<string, unknown> => !!s)
          .map((s) => ({ query: str(s.query) ?? '', matches: num(s.matches), shown: num(s.shown) }))
      : [],
  }
}

/**
 * The result payload as the page renders it. Null when there is none — a run
 * that has not reached a stage that writes one, or a poll that did not ask.
 */
export function parseScoutResult(raw: unknown): PeopleScoutResult | null {
  const o = object(raw)
  if (!o || !Array.isArray(o.prospects)) return null
  const usage = object(o.usage) ?? {}
  const bg = object(o.backgroundSource)
  const byAgent: PeopleScoutResult['usage']['byAgent'] = {}
  for (const [k, v] of Object.entries(object(usage.byAgent) ?? {})) {
    const a = object(v)
    if (a) byAgent[k] = { calls: num(a.calls), costUsd: num(a.costUsd), webSearches: num(a.webSearches) }
  }
  return {
    v: 1,
    runId: str(o.runId),
    searchMode: str(o.searchMode) ?? 'internal_first',
    backgroundSource: bg ? { source: bg.source === 'bank' ? 'bank' : 'fixture', items: num(bg.items), warning: str(bg.warning) } : null,
    internal: toInternal(o.internal),
    funnel: { ...emptyFunnelCounts(), ...toCounts(o.funnel) } as FunnelCounts,
    prospects: o.prospects.map(toProspect).filter((p): p is ProspectView => !!p),
    unranked: Array.isArray(o.unranked) ? o.unranked.map(toUnranked).filter((u): u is UnrankedView => !!u) : [],
    usage: {
      costUsd: num(usage.costUsd),
      apolloCredits: num(usage.apolloCredits),
      apolloCallsAvoided: num(usage.apolloCallsAvoided),
      webSearches: num(usage.webSearches),
      modelCalls: num(usage.modelCalls),
      latencyMs: num(usage.latencyMs),
      byAgent,
    },
    errors: strings(o.errors),
    stages: strings(o.stages),
    complete: o.complete === true,
    updated_at: str(o.updated_at) ?? '',
  }
}
