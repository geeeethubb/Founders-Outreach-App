// Reading the watchlist as intent — the pure half of the Companies page.
//
// The list is inspiration and memory, not truth. Most rows on it were the
// scout's idea; a handful are the user's own choices, and only those are
// preferences. This module keeps the two apart on screen exactly as
// lib/career/companies/intent.ts keeps them apart in the data, and orders every
// section the one way the whole system orders it: **higher priority first**.
//
// Pure. No fetch, no React, no database.

import { byCheckOrder, INTENT_HINT, INTENT_LABEL, normalizeIntent, ORIGIN_LABEL, PRIORITY_DEFAULT, type CompanyIntent, type WatchOrigin } from '@/lib/career/companies/intent'

export interface CompanyView {
  id: string
  name: string
  domain: string | null
  website_url: string | null
  careers_url: string | null
  ats_type: string | null
  ats_identifier: string | null
  watch_status: string | null
  watch_priority: number | null
  watch_note: string | null
  watch_source: string | null
  /** Migration 016. Absent on a database where it is not applied yet. */
  watch_origin?: string | null
  watch_status_at?: string | null
  /** Migration 016: openings are state, not intent. */
  open_roles_count?: number | null
  /** The API's own reading of the row (GET /api/career/companies). Preferred when present. */
  intent?: string | null
  origin?: string | null
  last_careers_check_at: string | null
  careers_check_note: string | null
  company_type: string | null
  industry_tags: string[] | null
  jobs_total: number
  open_internships: number
}

/** The intent a row carries. Anything unreadable is a suggestion, never a preference. */
export function intentOf(c: CompanyView): CompanyIntent {
  return normalizeIntent(c.intent) ?? normalizeIntent(c.watch_status) ?? 'suggested'
}

const ORIGINS: WatchOrigin[] = ['user', 'planner', 'scout', 'outreach', 'import']

/**
 * How a row got onto the list. `watch_origin` is migration 016's answer; before
 * it is applied the same question is answered by `watch_source`, the same way
 * the migration itself derives it.
 */
export function originOf(c: CompanyView): WatchOrigin {
  if (ORIGINS.includes(c.origin as WatchOrigin)) return c.origin as WatchOrigin
  if (ORIGINS.includes(c.watch_origin as WatchOrigin)) return c.watch_origin as WatchOrigin
  if (ORIGINS.includes(c.watch_source as WatchOrigin)) return c.watch_source as WatchOrigin
  return c.watch_status ? 'user' : 'outreach'
}

/**
 * Fold a PATCH answer into the row the page is holding. The edit routes answer
 * with the stored company, which carries intent and origin but not the page's
 * derived counts — so those are never taken from a patch, and a promotion can
 * not silently blank "3 open roles".
 */
const PATCH_IGNORED = new Set(['jobs_total', 'open_internships'])

export function mergeCompanyPatch(prev: CompanyView, incoming: Record<string, unknown> | null | undefined): CompanyView {
  const next: Record<string, unknown> = { ...prev }
  for (const [k, v] of Object.entries(incoming ?? {})) {
    if (v === undefined || PATCH_IGNORED.has(k)) continue
    next[k] = v
  }
  return next as unknown as CompanyView
}

export function originLabel(c: CompanyView): string {
  return ORIGIN_LABEL[originOf(c)]
}

/** Openings this page knows about — the careers check's count, or the stored open roles. For display. */
export function openRoles(c: CompanyView): number {
  return Math.max(careersOpenRoles(c), Number(c.open_internships ?? 0) || 0)
}

/**
 * Openings a careers check itself found (`open_roles_count`, migration 016) —
 * and nothing else.
 *
 * This is what lifts a company into the "Opening available" section, and it is
 * deliberately narrower than `openRoles`. `open_internships` counts the postings
 * already stored for that company, which is how most of them were discovered in
 * the first place: sectioning on it put the whole Explore list above the
 * founder's own Targets, on a page whose job is to keep those apart. Before 016
 * this is 0 and the section is simply empty.
 */
export function careersOpenRoles(c: CompanyView): number {
  return Number(c.open_roles_count ?? 0) || 0
}

/** True when the row is the user's own decision rather than the scout's guess. */
export function isUserChoice(c: CompanyView): boolean {
  const intent = intentOf(c)
  return intent === 'target' || intent === 'watching' || intent === 'ignored'
}

export type SectionKey = 'opening' | 'target' | 'watching' | 'suggested' | 'ignored'

export interface CompanySection {
  key: SectionKey
  title: string
  hint: string
  rows: CompanyView[]
  /** Long sections start collapsed; the page shows a count and a "show all". */
  collapsible: boolean
}

const SECTION_META: Record<SectionKey, { title: string; hint: string }> = {
  opening: { title: 'Opening available', hint: 'a careers check found a role open right now' },
  target: { title: 'Targets', hint: 'companies you specifically want to work at' },
  watching: { title: 'Watching', hint: 'you asked to keep an eye on these' },
  suggested: { title: 'Explore', hint: INTENT_HINT.suggested },
  // GET /api/career/companies returns ignored rows (only `?include=active`
  // leaves them out), so this section survives a reload and the undo it offers
  // is real. The scout still never sees them.
  ignored: { title: 'Ignored', hint: 'left out of every run — promote one to bring it back' },
}

/**
 * The four sections, in the order the page shows them, plus Ignored so a
 * rejection can be undone while the page is still open. A company appears
 * exactly once: a confirmed opening is state and outranks intent for placement,
 * and each row still shows its own intent.
 */
export function groupCompanies(rows: CompanyView[]): CompanySection[] {
  const buckets: Record<SectionKey, CompanyView[]> = { opening: [], target: [], watching: [], suggested: [], ignored: [] }
  for (const c of rows) {
    const intent = intentOf(c)
    if (intent === 'ignored') buckets.ignored.push(c)
    else if (careersOpenRoles(c) > 0) buckets.opening.push(c)
    else buckets[intent].push(c)
  }
  const order: SectionKey[] = ['opening', 'target', 'watching', 'suggested', 'ignored']
  return order.map((key) => ({
    key,
    title: SECTION_META[key].title,
    hint: SECTION_META[key].hint,
    rows: buckets[key].sort(byCheckOrder),
    collapsible: key === 'suggested' || key === 'ignored',
  }))
}

/** How many rows of a collapsible section are shown before "show all". */
export const COLLAPSED_ROWS = 8

/** One line under the page title: what the list is, in the founder's words. */
export const WATCHLIST_LEAD =
  'Companies are one input into a scout run, not the search. Scout keeps a list of places it thinks are worth a look; promoting one to Target or Watching is what makes it your preference.'

/** The badge text for a row's intent. */
export function intentLabel(c: CompanyView): string {
  return INTENT_LABEL[intentOf(c)]
}

export function priorityOf(c: CompanyView): number {
  return c.watch_priority ?? PRIORITY_DEFAULT
}
