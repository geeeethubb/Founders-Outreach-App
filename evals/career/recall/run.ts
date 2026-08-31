// One broad discovery run over the fixture corpus, using the product's own
// pipeline stages and nothing invented for the test.
//
//   sources → page until exhausted → coverage ledger
//           → buildNormalizedJob   (lib/career/jobs/normalize)
//           → clusterJobs          (lib/career/jobs/dedupe)
//           → applyHardConstraints (lib/career/jobs/filters)
//           → scoreRelevance       (lib/career/jobs/inbox-relevance)
//
// Every one of those is the shipped implementation. If the suite passed against
// a private copy of the pipeline it would be measuring a copy.
//
// RANKING IS RELEVANCE ONLY. There is no diversity term anywhere in the sort,
// deliberately: `lib/career/discovery/diversity.ts` says in its own header that
// it must never become a reranker, because hiding one employer's postings makes
// the number look better while the search stays exactly as narrow. So the top
// 50 is whatever relevance produced, and if one company owns it, the test says
// so. Ties break on score, then recency, then company and title alphabetically
// — a deterministic, subject-neutral order, not a spreading heuristic.

import { emptyCoverageLedger, recordSearchResult, coverageRows, coverageTotals, type CoverageLedger, type SourceCoverage, type CoverageTotals } from '@/lib/career/discovery/coverage'
import { measureDiversity, type DiversityReport } from '@/lib/career/discovery/diversity'
import { buildSearchOntology, type SearchOntology } from '@/lib/career/ontology'
import { applyHardConstraints } from '@/lib/career/jobs/filters'
import { bandFor, relevanceContext, scoreRelevance, type InboxRelevance } from '@/lib/career/jobs/inbox-relevance'
import { buildNormalizedJob, type NormalizedJob } from '@/lib/career/jobs/normalize'
import { clusterJobs } from '@/lib/career/jobs/dedupe'
import type { RawJobPosting } from '@/lib/career/sources/types'
import type { DiscoveryRegistry, JobDiscoverySource } from '@/lib/career/sources/discovery-types'
import type { CareerMission, EvidenceBank } from '@/lib/career/types'
import { urlKey } from './corpus'
import type { MeasuredJob } from './metrics'
import { recallEvidenceBank, recallMission } from './bank'
import { recallRegistry, type RecallRegistry } from './sources'

/** Pages one source may be asked for. Generous — the point is to page to exhaustion. */
export const MAX_PAGES_PER_SOURCE = 60

export interface RankedJob {
  job: NormalizedJob
  relevance: InboxRelevance
  sourceIds: string[]
  clusterSize: number
  retained: boolean
  constraintFailures: string[]
}

export interface RecallRunResult {
  ontology: SearchOntology
  mission: CareerMission
  /** Every raw posting every configured source returned, before normalization. */
  rawCount: number
  /** After clustering: one record per opportunity. */
  jobs: RankedJob[]
  /** The jobs that survived the mission's hard constraints, in relevance order. */
  accepted: RankedJob[]
  top50: RankedJob[]
  coverage: { rows: SourceCoverage[]; totals: CoverageTotals }
  diversityAll: DiversityReport
  diversityTop50: DiversityReport
  unconfigured: { id: string; name: string; reason: string }[]
  unadaptedPlatforms: string[]
  /** Source ids that returned at least one posting. */
  configuredIds: string[]
  errors: string[]
}

async function drain(
  source: JobDiscoverySource,
  ledger: CoverageLedger,
  maxPages: number,
  internshipsOnly: boolean
): Promise<{ postings: RawJobPosting[]; errors: string[] }> {
  const postings: RawJobPosting[] = []
  const errors: string[] = []
  let cursor: string | null = null
  for (let page = 0; page < maxPages; page++) {
    // Pull feeds enumerate: ask for everything the season and the internship
    // filter allow, and let ranking decide. Handing a pull feed the direction's
    // terms would pre-filter the inventory with the very vocabulary the
    // diversity test is trying to check, and a term the ontology happens to
    // miss would silently become a company nobody ever sees.
    const result = await source.search({ internshipsOnly }, cursor)
    recordSearchResult(ledger, source, result)
    postings.push(...result.postings)
    if (result.error) errors.push(`${source.id}: ${result.error}`)
    if (result.exhausted || !result.nextCursor) break
    cursor = result.nextCursor
    if (page === maxPages - 1) errors.push(`${source.id}: stopped at the ${maxPages}-page cap with a cursor still open`)
  }
  return { postings, errors }
}

export interface RecallRunOptions {
  bank?: EvidenceBank
  mission?: CareerMission
  registry?: RecallRegistry
  maxPagesPerSource?: number
  /** Platforms treated as adapted. Defaults to what lib/career/sources/registry.ts ships. */
  platforms?: readonly string[]
  /**
   * What the sources are asked for. `true` is the shipped configuration: every
   * adapter runs its own `internshipLike` title pre-filter first.
   *
   * `false` drains the boards WHOLE, so the 107 hand-labelled non-internships
   * reach `buildNormalizedJob` and `applyHardConstraints` instead of being
   * removed a layer earlier. That second pass is how precision gets a number
   * that is about the product's classifier rather than about the source filter
   * that ran ahead of it — see `measurePrecision`'s
   * `negativesFilteredBeforeScoring`.
   */
  internshipsOnly?: boolean
}

export async function runRecallDiscovery(opts: RecallRunOptions = {}): Promise<RecallRunResult> {
  const bank = opts.bank ?? recallEvidenceBank()
  const built = opts.registry ?? recallRegistry({ platforms: opts.platforms })
  const registry: DiscoveryRegistry = built.registry
  const maxPages = opts.maxPagesPerSource ?? MAX_PAGES_PER_SOURCE

  // The evidence bank, through the product's own ontology, becomes the role
  // families the relevance scorer treats as stated subjects. Nothing is typed
  // in twice: what the founder can prove is what discovery is judged against.
  const baseMission = opts.mission ?? recallMission()
  const ontology = buildSearchOntology({ bank, mission: baseMission })
  const mission: CareerMission = {
    ...baseMission,
    preferences: {
      ...baseMission.preferences,
      role_families: ontology.roleFamilies.slice(0, 10).map((f) => f.label),
    },
  }

  const ledger = emptyCoverageLedger()
  const raws: RawJobPosting[] = []
  const errors: string[] = []
  const sourceIdByKey = new Map<string, Set<string>>()

  for (const source of registry.configured()) {
    const { postings, errors: sourceErrors } = await drain(source, ledger, maxPages, opts.internshipsOnly !== false)
    errors.push(...sourceErrors)
    for (const p of postings) {
      raws.push(p)
      const key = urlKey(p.canonical_url ?? p.source_url) ?? `${p.company_name}|${p.title}`.toLowerCase()
      const set = sourceIdByKey.get(key) ?? new Set<string>()
      set.add(source.id)
      sourceIdByKey.set(key, set)
    }
  }

  const normalized = raws.map((raw) => buildNormalizedJob(raw))
  const { clusters, merged } = clusterJobs(normalized)
  const sizeByCanonical = new Map<string, number>()
  for (const cluster of clusters) {
    for (const job of cluster) {
      const k = urlKey(job.canonical_url) ?? `${job.company_key}|${job.normalized_title}`
      sizeByCanonical.set(k, Math.max(sizeByCanonical.get(k) ?? 0, cluster.length))
    }
  }

  const ctx = relevanceContext(mission)
  const ranked: RankedJob[] = merged.map((job) => {
    const key = urlKey(job.canonical_url) ?? `${job.company_key}|${job.normalized_title}`
    const ids = new Set<string>()
    for (const s of job.sources) {
      const sk = urlKey(s.canonical_url ?? s.source_url) ?? `${s.company_name}|${s.title}`.toLowerCase()
      for (const id of sourceIdByKey.get(sk) ?? []) ids.add(id)
    }
    const constraint = applyHardConstraints(job, mission.hard_constraints ?? [])
    return {
      job,
      relevance: scoreRelevance(
        {
          title: job.title,
          location_raw: job.location_raw,
          location_tier: job.location_tier,
          role_family: job.role_family,
          industry: job.industry,
          skills: job.skills,
          employment_type: job.employment_type,
          season_relevance: job.season_relevance,
          extraction_version: job.extraction_version,
          fit_overall: job.fit_overall,
        },
        ctx
      ),
      sourceIds: [...ids],
      clusterSize: sizeByCanonical.get(key) ?? 1,
      retained: constraint.pass,
      constraintFailures: constraint.failed.map((f) => f.label),
    }
  })

  const order = (a: RankedJob, b: RankedJob): number =>
    b.relevance.score - a.relevance.score ||
    (b.job.posted_at ?? '').localeCompare(a.job.posted_at ?? '') ||
    a.job.company_name.localeCompare(b.job.company_name) ||
    a.job.title.localeCompare(b.job.title)

  const accepted = ranked.filter((r) => r.retained).sort(order)
  const top50 = accepted.slice(0, 50)

  const toItem = (r: RankedJob) => ({
    key: urlKey(r.job.canonical_url) ?? `${r.job.company_key}|${r.job.normalized_title}`,
    companyName: r.job.company_name,
    companyKey: r.job.company_key,
    companyDomain: r.job.company_domain,
    title: r.job.title,
    roleFamily: r.job.role_family,
    industry: r.job.industry,
    sourceId: r.sourceIds[0] ?? null,
    locationRaw: r.job.location_raw,
    state: r.job.location_state,
    country: r.job.location_country,
    remote: r.job.work_mode === 'remote',
  })

  return {
    ontology,
    mission,
    rawCount: raws.length,
    jobs: ranked.sort(order),
    accepted,
    top50,
    coverage: { rows: coverageRows(ledger), totals: coverageTotals(ledger) },
    diversityAll: measureDiversity(accepted.map(toItem)),
    diversityTop50: measureDiversity(top50.map(toItem)),
    unconfigured: registry.unconfigured().map((u) => ({ id: u.id, name: u.name, reason: u.reason })),
    unadaptedPlatforms: built.unadaptedPlatforms,
    configuredIds: built.configuredIds,
    errors,
  }
}

/** The metric layer's view of a ranked job. */
export function toMeasured(r: RankedJob): MeasuredJob {
  return {
    canonical_url: r.job.canonical_url,
    company_name: r.job.company_name,
    company_domain: r.job.company_domain,
    title: r.job.title,
    role_family: r.job.role_family,
    sourceIds: r.sourceIds,
    clusterSize: r.clusterSize,
    retained: r.retained,
    constraintFailures: r.constraintFailures,
  }
}

export { bandFor }
