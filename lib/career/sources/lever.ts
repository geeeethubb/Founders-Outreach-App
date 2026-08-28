// Lever Postings API — public, keyless.
//
// Verified live (Aug 2026):
//   GET api.lever.co/v0/postings/{site}?mode=json  → [posting…] (404 on unknown site)
//   GET api.lever.co/v0/postings/{site}/{id}       → posting | 404 {"ok":false,"error":"Document not found"}
// `description` is the opening HTML; `lists` carry the bullet sections; the
// `*Plain` fields are Lever's own text rendering, which we prefer to our own.

import type { AtsBoardRef, JobSourceAdapter, ListPostingsResult, PostingFetchResult, RawJobPosting, UrlMatch } from './types'
import { applyListOptions, cachedListing, fetchJson, listCacheBypassFromEnv, slugCandidates } from './fetch'
import { htmlToText } from './html'

const API = 'https://api.lever.co/v0/postings'

export interface LeverPosting {
  id: string
  text: string
  categories?: { location?: string; team?: string; commitment?: string; department?: string; allLocations?: string[] }
  description?: string
  descriptionPlain?: string
  descriptionBody?: string
  descriptionBodyPlain?: string
  additional?: string
  additionalPlain?: string
  lists?: { text?: string; content?: string }[]
  hostedUrl?: string
  applyUrl?: string
  createdAt?: number
  updatedAt?: number
  workplaceType?: string
  country?: string
  [k: string]: unknown
}

function fullText(p: LeverPosting): { text: string; html: string } {
  const listsHtml = (p.lists ?? []).map((l) => `<h3>${l.text ?? ''}</h3><ul>${l.content ?? ''}</ul>`).join('\n')
  const html = [p.description ?? '', listsHtml, p.additional ?? ''].filter(Boolean).join('\n')
  const listsText = (p.lists ?? []).map((l) => `${l.text ?? ''}\n${htmlToText(l.content ?? '')}`).join('\n\n')
  const text = [p.descriptionPlain ?? htmlToText(p.description ?? ''), listsText, p.additionalPlain ?? htmlToText(p.additional ?? '')]
    .filter((s) => s.trim())
    .join('\n\n')
  return { text, html }
}

export function normalizeLeverPosting(p: LeverPosting, board: AtsBoardRef, now = new Date().toISOString()): RawJobPosting {
  const canonical = p.hostedUrl ?? `https://jobs.lever.co/${board.identifier}/${p.id}`
  const { text, html } = fullText(p)
  const locations = p.categories?.allLocations?.length ? p.categories.allLocations : p.categories?.location ? [p.categories.location] : []
  const location = locations.join('; ') || null
  const workplace = p.workplaceType && !/on-?site/i.test(p.workplaceType) ? p.workplaceType : null
  return {
    source_type: 'lever',
    source_url: canonical,
    external_id: p.id,
    company_name: board.company_name ?? board.identifier,
    company_domain: null,
    title: (p.text ?? '').trim(),
    // Lever keeps remote/hybrid in workplaceType, not in the location string — fold it in so parseLocation sees it.
    location_raw: location && workplace ? `${workplace} · ${location}` : location ?? workplace,
    description_text: text || null,
    description_html: html || null,
    department: p.categories?.team ?? p.categories?.department ?? null,
    posted_at: typeof p.createdAt === 'number' ? new Date(p.createdAt).toISOString() : null,
    updated_at: typeof p.updatedAt === 'number' ? new Date(p.updatedAt).toISOString() : null,
    apply_url: p.applyUrl ?? `${canonical}/apply`,
    canonical_url: canonical,
    ats_type: 'lever',
    ats_job_id: p.id,
    requisition_id: null,
    employment_type_hint: p.categories?.commitment ?? null,
    raw: p as Record<string, unknown>,
    retrieved_at: now,
  }
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

export function matchLeverUrl(url: string): UrlMatch | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (!/^jobs\.(eu\.)?lever\.co$/.test(u.hostname.toLowerCase())) return null
  const m = new RegExp(`^/([^/]+)(?:/(${UUID}))?(?:/apply)?/?$`, 'i').exec(u.pathname)
  if (!m) return null
  return { board: { ats: 'lever', identifier: m[1], board_url: `https://jobs.lever.co/${m[1]}` }, jobId: m[2]?.toLowerCase() ?? null }
}

export const leverAdapter: JobSourceAdapter = {
  id: 'lever',
  source_type: 'lever',
  isAvailable: () => process.env.CAREER_DISABLE_LEVER !== '1',
  matchUrl: matchLeverUrl,

  async detectBoard({ companyName, domain, careersUrl }) {
    if (careersUrl) {
      const m = matchLeverUrl(careersUrl)
      if (m) return m.board
    }
    for (const slug of slugCandidates(companyName, domain)) {
      // Lever has no board-metadata endpoint; a 200 array (even empty) means the site exists.
      const res = await fetchJson<unknown>(`${API}/${slug}?mode=json&limit=1`)
      if (res.status === 200 && Array.isArray(res.data)) {
        return { ats: 'lever', identifier: slug, company_name: companyName, board_url: `https://jobs.lever.co/${slug}` }
      }
    }
    return null
  },

  async listPostings(board, options) {
    const full = await cachedListing('lever', board.identifier, listCacheBypassFromEnv(), async () => {
      const res = await fetchJson<LeverPosting[]>(`${API}/${board.identifier}?mode=json`)
      const board_url = `https://jobs.lever.co/${board.identifier}`
      if (res.status === 404) return { postings: [], total_on_board: 0, board_url, error: 'board not found', note: `no Lever site "${board.identifier}"` }
      if (!Array.isArray(res.data)) return { postings: [], total_on_board: 0, board_url, error: res.error ?? 'unexpected payload' }
      const now = new Date().toISOString()
      const all = res.data.filter((p) => p && typeof p.id === 'string' && p.text).map((p) => normalizeLeverPosting(p, board, now))
      return { postings: all, total_on_board: res.data.length, board_url } satisfies ListPostingsResult
    })
    return { ...full, postings: applyListOptions(full.postings, options) }
  },

  async fetchPosting(board, externalId): Promise<PostingFetchResult> {
    const res = await fetchJson<LeverPosting>(`${API}/${board.identifier}/${encodeURIComponent(externalId)}`)
    if (res.status === 404) return { status: 'not_found', posting: null, note: 'Lever returned 404 for this posting id' }
    if (!res.data || res.status !== 200 || typeof res.data.id !== 'string') {
      return { status: 'error', posting: null, note: `Lever request failed: ${res.error ?? res.status}`, error: res.error }
    }
    return { status: 'open', posting: normalizeLeverPosting(res.data, board), note: 'present on the Lever site' }
  },
}
