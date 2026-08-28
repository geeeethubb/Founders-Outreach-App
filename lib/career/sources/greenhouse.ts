// Greenhouse Job Board API — public, keyless.
//
// Verified live (Aug 2026):
//   GET boards-api.greenhouse.io/v1/boards/{token}            → {name, content} | 404 "Job board not found"
//   GET …/boards/{token}/jobs?content=true                     → {jobs: [...], meta: {total}}
//   GET …/boards/{token}/jobs/{id}                             → job | 404 "Job not found"
// `content` is HTML escaped one extra time; html.ts undoes that.

import type { AtsBoardRef, JobSourceAdapter, ListPostingsResult, PostingFetchResult, RawJobPosting, UrlMatch } from './types'
import { applyListOptions, cachedListing, fetchJson, listCacheBypassFromEnv, slugCandidates } from './fetch'
import { htmlToText } from './html'

const API = 'https://boards-api.greenhouse.io/v1/boards'

export interface GreenhouseJob {
  id: number
  title: string
  updated_at?: string
  first_published?: string
  location?: { name?: string | null } | null
  absolute_url?: string
  content?: string
  requisition_id?: string | null
  departments?: { id?: number; name?: string }[]
  offices?: { id?: number; name?: string }[]
  metadata?: { id?: number; name?: string; value?: unknown; value_type?: string }[] | null
  company_name?: string
  application_deadline?: string | null
  [k: string]: unknown
}

function hintFromMetadata(job: GreenhouseJob): string | null {
  for (const m of job.metadata ?? []) {
    const name = (m.name ?? '').toLowerCase()
    if (/employment|job type|worker type|position type/.test(name) && typeof m.value === 'string' && m.value) return m.value
  }
  const dept = job.departments?.map((d) => d.name ?? '').join(' ') ?? ''
  if (/intern/i.test(dept)) return dept
  return null
}

export function normalizeGreenhouseJob(job: GreenhouseJob, board: AtsBoardRef, now = new Date().toISOString()): RawJobPosting {
  const canonical = `https://boards.greenhouse.io/${board.identifier}/jobs/${job.id}`
  const html = job.content ? htmlToText(job.content) : null
  return {
    source_type: 'greenhouse',
    source_url: canonical,
    external_id: String(job.id),
    company_name: board.company_name ?? job.company_name ?? board.identifier,
    company_domain: null,
    title: (job.title ?? '').trim(),
    location_raw: job.location?.name?.trim() || null,
    description_text: html,
    description_html: job.content ?? null,
    department: job.departments?.[0]?.name ?? null,
    posted_at: job.first_published ?? null,
    updated_at: job.updated_at ?? null,
    apply_url: job.absolute_url ?? canonical,
    canonical_url: canonical,
    ats_type: 'greenhouse',
    ats_job_id: String(job.id),
    requisition_id: job.requisition_id && !/see opening/i.test(job.requisition_id) ? job.requisition_id : null,
    employment_type_hint: hintFromMetadata(job),
    raw: job as Record<string, unknown>,
    retrieved_at: now,
  }
}

export function matchGreenhouseUrl(url: string): UrlMatch | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const host = u.hostname.toLowerCase()
  if (!/^(boards|job-boards)\.greenhouse\.io$/.test(host)) return null
  const board = (token: string, jobId: string | null): UrlMatch => ({
    board: { ats: 'greenhouse', identifier: token, board_url: `https://boards.greenhouse.io/${token}` },
    jobId,
  })
  if (u.pathname.startsWith('/embed/job_app')) {
    const token = u.searchParams.get('for')
    return token ? board(token, u.searchParams.get('token')) : null
  }
  const m = /^\/([^/]+)(?:\/jobs\/(\d+))?\/?$/.exec(u.pathname)
  if (!m || m[1] === 'embed') return null
  return board(m[1], m[2] ?? null)
}

export const greenhouseAdapter: JobSourceAdapter = {
  id: 'greenhouse',
  source_type: 'greenhouse',
  isAvailable: () => process.env.CAREER_DISABLE_GREENHOUSE !== '1',
  matchUrl: matchGreenhouseUrl,

  async detectBoard({ companyName, domain, careersUrl }) {
    if (careersUrl) {
      const m = matchGreenhouseUrl(careersUrl)
      if (m) return m.board
    }
    for (const slug of slugCandidates(companyName, domain)) {
      const res = await fetchJson<{ name?: string }>(`${API}/${slug}`)
      if (res.status === 200 && res.data?.name) {
        return { ats: 'greenhouse', identifier: slug, company_name: res.data.name, board_url: `https://boards.greenhouse.io/${slug}` }
      }
    }
    return null
  },

  async listPostings(board, options) {
    // The cache holds the full board; filtering happens after so one entry
    // serves every option combination (cache per entity, not per request).
    const full = await cachedListing('greenhouse', board.identifier, listCacheBypassFromEnv(), async () => {
      const res = await fetchJson<{ jobs?: GreenhouseJob[]; meta?: { total?: number } }>(`${API}/${board.identifier}/jobs?content=true`)
      const board_url = `https://boards.greenhouse.io/${board.identifier}`
      if (res.status === 404) return { postings: [], total_on_board: 0, board_url, error: 'board not found', note: `no Greenhouse board "${board.identifier}"` }
      if (!res.data) return { postings: [], total_on_board: 0, board_url, error: res.error ?? 'empty response' }
      const jobs = res.data.jobs ?? []
      const now = new Date().toISOString()
      const all = jobs.filter((j) => j && typeof j.id === 'number' && j.title).map((j) => normalizeGreenhouseJob(j, board, now))
      return { postings: all, total_on_board: jobs.length, board_url } satisfies ListPostingsResult
    })
    return { ...full, postings: applyListOptions(full.postings, options) }
  },

  async fetchPosting(board, externalId): Promise<PostingFetchResult> {
    const res = await fetchJson<GreenhouseJob>(`${API}/${board.identifier}/jobs/${encodeURIComponent(externalId)}`)
    if (res.status === 404) return { status: 'not_found', posting: null, note: 'Greenhouse returned 404 for this job id' }
    if (!res.data || res.status !== 200) return { status: 'error', posting: null, note: `Greenhouse request failed: ${res.error ?? res.status}`, error: res.error }
    return { status: 'open', posting: normalizeGreenhouseJob(res.data, board), note: 'present on the Greenhouse board' }
  },
}
