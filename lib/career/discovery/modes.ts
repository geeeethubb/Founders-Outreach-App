// Run modes — how deep a discovery run goes, as ONE declarative choice.
//
// Discovery used to be parameterised by four sliders (Strategies, Rounds,
// Companies, Extract). Those are implementation details of stages the founder
// does not operate, and the numbers they carried were the real product
// ceiling: `targetCount: 12` per strategy and twelve ranked jobs per run meant
// a $4 run returned twelve jobs however much supply existed
// (docs/JOB_DISCOVERY_V2_AUDIT.md §3).
//
// So the user picks a MODE and, if they want, a ceiling in dollars:
//
//   QUICK       cheap feeds, boards already known, the companies you chose.
//               A few minutes, no paid market sources, small model spend.
//   BROAD       every free source, many query families, real pagination, and
//               moderate paid use. Tens of minutes, resumable.
//   EXHAUSTIVE  every configured source, deep pagination, aggressive
//               diversification, and stopping only on saturation or budget.
//
// A mode is a plain object — no behaviour, no I/O — so the whole of "how big
// is this run" is one value that can be logged, persisted in the run row,
// asserted in a test and shown in the UI. The orchestrator reads it; nothing
// here reads the orchestrator.
//
// Two rules shape the numbers:
//
//   1. **Recall in discovery, precision in ranking.** The per-strategy posting
//      target and the extraction budget grow fast with mode; the number of
//      jobs given a FULL fit evaluation grows slowly, because that is the
//      expensive judgment and it is better spent on a well-chosen shortlist.
//
//   2. **Company-first shrinks as the run widens.** `exploreShare` and
//      `companyFirstTimeShare` fall from QUICK to EXHAUSTIVE: a big run is
//      supposed to find employers the watchlist has never heard of, and a
//      watchlist that eats the clock cannot do that.
//
// A caller that passes NO mode gets `LEGACY_BUDGET`, which is exactly today's
// behaviour with no spend ceiling — so the CLI, the eval and every existing
// test keep running unchanged until they opt in.

/** The three modes a user can choose. */
export const RUN_MODES = ['QUICK', 'BROAD', 'EXHAUSTIVE'] as const
export type RunMode = (typeof RUN_MODES)[number]

/** What a budget calls itself. 'LEGACY' is "no mode was chosen" — see LEGACY_BUDGET. */
export type BudgetLabel = RunMode | 'LEGACY'

/**
 * When a source or a strategy has stopped being worth continuing.
 *
 * Not a counter: a page that keeps producing new postings is never cut off,
 * and a page that produces almost nothing twice in a row is. See
 * `saturated()` in ./budget.ts, which is where this is applied.
 */
export interface SaturationPolicy {
  /** New-unique share of a page below which that page counts as low-yield. */
  minYieldRatio: number
  /** Consecutive low-yield pages that end the source. */
  lowYieldStreak: number
  /** Pages that must be seen before saturation can be declared at all. */
  minSamples: number
}

/**
 * A run's declared budget. Every number a stage is allowed to know about how
 * big this run is lives here, and nothing else does.
 */
export interface RunBudget {
  mode: BudgetLabel
  /**
   * Wall clock for the WHOLE run, across however many worker invocations it
   * takes — NOT one invocation's deadline.
   *
   * A worker gets 280s on Vercel and 1200s locally; a mode's run may be
   * bigger than either. The orchestrator keeps the running total in
   * `ScoutCursor.elapsed_ms` and refuses to start new work once this is
   * reached, so "up to an hour, across several passes" is a bound the code
   * enforces rather than a sentence in the UI. It applies to a run that named
   * a MODE; a legacy caller's clock is still exactly its own deadline.
   */
  maxRuntimeMs: number
  /** Pages of results to pull from one source before moving on (pagination depth). */
  maxPagesPerSource: number
  /** Distinct query families (role × qualifier × geography shapes) a run may execute. */
  maxQueryFamilies: number
  /** Postings that may be read properly (one model call each). */
  maxExtract: number
  /** Jobs that may receive a FULL fit evaluation in this run. */
  maxFullFit: number
  /** Hard ceiling in dollars. Infinity means "no ceiling configured". */
  maxSpendUsd: number
  /**
   * Whether a PAID JOB-SEARCH PROVIDER may be called at all.
   *
   * This is about providers (a paid aggregator API, a paid search index), not
   * about model spend — every mode makes model calls and every mode's cost is
   * bounded by `maxSpendUsd`, which is the number the UI shows. Today nothing
   * in a run calls a paid provider: the only consumer of this flag will be the
   * discovery registry's cost model (`DiscoveryCostModel.kind !== 'free'` in
   * lib/career/sources/discovery-types.ts) once paid sources are wired in.
   * Until then it is a declared constraint carried into that boundary, and the
   * UI copy claims nothing more than the ceiling.
   */
  usePaidSources: boolean

  // ── How the shape of the run follows from the mode ──
  /** Postings one job-first strategy aims at. This replaces the old `targetCount: 12`. */
  maxPostingsPerStrategy: number
  /** Search rounds inside one strategy session. */
  maxRoundsPerStrategy: number
  /** Job-first strategies a run may execute (before saturation stops it earlier). */
  maxStrategies: number
  /** Companies the company-first lane may check. */
  maxCompanyFirst: number
  /** Companies the scout itself may discover and check inside one run. */
  maxScoutCompanyChecks: number
  /** Share of the run's wall clock company-first may spend. */
  companyFirstTimeShare: number
  /** Share of the company-first budget the rotating `Explore` sample may take. */
  exploreShare: number
  /** Whether the free watchlist sweep runs first. */
  sweep: boolean
  saturation: SaturationPolicy
}

/** Nobody may configure a run above this, whatever they post. */
export const MAX_CONFIGURABLE_SPEND_USD = 100
/** Nobody may configure a run longer than this (one hour of worker invocations). */
export const MAX_CONFIGURABLE_RUNTIME_MS = 3_600_000

const QUICK: RunBudget = {
  mode: 'QUICK',
  maxRuntimeMs: 300_000,
  maxPagesPerSource: 1,
  maxQueryFamilies: 3,
  maxExtract: 15,
  maxFullFit: 12,
  maxSpendUsd: 0.75,
  usePaidSources: false,
  maxPostingsPerStrategy: 12,
  maxRoundsPerStrategy: 1,
  maxStrategies: 2,
  maxCompanyFirst: 60,
  maxScoutCompanyChecks: 5,
  companyFirstTimeShare: 0.6,
  exploreShare: 0.4,
  sweep: true,
  saturation: { minYieldRatio: 0.15, lowYieldStreak: 2, minSamples: 2 },
}

const BROAD: RunBudget = {
  mode: 'BROAD',
  maxRuntimeMs: 1_200_000,
  maxPagesPerSource: 5,
  maxQueryFamilies: 12,
  maxExtract: 80,
  maxFullFit: 40,
  maxSpendUsd: 4,
  usePaidSources: true,
  maxPostingsPerStrategy: 40,
  maxRoundsPerStrategy: 3,
  maxStrategies: 8,
  maxCompanyFirst: 250,
  maxScoutCompanyChecks: 15,
  companyFirstTimeShare: 0.35,
  exploreShare: 0.15,
  sweep: true,
  saturation: { minYieldRatio: 0.1, lowYieldStreak: 2, minSamples: 3 },
}

const EXHAUSTIVE: RunBudget = {
  mode: 'EXHAUSTIVE',
  maxRuntimeMs: MAX_CONFIGURABLE_RUNTIME_MS,
  maxPagesPerSource: 20,
  maxQueryFamilies: 40,
  maxExtract: 250,
  maxFullFit: 120,
  maxSpendUsd: 15,
  usePaidSources: true,
  maxPostingsPerStrategy: 100,
  maxRoundsPerStrategy: 5,
  maxStrategies: 24,
  maxCompanyFirst: 1000,
  maxScoutCompanyChecks: 30,
  companyFirstTimeShare: 0.25,
  exploreShare: 0.1,
  sweep: true,
  saturation: { minYieldRatio: 0.05, lowYieldStreak: 3, minSamples: 4 },
}

/**
 * What a caller that names no mode gets: the numbers this system already ran
 * with, and NO spend ceiling.
 *
 * A ceiling that appears because somebody added a feature is a ceiling nobody
 * agreed to — it could truncate the founder's twenty-minute CLI run without
 * anyone asking for it. So legacy callers keep spending exactly what they
 * spent before, and a ceiling only exists once a mode or an explicit
 * `maxSpendUsd` says so.
 *
 * And because this is the one path with no ceiling, its COUNTS are today's
 * too. Raising the per-strategy target to 40 and the fit evaluations to 40
 * here would have bought a bigger, more expensive run on the only caller
 * nobody had capped — roughly another dollar of fit evaluation per CLI run,
 * granted by a feature nobody had opted into. The raise belongs to the modes:
 * pick one and the run gets 40 (BROAD) or 100 (EXHAUSTIVE) postings per
 * strategy, under a ceiling that stops it.
 */
export const LEGACY_BUDGET: RunBudget = {
  ...BROAD,
  mode: 'LEGACY',
  maxSpendUsd: Number.POSITIVE_INFINITY,
  maxRuntimeMs: 1_200_000,
  maxFullFit: 12,
  maxPostingsPerStrategy: 12,
  maxStrategies: 3,
  maxRoundsPerStrategy: 2,
  maxExtract: 40,
  maxCompanyFirst: 25,
  maxScoutCompanyChecks: 10,
  companyFirstTimeShare: 0.55,
  exploreShare: 0.4,
  sweep: false,
  usePaidSources: true,
}

export const MODES: Record<RunMode, RunBudget> = { QUICK, BROAD, EXHAUSTIVE }

/** A posted value as a mode, or null. Never throws, never guesses. */
export function parseRunMode(value: unknown): RunMode | null {
  if (typeof value !== 'string') return null
  const v = value.trim().toUpperCase()
  return (RUN_MODES as readonly string[]).includes(v) ? (v as RunMode) : null
}

export interface BudgetOverrides {
  /** A user-set ceiling in dollars. Clamped to [0, MAX_CONFIGURABLE_SPEND_USD]. */
  maxSpendUsd?: number | null
  /** The wall clock this run actually has (a worker deadline, a CLI --deadline). */
  maxRuntimeMs?: number | null
  maxExtract?: number | null
  maxFullFit?: number | null
  maxStrategies?: number | null
  maxRoundsPerStrategy?: number | null
  maxCompanyFirst?: number | null
  /** False forbids paid sources whatever the mode says. Never turns them on. */
  usePaidSources?: boolean
}

function clampNumber(value: unknown, min: number, max: number): number | null {
  // `Number(null)` is 0, and an override that is ABSENT must not read as a
  // limit of zero — that is the difference between "use the mode's number"
  // and "this run may do none of that at all".
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return null
  return Math.max(min, Math.min(max, n))
}

function clampInt(value: unknown, min: number, max: number): number | null {
  const n = clampNumber(value, min, max)
  return n === null ? null : Math.floor(n)
}

/**
 * The budget a run will actually execute: a mode (or the legacy defaults),
 * with the caller's own ceilings applied on top.
 *
 * An override never RAISES a limit above what is configurable, and
 * `usePaidSources: false` can only turn paid sources off — a request cannot
 * talk a QUICK run into spending money.
 */
export function resolveRunBudget(mode: RunMode | BudgetLabel | null | undefined, overrides: BudgetOverrides = {}): RunBudget {
  const base = mode && mode !== 'LEGACY' && MODES[mode as RunMode] ? MODES[mode as RunMode] : LEGACY_BUDGET
  const spend = overrides.maxSpendUsd === null || overrides.maxSpendUsd === undefined ? null : clampNumber(overrides.maxSpendUsd, 0, MAX_CONFIGURABLE_SPEND_USD)
  const runtime = overrides.maxRuntimeMs === null || overrides.maxRuntimeMs === undefined ? null : clampInt(overrides.maxRuntimeMs, 1_000, MAX_CONFIGURABLE_RUNTIME_MS)
  return {
    ...base,
    saturation: { ...base.saturation },
    maxSpendUsd: spend ?? base.maxSpendUsd,
    maxRuntimeMs: runtime ?? base.maxRuntimeMs,
    maxExtract: clampInt(overrides.maxExtract, 0, 2000) ?? base.maxExtract,
    maxFullFit: clampInt(overrides.maxFullFit, 0, 500) ?? base.maxFullFit,
    maxStrategies: clampInt(overrides.maxStrategies, 0, 64) ?? base.maxStrategies,
    maxRoundsPerStrategy: clampInt(overrides.maxRoundsPerStrategy, 1, 12) ?? base.maxRoundsPerStrategy,
    maxCompanyFirst: clampInt(overrides.maxCompanyFirst, 0, 5000) ?? base.maxCompanyFirst,
    usePaidSources: overrides.usePaidSources === false ? false : base.usePaidSources,
  }
}

export interface ModeDescription {
  mode: RunMode
  label: string
  /** One line, in the founder's language — never "strategies" or "rounds". */
  blurb: string
  /** What it typically costs and how long it typically takes. */
  cost: string
  runtime: string
}

/**
 * Copy for the UI. Kept beside the numbers so the two cannot drift apart.
 *
 * Every sentence here is a claim about what the code does, and it is held to
 * that: the ceiling is enforced by the ledger, the runtime is the run-total
 * clock the orchestrator keeps in the cursor, and neither says "nothing paid"
 * — every mode makes model calls, and what bounds them is the ceiling.
 */
export const MODE_DESCRIPTIONS: Record<RunMode, ModeDescription> = {
  QUICK: {
    mode: 'QUICK',
    label: 'Quick',
    blurb: 'Free feeds, boards we already know, and the companies you chose. The cheapest useful pass.',
    cost: 'about $0.25–0.75',
    runtime: 'a few minutes',
  },
  BROAD: {
    mode: 'BROAD',
    label: 'Broad',
    blurb: 'Every free source, many kinds of search, real pagination — the market, not your watchlist.',
    cost: 'up to about $4',
    runtime: 'up to 20 minutes, resumable',
  },
  EXHAUSTIVE: {
    mode: 'EXHAUSTIVE',
    label: 'Exhaustive',
    blurb: 'Everything configured, searched deep, until the sources stop producing anything new.',
    cost: 'up to about $15',
    runtime: 'up to an hour, across several passes',
  },
}

export function describeMode(mode: RunMode): ModeDescription {
  return MODE_DESCRIPTIONS[mode]
}

/** Human line for a run's stats and the report: what this run was allowed to do. */
export function summarizeBudget(b: RunBudget): string {
  const spend = Number.isFinite(b.maxSpendUsd) ? `$${b.maxSpendUsd.toFixed(2)} ceiling` : 'no spend ceiling'
  return (
    `${b.mode}: ${spend} · ${Math.round(b.maxRuntimeMs / 60_000)} min · ` +
    `${b.maxQueryFamilies} query families · ${b.maxPagesPerSource} pages/source · ` +
    `${b.maxPostingsPerStrategy}/strategy · extract ${b.maxExtract} · full fit ${b.maxFullFit} · ` +
    `paid sources ${b.usePaidSources ? 'on' : 'off'} · explore share ${Math.round(b.exploreShare * 100)}%`
  )
}
