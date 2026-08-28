// Freshness verification — an HTTP call and a string match, reproducible by
// construction (docs/CAREER_OS.md §5 "Freshness").
//
// ATS presence is the strongest signal we have: a Greenhouse 404 means the
// job is gone. A careers page is weaker: 404 is CLOSED, an explicit banner is
// CLOSED, the title still on the page is LIKELY_OPEN, and anything else is
// AMBIGUOUS — the one case where the caller may ask the Job Verifier agent.
// The agent never sees the clear cases.

import type { JobOpportunity, VerificationStatus } from '../types'
import type { PageFetcher, RawJobPosting, SourceRegistry } from '../sources/types'
import type { NormalizedJob } from './normalize'

export const CLOSED_PHRASES = [
  'no longer accepting applications',
  'this position has been filled',
  'job is no longer available',
  'this job has closed',
  'no longer available',
  'position closed',
  'position has closed',
  'this job is closed',
  'job has expired',
  'posting has expired',
  'expired',
  'this job is no longer open',
  'sorry, this job',
  'job not found',
  "the job you're looking for",
  'the job you are looking for',
]

export type VerifyStatus = VerificationStatus | 'AMBIGUOUS'

export interface VerifyResult {
  status: VerifyStatus
  note: string
  method: 'ats_api' | 'page' | 'none'
  posting?: RawJobPosting | null
  closedSignals: string[]
  /** Page text when the outcome is AMBIGUOUS, for the agent. */
  pageText?: string
}

export interface VerifyDeps {
  registry: SourceRegistry
  fetcher: PageFetcher
  now?: Date
  staleDays?: number
}

type VerifiableJob = Pick<JobOpportunity, 'title' | 'ats_type' | 'ats_job_id' | 'canonical_url' | 'apply_url' | 'verification_status'> & {
  company_name?: string
}

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'for', 'in', 'to', 'at', 'on', 'with', 'intern', 'internship', 'summer', 'fall', 'spring', 'winter', 'co', 'op', 'us', 'remote'])

/** Title words that carry meaning — the ones a still-open page would repeat. */
export function titleContentWords(title: string): string[] {
  return [...new Set(title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w) && !/^20\d\d$/.test(w)))]
}

export function closedSignalsIn(text: string): string[] {
  const lower = text.toLowerCase()
  return CLOSED_PHRASES.filter((p) => lower.includes(p))
}

export function titleCoverage(title: string, text: string): number {
  const words = titleContentWords(title)
  if (!words.length) return 0
  const lower = text.toLowerCase()
  const hit = words.filter((w) => new RegExp(`\\b${w}\\b`).test(lower)).length
  return hit / words.length
}

export async function verifyJob(job: VerifiableJob, deps: VerifyDeps): Promise<VerifyResult> {
  // 1. ATS id → adapter. The strongest signal, and one JSON call.
  if (job.ats_type && job.ats_job_id && job.ats_type !== 'other') {
    const adapter = deps.registry.byId(job.ats_type as Parameters<SourceRegistry['byId']>[0])
    if (adapter) {
      const boardMatch = job.canonical_url ? adapter.matchUrl(job.canonical_url) : null
      const identifier = boardMatch?.board.identifier
      if (identifier) {
        const res = await adapter.fetchPosting({ ats: adapter.id, identifier, company_name: job.company_name }, job.ats_job_id)
        if (res.status === 'open') return { status: 'VERIFIED_OPEN', note: res.note, method: 'ats_api', posting: res.posting, closedSignals: [] }
        if (res.status === 'not_found' || res.status === 'closed') return { status: 'CLOSED', note: res.note, method: 'ats_api', posting: res.posting, closedSignals: [res.status] }
        return { status: 'ERROR', note: res.note, method: 'ats_api', posting: null, closedSignals: [] }
      }
    }
  }

  // 2. A page we can read.
  const url = job.canonical_url ?? job.apply_url
  if (!url) return { status: 'ERROR', note: 'no url to verify against', method: 'none', closedSignals: [] }
  const page = await deps.fetcher.fetch(url)
  if (page.robots_blocked) {
    return { status: job.verification_status, note: `could not verify: robots (${page.error ?? 'blocked'})`, method: 'page', closedSignals: [] }
  }
  if (page.status === 404 || page.status === 410) return { status: 'CLOSED', note: `page returned ${page.status}`, method: 'page', closedSignals: [`http ${page.status}`] }
  if (page.error || page.status < 200 || page.status >= 300) {
    return { status: 'ERROR', note: `fetch failed: ${page.error ?? `http ${page.status}`}`, method: 'page', closedSignals: [] }
  }
  const signals = closedSignalsIn(`${page.title ?? ''}\n${page.text}`)
  if (signals.length) return { status: 'CLOSED', note: `page says: "${signals[0]}"`, method: 'page', closedSignals: signals }
  const coverage = titleCoverage(job.title, `${page.title ?? ''}\n${page.text}`)
  if (coverage >= 0.6) return { status: 'LIKELY_OPEN', note: `page is 200 and carries the title (${Math.round(coverage * 100)}% of title words)`, method: 'page', closedSignals: [] }
  return {
    status: 'AMBIGUOUS',
    note: `page is 200 but the title is not clearly present (${Math.round(coverage * 100)}% of title words)`,
    method: 'page',
    closedSignals: [],
    pageText: page.text.slice(0, 6000),
  }
}

/** A job unconfirmed for longer than the window is STALE — unless it is already CLOSED. */
export function applyStaleness<T extends Pick<JobOpportunity, 'verification_status' | 'last_verified_at'>>(job: T, now = new Date(), staleDays = 14): T['verification_status'] {
  if (job.verification_status === 'CLOSED') return job.verification_status
  if (!job.last_verified_at) return job.verification_status
  const age = now.getTime() - new Date(job.last_verified_at).getTime()
  if (age > staleDays * 24 * 3600 * 1000) return 'STALE'
  return job.verification_status
}

export type { NormalizedJob }
