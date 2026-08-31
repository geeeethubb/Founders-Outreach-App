// Offline tests for the watchlist sweep and deferred extraction.
//
//   npx tsx scripts/test-career-sweep.ts
//
// No network, no keys, no database. The ATS adapters are stubs, the page
// fetcher is a stub, and `upsertJobs` runs against an in-memory PostgREST
// double — which matters, because the contract this workstream turns on is a
// store contract: **a thin copy must never erase a richer row.** Asserting that
// against a hand-written fake store would only prove the fake.
//
// What is asserted, in the order the strategy depends on it:
//
//   1. inventory scales      — 200 synthetic companies, all persisted, bounded
//                              concurrency, one dead board does not stop it
//   2. inventory is free     — no model call is reachable from the sweep
//   3. a thin row is real    — stored without an extraction, listable, and a
//                              re-listing cannot walk back what an extraction
//                              already learned
//   4. money follows         — extractPending takes the highest-relevance
//                              unextracted rows and stops at its limit
//   5. it is safe to repeat  — a re-sweep inserts nothing and moves last_seen
//   6. it is safe to stop    — a deadline keeps everything already stored

import { buildNormalizedJob, detectEmploymentType, type NormalizedJob } from '../lib/career/jobs/normalize'
import { jobRelevance, byRelevance, extractionPatch, looksLikeInternship } from '../lib/career/jobs/relevance'
import { orderForSweep, summarizeSweep, sweepWatchlist, type SweepCompany, type SweepStore } from '../lib/career/jobs/sweep'
import { upsertJobs, type Db } from '../lib/career/jobs/store'
import { extractPending, type PendingExtractionStore } from '../lib/career/scout/extract'
import type { ExtractionCandidate } from '../lib/career/jobs/extraction-store'
import { createSourceRegistry } from '../lib/career/sources/registry'
import type { JobSourceAdapter, PageFetcher, RawJobPosting } from '../lib/career/sources/types'
import { defaultMission } from '../lib/career/missions/store'
import { directionTerms } from '../lib/career/scout/direction'
import type { CareerMission, ExtractedJobFields } from '../lib/career/types'
import type { AgentResult } from '../lib/agents/runtime/types'
import type { JobExtraction } from '../lib/agents/job-extractor'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const USER = 'user-sweep'
const MISSION: CareerMission = { ...defaultMission(USER), id: 'mission-sweep', created_at: '', updated_at: '' }
const CTX = { user_id: USER, run_id: null, budget: { maxCompanies: 0, maxPeoplePerCompany: 0, maxApolloCalls: 0, maxWebSearches: 0, maxAgentSteps: 0 } }
const JD = 'Process Engineer Intern, Summer 2027, San Francisco. You will own process improvement work in our pilot plant, run experiments and present results to the engineering team. Requirements: pursuing a BS in chemical or mechanical engineering. '.repeat(3)

// ─── An in-memory PostgREST double ───────────────────────────────────────────
//
// Only the subset lib/career/jobs/store.ts actually calls: select/eq/neq/is/
// not/in/ilike/order/limit/range/maybeSingle, update, insert, upsert. Anything
// it does not implement throws rather than silently returning nothing, so a
// query the store adds later fails loudly here instead of passing vacuously.

type Row = Record<string, unknown>

interface Filter {
  kind: 'eq' | 'neq' | 'is' | 'not-is' | 'in' | 'ilike'
  col: string
  value: unknown
}

function matches(row: Row, f: Filter): boolean {
  const v = row[f.col]
  switch (f.kind) {
    case 'eq': return v === f.value
    case 'neq': return v !== f.value
    case 'is': return v === f.value || (f.value === null && (v === null || v === undefined))
    case 'not-is': return !(v === null || v === undefined)
    case 'in': return Array.isArray(f.value) && (f.value as unknown[]).includes(v)
    // The store escapes LIKE wildcards; the double compares case-insensitively
    // on the unescaped literal, which is what an escaped pattern means.
    case 'ilike': return String(v ?? '').toLowerCase() === String(f.value).replace(/\\([%_\\])/g, '$1').toLowerCase()
  }
}

class MemoryQuery implements PromiseLike<{ data: unknown; error: { message: string } | null; count?: number | null }> {
  private filters: Filter[] = []
  private op: 'select' | 'update' | 'insert' | 'upsert' = 'select'
  private payload: Row[] = []
  private cap: number | null = null
  private sortBy: { col: string; asc: boolean } | null = null
  private wantCount = false
  private returning = false

  constructor(private table: Row[], private db: MemoryDb, private name: string) {}

  select(_cols?: string, opts?: { count?: string }) {
    if (this.op === 'select') this.op = 'select'
    else this.returning = true
    if (opts?.count) this.wantCount = true
    return this
  }
  eq(col: string, value: unknown) { this.filters.push({ kind: 'eq', col, value }); return this }
  neq(col: string, value: unknown) { this.filters.push({ kind: 'neq', col, value }); return this }
  is(col: string, value: unknown) { this.filters.push({ kind: 'is', col, value }); return this }
  not(col: string, _op: string, _value: unknown) { this.filters.push({ kind: 'not-is', col, value: null }); return this }
  in(col: string, value: unknown[]) { this.filters.push({ kind: 'in', col, value }); return this }
  ilike(col: string, value: string) { this.filters.push({ kind: 'ilike', col, value }); return this }
  order(col: string, opts?: { ascending?: boolean }) { this.sortBy = { col, asc: opts?.ascending !== false }; return this }
  limit(n: number) { this.cap = n; return this }
  range(_a: number, _b: number) { return this }
  update(patch: Row) { this.op = 'update'; this.payload = [patch]; return this }
  insert(rows: Row | Row[]) { this.op = 'insert'; this.payload = Array.isArray(rows) ? rows : [rows]; return this }
  upsert(rows: Row | Row[], _opts?: unknown) { this.op = 'upsert'; this.payload = Array.isArray(rows) ? rows : [rows]; return this }

  private rows(): Row[] {
    let out = this.table.filter((r) => this.filters.every((f) => matches(r, f)))
    if (this.sortBy) {
      const { col, asc } = this.sortBy
      out = [...out].sort((a, b) => String(a[col] ?? '').localeCompare(String(b[col] ?? '')) * (asc ? 1 : -1))
    }
    if (this.cap != null) out = out.slice(0, this.cap)
    return out
  }

  private run(): { data: unknown; error: { message: string } | null; count?: number | null } {
    if (this.op === 'select') {
      const rows = this.rows()
      return { data: rows, error: null, count: this.wantCount ? rows.length : null }
    }
    if (this.op === 'update') {
      const hit = this.rows()
      for (const r of hit) Object.assign(r, this.payload[0])
      this.db.writes.push({ table: this.name, op: 'update', n: hit.length })
      return { data: hit, error: null }
    }
    // insert / upsert
    const added: Row[] = []
    for (const r of this.payload) {
      if (this.name === 'job_sources' || this.name === 'scouting_run_jobs') {
        const key = this.name === 'job_sources' ? `${r.job_id}|${r.source_url}` : `${r.run_id}|${r.job_id}`
        if (this.db.uniques.has(`${this.name}:${key}`)) continue
        this.db.uniques.add(`${this.name}:${key}`)
      }
      const row: Row = { id: `${this.name}-${this.db.nextId++}`, ...r }
      this.table.push(row)
      added.push(row)
    }
    this.db.writes.push({ table: this.name, op: this.op, n: added.length })
    return { data: added, error: null, count: added.length }
  }

  async maybeSingle() {
    const r = this.run()
    const rows = (r.data ?? []) as Row[]
    return { data: rows[0] ?? null, error: r.error }
  }
  async single() {
    return this.maybeSingle()
  }
  then<A, B = never>(
    ok?: ((v: { data: unknown; error: { message: string } | null; count?: number | null }) => A | PromiseLike<A>) | null,
    err?: ((r: unknown) => B | PromiseLike<B>) | null
  ): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(ok, err)
  }
}

class MemoryDb {
  tables: Record<string, Row[]> = {}
  writes: { table: string; op: string; n: number }[] = []
  uniques = new Set<string>()
  nextId = 1
  from(name: string) {
    this.tables[name] ??= []
    return new MemoryQuery(this.tables[name], this, name)
  }
}

const asDb = (m: MemoryDb) => m as unknown as Db

// ─── Stub sources ────────────────────────────────────────────────────────────

interface BoardSpec {
  postings: RawJobPosting[]
  fail?: string
  delayMs?: number
}

function posting(company: string, id: string, over: Partial<RawJobPosting> = {}): RawJobPosting {
  const url = `https://boards.greenhouse.io/${company}/jobs/${id}`
  return {
    source_type: 'greenhouse', source_url: url, external_id: id, company_name: company, company_domain: `${company}.com`,
    title: 'Process Engineer Intern', location_raw: 'San Francisco, CA', description_text: JD, description_html: null,
    department: null, posted_at: null, updated_at: null, apply_url: url, canonical_url: url,
    ats_type: 'greenhouse', ats_job_id: id, requisition_id: null, employment_type_hint: 'Intern',
    raw: {}, retrieved_at: new Date().toISOString(), ...over,
  }
}

function stubRegistry(boards: Map<string, BoardSpec>, track?: { inFlight: number; peak: number; listed: string[] }) {
  const adapter: JobSourceAdapter = {
    id: 'greenhouse', source_type: 'greenhouse', isAvailable: () => true,
    matchUrl: () => null,
    async detectBoard() { return null },
    async listPostings(board, options) {
      if (track) {
        track.inFlight++
        track.peak = Math.max(track.peak, track.inFlight)
        track.listed.push(board.identifier)
      }
      try {
        const spec = boards.get(board.identifier)
        if (spec?.delayMs) await new Promise((r) => setTimeout(r, spec.delayMs))
        if (!spec) return { postings: [], total_on_board: 0, board_url: null, note: 'unknown board' }
        // A board that throws, not one that answers politely: the sweep must
        // survive the rude failure as well as the tidy one.
        if (spec.fail === 'throw') throw new Error('board exploded')
        if (spec.fail) return { postings: [], total_on_board: 0, board_url: null, error: spec.fail }
        const kept = options?.internshipsOnly ? spec.postings.filter((p) => /intern/i.test(p.title)) : spec.postings
        return { postings: options?.limit ? kept.slice(0, options.limit) : kept, total_on_board: spec.postings.length, board_url: `https://boards.greenhouse.io/${board.identifier}` }
      } finally {
        if (track) track.inFlight--
      }
    },
    async fetchPosting() { return { status: 'not_found', posting: null, note: 'n/a' } },
  }
  return createSourceRegistry([adapter])
}

const NEVER_FETCH: PageFetcher = {
  async fetch(url) {
    throw new Error(`the sweep must not fetch pages in these tests: ${url}`)
  },
}

/** A SweepStore backed by the memory database, so `upsertJobs` is the real one. */
function memoryStore(db: MemoryDb, companies: SweepCompany[]) {
  const checked: { id: string; note: string; openings: number }[] = []
  const store: SweepStore = {
    async listWatchlist() {
      return { companies: companies as unknown as Row[], error: null, migrationMissing: false }
    },
    async markCareersChecked(id, info) {
      checked.push({ id, note: info?.note ?? '', openings: info?.openings ?? 0 })
      return { error: null, migrationMissing: false, downgraded: [] } as never
    },
    async ensureCompany() {
      return { id: null, error: null, migrationMissing: false }
    },
    async upsertWatch() {
      return { id: null, error: null, migrationMissing: false }
    },
    upsertJobs: (userId, jobs, opts) => upsertJobs(userId, jobs, opts, asDb(db)),
  }
  return { store, checked }
}

function company(i: number, over: Partial<SweepCompany> = {}): SweepCompany {
  const slug = `co${i}`
  return {
    id: `c-${i}`, name: `Company ${i}`, domain: `${slug}.com`, careers_url: null,
    ats_type: 'greenhouse', ats_identifier: slug, watch_status: 'suggested', watch_priority: 50,
    last_careers_check_at: null, intent: 'suggested', ...over,
  }
}

async function main() {
  // ─── Relevance ─────────────────────────────────────────────────────────────
  console.log('relevance')
  {
    const base = { title: 'Process Engineer Intern', company_name: 'Acme', role_family: 'process_engineering', season_relevance: 'summer_2027', location_tier: 1, employment_type: 'internship', verification_status: 'VERIFIED_OPEN' }
    check('a perfect posting scores every term', jobRelevance(base) === 20 + 25 + 10 + 15 + 5, String(jobRelevance(base)))
    check('a different season is pushed to the bottom', jobRelevance({ ...base, season_relevance: 'other_season' }) < jobRelevance({ ...base, season_relevance: 'unspecified' }))
    check('an unspecified season still beats no season at all', jobRelevance({ ...base, season_relevance: 'unspecified' }) > jobRelevance({ ...base, season_relevance: 'unknown' }))
    check('a full-time role is not internship-shaped', !looksLikeInternship({ title: 'Process Engineer Intern Mentor', employment_type: 'full_time' }))
    check('a listing-only row is not penalised for being thin', jobRelevance({ ...base, description_text: null }) === jobRelevance({ ...base, description_text: JD }))
    const terms = directionTerms('semiconductor manufacturing')
    const onDirection = { ...base, title: 'Semiconductor Manufacturing Intern' }
    check('the stated direction outranks everything but the season', jobRelevance(onDirection, terms) > jobRelevance(base, terms), `${jobRelevance(onDirection, terms)} vs ${jobRelevance(base, terms)}`)
    check('direction credit is capped at three terms', jobRelevance({ ...base, title: 'Semiconductor Manufacturing Intern', description_text: 'semiconductor manufacturing semiconductor manufacturing' }, terms) - jobRelevance(base, terms) <= 30)
    const ordered = byRelevance([{ title: 'A Intern', season_relevance: 'other_season' }, { title: 'B Intern', season_relevance: 'summer_2027' }, { title: 'C Intern', season_relevance: 'summer_2027' }])
    check('byRelevance is best-first and keeps store order on a tie', ordered.map((r) => r.title).join(',') === 'B Intern,C Intern,A Intern', ordered.map((r) => r.title).join(','))
  }

  // ─── The "Internal Communications" trap ────────────────────────────────────
  console.log('employment type from a department hint')
  {
    check('"Internal Communications" is not an internship hint', detectEmploymentType('Office Management and Internal Communications', 'Internal Communications') !== 'internship', detectEmploymentType('Office Management and Internal Communications', 'Internal Communications'))
    check('"International Sales" is not an internship hint', detectEmploymentType('Account Manager', 'International Sales') !== 'internship')
    check('"Internship Program" still is', detectEmploymentType('Data Analyst', 'Internship Program') === 'internship')
    check('a real intern title still wins whatever the hint says', detectEmploymentType('Process Engineering Intern', 'Internal Communications') === 'internship')
  }

  // ─── Sweep order ───────────────────────────────────────────────────────────
  console.log('sweep order')
  {
    const rows = [
      company(1, { id: 'never', name: 'Never checked', ats_type: null, ats_identifier: null }),
      company(2, { id: 'old', name: 'Checked long ago', ats_type: null, ats_identifier: null, last_careers_check_at: '2026-01-01' }),
      company(3, { id: 'board', name: 'Has a board', last_careers_check_at: '2026-08-01' }),
    ]
    const order = orderForSweep(rows, new Set(['greenhouse'])).map((c) => c.id)
    check('stored boards first, then never-checked, then the stalest', order.join(',') === 'board,never,old', order.join(','))
    const noAdapter = orderForSweep([company(4, { id: 'wd', ats_type: 'workday', ats_identifier: 'x' }), company(5, { id: 'gh' })], new Set(['greenhouse'])).map((c) => c.id)
    check('a stored ATS with no adapter is not treated as resolved', noAdapter[0] === 'gh', noAdapter.join(','))
  }

  // ─── The store contract deferred extraction depends on ─────────────────────
  console.log('upsertJobs: a thin copy never erases a richer row')
  {
    const db = new MemoryDb()
    const listing = buildNormalizedJob(posting('acme', '1', { description_text: null }))
    const first = await upsertJobs(USER, [listing], {}, asDb(db))
    check('a posting with NO description persists anyway', first.inserted === 1 && first.ids.length === 1, JSON.stringify(first.errors))
    const row = () => db.tables['job_opportunities'][0]
    check('…and it is stored unextracted', row().extraction_version == null && row().extraction_confidence == null)
    check('…and it is still listable: title, company, url, ats id', !!row().title && !!row().canonical_url && row().ats_job_id === '1')

    // Now an extraction lands on it, exactly as extractPending would write one.
    const extracted: ExtractedJobFields = {
      employment_type: 'internship', season_relevance: 'summer_2027', work_mode: 'onsite', role_family: 'process_engineering',
      location_raw: 'San Francisco, CA', deadline: 'October 2026', compensation: '$30/hr', min_qualifications: ['BS in ChemE'],
      preferred_qualifications: [], graduation_eligibility: '2028', work_authorization: null, skills: ['Aspen'],
      responsibilities: ['Run experiments'], industry: 'chemicals', appears_closed: false, confidence: 0.9,
    }
    Object.assign(row(), extractionPatch({ id: String(row().id), title: String(row().title), company_name: String(row().company_name), location_raw: (row().location_raw as string) ?? null, employment_type: (row().employment_type as string) ?? null, season_relevance: (row().season_relevance as string) ?? null, work_mode: (row().work_mode as string) ?? null, role_family: (row().role_family as string) ?? null }, extracted, 'v9'))
    check('extractionPatch fills the extracted columns and stamps the version', row().extraction_version === 'v9' && row().season_relevance === 'summer_2027' && Array.isArray(row().skills))
    check('extractionPatch turns a prose deadline into a timestamp', typeof row().deadline === 'string' && /^2026-10-31/.test(String(row().deadline)))

    // …and a later sweep re-lists the same posting, thin.
    const before = { ...row() }
    await new Promise((r) => setTimeout(r, 5))
    const again = await upsertJobs(USER, [buildNormalizedJob(posting('acme', '1', { description_text: null }))], {}, asDb(db))
    check('a re-sweep updates rather than inserts', again.inserted === 0 && again.updated === 1 && db.tables['job_opportunities'].length === 1)
    check('…the extraction survives the re-listing', row().extraction_version === 'v9' && row().compensation === '$30/hr' && String(row().season_relevance) === 'summer_2027')
    check('…so do the columns an extraction refined', row().role_family === 'process_engineering' && row().employment_type === 'internship')
    check('…and last_seen_at moves forward', String(row().last_seen_at) > String(before.last_seen_at), `${String(before.last_seen_at)} → ${String(row().last_seen_at)}`)

    // A copy that DOES carry text is allowed to refresh the description.
    const rich = await upsertJobs(USER, [buildNormalizedJob(posting('acme', '1', { description_text: `${JD} NEW PARAGRAPH.` }))], {}, asDb(db))
    check('a copy that carries text does refresh the description', rich.updated === 1 && /NEW PARAGRAPH/.test(String(row().description_text)))
  }

  // ─── The sweep itself, at scale ────────────────────────────────────────────
  console.log('sweep: 200 companies')
  {
    const boards = new Map<string, BoardSpec>()
    const companies: SweepCompany[] = []
    for (let i = 0; i < 200; i++) {
      companies.push(company(i))
      boards.set(`co${i}`, {
        delayMs: 1,
        postings: [
          posting(`co${i}`, `${i}-a`),
          // Every board also advertises something that is not an internship —
          // the board's own filter keeps that out before anything is stored —
          // and an internship in the wrong country, which only the mission's
          // hard constraints can reject.
          posting(`co${i}`, `${i}-b`, { title: 'Senior Process Engineer', employment_type_hint: null }),
          posting(`co${i}`, `${i}-c`, { title: 'Materials Intern', location_raw: 'London, United Kingdom' }),
        ],
      })
    }
    // Three boards that fail in three different ways, spread through the queue.
    boards.set('co7', { postings: [], fail: 'http 500' })
    boards.set('co77', { postings: [], fail: 'throw' })
    boards.delete('co177')

    const track = { inFlight: 0, peak: 0, listed: [] as string[] }
    const db = new MemoryDb()
    const { store, checked } = memoryStore(db, companies)
    const stats = { ...(await import('../lib/career/scout/stats')).emptyStats() }
    const result = await sweepWatchlist(
      USER,
      { mission: MISSION, concurrency: 5, batchSize: 25, ctx: CTX, stats, runId: 'run-1' },
      { store, registry: stubRegistry(boards, track), fetcher: NEVER_FETCH }
    )

    check('every company on the list is visited, including the ones that failed', result.checked === 200 && checked.length === 199, `${result.checked} checked, ${checked.length} recorded`)
    check('concurrency is bounded by the option', track.peak <= 5 && track.peak > 1, `peak ${track.peak}`)
    check('one dead board does not stop the sweep', result.postingsListed === 394 && result.errors.some((e) => /Company 7\b/.test(e)), `${result.postingsListed} postings, ${result.errors.length} errors`)
    check('a board that THROWS is caught per company', result.outcomes.some((o) => o.note === 'threw'), result.errors.slice(0, 3).join(' | '))
    // 199, not 200: the board that threw never got as far as telling us it had
    // one. "We could not tell" is not "there is nothing" — the same rule
    // `markCareersChecked` follows for a failed listing.
    check('a board with nothing on it is checked but has no openings', result.withBoard === 199 && result.withOpenings === 197, `${result.withBoard} with a board, ${result.withOpenings} with openings`)
    check('a non-internship never reaches normalization — the board filter drops it', !db.tables['job_opportunities'].some((r) => /Senior/.test(String(r.title))))
    check('an internship in the wrong country IS stored-then-rejected, by name', (result.rejected['United States'] ?? 0) === 197, JSON.stringify(result.rejected))
    check('every eligible internship posting is persisted', result.inserted === 197 && db.tables['job_opportunities'].length === 197, `${result.inserted} inserted, ${db.tables['job_opportunities'].length} rows`)
    check('the sweep makes NO model call', stats.model_calls === 0 && stats.jobs_extracted === 0)
    check('every stored row says it has not been read yet', result.jobs.length > 0 && result.jobs.every((j) => j.extracted === false))
    check('rows are stamped against the run so the sweep is a run you can open', (db.tables['scouting_run_jobs'] ?? []).length === 197, String((db.tables['scouting_run_jobs'] ?? []).length))
    check('it persists in batches, not once at the end', db.writes.filter((w) => w.table === 'job_opportunities' && w.op === 'insert').length > 1)
    check('results come back best-relevance first', result.jobs.length > 1 && result.jobs[0].relevance >= result.jobs[result.jobs.length - 1].relevance)
    check('the summary reads as a funnel', summarizeSweep(result).length === 5 && summarizeSweep(result)[0].includes('200 checked'))

    // ── Re-sweep: idempotent ────────────────────────────────────────────────
    const firstSeen = db.tables['job_opportunities'].map((r) => String(r.last_seen_at))
    await new Promise((r) => setTimeout(r, 5))
    const second = await sweepWatchlist(
      USER,
      { mission: MISSION, concurrency: 5, ctx: CTX, runId: 'run-2' },
      { store, registry: stubRegistry(boards), fetcher: NEVER_FETCH }
    )
    check('a re-sweep of the same boards inserts nothing new', second.inserted === 0 && second.updated === 197 && db.tables['job_opportunities'].length === 197, `${second.inserted} new, ${second.updated} updated, ${db.tables['job_opportunities'].length} rows`)
    const nowSeen = db.tables['job_opportunities'].map((r) => String(r.last_seen_at))
    check('…but every row it re-saw has a newer last_seen_at', nowSeen.every((v, i) => v > firstSeen[i]))
    check('…and the second run gets its own run→job links', (db.tables['scouting_run_jobs'] ?? []).length === 394)
  }

  // ─── The cheap pass: stored boards only ────────────────────────────────────
  console.log('sweep: stored boards only')
  {
    const boards = new Map<string, BoardSpec>([['co1', { postings: [posting('co1', '1')] }]])
    const companies = [company(1), company(2, { ats_type: null, ats_identifier: null })]
    const db = new MemoryDb()
    const { store, checked } = memoryStore(db, companies)
    const result = await sweepWatchlist(
      USER,
      { mission: MISSION, storedBoardsOnly: true, ctx: CTX },
      { store, registry: stubRegistry(boards), fetcher: NEVER_FETCH }
    )
    check('a company with no stored board is declined, not checked', result.checked === 1 && checked.length === 1, `${result.checked} checked`)
    check('…and its last_careers_check_at is left alone for the pass that can detect', !checked.some((c) => c.id === 'c-2'))
    check('…while the stored board is still swept', result.inserted === 1)
  }

  // ─── A deadline mid-sweep ──────────────────────────────────────────────────
  console.log('sweep: a deadline mid-flight')
  {
    const boards = new Map<string, BoardSpec>()
    const companies: SweepCompany[] = []
    for (let i = 0; i < 40; i++) {
      companies.push(company(i))
      boards.set(`co${i}`, { postings: [posting(`co${i}`, String(i))], delayMs: 12 })
    }
    const db = new MemoryDb()
    const { store } = memoryStore(db, companies)
    const result = await sweepWatchlist(
      USER,
      { mission: MISSION, concurrency: 2, batchSize: 4, deadline: Date.now() + 120, ctx: CTX },
      { store, registry: stubRegistry(boards), fetcher: NEVER_FETCH }
    )
    check('the deadline stops the sweep before the end', result.deadlineHit && result.checked < 40 && result.checked > 0, `${result.checked} of 40`)
    check('everything already found is still stored', db.tables['job_opportunities'].length === result.inserted && result.inserted > 0, `${result.inserted} inserted, ${db.tables['job_opportunities'].length} rows`)
    check('nothing gathered is thrown away — the final flush still runs', result.jobs.length === result.inserted)
    check('the companies left over are reported, not hidden', result.remaining >= 40 - result.checked && result.errors.some((e) => /stopped at its deadline/.test(e)), `${result.remaining} remaining`)
  }

  // ─── Deferred extraction ───────────────────────────────────────────────────
  console.log('extractPending')
  {
    const rows: ExtractionCandidate[] = [
      { id: 'j-low', title: 'Marketing Intern', company_name: 'Acme', location_raw: 'Remote', location_tier: 4, role_family: 'other', season_relevance: 'unknown', employment_type: 'internship', work_mode: null, verification_status: 'UNVERIFIED', canonical_url: 'u1', first_seen_at: '2026-08-01', last_seen_at: '2026-08-29' },
      { id: 'j-best', title: 'Process Engineering Intern', company_name: 'Acme', location_raw: 'San Francisco, CA', location_tier: 1, role_family: 'process_engineering', season_relevance: 'summer_2027', employment_type: 'internship', work_mode: null, verification_status: 'VERIFIED_OPEN', canonical_url: 'u2', first_seen_at: '2026-08-01', last_seen_at: '2026-08-29' },
      { id: 'j-mid', title: 'Materials Intern', company_name: 'Beta', location_raw: 'Boston, MA', location_tier: 2, role_family: 'materials', season_relevance: 'unspecified', employment_type: 'internship', work_mode: null, verification_status: 'VERIFIED_OPEN', canonical_url: 'u3', first_seen_at: '2026-08-01', last_seen_at: '2026-08-29' },
      { id: 'j-thin', title: 'Quality Intern', company_name: 'Gamma', location_raw: 'New York, NY', location_tier: 1, role_family: 'quality', season_relevance: 'summer_2027', employment_type: 'internship', work_mode: null, verification_status: 'VERIFIED_OPEN', canonical_url: 'u4', first_seen_at: '2026-08-01', last_seen_at: '2026-08-29' },
    ]
    const texts = new Map<string, string | null>([['j-low', JD], ['j-best', JD], ['j-mid', JD], ['j-thin', 'too short']])
    const written: { id: string; patch: Record<string, unknown> }[] = []
    const asked: string[] = []
    const store: PendingExtractionStore = {
      async listExtractionCandidates() { return { rows, error: null, migrationMissing: false } },
      async loadJobTexts(_u, ids) { return { texts: new Map(ids.map((i) => [i, texts.get(i) ?? null])), error: null } },
      async applyExtraction(_u, id, patch) { written.push({ id, patch }); return { error: null, migrationMissing: false } },
    }
    const extraction: ExtractedJobFields = {
      employment_type: 'internship', season_relevance: 'summer_2027', work_mode: 'onsite', role_family: 'process_engineering',
      location_raw: null, deadline: null, compensation: null, min_qualifications: [], preferred_qualifications: [],
      graduation_eligibility: null, work_authorization: null, skills: [], responsibilities: [], industry: null,
      appears_closed: false, confidence: 0.8,
    }
    const extractor = async (input: { title: string }): Promise<AgentResult<JobExtraction>> => {
      asked.push(input.title)
      return {
        output: extraction as JobExtraction, status: 'succeeded', error: null, evidence: [],
        trace: { agent_id: 'job_extractor', prompt_version: 'test', model: 'stub', model_role: 'fast', provider_id: 'stub', tools_called: [], web_searches: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0.01, latency_ms: 1, steps: 1 },
      }
    }

    const one = await extractPending(USER, { limit: 1, ctx: CTX, store, extractor, concurrency: 1 })
    check('extractPending spends its budget on the best row first', one.extracted === 1 && written[0]?.id === 'j-best', `${asked.join(',')} → ${written.map((w) => w.id).join(',')}`)
    check('…and respects its limit exactly', one.selected === 1 && asked.length === 1)
    check('…and reports the pool it chose from', one.candidates === 4)
    check('…and writes the extraction version through', written[0]?.patch.extraction_version === (await import('../lib/agents/job-extractor')).jobExtractorPrompt.version)

    written.length = 0
    asked.length = 0
    const three = await extractPending(USER, { limit: 3, ctx: CTX, store, extractor, concurrency: 1 })
    check('a larger budget takes the next-best rows, in order', written.map((w) => w.id).join(',') === 'j-best,j-mid,j-low', written.map((w) => w.id).join(','))
    check('a row with too little text is skipped and counted, never sent', three.tooShort === 1 && !asked.some((t) => /Quality/.test(t)), `tooShort ${three.tooShort}`)
    check('…and it is still reported so the reason is visible', three.rows.some((r) => r.id === 'j-thin' && r.outcome === 'too_short'))

    written.length = 0
    asked.length = 0
    const none = await extractPending(USER, { limit: 0, ctx: CTX, store, extractor })
    check('a zero budget costs nothing at all', none.extracted === 0 && asked.length === 0 && none.candidates === 0)

    written.length = 0
    asked.length = 0
    const late = await extractPending(USER, { limit: 3, ctx: CTX, store, extractor, concurrency: 1, deadline: Date.now() - 1 })
    check('past its deadline no extraction starts', late.extracted === 0 && asked.length === 0 && late.deadlineHit)

    written.length = 0
    const failing = await extractPending(USER, {
      limit: 1, ctx: CTX, store, concurrency: 1,
      extractor: async () => ({ output: null, status: 'failed', error: 'model said no', evidence: [], trace: { agent_id: 'job_extractor', prompt_version: 'test', model: 'stub', model_role: 'fast', provider_id: 'stub', tools_called: [], web_searches: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0.02, latency_ms: 1, steps: 1 } }) as never,
    })
    check('a failed extraction is surfaced and costs are still counted', failing.failed === 1 && failing.extracted === 0 && failing.costUsd === 0.02 && failing.errors.some((e) => /model said no/.test(e)), failing.errors.join(' | '))
    check('…and the row is left unextracted rather than half-written', written.length === 0)

    const ordered = await extractPending(USER, { limit: 2, order: 'oldest', ctx: CTX, store, extractor, concurrency: 1 })
    check('order:oldest takes the pool in store order, not by relevance', ordered.rows.filter((r) => r.outcome === 'extracted').map((r) => r.id).join(',') === 'j-low,j-best', ordered.rows.map((r) => `${r.id}:${r.outcome}`).join(','))
  }

  console.log('')
  if (failures) {
    console.log(`${failures} check(s) FAILED`)
    process.exitCode = 1
  } else {
    console.log('all checks passed')
  }
}

// A NormalizedJob is only used through the store here; the import keeps the
// intent explicit for a reader.
void (null as unknown as NormalizedJob)

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
