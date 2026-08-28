// SmartRecruiters Posting API — public, keyless.
//
// Verified live (Aug 2026):
//   GET api.smartrecruiters.com/v1/companies/{id}/postings?limit=100&offset=N
//     → {offset, limit, totalFound, content: [{id, name, uuid, refNumber, releasedDate,
//          location{city, region, country ('us'), remote, hybrid, fullLocation}, typeOfEmployment{label},
//          experienceLevel{label}, department{label}, ref, company{identifier, name}}]}
//     An unknown company id returns 200 with totalFound 0, so detectBoard must
//     require at least one posting — a slug that exists but is empty is indistinguishable.
//   GET …/postings/{id} → {…, postingUrl, applyUrl, active, jobAd{sections{jobDescription{text}…}}}
//     | 404 RESOURCE_NOT_FOUND
// The listing carries no description; fetchPosting fills it in.

import type { AtsBoardRef, JobSourceAdapter, ListPostingsResult, PostingFetchResult, RawJobPosting, UrlMatch } from './types'
import { applyListOptions, cachedListing, fetchJson, listCacheBypassFromEnv, slugCandidates } from './fetch'
import { htmlToText } from './html'

const API = 'https://api.smartrecruiters.com/v1/companies'
const PAGE = 100
const MAX_PAGES = 10

export interface SmartRecruitersPosting {
  id: string
  name: string
  uuid?: string
  refNumber?: string
  releasedDate?: string
  location?: { city?: string; region?: string; country?: string; remote?: boolean; hybrid?: boolean; fullLocation?: string }
  typeOfEmployment?: { id?: string; label?: string }
  experienceLevel?: { id?: string; label?: string }
  department?: { id?: string; label?: string }
  company?: { identifier?: string; name?: string }
  ref?: string
  postingUrl?: string
  applyUrl?: string
  active?: boolean
  jobAd?: { sections?: Record<string, { title?: string; text?: string }> }
  [k: string]: unknown
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function locationRaw(p: SmartRecruitersPosting): string | null {
  const l = p.location
  if (!l) return null
  const base = l.fullLocation ?? [l.city, l.region, l.country?.toUpperCase()].filter(Boolean).join(', ')
  const mode = l.remote ? 'Remote' : l.hybrid ? 'Hybrid' : null
  return mode ? `${mode} · ${base}` : base || null
}

export function normalizeSmartRecruitersPosting(p: SmartRecruitersPosting, board: AtsBoardRef, now = new Date().toISOString()): RawJobPosting {
  const company = p.company?.identifier ?? board.identifier
  const canonical = p.postingUrl?.replace(/\?oga=true$/, '') ?? `https://jobs.smartrecruiters.com/${company}/${p.id}-${slugify(p.name ?? '')}`
  const sections = p.jobAd?.sections ?? {}
  const order = ['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation']
  const html = order.map((k) => sections[k]?.text ?? '').filter(Boolean).join('\n')
  const hint = [p.typeOfEmployment?.label, p.experienceLevel?.label].filter(Boolean).join(' / ') || null
  return {
    source_type: 'smartrecruiters',
    source_url: canonical,
    external_id: p.id,
    company_name: board.company_name ?? p.company?.name ?? company,
    company_domain: null,
    title: (p.name ?? '').trim(),
    location_raw: locationRaw(p),
    description_text: html ? htmlToText(html) : null,
    description_html: html || null,
    department: p.department?.label ?? null,
    posted_at: p.releasedDate ?? null,
    updated_at: null,
    apply_url: p.applyUrl ?? `${canonical}?oga=true`,
    canonical_url: canonical,
    ats_type: 'smartrecruiters',
    ats_job_id: p.id,
    requisition_id: p.refNumber ?? null,
    employment_type_hint: hint,
    raw: p as Record<string, unknown>,
    retrieved_at: now,
  }
}

export function matchSmartRecruitersUrl(url: string): UrlMatch | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (!/^(jobs|careers)\.smartrecruiters\.com$/.test(u.hostname.toLowerCase())) return null
  const m = /^\/([^/]+)(?:\/(\d{6,})(?:-[^/]*)?)?\/?$/.exec(u.pathname)
  if (!m) return null
  return { board: { ats: 'smartrecruiters', identifier: m[1], board_url: `https://jobs.smartrecruiters.com/${m[1]}` }, jobId: m[2] ?? null }
}

export const smartRecruitersAdapter: JobSourceAdapter = {
  id: 'smartrecruiters',
  source_type: 'smartrecruiters',
  isAvailable: () => process.env.CAREER_DISABLE_SMARTRECRUITERS !== '1',
  matchUrl: matchSmartRecruitersUrl,

  async detectBoard({ companyName, domain, careersUrl }) {
    if (careersUrl) {
      const m = matchSmartRecruitersUrl(careersUrl)
      if (m) return m.board
    }
    // SmartRecruiters ids are case-sensitive CamelCase ("BoschGroup"); try the
    // name without spaces in its original case as well as the lowercase slugs.
    const camel = companyName.replace(/[^A-Za-z0-9]/g, '')
    const candidates = [camel, ...slugCandidates(companyName, domain, 3)].filter((c, i, a) => c && a.indexOf(c) === i).slice(0, 4)
    for (const slug of candidates) {
      const res = await fetchJson<{ totalFound?: number; content?: SmartRecruitersPosting[] }>(`${API}/${slug}/postings?limit=1`)
      if (res.status === 200 && (res.data?.totalFound ?? 0) > 0) {
        const name = res.data?.content?.[0]?.company?.name ?? companyName
        return { ats: 'smartrecruiters', identifier: slug, company_name: name, board_url: `https://jobs.smartrecruiters.com/${slug}` }
      }
    }
    return null
  },

  async listPostings(board, options) {
    const full = await cachedListing('smartrecruiters', board.identifier, listCacheBypassFromEnv(), async () => {
      const board_url = `https://jobs.smartrecruiters.com/${board.identifier}`
      const all: SmartRecruitersPosting[] = []
      let total = 0
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await fetchJson<{ totalFound?: number; content?: SmartRecruitersPosting[] }>(
          `${API}/${board.identifier}/postings?limit=${PAGE}&offset=${page * PAGE}`
        )
        if (res.status === 404) return { postings: [], total_on_board: 0, board_url, error: 'board not found' }
        if (!res.data) return { postings: all.length ? all.map((p) => normalizeSmartRecruitersPosting(p, board)) : [], total_on_board: total, board_url, error: res.error ?? 'empty response' }
        total = res.data.totalFound ?? total
        const content = res.data.content ?? []
        all.push(...content)
        if (content.length < PAGE || all.length >= total) break
      }
      const now = new Date().toISOString()
      const postings = all.filter((p) => p && p.id && p.name).map((p) => normalizeSmartRecruitersPosting(p, board, now))
      const note = total > all.length ? `board has ${total} postings; listed the first ${all.length}` : undefined
      return { postings, total_on_board: total, board_url, note } satisfies ListPostingsResult
    })
    return { ...full, postings: applyListOptions(full.postings, options) }
  },

  async fetchPosting(board, externalId): Promise<PostingFetchResult> {
    const res = await fetchJson<SmartRecruitersPosting>(`${API}/${board.identifier}/postings/${encodeURIComponent(externalId)}`)
    if (res.status === 404) return { status: 'not_found', posting: null, note: 'SmartRecruiters returned 404 for this posting id' }
    if (!res.data || res.status !== 200) return { status: 'error', posting: null, note: `SmartRecruiters request failed: ${res.error ?? res.status}`, error: res.error }
    const posting = normalizeSmartRecruitersPosting(res.data, board)
    if (res.data.active === false) return { status: 'closed', posting, note: 'SmartRecruiters reports the posting as inactive' }
    return { status: 'open', posting, note: 'active on SmartRecruiters' }
  },
}
