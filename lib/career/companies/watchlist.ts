// The watchlist: companies, what they mean to the user, and what we last saw
// on their careers page.
//
// The one rule this file exists to enforce (migration 016, ADR-039):
//
//   an agent may only ever write `suggested`, and never touches a row the user
//   owns. `target` / `watching` / `ignored` come from an explicit click, and
//   nothing — not the planner, not the scout, not a rediscovery, not a fit
//   score — infers them.
//
// The second rule: whether a company has an opening right now is STATE
// (`open_roles_count`, `last_careers_check_at`), not intent. A careers check
// therefore never writes `watch_status`; before 016 it did, and a nightly check
// could quietly overwrite a company the user had marked as a target.
//
// Every 016 column is written through `writeTolerant`, so a database that has
// not had the migration applied yet keeps working with the fields it has.
//
// And because migration 016 is applied BY HAND, the rule cannot live only in
// its `update` statements: until the founder runs it, the table still holds 163
// rows an agent wrote as `target`. `resolveStoredIntent` therefore applies the
// same correction on read — an agent-owned row can only ever mean `suggested`,
// whichever era the row was written in — so the page, the planner and the
// company-first budget all agree before the migration lands and after it.

import { createServiceClient } from '@/lib/supabase/server'
import { normalizeCompanyName, normalizeDomain } from '@/lib/providers/apollo/normalize'
import type { AtsType, CompanyIntent, WatchOrigin, WatchStatus } from '../types'
import { isMissingSchema, readTolerant, writeTolerant, type Db } from '../jobs/db'
import { AGENT_INTENT, byCheckOrder, clampPriority, isUserIntent, normalizeIntent, resolveAgentIntent } from './intent'

/** Columns migration 016 added. Stripped automatically when the database lacks them. */
export const INTENT_COLUMNS = ['watch_origin', 'watch_status_at', 'open_roles_count']

const BASE_COLUMNS =
  'id, name, domain, website_url, careers_url, ats_type, ats_identifier, watch_status, watch_priority, watch_note, watch_source, last_careers_check_at, careers_check_note, company_type, industry_tags'
const FULL_COLUMNS = `${BASE_COLUMNS}, watch_origin, watch_status_at, open_roles_count`
/** What the Companies page reads. `jobs` is an embedded count, not a column. */
const LIST_BASE = `${BASE_COLUMNS}, jobs:job_opportunities(count)`
const LIST_FULL = `${FULL_COLUMNS}, jobs:job_opportunities(count)`

// ─── Companies ───────────────────────────────────────────────────────────────

export interface EnsureCompanyInput {
  name: string
  domain?: string | null
  careers_url?: string | null
  ats?: { ats_type: AtsType; ats_identifier: string } | null
  company_type?: string | null
  website_url?: string | null
}

/**
 * Find-or-create a company by domain, else normalized name — the same keys
 * lib/scouting/persist.ts uses, so a job's company is the outreach's company.
 * It never touches `watch_status`: what a company means to the user is set by
 * `upsertWatch` (agents) or `setUserCompanyIntent` (the user), nowhere else.
 */
export async function ensureCompany(
  userId: string,
  input: EnsureCompanyInput,
  db: Db = createServiceClient()
): Promise<{ id: string | null; created: boolean; error: string | null; migrationMissing: boolean }> {
  const domain = normalizeDomain(input.domain)
  const normalizedName = normalizeCompanyName(input.name)
  const query = domain
    ? db.from('companies').select('id, watch_status, careers_url, ats_type, ats_identifier').eq('user_id', userId).eq('domain', domain)
    : db.from('companies').select('id, watch_status, careers_url, ats_type, ats_identifier').eq('user_id', userId).eq('normalized_name', normalizedName)
  const { data: existing, error: readErr } = await query.limit(1).maybeSingle()
  if (readErr) return { id: null, created: false, error: readErr.message, migrationMissing: isMissingSchema(readErr.message) }

  const patch: Record<string, unknown> = {}
  if (input.careers_url) patch.careers_url = input.careers_url
  if (input.ats) {
    patch.ats_type = input.ats.ats_type
    patch.ats_identifier = input.ats.ats_identifier
  }
  if (input.company_type) patch.company_type = input.company_type

  if (existing) {
    const row = existing as { id: string; careers_url: string | null; ats_type: string | null }
    // Keep a careers URL the user set; fill only blanks unless we found an ATS board.
    if (row.careers_url && !input.ats) delete patch.careers_url
    if (Object.keys(patch).length) {
      const { error } = await db.from('companies').update(patch as never).eq('id', row.id)
      if (error && !isMissingSchema(error.message)) return { id: row.id, created: false, error: error.message, migrationMissing: false }
    }
    return { id: row.id, created: false, error: null, migrationMissing: false }
  }

  const { data: created, error } = await db
    .from('companies')
    .insert({
      user_id: userId,
      name: input.name,
      domain,
      normalized_name: domain ? null : normalizedName,
      website_url: input.website_url ?? (domain ? `https://${domain}` : null),
      status: 'discovered',
      ...patch,
    } as never)
    .select('id')
    .maybeSingle()
  if (error) return { id: null, created: false, error: error.message, migrationMissing: isMissingSchema(error.message) }
  return { id: (created as { id: string } | null)?.id ?? null, created: true, error: null, migrationMissing: false }
}

// ─── Reading intent off a stored row ─────────────────────────────────────────

/** The writers whose rows are guesses. Their intent is capped at `suggested`. */
const AGENT_SOURCES = new Set(['planner', 'scout'])

export interface StoredIntentRow {
  watch_status?: unknown
  /** What the column held before a read corrected it, when a reader has already run. */
  watch_status_stored?: unknown
  watch_source?: unknown
  watch_origin?: unknown
}

function storedStatus(row: StoredIntentRow): CompanyIntent | null {
  const raw = row.watch_status_stored ?? row.watch_status
  return normalizeIntent(raw as WatchStatus | string | null | undefined)
}

/**
 * What a stored row actually means, whether or not migration 016 has run.
 *
 * `watch_status` alone cannot be trusted on a pre-016 database: the old build
 * wrote `target` from planner seeds and scout discoveries, so the live table
 * holds 163 "targets" no human ever chose. `watch_source` is the ownership
 * marker in BOTH eras — `upsertWatch` stamps `planner`/`scout`, and only
 * `setUserCompanyIntent` stamps `user` — so a row an agent owns resolves to
 * `suggested` here, exactly as migration 016's UPDATE would rewrite it.
 *
 * `ignored` is never re-interpreted: a rejection is only ever the user's.
 */
export function resolveStoredIntent(row: StoredIntentRow): CompanyIntent | null {
  const stored = storedStatus(row)
  if (!stored) return null
  if (stored === 'suggested' || stored === 'ignored') return stored
  const source = typeof row.watch_source === 'string' ? row.watch_source : null
  return AGENT_SOURCES.has(source ?? '') ? AGENT_INTENT : stored
}

/** True when the row says one thing and an agent wrote it — 016 has not corrected it yet. */
export function isReinterpreted(row: StoredIntentRow): boolean {
  const stored = storedStatus(row)
  return !!stored && stored !== resolveStoredIntent(row)
}

// ─── Reading the list ────────────────────────────────────────────────────────

export interface WatchlistResult {
  companies: Record<string, unknown>[]
  error: string | null
  migrationMissing: boolean
  /** false when the database predates migration 016 and has no intent columns. */
  intentColumns: boolean
  /**
   * How many rows an agent had written as `target`/`watching` and this read
   * corrected to `suggested`. Non-zero means migration 016 is still pending —
   * the number is surfaced, never quietly absorbed.
   */
  reinterpreted: number
}

export interface ListWatchlistOptions {
  /**
   * Include the rows the user ignored. The scout never wants them; the
   * Companies page does, because "Ignored" is a section you can promote out of
   * — without it, a mis-click is unrecoverable through the product.
   */
  includeIgnored?: boolean
}

/**
 * Everything the user has any intent about, best first.
 *
 * `suggested` rows are included — they are the scout's proposals, and hiding
 * them is what made the watchlist look like a list of 160 hand-picked targets.
 * `ignored` rows are excluded unless the caller asks for them.
 *
 * Every returned row carries the intent `resolveStoredIntent` read off it, in
 * `watch_status` as well as `intent`, so a reader that only knows the column
 * (the scout's `selectCompaniesToCheck`) gets the corrected answer too. The
 * value the database actually holds is kept in `watch_status_stored`.
 *
 * Ordered by `byCheckOrder`: priority DESC (higher = more important), then
 * never-checked first, then name. The SQL asks for the same order; the in-memory
 * sort makes it exact, so the store, the scout and the page cannot disagree.
 */
export async function listWatchlist(userId: string, db: Db = createServiceClient(), opts: ListWatchlistOptions = {}): Promise<WatchlistResult> {
  const read = await readTolerant<Record<string, unknown>>(LIST_FULL, LIST_BASE, (cols) => {
    let q = db.from('companies').select(cols).eq('user_id', userId).not('watch_status', 'is', null)
    if (!opts.includeIgnored) q = q.neq('watch_status', 'ignored')
    return q
      .order('watch_priority', { ascending: false, nullsFirst: false })
      .order('last_careers_check_at', { ascending: true, nullsFirst: true })
      .order('name', { ascending: true })
  })
  if (read.error) return { companies: [], error: read.error, migrationMissing: read.migrationMissing, intentColumns: read.full, reinterpreted: 0 }

  let reinterpreted = 0
  const companies: Record<string, unknown>[] = read.rows.map((row) => {
    const intent = resolveStoredIntent(row)
    if (intent && intent !== normalizeIntent(row.watch_status as WatchStatus | null)) reinterpreted++
    return { ...row, watch_status_stored: row.watch_status ?? null, watch_status: intent ?? row.watch_status ?? null, intent }
  })
  companies.sort((a, b) =>
    byCheckOrder(
      { watch_priority: a.watch_priority as number | null, last_careers_check_at: a.last_careers_check_at as string | null, name: String(a.name ?? '') },
      { watch_priority: b.watch_priority as number | null, last_careers_check_at: b.last_careers_check_at as string | null, name: String(b.name ?? '') }
    )
  )
  return { companies, error: null, migrationMissing: false, intentColumns: read.full, reinterpreted }
}

/** A stored row as the API and the UI read it: intent and origin resolved. */
export function toCompanyView(row: Record<string, unknown>): Record<string, unknown> {
  const { jobs, ...rest } = row as Record<string, unknown> & { jobs?: { count: number }[] }
  // The same correction listWatchlist applies, so a row read on its own (a
  // PATCH answer, say) can never claim an intent the list would deny it.
  const intent: CompanyIntent = resolveStoredIntent(rest) ?? AGENT_INTENT
  const source = typeof rest.watch_source === 'string' ? rest.watch_source : null
  const stored = typeof rest.watch_origin === 'string' ? (rest.watch_origin as WatchOrigin) : null
  const origin: WatchOrigin = stored ?? (source === 'user' || source === 'planner' || source === 'scout' ? source : 'import')
  return {
    ...rest,
    watch_status: intent,
    watch_status_stored: rest.watch_status_stored ?? rest.watch_status ?? null,
    watch_origin: origin,
    watch_status_at: rest.watch_status_at ?? null,
    open_roles_count: Number(rest.open_roles_count ?? 0),
    intent,
    origin,
    /** true when 016 has not yet rewritten a row an agent wrote as a target. */
    reinterpreted: isReinterpreted(rest),
    jobs_total: Number(jobs?.[0]?.count ?? 0),
  }
}

// ─── Writing intent ──────────────────────────────────────────────────────────

export interface UpsertWatchInput {
  name: string
  domain?: string | null
  careers_url?: string | null
  /** What the writer proposes. An agent's proposal is capped at `suggested`. */
  watch_status: WatchStatus
  watch_priority?: number | null
  watch_note?: string | null
  watch_source: 'planner' | 'user' | 'scout'
  /** How the company first entered the list. Kept once set. */
  watch_origin?: WatchOrigin
  ats?: { ats_type: AtsType; ats_identifier: string } | null
  company_type?: string | null
}

export interface UpsertWatchResult {
  id: string | null
  error: string | null
  migrationMissing: boolean
  /** The intent stored after the write — not necessarily the one proposed. */
  intent: CompanyIntent | null
  /** false when an agent proposal was refused because the user owns the row. */
  changed: boolean
  downgraded: string[]
}

function defaultOrigin(source: UpsertWatchInput['watch_source']): WatchOrigin {
  return source
}

/**
 * Put a company on the watchlist, or update the one that is there.
 *
 * `watch_source: 'user'` is an explicit choice and sets the intent outright.
 * `'planner'` and `'scout'` are guesses: they may only ever land `suggested`,
 * and a row the user owns (by source or by intent, including `ignored`) is left
 * exactly as it is — which is what makes an ignored company un-resurrectable.
 */
export async function upsertWatch(userId: string, input: UpsertWatchInput, now = new Date(), db: Db = createServiceClient()): Promise<UpsertWatchResult> {
  const c = await ensureCompany(userId, { name: input.name, domain: input.domain, careers_url: input.careers_url, ats: input.ats, company_type: input.company_type }, db)
  if (!c.id) return { id: null, error: c.error, migrationMissing: c.migrationMissing, intent: null, changed: false, downgraded: [] }

  const cur = await readTolerant<{ watch_status: WatchStatus | null; watch_source: string | null; watch_origin?: string | null }>(
    'watch_status, watch_source, watch_origin',
    'watch_status, watch_source',
    (cols) => db.from('companies').select(cols).eq('id', c.id as string).limit(1)
  )
  const row = cur.rows[0] ?? null
  // Read through the same correction the list applies: a pre-016 row an agent
  // wrote as `target` is a guess, so this write may heal it. Reading the raw
  // column here would make those 163 rows permanently untouchable instead.
  const currentIntent = row ? resolveStoredIntent(row) : null
  const currentSource = row?.watch_source ?? null
  const currentOrigin = (row?.watch_origin as WatchOrigin | null | undefined) ?? null
  const byUser = input.watch_source === 'user'

  let intent: CompanyIntent
  if (byUser) {
    intent = normalizeIntent(input.watch_status) ?? 'watching'
  } else {
    // Rule 2: an agent never raises a user's intent and never lowers it either.
    // `resolveAgentIntent` answers both questions at once — it hands back the
    // stored intent for a row the user owns, and `suggested` for everything
    // else — so a row it did not reduce to `suggested` is a row this write must
    // leave exactly as it found it. (`watch_source = 'user'` is checked too,
    // because a user may deliberately store `suggested`, which is what an agent
    // would also write: same value, different owner.)
    intent = resolveAgentIntent(currentIntent, currentSource)
    if (intent !== AGENT_INTENT || currentSource === 'user' || isUserIntent(currentIntent)) {
      return { id: c.id, error: null, migrationMissing: false, intent: currentIntent, changed: false, downgraded: [] }
    }
  }

  const patch: Record<string, unknown> = {
    watch_status: intent,
    watch_source: byUser ? 'user' : input.watch_source,
    watch_origin: currentOrigin ?? input.watch_origin ?? defaultOrigin(input.watch_source),
  }
  if (currentIntent !== intent) patch.watch_status_at = now.toISOString()
  if (input.watch_priority !== undefined) patch.watch_priority = clampPriority(input.watch_priority)
  if (input.watch_note !== undefined) patch.watch_note = input.watch_note

  const w = await writeTolerant(patch, INTENT_COLUMNS, (p) => db.from('companies').update(p as never).eq('id', c.id as string))
  if (w.error) return { id: c.id, error: w.error, migrationMissing: w.migrationMissing, intent: currentIntent, changed: false, downgraded: w.downgraded }
  return { id: c.id, error: null, migrationMissing: false, intent, changed: true, downgraded: w.downgraded }
}

export interface UserCompanyEdit {
  watch_status?: CompanyIntent
  watch_priority?: number | null
  watch_note?: string | null
  careers_url?: string | null
}

export interface UserCompanyResult {
  company: Record<string, unknown> | null
  error: string | null
  migrationMissing: boolean
  notFound: boolean
  downgraded: string[]
}

/**
 * The user's own edit. This is the ONLY path that writes `target`, `watching`
 * or `ignored`: it stamps `watch_source = 'user'` and `watch_status_at`, which
 * is what every agent write then reads and refuses to overrule.
 */
export async function setUserCompanyIntent(
  userId: string,
  companyId: string,
  edit: UserCompanyEdit,
  now = new Date(),
  db: Db = createServiceClient()
): Promise<UserCompanyResult> {
  const cur = await readTolerant<{ id: string; watch_status: WatchStatus | null; watch_source?: string | null; watch_origin?: string | null }>(
    'id, watch_status, watch_source, watch_origin',
    'id, watch_status, watch_source',
    (cols) => db.from('companies').select(cols).eq('user_id', userId).eq('id', companyId).limit(1)
  )
  if (cur.error) return { company: null, error: cur.error, migrationMissing: cur.migrationMissing, notFound: false, downgraded: [] }
  const row = cur.rows[0] ?? null
  if (!row) return { company: null, error: null, migrationMissing: false, notFound: true, downgraded: [] }

  const patch: Record<string, unknown> = {}
  if (edit.watch_status !== undefined) {
    patch.watch_status = edit.watch_status
    patch.watch_source = 'user'
    // Origin remembers where the company came from; a promotion does not erase
    // "found by Scout". Only a row with no origin at all becomes 'user'.
    patch.watch_origin = (row.watch_origin as WatchOrigin | null) ?? 'user'
    if (normalizeIntent(row.watch_status) !== edit.watch_status) patch.watch_status_at = now.toISOString()
  }
  if (edit.watch_priority !== undefined) patch.watch_priority = clampPriority(edit.watch_priority)
  if (edit.watch_note !== undefined) patch.watch_note = edit.watch_note
  if (edit.careers_url !== undefined) patch.careers_url = edit.careers_url

  const w = await writeTolerant(patch, INTENT_COLUMNS, (p) => db.from('companies').update(p as never).eq('user_id', userId).eq('id', companyId))
  if (w.error) return { company: null, error: w.error, migrationMissing: w.migrationMissing, notFound: false, downgraded: w.downgraded }

  const after = await readTolerant<Record<string, unknown>>(FULL_COLUMNS, BASE_COLUMNS, (cols) =>
    db.from('companies').select(cols).eq('user_id', userId).eq('id', companyId).limit(1)
  )
  const stored = after.rows[0] ?? null
  return { company: stored ? toCompanyView(stored) : null, error: after.error, migrationMissing: false, notFound: false, downgraded: w.downgraded }
}

// ─── Openings are state, not intent ──────────────────────────────────────────

export interface CareersCheck {
  note: string
  /** How many matching roles the board listed. */
  openings: number
  /**
   * false when the check could not tell (a listing error). `open_roles_count`
   * is then left alone: "we could not look" is not "there is nothing".
   */
  counted?: boolean
  /**
   * @deprecated Ignored since migration 016. An opening is state; intent is the
   * user's. Kept in the shape only so pre-016 callers still compile.
   */
  status?: WatchStatus | null
}

/**
 * Record a careers-page check. Writes `open_roles_count`,
 * `last_careers_check_at` and `careers_check_note` — and never `watch_status`.
 */
export async function markCareersChecked(companyId: string, check: CareersCheck, now = new Date(), db: Db = createServiceClient()): Promise<{ error: string | null }> {
  const counted = check.counted ?? true
  const patch: Record<string, unknown> = {
    last_careers_check_at: now.toISOString(),
    careers_check_note: counted ? `${check.note} (${check.openings} matching openings)` : check.note,
  }
  if (counted) patch.open_roles_count = Math.max(0, Math.round(check.openings))
  const w = await writeTolerant(patch, INTENT_COLUMNS, (p) => db.from('companies').update(p as never).eq('id', companyId))
  return { error: w.error }
}
