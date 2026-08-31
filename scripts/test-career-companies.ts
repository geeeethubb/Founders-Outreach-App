// Offline checks for the watchlist data layer: what an agent may write, what
// only the user may write, what a careers check may touch, and what a run's
// results are.
//
//   npx tsx scripts/test-career-companies.ts
//
// No network, no keys, no database. The Supabase client is a small in-memory
// fake (below) that can also be told a column or a table does not exist, which
// is how the pre-016 database is simulated: every write must degrade to the
// columns that are there instead of throwing.

import { byCheckOrder, clampPriority, normalizeIntent, selectCompaniesToCheck } from '../lib/career/companies/intent'
import {
  isReinterpreted,
  listWatchlist,
  markCareersChecked,
  resolveStoredIntent,
  setUserCompanyIntent,
  toCompanyView,
  upsertWatch,
} from '../lib/career/companies/watchlist'
import { escapeLike, listJobs, MAX_RUN_JOB_IDS, RUN_JOB_ID_URL_BYTES, runJobIds, runJobSummary, upsertJobs, type Db } from '../lib/career/jobs/store'
import { buildNormalizedJob } from '../lib/career/jobs/normalize'
import { seedWatchlistFromPlan, type CompanyFirstStore } from '../lib/career/scout/company-first'
import type { RawJobPosting } from '../lib/career/sources/types'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const USER = 'user-1'

// ─── A tiny in-memory PostgREST ──────────────────────────────────────────────

type Row = Record<string, unknown>

interface FakeOptions {
  /** Columns this database does not have yet, per table (simulates pre-016). */
  missingColumns?: Record<string, string[]>
  /** Tables this database does not have yet. */
  missingTables?: string[]
}

interface Filter { op: 'eq' | 'neq' | 'in' | 'gte' | 'ilike' | 'notis'; col: string; val: unknown }

function splitColumns(sel: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of sel) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((t) => !t.includes('(') && t !== '*')
    .map((t) => (t.includes(':') ? t.split(':')[1] : t))
}

function likeToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (m) => `\\${m}`)
  return new RegExp(`^${escaped.replace(/%/g, '.*').replace(/_/g, '.')}$`, 'i')
}

class FakeQuery implements PromiseLike<{ data: unknown; error: { message: string } | null; count: number | null }> {
  private filters: Filter[] = []
  private columns = '*'
  private wantCount = false
  private single: 'none' | 'maybe' | 'single' = 'none'
  private orders: { col: string; asc: boolean; nullsFirst: boolean }[] = []
  private returning = false
  private from = 0
  private to = Number.MAX_SAFE_INTEGER

  constructor(
    private db: FakeDb,
    private table: string,
    private mode: 'select' | 'insert' | 'update' | 'upsert',
    private payload: Row[] | Row | null = null,
    private conflictKeys: string[] = []
  ) {}

  select(cols = '*', opts?: { count?: string }) {
    this.columns = cols
    if (opts?.count) this.wantCount = true
    if (this.mode !== 'select') this.returning = true
    return this
  }
  eq(col: string, val: unknown) { this.filters.push({ op: 'eq', col, val }); return this }
  neq(col: string, val: unknown) { this.filters.push({ op: 'neq', col, val }); return this }
  in(col: string, val: unknown[]) { this.filters.push({ op: 'in', col, val }); return this }
  gte(col: string, val: unknown) { this.filters.push({ op: 'gte', col, val }); return this }
  ilike(col: string, val: string) { this.filters.push({ op: 'ilike', col, val }); return this }
  not(col: string, _op: string, _val: unknown) { this.filters.push({ op: 'notis', col, val: null }); return this }
  or(_expr: string) { return this }
  order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) {
    this.orders.push({ col, asc: opts?.ascending ?? true, nullsFirst: opts?.nullsFirst ?? false })
    return this
  }
  limit(n: number) { this.to = Math.min(this.to, this.from + n - 1); return this }
  range(from: number, to: number) { this.from = from; this.to = to; return this }
  maybeSingle() { this.single = 'maybe'; return this }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  then<TR = any, TE = never>(resolve?: ((v: { data: unknown; error: { message: string } | null; count: number | null }) => TR | PromiseLike<TR>) | null, reject?: ((r: unknown) => TE | PromiseLike<TE>) | null): PromiseLike<TR | TE> {
    try {
      return Promise.resolve(this.run()).then(resolve, reject)
    } catch (e) {
      return Promise.reject(e).then(resolve, reject)
    }
  }

  private missing(cols: string[]): string | null {
    if (this.db.opts.missingTables?.includes(this.table)) return `relation "public.${this.table}" does not exist`
    const gone = this.db.opts.missingColumns?.[this.table] ?? []
    const hit = cols.find((c) => gone.includes(c))
    return hit ? `column ${this.table}.${hit} does not exist` : null
  }

  private matches(row: Row): boolean {
    return this.filters.every((f) => {
      const v = row[f.col]
      if (f.op === 'eq') return v === f.val
      if (f.op === 'neq') return v !== f.val
      if (f.op === 'in') return (f.val as unknown[]).includes(v)
      if (f.op === 'gte') return typeof v === 'number' && typeof f.val === 'number' && v >= f.val
      if (f.op === 'ilike') return typeof v === 'string' && likeToRegExp(String(f.val)).test(v)
      return v !== null && v !== undefined // not(col, 'is', null)
    })
  }

  private run(): { data: unknown; error: { message: string } | null; count: number | null } {
    const rows = this.db.rows(this.table)
    const err = (message: string) => ({ data: null, error: { message }, count: null })

    if (this.mode === 'insert' || this.mode === 'upsert') {
      const incoming = (Array.isArray(this.payload) ? this.payload : [this.payload]).filter(Boolean) as Row[]
      const bad = this.missing(incoming.flatMap((r) => Object.keys(r)))
      if (bad) return err(bad)
      const written: Row[] = []
      for (const r of incoming) {
        if (this.mode === 'upsert' && this.conflictKeys.length) {
          const dup = rows.find((existing) => this.conflictKeys.every((k) => existing[k] === r[k]))
          if (dup) continue
        }
        const row = { id: `${this.table}-${this.db.seq()}`, ...r }
        rows.push(row)
        written.push(row)
      }
      const data = this.returning ? (this.single === 'none' ? written : written[0] ?? null) : null
      return { data, error: null, count: written.length }
    }

    if (this.mode === 'update') {
      const patch = this.payload as Row
      const bad = this.missing(Object.keys(patch))
      if (bad) return err(bad)
      const hit = rows.filter((r) => this.matches(r))
      for (const r of hit) Object.assign(r, patch)
      const data = this.returning ? (this.single === 'none' ? hit : hit[0] ?? null) : null
      return { data, error: null, count: hit.length }
    }

    const bad = this.missing(splitColumns(this.columns))
    if (bad) return err(bad)
    let hit = rows.filter((r) => this.matches(r)).map((r) => ({ ...r }))
    for (const o of [...this.orders].reverse()) {
      hit.sort((a, b) => {
        const av = a[o.col]
        const bv = b[o.col]
        const an = av === null || av === undefined
        const bn = bv === null || bv === undefined
        if (an && bn) return 0
        if (an) return o.nullsFirst ? -1 : 1
        if (bn) return o.nullsFirst ? 1 : -1
        const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv))
        return o.asc ? cmp : -cmp
      })
    }
    const total = hit.length
    // An embedded `jobs:job_opportunities(count)` — the only embed these tests use.
    if (this.columns.includes('job_opportunities(count)')) {
      hit = hit.map((r) => ({ ...r, jobs: [{ count: this.db.rows('job_opportunities').filter((j) => j.company_id === r.id).length }] }))
    }
    hit = hit.slice(this.from, this.to + 1)
    if (this.single !== 'none') return { data: hit[0] ?? null, error: null, count: this.wantCount ? total : null }
    return { data: hit, error: null, count: this.wantCount ? total : null }
  }
}

class FakeDb {
  private tables: Record<string, Row[]> = {}
  private n = 0
  constructor(public opts: FakeOptions = {}) {}
  seq() { return ++this.n }
  rows(table: string): Row[] {
    if (!this.tables[table]) this.tables[table] = []
    return this.tables[table]
  }
  seed(table: string, rows: Row[]) { this.rows(table).push(...rows) }
  from(table: string) {
    return {
      select: (cols?: string, opts?: { count?: string }) => new FakeQuery(this, table, 'select').select(cols ?? '*', opts),
      insert: (payload: Row | Row[]) => new FakeQuery(this, table, 'insert', payload),
      update: (payload: Row) => new FakeQuery(this, table, 'update', payload),
      upsert: (payload: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean; count?: string }) =>
        new FakeQuery(this, table, 'upsert', payload, (opts?.onConflict ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
    }
  }
  /** Typed as the real client for the stores; every method they use is above. */
  asDb(): Db { return this as unknown as Db }
  company(name: string): Row | undefined { return this.rows('companies').find((c) => c.name === name) }
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const JD = 'We are hiring a Process Engineer Intern for Summer 2027 in San Francisco. You will own experiments and present results. '.repeat(3)

function raw(over: Partial<RawJobPosting>): RawJobPosting {
  return {
    source_type: 'greenhouse', source_url: 'https://boards.greenhouse.io/acme/jobs/1', external_id: '1', company_name: 'Acme', company_domain: 'acme.com',
    title: 'Process Engineer Intern', location_raw: 'San Francisco, CA', description_text: JD, description_html: null, department: null, posted_at: null, updated_at: null,
    apply_url: 'https://boards.greenhouse.io/acme/jobs/1', canonical_url: 'https://boards.greenhouse.io/acme/jobs/1', ats_type: 'greenhouse', ats_job_id: '1', requisition_id: null,
    employment_type_hint: 'Intern', raw: {}, retrieved_at: new Date().toISOString(), ...over,
  }
}
const JOB_A = buildNormalizedJob(raw({}))
const JOB_B = buildNormalizedJob(raw({ source_url: 'https://boards.greenhouse.io/acme/jobs/2', canonical_url: 'https://boards.greenhouse.io/acme/jobs/2', apply_url: 'https://boards.greenhouse.io/acme/jobs/2', external_id: '2', ats_job_id: '2', title: 'Materials Intern' }))

const NOW = new Date('2026-08-30T12:00:00.000Z')

async function main() {
  // ─── A. An agent may only ever suggest ────────────────────────────────────
  console.log('intent: what an agent may write')
  {
    const db = new FakeDb()
    const planner = await upsertWatch(USER, { name: 'Acme', domain: 'acme.com', watch_status: 'target', watch_source: 'planner', watch_origin: 'planner', watch_priority: 90 }, NOW, db.asDb())
    const acme = db.company('Acme')!
    check('a planner seed asking for target is stored suggested', planner.intent === 'suggested' && acme.watch_status === 'suggested', String(acme.watch_status))
    check('the seed is stamped planner, not user', acme.watch_source === 'planner' && acme.watch_origin === 'planner' && typeof acme.watch_status_at === 'string')
    check('priority is clamped to 0–100, higher = more important', acme.watch_priority === 90)

    const scout = await upsertWatch(USER, { name: 'Omega Labs', domain: 'omega.com', watch_status: 'target', watch_source: 'scout' }, NOW, db.asDb())
    const omega = db.company('Omega Labs')!
    check('a scout discovery is stored suggested with origin scout', scout.intent === 'suggested' && omega.watch_status === 'suggested' && omega.watch_origin === 'scout')

    const wild = await upsertWatch(USER, { name: 'Wildcat', watch_status: 'watching', watch_source: 'scout' }, NOW, db.asDb())
    check('an agent cannot even write watching', wild.intent === 'suggested' && db.company('Wildcat')!.watch_status === 'suggested')

    // Planner seeds through the real seeding loop, with the real store.
    const store: Pick<CompanyFirstStore, 'upsertWatch'> = { upsertWatch: (u, i) => upsertWatch(u, i, NOW, db.asDb()) }
    const seeded = await seedWatchlistFromPlan(USER, [
      { name: 'Nova Materials', domain: 'nova.com', why: 'materials + process', priority: 0.8, company_type: 'growth-stage', source_url: 'https://nova.com/careers', source_verified: true },
      { name: 'Acme', domain: 'acme.com', why: 'already there', priority: 0.9, company_type: 'startup', source_url: null, source_verified: false },
    ], ['Acme'], { store: store as CompanyFirstStore })
    check('seedWatchlistFromPlan adds new names only', seeded.added === 1 && seeded.skipped === 1, JSON.stringify(seeded.errors))
    check('a planner seed lands as suggested/planner', db.company('Nova Materials')!.watch_status === 'suggested' && db.company('Nova Materials')!.watch_origin === 'planner')
    check('no company in the list is a target — nothing an agent ran created one', db.rows('companies').every((c) => c.watch_status === 'suggested'))
  }

  // ─── B. The user's choices are the only hard signal ───────────────────────
  console.log('intent: what the user writes')
  {
    const db = new FakeDb()
    await upsertWatch(USER, { name: 'Acme', domain: 'acme.com', watch_status: 'target', watch_source: 'scout' }, NOW, db.asDb())
    const id = String(db.company('Acme')!.id)

    const toWatching = await setUserCompanyIntent(USER, id, { watch_status: 'watching' }, NOW, db.asDb())
    let acme = db.company('Acme')!
    check('Explore → Watching is an explicit user promotion', acme.watch_status === 'watching' && toWatching.company?.intent === 'watching')
    check('the promotion stamps user ownership and when', acme.watch_source === 'user' && acme.watch_status_at === NOW.toISOString())
    check('origin still remembers the scout found it', acme.watch_origin === 'scout' && toWatching.company?.origin === 'scout')

    const later = new Date('2026-08-31T09:00:00.000Z')
    await setUserCompanyIntent(USER, id, { watch_status: 'target', watch_priority: 400 }, later, db.asDb())
    acme = db.company('Acme')!
    check('Watching → Target works and re-stamps the time', acme.watch_status === 'target' && acme.watch_status_at === later.toISOString())
    check('priority is clamped, not rejected', acme.watch_priority === 100 && clampPriority(400) === 100)

    const agentAgain = await upsertWatch(USER, { name: 'Acme', domain: 'acme.com', watch_status: 'suggested', watch_source: 'scout' }, later, db.asDb())
    check('a scout that re-finds a target does not demote it', agentAgain.changed === false && agentAgain.intent === 'target' && db.company('Acme')!.watch_status === 'target')
    const agentPromote = await upsertWatch(USER, { name: 'Acme', domain: 'acme.com', watch_status: 'target', watch_source: 'planner', watch_priority: 5 }, later, db.asDb())
    check('an agent cannot promote, and cannot touch a user row at all', agentPromote.changed === false && db.company('Acme')!.watch_priority === 100 && db.company('Acme')!.watch_source === 'user')

    // Ignore, then let both agents try to bring it back.
    await setUserCompanyIntent(USER, id, { watch_status: 'ignored' }, later, db.asDb())
    await upsertWatch(USER, { name: 'Acme', domain: 'acme.com', watch_status: 'target', watch_source: 'scout' }, later, db.asDb())
    await upsertWatch(USER, { name: 'Acme', domain: 'acme.com', watch_status: 'suggested', watch_source: 'planner' }, later, db.asDb())
    check('an ignored company is never re-added by an agent', db.company('Acme')!.watch_status === 'ignored')
    const list = await listWatchlist(USER, db.asDb())
    check('and it is not in the watchlist', !list.companies.some((c) => c.name === 'Acme'))
  }

  // ─── C. Openings are state, never intent ─────────────────────────────────
  console.log('careers checks record state, not preference')
  {
    const db = new FakeDb()
    await upsertWatch(USER, { name: 'Acme', domain: 'acme.com', watch_status: 'suggested', watch_source: 'scout' }, NOW, db.asDb())
    const id = String(db.company('Acme')!.id)
    await setUserCompanyIntent(USER, id, { watch_status: 'target' }, NOW, db.asDb())

    await markCareersChecked(id, { note: 'greenhouse/acme: 2 matching of 40', openings: 2 }, NOW, db.asDb())
    let acme = db.company('Acme')!
    check('a check with openings does not change intent', acme.watch_status === 'target' && acme.watch_source === 'user')
    check('it records open_roles_count and when it looked', acme.open_roles_count === 2 && acme.last_careers_check_at === NOW.toISOString())
    check('and says what it saw', String(acme.careers_check_note).includes('2 matching openings'))

    await markCareersChecked(id, { note: 'no board', openings: 0 }, NOW, db.asDb())
    acme = db.company('Acme')!
    check('a check with no openings still does not change intent', acme.watch_status === 'target' && acme.open_roles_count === 0)

    await markCareersChecked(id, { note: 'listing failed: 502', openings: 0, counted: false }, NOW, db.asDb())
    acme = db.company('Acme')!
    check('a FAILED listing records the attempt but no count', acme.open_roles_count === 0 && acme.careers_check_note === 'listing failed: 502')

    // A watching company with openings stays watching — the pre-016 build turned it into 'opening_available'.
    await upsertWatch(USER, { name: 'Beta', domain: 'beta.com', watch_status: 'suggested', watch_source: 'scout' }, NOW, db.asDb())
    const betaId = String(db.company('Beta')!.id)
    await setUserCompanyIntent(USER, betaId, { watch_status: 'watching' }, NOW, db.asDb())
    await markCareersChecked(betaId, { note: 'greenhouse/beta: 3 matching of 12', openings: 3, status: 'opening_available' }, NOW, db.asDb())
    check('the legacy `status` argument is ignored entirely', db.company('Beta')!.watch_status === 'watching' && db.company('Beta')!.open_roles_count === 3)
  }

  // ─── D. One direction for priority, everywhere ───────────────────────────
  console.log('priority: higher = more important, everywhere')
  {
    const db = new FakeDb()
    db.seed('companies', [
      { id: 'c1', user_id: USER, name: 'Low', watch_status: 'suggested', watch_source: 'scout', watch_priority: 10, last_careers_check_at: null },
      { id: 'c2', user_id: USER, name: 'High', watch_status: 'target', watch_source: 'user', watch_priority: 95, last_careers_check_at: '2026-08-01T00:00:00.000Z' },
      { id: 'c3', user_id: USER, name: 'Mid', watch_status: 'watching', watch_source: 'user', watch_priority: 50, last_careers_check_at: null },
      { id: 'c4', user_id: USER, name: 'Also mid', watch_status: 'suggested', watch_source: 'planner', watch_priority: 50, last_careers_check_at: '2026-08-02T00:00:00.000Z' },
      { id: 'c5', user_id: USER, name: 'Gone', watch_status: 'ignored', watch_source: 'user', watch_priority: 99, last_careers_check_at: null },
      { id: 'c6', user_id: USER, name: 'Legacy', watch_status: 'opening_available', watch_source: 'user', watch_priority: 60, last_careers_check_at: null },
      { id: 'c7', user_id: 'someone-else', name: 'Not mine', watch_status: 'target', watch_source: 'user', watch_priority: 100, last_careers_check_at: null },
    ])
    const res = await listWatchlist(USER, db.asDb())
    const names = res.companies.map((c) => String(c.name))
    check('ignored is excluded and another user never appears', !names.includes('Gone') && !names.includes('Not mine'))
    check('suggested rows are NOT filtered out — they are the scout’s proposals', names.includes('Low') && names.includes('Also mid'))
    const expected = [...res.companies]
      .map((c) => ({ watch_priority: c.watch_priority as number | null, last_careers_check_at: c.last_careers_check_at as string | null, name: String(c.name) }))
      .sort(byCheckOrder)
      .map((c) => c.name)
    check('the store returns exactly byCheckOrder — priority DESC, never-checked first, then name', JSON.stringify(names) === JSON.stringify(expected), names.join(' > '))
    check('the highest priority is first and the lowest last', names[0] === 'High' && names[names.length - 1] === 'Low', names.join(' > '))
    check('at equal priority the never-checked company is checked first', names.indexOf('Mid') < names.indexOf('Also mid'))
    const ascending = [...names].reverse()
    check('the old ascending sort would have checked the least important first', ascending[0] === 'Low')

    const legacy = res.companies.find((c) => c.name === 'Legacy')!
    check('a legacy opening_available row reads as watching', normalizeIntent(legacy.watch_status as string) === 'watching' && toCompanyView(legacy).intent === 'watching')
    check('toCompanyView fills origin from watch_source when 016 has not run', toCompanyView(legacy).origin === 'user')

    // The same order the scout uses to spend its budget.
    const selection = selectCompaniesToCheck(res.companies.map((c) => ({ id: String(c.id), name: String(c.name), watch_status: c.watch_status as string, watch_priority: c.watch_priority as number | null, last_careers_check_at: c.last_careers_check_at as string | null })), { budget: 3 })
    check('selectCompaniesToCheck agrees: the user’s own choices come first', selection.selected[0]?.name === 'High' && selection.counts.suggested >= 1, selection.reason)
  }

  // ─── E. A pre-016 database keeps working ─────────────────────────────────
  console.log('pre-016 database degrades, never throws')
  {
    const db = new FakeDb({ missingColumns: { companies: ['watch_origin', 'watch_status_at', 'open_roles_count'] }, missingTables: ['scouting_run_jobs'] })
    const seed = await upsertWatch(USER, { name: 'Acme', domain: 'acme.com', watch_status: 'target', watch_source: 'planner' }, NOW, db.asDb())
    const acme = db.company('Acme')!
    check('the write lands with the columns that exist', seed.error === null && acme.watch_status === 'suggested' && acme.watch_source === 'planner')
    check('and says which columns it had to drop', seed.downgraded.includes('watch_origin') && seed.downgraded.includes('watch_status_at') && acme.watch_origin === undefined)

    const user = await setUserCompanyIntent(USER, String(acme.id), { watch_status: 'target' }, NOW, db.asDb())
    check('a user promotion still works without the 016 columns', user.error === null && db.company('Acme')!.watch_status === 'target' && db.company('Acme')!.watch_source === 'user')

    const checked = await markCareersChecked(String(acme.id), { note: 'greenhouse/acme: 1 matching of 9', openings: 1 }, NOW, db.asDb())
    check('a careers check still records the note and the time', checked.error === null && db.company('Acme')!.last_careers_check_at === NOW.toISOString() && db.company('Acme')!.open_roles_count === undefined)

    const list = await listWatchlist(USER, db.asDb())
    check('the watchlist reads with the older column list and says so', list.error === null && list.companies.length === 1 && list.intentColumns === false)
    check('and the view still resolves an intent', toCompanyView(list.companies[0]).intent === 'target')

    const up = await upsertJobs(USER, [JOB_A], { runId: 'run-1', missionId: 'm-1' }, db.asDb())
    check('jobs still persist when scouting_run_jobs is missing', up.inserted === 1 && up.errors.length === 0, JSON.stringify(up.errors))
    check('and the missing run→job table is surfaced, not hidden', (up.runJobsNote ?? '').includes('016'))
    const summary = await runJobSummary(USER, 'run-1', db.asDb())
    check('a run summary falls back to discovery_run_id', summary.total === 1 && summary.inserted === 1, JSON.stringify(summary))
    const byRun = await listJobs(USER, { runId: 'run-1' }, db.asDb())
    check('and the run’s jobs are still listable', byRun.jobs.length === 1 && byRun.error === null)
  }

  // ─── F. Run-scoped results ───────────────────────────────────────────────
  console.log('run results: everything a run touched')
  {
    const db = new FakeDb()
    const first = await upsertJobs(USER, [JOB_A, JOB_B], { runId: 'run-1', missionId: 'm-1' }, db.asDb())
    check('the first run inserts both', first.inserted === 2 && first.runJobs === 2, JSON.stringify(first.errors))
    check('both are recorded as inserted by run-1', db.rows('scouting_run_jobs').filter((r) => r.run_id === 'run-1' && r.inserted === true).length === 2)

    const second = await upsertJobs(USER, [JOB_A], { runId: 'run-2', missionId: 'm-1' }, db.asDb())
    check('the second run re-sees one job', second.inserted === 0 && second.updated === 1)
    const link2 = db.rows('scouting_run_jobs').filter((r) => r.run_id === 'run-2')
    check('a re-seen job is still one of run-2’s results, marked not-inserted', link2.length === 1 && link2[0].inserted === false)
    check('discovery_run_id alone would have shown run-2 finding nothing', db.rows('job_opportunities').every((j) => j.discovery_run_id === 'run-1'))

    // The inbox narrows; a run view does not.
    const jobs = db.rows('job_opportunities')
    jobs[0].is_canonical = false
    jobs[0].disposition = 'dismissed'
    jobs[1].verification_status = 'LIKELY_OPEN'
    jobs[1].fit_overall = 72

    const inbox = await listJobs(USER, {}, db.asDb())
    check('the inbox hides the non-canonical job', inbox.jobs.length === 1)
    const run1 = await listJobs(USER, { runId: 'run-1' }, db.asDb())
    check('a run view ignores the inbox defaults — dismissed and non-canonical included', run1.jobs.length === 2, `${run1.jobs.length}`)
    const run1canonical = await listJobs(USER, { runId: 'run-1', canonicalOnly: true }, db.asDb())
    check('an explicit filter is still honoured inside a run view', run1canonical.jobs.length === 1)
    const run1new = await listJobs(USER, { runId: 'run-1', disposition: 'new' }, db.asDb())
    check('so is an explicit disposition', run1new.jobs.length === 1)
    const run2 = await listJobs(USER, { runId: 'run-2' }, db.asDb())
    check('run-2 returns the job it re-found, which discovery_run_id would have missed', run2.jobs.length === 1)
    const empty = await listJobs(USER, { runId: 'run-9' }, db.asDb())
    check('a run with no jobs is empty, not unfiltered', empty.jobs.length === 0 && empty.total === 0)

    db.seed('scouting_runs', [{ id: 'run-1', user_id: USER, stats: { jobs_rejected: { 'Internships only': 3, 'United States': 1 } } }])
    const summary = await runJobSummary(USER, 'run-1', db.asDb())
    check('the summary counts what the run stored', summary.total === 2 && summary.inserted === 2 && summary.likely_open === 1 && summary.verified_open === 0, JSON.stringify(summary))
    check('ranked vs unranked is counted from fit', summary.ranked === 1 && summary.unranked === 1)
    check('what the run rejected is reported, not hidden', (summary.rejected_note ?? '').startsWith('4 postings rejected') && (summary.rejected_note ?? '').includes('Internships only ×3'), summary.rejected_note ?? '')
    const s2 = await runJobSummary(USER, 'run-2', db.asDb())
    check('a re-seen job counts in its run’s total but not as inserted', s2.total === 1 && s2.inserted === 0)
  }

  // ─── G. The live database, read before migration 016 is applied ──────────
  //
  // The founder's table today holds 150 target/planner, 13 target/scout, 7
  // opening_available/planner and 1 watching/planner rows, and ZERO the user
  // chose. Migration 016 rewrites them — but it is applied by hand, so until
  // then the READER has to apply the same rule, or the Companies page shows
  // 163 invented targets and the company-first budget goes to them.
  console.log('pre-016 rows are read as what they are, not what they say')
  {
    const db = new FakeDb({ missingColumns: { companies: ['watch_origin', 'watch_status_at', 'open_roles_count'] } })
    db.seed('companies', [
      { id: 'p1', user_id: USER, name: 'Planner Invention A', domain: 'p-a.com', watch_status: 'target', watch_source: 'planner', watch_priority: 90, last_careers_check_at: null },
      { id: 'p2', user_id: USER, name: 'Planner Invention B', domain: 'p-b.com', watch_status: 'opening_available', watch_source: 'planner', watch_priority: 85, last_careers_check_at: null },
      { id: 's1', user_id: USER, name: 'Scout Discovery', domain: 's-1.com', watch_status: 'target', watch_source: 'scout', watch_priority: 80, last_careers_check_at: null },
      { id: 'u1', user_id: USER, name: 'The One The User Chose', domain: 'chosen.com', watch_status: 'watching', watch_source: 'user', watch_priority: 50, last_careers_check_at: null },
      { id: 'u2', user_id: USER, name: 'Rejected', domain: 'rejected.com', watch_status: 'ignored', watch_source: 'user', watch_priority: 99, last_careers_check_at: null },
    ])

    check('resolveStoredIntent demotes a target an agent wrote', resolveStoredIntent({ watch_status: 'target', watch_source: 'planner' }) === 'suggested')
    check('…and a scout discovery, and a legacy opening_available', resolveStoredIntent({ watch_status: 'target', watch_source: 'scout' }) === 'suggested' && resolveStoredIntent({ watch_status: 'opening_available', watch_source: 'planner' }) === 'suggested')
    check('but never touches the user’s own row', resolveStoredIntent({ watch_status: 'target', watch_source: 'user' }) === 'target' && resolveStoredIntent({ watch_status: 'ignored', watch_source: 'user' }) === 'ignored')
    check('an ignored row is never re-read as a suggestion, whoever wrote it', resolveStoredIntent({ watch_status: 'ignored', watch_source: 'scout' }) === 'ignored')

    const list = await listWatchlist(USER, db.asDb())
    const intents = new Map(list.companies.map((c) => [String(c.name), String(c.intent)]))
    check('the three agent rows read as Explore, not Target', intents.get('Planner Invention A') === 'suggested' && intents.get('Planner Invention B') === 'suggested' && intents.get('Scout Discovery') === 'suggested', [...intents].map(([n, i]) => `${n}=${i}`).join(', '))
    check('the one row the user chose keeps its meaning', intents.get('The One The User Chose') === 'watching')
    check('no target survives a list where the user never made one', ![...intents.values()].includes('target'))
    check('and the correction is counted, not silent', list.reinterpreted === 3, String(list.reinterpreted))
    check('016 columns are reported missing', list.intentColumns === false)

    const planner = list.companies.find((c) => c.name === 'Planner Invention A')!
    check('the stored value is kept, so nothing is hidden', planner.watch_status_stored === 'target' && planner.watch_status === 'suggested')
    const view = toCompanyView(planner)
    check('the API view says the row was re-interpreted', view.intent === 'suggested' && view.reinterpreted === true && isReinterpreted(planner))

    // The whole point: where a run's company-first budget goes.
    const selection = selectCompaniesToCheck(
      list.companies.map((c) => ({ id: String(c.id), name: String(c.name), watch_status: c.watch_status as string, watch_priority: c.watch_priority as number | null, last_careers_check_at: c.last_careers_check_at as string | null })),
      { budget: 2 }
    )
    check('a budget of 2 no longer goes entirely to planner inventions', selection.selected.some((c) => c.name === 'The One The User Chose'), selection.selected.map((c) => c.name).join(', '))
    check('and the run reports 0 targets, because there are none', selection.counts.target === 0 && selection.counts.watching === 1, selection.reason)

    // The write side of the same bug: a false target must not be permanently
    // untouchable. An agent re-finding it corrects the row in place.
    const again = await upsertWatch(USER, { name: 'Planner Invention A', domain: 'p-a.com', watch_status: 'target', watch_source: 'planner' }, NOW, db.asDb())
    check('an agent re-finding a false target heals the row to suggested', again.intent === 'suggested' && db.company('Planner Invention A')!.watch_status === 'suggested', String(db.company('Planner Invention A')!.watch_status))
    const userRow = await upsertWatch(USER, { name: 'The One The User Chose', domain: 'chosen.com', watch_status: 'target', watch_source: 'scout' }, NOW, db.asDb())
    check('while a genuine user row is still refused', userRow.changed === false && db.company('The One The User Chose')!.watch_status === 'watching')
  }

  // ─── H. Ignore is not a one-way door ─────────────────────────────────────
  console.log('an ignored company can be brought back')
  {
    const db = new FakeDb()
    await upsertWatch(USER, { name: 'Acme', domain: 'acme.com', watch_status: 'suggested', watch_source: 'scout' }, NOW, db.asDb())
    const id = String(db.company('Acme')!.id)
    await setUserCompanyIntent(USER, id, { watch_status: 'ignored' }, NOW, db.asDb())

    const scouted = await listWatchlist(USER, db.asDb())
    check('a run never sees an ignored company', scouted.companies.length === 0)
    const shown = await listWatchlist(USER, db.asDb(), { includeIgnored: true })
    check('but the page can ask for it, so the section is not structurally empty', shown.companies.length === 1 && shown.companies[0].intent === 'ignored')
    check('and it is labelled as the user’s own decision', toCompanyView(shown.companies[0]).origin === 'scout' && shown.companies[0].watch_source === 'user')

    const back = await setUserCompanyIntent(USER, id, { watch_status: 'watching' }, NOW, db.asDb())
    check('promoting it back undoes the rejection', back.company?.intent === 'watching')
    const after = await listWatchlist(USER, db.asDb())
    check('and it is scouted again', after.companies.length === 1 && after.companies[0].name === 'Acme')
  }

  // ─── I. Counting what actually landed ────────────────────────────────────
  console.log('run links and reads report what happened, not what was attempted')
  {
    check('escapeLike makes a LIKE wildcard match itself', escapeLike('Analyst_Intern 50%') === 'Analyst\\_Intern 50\\%')
    check('and escapes the escape character', escapeLike('a\\b') === 'a\\\\b')
    check('a title with no wildcards is untouched', escapeLike('Process Engineer Intern') === 'Process Engineer Intern')

    const db = new FakeDb()
    const first = await upsertJobs(USER, [JOB_A], { runId: 'run-1' }, db.asDb())
    check('a new link is written and counted', first.runJobs === 1 && first.runJobsAttempted === 1)
    const repeat = await upsertJobs(USER, [JOB_A], { runId: 'run-1' }, db.asDb())
    check('re-touching the same job in the same run writes nothing, and says so', repeat.runJobs === 0 && repeat.runJobsAttempted === 1, `${repeat.runJobs}/${repeat.runJobsAttempted}`)
    check('the link table still holds exactly one row for that pair', db.rows('scouting_run_jobs').filter((r) => r.run_id === 'run-1').length === 1)

    // A run bigger than the id ceiling reports the overflow instead of quietly
    // answering with a page.
    const many = Array.from({ length: MAX_RUN_JOB_IDS + 5 }, (_, i) => ({ run_id: 'run-big', job_id: `j${i}`, user_id: USER, inserted: true }))
    db.seed('scouting_run_jobs', many)
    const big = await runJobIds(USER, 'run-big', db.asDb())
    check('the id read is capped at a chosen ceiling', big.ids.length === MAX_RUN_JOB_IDS)
    check('and the jobs beyond it are reported, not dropped in silence', big.truncated === 5, String(big.truncated))
    // The ceiling is a request-size budget: every id travels in the `in(...)`
    // filter in the URL, and a query string no gateway will carry answers with
    // nothing at all rather than with a truncated, honest list.
    const urlBytes = MAX_RUN_JOB_IDS * RUN_JOB_ID_URL_BYTES
    check('the ceiling keeps the PostgREST in(...) filter inside a sane URL', urlBytes <= 12_000, `${urlBytes} bytes`)
  }

  console.log(failures === 0 ? '\nall company/watchlist checks passed' : `\n${failures} check(s) FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
