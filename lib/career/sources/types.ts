// Job source adapters — the discovery surface abstraction.
//
// Discovery is never coupled to one job board. Every surface implements this
// interface; the scout and the company-first loop depend on the interface,
// never on Greenhouse or Lever by name. An unavailable adapter is skipped, not
// fatal (ARCHITECTURE §4, principle 8).
//
// What adapters must NOT do: log in, solve CAPTCHAs, ignore robots.txt, or
// fetch pages behind access controls. Public job-board APIs and public careers
// pages only. See docs/CAREER_OS.md §5.

import type { AtsType, JobSourceType } from '../types'

/** A posting exactly as a source returned it, before normalization. */
export interface RawJobPosting {
  source_type: JobSourceType
  /** Where THIS copy was seen. */
  source_url: string
  /** The source's own id for the posting, when it has one. */
  external_id: string | null

  company_name: string
  company_domain: string | null

  title: string
  location_raw: string | null
  /** Plain text. Adapters strip HTML; description_html keeps the original when available. */
  description_text: string | null
  description_html: string | null
  department: string | null

  posted_at: string | null       // ISO
  updated_at: string | null      // ISO
  /** The link a candidate would apply through. Often equals canonical_url. */
  apply_url: string | null
  /** The first-party URL for this posting, if the source knows it. */
  canonical_url: string | null

  ats_type: AtsType | null
  ats_job_id: string | null
  requisition_id: string | null
  /** A cheap hint from the source's own metadata ("Intern", "Internship"). */
  employment_type_hint: string | null

  raw: Record<string, unknown>
  retrieved_at: string
}

/** Identity of one company's board on one ATS. */
export interface AtsBoardRef {
  ats: AtsType
  /** Greenhouse board token, Lever site name, Ashby org name, SmartRecruiters company id, Workable subdomain. */
  identifier: string
  company_name?: string
  /** The public board URL, for display and for the careers_url column. */
  board_url?: string
}

export type PostingFetchStatus = 'open' | 'closed' | 'not_found' | 'error'

export interface PostingFetchResult {
  status: PostingFetchStatus
  posting: RawJobPosting | null
  /** Human-readable reason, surfaced in verification_note. */
  note: string
  error?: string
}

export interface ListPostingsOptions {
  /** Keep only postings whose title/metadata suggests an internship. Default false. */
  internshipsOnly?: boolean
  /** Cap on postings returned after filtering. */
  limit?: number
}

export interface ListPostingsResult {
  postings: RawJobPosting[]
  /** Postings the board returned before any filtering. */
  total_on_board: number
  board_url: string | null
  error?: string
  /** Never throw for an expected condition — say what happened. */
  note?: string
}

export interface UrlMatch {
  board: AtsBoardRef
  /** Set when the URL points at one posting rather than the board. */
  jobId: string | null
}

/**
 * One ATS. All methods are deterministic HTTP + parsing. Results are cached by
 * the caller through lib/providers/cache.ts keyed on the board identity.
 */
export interface JobSourceAdapter {
  readonly id: AtsType
  readonly source_type: JobSourceType
  /** False when the adapter is disabled by env. Public APIs need no key. */
  isAvailable(): boolean
  /**
   * Recognize a URL that belongs to this ATS and extract the board identity
   * (and the job id when the URL is a single posting). Pure, no network.
   */
  matchUrl(url: string): UrlMatch | null
  /**
   * Guess the board identity for a company from its name / domain and confirm
   * it exists with one request. Null when no board is found. Must not spray
   * dozens of requests — a handful of slug candidates at most.
   */
  detectBoard(input: { companyName: string; domain?: string | null; careersUrl?: string | null }): Promise<AtsBoardRef | null>
  listPostings(board: AtsBoardRef, options?: ListPostingsOptions): Promise<ListPostingsResult>
  /** Fetch one posting by id. The freshness primitive: `not_found` on an ATS is CLOSED. */
  fetchPosting(board: AtsBoardRef, externalId: string): Promise<PostingFetchResult>
}

// ─── Page fetching (careers pages, aggregator leads) ─────────────────────────

export interface FetchedPage {
  url: string
  final_url: string
  status: number
  /** Visible text with scripts/styles removed, whitespace collapsed, capped. */
  text: string
  title: string | null
  /** Absolute links found on the page. */
  links: string[]
  /** Set when robots.txt disallowed the fetch. The page is NOT fetched. */
  robots_blocked: boolean
  error?: string
  retrieved_at: string
}

export interface PageFetcher {
  fetch(url: string, opts?: { maxBytes?: number; timeoutMs?: number }): Promise<FetchedPage>
}

// ─── Careers page discovery ──────────────────────────────────────────────────

export interface CareersPageScan {
  careers_url: string | null
  /** ATS boards linked from the page, in confidence order. */
  boards: AtsBoardRef[]
  /** Posting links found directly on the page when no ATS is detected. */
  posting_links: { url: string; text: string }[]
  /** Text hints: "we're not hiring interns", "Summer 2027", … */
  hints: string[]
  fetched: FetchedPage | null
  error?: string
}

// ─── Registry ────────────────────────────────────────────────────────────────

export interface SourceRegistry {
  adapters(): JobSourceAdapter[]
  byId(id: AtsType): JobSourceAdapter | null
  /** First adapter whose matchUrl recognizes the URL. */
  matchUrl(url: string): { adapter: JobSourceAdapter; match: UrlMatch } | null
}
