// An in-memory RunStoreDb with the SAME semantics the Supabase implementation
// has, so the durable-run kernel can be driven end to end with no database:
//
//   guard      equality; an array is `in`; null is `is null`. Applied on top of
//              the id, atomically (no await between the check and the write),
//              exactly as one UPDATE ... WHERE statement is.
//   unique     migration 021's partial unique index: at most one row per
//              (user_id, kind) with status in (queued, running) AND queued_at
//              set. A second insert reports `conflict: true`; a patch that
//              would create a second active durable row fails like Postgres.
//   columns    getRun without `full` and every patchRun answer omit the heavy
//              columns (checkpoint, result), as the live select lists do.
//
// Every write is recorded in `history`, so a suite can assert on the exact
// patch a transition made — not only on the row it left behind.

import { emptyJobCounts, type RunJobCounts, type ScoutRunRow } from '../../lib/career/scout/run-record'
import type { RunStoreDb } from '../../lib/career/scout/run-store-db'

export type Row = Record<string, unknown>

export interface PatchRecord {
  seq: number
  id: string
  patch: Row
  guard: Row
  /** How many rows the guard matched (0 or 1). */
  matched: number
  error: string | null
}

export interface FakeRunStoreDb extends RunStoreDb {
  rows: Map<string, Row>
  history: PatchRecord[]
  /** countJobs answers from here; default zero. */
  jobCounts: Map<string, number>
  /** Runs synchronously before a patch's guard is evaluated. A test uses it to interpose a race. */
  hooks: { beforePatch?: (id: string, patch: Row, guard: Row) => void }
  /** Columns the database "does not have": a patch naming one fails like a pre-migration Postgres. */
  unknownColumns: string[]
  /** Insert a row directly (no unique check, no defaults beyond id/started_at). */
  seed(row: Row): string
  /** A deep copy of a row, for before/after comparison. */
  snapshot(id: string): Row | null
  /** The row as it is, live. */
  row(id: string): Row
}

const HEAVY = ['checkpoint', 'result']
const ACTIVE = ['queued', 'running']

export function deepCopy<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T)
}

function strip(row: Row, heavy: boolean): ScoutRunRow {
  const c = deepCopy(row)
  if (!heavy) for (const k of HEAVY) delete c[k]
  return c as unknown as ScoutRunRow
}

function guardMatches(row: Row, guard: Row): boolean {
  for (const [k, v] of Object.entries(guard)) {
    const actual = row[k] === undefined ? null : row[k]
    if (Array.isArray(v)) {
      if (!v.includes(actual as never)) return false
    } else if (v === null) {
      if (actual !== null) return false
    } else if (actual !== v) return false
  }
  return true
}

export function createFakeRunStoreDb(): FakeRunStoreDb {
  const rows = new Map<string, Row>()
  const history: PatchRecord[] = []
  const jobCounts = new Map<string, number>()
  let n = 0
  let seq = 0

  const activeDurable = (userId: unknown, kind: unknown, exceptId: string | null) =>
    [...rows.entries()].some(([id, r]) => id !== exceptId && r.user_id === userId && (r.kind ?? 'job_scout') === (kind ?? 'job_scout') && ACTIVE.includes(String(r.status)) && Boolean(r.queued_at))

  const db: FakeRunStoreDb = {
    rows,
    history,
    jobCounts,
    hooks: {},
    unknownColumns: [],
    seed(row) {
      const id = String(row.id ?? `seed-${++n}`)
      rows.set(id, { started_at: new Date().toISOString(), ...row, id })
      return id
    },
    snapshot(id) {
      const r = rows.get(id)
      return r ? deepCopy(r) : null
    },
    row(id) {
      const r = rows.get(id)
      if (!r) throw new Error(`fake db: no row ${id}`)
      return r
    },
    async insertRun(row) {
      if (ACTIVE.includes(String(row.status)) && row.queued_at && activeDurable(row.user_id, row.kind, null)) {
        return { row: null, error: 'duplicate key value violates unique constraint "scouting_runs_one_active_per_kind"', conflict: true }
      }
      const id = `run-${++n}`
      const full: Row = { id, started_at: new Date().toISOString(), ...row }
      rows.set(id, full)
      return { row: strip(full, false), error: null }
    },
    async patchRun(id, patch, guard = {}) {
      db.hooks.beforePatch?.(id, patch, guard)
      const rec: PatchRecord = { seq: ++seq, id, patch: deepCopy(patch), guard: deepCopy(guard), matched: 0, error: null }
      history.push(rec)
      const bad = Object.keys(patch).find((k) => db.unknownColumns.includes(k))
      if (bad) {
        rec.error = `column scouting_runs.${bad} does not exist`
        return { rows: [], error: rec.error }
      }
      const row = rows.get(id)
      if (!row || !guardMatches(row, guard)) return { rows: [], error: null }
      const next = { ...row, ...patch }
      if (ACTIVE.includes(String(next.status)) && next.queued_at && activeDurable(next.user_id, next.kind, id)) {
        rec.error = 'duplicate key value violates unique constraint "scouting_runs_one_active_per_kind"'
        return { rows: [], error: rec.error }
      }
      Object.assign(row, patch)
      rec.matched = 1
      return { rows: [strip(row, false)], error: null }
    },
    async getRun(id, userId = null, opts = {}) {
      const r = rows.get(id)
      if (!r || (userId && r.user_id !== userId)) return { row: null, error: null }
      return { row: strip(r, opts.full === true), error: null }
    },
    async listRuns(userId, statuses, limit, kinds) {
      const out = [...rows.values()]
        .filter((r) => r.user_id === userId && statuses.includes(String(r.status)) && (!kinds || kinds.includes(String(r.kind ?? 'job_scout'))))
        .sort((a, b) => String(b.started_at ?? '').localeCompare(String(a.started_at ?? '')))
        .slice(0, limit)
        .map((r) => strip(r, false))
      return { rows: out, error: null }
    },
    async countJobs(runId) {
      const total = jobCounts.get(runId) ?? 0
      const counts: RunJobCounts = { ...emptyJobCounts(), total, inserted: total }
      return { counts, error: null }
    },
  }
  return db
}

// ─── The tiny assertion harness every suite shares ───────────────────────────

export interface Checker {
  check(name: string, ok: boolean, detail?: string): void
  /** Deep-equal on JSON shape. */
  same(name: string, actual: unknown, expected: unknown): void
  finish(suite: string): void
  readonly failures: string[]
  readonly passed: number
}

export function makeChecker(): Checker {
  const failures: string[] = []
  let passed = 0
  return {
    get failures() {
      return failures
    },
    get passed() {
      return passed
    },
    check(name, ok, detail = '') {
      if (ok) {
        passed++
        console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`)
      } else {
        failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
        console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
      }
    },
    same(name, actual, expected) {
      const a = JSON.stringify(actual)
      const e = JSON.stringify(expected)
      this.check(name, a === e, a === e ? '' : `got ${a} expected ${e}`)
    },
    finish(suite) {
      if (failures.length === 0) console.log(`\n${suite}: all ${passed} checks passed`)
      else {
        console.log(`\n${suite}: ${failures.length} FAILED, ${passed} passed`)
        for (const f of failures) console.log(`  FAIL ${f}`)
      }
      process.exitCode = failures.length === 0 ? 0 : 1
    },
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
export const iso = (t: number) => new Date(t).toISOString()

/** Capture console output for the duration of `fn`, returning every line written. */
export async function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = []
  const orig = { log: console.log, warn: console.warn, error: console.error }
  const grab = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
  }
  console.log = grab
  console.warn = grab
  console.error = grab
  try {
    const result = await fn()
    return { result, lines }
  } finally {
    console.log = orig.log
    console.warn = orig.warn
    console.error = orig.error
  }
}
