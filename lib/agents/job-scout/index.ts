// Job Scout Agent — one round.
//
// Judgment problem it owns: "is this search surface productive, what is it
// returning, and what should I try next?" (docs/CAREER_OS.md §3). The same
// shape as Market Discovery: the agent decides what to do, the session in
// session.ts decides how long it may keep deciding.
//
// Grounding is structural. A submitted posting's URL must be in the web-search
// evidence pool OR in the set of URLs a tool actually returned. Anything else
// is dropped and COUNTED — the count is reported back to the model in the next
// round's history, which is the only feedback that has ever stopped a model
// from constructing plausible careers URLs.

import { runAgent } from '../runtime/loop'
import { normalizeModelText } from '../runtime/text'
import { normalizeDomain } from '@/lib/providers/apollo/normalize'
import type { AgentResult, AgentTool, EvidenceSource, ToolContext } from '../runtime/types'
import { jobScoutPrompt, type JobScoutInput, type ScoutRoundHistory } from './prompt'

export { jobScoutPrompt }
export type { JobScoutInput, ScoutRoundHistory }
export type { LookupBoardFn, FetchPageFn, LookupBoardResult, FetchPageResult, BoardPostingSummary, ScoutToolLogEntry } from './tools'
export { buildScoutTools } from './tools'

export type PostingSourceKind = 'ats' | 'careers_page' | 'aggregator' | 'search_result'
const SOURCE_KINDS: PostingSourceKind[] = ['ats', 'careers_page', 'aggregator', 'search_result']

export interface ScoutedPosting {
  company_name: string
  company_domain: string | null
  title: string
  location: string | null
  /** The URL the agent actually saw — validated against the pool. */
  url: string
  source_kind: PostingSourceKind
  ats_hint: string | null
  season_hint: string | null
  why_relevant: string
}

export interface CompanyToCheck {
  name: string
  domain: string | null
  why: string
}

export const SCOUT_DIAGNOSES = [
  'HEALTHY',
  'AGGREGATOR_NOISE',
  'WRONG_SEASON',
  'NOT_INTERNSHIPS',
  'LOW_SUPPLY',
  'GEOGRAPHIC_OVERCONSTRAINT',
  'DOMAIN_DRIFT',
  'STALE_RESULTS',
] as const
export type ScoutDiagnosis = (typeof SCOUT_DIAGNOSES)[number]

export const SCOUT_ACTIONS = [
  'ACCEPT',
  'REFINE',
  'BROADEN',
  'NARROW',
  'SWITCH_SURFACE',
  'FOLLOW_COMPANY',
  'REJECT_STRATEGY',
  'REQUEST_NEW_STRATEGY',
] as const
export type ScoutAction = (typeof SCOUT_ACTIONS)[number]

/** Actions that end the session rather than triggering another round. */
export const SCOUT_TERMINAL_ACTIONS: ScoutAction[] = ['ACCEPT', 'REJECT_STRATEGY', 'REQUEST_NEW_STRATEGY']

export interface JobScoutRoundOutput {
  postings: ScoutedPosting[]
  companies_to_check: CompanyToCheck[]
  diagnosis: ScoutDiagnosis
  diagnosis_reasoning: string
  action: ScoutAction
  next_query: string | null
  action_reasoning: string
  /** Postings dropped because their URL was in neither the evidence pool nor a tool result. */
  ungrounded_postings: number
}

export const OUTPUT_SCHEMA = {
  properties: {
    postings: {
      type: 'array',
      description: 'Postings you actually saw THIS round. Empty is a valid and honest answer.',
      items: {
        type: 'object',
        properties: {
          company_name: { type: 'string' },
          company_domain: { type: ['string', 'null'], description: 'e.g. "example.com". Null unless confident.' },
          title: { type: 'string', description: 'The title as posted.' },
          location: { type: ['string', 'null'], description: 'As posted. Null if not shown.' },
          url: { type: 'string', description: 'The posting or careers URL you SAW — in a search result or a tool result. Never constructed.' },
          source_kind: { type: 'string', enum: SOURCE_KINDS, description: 'ats = from lookup_ats_board or an ATS host; careers_page = first-party page; aggregator = unresolved aggregator; search_result = other.' },
          ats_hint: { type: ['string', 'null'], description: 'greenhouse / lever / ashby / smartrecruiters / workable, if evident.' },
          season_hint: { type: ['string', 'null'], description: 'The season the posting names, verbatim ("Summer 2027"), or "unspecified".' },
          why_relevant: { type: 'string', description: 'One short sentence tying it to the strategy.' },
        },
        required: ['company_name', 'company_domain', 'title', 'location', 'url', 'source_kind', 'ats_hint', 'season_hint', 'why_relevant'],
      },
    },
    companies_to_check: {
      type: 'array',
      description: 'Relevant companies whose careers page code should check deterministically.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          domain: { type: ['string', 'null'] },
          why: { type: 'string' },
        },
        required: ['name', 'domain', 'why'],
      },
    },
    diagnosis: { type: 'string', enum: SCOUT_DIAGNOSES },
    diagnosis_reasoning: { type: 'string' },
    action: { type: 'string', enum: SCOUT_ACTIONS },
    next_query: { type: ['string', 'null'], description: 'REQUIRED unless the action is terminal. Materially different from previous queries.' },
    action_reasoning: { type: 'string' },
  },
  required: ['postings', 'companies_to_check', 'diagnosis', 'diagnosis_reasoning', 'action', 'next_query', 'action_reasoning'],
}

function httpUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null
  try {
    const p = new URL(v.trim())
    return p.protocol === 'http:' || p.protocol === 'https:' ? p.toString() : null
  } catch {
    return null
  }
}

function stripDecoration(url: string): string {
  try {
    const p = new URL(url)
    p.hash = ''
    p.search = ''
    return p.toString()
  } catch {
    return url
  }
}

/**
 * Build the grounded-URL checker. Exact match on the URL, or the same URL with
 * its fragment and tracking query stripped. NOT origin-level: a company's
 * careers origin being in the pool must not license any invented path under it —
 * that is exactly the fabrication this check exists to catch.
 */
function groundedIn(evidence: EvidenceSource[], toolUrls: Set<string>): (url: string) => boolean {
  const pool = new Set<string>()
  const add = (u: string) => {
    pool.add(u)
    try {
      const p = new URL(u)
      p.hash = ''
      pool.add(p.toString())
      p.search = ''
      pool.add(p.toString())
    } catch {
      /* ignore */
    }
  }
  for (const e of evidence) add(e.url)
  for (const u of toolUrls) add(u)
  return (url: string) => {
    if (pool.has(url)) return true
    try {
      const p = new URL(url)
      p.hash = ''
      if (pool.has(p.toString())) return true
      p.search = ''
      return pool.has(p.toString())
    } catch {
      return false
    }
  }
}

/** Rejects (null) rather than repairs; drops and counts ungrounded postings. Exported for the offline test. */
export function validateRound(raw: unknown, evidence: EvidenceSource[], toolUrls: Set<string>): JobScoutRoundOutput | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.postings)) return null

  const diagnosis = String(r.diagnosis ?? '') as ScoutDiagnosis
  const action = String(r.action ?? '') as ScoutAction
  if (!SCOUT_DIAGNOSES.includes(diagnosis) || !SCOUT_ACTIONS.includes(action)) return null

  const grounded = groundedIn(evidence, toolUrls)
  const seenUrls = new Set<string>()
  const postings: ScoutedPosting[] = []
  let ungrounded = 0

  for (const entry of r.postings) {
    if (!entry || typeof entry !== 'object') continue
    const p = entry as Record<string, unknown>
    const company = normalizeModelText(p.company_name)
    const title = normalizeModelText(p.title)
    if (!company || !title) continue
    const url = httpUrl(p.url)
    if (!url || !grounded(url)) {
      ungrounded++
      continue
    }
    // Same posting, different fragment or tracking query, is one posting.
    const dedupeKey = stripDecoration(url)
    if (seenUrls.has(dedupeKey)) continue
    seenUrls.add(dedupeKey)
    const kind = String(p.source_kind ?? '') as PostingSourceKind
    postings.push({
      company_name: company,
      company_domain: normalizeDomain(typeof p.company_domain === 'string' ? p.company_domain : null),
      title,
      location: typeof p.location === 'string' && p.location.trim() ? normalizeModelText(p.location) : null,
      url,
      source_kind: SOURCE_KINDS.includes(kind) ? kind : 'search_result',
      ats_hint: typeof p.ats_hint === 'string' && p.ats_hint.trim() ? normalizeModelText(p.ats_hint).toLowerCase() : null,
      season_hint: typeof p.season_hint === 'string' && p.season_hint.trim() ? normalizeModelText(p.season_hint) : null,
      why_relevant: normalizeModelText(p.why_relevant),
    })
  }

  const companies: CompanyToCheck[] = []
  const seenCompanies = new Set<string>()
  if (Array.isArray(r.companies_to_check)) {
    for (const entry of r.companies_to_check) {
      if (!entry || typeof entry !== 'object') continue
      const c = entry as Record<string, unknown>
      const name = normalizeModelText(c.name)
      if (!name) continue
      const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '')
      if (seenCompanies.has(key)) continue
      seenCompanies.add(key)
      companies.push({
        name,
        domain: normalizeDomain(typeof c.domain === 'string' ? c.domain : null),
        why: normalizeModelText(c.why),
      })
    }
  }

  const nextQuery = typeof r.next_query === 'string' && r.next_query.trim() ? normalizeModelText(r.next_query) : null

  return {
    postings,
    companies_to_check: companies.slice(0, 20),
    diagnosis,
    diagnosis_reasoning: normalizeModelText(r.diagnosis_reasoning),
    action,
    next_query: nextQuery,
    action_reasoning: normalizeModelText(r.action_reasoning),
    ungrounded_postings: ungrounded,
  }
}

export async function runJobScoutRound(
  input: JobScoutInput,
  ctx: ToolContext,
  opts: {
    tools: AgentTool<never>[]
    /** URLs the tools returned so far this session. Filled by buildScoutTools. */
    toolUrls: Set<string>
    /** Default true. False forces a live call (probes measuring real behaviour). */
    cache?: boolean
    onStep?: (info: { step: number; elapsedMs: number; stopReason: string | null; toolCalls: string[] }) => void
  }
): Promise<AgentResult<JobScoutRoundOutput>> {
  return runAgent<JobScoutInput, JobScoutRoundOutput>({
    agentId: 'job_scout',
    // Judging whether a surface is productive is the hard call here.
    tier: 'standard',
    modelRole: 'reasoning',
    prompt: jobScoutPrompt,
    input,
    outputSchema: OUTPUT_SCHEMA,
    validate: (raw, evidence) => validateRound(raw, evidence, opts.toolUrls),
    tools: opts.tools,
    ctx,
    webSearch: true,
    maxWebSearches: 4,
    maxSteps: 7,
    maxTokens: 8000,
    onStep: opts.onStep,
    // A replayed round carries its ALREADY-VALIDATED output — the URL pool was
    // checked when it was live — so caching is safe even though the tools do
    // not re-fill `toolUrls` on replay. The session keys on everything that
    // changes what the model sees.
    cacheKeyParts: opts.cache === false
      ? undefined
      : {
          strategy: input.strategy.name,
          kind: input.strategy.kind,
          mission: input.mission,
          query: input.currentQuery,
          round: input.history.length + 1,
          already: input.alreadyFound,
          target: input.targetCount,
        },
  })
}
