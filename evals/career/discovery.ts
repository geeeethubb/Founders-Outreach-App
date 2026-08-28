// The DISCOVERY EVAL (docs/CAREER_OS.md §9, "discovery"). Three parts, no DB:
//
//   (a) COMPANY-FIRST over the benchmark's keyless boards: the real adapters
//       list internships, the real extractor (cheap tier) classifies them,
//       clusterJobs dedupes, and every ATS-listed job is re-verified through
//       the ATS — measuring classification, location, duplicates, canonical
//       URLs and stale-shown-open the way the product would show them.
//   (b) JOB-FIRST: one real runJobScout in memory — planner, scout sessions,
//       tools, resolve, extractor, verifier — with company-first switched off,
//       because (a) already measured it. This is "relevant openings found".
//   (c) P@20: the union, ranked by the Fit Evaluator with no research, judged
//       by the independent career-advisor judge.
//
// Everything paid is cached by content, so a re-run after a fix costs only
// what changed. Everything measured is reported with n; nothing is silently
// dropped from a denominator.

import fs from 'fs'
import path from 'path'
import type { ToolContext } from '@/lib/agents/runtime/types'
import { mapWithConcurrency } from '@/lib/scouting/concurrency'
import { runJobScout, type JobScoutResult, type ScoutStore } from '@/lib/career/scout/orchestrator'
import { checkCompanyForOpenings, type CompanyCheckResult, type CompanyFirstStore } from '@/lib/career/scout/company-first'
import { extractAndNormalize } from '@/lib/career/scout/extract'
import { emptyStats, type ScoutStats } from '@/lib/career/scout/stats'
import { INTERNSHIP_LOOKUP_LIMIT } from '@/lib/career/scout/tools'
import { clusterJobs } from '@/lib/career/jobs/dedupe'
import { BAY_AREA_CITIES, METRO_ALIASES } from '@/lib/career/jobs/location'
import { normalizeCompanyName, type NormalizedJob } from '@/lib/career/jobs/normalize'
import { verifyJob } from '@/lib/career/jobs/verify'
import { getPageFetcher } from '@/lib/career/sources/fetch'
import { getSourceRegistry, matchAnyAtsUrl } from '@/lib/career/sources/registry'
import type { PageFetcher, RawJobPosting, SourceRegistry } from '@/lib/career/sources/types'
import type { CareerMission } from '@/lib/career/types'
import type { CareerRun as Run } from '@/lib/career/runs'
import { judgeJobRelevance, type JobVerdict } from './judge'
import { canonicalUrlAccuracy, duplicateRate, hostOf, precisionAtK, staleShownOpenRate } from './metrics'
import { EVAL_USER, blindForJudge, count, fitCached, judgeDescription, memoryRun, rate, toJobOpportunity, type EvalBank, type MetricResult } from './harness'

export const ATS_HOSTS = ['boards.greenhouse.io', 'job-boards.greenhouse.io', 'jobs.lever.co', 'jobs.ashbyhq.com']
const KEYLESS = new Set(['greenhouse', 'lever', 'ashby'])
const INTERN_TITLE = /\b(intern|internship|co-?op)\b/i
/**
 * checkCompanyForOpenings lists INTERNSHIP_LOOKUP_LIMIT postings per board,
 * applied AFTER the internship filter — so a board with more internships than
 * that hands back a truncated pool. The pool is what this eval measures, so a
 * board that filled the cap is counted and named; the number is a ceiling on
 * what the product could have shown, not a bug in it.
 */
const COMPANY_FIRST_LISTING_CAP = INTERNSHIP_LOOKUP_LIMIT
/** The extraction budget follows the pool: every internship-like posting listed, within a ceiling that keeps a first run near the suite budget. */
const MAX_EXTRACT_CEILING = 150
const MIN_EXTRACT = 60

export interface BenchmarkCompany {
  name: string
  domain: string
  hq_metro: string
  tier: 1 | 2 | 3
  company_type: string
  industry_tags: string[]
  known_ats: string
  known_board_identifier: string | null
  careers_url: string
  expects_summer_internships: boolean
  note: string
}

export function loadBenchmark(): BenchmarkCompany[] {
  return (JSON.parse(fs.readFileSync(path.resolve('evals/career/fixtures/benchmark-companies.json'), 'utf8')) as { companies: BenchmarkCompany[] }).companies
}

export function keylessBoards(companies: BenchmarkCompany[]): BenchmarkCompany[] {
  return companies.filter((c) => KEYLESS.has(c.known_ats) && c.known_board_identifier)
}

const memoryCompanyStore: CompanyFirstStore = {
  async markCareersChecked() { return { error: null } },
  async ensureCompany() { return { id: 'mem', error: null, migrationMissing: false } },
  async upsertWatch(_u, input) { return { id: `mem-${input.name}`, error: null, migrationMissing: false } },
}

// ─── (a) Company-first ───────────────────────────────────────────────────────

export interface CompanyFirstEval {
  perCompany: { name: string; ats: string; postings: number; method: string; note: string; error: string | null; at_cap: boolean }[]
  /** Boards whose internship listing filled the per-board cap — their pool may be truncated. */
  boardsAtCap: number
  postingsListed: number
  zeroInternships: string[]
  jobs: NormalizedJob[]
  clusters: number
  rejected: Record<string, number>
  internshipDisagreements: { company: string; title: string; employment_type: string; titleSaysIntern: boolean }[]
  location: { onsite: number; citySane: number; atHq: number; tierAgrees: number; tierMismatches: { company: string; location_raw: string | null; tier: number | null; expected: number }[] }
  stale: { shownOpen: number; closed: number; errors: number; notOpen: { company: string; title: string; status: string; note: string }[] }
  metrics: MetricResult[]
  stats: ScoutStats
  costUsd: number
}

/** Is the posting at the company's HQ metro? City-level, through the same aliases the tiering uses. */
export function atHeadquarters(job: Pick<NormalizedJob, 'location_city' | 'location_raw'>, hqMetro: string): boolean {
  const city = job.location_city?.toLowerCase()
  if (!city) return false
  const names = new Set<string>()
  for (const piece of hqMetro.toLowerCase().split(/\s*[\/,]\s*/)) {
    const p = piece.trim()
    if (!p) continue
    names.add(p)
    for (const a of METRO_ALIASES[p] ?? []) names.add(a)
    if (p === 'bay area') for (const c of BAY_AREA_CITIES) names.add(c)
  }
  return names.has(city)
}

export async function runCompanyFirstEval(params: { companies: BenchmarkCompany[]; mission: CareerMission; ctx: ToolContext; registry?: SourceRegistry; fetcher?: PageFetcher; maxExtract?: number; log?: (line: string) => void }): Promise<CompanyFirstEval> {
  const registry = params.registry ?? getSourceRegistry()
  const fetcher = params.fetcher ?? getPageFetcher()
  const log = params.log ?? (() => {})
  const run = memoryRun()
  const stats = emptyStats()

  const outcomes: (CompanyCheckResult & { company: BenchmarkCompany; atCap: boolean })[] = []
  await mapWithConcurrency(params.companies, 4, async (c) => {
    const r = await checkCompanyForOpenings(EVAL_USER, { id: c.name, name: c.name, domain: c.domain, careers_url: c.careers_url, ats_type: c.known_ats, ats_identifier: c.known_board_identifier }, { internshipsOnly: true }, { registry, fetcher, store: memoryCompanyStore })
    const atCap = !!r.board && r.postings.length >= COMPANY_FIRST_LISTING_CAP
    outcomes.push({ ...r, company: c, atCap })
    log(`${c.name.padEnd(28)} ${c.known_ats.padEnd(10)} ${String(r.postings.length).padStart(3)} internship-like postings · ${r.note}${atCap ? ` · filled the ${COMPANY_FIRST_LISTING_CAP} cap, pool may be truncated` : ''}${r.error ? ` · ERROR ${r.error}` : ''}`)
  })
  outcomes.sort((a, b) => a.company.name.localeCompare(b.company.name))
  const raws: RawJobPosting[] = outcomes.flatMap((o) => o.postings)

  // Every listed posting is internship-like already (internshipsOnly), so the budget is the pool, within the ceiling.
  const maxExtract = params.maxExtract ?? Math.min(MAX_EXTRACT_CEILING, Math.max(MIN_EXTRACT, raws.length))
  const ex = await extractAndNormalize(raws, { mission: params.mission, ctx: params.ctx, run, maxExtract, concurrency: 4, stats, onProgress: (d) => log(`  extract: ${d}`) })
  const clustered = clusterJobs(ex.jobs)
  const jobs = clustered.merged
  const byName = new Map(params.companies.map((c) => [normalizeCompanyName(c.name) ?? c.name.toLowerCase(), c]))
  const companyOf = (j: NormalizedJob) => byName.get(normalizeCompanyName(j.company_name) ?? j.company_name.toLowerCase()) ?? null

  // Internship classification: the extractor's answer vs a strict title regex, on extracted rows only.
  const extracted = jobs.filter((j) => j.extraction_version)
  const internshipDisagreements = extracted
    .filter((j) => (j.employment_type === 'internship' || j.employment_type === 'co_op') !== INTERN_TITLE.test(j.title))
    .map((j) => ({ company: j.company_name, title: j.title, employment_type: j.employment_type, titleSaysIntern: INTERN_TITLE.test(j.title) }))

  // Location: parsed city must appear in the raw string; at HQ, the tier must be the benchmark's.
  const onsite = jobs.filter((j) => j.work_mode !== 'remote' && j.location_city)
  const citySane = onsite.filter((j) => (j.location_raw ?? '').toLowerCase().includes(j.location_city!.toLowerCase()))
  const tierMismatches: CompanyFirstEval['location']['tierMismatches'] = []
  let atHq = 0
  let tierAgrees = 0
  for (const j of onsite) {
    const c = companyOf(j)
    if (!c || !atHeadquarters(j, c.hq_metro)) continue
    atHq++
    if (j.location_tier === c.tier) tierAgrees++
    else tierMismatches.push({ company: c.name, location_raw: j.location_raw, tier: j.location_tier, expected: c.tier })
  }

  // Stale-shown-open: listed on the board this run ⇒ the product shows VERIFIED_OPEN. Ask the ATS again, per job.
  const notOpen: CompanyFirstEval['stale']['notOpen'] = []
  const verifyRows: { shownOpen: boolean; actuallyOpen: boolean }[] = []
  let verifyErrors = 0
  await mapWithConcurrency(jobs, 4, async (j) => {
    j.verification_status = 'VERIFIED_OPEN'
    j.verification_method = 'ats_listing'
    const v = await verifyJob(j, { registry, fetcher })
    if (v.status === 'ERROR') { verifyErrors++; return }
    verifyRows.push({ shownOpen: true, actuallyOpen: v.status === 'VERIFIED_OPEN' || v.status === 'LIKELY_OPEN' })
    if (v.status !== 'VERIFIED_OPEN' && v.status !== 'LIKELY_OPEN') notOpen.push({ company: j.company_name, title: j.title, status: v.status, note: v.note })
  })

  const dupRate = duplicateRate(clustered.clusters.map((c) => ({ size: c.length })))
  const canon = canonicalUrlAccuracy(jobs, ATS_HOSTS)
  const staleRate = staleShownOpenRate(verifyRows)
  const internAcc = extracted.length ? 1 - internshipDisagreements.length / extracted.length : 0
  const cityRate = onsite.length ? citySane.length / onsite.length : 0
  const hqRate = atHq ? tierAgrees / atHq : 0
  const withOpenings = outcomes.filter((o) => o.postings.length > 0).length
  const boardsAtCap = outcomes.filter((o) => o.atCap).length
  const metrics: MetricResult[] = [
    count('boards with ≥1 internship-like posting', withOpenings, outcomes.length, 'reported', true, `${raws.length} postings listed · ${boardsAtCap} board(s) filled the ${COMPANY_FIRST_LISTING_CAP} cap · ${Math.min(maxExtract, raws.length)} extracted`),
    rate('internship classification agreement (extractor vs title)', internAcc, extracted.length, 'reported; disagreements read', true),
    rate('location: parsed city appears in location_raw', cityRate, onsite.length, '≥ 95%', cityRate >= 0.95),
    rate('location: tier agrees with benchmark at HQ', hqRate, atHq, '≥ 90%', hqRate >= 0.9),
    rate('duplicate rate', dupRate, ex.jobs.length, '< 3%', dupRate < 0.03),
    rate('canonical URL on the board ATS host', canon, jobs.length, '≥ 95%', canon >= 0.95),
    rate('stale shown open (ATS re-check)', staleRate, verifyRows.length, '< 3%', staleRate < 0.03, verifyErrors ? `${verifyErrors} re-check error(s) excluded` : undefined),
  ]

  return {
    perCompany: outcomes.map((o) => ({ name: o.company.name, ats: o.company.known_ats, postings: o.postings.length, method: o.method, note: o.note, error: o.error, at_cap: o.atCap })),
    boardsAtCap, postingsListed: raws.length,
    zeroInternships: outcomes.filter((o) => o.postings.length === 0).map((o) => o.company.name),
    jobs, clusters: clustered.clusters.length, rejected: stats.jobs_rejected, internshipDisagreements,
    location: { onsite: onsite.length, citySane: citySane.length, atHq, tierAgrees, tierMismatches },
    stale: { shownOpen: verifyRows.length, closed: notOpen.length, errors: verifyErrors, notOpen },
    metrics, stats, costUsd: run.costUsd(),
  }
}

// ─── (b) Job-first ───────────────────────────────────────────────────────────

export interface JobFirstEval {
  result: JobScoutResult
  jobs: NormalizedJob[]
  canonical: { ok: number; miss: { company: string; title: string; canonical_url: string | null; source_types: string[] }[] }
  metrics: MetricResult[]
  runtimeMs: number
}

/** A host counts when it is any known ATS family or the company's own domain; an aggregator (or no URL) is a miss. */
export function firstPartyHost(job: Pick<NormalizedJob, 'canonical_url' | 'company_domain' | 'company_name'>): boolean {
  const host = hostOf(job.canonical_url)
  if (!host) return false
  if (matchAnyAtsUrl(job.canonical_url!)) return true
  const domain = job.company_domain?.toLowerCase().replace(/^www\./, '')
  if (domain && (host === domain || host.endsWith(`.${domain}`))) return true
  const token = (normalizeCompanyName(job.company_name) ?? '').split(/\s+/).find((t) => t.length >= 4)
  return !!token && host.replace(/[^a-z0-9]/g, '').includes(token.replace(/[^a-z0-9]/g, ''))
}

export function memoryScoutStore(bank: EvalBank, mission: CareerMission, run: Run): { store: ScoutStore; jobs: NormalizedJob[] } {
  const jobs: NormalizedJob[] = []
  const watch: Record<string, unknown>[] = []
  const store: ScoutStore = {
    ...memoryCompanyStore,
    async upsertWatch(_u, input) {
      if (!watch.some((w) => w.name === input.name)) watch.push({ id: `w-${watch.length}`, name: input.name, domain: input.domain ?? null, careers_url: null, ats_type: null, ats_identifier: null, watch_status: input.watch_status, watch_priority: input.watch_priority ?? 0 })
      return { id: `w-${input.name}`, error: null, migrationMissing: false }
    },
    async getMission() { return { mission, error: null, migrationMissing: false } },
    async loadBank() { return { bank: bank.bank, migrationMissing: false, errors: [] } },
    async recentFeedback() { return [] },
    async startRun() { return run },
    async listWatchlist() { return { companies: [...watch], error: null, migrationMissing: false } },
    async listJobs() { return { jobs: [], error: null, migrationMissing: false } },
    async upsertJobs(_u, rows) { jobs.push(...rows); return { inserted: rows.length, updated: 0, skippedClosed: 0, ids: rows.map((_, i) => `mem-${i}`), companyIds: {}, errors: [], migrationMissing: false } },
  }
  return { store, jobs }
}

export async function runJobFirstEval(params: { bank: EvalBank; mission: CareerMission; log?: (stage: string, detail: string) => void }): Promise<JobFirstEval> {
  const started = Date.now()
  const run = memoryRun()
  const { store, jobs } = memoryScoutStore(params.bank, params.mission, run)
  const result = await runJobScout(
    { userId: EVAL_USER, budget: { deadlineMs: 600_000 }, maxStrategies: 2, maxRoundsPerStrategy: 2, maxCompaniesFirst: 0, maxExtract: 25, verify: true, onProgress: params.log, label: 'discovery eval' },
    { store, rank: async () => ({ results: {}, skipped: [], costUsd: 0, errors: [], runId: null }) }
  )
  const miss = jobs.filter((j) => !firstPartyHost(j)).map((j) => ({ company: j.company_name, title: j.title, canonical_url: j.canonical_url, source_types: [...new Set(j.sources.map((s) => s.source_type))] }))
  const ok = jobs.length - miss.length
  const canon = jobs.length ? ok / jobs.length : 0
  const metrics: MetricResult[] = [
    count('job-first: openings found (after constraints)', jobs.length, result.stats.postings_seen, 'reported', true, `${result.stats.postings_seen} seen · ${result.stats.postings_resolved} resolved`),
    rate('job-first: canonical URL first-party (ATS family or company domain)', canon, jobs.length, '≥ 95%', canon >= 0.95),
  ]
  return { result, jobs, canonical: { ok, miss }, metrics, runtimeMs: Date.now() - started }
}

// ─── (c) P@20 ────────────────────────────────────────────────────────────────

export interface RankedRow {
  jobId: string
  company: string
  title: string
  location_raw: string | null
  tier: number | null
  benchmarkTier: number | null
  season: string
  overall: number | null
  band: string | null
  eligibility: string | null
  judge: JobVerdict | null
  reasoning: string | null
  canonical_url: string | null
  source: 'company_first' | 'job_first' | 'both'
  /** The evaluator's per-dimension numbers, so a BAD_FIT in the top 20 can be traced to the dimension that put it there. */
  components: Record<string, number> | null
  gates: string[]
}

export interface PrecisionEval {
  rows: RankedRow[]
  top20: RankedRow[]
  metrics: MetricResult[]
  eligibility: Record<string, number>
  fitFailures: string[]
  costUsd: number
  judgeCostUsd: number
  judgeError: string | null
}

export async function runPrecisionEval(params: { companyFirst: NormalizedJob[]; jobFirst: NormalizedJob[]; benchmark: BenchmarkCompany[]; bank: EvalBank; mission: CareerMission; ctx: ToolContext; maxFit?: number; log?: (line: string) => void }): Promise<PrecisionEval> {
  const log = params.log ?? (() => {})
  const run = memoryRun()
  const origin = new Map<NormalizedJob, RankedRow['source']>()
  for (const j of params.companyFirst) origin.set(j, 'company_first')
  for (const j of params.jobFirst) origin.set(j, 'job_first')
  const union = clusterJobs([...params.companyFirst, ...params.jobFirst])
  const sourceOf = (cluster: NormalizedJob[]): RankedRow['source'] => {
    const kinds = new Set(cluster.map((j) => origin.get(j)))
    return kinds.size > 1 ? 'both' : [...kinds][0] ?? 'company_first'
  }
  // Extracted rows first: a thin heuristic row is a weaker candidate for the fit evaluator.
  // Run 3 capped at 70 and left 15 extracted job-first jobs unranked — the mission-targeted ones; run 5's cap of 90 held
  // only because the boards were capped at 40 each. Now every canonical is ranked unless the caller sets maxFit.
  const ordered = union.clusters.map((cluster, i) => ({ job: union.merged[i], source: sourceOf(cluster) })).sort((a, b) => Number(!!b.job.extraction_version) - Number(!!a.job.extraction_version))
  const candidates = params.maxFit ? ordered.slice(0, params.maxFit) : ordered
  const byName = new Map(params.benchmark.map((c) => [normalizeCompanyName(c.name) ?? c.name.toLowerCase(), c.tier]))
  const fitFailures: string[] = []
  const rows: RankedRow[] = []

  await mapWithConcurrency(candidates, 3, async ({ job, source }) => {
    const id = `disc:${job.canonical_url ?? job.sources[0]?.source_url ?? job.title}`
    const fit = await fitCached(toJobOpportunity(job, id, params.mission), params.bank, params.mission, params.ctx, run)
    if (!fit.judgment) fitFailures.push(`${job.company_name} / ${job.title}: ${fit.error ?? fit.status}`)
    rows.push({
      jobId: id, company: job.company_name, title: job.title, location_raw: job.location_raw, tier: job.location_tier,
      benchmarkTier: byName.get(normalizeCompanyName(job.company_name) ?? job.company_name.toLowerCase()) ?? null, season: job.season_relevance,
      overall: fit.evaluation?.overall ?? null, band: fit.evaluation?.band ?? null, eligibility: fit.judgment?.eligibility ?? null, judge: null, reasoning: null,
      canonical_url: job.canonical_url, source,
      components: fit.judgment ? Object.fromEntries(fit.judgment.components.map((c) => [c.dimension, c.score])) : null, gates: fit.evaluation?.gates ?? [],
    })
    log(`fit ${rows.length}/${candidates.length} ${job.company_name} / ${job.title}: ${fit.evaluation?.overall.toFixed(3) ?? fit.status} ${fit.judgment?.eligibility ?? ''}`)
  })
  rows.sort((a, b) => (b.overall ?? -1) - (a.overall ?? -1))
  const top20 = rows.slice(0, 20)

  const jobByRow = new Map(candidates.map((c) => [`disc:${c.job.canonical_url ?? c.job.sources[0]?.source_url ?? c.job.title}`, c.job]))
  const blind = blindForJudge(top20.map((r) => ({ job_id: r.jobId, company: r.company, title: r.title, location: r.location_raw, description: judgeDescription(jobByRow.get(r.jobId)?.description_text ?? null) })))
  const judged = await judgeJobRelevance(params.bank.missionText, params.bank.judgeBackground, blind.inputs)
  for (const j of judged.results) { const r = top20.find((x) => x.jobId === blind.unblind(j.job_id)); if (r) { r.judge = j.verdict; r.reasoning = j.reasoning } }

  const verdicts = top20.map((r) => r.judge)
  const relevant = (v: JobVerdict | null) => v === 'GOOD_FIT' || v === 'STRETCH'
  const p20 = precisionAtK(verdicts, 20, relevant)
  const bad = top20.filter((r) => r.judge === 'BAD_FIT').length
  // Secondary views of the same judged rows — reported, never the target. P@10 says whether the head of the list is
  // right; the band view says whether the jobs the product would show as GOOD/STRONG are the ones the judge would
  // show. Neither hides a BAD_FIT from the top 20: that number stands on its own.
  const p10 = precisionAtK(verdicts, 10, relevant)
  const goodBand = top20.filter((r) => r.band === 'GOOD' || r.band === 'STRONG')
  const pBand = goodBand.length ? goodBand.filter((r) => relevant(r.judge)).length / goodBand.length : 0
  const eligibility: Record<string, number> = {}
  for (const r of rows) eligibility[r.eligibility ?? 'NONE'] = (eligibility[r.eligibility ?? 'NONE'] ?? 0) + 1
  const covered = verdicts.every(Boolean)
  const metrics: MetricResult[] = [
    rate('P@20 (judge GOOD_FIT|STRETCH)', p20, top20.length, '≥ 80%', p20 >= 0.8 && covered && top20.length === 20, top20.length < 20 ? `only ${top20.length} ranked jobs` : covered ? `${rows.length} ranked` : 'judge did not cover every job'),
    count('BAD_FIT in the top 20', bad, top20.length, 'reported', true),
    rate('secondary: P@10 (judge GOOD_FIT|STRETCH)', p10, Math.min(10, top20.length), 'reported (secondary)', true),
    rate('secondary: precision over GOOD|STRONG bands in the top 20', pBand, goodBand.length, 'reported (secondary)', true, goodBand.length ? undefined : 'no job reached the GOOD band'),
    count('fit evaluations that failed', fitFailures.length, candidates.length, '= 0', fitFailures.length === 0),
  ]
  return { rows, top20, metrics, eligibility, fitFailures, costUsd: run.costUsd(), judgeCostUsd: judged.costUsd, judgeError: judged.error ?? null }
}

