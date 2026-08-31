// Careers-page scan: find the ATS a company uses, or the postings it lists
// itself, from its public careers page.
//
// This is the fallback for companies whose ATS slug we cannot guess. It is
// bounded — at most a handful of fetches per company — because a scan that
// crawls is a scraper, and this is not one.

import type { AtsBoardRef, CareersPageScan, FetchedPage, PageFetcher } from './types'
import { getPageFetcher } from './fetch'
import { matchAnyAtsUrl, toBoardRef } from './registry'

export const CAREERS_PATH_CANDIDATES = ['/careers', '/jobs', '/careers/jobs', '/join-us', '/company/careers', '/about/careers']
export const MAX_FETCHES_PER_COMPANY = 7

const POSTING_LINK_RE = /\b(job|jobs|career|careers|position|positions|intern|internship|opening|openings)\b/i

export interface ScanCareersInput {
  companyName: string
  domain?: string | null
  careersUrl?: string | null
}

/** Sentences worth surfacing to the planner/scout without a model in the loop. */
export function extractHints(text: string): string[] {
  const hints = new Set<string>()
  const lower = text.toLowerCase()
  const patterns: RegExp[] = [
    /\b(summer|fall|spring|winter)\s+20\d\d\b/g,
    /\b20\d\d\s+(summer|fall|spring|winter)\s+intern\w*/g,
    /\bintern(?:ship)?s?\b[^.\n]{0,80}/g,
    /\bco-?op\b[^.\n]{0,60}/g,
    /\bnot (?:currently )?(?:hiring|accepting)[^.\n]{0,80}/g,
    /\bno (?:open|current) (?:positions|roles|openings)[^.\n]{0,60}/g,
    /\bapplications? (?:open|close|closes|closing|due)[^.\n]{0,60}/g,
  ]
  for (const re of patterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(lower)) && hints.size < 12) {
      const snippet = m[0].replace(/\s+/g, ' ').trim()
      if (snippet.length >= 6) hints.add(snippet.slice(0, 120))
    }
  }
  return [...hints]
}

function dedupeBoards(boards: AtsBoardRef[]): AtsBoardRef[] {
  const seen = new Set<string>()
  const out: AtsBoardRef[] = []
  for (const b of boards) {
    const key = `${b.ats}:${b.identifier.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(b)
  }
  // Adapted ATSes first — those we can list; 'other' is a recorded URL only.
  return out.sort((a, b) => Number(a.ats === 'other') - Number(b.ats === 'other'))
}

/**
 * A large employer's careers page often renders its ATS link from JavaScript,
 * so the URL survives only as text in the extracted body — that is how Intel,
 * Micron and Amgen all looked link-less while naming their Workday tenant on
 * the page. Sweeping the text costs nothing and is the difference between
 * "no board detected" and a listable board.
 */
const URL_IN_TEXT_RE = /https?:\/\/[a-z0-9][a-z0-9._~:/?#[\]@!$&'()*+,;=%-]*/gi

export function atsUrlsInText(text: string, max = 40): string[] {
  const out: string[] = []
  for (const raw of text.match(URL_IN_TEXT_RE) ?? []) {
    const url = raw.replace(/[.,;:)\]}'"]+$/, '')
    if (!matchAnyAtsUrl(url) || out.includes(url)) continue
    out.push(url)
    if (out.length >= max) break
  }
  return out
}

/**
 * ATS families this page mentions at all — by link, by final URL, or by the
 * vendor's hostname appearing anywhere in the text. `detect.ts` uses this to
 * decide whether a tenant probe is warranted, so it is deliberately looser than
 * `matchAnyAtsUrl`: a page that says "myworkdayjobs.com" without a usable URL
 * still tells us where to look.
 */
const FAMILY_HOST_RE: [string, RegExp][] = [
  ['workday', /myworkdayjobs\.com|\bworkday\b/i],
  ['icims', /\bicims\.com\b/i],
  ['taleo', /\btaleo\.net\b/i],
  ['successfactors', /successfactors\.com|\bsapsf\.com\b|jobs2web\.com/i],
  ['greenhouse', /greenhouse\.io/i],
  ['lever', /jobs\.lever\.co/i],
  ['ashby', /ashbyhq\.com/i],
  ['smartrecruiters', /smartrecruiters\.com/i],
  ['workable', /workable\.com/i],
]

export function atsFamilyHints(page: FetchedPage | null): string[] {
  if (!page) return []
  const haystack = `${page.final_url}\n${page.links.join('\n')}\n${page.text}`
  return FAMILY_HOST_RE.filter(([, re]) => re.test(haystack)).map(([family]) => family)
}

function boardsFromLinks(links: string[], companyName: string): AtsBoardRef[] {
  const boards: AtsBoardRef[] = []
  for (const link of links) {
    const m = matchAnyAtsUrl(link)
    if (m) boards.push(toBoardRef(m, companyName))
  }
  return dedupeBoards(boards)
}

function postingLinks(page: FetchedPage, pageUrl: string): { url: string; text: string }[] {
  let origin: string | null = null
  try {
    origin = new URL(pageUrl).hostname.replace(/^www\./, '')
  } catch {
    origin = null
  }
  const out: { url: string; text: string }[] = []
  for (const url of page.links) {
    if (url === page.final_url || url === page.url) continue
    let host: string
    let path: string
    try {
      const u = new URL(url)
      host = u.hostname.replace(/^www\./, '')
      path = u.pathname
    } catch {
      continue
    }
    // Same site, or a known ATS host — never a social link or a random outbound page.
    const sameSite = origin ? host === origin || host.endsWith(`.${origin}`) : false
    if (!sameSite && !matchAnyAtsUrl(url)) continue
    if (!POSTING_LINK_RE.test(path) && !POSTING_LINK_RE.test(url)) continue
    if (/\.(png|jpe?g|svg|gif|pdf|css|js)$/i.test(path)) continue
    out.push({ url, text: '' })
    if (out.length >= 60) break
  }
  return out
}

export async function scanCareersPage(input: ScanCareersInput, fetcher: PageFetcher = getPageFetcher()): Promise<CareersPageScan> {
  const candidates: string[] = []
  if (input.careersUrl) candidates.push(input.careersUrl)
  if (input.domain) {
    const host = input.domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    for (const p of CAREERS_PATH_CANDIDATES) candidates.push(`https://${host}${p}`)
  }
  if (!candidates.length) return { careers_url: null, boards: [], posting_links: [], hints: [], fetched: null, error: 'no careers url or domain to scan' }

  let fetches = 0
  let lastError: string | undefined
  let blocked = false
  // The first page that loads is not always the one that names the ATS —
  // intel.com/careers is a marketing page and intel.com/jobs is the board. Keep
  // the first readable page as a fallback and keep looking for one with a board.
  let fallback: CareersPageScan | null = null

  for (const url of candidates.slice(0, MAX_FETCHES_PER_COMPANY)) {
    fetches++
    const page = await fetcher.fetch(url)
    if (page.robots_blocked) {
      blocked = true
      lastError = page.error
      continue
    }
    if (page.status < 200 || page.status >= 300 || !page.text) {
      lastError = page.error ?? `http ${page.status}`
      continue
    }
    const boards = boardsFromLinks([...page.links, ...atsUrlsInText(page.text)], input.companyName)
    // A page that only redirected to a board is itself the board.
    const selfMatch = matchAnyAtsUrl(page.final_url)
    if (selfMatch) boards.unshift(toBoardRef(selfMatch, input.companyName))
    const scan: CareersPageScan = {
      careers_url: page.final_url,
      boards: dedupeBoards(boards),
      posting_links: boards.length ? [] : postingLinks(page, page.final_url),
      hints: extractHints(page.text),
      fetched: page,
    }
    if (scan.boards.length) return scan
    if (!fallback || (!fallback.posting_links.length && scan.posting_links.length)) fallback = scan
  }
  if (fallback) return fallback
  return {
    careers_url: null,
    boards: [],
    posting_links: [],
    hints: [],
    fetched: null,
    error: blocked ? `could not scan: ${lastError ?? 'robots'}` : `no careers page found after ${fetches} fetches${lastError ? ` (last: ${lastError})` : ''}`,
  }
}
