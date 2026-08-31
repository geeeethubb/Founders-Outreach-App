// The run report — "did it actually search anything?"
//
// That question is the founder's, verbatim, after a $4.02 run that returned 25
// postings. The old summary could not answer it: `sources_consulted` was a
// histogram of postings per source TYPE, so a surface that was never called and
// a surface that was called and returned nothing looked identical, and a
// surface that returned 200 near-duplicates looked like the best one.
//
// This renders the table the brief asked for:
//
//   Simplify           217 seen · 192 unique · ✓ completed
//   Greenhouse          87 seen ·  59 unique
//   Company watchlist   14 checked ·  21 jobs
//
//   TOTAL RAW            325     (217 + 87 + 21)
//   UNIQUE               213     (192 ∪ 59 = 192, + 21 from the watchlist lane)
//   …
//
// Note what those two numbers are made of, because an earlier draft got it
// wrong in both directions. TOTAL RAW sums the `seen` COLUMN, and `seen` is
// always POSTINGS — the watchlist row displays "14 checked" because 14 is the
// interesting number for a company sweep, but the 14 is a display field and its
// `seen` is still 21 postings. UNIQUE is the ledger's cross-source union, which
// counts the posting Greenhouse and Simplify both returned once; a lane outside
// the ledger contributes its own `unique`, and if it hands over posting keys
// (`keys`) it is unioned properly instead. UNIQUE can never exceed TOTAL RAW,
// and `buildScoutReport` enforces that rather than trusting its callers.
//
// Two properties matter more than the formatting:
//
//   1. **The totals are DERIVED from the rows.** `TOTAL RAW` is the sum of the
//      per-source `seen` column, computed here, never passed in. A report whose
//      total disagrees with its own table is worse than no report.
//   2. **It renders from a persisted run row.** `buildScoutReport` produces
//      plain JSON that goes on `scouting_runs.stats`; `scoutReportFromRunRow`
//      reads it back. The CLI and the Jobs page print the same bytes, hours
//      after the worker exited, because neither recomputes anything.
//
// Pure: no I/O, no clock except an optional `generatedAt` the caller passes.

import { coverageRows, coverageTotals, type CoverageLedger, type SourceCoverage } from '../discovery/coverage'
import type { DiversityReport } from '../discovery/diversity'
import type { UnconfiguredSource } from '../sources/discovery-types'

/** Where the report lives on the run row's `stats` payload. */
export const SCOUT_REPORT_STATS_KEY = 'discovery_report'

/** One line of the source table. Plain JSON — this is what gets persisted. */
export interface ScoutReportSource {
  id: string
  name: string
  sourceType?: string
  seen: number
  unique: number
  newToDb?: number
  pages?: number
  exhausted?: boolean
  completed?: boolean
  errors?: string[]
  notes?: string[]
  costUsd?: number
  /**
   * DISPLAY ONLY: companies swept by a company-lane row, printed as
   * "14 checked · 21 jobs" instead of the seen/unique pair.
   *
   * It is NOT a substitute unit for `seen`. `seen` on this row still counts
   * POSTINGS, because `seen` is the column TOTAL RAW sums; putting a company
   * count there makes TOTAL RAW smaller than UNIQUE. `buildScoutReport`
   * catches that and says so on the row rather than printing a contradiction.
   */
  checked?: number | null
}

/**
 * An extras row — a lane that is not a `JobDiscoverySource`, today the company
 * watchlist sweep.
 *
 * `keys` is the important field. Without it, the lane's `unique` is simply
 * added to the ledger's, so a sweep that read the same Greenhouse board the ATS
 * lane read counts those postings twice. With it, the run-level union is exact.
 * Use `postingKey` from ../discovery/coverage so the keys match the ledger's.
 */
export interface ExtraReportSource extends ScoutReportSource {
  keys?: string[]
}

export interface ScoutReportTotals {
  /** Sum of every row's `seen`. Derived, never supplied. */
  rawPostings: number
  /** Distinct postings across sources — overlaps counted once. */
  uniquePostings: number
  newToDb: number
  /** Survived cheap relevance / constraint rejection. */
  relevant: number
  verifiedOpen: number
  /** Received a full fit evaluation. */
  fullyRanked: number
  uniqueCompanies: number
  uniqueRoleFamilies: number
  costUsd: number
  latencyMs: number
  sourcesConfigured: number
  sourcesSkipped: number
}

export interface ScoutReport {
  runId: string | null
  label: string | null
  status: string | null
  generatedAt: string | null
  sources: ScoutReportSource[]
  totals: ScoutReportTotals
  /** Named, with its env var, so "no results" is never mistaken for "no data". */
  skipped: { id: string; name: string; envVar: string | null; reason: string }[]
  diversity: DiversityReport | null
  errors: string[]
}

/** The funnel numbers the ledger cannot know — they come from later stages. */
export interface ScoutReportFunnel {
  relevant?: number
  verifiedOpen?: number
  fullyRanked?: number
  uniqueCompanies?: number
  uniqueRoleFamilies?: number
}

export interface BuildScoutReportInput {
  runId?: string | null
  label?: string | null
  status?: string | null
  /** Coverage accumulated during the run. Rows are emitted in registration order. */
  ledger?: CoverageLedger | null
  /** Rows for lanes that are not `JobDiscoverySource`s — the company watchlist sweep. */
  extraSources?: ExtraReportSource[]
  funnel?: ScoutReportFunnel
  diversity?: DiversityReport | null
  skipped?: UnconfiguredSource[]
  costUsd?: number
  latencyMs?: number
  generatedAt?: string
}

function fromCoverage(row: SourceCoverage): ScoutReportSource {
  return {
    id: row.sourceId,
    name: row.name,
    sourceType: row.sourceType,
    seen: row.seen,
    unique: row.unique,
    newToDb: row.newToDb,
    pages: row.pages,
    exhausted: row.exhausted,
    completed: row.completed,
    errors: row.errors.slice(),
    notes: row.notes.slice(),
    costUsd: row.costUsd,
  }
}

/**
 * Bring an extras row into the table's units.
 *
 * The one thing that can go wrong here is a caller putting a COMPANY count in
 * `seen` on a `checked` row — which the field name invites, and which makes
 * TOTAL RAW smaller than UNIQUE. That is corrected to the only defensible
 * lower bound (the row's own `unique`) and the correction is written onto the
 * row as a note, because silently repairing a caller's arithmetic is how a
 * report starts lying quietly (principle 9).
 */
function normalizeExtra(s: ExtraReportSource): { row: ScoutReportSource; keys: string[] } {
  const keys = (s.keys ?? []).filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim())
  const unique = Math.max(s.unique || 0, keys.length ? new Set(keys).size : 0)
  const notes = (s.notes ?? []).slice()
  let seen = s.seen || 0
  if (seen < unique) {
    notes.push(
      `seen (${seen}) was below unique (${unique}) — corrected: \`seen\` counts postings for TOTAL RAW, \`checked\` counts companies`
    )
    seen = unique
  }
  const { keys: _drop, ...rest } = s
  return { row: { ...rest, seen, unique, errors: (s.errors ?? []).slice(), notes }, keys }
}

export function buildScoutReport(input: BuildScoutReportInput): ScoutReport {
  const ledgerRows = input.ledger ? coverageRows(input.ledger).map(fromCoverage) : []
  const extras = (input.extraSources ?? []).map((s) => normalizeExtra(s))
  const sources: ScoutReportSource[] = [...ledgerRows, ...extras.map((e) => e.row)]

  const totalsFromLedger = input.ledger ? coverageTotals(input.ledger) : null
  // TOTAL RAW is the sum of the column above it. It is computed here for
  // exactly that reason — a caller cannot hand in a number that disagrees.
  const rawPostings = sources.reduce((a, s) => a + (s.seen || 0), 0)

  // Run-level UNIQUE. Cross-source overlap inside the ledger is already
  // resolved by its key set. An extras lane that hands over posting `keys`
  // joins that union, so a sweep that re-read a board the ATS lane read is not
  // counted twice; one that does not can only be added, which is an upper
  // bound — hence the clamp below.
  const union = new Set<string>(input.ledger ? input.ledger.keys : [])
  const unkeyedUnique = extras.reduce((a, e) => a + (e.keys.length ? 0 : e.row.unique || 0), 0)
  for (const e of extras) for (const k of e.keys) union.add(k)
  // UNIQUE ≤ TOTAL RAW is an invariant of the table, not a hope about callers.
  const uniquePostings = Math.min(union.size + unkeyedUnique, rawPostings)

  const newToDbRaw = (totalsFromLedger?.newToDb ?? 0) + extras.reduce((a, e) => a + (e.row.newToDb || 0), 0)
  const newToDb = Math.min(newToDbRaw, uniquePostings)
  const costUsd = input.costUsd ?? sources.reduce((a, s) => a + (s.costUsd || 0), 0)

  const d = input.diversity ?? null
  const funnel = input.funnel ?? {}
  const skipped = (input.skipped ?? []).map((s) => ({ id: s.id, name: s.name, envVar: s.envVar, reason: s.reason }))

  const errors = sources.flatMap((s) => (s.errors ?? []).map((e) => `${s.name}: ${e}`))

  return {
    runId: input.runId ?? null,
    label: input.label ?? null,
    status: input.status ?? null,
    generatedAt: input.generatedAt ?? null,
    sources,
    totals: {
      rawPostings,
      uniquePostings,
      newToDb,
      relevant: funnel.relevant ?? 0,
      verifiedOpen: funnel.verifiedOpen ?? 0,
      fullyRanked: funnel.fullyRanked ?? 0,
      uniqueCompanies: funnel.uniqueCompanies ?? d?.uniqueCompanies ?? 0,
      uniqueRoleFamilies: funnel.uniqueRoleFamilies ?? d?.uniqueRoleFamilies ?? 0,
      costUsd,
      latencyMs: input.latencyMs ?? 0,
      sourcesConfigured: sources.length,
      sourcesSkipped: skipped.length,
    },
    skipped,
    diversity: d,
    errors,
  }
}

// ─── Persistence ─────────────────────────────────────────────────────────────

/** The payload to merge into `scouting_runs.stats`. Plain JSON by construction. */
export function toReportPayload(report: ScoutReport): Record<string, unknown> {
  return { [SCOUT_REPORT_STATS_KEY]: report }
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function readSource(v: unknown): ScoutReportSource | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const id = str(o.id) ?? str(o.sourceId)
  if (!id) return null
  const checked = o.checked === null || o.checked === undefined ? null : num(o.checked)
  return {
    id,
    name: str(o.name) ?? id,
    ...(str(o.sourceType) ? { sourceType: String(o.sourceType) } : {}),
    seen: num(o.seen),
    unique: num(o.unique),
    newToDb: num(o.newToDb),
    pages: num(o.pages),
    exhausted: Boolean(o.exhausted),
    completed: Boolean(o.completed),
    errors: strList(o.errors),
    notes: strList(o.notes),
    costUsd: num(o.costUsd),
    checked,
  }
}

/**
 * Read a report back off a persisted run row. Defensive on every field: this
 * parses a JSON blob written by an older build, so a missing key must render a
 * shorter report, never throw in a page render. Returns null when the row
 * predates the report entirely — callers then fall back to `summarizeStats`.
 */
export function scoutReportFromRunRow(row: {
  id?: string | null
  label?: string | null
  status?: string | null
  stats?: unknown
  completed_at?: string | null
}): ScoutReport | null {
  const stats = (row.stats ?? null) as Record<string, unknown> | null
  if (!stats || typeof stats !== 'object') return null
  const blob = stats[SCOUT_REPORT_STATS_KEY]
  if (!blob || typeof blob !== 'object') return null
  const o = blob as Record<string, unknown>

  const sources = Array.isArray(o.sources) ? o.sources.map(readSource).filter((s): s is ScoutReportSource => s !== null) : []
  const t = (o.totals && typeof o.totals === 'object' ? o.totals : {}) as Record<string, unknown>
  // Re-derive TOTAL RAW from the rows that were persisted, so a stored total
  // can never contradict the table it is printed under.
  const rawPostings = sources.reduce((a, s) => a + (s.seen || 0), 0)
  const rawTotal = sources.length ? rawPostings : num(t.rawPostings)
  // Same invariant on the way back out: a blob written by an older build could
  // hold UNIQUE > TOTAL RAW, and printing that would contradict the table.
  const uniquePostings = sources.length ? Math.min(num(t.uniquePostings), rawTotal) : num(t.uniquePostings)
  const skipped = Array.isArray(o.skipped)
    ? o.skipped
        .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === 'object')
        .map((s) => ({
          id: str(s.id) ?? 'unknown',
          name: str(s.name) ?? str(s.id) ?? 'unknown',
          envVar: str(s.envVar),
          reason: str(s.reason) ?? 'not configured',
        }))
    : []

  return {
    runId: str(o.runId) ?? str(row.id) ?? null,
    label: str(o.label) ?? str(row.label) ?? null,
    status: str(o.status) ?? str(row.status) ?? null,
    generatedAt: str(o.generatedAt) ?? str(row.completed_at) ?? null,
    sources,
    totals: {
      rawPostings: rawTotal,
      uniquePostings,
      newToDb: sources.length ? Math.min(num(t.newToDb), uniquePostings) : num(t.newToDb),
      relevant: num(t.relevant),
      verifiedOpen: num(t.verifiedOpen),
      fullyRanked: num(t.fullyRanked),
      uniqueCompanies: num(t.uniqueCompanies),
      uniqueRoleFamilies: num(t.uniqueRoleFamilies),
      costUsd: num(t.costUsd),
      latencyMs: num(t.latencyMs),
      sourcesConfigured: num(t.sourcesConfigured, sources.length),
      sourcesSkipped: num(t.sourcesSkipped, skipped.length),
    },
    skipped,
    diversity: (o.diversity ?? null) as DiversityReport | null,
    errors: strList(o.errors),
  }
}

// ─── Rendering ───────────────────────────────────────────────────────────────

const NAME_COL_MAX = 26

function padName(name: string, width: number): string {
  const n = name.length > width ? `${name.slice(0, width - 1)}…` : name
  return n.padEnd(width)
}

function sourceStatus(s: ScoutReportSource): string {
  if (s.errors && s.errors.length) return `✗ ${s.errors.length} error${s.errors.length === 1 ? '' : 's'}`
  if (s.completed) return '✓ completed'
  if (s.exhausted) return 'exhausted'
  // "not called" is a strong claim — it is the whole reason the table exists —
  // so it needs every sign of a call to be absent. `pages` is optional on an
  // extras row, and a lane that reported jobs on this very line was plainly
  // called.
  const noSignOfACall = (s.pages ?? 0) === 0 && !s.seen && !s.unique && (s.checked ?? null) === null
  if (noSignOfACall) return 'not called'
  return 'more available'
}

/** One row: "Simplify   217 seen · 192 unique · ✓ completed". */
export function renderSourceRow(s: ScoutReportSource, nameWidth: number, numWidth: number): string {
  const left = padName(s.name, nameWidth)
  const body =
    s.checked !== null && s.checked !== undefined
      ? `${String(s.checked).padStart(numWidth)} checked · ${String(s.unique).padStart(numWidth)} jobs`
      : `${String(s.seen).padStart(numWidth)} seen · ${String(s.unique).padStart(numWidth)} unique`
  return `${left}  ${body} · ${sourceStatus(s)}`
}

const TOTAL_LABELS: [keyof ScoutReportTotals, string][] = [
  ['rawPostings', 'TOTAL RAW'],
  ['uniquePostings', 'UNIQUE'],
  ['relevant', 'RELEVANT'],
  ['verifiedOpen', 'VERIFIED OPEN'],
  ['fullyRanked', 'FULLY RANKED'],
  ['uniqueCompanies', 'UNIQUE COMPANIES'],
  ['uniqueRoleFamilies', 'UNIQUE ROLE FAMILIES'],
]

export function scoutReportLines(report: ScoutReport): string[] {
  const lines: string[] = []
  const head = ['Discovery report', report.label ? `— ${report.label}` : '', report.status ? `(${report.status})` : ''].filter(Boolean).join(' ')
  lines.push(head)

  const nameWidth = Math.min(NAME_COL_MAX, Math.max(8, ...report.sources.map((s) => s.name.length)))
  const numWidth = Math.max(
    3,
    ...report.sources.map((s) => String(Math.max(s.seen, s.unique, s.checked ?? 0)).length)
  )
  if (!report.sources.length) lines.push('  (no source was recorded — this run searched nothing)')
  for (const s of report.sources) lines.push(`  ${renderSourceRow(s, nameWidth, numWidth)}`)

  if (report.skipped.length) {
    lines.push('')
    lines.push(`SKIPPED (${report.skipped.length} source${report.skipped.length === 1 ? '' : 's'} not configured)`)
    for (const s of report.skipped) lines.push(`  ${padName(s.name, nameWidth)}  ${s.envVar ? `set ${s.envVar}` : s.reason}`)
  }

  lines.push('')
  const labelWidth = Math.max(...TOTAL_LABELS.map(([, l]) => l.length))
  for (const [key, label] of TOTAL_LABELS) {
    lines.push(`${label.padEnd(labelWidth)}  ${String(report.totals[key])}`)
  }
  if (report.totals.newToDb) lines.push(`${'NEW TO DATABASE'.padEnd(labelWidth)}  ${report.totals.newToDb}`)
  if (report.totals.costUsd) lines.push(`${'COST'.padEnd(labelWidth)}  $${report.totals.costUsd.toFixed(4)}`)
  if (report.totals.latencyMs) lines.push(`${'ELAPSED'.padEnd(labelWidth)}  ${(report.totals.latencyMs / 1000).toFixed(1)}s`)

  if (report.diversity?.concentrationWarning) {
    lines.push('')
    lines.push(report.diversity.concentrationWarning)
    for (const r of report.diversity.reasons.slice(1)) lines.push(`  · ${r}`)
  }
  if (report.errors.length) {
    lines.push('')
    lines.push(`ERRORS (${report.errors.length})`)
    for (const e of report.errors.slice(0, 10)) lines.push(`  · ${e}`)
  }
  return lines
}

export function renderScoutReport(report: ScoutReport): string {
  return scoutReportLines(report).join('\n')
}

/** Render straight from a persisted row; null when the row has no report. */
export function renderRunRowReport(row: Parameters<typeof scoutReportFromRunRow>[0]): string | null {
  const report = scoutReportFromRunRow(row)
  return report ? renderScoutReport(report) : null
}
