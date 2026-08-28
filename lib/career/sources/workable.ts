// Workable careers-site API — public, keyless.
//
// Verified live (Aug 2026):
//   POST apply.workable.com/api/v3/accounts/{subdomain}/jobs
//        body {query:'', location:[], department:[], worktype:[], remote:[]}   (GET is 404)
//     → {total, results: [{id, shortcode, title, remote, location{city, region, country, countryCode, display},
//          locations[], state, published, type ('full'|'part'|…), department[], workplace ('remote'|'hybrid'|'on_site')}],
//        nextPage: '<token>'}      — pass {token} in the body for the next page (10 per page)
//     An unknown subdomain is a 404 on some accounts and {total:0} on others.
//   GET apply.workable.com/api/v2/accounts/{subdomain}/jobs/{shortcode}
//     → {title, description, requirements, benefits, location, …} | 404 "Job not found"
// The v3 listing carries no description; fetchPosting fills it in.

import type { AtsBoardRef, JobSourceAdapter, ListPostingsResult, PostingFetchResult, RawJobPosting, UrlMatch } from './types'
import { applyListOptions, cachedListing, fetchJson, listCacheBypassFromEnv, slugCandidates, type JsonFetchResult } from './fetch'
import { htmlToText } from './html'

const API_V3 = 'https://apply.workable.com/api/v3/accounts'
const API_V2 = 'https://apply.workable.com/api/v2/accounts'
const MAX_PAGES = 15

export interface WorkableJob {
  id?: number
  shortcode: string
  title: string
  remote?: boolean
  location?: { city?: string | null; region?: string | null; country?: string | null; countryCode?: string | null; display?: string | null; workplaceType?: string | null }
  locations?: { city?: string | null; region?: string | null; country?: string | null }[]
  state?: string
  published?: string
  type?: string
  department?: string[] | string
  workplace?: string
  description?: string
  requirements?: string
  benefits?: string
  url?: string
  [k: string]: unknown
}

const TYPE_LABELS: Record<string, string> = { full: 'Full-time', part: 'Part-time', contract: 'Contract', temporary: 'Temporary', intern: 'Internship', internship: 'Internship' }

function locationRaw(j: WorkableJob): string | null {
  const l = j.location
  const base = l?.display || [l?.city, l?.region, l?.country].filter(Boolean).join(', ')
  const mode = j.workplace === 'remote' || j.remote ? 'Remote' : j.workplace === 'hybrid' ? 'Hybrid' : null
  if (!base) return mode
  return mode ? `${mode} · ${base}` : base
}

export function normalizeWorkableJob(j: WorkableJob, board: AtsBoardRef, now = new Date().toISOString()): RawJobPosting {
  const canonical = `https://apply.workable.com/${board.identifier}/j/${j.shortcode}/`
  const html = [j.description, j.requirements ? `<h3>Requirements</h3>${j.requirements}` : '', j.benefits ? `<h3>Benefits</h3>${j.benefits}` : '']
    .filter(Boolean)
    .join('\n')
  const dept = Array.isArray(j.department) ? j.department[0] : j.department
  return {
    source_type: 'workable',
    source_url: canonical,
    external_id: j.shortcode,
    company_name: board.company_name ?? board.identifier,
    company_domain: null,
    title: (j.title ?? '').trim(),
    location_raw: locationRaw(j),
    description_text: html ? htmlToText(html) : null,
    description_html: html || null,
    department: dept ?? null,
    posted_at: j.published ?? null,
    updated_at: null,
    apply_url: `${canonical}apply/`,
    canonical_url: canonical,
    ats_type: 'workable',
    ats_job_id: j.shortcode,
    requisition_id: null,
    employment_type_hint: j.type ? TYPE_LABELS[j.type.toLowerCase()] ?? j.type : null,
    raw: j as Record<string, unknown>,
    retrieved_at: now,
  }
}

export function matchWorkableUrl(url: string): UrlMatch | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.hostname.toLowerCase() !== 'apply.workable.com') return null
  const m = /^\/([^/]+)(?:\/j\/([A-Za-z0-9]+))?(?:\/apply)?\/?$/.exec(u.pathname)
  if (!m || m[1] === 'api') return null
  return { board: { ats: 'workable', identifier: m[1], board_url: `https://apply.workable.com/${m[1]}/` }, jobId: m[2]?.toUpperCase() ?? null }
}

const EMPTY_QUERY = { query: '', location: [], department: [], worktype: [], remote: [] }

export const workableAdapter: JobSourceAdapter = {
  id: 'workable',
  source_type: 'workable',
  isAvailable: () => process.env.CAREER_DISABLE_WORKABLE !== '1',
  matchUrl: matchWorkableUrl,

  async detectBoard({ companyName, domain, careersUrl }) {
    if (careersUrl) {
      const m = matchWorkableUrl(careersUrl)
      if (m) return m.board
    }
    for (const slug of slugCandidates(companyName, domain)) {
      const res = await fetchJson<{ total?: number }>(`${API_V3}/${slug}/jobs`, { method: 'POST', body: EMPTY_QUERY })
      // An unknown subdomain often answers {total:0} rather than 404; require postings to call it found.
      if (res.status === 200 && (res.data?.total ?? 0) > 0) {
        return { ats: 'workable', identifier: slug, company_name: companyName, board_url: `https://apply.workable.com/${slug}/` }
      }
    }
    return null
  },

  async listPostings(board, options) {
    const full = await cachedListing('workable', board.identifier, listCacheBypassFromEnv(), async () => {
      const board_url = `https://apply.workable.com/${board.identifier}/`
      const all: WorkableJob[] = []
      let total = 0
      let token: string | null = null
      for (let page = 0; page < MAX_PAGES; page++) {
        const body: Record<string, unknown> = token ? { ...EMPTY_QUERY, token } : EMPTY_QUERY
        const res: JsonFetchResult<{ total?: number; results?: WorkableJob[]; nextPage?: string | null }> = await fetchJson(
          `${API_V3}/${board.identifier}/jobs`,
          { method: 'POST', body }
        )
        if (res.status === 404) return { postings: [], total_on_board: 0, board_url, error: 'board not found', note: `no Workable account "${board.identifier}"` }
        if (!res.data) return { postings: [], total_on_board: total, board_url, error: res.error ?? 'empty response' }
        total = res.data.total ?? total
        const results = res.data.results ?? []
        all.push(...results)
        token = res.data.nextPage ?? null
        if (!token || results.length === 0 || all.length >= total) break
      }
      const now = new Date().toISOString()
      const postings = all.filter((j) => j && j.shortcode && j.title).map((j) => normalizeWorkableJob(j, board, now))
      return { postings, total_on_board: total, board_url } satisfies ListPostingsResult
    })
    return { ...full, postings: applyListOptions(full.postings, options) }
  },

  async fetchPosting(board, externalId): Promise<PostingFetchResult> {
    const res = await fetchJson<WorkableJob>(`${API_V2}/${board.identifier}/jobs/${encodeURIComponent(externalId)}`)
    if (res.status === 404) return { status: 'not_found', posting: null, note: 'Workable returned 404 for this shortcode' }
    if (!res.data || res.status !== 200 || !res.data.shortcode) return { status: 'error', posting: null, note: `Workable request failed: ${res.error ?? res.status}`, error: res.error }
    const posting = normalizeWorkableJob(res.data, board)
    if (res.data.state && res.data.state !== 'published') return { status: 'closed', posting, note: `Workable reports state "${res.data.state}"` }
    return { status: 'open', posting, note: 'published on Workable' }
  },
}
