// Company-first discovery: for every company we are watching, detect the ATS
// and list its internships. No agent — this is the loop that makes "watching
// for an opening" possible (docs/CAREER_OS.md §5).
//
// A stored ats_type/ats_identifier skips detection entirely: one JSON call per
// company per day, cached. Detection only runs for companies we have never
// resolved, and its result is written back so the next run is the cheap path.

import { mapWithConcurrency } from '@/lib/scouting/concurrency'
import type { SeedCompany } from '@/lib/agents/job-mission-planner'
import type { AtsType, WatchOrigin, WatchStatus } from '../types'
import { normalizeCompanyName } from '../jobs/normalize'
import { ensureCompany, markCareersChecked, upsertWatch, type UpsertWatchInput } from '../companies/watchlist'
import { detectAtsForCompany } from '../sources/detect'
import { getPageFetcher } from '../sources/fetch'
import { getSourceRegistry } from '../sources/registry'
import type { AtsBoardRef, PageFetcher, RawJobPosting, SourceRegistry } from '../sources/types'
import { INTERNSHIP_LOOKUP_LIMIT, LOOKUP_POSTING_LIMIT } from './tools'

/**
 * ATS families a stored `ats_type` can be trusted to list directly.
 *
 * It is derived from the registry rather than written out, so an adapter S1
 * adds — Workday, say — is usable by every stored row the day it lands, with
 * no edit here. A stored type with no adapter falls through to detection,
 * which is the honest answer: we cannot list it, so look again.
 */
function adaptedAtsTypes(registry: SourceRegistry): Set<string> {
  return new Set(registry.adapters().map((a) => a.id))
}

export interface WatchedCompany {
  id: string
  name: string
  domain: string | null
  careers_url: string | null
  ats_type: string | null
  ats_identifier: string | null
  /** Intent, never state (migration 016). Nothing in this file writes it. */
  watch_status?: WatchStatus | null
  watch_origin?: WatchOrigin | null
  /** Openings at the last check — state, written by `markCareersChecked`. */
  open_roles_count?: number | null
  /** Higher = more important, 0–100 (lib/career/companies/intent.ts). */
  watch_priority?: number | null
  last_careers_check_at?: string | null
}

/** The persistence the loop needs — injectable so the whole thing runs in memory under test. */
export interface CompanyFirstStore {
  markCareersChecked: typeof markCareersChecked
  ensureCompany: (userId: string, input: { name: string; domain?: string | null; careers_url?: string | null; ats?: { ats_type: AtsType; ats_identifier: string } | null }) => Promise<{ id: string | null; error: string | null; migrationMissing: boolean }>
  upsertWatch: (userId: string, input: UpsertWatchInput) => Promise<{ id: string | null; error: string | null; migrationMissing: boolean }>
}

export interface CompanyFirstDeps {
  registry?: SourceRegistry
  fetcher?: PageFetcher
  store?: CompanyFirstStore
  bypassCache?: boolean
}

export function liveCompanyFirstStore(): CompanyFirstStore {
  return {
    markCareersChecked,
    ensureCompany: (userId, input) => ensureCompany(userId, input),
    upsertWatch,
  }
}

export interface CompanyCheckResult {
  companyId: string
  name: string
  postings: RawJobPosting[]
  board: AtsBoardRef | null
  method: 'stored' | 'url' | 'slug' | 'careers_scan' | 'none'
  note: string
  error: string | null
}

export interface CheckCompanyOptions {
  internshipsOnly?: boolean
  bypassCache?: boolean
  /**
   * Postings to keep per board, AFTER the internship filter. Defaults to the
   * scout tool's depth; the watchlist sweep raises it, because a board listing
   * is one JSON request whatever the cap and a company running fifty
   * internships must not be cut to the first few.
   */
  limit?: number
  /**
   * Skip ATS detection: check only companies whose board is already stored.
   * Detection costs slug probes and careers-page fetches, which is the slow,
   * rude part of a sweep; a cheap pass turns it off and reports the companies
   * it therefore did not check.
   */
  storedBoardsOnly?: boolean
}

export async function checkCompanyForOpenings(
  userId: string,
  company: WatchedCompany,
  opts: CheckCompanyOptions = {},
  deps: CompanyFirstDeps = {}
): Promise<CompanyCheckResult> {
  const registry = deps.registry ?? getSourceRegistry()
  const fetcher = deps.fetcher ?? getPageFetcher()
  const store = deps.store ?? liveCompanyFirstStore()
  const internshipsOnly = opts.internshipsOnly ?? true
  const base = { companyId: company.id, name: company.name }

  let board: AtsBoardRef | null = null
  let method: CompanyCheckResult['method'] = 'none'
  let note = ''
  let careersUrl = company.careers_url

  if (company.ats_type && company.ats_identifier && adaptedAtsTypes(registry).has(company.ats_type)) {
    board = { ats: company.ats_type as AtsType, identifier: company.ats_identifier, company_name: company.name, board_url: company.careers_url ?? undefined }
    method = 'stored'
  } else if (opts.storedBoardsOnly) {
    // Not an error and not a check: say so, and leave `last_careers_check_at`
    // alone so the next pass that CAN detect still treats it as never checked.
    return { ...base, postings: [], board: null, method: 'none', note: 'no stored board and detection was skipped', error: null }
  } else {
    const detection = await detectAtsForCompany(
      { companyName: company.name, domain: company.domain, careersUrl: company.careers_url },
      { registry, fetcher, bypassCache: opts.bypassCache ?? deps.bypassCache }
    )
    board = detection.board
    method = detection.method
    careersUrl = detection.careers_url ?? careersUrl
    if (!board) {
      note = `no public board detected (${detection.attempts.slice(0, 3).join('; ') || 'nothing tried'})`
      if (detection.hints.length) note += ` · hints: ${detection.hints.slice(0, 2).join('; ')}`
    }
  }

  if (!board) {
    // A careers page without a board is still worth remembering, and the check still counts.
    if (careersUrl && careersUrl !== company.careers_url) await store.ensureCompany(userId, { name: company.name, domain: company.domain, careers_url: careersUrl })
    await store.markCareersChecked(company.id, { note: note || 'no board', openings: 0 })
    return { ...base, postings: [], board: null, method, note, error: null }
  }

  const adapter = registry.byId(board.ats)
  if (!adapter) {
    note = `board on ${board.ats} has no listing adapter; recorded the board URL`
    await store.ensureCompany(userId, { name: company.name, domain: company.domain, careers_url: board.board_url ?? careersUrl, ats: { ats_type: board.ats, ats_identifier: board.identifier } })
    await store.markCareersChecked(company.id, { note, openings: 0 })
    return { ...base, postings: [], board, method, note, error: null }
  }

  // The cap runs after the internship filter; the same depth the scout's lookup tool uses, for the same reason (tools.ts).
  const limit = opts.limit ?? (internshipsOnly ? INTERNSHIP_LOOKUP_LIMIT : LOOKUP_POSTING_LIMIT)
  const listing = await adapter.listPostings(board, { internshipsOnly, limit })
  if (listing.error) {
    // A failed listing says nothing about openings: record that we looked, but
    // no count — "we could not tell" is not "there is nothing".
    note = `listing failed: ${listing.error}`
    await store.markCareersChecked(company.id, { note, openings: 0, counted: false })
    return { ...base, postings: [], board, method, note, error: listing.error }
  }

  const postings = listing.postings
  note = `${board.ats}/${board.identifier}: ${postings.length} matching of ${listing.total_on_board}`
  if (method !== 'stored') {
    await store.ensureCompany(userId, { name: company.name, domain: company.domain, careers_url: listing.board_url ?? board.board_url ?? careersUrl, ats: { ats_type: board.ats, ats_identifier: board.identifier } })
  }
  // Openings are STATE (migration 016): this records how many are open, and
  // never what the company means to the user.
  await store.markCareersChecked(company.id, { note, openings: postings.length })
  return { ...base, postings, board, method, note, error: null }
}

export interface CompanyFirstResult {
  postings: RawJobPosting[]
  outcomes: CompanyCheckResult[]
  checked: number
  withOpenings: number
  errors: string[]
  deadlineHit: boolean
}

export async function runCompanyFirst(
  userId: string,
  companies: WatchedCompany[],
  opts: CheckCompanyOptions & { concurrency?: number; deadline?: number; maxCompanies?: number; onProgress?: (detail: string) => void } = {},
  deps: CompanyFirstDeps = {}
): Promise<CompanyFirstResult> {
  // The caller decides WHICH companies and in what order — targets first, then
  // watching, then a rotating sample of explore (selectCompaniesToCheck). This
  // loop only takes the first `max` of what it is handed.
  const max = opts.maxCompanies ?? 25
  const queue = companies.slice(0, max)
  const outcomes: CompanyCheckResult[] = []
  const errors: string[] = []
  let deadlineHit = false

  await mapWithConcurrency(queue, opts.concurrency ?? 4, async (company) => {
    if (opts.deadline && Date.now() > opts.deadline) {
      deadlineHit = true
      return
    }
    try {
      const r = await checkCompanyForOpenings(
        userId,
        company,
        { internshipsOnly: opts.internshipsOnly ?? true, limit: opts.limit, storedBoardsOnly: opts.storedBoardsOnly, bypassCache: opts.bypassCache },
        deps
      )
      outcomes.push(r)
      if (r.error) errors.push(`${company.name}: ${r.error}`)
      opts.onProgress?.(`${company.name}: ${r.postings.length} openings (${r.method})`)
    } catch (e) {
      errors.push(`${company.name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  })

  return {
    postings: outcomes.flatMap((o) => o.postings),
    outcomes,
    checked: outcomes.length,
    withOpenings: outcomes.filter((o) => o.postings.length > 0).length,
    errors,
    deadlineHit,
  }
}

/**
 * Planner seeds → watchlist rows, skipping names already present.
 *
 * Every seed lands as `suggested` with origin `planner`: the planner is
 * guessing at the KIND of company that fits the mission, and a guess is not a
 * preference. Only the user promotes one to Watching or Target.
 */
export async function seedWatchlistFromPlan(
  userId: string,
  seeds: SeedCompany[],
  existingNames: string[],
  deps: Pick<CompanyFirstDeps, 'store'> = {}
): Promise<{ added: number; skipped: number; errors: string[]; migrationMissing: boolean }> {
  const store = deps.store ?? liveCompanyFirstStore()
  const present = new Set(existingNames.map((n) => normalizeCompanyName(n) ?? n.toLowerCase()))
  let added = 0
  let skipped = 0
  const errors: string[] = []
  for (const seed of seeds) {
    const key = normalizeCompanyName(seed.name) ?? seed.name.toLowerCase()
    if (present.has(key)) {
      skipped++
      continue
    }
    const r = await store.upsertWatch(userId, {
      name: seed.name,
      domain: seed.domain,
      // A planner seed is a hypothesis, never a preference (rule 1, ADR-039).
      watch_status: 'suggested',
      watch_source: 'planner',
      watch_origin: 'planner',
      watch_priority: Math.round(Math.max(0, Math.min(1, seed.priority)) * 100),
      watch_note: seed.why.slice(0, 300),
      company_type: seed.company_type || null,
    })
    if (r.migrationMissing) return { added, skipped, errors: [...errors, r.error ?? 'migration missing'], migrationMissing: true }
    if (r.error) errors.push(`${seed.name}: ${r.error}`)
    else {
      added++
      present.add(key)
    }
  }
  return { added, skipped, errors, migrationMissing: false }
}
