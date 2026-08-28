// Ashby Job Board API — public, keyless.
//
// Verified live (Aug 2026):
//   GET api.ashbyhq.com/posting-api/job-board/{org}?includeCompensation=true
//     → {jobs: [{id, title, department, team, employmentType ('FullTime'|'Intern'|'Contract'|'Temporary'),
//               location, secondaryLocations[], publishedAt, isListed, isRemote, workplaceType,
//               descriptionHtml, descriptionPlain, jobUrl, applyUrl, compensation}], apiVersion}
//     | 404 "Not Found" on an unknown org
// There is no single-posting endpoint: fetchPosting lists and filters. The
// listing is cached per day, so verification of N jobs at one org costs one call.

import type { AtsBoardRef, JobSourceAdapter, ListPostingsResult, PostingFetchResult, RawJobPosting, UrlMatch } from './types'
import { applyListOptions, cachedListing, fetchJson, listCacheBypassFromEnv, slugCandidates } from './fetch'
import { htmlToText } from './html'

const API = 'https://api.ashbyhq.com/posting-api/job-board'

export interface AshbyJob {
  id: string
  title: string
  department?: string
  team?: string
  employmentType?: string
  location?: string
  secondaryLocations?: { location?: string }[]
  publishedAt?: string
  isListed?: boolean
  isRemote?: boolean
  workplaceType?: string
  descriptionHtml?: string
  descriptionPlain?: string
  jobUrl?: string
  applyUrl?: string
  compensation?: { compensationTierSummary?: string | null } | null
  [k: string]: unknown
}

export function normalizeAshbyJob(job: AshbyJob, board: AtsBoardRef, now = new Date().toISOString()): RawJobPosting {
  const canonical = job.jobUrl ?? `https://jobs.ashbyhq.com/${board.identifier}/${job.id}`
  const locs = [job.location, ...(job.secondaryLocations ?? []).map((s) => s.location)].filter((s): s is string => !!s)
  const workplace = job.workplaceType && !/on-?site/i.test(job.workplaceType) ? job.workplaceType : job.isRemote && !locs.some((l) => /remote/i.test(l)) ? 'Remote' : null
  const location = locs.join('; ') || null
  return {
    source_type: 'ashby',
    source_url: canonical,
    external_id: job.id,
    company_name: board.company_name ?? board.identifier,
    company_domain: null,
    title: (job.title ?? '').trim(),
    location_raw: location && workplace ? `${workplace} · ${location}` : location ?? workplace,
    description_text: job.descriptionPlain ?? (job.descriptionHtml ? htmlToText(job.descriptionHtml) : null),
    description_html: job.descriptionHtml ?? null,
    department: job.team ?? job.department ?? null,
    posted_at: job.publishedAt ?? null,
    updated_at: null,
    apply_url: job.applyUrl ?? `${canonical}/application`,
    canonical_url: canonical,
    ats_type: 'ashby',
    ats_job_id: job.id,
    requisition_id: null,
    employment_type_hint: job.employmentType ?? null,
    raw: job as Record<string, unknown>,
    retrieved_at: now,
  }
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

export function matchAshbyUrl(url: string): UrlMatch | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.hostname.toLowerCase() !== 'jobs.ashbyhq.com') return null
  const m = new RegExp(`^/([^/]+)(?:/(${UUID}))?(?:/application)?/?$`, 'i').exec(u.pathname)
  if (!m) return null
  return { board: { ats: 'ashby', identifier: m[1], board_url: `https://jobs.ashbyhq.com/${m[1]}` }, jobId: m[2]?.toLowerCase() ?? null }
}

async function listAll(board: AtsBoardRef): Promise<ListPostingsResult> {
  return cachedListing('ashby', board.identifier, listCacheBypassFromEnv(), async () => {
    const res = await fetchJson<{ jobs?: AshbyJob[] }>(`${API}/${encodeURIComponent(board.identifier)}?includeCompensation=true`)
    const board_url = `https://jobs.ashbyhq.com/${board.identifier}`
    if (res.status === 404) return { postings: [], total_on_board: 0, board_url, error: 'board not found', note: `no Ashby job board "${board.identifier}"` }
    if (!res.data || !Array.isArray(res.data.jobs)) return { postings: [], total_on_board: 0, board_url, error: res.error ?? 'unexpected payload' }
    const now = new Date().toISOString()
    const listed = res.data.jobs.filter((j) => j && typeof j.id === 'string' && j.title && j.isListed !== false)
    return { postings: listed.map((j) => normalizeAshbyJob(j, board, now)), total_on_board: res.data.jobs.length, board_url }
  })
}

export const ashbyAdapter: JobSourceAdapter = {
  id: 'ashby',
  source_type: 'ashby',
  isAvailable: () => process.env.CAREER_DISABLE_ASHBY !== '1',
  matchUrl: matchAshbyUrl,

  async detectBoard({ companyName, domain, careersUrl }) {
    if (careersUrl) {
      const m = matchAshbyUrl(careersUrl)
      if (m) return m.board
    }
    for (const slug of slugCandidates(companyName, domain)) {
      const res = await fetchJson<{ jobs?: unknown[] }>(`${API}/${slug}`)
      if (res.status === 200 && Array.isArray(res.data?.jobs)) {
        return { ats: 'ashby', identifier: slug, company_name: companyName, board_url: `https://jobs.ashbyhq.com/${slug}` }
      }
    }
    return null
  },

  async listPostings(board, options) {
    const full = await listAll(board)
    return { ...full, postings: applyListOptions(full.postings, options) }
  },

  async fetchPosting(board, externalId): Promise<PostingFetchResult> {
    const full = await listAll(board)
    if (full.error) return { status: 'error', posting: null, note: `Ashby listing failed: ${full.error}`, error: full.error }
    const hit = full.postings.find((p) => p.ats_job_id?.toLowerCase() === externalId.toLowerCase())
    if (!hit) return { status: 'not_found', posting: null, note: 'not present in the Ashby job board listing' }
    return { status: 'open', posting: hit, note: 'present in the Ashby job board listing' }
  },
}
