// DataForSEO Google Jobs — the paid search slot, behind an env var.
//
// WHY THIS PROVIDER. docs/JOB_SOURCE_MATRIX.md compared the whole SERP market
// on 2026-08-31 and this one won on two facts that are not close:
//
//   1. `employment_type` accepts `intern` — a real, structured internship
//      filter. SerpApi lost its equivalent when Google deprecated `chips`, and
//      every other vendor with a Google Jobs vertical has none. Filtering for
//      internships in the QUERY means paying for, and then discarding, the
//      other 95 % of the SERP.
//   2. $0.0006 per 10 results, `depth` up to 200 per task — ~$0.06 per 1,000
//      jobs, roughly 75x cheaper per job than the next usable option.
//
// WHAT IT IS FOR. Google Jobs is how this app reaches the LinkedIn and Indeed
// markets legitimately: Google indexes those postings, DataForSEO reads
// Google's public results page, and nothing here logs in, bypasses a CAPTCHA,
// or touches a platform behind an access control. It is a SUPPLEMENT to the
// free ATS layer, never the backbone — docs/JOB_SOURCE_MATRIX.md §"the sensible
// posture is: treat every SERP vendor as replaceable".
//
// THREE PROPERTIES THIS FILE OWES THE REST OF THE SYSTEM.
//
//   COST IS REPORTED, NOT ESTIMATED AFTER THE FACT. Every result carries
//   `costUsd` and `requests`, so the coverage ledger can say what the run spent
//   here, and a caller-supplied budget is enforced BEFORE a task is posted —
//   the only moment at which refusing is still free.
//
//   NO KEY IS NOT AN ERROR. `isConfigured()` is a pure env read. Without the
//   credentials the registry skips this source and names the env var; the app
//   is fully functional with no paid provider at all (principle 8). Nothing in
//   this file throws for a missing key — or for anything else.
//
//   THE QUEUE DOES NOT BLOCK THE RUN. This is a task API: post a task, poll for
//   it, and the standard queue takes up to five minutes. Holding a discovery
//   run open for five minutes to save one HTTP round trip is the wrong trade,
//   so a task that is not ready by the deadline comes back as
//   `exhausted: false` with a cursor. The caller resumes it later; the task is
//   already paid for and DataForSEO retains it for 30 days.
//
// STATUS: written against the documented request/response shapes and the
// fixtures in evals/career/fixtures/ats/dataforseo-*.json. It has NOT been run
// against a live DataForSEO account — there is no key on this machine. Parsing
// is deliberately defensive for that reason: every field is optional, and an
// unexpected shape degrades to "skip that item", never to a throw.

import { normalizeDomain } from '@/lib/providers/apollo/normalize'
import type { RawJobPosting } from './types'
import type { AtsType, JobSourceType } from '../types'
import { atsFamilyFromUrl, isAggregatorHost } from './tenant-discovery'
import type {
  DiscoveryCapabilities,
  DiscoveryCostModel,
  DiscoveryHealth,
  DiscoverySearchInput,
  DiscoverySearchResult,
  JobDiscoverySource,
} from './discovery-types'

// ─── Constants from the provider's documentation ─────────────────────────────

export const DATAFORSEO_BASE = 'https://api.dataforseo.com'
export const TASK_POST_PATH = '/v3/serp/google/jobs/task_post'
export const TASK_GET_PATH = '/v3/serp/google/jobs/task_get/advanced'
/** Free: reports the account balance. Used only by `healthCheck`. */
export const USER_DATA_PATH = '/v3/appendix/user_data'

/** Standard queue, per 10-result page. Priority queue is $0.0012. */
export const COST_PER_PAGE_USD = 0.0006
export const RESULTS_PER_PAGE = 10
/** `depth` is billed per 10-result page and capped at 200. */
export const MAX_DEPTH = 200
/** `keyword` is limited to 700 characters. */
export const MAX_KEYWORD_CHARS = 700
/** DataForSEO's location code for the United States. */
export const DEFAULT_LOCATION_CODE = 2840

/**
 * The status codes this adapter reasons about. DataForSEO returns them twice:
 * once on the envelope, once per task, and the task's is the one that matters.
 */
export const STATUS_OK = 20000
export const STATUS_TASK_CREATED = 20100
/** "Task In Queue" / "Task Handed" — not ready yet, and not an error. */
export const NOT_READY_CODES = [20100, 40601, 40602]
/** Authentication and billing. A run must say which, because the fixes differ. */
export const AUTH_CODES = [40100, 40101, 40102, 40103, 40200]

const DEFAULT_DEADLINE_MS = 45_000
const FIRST_POLL_MS = 3_000
const MAX_POLL_MS = 20_000
const POLL_BACKOFF = 1.6
/**
 * A hard iteration cap, independent of the clock. `now` and `sleep` are both
 * injectable options, and nothing couples them: a caller that injects a fast
 * clock with a real sleep — or a no-op sleep with a real clock — would turn a
 * 45-second polling window into a tight request loop against an API whose rate
 * limits are undocumented (docs/JOB_SOURCE_MATRIX.md). The deadline governs
 * how long we wait; this governs how many times we ask, and neither depends on
 * the other being honest.
 */
const MAX_POLLS = 8
const REQUEST_TIMEOUT_MS = 30_000

// ─── Credentials ─────────────────────────────────────────────────────────────

export interface DataForSeoCredentials {
  login: string
  password: string
}

/**
 * Anything shaped like an environment. `process.env` satisfies it, and so does
 * a two-key literal in a test — which is the point: `NodeJS.ProcessEnv` insists
 * on `NODE_ENV`, so typing it that way would force every caller that wants to
 * probe the unconfigured path to fabricate an entire environment.
 */
export type EnvLike = Record<string, string | undefined>

/**
 * Pure env read. Both halves are required — a login without a password is
 * unconfigured, not half-configured, and reporting it as configured would turn
 * a missing secret into an HTTP 401 in the middle of a run.
 */
export function dataForSeoCredentials(env: EnvLike = process.env): DataForSeoCredentials | null {
  const login = (env.DATAFORSEO_LOGIN ?? '').trim()
  const password = (env.DATAFORSEO_PASSWORD ?? '').trim()
  if (!login || !password) return null
  return { login, password }
}

function basicAuth(c: DataForSeoCredentials): string {
  return `Basic ${Buffer.from(`${c.login}:${c.password}`, 'utf8').toString('base64')}`
}

// ─── The HTTP seam ───────────────────────────────────────────────────────────

export interface DataForSeoRequest {
  method: 'GET' | 'POST'
  url: string
  /** Already JSON-serialisable. Never logged: it is small and boring, but the header beside it is not. */
  body?: unknown
  headers: Record<string, string>
}

export interface DataForSeoResponse {
  ok: boolean
  status: number
  body: string
  error?: string
}

export type DataForSeoFetcher = (req: DataForSeoRequest) => Promise<DataForSeoResponse>

const defaultFetcher: DataForSeoFetcher = async (req) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: controller.signal,
    })
    return { ok: res.ok, status: res.status, body: await res.text() }
  } catch (e) {
    return { ok: false, status: 0, body: '', error: e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(timer)
  }
}

// ─── Response shapes (every field optional on purpose) ───────────────────────

export interface DataForSeoJobItem {
  type?: string
  rank_group?: number
  rank_absolute?: number
  title?: string
  employer_name?: string
  employer_logo?: string
  location?: string
  description?: string
  /** "2026-08-01 00:00:00 +00:00" */
  timestamp?: string | null
  /** "3 days ago" — present when Google gave a relative date instead. */
  time_ago?: string | null
  is_remote?: boolean | null
  employment_type?: string | string[] | null
  salary?: unknown
  job_id?: string | null
  url?: string | null
  apply_urls?: unknown
  apply_link?: unknown
  [k: string]: unknown
}

export interface DataForSeoResult {
  keyword?: string
  se_domain?: string
  location_code?: number
  language_code?: string
  check_url?: string
  datetime?: string
  items_count?: number
  items?: DataForSeoJobItem[] | null
}

export interface DataForSeoTask {
  id?: string
  status_code?: number
  status_message?: string
  cost?: number
  result_count?: number
  result?: DataForSeoResult[] | null
  data?: Record<string, unknown>
}

export interface DataForSeoEnvelope {
  version?: string
  status_code?: number
  status_message?: string
  cost?: number
  tasks_count?: number
  tasks_error?: number
  tasks?: DataForSeoTask[] | null
}

// ─── Building the task ───────────────────────────────────────────────────────

/** Round a wanted result count up to a whole billed page, then clamp to the cap. */
export function clampDepth(want: number | null | undefined, fallback = 100): number {
  const raw = Number.isFinite(want) && (want as number) > 0 ? (want as number) : fallback
  const pages = Math.ceil(raw / RESULTS_PER_PAGE)
  return Math.min(Math.max(pages, 1), MAX_DEPTH / RESULTS_PER_PAGE) * RESULTS_PER_PAGE
}

export function pagesFor(depth: number): number {
  return Math.ceil(depth / RESULTS_PER_PAGE)
}

export function estimateCostUsd(depth: number): number {
  return pagesFor(depth) * COST_PER_PAGE_USD
}

/**
 * The search phrase. Google Jobs is one text box, so the title terms are OR-ed
 * into it and the internship constraint is expressed as `employment_type`
 * rather than as words — that is the whole reason this provider was chosen.
 */
export function buildKeyword(input: DiscoverySearchInput): string {
  const terms = (input.titleTerms ?? []).map((t) => t.trim()).filter(Boolean)
  const parts: string[] = []
  if (input.query && input.query.trim()) parts.push(input.query.trim())
  if (terms.length) parts.push(terms.length === 1 ? terms[0] : `(${terms.join(' OR ')})`)
  const keyword = parts.join(' ').trim() || 'internship'
  return keyword.length > MAX_KEYWORD_CHARS ? keyword.slice(0, MAX_KEYWORD_CHARS).trimEnd() : keyword
}

export interface TaskOptions {
  depth?: number
  locationCode?: number
  languageCode?: string
  /** Null disables the filter entirely. Undefined takes the internship default. */
  employmentType?: string[] | null
  /** 1 = standard queue (the price this file quotes), 2 = priority. */
  priority?: 1 | 2
  tag?: string
}

/**
 * The `task_post` body: an ARRAY of task objects, which is how every DataForSEO
 * endpoint takes work. One task per call here — batching would make the cost
 * ledger lie about which query spent what.
 */
export function buildTaskPostBody(input: DiscoverySearchInput, opts: TaskOptions = {}): Record<string, unknown>[] {
  const depth = clampDepth(opts.depth ?? input.limit)
  const employmentType =
    opts.employmentType === null
      ? null
      : opts.employmentType ?? (input.internshipsOnly === false ? null : ['intern'])

  const task: Record<string, unknown> = {
    keyword: buildKeyword(input),
    language_code: opts.languageCode ?? 'en',
    depth,
  }
  // `location_name` when the caller named a place, `location_code` otherwise.
  // Sending both is an error on this API, so it is one or the other.
  if (input.location && input.location.trim()) task.location_name = input.location.trim()
  else task.location_code = opts.locationCode ?? DEFAULT_LOCATION_CODE
  if (employmentType && employmentType.length) task.employment_type = employmentType
  if (opts.priority) task.priority = opts.priority
  if (opts.tag) task.tag = opts.tag
  return [task]
}

// ─── Reading the result ──────────────────────────────────────────────────────

/** "2026-08-01 00:00:00 +00:00" → ISO. Anything unparseable is null, never a throw. */
export function parseDataForSeoTimestamp(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim()
  if (!s) return null
  const normalized = s.replace(' ', 'T').replace(/ ([+-]\d{2}):?(\d{2})$/, '$1:$2')
  const ms = Date.parse(normalized)
  if (Number.isFinite(ms)) return new Date(ms).toISOString()
  const plain = Date.parse(s)
  return Number.isFinite(plain) ? new Date(plain).toISOString() : null
}

function urlCandidates(item: DataForSeoJobItem): string[] {
  const out: string[] = []
  const push = (v: unknown): void => {
    if (typeof v === 'string' && /^https?:\/\//i.test(v.trim())) out.push(v.trim())
    else if (v && typeof v === 'object' && typeof (v as { url?: unknown }).url === 'string') push((v as { url: string }).url)
  }
  if (Array.isArray(item.apply_urls)) item.apply_urls.forEach(push)
  else push(item.apply_urls)
  push(item.apply_link)
  push(item.url)
  return out.filter((u, i, a) => a.indexOf(u) === i)
}

/**
 * Which link to keep. A Google Jobs card usually offers several "apply on X"
 * options; the one worth keeping is the employer's own ATS, because that is a
 * canonical URL, a dedupe key, and — through `atsFamilyFromUrl` — a free board
 * reference for tenant discovery. An aggregator link is taken only if nothing
 * better exists.
 */
export function pickApplyUrl(item: DataForSeoJobItem): { url: string | null; ats: AtsType | null } {
  const candidates = urlCandidates(item)
  // Preference order: a board on a recognised ATS, then any employer host, then
  // an aggregator link. The last is still worth keeping — a human can click it —
  // but it is not a canonical URL and `toRawPosting` will not treat it as one.
  let employerLink: string | null = null
  let aggregatorLink: string | null = null
  for (const u of candidates) {
    const fam = atsFamilyFromUrl(u)
    if (fam) {
      const adapted = ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'workday']
      return { url: u, ats: adapted.includes(fam.ats) ? (fam.ats as AtsType) : 'other' }
    }
    let host = ''
    try {
      host = new URL(u).hostname.toLowerCase()
    } catch {
      continue
    }
    if (isAggregatorHost(host)) aggregatorLink = aggregatorLink ?? u
    else employerLink = employerLink ?? u
  }
  return { url: employerLink ?? aggregatorLink, ats: null }
}

/**
 * One SERP item → one `RawJobPosting`. Returns null for anything without a
 * title and an employer, which is what a "related searches" row looks like.
 *
 * `source_type` is the interesting decision. `'aggregator'` is not a label, it
 * is a behaviour: scout/extract.ts NULLS `canonical_url` AND `apply_url` for a
 * posting whose sources are all aggregators, because a lead we never followed
 * must not claim a SERP page as its canonical posting. So a result that came
 * back with a first-party apply link is `'web_search'` — the link is real and
 * must survive — and one that came back with only a Google or LinkedIn link is
 * `'aggregator'`, which is exactly true of it.
 *
 * FIRST-PARTY IS THE OPPOSITE OF AGGREGATOR, NOT A SYNONYM FOR "RECOGNISED
 * ATS". `careers.merck.com/us/en/job/R123` is the employer's own posting on the
 * employer's own domain; that we have no adapter for whatever runs behind it
 * changes nothing about the link. Typing it `'aggregator'` because
 * `atsFamilyFromUrl` returned null would make extract.ts strip the apply URL
 * off a result the founder PAID for — and employer-hosted front ends are the
 * top of this corpus by volume (the live census puts lifeattiktok.com,
 * jobs.bytedance.com, www.tesla.com and amazon.jobs above every ATS host).
 * The test is `isAggregatorHost`, and only that.
 */
export function toRawPosting(item: DataForSeoJobItem, result: DataForSeoResult, retrievedAt: string): RawJobPosting | null {
  const title = (item.title ?? '').trim()
  const company = (item.employer_name ?? '').trim()
  if (!title || !company) return null

  const { url, ats } = pickApplyUrl(item)
  const serpUrl = (result.check_url ?? '').trim() || null
  const host = (() => {
    try {
      return url ? new URL(url).hostname.toLowerCase() : null
    } catch {
      return null
    }
  })()
  const firstParty = !!url && !!host && !isAggregatorHost(host)
  const sourceType: JobSourceType = firstParty ? 'web_search' : 'aggregator'
  // The apply host is usually the ATS, not the employer. Calling
  // `greenhouse.io` the company domain would poison company matching, so a
  // recognised ATS host contributes no domain at all.
  const domain = host && !ats && firstParty ? normalizeDomain(host) : null

  const description = typeof item.description === 'string' ? item.description.trim() : ''

  return {
    source_type: sourceType,
    source_url: url ?? serpUrl ?? 'https://www.google.com/search?ibp=htl;jobs',
    external_id: typeof item.job_id === 'string' && item.job_id ? item.job_id : null,
    company_name: company,
    company_domain: domain,
    title,
    location_raw: (item.location ?? '').trim() || null,
    description_text: description || null,
    description_html: null,
    department: null,
    posted_at: parseDataForSeoTimestamp(item.timestamp),
    updated_at: null,
    apply_url: url,
    canonical_url: firstParty ? url : null,
    ats_type: ats,
    ats_job_id: null,
    requisition_id: null,
    employment_type_hint: Array.isArray(item.employment_type)
      ? item.employment_type.join(', ') || null
      : typeof item.employment_type === 'string'
        ? item.employment_type
        : null,
    raw: {
      dataforseo: {
        job_id: item.job_id ?? null,
        rank_absolute: item.rank_absolute ?? null,
        is_remote: item.is_remote ?? null,
        salary: item.salary ?? null,
        time_ago: item.time_ago ?? null,
        apply_urls: urlCandidates(item),
        serp_url: serpUrl,
        keyword: result.keyword ?? null,
      },
    },
    retrieved_at: retrievedAt,
  }
}

// ─── The resumable cursor ────────────────────────────────────────────────────

/**
 * A queued task, addressable later. It carries the spend so far so that a
 * budget survives a process boundary: the run that resumes a cursor is often
 * not the run that posted the task.
 */
export interface DataForSeoCursor {
  v: 1
  task: string
  depth: number
  spentUsd: number
  postedAt: number
}

export function encodeCursor(c: DataForSeoCursor): string {
  return JSON.stringify(c)
}

export function decodeCursor(raw: string | null | undefined): DataForSeoCursor | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<DataForSeoCursor>
    if (parsed && parsed.v === 1 && typeof parsed.task === 'string' && parsed.task) {
      return {
        v: 1,
        task: parsed.task,
        depth: typeof parsed.depth === 'number' ? parsed.depth : RESULTS_PER_PAGE,
        spentUsd: typeof parsed.spentUsd === 'number' ? parsed.spentUsd : 0,
        postedAt: typeof parsed.postedAt === 'number' ? parsed.postedAt : 0,
      }
    }
  } catch {
    /* fall through */
  }
  return null
}

// ─── The source ──────────────────────────────────────────────────────────────

export interface DataForSeoSourceOptions {
  fetcher?: DataForSeoFetcher
  env?: EnvLike
  /** Hard ceiling on what this source may spend, in dollars, across its lifetime. */
  budgetUsd?: number | null
  /** Results to ask for per task. Rounded up to a page, clamped to 200. */
  depth?: number
  locationCode?: number
  languageCode?: string
  /** Stop polling and hand back a cursor after this long. Default 45 s. */
  deadlineMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  priority?: 1 | 2
  tag?: string
}

const CAPABILITIES: DiscoveryCapabilities = {
  // Not offset paging: the cursor resumes a QUEUED TASK. One task is one
  // answer of up to `depth` results, and `depth` is chosen before it is posted.
  paginates: true,
  supportsQuery: true,
  supportsLocation: true,
  // Google's `date_posted` filter is not exposed by this endpoint. Declaring
  // false means the planner filters `since` itself instead of trusting a
  // parameter that is silently ignored.
  supportsSince: false,
  // The advanced endpoint carries `description`, which is why it is worth its
  // price: a posting with a description skips a second fetch and clears
  // extraction's minimum-length gate.
  givesDescription: true,
  // Often true in practice — an "apply on Greenhouse" link IS canonical — but
  // never guaranteed for a given result. Under-promising costs one fetch;
  // over-promising loses postings.
  givesCanonicalUrl: false,
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function parseEnvelope(body: string): { env: DataForSeoEnvelope | null; error: string | null } {
  try {
    const parsed = JSON.parse(body) as DataForSeoEnvelope
    if (!parsed || typeof parsed !== 'object') return { env: null, error: 'unexpected response shape' }
    return { env: parsed, error: null }
  } catch (e) {
    return { env: null, error: `malformed JSON: ${errText(e)}` }
  }
}

function describeFailure(status: number, env: DataForSeoEnvelope | null, task: DataForSeoTask | null): string {
  const code = task?.status_code ?? env?.status_code ?? 0
  const message = task?.status_message ?? env?.status_message ?? `http ${status}`
  if (status === 401 || AUTH_CODES.includes(code)) {
    return `authentication or billing rejected (${code || status}): ${message} — check DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD and the account balance`
  }
  return `dataforseo ${code || status}: ${message}`
}

/**
 * The paid Google Jobs source.
 *
 * Construct it freely: nothing happens, and nothing is read from the network,
 * until `search` is called on a configured instance. An unconfigured instance
 * is inert by design — `isConfigured()` is false, the registry skips it, and a
 * `search` called on it anyway returns an empty, exhausted, ERROR-FREE result.
 * A missing optional key is not a failure of the run.
 */
export function dataForSeoSource(opts: DataForSeoSourceOptions = {}): JobDiscoverySource {
  const fetcher = opts.fetcher ?? defaultFetcher
  const now = opts.now ?? (() => Date.now())
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const env = opts.env ?? process.env
  const budgetUsd = opts.budgetUsd ?? null
  // Lifetime spend of THIS instance. The registry builds one per run, so this
  // is the run's spend at this source, and it is what the budget is measured
  // against.
  let spentUsd = 0

  const costModel: DiscoveryCostModel = {
    kind: 'per_request',
    // One request buys one 10-result page.
    unitCostUsd: COST_PER_PAGE_USD,
    envVar: 'DATAFORSEO_LOGIN',
  }

  const creds = (): DataForSeoCredentials | null => {
    try {
      return dataForSeoCredentials(env)
    } catch {
      return null
    }
  }

  const headers = (c: DataForSeoCredentials): Record<string, string> => ({
    authorization: basicAuth(c),
    'content-type': 'application/json',
    accept: 'application/json',
  })

  return {
    id: 'dataforseo',
    name: 'DataForSEO Google Jobs',
    sourceType: 'search',
    capabilities: CAPABILITIES,
    costModel,

    isConfigured(): boolean {
      return creds() !== null
    },

    async healthCheck(): Promise<DiscoveryHealth> {
      const c = creds()
      if (!c) return { ok: false, detail: 'DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD not set — the paid Google Jobs source is skipped' }
      try {
        const res = await fetcher({ method: 'GET', url: `${DATAFORSEO_BASE}${USER_DATA_PATH}`, headers: headers(c) })
        const { env: body, error } = parseEnvelope(res.body)
        if (!res.ok || error || (body?.status_code ?? 0) !== STATUS_OK) {
          return { ok: false, detail: describeFailure(res.status, body, null) }
        }
        const money = (body?.tasks?.[0]?.result as unknown as { money?: { balance?: number } }[] | undefined)?.[0]?.money
        const balance = typeof money?.balance === 'number' ? `$${money.balance.toFixed(2)} balance` : 'account reachable'
        return { ok: true, detail: `${balance} · $${COST_PER_PAGE_USD} per ${RESULTS_PER_PAGE} results` }
      } catch (e) {
        return { ok: false, detail: errText(e) }
      }
    },

    async search(input: DiscoverySearchInput, cursor?: string | null): Promise<DiscoverySearchResult> {
      const c = creds()
      if (!c) {
        // Silent skip. Not an error: the app is designed to run with no paid
        // provider, and colouring the run's error list for an absent optional
        // key would train the founder to ignore that list.
        return {
          postings: [],
          nextCursor: null,
          exhausted: true,
          seen: 0,
          note: 'DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD not set — skipped',
          costUsd: 0,
          requests: 0,
        }
      }

      // A per-call hint may only TIGHTEN the ceiling, never raise it.
      // `opts.budgetUsd` is the hard limit whoever constructed this source set;
      // `input.extra` is documented in discovery-types.ts as free-form and
      // "never load-bearing", which makes it exactly the wrong thing to let
      // overwrite the one number standing between a planner bug and an
      // unbounded bill. Taking the min means a caller can spend less than the
      // ceiling and can never spend more.
      const rawCallerBudget = input.extra?.budgetUsd
      const callerBudget = typeof rawCallerBudget === 'number' && Number.isFinite(rawCallerBudget) ? rawCallerBudget : null
      const budget =
        callerBudget !== null && budgetUsd !== null ? Math.min(callerBudget, budgetUsd) : callerBudget ?? budgetUsd
      let requests = 0
      let costUsd = 0

      const resume = decodeCursor(cursor)
      if (resume) spentUsd = Math.max(spentUsd, resume.spentUsd)

      let taskId = resume?.task ?? null
      let depth = resume?.depth ?? clampDepth(opts.depth ?? input.limit)
      let postedAt = resume?.postedAt ?? now()

      // ── Post the task, if we are not resuming one ──
      if (!taskId) {
        depth = clampDepth(opts.depth ?? input.limit)
        const projected = estimateCostUsd(depth)
        if (budget !== null && spentUsd + projected > budget + 1e-9) {
          // Refuse BEFORE spending. This is the only moment at which the answer
          // is still free, and an over-budget source is exhausted, not broken.
          return {
            postings: [],
            nextCursor: null,
            exhausted: true,
            seen: 0,
            note: `budget reached: $${spentUsd.toFixed(4)} spent, $${projected.toFixed(4)} more would exceed the $${budget.toFixed(4)} ceiling`,
            costUsd: 0,
            requests: 0,
          }
        }

        const body = buildTaskPostBody(input, {
          depth,
          locationCode: opts.locationCode,
          languageCode: opts.languageCode,
          priority: opts.priority,
          tag: opts.tag,
        })
        let res: DataForSeoResponse
        try {
          res = await fetcher({ method: 'POST', url: `${DATAFORSEO_BASE}${TASK_POST_PATH}`, body, headers: headers(c) })
        } catch (e) {
          return { postings: [], nextCursor: null, exhausted: true, seen: 0, error: `task_post failed: ${errText(e)}`, requests: 1, costUsd: 0 }
        }
        requests++
        const { env: envelope, error: parseError } = parseEnvelope(res.body)
        const task = envelope?.tasks?.[0] ?? null
        const created = (task?.status_code ?? 0) === STATUS_TASK_CREATED || (task?.status_code ?? 0) === STATUS_OK
        if (!res.ok || parseError || !task?.id || !created) {
          return {
            postings: [],
            nextCursor: null,
            exhausted: true,
            seen: 0,
            error: parseError ?? describeFailure(res.status, envelope, task),
            requests,
            costUsd: 0,
          }
        }
        taskId = task.id
        postedAt = now()
        // Prefer the cost the provider charged over our arithmetic; they are
        // the same number when nothing surprising happened, and when they
        // differ the invoice is right and we are wrong.
        const charged = typeof task.cost === 'number' ? task.cost : typeof envelope?.cost === 'number' ? envelope.cost : estimateCostUsd(depth)
        costUsd += charged
        spentUsd += charged
      }

      // ── Poll for it ──
      // The deadline is measured from NOW, not from `postedAt`: a cursor
      // resumed an hour later must get its own polling window, or it would
      // return the same cursor unexamined forever.
      const deadline = now() + (opts.deadlineMs ?? DEFAULT_DEADLINE_MS)
      let wait = FIRST_POLL_MS
      let lastNote = 'task queued'
      let polls = 0
      for (;;) {
        if (now() >= deadline) break
        if (polls >= MAX_POLLS) {
          lastNote = `${lastNote} (stopped after ${polls} polls)`
          break
        }
        polls++
        // `task_get` is free, so the last poll before the deadline is worth
        // making even when the wait has to be cut short to fit — but never
        // shorter than the first interval, so an injected no-op sleep cannot
        // spin.
        await sleep(Math.max(FIRST_POLL_MS, Math.min(wait, Math.max(0, deadline - now()))))
        let res: DataForSeoResponse
        try {
          res = await fetcher({ method: 'GET', url: `${DATAFORSEO_BASE}${TASK_GET_PATH}/${encodeURIComponent(taskId)}`, headers: headers(c) })
        } catch (e) {
          return {
            postings: [],
            nextCursor: encodeCursor({ v: 1, task: taskId, depth, spentUsd, postedAt }),
            exhausted: false,
            seen: 0,
            error: `task_get failed: ${errText(e)}`,
            requests,
            costUsd,
          }
        }
        requests++
        const { env: envelope, error: parseError } = parseEnvelope(res.body)
        const task = envelope?.tasks?.[0] ?? null
        const code = task?.status_code ?? envelope?.status_code ?? 0

        if (!parseError && NOT_READY_CODES.includes(code)) {
          lastNote = task?.status_message ?? 'task in queue'
          wait = Math.min(wait * POLL_BACKOFF, MAX_POLL_MS)
          continue
        }
        if (!res.ok || parseError || code !== STATUS_OK) {
          return {
            postings: [],
            // The task is paid for and retained for 30 days; an auth blip or a
            // transient 5xx should not throw the receipt away.
            nextCursor: encodeCursor({ v: 1, task: taskId, depth, spentUsd, postedAt }),
            exhausted: false,
            seen: 0,
            error: parseError ?? describeFailure(res.status, envelope, task),
            requests,
            costUsd,
          }
        }

        const results = task?.result ?? []
        const retrievedAt = new Date(now()).toISOString()
        const postings: RawJobPosting[] = []
        let seen = 0
        for (const result of results) {
          const items = result?.items ?? []
          seen += typeof result?.items_count === 'number' ? result.items_count : items.length
          for (const item of items) {
            if (item?.type && item.type !== 'google_jobs_search') continue
            const posting = toRawPosting(item, result ?? {}, retrievedAt)
            if (posting) postings.push(posting)
          }
        }
        return {
          postings,
          // One task is one complete answer: there is no page 2 to ask for.
          nextCursor: null,
          exhausted: true,
          seen,
          note: postings.length < seen ? `${seen - postings.length} SERP rows were not job cards` : undefined,
          requests,
          costUsd,
        }
      }

      // Deadline reached with the task still queued. Hand back a cursor rather
      // than holding the run open — the task is paid for and retrievable for
      // 30 days.
      return {
        postings: [],
        nextCursor: encodeCursor({ v: 1, task: taskId, depth, spentUsd, postedAt }),
        exhausted: false,
        seen: 0,
        note: `${lastNote} — resume with the cursor (DataForSEO retains results for 30 days)`,
        requests,
        costUsd,
      }
    },
  }
}
