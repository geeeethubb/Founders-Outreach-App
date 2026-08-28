// Duplicate clustering — the same job seen on Greenhouse, on the company's
// careers page, and on an aggregator is ONE opportunity with three sources.
//
// Arithmetic, not judgment (docs/CAREER_OS.md §3). Union-find over pairwise
// keys; the canonical record is the most first-party one, and every other
// copy's sources are merged onto it so provenance is never lost.

import type { JobSourceType } from '../types'
import type { RawJobPosting } from '../sources/types'
import type { NormalizedJob } from './normalize'

const SOURCE_RANK: Record<JobSourceType, number> = {
  greenhouse: 0, lever: 0, ashby: 0, smartrecruiters: 0, workable: 0,
  careers_page: 1, manual: 2, web_search: 3, aggregator: 4,
}

export const SHINGLE_JACCARD_THRESHOLD = 0.6

function shingles(text: string | null | undefined, k = 5, chars = 3000): Set<string> {
  const words = (text ?? '').slice(0, chars).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
  const out = new Set<string>()
  for (let i = 0; i + k <= words.length; i++) out.add(words.slice(i, i + k).join(' '))
  return out
}

export function shingleJaccard(a: string | null | undefined, b: string | null | undefined): number {
  const sa = shingles(a)
  const sb = shingles(b)
  if (!sa.size || !sb.size) return 0
  let inter = 0
  for (const s of sa) if (sb.has(s)) inter++
  return inter / (sa.size + sb.size - inter)
}

function locationsOverlap(a: NormalizedJob, b: NormalizedJob): boolean {
  const ra = (a.location_raw ?? '').toLowerCase()
  const rb = (b.location_raw ?? '').toLowerCase()
  if (a.location_city && b.location_city) {
    if (a.location_city.toLowerCase() === b.location_city.toLowerCase()) return true
  }
  const multi = (j: NormalizedJob) => /multiple|various/.test((j.location_raw ?? '').toLowerCase()) || (j.location_raw ?? '').includes(';')
  if (multi(a) || multi(b)) return true
  if (a.work_mode === 'remote' && b.work_mode === 'remote') return true
  if (!a.location_raw || !b.location_raw) return true
  if (ra === rb) return true
  if (a.location_city && rb.includes(a.location_city.toLowerCase())) return true
  if (b.location_city && ra.includes(b.location_city.toLowerCase())) return true
  return false
}

const TITLE_SEASON = /\b(spring|summer|fall|autumn|winter)\b/i

/** The season a title states, when it states one. normalizeTitle strips it, so it is read from the raw title. */
function seasonInTitle(title: string): string | null {
  const m = TITLE_SEASON.exec(title)
  if (!m) return null
  const s = m[1].toLowerCase()
  return s === 'autumn' ? 'fall' : s
}

function titleTokens(t: string): Set<string> {
  return new Set(t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2))
}

/** Token Jaccard of two normalized titles, or 1 when one's tokens are a subset of the other's ("process engineer intern" ⊂ "process engineer intern pilot line"). Tokens are not stemmed — "engineer" and "engineering" differ — so a reworded cross-source duplicate relies on the URL/ATS-id rules instead. */
export function titleSimilarity(a: string, b: string): number {
  const ta = titleTokens(a)
  const tb = titleTokens(b)
  if (!ta.size || !tb.size) return 0
  let inter = 0
  for (const w of ta) if (tb.has(w)) inter++
  if (inter === Math.min(ta.size, tb.size)) return 1
  return inter / (ta.size + tb.size - inter)
}

export const TITLE_SIMILARITY_THRESHOLD = 0.5

function sameJob(a: NormalizedJob, b: NormalizedJob): boolean {
  if (a.ats_type && a.ats_job_id && a.ats_type === b.ats_type && a.ats_job_id === b.ats_job_id) return true
  if (a.canonical_url && b.canonical_url && stripUrl(a.canonical_url) === stripUrl(b.canonical_url)) return true
  if (a.company_key !== b.company_key) return false
  // Two ids on the same board are two postings, whatever their bodies say.
  // The discovery eval found Palantir's one SWE-internship body listed under
  // four cities, Zipline's under Spring and Summer, and Verkada's Backend and
  // Security intern roles sharing every word below the title: identical
  // templates, distinct openings. Merging them silently dropped the one the
  // user might have wanted (a Materials intern collapsed into a Mechanical one).
  if (a.ats_type && b.ats_type && a.ats_type === b.ats_type && a.ats_job_id && b.ats_job_id && a.ats_job_id !== b.ats_job_id) return false
  if (a.requisition_id && b.requisition_id && a.requisition_id.toLowerCase() === b.requisition_id.toLowerCase()) return true
  // A title that names a season names a different posting when the other names another.
  const sa = seasonInTitle(a.title)
  const sb = seasonInTitle(b.title)
  if (sa && sb && sa !== sb) return false
  if (a.normalized_title === b.normalized_title && locationsOverlap(a, b)) return true
  // Near-identical bodies confirm a match only between titles that already
  // look alike and locations that agree — a shared job-description template
  // is not a shared job.
  return (
    titleSimilarity(a.normalized_title, b.normalized_title) >= TITLE_SIMILARITY_THRESHOLD &&
    locationsOverlap(a, b) &&
    shingleJaccard(a.description_text, b.description_text) >= SHINGLE_JACCARD_THRESHOLD
  )
}

function stripUrl(u: string): string {
  return u.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[?#].*$/, '').replace(/\/+$/, '')
}

function completeness(j: NormalizedJob): number {
  let n = 0
  if (j.description_text) n += Math.min(3, j.description_text.length / 1000)
  if (j.location_raw) n += 1
  if (j.posted_at) n += 1
  if (j.apply_url) n += 1
  if (j.ats_job_id) n += 1
  if (j.min_qualifications.length) n += 1
  return n
}

function bestSourceRank(j: NormalizedJob): number {
  return Math.min(...j.sources.map((s) => SOURCE_RANK[s.source_type] ?? 5), 5)
}

/** ATS adapters > careers page > manual > web search > aggregator; ties → most complete record. */
export function canonicalOf(cluster: NormalizedJob[]): NormalizedJob {
  return [...cluster].sort((a, b) => bestSourceRank(a) - bestSourceRank(b) || completeness(b) - completeness(a))[0]
}

export interface ClusterResult {
  clusters: NormalizedJob[][]
  canonicalOf: (cluster: NormalizedJob[]) => NormalizedJob
  /** Canonical records with every duplicate's sources merged onto them. */
  merged: NormalizedJob[]
}

export function clusterJobs(jobs: NormalizedJob[]): ClusterResult {
  const parent = jobs.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b)
  }

  // Cheap exact keys first so the O(n²) pass only compares within a company.
  const byCompany = new Map<string, number[]>()
  jobs.forEach((j, i) => {
    const list = byCompany.get(j.company_key) ?? []
    list.push(i)
    byCompany.set(j.company_key, list)
  })
  const byAts = new Map<string, number>()
  const byUrl = new Map<string, number>()
  jobs.forEach((j, i) => {
    if (j.ats_type && j.ats_job_id) {
      const k = `${j.ats_type}:${j.ats_job_id}`
      const prev = byAts.get(k)
      if (prev !== undefined) union(i, prev)
      else byAts.set(k, i)
    }
    if (j.canonical_url) {
      const k = stripUrl(j.canonical_url)
      const prev = byUrl.get(k)
      if (prev !== undefined) union(i, prev)
      else byUrl.set(k, i)
    }
  })
  for (const idxs of byCompany.values()) {
    for (let x = 0; x < idxs.length; x++) {
      for (let y = x + 1; y < idxs.length; y++) {
        const a = idxs[x]
        const b = idxs[y]
        if (find(a) === find(b)) continue
        if (sameJob(jobs[a], jobs[b])) union(a, b)
      }
    }
  }

  const groups = new Map<number, NormalizedJob[]>()
  jobs.forEach((j, i) => {
    const root = find(i)
    const g = groups.get(root) ?? []
    g.push(j)
    groups.set(root, g)
  })
  const clusters = [...groups.values()]
  const merged = clusters.map((cluster) => {
    const canonical = canonicalOf(cluster)
    const seen = new Set<string>()
    const sources: RawJobPosting[] = []
    for (const j of cluster) {
      for (const s of j.sources) {
        const k = `${s.source_type}|${s.source_url}`
        if (seen.has(k)) continue
        seen.add(k)
        sources.push(s)
      }
    }
    return { ...canonical, sources, is_canonical: true }
  })
  return { clusters, canonicalOf, merged }
}

/** Fraction of input records that were duplicates of another — the eval's headline number. */
export function duplicateRate(clusters: NormalizedJob[][]): number {
  const total = clusters.reduce((n, c) => n + c.length, 0)
  if (!total) return 0
  return (total - clusters.length) / total
}
