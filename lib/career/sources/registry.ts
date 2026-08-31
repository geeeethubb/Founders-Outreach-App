// The source registry: every adapter, in confidence order, plus URL recognition
// for ATS families we do not adapt.
//
// The scout and the company-first loop depend on this and never on an adapter
// by name. `matchAnyAtsUrl` exists because a careers page that links to
// Workday or iCIMS still tells us something worth recording — the canonical
// board URL — even though there is no keyless API to list it.

import type { AtsType } from '../types'
import type { AtsBoardRef, JobSourceAdapter, ListPostingsResult, SourceRegistry, UrlMatch } from './types'
import {
  emptyDiscoveryResult,
  failedDiscoveryResult,
  sourceClassOf,
  type DiscoveryCapabilities,
  type DiscoveryCostModel,
  type DiscoveryHealth,
  type DiscoveryRegistry,
  type DiscoverySourceClass,
  type DiscoverySourceType,
  type JobDiscoverySource,
  type UnconfiguredSource,
} from './discovery-types'
import { greenhouseAdapter } from './greenhouse'
import { leverAdapter } from './lever'
import { ashbyAdapter } from './ashby'
import { smartRecruitersAdapter } from './smartrecruiters'
import { workableAdapter } from './workable'
import { workdayAdapter } from './workday'
import { oracleOrcSource } from './oracle-orc'
import { taleoSource } from './taleo'
import { recruiteeSource } from './recruitee'
import { gemSource } from './gem'
import { teamtailorSource } from './teamtailor'
import { personioSource } from './personio'
import { simplifySource } from './simplify'
import { dataForSeoSource } from './dataforseo'

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

// ─── The discovery registry: every surface, one interface ────────────────────
//
// `SourceRegistry` above is the ATS registry and stays exactly as it is — the
// scout, the sweep and company-first all depend on it. What follows is the
// wider registry V2 needs, over `JobDiscoverySource` (./discovery-types), which
// also covers feeds, SERP providers and aggregators.
//
// The six ATS adapters are NOT rewritten. `wrapAtsAdapter` presents each one
// through the new interface: a board listing is a single exhausted page with a
// null cursor, and `total_on_board` is what the coverage table calls `seen`.

const ATS_NAMES: Record<string, string> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  smartrecruiters: 'SmartRecruiters',
  workable: 'Workable',
  workday: 'Workday',
}

/**
 * Per-adapter capability overrides. The one that is NOT uniform across the six
 * is `givesDescription`, and it is the one a planner acts on.
 *
 * Three ATSes return the description in the LIST call:
 *   greenhouse  `…/jobs?content=true` carries `content`
 *   lever       `…?mode=json` carries `descriptionPlain`
 *   ashby       the job-board endpoint carries `descriptionPlain`
 *
 * Three do not, and their listings normalize to `description_text: null`:
 *   workday          `collectWorkdayPostings` passes no `descriptionHtml`
 *   smartrecruiters  the text lives in `jobAd.sections`, absent from `/postings`
 *   workable         "the v3 listing carries no description; fetchPosting fills it in"
 *
 * Declaring `givesDescription: true` for all six was a real bug in waiting:
 * extraction drops any posting under `MIN_EXTRACT_CHARS` of description
 * (scout/extract.ts), so a planner that trusted the capability and skipped the
 * per-posting fetch would lose every Workday, SmartRecruiters and Workable job
 * — silently, and only for the three biggest enterprise boards.
 */
export const ATS_CAPABILITIES: Record<string, Partial<DiscoveryCapabilities>> = {
  greenhouse: { givesDescription: true },
  lever: { givesDescription: true },
  ashby: { givesDescription: true },
  smartrecruiters: { givesDescription: false },
  workable: { givesDescription: false },
  workday: { givesDescription: false },
}

export interface WrapAtsOptions {
  id?: string
  name?: string
  capabilities?: Partial<DiscoveryCapabilities>
  costModel?: DiscoveryCostModel
  /** Override the default no-network health check with a real probe. */
  healthCheck?: () => Promise<DiscoveryHealth>
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Present an existing `JobSourceAdapter` as a `JobDiscoverySource`.
 *
 * The adapter is addressed by a board, so `search` needs `input.board` — or an
 * `input.company` it can resolve with one `detectBoard` call. Given neither, it
 * returns an empty, exhausted result with a note. That is a caller mistake, not
 * a failure of the source, and it must not colour the run's error list.
 *
 * The default `healthCheck` does NOT touch the network: it reports whether the
 * adapter is enabled. Probing six ATSes on every registry read would cost six
 * requests to answer a question the env already answers.
 */
export function wrapAtsAdapter(adapter: JobSourceAdapter, opts: WrapAtsOptions = {}): JobDiscoverySource {
  const name = opts.name ?? ATS_NAMES[String(adapter.id)] ?? String(adapter.id)
  const capabilities: DiscoveryCapabilities = {
    // A board is listed in one call: there is no second page to ask for.
    paginates: false,
    supportsQuery: false,
    supportsLocation: false,
    supportsSince: false,
    // Default FALSE, opt in per adapter. A capability that over-promises costs
    // postings; one that under-promises costs a fetch.
    givesDescription: false,
    givesCanonicalUrl: true,
    ...ATS_CAPABILITIES[String(adapter.id)],
    ...opts.capabilities,
  }
  const costModel: DiscoveryCostModel = opts.costModel ?? { kind: 'free' }
  const configured = (): boolean => {
    try {
      return adapter.isAvailable()
    } catch {
      return false
    }
  }
  return {
    id: opts.id ?? String(adapter.id),
    name,
    sourceType: 'ats',
    capabilities,
    costModel,
    isConfigured: configured,
    async healthCheck() {
      if (opts.healthCheck) {
        try {
          return await opts.healthCheck()
        } catch (e) {
          return { ok: false, detail: errText(e) }
        }
      }
      return configured()
        ? { ok: true, detail: `${name} adapter enabled (not probed)` }
        : { ok: false, detail: `${name} adapter disabled by env` }
    },
    async search(input, cursor) {
      if (!configured()) return failedDiscoveryResult(`${name} adapter is disabled`)
      // paginates: false — anything but the first page is already exhausted.
      if (cursor) return emptyDiscoveryResult(`${name} lists a board in one call; no page after the first`)

      let board = input.board ?? null
      if (!board && input.company) {
        try {
          board = await adapter.detectBoard({
            companyName: input.company.name,
            domain: input.company.domain ?? null,
            careersUrl: input.company.careersUrl ?? null,
          })
        } catch (e) {
          return failedDiscoveryResult(`${name} board detection failed: ${errText(e)}`)
        }
        if (!board) return emptyDiscoveryResult(`no ${name} board found for ${input.company.name}`)
      }
      if (!board) return emptyDiscoveryResult(`${name} needs a board or a company; neither was given`)

      let res: ListPostingsResult
      try {
        res = await adapter.listPostings(board, {
          internshipsOnly: input.internshipsOnly ?? false,
          ...(input.limit ? { limit: input.limit } : {}),
        })
      } catch (e) {
        return failedDiscoveryResult(`${name} list failed: ${errText(e)}`)
      }
      const postings = Array.isArray(res.postings) ? res.postings : []
      const onBoard = Number.isFinite(res.total_on_board) ? Number(res.total_on_board) : postings.length
      return {
        postings,
        nextCursor: null,
        exhausted: true,
        // `seen` is what the board held, not what survived internshipsOnly.
        seen: Math.max(onBoard, postings.length),
        requests: 1,
        costUsd: 0,
        ...(res.note ? { note: res.note } : {}),
        ...(res.error ? { error: res.error } : {}),
      }
    },
  }
}

/** Sources registered at runtime (paid providers, feeds) — keyed by id, last registration wins. */
const EXTRA_DISCOVERY_SOURCES: JobDiscoverySource[] = []

/**
 * Register a non-ATS surface. Idempotent by id, so a module may register on
 * import — and the id space is SHARED with the wrapped ATS adapters, so
 * registering under `greenhouse` replaces the wrapper rather than shadowing it
 * (see `dedupeById`).
 */
export function registerDiscoverySource(source: JobDiscoverySource): void {
  const i = EXTRA_DISCOVERY_SOURCES.findIndex((s) => s.id === source.id)
  if (i >= 0) EXTRA_DISCOVERY_SOURCES[i] = source
  else EXTRA_DISCOVERY_SOURCES.push(source)
}

/** Test seam. */
export function clearRegisteredDiscoverySources(): void {
  EXTRA_DISCOVERY_SOURCES.length = 0
}

function isConfiguredSafe(s: JobDiscoverySource): boolean {
  try {
    return s.isConfigured()
  } catch {
    return false
  }
}

function costLabel(s: JobDiscoverySource): string {
  const c = s.costModel
  if (c.kind === 'free') return 'free'
  const unit = c.unitCostUsd ? `$${c.unitCostUsd.toFixed(4)}` : 'unpriced'
  return c.kind === 'per_request' ? `${unit}/request` : `${unit}/credit`
}

/**
 * Collapse duplicate ids: the LAST definition wins, in the FIRST one's
 * position.
 *
 * `byId` is a `find`, so without this a source registered under an id an ATS
 * wrapper already owns is shadowed — it appears in `all()` and `describe()`,
 * is counted in every coverage table built from them, and is never the one
 * `byId` returns. "Last wins" matches `registerDiscoverySource`, which is how a
 * caller replaces the built-in Greenhouse wrapper with a paid Greenhouse feed;
 * keeping the original position keeps the printed table stable.
 */
function dedupeById(sources: JobDiscoverySource[]): JobDiscoverySource[] {
  const at = new Map<string, number>()
  const out: JobDiscoverySource[] = []
  for (const s of sources) {
    const i = at.get(s.id)
    if (i === undefined) {
      at.set(s.id, out.length)
      out.push(s)
    } else {
      out[i] = s
    }
  }
  return out
}

/** A registry over an explicit list — the test seam and the composition point. */
export function createDiscoveryRegistry(input: JobDiscoverySource[]): DiscoveryRegistry {
  const sources = dedupeById(input)
  const all = () => sources.slice()
  const configured = () => sources.filter(isConfiguredSafe)
  return {
    all,
    configured,
    unconfigured(): UnconfiguredSource[] {
      return sources.filter((s) => !isConfiguredSafe(s)).map((s) => {
        const envVar = s.costModel.envVar ?? null
        return {
          id: s.id,
          name: s.name,
          sourceType: s.sourceType,
          envVar,
          reason: envVar ? `not configured — set ${envVar}` : 'not configured — disabled or unavailable',
        }
      })
    },
    byId: (id: string) => sources.find((s) => s.id === id) ?? null,
    byType: (sourceType: DiscoverySourceType) => sources.filter((s) => s.sourceType === sourceType),
    byClass: (cls: DiscoverySourceClass) => sources.filter((s) => sourceClassOf(s.sourceType) === cls),
    describe() {
      return sources.map((s) => {
        const ok = isConfiguredSafe(s)
        const envVar = s.costModel.envVar
        const state = ok ? 'configured' : envVar ? `not configured — set ${envVar}` : 'not configured'
        return `${s.id} · ${s.sourceType}/${sourceClassOf(s.sourceType)} · ${costLabel(s)} · ${state}`
      })
    },
  }
}

/**
 * The V2 sources — the ones written against `JobDiscoverySource` directly
 * rather than wrapped from a `JobSourceAdapter`.
 *
 * Order is deliberate: Oracle and Taleo first because they are what the
 * founder's own field runs on (Merck, DuPont, Corning, ExxonMobil), and they
 * are the reason 126 watchlist companies used to answer "no public board
 * detected". Simplify last of the free ones because it is a software list
 * whose real value is the ATS tenants it reveals, not its own postings.
 * DataForSEO is the only paid source and reports `isConfigured: false`
 * without its credentials, so a build with no key simply runs without it.
 */
export function v2DiscoverySources(): JobDiscoverySource[] {
  return [
    oracleOrcSource(),
    taleoSource(),
    recruiteeSource(),
    gemSource(),
    teamtailorSource(),
    personioSource(),
    simplifySource(),
    dataForSeoSource(),
  ]
}

/**
 * Every discovery surface this build knows: the six ATS adapters wrapped, the
 * V2 sources above, plus anything registered at runtime. A missing credential
 * is REPORTED, never thrown — `unconfigured()` names the env var each skipped
 * source needs.
 */
export function discoveryRegistry(): DiscoveryRegistry {
  return createDiscoveryRegistry([
    ...ALL.map((a) => wrapAtsAdapter(a)),
    ...v2DiscoverySources(),
    ...EXTRA_DISCOVERY_SOURCES,
  ])
}
