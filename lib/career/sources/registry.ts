// The source registry: every adapter, in confidence order, plus URL recognition
// for ATS families we do not adapt.
//
// The scout and the company-first loop depend on this and never on an adapter
// by name. `matchAnyAtsUrl` exists because a careers page that links to
// Workday or iCIMS still tells us something worth recording — the canonical
// board URL — even though there is no keyless API to list it.

import type { AtsType } from '../types'
import type { AtsBoardRef, JobSourceAdapter, SourceRegistry, UrlMatch } from './types'
import { greenhouseAdapter } from './greenhouse'
import { leverAdapter } from './lever'
import { ashbyAdapter } from './ashby'
import { smartRecruitersAdapter } from './smartrecruiters'
import { workableAdapter } from './workable'
import { workdayAdapter } from './workday'

const ALL: JobSourceAdapter[] = [greenhouseAdapter, leverAdapter, ashbyAdapter, smartRecruitersAdapter, workableAdapter, workdayAdapter]

let registry: SourceRegistry | null = null

export function getSourceRegistry(): SourceRegistry {
  if (registry) return registry
  registry = {
    adapters: () => ALL.filter((a) => a.isAvailable()),
    byId: (id: AtsType) => ALL.find((a) => a.id === id && a.isAvailable()) ?? null,
    matchUrl(url: string) {
      for (const adapter of ALL) {
        if (!adapter.isAvailable()) continue
        const match = adapter.matchUrl(url)
        if (match) return { adapter, match }
      }
      return null
    },
  }
  return registry
}

/** Test seam: a registry over an explicit adapter list (stubs). */
export function createSourceRegistry(adapters: JobSourceAdapter[]): SourceRegistry {
  return {
    adapters: () => adapters.filter((a) => a.isAvailable()),
    byId: (id) => adapters.find((a) => a.id === id && a.isAvailable()) ?? null,
    matchUrl(url) {
      for (const adapter of adapters) {
        if (!adapter.isAvailable()) continue
        const match = adapter.matchUrl(url)
        if (match) return { adapter, match }
      }
      return null
    },
  }
}

export interface AnyAtsMatch {
  ats: AtsType
  /** The adapter family name for 'other' matches: 'workday', 'icims', … */
  family: string
  identifier: string
  board_url: string
  jobId: string | null
}

/**
 * Recognized ATS families without an adapter. Each entry extracts the tenant
 * from the hostname (or the first path segment) and rebuilds a board URL.
 */
// Workday used to live here. It is an adapter now (lib/career/sources/workday.ts),
// so `getSourceRegistry().matchUrl` claims those URLs first and they arrive with
// a listable `tenant/pod/site` identifier instead of a bare tenant name.
const OTHER_FAMILIES: { family: string; host: RegExp; identifier: (u: URL, m: RegExpExecArray) => string | null; board: (u: URL, id: string) => string }[] = [
  { family: 'icims', host: /^(?:careers[-.])?([a-z0-9-]+)\.icims\.com$/, identifier: (_u, m) => m[1], board: (u) => `${u.origin}/jobs/search` },
  { family: 'taleo', host: /^([a-z0-9-]+)\.taleo\.net$/, identifier: (_u, m) => m[1], board: (u) => `${u.origin}${u.pathname.split('/').slice(0, 2).join('/')}` },
  {
    family: 'successfactors',
    host: /^(?:career[s]?|jobs)\.?([a-z0-9-]*)\.?(?:successfactors|sapsf)\.(?:com|eu)$|^([a-z0-9-]+)\.(?:jobs2web|successfactors)\.com$/,
    identifier: (u, m) => m[1] || m[2] || u.pathname.split('/')[1] || null,
    board: (u) => u.origin,
  },
  { family: 'jobvite', host: /^jobs\.jobvite\.com$/, identifier: (u) => u.pathname.split('/')[1] || null, board: (u, id) => `${u.origin}/${id}` },
  { family: 'bamboohr', host: /^([a-z0-9-]+)\.bamboohr\.com$/, identifier: (_u, m) => m[1], board: (u) => `${u.origin}/careers` },
  { family: 'rippling', host: /^ats\.rippling\.com$/, identifier: (u) => u.pathname.split('/')[1] || null, board: (u, id) => `${u.origin}/${id}` },
  { family: 'recruitee', host: /^([a-z0-9-]+)\.recruitee\.com$/, identifier: (_u, m) => m[1], board: (u) => u.origin },
  { family: 'breezy', host: /^([a-z0-9-]+)\.breezy\.hr$/, identifier: (_u, m) => m[1], board: (u) => u.origin },
]

/** Recognize a URL on any known ATS — adapted or not. Adapted ATSes take precedence. */
export function matchAnyAtsUrl(url: string): AnyAtsMatch | null {
  const adapted = getSourceRegistry().matchUrl(url)
  if (adapted) {
    const b: AtsBoardRef = adapted.match.board
    return { ats: b.ats, family: b.ats, identifier: b.identifier, board_url: b.board_url ?? url, jobId: adapted.match.jobId }
  }
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const host = u.hostname.toLowerCase()
  for (const fam of OTHER_FAMILIES) {
    const m = fam.host.exec(host)
    if (!m) continue
    const identifier = fam.identifier(u, m)
    if (!identifier) continue
    return { ats: 'other', family: fam.family, identifier, board_url: fam.board(u, identifier), jobId: null }
  }
  return null
}

export function toBoardRef(match: AnyAtsMatch, companyName?: string): AtsBoardRef {
  return { ats: match.ats, identifier: match.identifier, company_name: companyName, board_url: match.board_url }
}

export type { UrlMatch }
