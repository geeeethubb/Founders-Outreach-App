// The diversity regression the founder specified.
//
//   "If the top 50 relevant discovered jobs contain fewer than 20 unique
//    companies when the corpus supports it, discovery fails the diversity test."
//
// Three clauses, and the middle one is the one that keeps this honest: WHEN THE
// CORPUS SUPPORTS IT. A benchmark holding twelve employers cannot be failed for
// producing twelve, so the test first counts how many companies the corpus can
// actually offer under this mission, and only then judges the run against 20.
// A test that fires when the ground truth is thin teaches its operator to
// ignore it.
//
// The number this exists to prevent recurring: 284 postings, 34 companies, GE
// Vernova 107 of them — 38 % — measured live before any of this was built
// (docs/JOB_DISCOVERY_V2_AUDIT.md §0). So the largest single company's share is
// asserted explicitly and printed whether it passes or fails, because "38 %"
// is the fact that started this work and a suite that only prints a checkmark
// would have hidden it.

import { MAX_COMPANY_SHARE } from '@/lib/career/discovery/diversity'
import { ROLE_AREAS, benchmarkKeys, companyKey, titleKey, urlKey, type BenchmarkEntry, type RoleArea } from './corpus'
import type { RankedJob, RecallRunResult } from './run'

/** Companies the top 50 must span, when the corpus can supply them. The founder's number. */
export const MIN_TOP50_COMPANIES = 20

/** Areas the top 50 must touch, of the eight the direction spans. */
export const MIN_TOP50_AREAS = 5

/** Distinct surfaces the top 50 must come from. One surface carrying a run is the audit's finding. */
export const MIN_TOP50_SOURCES = 2

export const TOP_N = 50

/**
 * A role family, as one of the eight areas the direction spans. The mapping is
 * coarse and one-way: it exists so "did the top 50 stay inside one subject?"
 * has an answer for postings the benchmark never labelled, not to classify
 * anything for the product.
 */
const FAMILY_AREA: Record<string, RoleArea> = {
  process_engineering: 'process_chemical',
  chemical_engineering: 'process_chemical',
  manufacturing_operations: 'manufacturing',
  quality: 'manufacturing',
  materials: 'materials',
  research: 'materials',
  energy: 'energy',
  sustainability: 'energy',
  data_ai: 'ai_industry',
  software: 'ai_industry',
  supply_chain: 'industrial_tech',
  mechanical: 'industrial_tech',
  electrical: 'industrial_tech',
  hardware: 'industrial_tech',
  design: 'industrial_tech',
}

const PHARMA_RE = /\b(pharma|biolog|vaccine|cmc|drug|clinical|medical device|biotech|bioprocess)\b/i
const CPG_RE = /\b(consumer|cpg|brand|household|beverage|food|flavou?r|fragrance|ingredient)\b/i

export function areaOfJob(job: { title: string; role_family?: string | null; company_name?: string }): RoleArea | null {
  const hay = `${job.title} ${job.company_name ?? ''}`
  if (PHARMA_RE.test(hay)) return 'pharma'
  if (CPG_RE.test(hay)) return 'cpg'
  return FAMILY_AREA[(job.role_family ?? '').trim()] ?? null
}

export interface DiversityAssertion {
  name: string
  pass: boolean
  observed: string
  expected: string
  detail: string
}

export interface DiversityRegressionReport {
  /** Companies with at least one non-'off' posting anywhere in the accepted inventory. */
  corpusCompanies: number
  corpusSupportsTarget: boolean
  top50: number
  uniqueCompanies: number
  largestCompany: { name: string; count: number; share: number } | null
  areas: RoleArea[]
  missingAreas: RoleArea[]
  sources: string[]
  /** Benchmark entries that reached the top 50, by area. */
  benchmarkInTop50: { id: string; company: string; title: string; role_area: string; rank: number }[]
  assertions: DiversityAssertion[]
  pass: boolean
}

function shareOf(top: RankedJob[]): { name: string; count: number; share: number } | null {
  const counts = new Map<string, { name: string; count: number }>()
  for (const r of top) {
    const k = companyKey(r.job.company_name) || r.job.company_name.toLowerCase()
    const row = counts.get(k) ?? { name: r.job.company_name, count: 0 }
    row.count += 1
    counts.set(k, row)
  }
  const sorted = [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  if (!sorted.length) return null
  return { ...sorted[0], share: sorted[0].count / top.length }
}

export function runDiversityRegression(result: RecallRunResult, benchmark: BenchmarkEntry[]): DiversityRegressionReport {
  const relevant = result.accepted.filter((r) => r.relevance.band !== 'off')
  const corpusCompanies = new Set(relevant.map((r) => companyKey(r.job.company_name) || r.job.company_name.toLowerCase())).size
  const top = result.top50

  const uniqueCompanies = new Set(top.map((r) => companyKey(r.job.company_name) || r.job.company_name.toLowerCase())).size
  const largest = shareOf(top)

  const areaSet = new Set<RoleArea>()
  const byUrl = new Map<string, BenchmarkEntry>()
  const byFallback = new Map<string, BenchmarkEntry>()
  for (const e of benchmark) {
    const k = benchmarkKeys(e)
    if (k.url) byUrl.set(k.url, e)
    byFallback.set(k.fallback, e)
  }

  const benchmarkInTop50: DiversityRegressionReport['benchmarkInTop50'] = []
  top.forEach((r, i) => {
    const u = urlKey(r.job.canonical_url)
    const fb = `${companyKey(r.job.company_name)}|${titleKey(r.job.title)}`
    const entry = (u ? byUrl.get(u) : undefined) ?? byFallback.get(fb)
    if (entry) {
      areaSet.add(entry.role_area)
      benchmarkInTop50.push({ id: entry.id, company: entry.company, title: entry.title, role_area: entry.role_area, rank: i + 1 })
    } else {
      const a = areaOfJob({ title: r.job.title, role_family: r.job.role_family, company_name: r.job.company_name })
      if (a) areaSet.add(a)
    }
  })

  const sources = [...new Set(top.flatMap((r) => r.sourceIds))].sort()
  const areas = ROLE_AREAS.filter((a) => areaSet.has(a))
  const missingAreas = ROLE_AREAS.filter((a) => !areaSet.has(a))
  const corpusSupportsTarget = corpusCompanies >= MIN_TOP50_COMPANIES

  const assertions: DiversityAssertion[] = [
    {
      name: 'top-50 unique companies',
      pass: !corpusSupportsTarget || uniqueCompanies >= MIN_TOP50_COMPANIES,
      observed: String(uniqueCompanies),
      expected: `>= ${MIN_TOP50_COMPANIES}`,
      detail: corpusSupportsTarget
        ? `the corpus offers ${corpusCompanies} companies with a relevant posting, so the target applies`
        : `SKIPPED — the corpus offers only ${corpusCompanies} companies with a relevant posting, fewer than the target`,
    },
    {
      name: 'largest single company share',
      pass: !largest || largest.share <= MAX_COMPANY_SHARE,
      observed: largest ? `${largest.name} ${largest.count}/${top.length} (${Math.round(largest.share * 100)}%)` : 'n/a',
      expected: `<= ${Math.round(MAX_COMPANY_SHARE * 100)}%`,
      detail: 'the live run before this work was GE Vernova at 38%',
    },
    {
      name: 'areas represented in the top 50',
      pass: areas.length >= MIN_TOP50_AREAS,
      observed: `${areas.length} (${areas.join(', ') || 'none'})`,
      expected: `>= ${MIN_TOP50_AREAS} of ${ROLE_AREAS.length}`,
      detail: missingAreas.length ? `missing: ${missingAreas.join(', ')}` : 'every area represented',
    },
    {
      name: 'surfaces represented in the top 50',
      pass: sources.length >= MIN_TOP50_SOURCES,
      observed: `${sources.length} (${sources.join(', ') || 'none'})`,
      expected: `>= ${MIN_TOP50_SOURCES}`,
      detail: 'one surface carrying a whole run is what the audit found',
    },
  ]

  return {
    corpusCompanies,
    corpusSupportsTarget,
    top50: top.length,
    uniqueCompanies,
    largestCompany: largest,
    areas: [...areas],
    missingAreas,
    sources,
    benchmarkInTop50,
    assertions,
    pass: assertions.every((a) => a.pass),
  }
}
