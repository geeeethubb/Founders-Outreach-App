// Diversity: is this inventory actually a market, or one company's careers page?
//
// The measurement that produced this file: 284 postings, 34 companies, and GE
// Vernova alone contributing 107 of them — 38 %. Nothing in the pipeline
// noticed, because nothing measured it. A sweep lists a whole board and stores
// everything on it, so ONE employer with a large board outweighs thirty
// employers with two openings each, and the founder's inbox looks full while
// the search was narrow.
//
// So: measure concentration, name the company responsible, and hand the
// orchestrator a directive it can act on.
//
// What this file must never become is a reranker. It does not reorder,
// down-weight or hide anything — hiding GE Vernova's postings would make the
// number look better while the search stayed exactly as narrow. `shouldDiversify`
// says WHERE TO SEARCH MORE: which surfaces were under-used, which role
// families and industries are missing, which regions are unrepresented, and
// which companies are already saturated and need no further pulling. Recall is
// raised by searching more, never by discarding.
//
// Pure: no I/O, no clock. Every threshold is an exported constant so the
// orchestrator, the report and the tests cannot disagree about what "low" means.

import { parseLocation } from '../jobs/location'
import { companyKeyFor, roleFamilyFromTitle } from '../jobs/normalize'

// ─── Thresholds ──────────────────────────────────────────────────────────────

/** Below this many postings, concentration is noise: a 3-job run is not "low diversity". */
export const MIN_DIVERSITY_SAMPLE = 10
/** One company may hold at most this share of the inventory. GE Vernova held 0.38. */
export const MAX_COMPANY_SHARE = 0.25
/** The five largest companies may hold at most this share between them. */
export const MAX_TOP5_SHARE = 0.6
/** Average postings per company. 284/34 = 8.4; 30 jobs from 5 companies = 6.0. */
export const MAX_JOBS_PER_COMPANY = 4
/** At a full-sized run, fewer distinct role families than this is a narrow search. */
export const MIN_ROLE_FAMILIES = 3
/** At a full-sized run, fewer surfaces than this means one surface carried it. */
export const MIN_SOURCES = 2
/** At a full-sized run, fewer regions than this means the geography was hard-coded. */
export const MIN_GEO_SPREAD = 4
/** A run of at least this size is judged against the "full-sized run" thresholds above. */
export const FULL_RUN_SAMPLE = 20

// ─── Input ───────────────────────────────────────────────────────────────────

/**
 * One posting, as much as the caller happens to know. Everything except the
 * company name is optional: diversity is measured on partial inventories all
 * through a run, and a missing field must degrade the measurement rather than
 * fail it.
 */
export interface DiversityItem {
  /**
   * Stable posting identity. Absent, it falls back to company + normalized
   * title — coarse on purpose: an inventory handed over WITHOUT keys is exactly
   * the case where thirty copies of one board's posting must not read as thirty
   * jobs, and over-merging two same-titled roles at one employer costs the
   * measurement nothing it is trying to say.
   */
  key?: string | null
  companyName: string
  companyKey?: string | null
  companyDomain?: string | null
  title?: string | null
  /** Given, or derived from the title. */
  roleFamily?: string | null
  industry?: string | null
  sourceId?: string | null
  locationRaw?: string | null
  state?: string | null
  country?: string | null
  remote?: boolean | null
}

export interface CountedName {
  name: string
  count: number
  share: number
}

/**
 * The COMPLETE tallies, every category, unranked and untruncated. Plain
 * `Record`s so the whole report survives a round trip through `stats` JSON.
 *
 * This exists because the ranked lists below are a DISPLAY, capped at ten. A
 * run measured live had 46 role families; deciding "which families have no
 * postings?" from a top-10 list reports the 11th-largest family as missing and
 * sends the orchestrator to buy searches for coverage it already has. Display
 * reads `roleFamilies`; decisions read `counts`.
 */
export interface DiversityCounts {
  companies: Record<string, number>
  roleFamilies: Record<string, number>
  industries: Record<string, number>
  regions: Record<string, number>
  sources: Record<string, number>
}

export interface DiversityReport {
  uniqueJobs: number
  uniqueCompanies: number
  uniqueRoleFamilies: number
  uniqueIndustries: number
  uniqueSources: number
  /** Distinct US states, plus one bucket for remote. Unknown locations are not a region. */
  geographicSpread: number
  /** 0–1. The largest single employer's share of the inventory. */
  largestCompanyShare: number
  largestCompany: CountedName | null
  /** One sentence naming the problem, or null. This is what the run report prints. */
  concentrationWarning: string | null
  /** 'low' is the LOW DIVERSITY flag. 'unknown' means too few postings to judge. */
  level: 'ok' | 'low' | 'unknown'
  /** Every reason the run was flagged, each naming the thing responsible. */
  reasons: string[]
  /** Top ten, for printing. Never read these to decide what is missing — see `counts`. */
  topCompanies: CountedName[]
  roleFamilies: CountedName[]
  industries: CountedName[]
  regions: CountedName[]
  sources: CountedName[]
  /** Every category, untruncated. This is what `shouldDiversify` reads. */
  counts: DiversityCounts
}

// ─── Measurement ─────────────────────────────────────────────────────────────

function tally(pairs: (string | null)[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const p of pairs) {
    if (!p) continue
    m.set(p, (m.get(p) ?? 0) + 1)
  }
  return m
}

function asRecord(m: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of m) out[k] = v
  return out
}

function ranked(m: Map<string, number>, total: number, limit = 10): CountedName[] {
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count, share: total > 0 ? count / total : 0 }))
}

/** The region a posting belongs to: its US state, else REMOTE, else nothing. */
export function regionOf(item: DiversityItem): string | null {
  const state = (item.state ?? '').trim().toUpperCase()
  if (state) return state
  const parsed = item.locationRaw ? parseLocation(item.locationRaw) : null
  if (parsed?.state) return parsed.state.toUpperCase()
  if (item.remote || parsed?.remote) return 'REMOTE'
  return null
}

function itemKey(item: DiversityItem): string {
  if (item.key && item.key.trim()) return item.key.trim()
  // No index here. An index would make every fallback key unique, so key-less
  // duplicates could never collide and the dedupe this function exists for
  // would be a no-op — the exact failure the file is meant to catch.
  return `${companyOf(item)}|${(item.title ?? '').trim().toLowerCase()}`
}

function companyOf(item: DiversityItem): string {
  if (item.companyKey && item.companyKey.trim()) return item.companyKey.trim()
  return companyKeyFor(item.companyName ?? '', item.companyDomain ?? null)
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`
}

/**
 * Measure an inventory. Postings sharing a `key` are counted once — the same
 * job found by three sources is one job, and must not make the run look more
 * diverse than it is.
 */
export function measureDiversity(items: DiversityItem[]): DiversityReport {
  const seen = new Set<string>()
  const unique: DiversityItem[] = []
  const sourceIds: (string | null)[] = []
  items.forEach((item) => {
    // Sources are counted over every sighting: two sources finding the same
    // job is two sources' worth of coverage, even though it is one job.
    sourceIds.push(item.sourceId ?? null)
    const k = itemKey(item)
    if (seen.has(k)) return
    seen.add(k)
    unique.push(item)
  })

  const total = unique.length
  const companyNames = new Map<string, string>()
  for (const item of unique) {
    const key = companyOf(item)
    if (!companyNames.has(key)) companyNames.set(key, (item.companyName ?? '').trim() || key)
  }

  const companies = tally(unique.map(companyOf))
  const displayCompanies = new Map<string, number>()
  for (const [key, n] of companies) displayCompanies.set(companyNames.get(key) ?? key, n)

  const families = tally(unique.map((i) => (i.roleFamily ?? '').trim() || (i.title ? roleFamilyFromTitle(i.title) : null)))
  const industries = tally(unique.map((i) => ((i.industry ?? '').trim() || null)))
  const regions = tally(unique.map(regionOf))
  const sources = tally(sourceIds.map((s) => (s ?? '').trim() || null))

  const topCompanies = ranked(displayCompanies, total)
  const largestCompany = topCompanies[0] ?? null
  const largestCompanyShare = largestCompany ? largestCompany.share : 0
  const top5 = topCompanies.slice(0, 5)
  const top5Count = top5.reduce((a, c) => a + c.count, 0)
  const top5Share = total > 0 ? top5Count / total : 0
  const jobsPerCompany = companies.size > 0 ? total / companies.size : 0

  const reasons: string[] = []
  if (total >= MIN_DIVERSITY_SAMPLE) {
    if (largestCompany && largestCompanyShare > MAX_COMPANY_SHARE) {
      reasons.push(
        `${largestCompany.name} is ${pct(largestCompanyShare)} of the inventory (${largestCompany.count} of ${total}) — one employer's board is carrying the run`
      )
    }
    if (top5.length >= 2 && top5Share > MAX_TOP5_SHARE && companies.size > 1) {
      reasons.push(
        `the ${top5.length} largest employers hold ${top5Count} of ${total} postings (${pct(top5Share)}): ${top5.map((c) => `${c.name} ${c.count}`).join(', ')}`
      )
    }
    if (jobsPerCompany > MAX_JOBS_PER_COMPANY) {
      reasons.push(
        `${total} postings from only ${companies.size} companies (${jobsPerCompany.toFixed(1)} each) — discovery went deep on few employers instead of wide`
      )
    }
  }
  if (total >= FULL_RUN_SAMPLE) {
    if (families.size < MIN_ROLE_FAMILIES) {
      reasons.push(`only ${families.size} role famil${families.size === 1 ? 'y' : 'ies'} across ${total} postings — the query set is too narrow`)
    }
    if (sources.size < MIN_SOURCES) {
      reasons.push(`${sources.size === 0 ? 'no source was recorded' : `every posting came from ${[...sources.keys()][0]}`} — a single surface carried the run`)
    }
    if (regions.size < MIN_GEO_SPREAD) {
      reasons.push(
        `only ${regions.size} region${regions.size === 1 ? '' : 's'} represented (${[...regions.keys()].join(', ') || 'none'}) — geography is narrowing discovery`
      )
    }
  }

  const level: DiversityReport['level'] = total < MIN_DIVERSITY_SAMPLE ? 'unknown' : reasons.length ? 'low' : 'ok'

  return {
    uniqueJobs: total,
    uniqueCompanies: companies.size,
    uniqueRoleFamilies: families.size,
    uniqueIndustries: industries.size,
    uniqueSources: sources.size,
    geographicSpread: regions.size,
    largestCompanyShare,
    largestCompany,
    concentrationWarning: reasons.length ? `LOW DIVERSITY — ${reasons[0]}` : null,
    level,
    reasons,
    topCompanies,
    roleFamilies: ranked(families, total),
    industries: ranked(industries, total),
    regions: ranked(regions, total),
    sources: ranked(sources, sourceIds.filter(Boolean).length || total),
    counts: {
      companies: asRecord(displayCompanies),
      roleFamilies: asRecord(families),
      industries: asRecord(industries),
      regions: asRecord(regions),
      sources: asRecord(sources),
    },
  }
}

// ─── Driving behaviour ───────────────────────────────────────────────────────

export interface DiversifyOptions {
  /** Surfaces available to the run, whether or not they were used. */
  availableSources?: string[]
  /** Role families the plan set out to cover. */
  expectedRoleFamilies?: string[]
  /** Industries the plan set out to cover. */
  expectedIndustries?: string[]
  /** Regions the run intends to cover. Empty means "anywhere", and geography is not judged. */
  expectedRegions?: string[]
  /** A source that produced fewer than this many unique postings was barely used. Default 3. */
  minUniquePerSource?: number
  /** Override the concentration ceiling for this run. */
  maxCompanyShare?: number
}

/**
 * What to do about it. Every field names something to SEARCH MORE OF, except
 * `saturatedCompanies`, which names employers already over-represented so the
 * orchestrator spends its next calls elsewhere — not so it deletes their jobs.
 */
export interface DiversifyDirective {
  needed: boolean
  reasons: string[]
  /** Surfaces that were available and unused, or used and barely read. */
  underCoveredSources: string[]
  underCoveredRoleFamilies: string[]
  underCoveredIndustries: string[]
  underCoveredRegions: string[]
  /** Over MAX_COMPANY_SHARE. Stop pulling more of their board this run. */
  saturatedCompanies: string[]
  /** One line for a progress event or a log. */
  suggestion: string
}

/**
 * The complete tally for one dimension. A report persisted before `counts`
 * existed has only the top-10 display list, and reading that as a complete
 * tally is precisely the bug this guards: it is used as a LAST resort, and the
 * caller is warned in `reasons` when it happens, because the answer may then
 * name categories that are in fact covered.
 */
function tallyOf(d: DiversityReport, dim: keyof DiversityCounts, fallback: CountedName[]): { counts: Record<string, number>; complete: boolean } {
  const c = d.counts?.[dim]
  if (c && typeof c === 'object') return { counts: c, complete: true }
  const out: Record<string, number> = {}
  for (const r of fallback) out[r.name] = r.count
  return { counts: out, complete: false }
}

export function shouldDiversify(diversity: DiversityReport, opts: DiversifyOptions = {}): DiversifyDirective {
  const minPerSource = opts.minUniquePerSource ?? 3
  const maxShare = opts.maxCompanyShare ?? MAX_COMPANY_SHARE

  const sourceTally = tallyOf(diversity, 'sources', diversity.sources)
  const familyTally = tallyOf(diversity, 'roleFamilies', diversity.roleFamilies)
  const industryTally = tallyOf(diversity, 'industries', diversity.industries)
  const regionTally = tallyOf(diversity, 'regions', diversity.regions)
  const companyTally = tallyOf(diversity, 'companies', diversity.topCompanies)
  const partial = !sourceTally.complete

  const usedWell = new Set(
    Object.entries(sourceTally.counts)
      .filter(([, n]) => n >= minPerSource)
      .map(([name]) => name)
  )
  const available = opts.availableSources ?? []
  const underCoveredSources = available.filter((id) => !usedWell.has(id))

  const lower = (r: Record<string, number>) => new Set(Object.keys(r).map((k) => k.toLowerCase()))
  const upper = (r: Record<string, number>) => new Set(Object.keys(r).map((k) => k.toUpperCase()))

  const haveFamilies = lower(familyTally.counts)
  const underCoveredRoleFamilies = (opts.expectedRoleFamilies ?? []).filter((f) => !haveFamilies.has(f.trim().toLowerCase()))

  const haveIndustries = lower(industryTally.counts)
  const underCoveredIndustries = (opts.expectedIndustries ?? []).filter((f) => !haveIndustries.has(f.trim().toLowerCase()))

  const haveRegions = upper(regionTally.counts)
  const underCoveredRegions = (opts.expectedRegions ?? []).filter((r) => !haveRegions.has(r.trim().toUpperCase()))

  const totalJobs = diversity.uniqueJobs || 0
  const saturatedCompanies = Object.entries(companyTally.counts)
    .filter(([, n]) => totalJobs > 0 && n / totalJobs > maxShare)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name)

  const reasons = [...diversity.reasons]
  if (partial) {
    reasons.push(
      'this measurement predates full category tallies — coverage was judged from the top-10 display lists, so a category ranked 11th or lower may be named as missing when it is not'
    )
  }
  if (underCoveredSources.length) reasons.push(`${underCoveredSources.length} surface(s) barely read: ${underCoveredSources.join(', ')}`)
  if (underCoveredRoleFamilies.length) reasons.push(`role families with no postings yet: ${underCoveredRoleFamilies.join(', ')}`)
  if (underCoveredIndustries.length) reasons.push(`industries with no postings yet: ${underCoveredIndustries.join(', ')}`)
  if (underCoveredRegions.length) reasons.push(`regions with no postings yet: ${underCoveredRegions.join(', ')}`)

  const needed =
    diversity.level === 'low' ||
    underCoveredSources.length > 0 ||
    underCoveredRoleFamilies.length > 0 ||
    underCoveredIndustries.length > 0 ||
    underCoveredRegions.length > 0

  const targets: string[] = []
  if (underCoveredSources.length) targets.push(`search ${underCoveredSources.join(', ')}`)
  if (underCoveredRoleFamilies.length) targets.push(`query for ${underCoveredRoleFamilies.join(', ')}`)
  if (underCoveredIndustries.length) targets.push(`query for ${underCoveredIndustries.join(', ')}`)
  if (underCoveredRegions.length) targets.push(`cover ${underCoveredRegions.join(', ')}`)
  if (saturatedCompanies.length) targets.push(`stop pulling ${saturatedCompanies.join(', ')} — already over ${pct(maxShare)} of the run`)

  return {
    needed,
    reasons,
    underCoveredSources,
    underCoveredRoleFamilies,
    underCoveredIndustries,
    underCoveredRegions,
    saturatedCompanies,
    suggestion: needed
      ? targets.length
        ? `Broaden discovery: ${targets.join('; ')}.`
        : 'Broaden discovery: the inventory is concentrated, but no under-covered surface or category was supplied to aim at.'
      : 'Coverage looks balanced; no extra searches needed on diversity grounds.',
  }
}

/** Human lines for the run report and the CLI. */
export function summarizeDiversity(d: DiversityReport): string[] {
  const lines = [
    `unique jobs ${d.uniqueJobs} · companies ${d.uniqueCompanies} · role families ${d.uniqueRoleFamilies} · industries ${d.uniqueIndustries} · sources ${d.uniqueSources} · regions ${d.geographicSpread}`,
  ]
  if (d.largestCompany) {
    lines.push(`largest employer: ${d.largestCompany.name} ${d.largestCompany.count} (${pct(d.largestCompanyShare)})`)
  }
  if (d.level === 'unknown') lines.push(`too few postings to judge diversity (need ${MIN_DIVERSITY_SAMPLE})`)
  for (const r of d.reasons) lines.push(`LOW DIVERSITY — ${r}`)
  return lines
}
