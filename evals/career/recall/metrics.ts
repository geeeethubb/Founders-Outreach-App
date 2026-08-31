// The recall metrics. Pure functions over a discovery result — no I/O, no
// clock, no model, so the arithmetic is inspectable and the same numbers mean
// the same thing in the table, in results.json and in the regression test.
//
// RECALL IS THE HEADLINE, and it is reported twice on purpose:
//
//   recall              over every active benchmark entry
//   reachableRecall     over only the entries a CONFIGURED source could see
//
// The second is the one with a target on it, and the qualifier travels with the
// number everywhere it is printed. Claiming 100 % coverage of a corpus that
// contains two Merck co-ops only visible through a Phenom endpoint nobody has
// written an adapter for would be a lie told with a true number.
//
// A benchmark entry counts as FOUND when discovery returned it, not when
// discovery kept it. `retained` is measured separately: a posting dropped by
// the mission's own country or season constraint was still discovered, and
// folding that into recall would make a correct filter look like a broken
// crawler.

import { companyKey, titleKey, urlKey, type BenchmarkEntry, type PrecisionLabel } from './corpus'

/** The minimum a metric needs to know about one discovered posting. */
export interface MeasuredJob {
  canonical_url: string | null
  company_name: string
  company_domain?: string | null
  title: string
  role_family?: string | null
  /** Source ids that produced this job — more than one when sources overlapped. */
  sourceIds: string[]
  /** Postings that merged into this one, including itself. */
  clusterSize: number
  /** Survived normalization and the mission's hard constraints. */
  retained: boolean
  /** Labels of the hard constraints that rejected it. Empty when it was retained. */
  constraintFailures?: string[]
}

// ─── Recall ──────────────────────────────────────────────────────────────────

export interface RecallMatch {
  entry: BenchmarkEntry
  found: boolean
  retained: boolean
  matchedBy: 'canonical_url' | 'company_title' | null
  reachable: boolean
  /** Why an entry is out of the reachable denominator. */
  unreachableReason: string | null
  /**
   * Hard-constraint labels that dropped this entry AFTER discovery found it.
   * Empty unless `found && !retained`. Carried on the match rather than left as
   * an aggregate count because a filter regression looks exactly like a correct
   * filter until you can read the names it removed.
   */
  droppedBy: string[]
}

export interface RecallReport {
  /** Active benchmark entries considered. */
  total: number
  found: number
  recall: number
  /** Entries at least one configured source could see. */
  reachable: number
  reachableFound: number
  reachableRecall: number
  /** Of the found entries, how many survived the mission's own filters. */
  retained: number
  /** Found, then dropped by a hard constraint. Named, never left as a count. */
  dropped: RecallMatch[]
  matchedByUrl: number
  matchedByCompanyTitle: number
  misses: RecallMatch[]
  unreachable: RecallMatch[]
  byArea: Record<string, { total: number; found: number; reachable: number; reachableFound: number }>
  byPlatform: Record<string, { total: number; found: number; reachable: number; reachableFound: number }>
}

export interface ReachabilityInput {
  /** Surface families a configured source covers, e.g. 'workday', 'greenhouse', 'simplify'. */
  configuredFamilies: Set<string>
  /** Per-family explanation for the ones that are missing. */
  reasons?: Record<string, string>
}

function jobKeys(job: MeasuredJob): { url: string | null; fallback: string } {
  return {
    url: urlKey(job.canonical_url),
    fallback: `${companyKey(job.company_name)}|${titleKey(job.title)}`,
  }
}

export function measureRecall(entries: BenchmarkEntry[], jobs: MeasuredJob[], reach: ReachabilityInput): RecallReport {
  const byUrl = new Map<string, MeasuredJob>()
  const byFallback = new Map<string, MeasuredJob>()
  for (const job of jobs) {
    const k = jobKeys(job)
    if (k.url && !byUrl.has(k.url)) byUrl.set(k.url, job)
    if (!byFallback.has(k.fallback)) byFallback.set(k.fallback, job)
  }

  const active = entries.filter((e) => e.active)
  const matches: RecallMatch[] = active.map((entry) => {
    const url = urlKey(entry.canonical_url) ?? urlKey(entry.url)
    const fallback = `${companyKey(entry.company)}|${titleKey(entry.title)}`
    const hit = (url ? byUrl.get(url) : undefined) ?? byFallback.get(fallback)
    const matchedBy: RecallMatch['matchedBy'] = !hit ? null : url && byUrl.has(url) ? 'canonical_url' : 'company_title'
    const reachable = entry.reachable_by.some((f) => reach.configuredFamilies.has(f))
    const missingFamilies = entry.reachable_by.filter((f) => !reach.configuredFamilies.has(f))
    return {
      entry,
      found: !!hit,
      retained: !!hit && hit.retained,
      matchedBy,
      reachable,
      unreachableReason: reachable
        ? null
        : missingFamilies.map((f) => reach.reasons?.[f] ?? `no configured source covers ${f}`).join('; '),
      droppedBy: hit && !hit.retained ? hit.constraintFailures ?? ['(no label recorded)'] : [],
    }
  })

  const bucket = () => ({ total: 0, found: 0, reachable: 0, reachableFound: 0 })
  const byArea: RecallReport['byArea'] = {}
  const byPlatform: RecallReport['byPlatform'] = {}
  for (const m of matches) {
    for (const [map, key] of [
      [byArea, m.entry.role_area as string],
      [byPlatform, m.entry.platform],
    ] as const) {
      const row = (map[key] ??= bucket())
      row.total += 1
      if (m.found) row.found += 1
      if (m.reachable) {
        row.reachable += 1
        if (m.found) row.reachableFound += 1
      }
    }
  }

  const reachableMatches = matches.filter((m) => m.reachable)
  const found = matches.filter((m) => m.found)
  const reachableFound = reachableMatches.filter((m) => m.found)
  return {
    total: matches.length,
    found: found.length,
    recall: matches.length ? found.length / matches.length : 0,
    reachable: reachableMatches.length,
    reachableFound: reachableFound.length,
    reachableRecall: reachableMatches.length ? reachableFound.length / reachableMatches.length : 0,
    retained: matches.filter((m) => m.retained).length,
    dropped: matches.filter((m) => m.found && !m.retained),
    matchedByUrl: matches.filter((m) => m.matchedBy === 'canonical_url').length,
    matchedByCompanyTitle: matches.filter((m) => m.matchedBy === 'company_title').length,
    misses: reachableMatches.filter((m) => !m.found),
    unreachable: matches.filter((m) => !m.reachable),
    byArea,
    byPlatform,
  }
}

// ─── Precision ───────────────────────────────────────────────────────────────

export interface PrecisionReport {
  /** Accepted candidates that carry a hand label. Precision is computed over these only. */
  labelled: number
  /** Accepted candidates with no label — reported, never assumed correct. */
  unlabelled: number
  accepted: number
  legitimate: number
  precision: number
  /** Every accepted candidate a person labelled "not an internship". */
  falsePositives: { company: string; title: string; url: string; note?: string }[]
  /** Hand-labelled negatives in the corpus, in total. */
  labelledNegatives: number
  /** Of those, how many actually reached normalization and the hard constraints. */
  negativesReached: number
  /**
   * Negatives a source removed BEFORE the pipeline saw them — the shipped
   * `internshipsOnly` pre-filter (lib/career/sources/fetch.ts `internshipLike`).
   * This is the ceiling on how wrong precision could possibly have been, and it
   * travels with the ratio everywhere the ratio is printed. A precision of
   * 99 % over a pool something else already cleaned is not a measurement of
   * this pipeline.
   */
  negativesFilteredBeforeScoring: number
}

/**
 * Of what discovery ACCEPTED, how much is a real internship.
 *
 * Scored only over postings a person labelled, and the unlabelled count is
 * printed beside the ratio. Filling the gap with the product's own classifier
 * would make precision a measurement of the classifier against itself.
 *
 * `reached` is every posting that survived to normalization, accepted or not.
 * It exists so the report can say how much of the labelled negative set the
 * pipeline was actually asked to judge.
 */
export function measurePrecision(accepted: MeasuredJob[], labels: PrecisionLabel[], reached: MeasuredJob[] = accepted): PrecisionReport {
  const byUrl = new Map<string, PrecisionLabel>()
  for (const l of labels) {
    const k = urlKey(l.url)
    if (k) byUrl.set(k, l)
  }
  let legitimate = 0
  let labelled = 0
  const falsePositives: PrecisionReport['falsePositives'] = []
  for (const job of accepted) {
    const k = urlKey(job.canonical_url)
    const label = k ? byUrl.get(k) : undefined
    if (!label) continue
    labelled += 1
    if (label.label === 'internship') legitimate += 1
    else falsePositives.push({ company: job.company_name, title: job.title, url: job.canonical_url ?? '', note: label.note })
  }
  const reachedUrls = new Set<string>()
  for (const job of reached) {
    const k = urlKey(job.canonical_url)
    if (k) reachedUrls.add(k)
  }
  const negatives = labels.filter((l) => l.label !== 'internship')
  const negativesReached = negatives.filter((l) => {
    const k = urlKey(l.url)
    return !!k && reachedUrls.has(k)
  }).length

  return {
    labelled,
    unlabelled: accepted.length - labelled,
    accepted: accepted.length,
    legitimate,
    precision: labelled ? legitimate / labelled : 0,
    falsePositives,
    labelledNegatives: negatives.length,
    negativesReached,
    negativesFilteredBeforeScoring: negatives.length - negativesReached,
  }
}

// ─── Duplicates, staleness, hygiene ──────────────────────────────────────────

/** A cluster of n contributes n−1 duplicates. Singletons contribute nothing. */
export function duplicateRate(jobs: MeasuredJob[]): number {
  const total = jobs.reduce((n, j) => n + Math.max(1, j.clusterSize), 0)
  if (!total) return 0
  return (total - jobs.length) / total
}

/**
 * Of the postings the run presented as open, how many the corpus says are
 * closed. Ground truth is the fixture's own `active` flag, keyed by URL — the
 * Simplify sample deliberately carries 40 closed Summer 2027 rows so that a
 * regression in `isOpen()` shows up here as a number rather than as silence.
 */
export function staleRate(jobs: MeasuredJob[], closedUrls: Set<string>): { shown: number; stale: number; rate: number; examples: string[] } {
  let stale = 0
  const examples: string[] = []
  for (const job of jobs) {
    const k = urlKey(job.canonical_url)
    if (k && closedUrls.has(k)) {
      stale += 1
      if (examples.length < 5) examples.push(`${job.company_name} — ${job.title}`)
    }
  }
  return { shown: jobs.length, stale, rate: jobs.length ? stale / jobs.length : 0, examples }
}

export function uniqueCompanies(jobs: MeasuredJob[]): number {
  return new Set(jobs.map((j) => companyKey(j.company_name) || j.company_name.toLowerCase())).size
}

/** Distinct sources that produced at least one posting. Overlap counts for both. */
export function sourceDiversity(jobs: MeasuredJob[]): { sources: number; perSource: Record<string, number> } {
  const perSource: Record<string, number> = {}
  for (const job of jobs) for (const id of new Set(job.sourceIds)) perSource[id] = (perSource[id] ?? 0) + 1
  return { sources: Object.keys(perSource).length, perSource }
}

export function roleFamilyDiversity(jobs: MeasuredJob[]): { families: number; perFamily: Record<string, number> } {
  const perFamily: Record<string, number> = {}
  for (const job of jobs) {
    const f = (job.role_family ?? '').trim() || 'unknown'
    perFamily[f] = (perFamily[f] ?? 0) + 1
  }
  return { families: Object.keys(perFamily).length, perFamily }
}

/** Hosts that belong to the employer or its ATS. Anything else stored as canonical is a redirect wearing a first-party label. */
const ATS_HOSTS = [
  'greenhouse.io', 'job-boards.greenhouse.io', 'boards.greenhouse.io', 'lever.co', 'ashbyhq.com',
  'smartrecruiters.com', 'workable.com', 'myworkdayjobs.com', 'myworkdaysite.com', 'oraclecloud.com',
  'icims.com', 'taleo.net', 'successfactors.com', 'recruitee.com', 'gem.com', 'teamtailor.com',
  'personio.de', 'eightfold.ai', 'bamboohr.com', 'rippling.com', 'breezy.hr', 'jobvite.com',
]

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

/**
 * Share of postings whose `canonical_url` is first-party: the employer's own
 * domain, or an ATS the employer runs. An aggregator URL parked in
 * `canonical_url` is the failure this catches, and it is kept apart from recall
 * so that neither can flatter the other.
 */
export function canonicalUrlRate(jobs: MeasuredJob[]): { rate: number; firstParty: number; total: number; offenders: string[] } {
  let firstParty = 0
  const offenders: string[] = []
  for (const job of jobs) {
    const host = hostOf(job.canonical_url)
    const domain = (job.company_domain ?? '').toLowerCase().replace(/^www\./, '')
    const ok =
      !!host &&
      (ATS_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) || (!!domain && (host === domain || host.endsWith(`.${domain}`))))
    if (ok) firstParty += 1
    else if (offenders.length < 10) offenders.push(`${job.company_name}: ${job.canonical_url ?? 'null'}`)
  }
  return { rate: jobs.length ? firstParty / jobs.length : 0, firstParty, total: jobs.length, offenders }
}

export function pct(n: number, digits = 1): string {
  return `${(n * 100).toFixed(digits)}%`
}
