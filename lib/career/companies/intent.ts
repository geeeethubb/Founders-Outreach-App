// What a company means to the user — the semantic core of the watchlist.
//
// The rule this module exists to enforce: **an agent's guess is never a user
// preference.** The planner and the scout may only ever write `suggested`;
// `target` and `watching` come from an explicit click, and nothing infers them
// from prestige, rediscovery, ranking or fit (migration 016, ADR-039).
//
// It is also where "does it have an opening right now" stops being a status.
// That is state (`open_roles_count`, `last_careers_check_at`); intent is what
// the user wants. Conflating them is what let a check overwrite a target.
//
// Pure. No database, no network — every rule here is testable in memory.

import type { CompanyIntent, WatchOrigin, WatchStatus } from '@/lib/career/types'

export type { CompanyIntent, WatchOrigin }

/** Strength of intent. Higher wins when two writers disagree; `ignored` is a floor, not a value. */
export const INTENT_RANK: Record<CompanyIntent, number> = { ignored: 0, suggested: 1, watching: 2, target: 3 }

/** The only intent an agent may write. Everything above it needs a user action. */
export const AGENT_INTENT: CompanyIntent = 'suggested'

export const USER_INTENTS: CompanyIntent[] = ['target', 'watching', 'ignored']

/** Intents a scout run considers at all (ignored is excluded everywhere). */
export const ACTIVE_INTENTS: CompanyIntent[] = ['target', 'watching', 'suggested']

export const INTENT_LABEL: Record<CompanyIntent, string> = {
  target: 'Target',
  watching: 'Watching',
  suggested: 'Explore',
  ignored: 'Ignored',
}

export const INTENT_HINT: Record<CompanyIntent, string> = {
  target: 'you want to work here — checked first, every run',
  watching: 'worth keeping an eye on — checked regularly',
  suggested: "Scout thinks these may be worth a look — not preferences until you say so",
  ignored: 'left out of every run',
}

export const ORIGIN_LABEL: Record<WatchOrigin, string> = {
  user: 'added by you',
  planner: 'suggested by Scout’s plan',
  scout: 'found by Scout',
  outreach: 'from your contacts',
  import: 'imported',
}

/**
 * A stored `watch_status` as an intent. Pre-016 rows can still say
 * 'opening_available', which was a state wearing an intent's clothes — read it
 * as 'watching' (the user was checking it) and never write it again.
 */
export function normalizeIntent(status: WatchStatus | string | null | undefined): CompanyIntent | null {
  if (!status) return null
  if (status === 'opening_available') return 'watching'
  return (['target', 'watching', 'suggested', 'ignored'] as const).includes(status as CompanyIntent) ? (status as CompanyIntent) : null
}

/** True when this intent could only have come from the user. */
export function isUserIntent(intent: CompanyIntent | null | undefined): boolean {
  return !!intent && USER_INTENTS.includes(intent)
}

/**
 * What an agent-proposed intent may become, given what is already stored.
 * An agent never raises intent and never lowers a user's: a company the user
 * ignored stays ignored, a target stays a target, and everything else the
 * scout re-finds stays `suggested`.
 */
export function resolveAgentIntent(current: CompanyIntent | null, currentSource: string | null): CompanyIntent {
  if (!current) return AGENT_INTENT
  // The user owns their own rows outright — including `ignored`, so a company
  // they rejected is never re-added as anything.
  if (currentSource === 'user' || isUserIntent(current)) return current
  return AGENT_INTENT
}

// ─── Priority ────────────────────────────────────────────────────────────────
//
// One direction, everywhere: **higher is more important**, 0–100. The store
// orders descending, the scout sorts descending, and the Companies page used to
// sort ascending — which quietly checked the least important companies first.

export const PRIORITY_MIN = 0
export const PRIORITY_MAX = 100
export const PRIORITY_DEFAULT = 50

export function clampPriority(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return null
  return Math.max(PRIORITY_MIN, Math.min(PRIORITY_MAX, Math.round(n)))
}

/** Descending priority, then never-checked first, then name. Deterministic. */
export function byCheckOrder<T extends { watch_priority?: number | null; last_careers_check_at?: string | null; name: string }>(a: T, b: T): number {
  const pa = a.watch_priority ?? PRIORITY_DEFAULT
  const pb = b.watch_priority ?? PRIORITY_DEFAULT
  if (pa !== pb) return pb - pa
  const ca = a.last_careers_check_at ?? ''
  const cb = b.last_careers_check_at ?? ''
  if (ca !== cb) return ca.localeCompare(cb) // '' (never checked) sorts first
  return a.name.localeCompare(b.name)
}

// ─── Which companies a run checks ────────────────────────────────────────────

export interface SelectableCompany {
  id: string
  name: string
  watch_status?: WatchStatus | string | null
  watch_priority?: number | null
  last_careers_check_at?: string | null
}

export interface CompanySelection<T extends SelectableCompany> {
  selected: T[]
  counts: { target: number; watching: number; suggested: number }
  /** Companies eligible but not selected this run — they rotate in next time. */
  skipped: number
  reason: string
}

export interface SelectOptions {
  /** How many companies this run may check at all. */
  budget: number
  /**
   * The most of that budget an `explore` (suggested) sample may take. A large
   * accumulated list of guesses must never starve fresh discovery or the
   * companies the user actually chose. Default 40 %.
   */
  exploreShare?: number
  /** Always leave room for at least this many explore checks when any exist. Default 2. */
  minExplore?: number
}

/**
 * The companies a run checks, best first:
 *
 *   1. every Target (the user said they want to work there),
 *   2. then Watching,
 *   3. then a ROTATING sample of Explore — least-recently-checked first, so a
 *      hundred old guesses cannot consume the run, and different ones surface
 *      each time.
 *
 * `ignored` never appears. Pure and deterministic.
 */
export function selectCompaniesToCheck<T extends SelectableCompany>(companies: T[], opts: SelectOptions): CompanySelection<T> {
  const budget = Math.max(0, Math.floor(opts.budget))
  const exploreShare = opts.exploreShare ?? 0.4
  const minExplore = opts.minExplore ?? 2

  const byIntent = { target: [] as T[], watching: [] as T[], suggested: [] as T[] }
  for (const c of companies) {
    const intent = normalizeIntent(c.watch_status)
    if (!intent || intent === 'ignored') continue
    byIntent[intent].push(c)
  }
  for (const k of Object.keys(byIntent) as (keyof typeof byIntent)[]) byIntent[k].sort(byCheckOrder)

  const eligible = byIntent.target.length + byIntent.watching.length + byIntent.suggested.length
  if (budget === 0) {
    return { selected: [], counts: { target: 0, watching: 0, suggested: 0 }, skipped: eligible, reason: 'no company-first budget this run' }
  }

  const userRows = [...byIntent.target, ...byIntent.watching]

  // Explore is capped at a share of the budget and stays capped even when the
  // user's own rows do not fill the rest: the leftover slots are NOT handed to
  // a hundred old guesses, they are returned to the run for market discovery.
  // The cap can never squeeze out the user's rows either — with one slot and
  // one target, the target gets it.
  const exploreCap =
    byIntent.suggested.length === 0
      ? 0
      : Math.min(
          Math.max(minExplore, Math.floor(budget * exploreShare)),
          byIntent.suggested.length,
          Math.max(0, budget - (userRows.length > 0 ? 1 : 0))
        )

  const chosenUser = userRows.slice(0, Math.max(0, budget - exploreCap))
  const chosenExplore = byIntent.suggested.slice(0, Math.min(exploreCap, Math.max(0, budget - chosenUser.length)))
  const selected = [...chosenUser, ...chosenExplore]

  const counts = {
    target: selected.filter((c) => normalizeIntent(c.watch_status) === 'target').length,
    watching: selected.filter((c) => normalizeIntent(c.watch_status) === 'watching').length,
    suggested: selected.filter((c) => normalizeIntent(c.watch_status) === 'suggested').length,
  }
  const unused = budget - selected.length
  const reason =
    `${counts.target} target · ${counts.watching} watching · ${counts.suggested} explore (rotating, least recently checked)` +
    (eligible > selected.length ? ` · ${eligible - selected.length} left for a later run` : '') +
    (unused > 0 ? ` · ${unused} slot${unused === 1 ? '' : 's'} returned to market discovery` : '')
  return { selected, counts, skipped: eligible - selected.length, reason }
}

// ─── What the user's choices say about the companies they like ───────────────

export interface AttributeSource {
  name: string
  watch_status?: WatchStatus | string | null
  company_type?: string | null
  industry_tags?: string[] | null
}

export interface JobFeedbackSignal {
  verdict: string
  company_name?: string | null
  industry?: string | null
  role_family?: string | null
}

export interface LearnedAttributes {
  /** Company types and industry tags the user's own choices keep showing. */
  likedTypes: string[]
  likedTags: string[]
  likedCompanies: string[]
  dislikedTypes: string[]
  dislikedTags: string[]
  dislikedCompanies: string[]
  /** One line for a prompt, empty when there is nothing learned yet. */
  summary: string
}

const POSITIVE_VERDICTS = new Set(['love', 'interested'])
const NEGATIVE_VERDICTS = new Set(['not_interested', 'dismissed'])

function topByCount(values: string[], limit: number): string[] {
  const counts = new Map<string, number>()
  for (const raw of values) {
    const v = raw.trim()
    if (!v) continue
    counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([v]) => v)
}

/**
 * What the user's promotions and verdicts say about the KIND of company they
 * like — so the next plan can look for more like them instead of re-checking
 * the same names forever. Deliberately transparent: counted attributes the
 * user can see on the Companies page, not an opaque embedding (ADR-039).
 */
export function learnCompanyAttributes(companies: AttributeSource[], feedback: JobFeedbackSignal[] = [], limit = 6): LearnedAttributes {
  const liked: AttributeSource[] = []
  const disliked: AttributeSource[] = []
  for (const c of companies) {
    const intent = normalizeIntent(c.watch_status)
    if (intent === 'target' || intent === 'watching') liked.push(c)
    else if (intent === 'ignored') disliked.push(c)
  }

  const byName = new Map(companies.map((c) => [c.name.toLowerCase(), c]))
  const likedFeedbackTags: string[] = []
  const dislikedFeedbackTags: string[] = []
  const likedFeedbackCompanies: string[] = []
  const dislikedFeedbackCompanies: string[] = []
  for (const f of feedback) {
    const verdict = (f.verdict ?? '').toLowerCase()
    const name = (f.company_name ?? '').trim()
    const company = name ? byName.get(name.toLowerCase()) : undefined
    if (POSITIVE_VERDICTS.has(verdict)) {
      if (name) likedFeedbackCompanies.push(name)
      if (f.industry) likedFeedbackTags.push(f.industry)
      if (company) liked.push(company)
    } else if (NEGATIVE_VERDICTS.has(verdict)) {
      if (name) dislikedFeedbackCompanies.push(name)
      if (f.industry) dislikedFeedbackTags.push(f.industry)
    }
  }

  const likedTypes = topByCount(liked.map((c) => c.company_type ?? '').filter(Boolean), limit)
  const likedTags = topByCount([...liked.flatMap((c) => c.industry_tags ?? []), ...likedFeedbackTags], limit)
  const likedCompanies = topByCount([...liked.map((c) => c.name), ...likedFeedbackCompanies], limit)
  const dislikedTypes = topByCount(disliked.map((c) => c.company_type ?? '').filter(Boolean), limit)
  const dislikedTags = topByCount([...disliked.flatMap((c) => c.industry_tags ?? []), ...dislikedFeedbackTags], limit)
  const dislikedCompanies = topByCount([...disliked.map((c) => c.name), ...dislikedFeedbackCompanies], limit)

  const parts: string[] = []
  if (likedTypes.length) parts.push(`likes company types: ${likedTypes.join(', ')}`)
  if (likedTags.length) parts.push(`likes areas: ${likedTags.join(', ')}`)
  if (likedCompanies.length) parts.push(`chose: ${likedCompanies.join(', ')}`)
  if (dislikedTypes.length || dislikedTags.length) parts.push(`avoids: ${[...dislikedTypes, ...dislikedTags].join(', ')}`)
  if (dislikedCompanies.length) parts.push(`rejected: ${dislikedCompanies.join(', ')}`)

  return { likedTypes, likedTags, likedCompanies, dislikedTypes, dislikedTags, dislikedCompanies, summary: parts.join(' · ') }
}
