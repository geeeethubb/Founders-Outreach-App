// The two client-side tools the Job Scout has, besides server-side web search.
//
// Both are INJECTED as functions. The scout never imports an ATS adapter or a
// page fetcher — the orchestrator supplies real ones (lib/career/sources/*),
// the tests supply stubs, and the agent cannot tell the difference. That is
// the same seam as NetworkSearchFn in network-retrieval/tool.ts, for the same
// reason: the agent's judgment has to be measurable without the network.
//
// What the tools enforce, deterministically: per-session caps, a record of
// every call, and the URL pool. Every URL a tool returns goes into `seen`,
// and validate() in index.ts refuses any posting whose URL is in neither the
// web-search evidence pool nor that set. A posting URL the model merely typed
// is a fabrication by construction.

import type { AgentTool, ToolOutcome } from '../runtime/types'

export interface BoardPostingSummary {
  title: string
  location: string | null
  url: string
  external_id: string | null
  posted_at: string | null
  /** A cheap hint from the board's own metadata — "Intern", "Summer 2027". */
  hint: string | null
}

export interface LookupBoardResult {
  found: boolean
  ats: string | null
  board_url: string | null
  postings: BoardPostingSummary[]
  total_on_board: number
  note: string
}

/** Detect a company's ATS and list matching postings. Deterministic; W2 owns the implementation. */
export type LookupBoardFn = (input: {
  company_name: string
  domain?: string | null
  careers_url?: string | null
  internships_only?: boolean
}) => Promise<LookupBoardResult>

export interface FetchPageResult {
  ok: boolean
  status: number
  title: string | null
  /** Visible text. The tool caps it before it reaches the model. */
  text: string
  links: string[]
  note: string
}

/** Bounded, robots-aware, text-only page fetch. W2 owns the implementation. */
export type FetchPageFn = (url: string) => Promise<FetchPageResult>

export interface ScoutToolLogEntry {
  tool: 'lookup_ats_board' | 'fetch_page'
  args: Record<string, unknown>
  ok: boolean
  summary: string
  elapsedMs: number
}

export interface LookupBoardArgs {
  company_name: string
  domain?: string | null
  careers_url?: string | null
  internships_only?: boolean
}

export interface FetchPageArgs {
  url: string
}

/** Text a fetched page may inject into the prompt. Tool results re-enter the context every turn. */
export const FETCH_TEXT_CAP = 6000
const MAX_LINKS = 40
const MAX_POSTINGS = 40

function httpUrl(u: string): string | null {
  try {
    const p = new URL(u)
    return p.protocol === 'http:' || p.protocol === 'https:' ? p.toString() : null
  } catch {
    return null
  }
}

/**
 * Built per session so the caller keeps the log and the URL pool.
 *
 * `seen` is the pool: every posting URL, board URL and page link any tool
 * returned. The orchestrator resolves submitted postings against it and never
 * trusts a URL the model echoed back.
 */
export function buildScoutTools(opts: {
  lookupBoard: LookupBoardFn
  fetchPage: FetchPageFn
  seen: Set<string>
  log: ScoutToolLogEntry[]
  maxLookups: number
  maxFetches: number
  onCall?: (entry: ScoutToolLogEntry) => void
}): AgentTool<never>[] {
  const count = (tool: ScoutToolLogEntry['tool']) => opts.log.filter((e) => e.tool === tool).length

  const record = (entry: ScoutToolLogEntry): void => {
    opts.log.push(entry)
    opts.onCall?.(entry)
  }

  const lookup: AgentTool<LookupBoardArgs> = {
    name: 'lookup_ats_board',
    description:
      "Detect a company's applicant-tracking system (Greenhouse, Lever, Ashby, SmartRecruiters, Workable) and list " +
      'its current postings — internships only by default. This is the AUTHORITATIVE source for whether a company ' +
      'has an internship open right now; a search-result snippet is not. Use it on every company a search result ' +
      'mentions that looks relevant. found=false means no public board was detected, not that there is no job.',
    input_schema: {
      type: 'object',
      properties: {
        company_name: { type: 'string' },
        domain: { type: ['string', 'null'], description: 'Web domain if you know it, e.g. "example.com". Improves detection.' },
        careers_url: { type: ['string', 'null'], description: 'A careers-page URL you saw, if any. The board is often linked from it.' },
        internships_only: { type: 'boolean', description: 'Default true. Set false only to check whether the board is alive at all.' },
      },
      required: ['company_name'],
    },
    async execute(args): Promise<ToolOutcome> {
      const name = String(args.company_name ?? '').trim()
      if (!name) return { ok: false, result: { error: 'company_name is required' }, summary: 'lookup: missing company_name' }
      if (count('lookup_ats_board') >= opts.maxLookups) {
        return {
          ok: false,
          result: { error: `Board lookup budget exhausted (${opts.maxLookups}). Submit what you have.` },
          summary: 'lookup budget exhausted',
        }
      }
      const startedAt = Date.now()
      let res: LookupBoardResult
      try {
        res = await opts.lookupBoard({
          company_name: name,
          domain: typeof args.domain === 'string' ? args.domain : null,
          careers_url: typeof args.careers_url === 'string' ? args.careers_url : null,
          internships_only: args.internships_only !== false,
        })
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        record({ tool: 'lookup_ats_board', args: { company_name: name }, ok: false, summary: `failed: ${message.slice(0, 80)}`, elapsedMs: Date.now() - startedAt })
        return { ok: false, result: { error: `lookup failed: ${message.slice(0, 200)}` }, summary: `lookup ${name}: failed` }
      }

      // An adapter that omits the array is a broken adapter, not a reason to
      // fail the round; the note still tells the model what happened.
      const postings = (Array.isArray(res.postings) ? res.postings : []).slice(0, MAX_POSTINGS)
      for (const p of postings) {
        const u = httpUrl(p.url)
        if (u) opts.seen.add(u)
      }
      if (res.board_url) {
        const u = httpUrl(res.board_url)
        if (u) opts.seen.add(u)
      }

      const summary = res.found
        ? `lookup ${name}: ${res.ats ?? 'board'} · ${postings.length} matching of ${res.total_on_board}`
        : `lookup ${name}: no board`
      record({ tool: 'lookup_ats_board', args: { company_name: name, domain: args.domain ?? null }, ok: true, summary, elapsedMs: Date.now() - startedAt })

      return {
        ok: true,
        result: {
          found: res.found,
          ats: res.ats,
          board_url: res.board_url,
          total_on_board: res.total_on_board,
          matching: postings.length,
          lookups_left: opts.maxLookups - count('lookup_ats_board'),
          note: res.note,
          // One line per posting. Forty JSON objects would burn the context the
          // model needs to judge them.
          postings: postings.map(
            (p) =>
              `${p.title} | ${p.location ?? 'location n/a'} | ${p.url}` +
              (p.posted_at ? ` | posted ${p.posted_at.slice(0, 10)}` : '') +
              (p.hint ? ` | ${p.hint}` : '')
          ),
        },
        summary,
      }
    },
  }

  const fetch: AgentTool<FetchPageArgs> = {
    name: 'fetch_page',
    description:
      'Fetch one public page as plain text (careers pages, a posting, an aggregator lead). Bounded and robots-aware; ' +
      'pages behind a login are not fetched. Use it to resolve an aggregator result to the first-party posting, or to ' +
      'read a careers page when no ATS board was detected. Returns the visible text (capped) and the links on the page.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'An http(s) URL you saw in a search result or a tool result.' } },
      required: ['url'],
    },
    async execute(args): Promise<ToolOutcome> {
      const url = httpUrl(String(args.url ?? ''))
      if (!url) return { ok: false, result: { error: 'url must be an http(s) URL' }, summary: 'fetch: bad url' }
      if (count('fetch_page') >= opts.maxFetches) {
        return {
          ok: false,
          result: { error: `Page fetch budget exhausted (${opts.maxFetches}). Submit what you have.` },
          summary: 'fetch budget exhausted',
        }
      }
      const startedAt = Date.now()
      let res: FetchPageResult
      try {
        res = await opts.fetchPage(url)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        record({ tool: 'fetch_page', args: { url }, ok: false, summary: `failed: ${message.slice(0, 80)}`, elapsedMs: Date.now() - startedAt })
        return { ok: false, result: { error: `fetch failed: ${message.slice(0, 200)}` }, summary: `fetch ${url.slice(0, 60)}: failed` }
      }

      // The page was really retrieved, so its URL and its links are citable.
      opts.seen.add(url)
      const links = (Array.isArray(res.links) ? res.links : []).map(httpUrl).filter((l): l is string => l !== null).slice(0, MAX_LINKS)
      for (const l of links) opts.seen.add(l)

      const text = res.text.length > FETCH_TEXT_CAP ? `${res.text.slice(0, FETCH_TEXT_CAP)}\n…[truncated]` : res.text
      const summary = `fetch ${url.slice(0, 60)}: ${res.status}${res.ok ? '' : ' (not ok)'} · ${res.text.length} chars`
      record({ tool: 'fetch_page', args: { url }, ok: res.ok, summary, elapsedMs: Date.now() - startedAt })

      return {
        ok: res.ok,
        result: {
          status: res.status,
          title: res.title,
          note: res.note,
          fetches_left: opts.maxFetches - count('fetch_page'),
          text,
          links,
        },
        summary,
      }
    },
  }

  return [lookup as never, fetch as never]
}
