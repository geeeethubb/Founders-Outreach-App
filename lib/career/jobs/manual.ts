// Manual entry: the user pastes a posting URL and the system resolves,
// extracts, verifies and stores it.
//
// This is the sanctioned path for platforms we refuse to read (LinkedIn,
// Indeed, Glassdoor, Handshake — docs/CAREER_OS.md §5): the user opens the
// posting there and pastes the company's own link. Hard constraints are
// REPORTED, not enforced — a job the user added by hand is the user's call,
// and a silent refusal would look like a bug. The constraint failures come
// back as warnings instead.

import { jobExtractorPrompt, runJobExtractor } from '@/lib/agents/job-extractor'
import type { ToolContext } from '@/lib/agents/runtime/types'
import type { CareerRun } from '../runs'
import { constraintRejections, type ExtractorFn, MIN_EXTRACT_CHARS } from '../scout/extract'
import { getPageFetcher, isExcludedHost } from '../sources/fetch'
import { getSourceRegistry, matchAnyAtsUrl } from '../sources/registry'
import type { PageFetcher, RawJobPosting, SourceRegistry } from '../sources/types'
import type { CareerMission } from '../types'
import { buildNormalizedJob, type NormalizedJob } from './normalize'
import { setDisposition, upsertJobs, type UpsertJobsResult } from './store'
import { verifyWithAgent, type VerifierFn } from './verify-batch'

export const EXCLUDED_PLATFORM_MESSAGE = 'This platform cannot be read directly. Open the posting and paste the company careers/ATS link instead.'

export interface AddJobDeps {
  registry?: SourceRegistry
  fetcher?: PageFetcher
  extractor?: ExtractorFn
  verifier?: VerifierFn
  upsertJobs?: (userId: string, jobs: NormalizedJob[], opts: { runId?: string | null; missionId?: string | null }) => Promise<UpsertJobsResult>
  setDisposition?: typeof setDisposition
}

export interface AddJobOptions {
  mission: Pick<CareerMission, 'id' | 'hard_constraints' | 'preferences'> | null
  ctx: ToolContext
  run?: Pick<CareerRun, 'trace' | 'runId'> | null
  verify?: boolean
}

export interface AddJobResult {
  jobId: string | null
  job: Pick<NormalizedJob, 'title' | 'company_name' | 'location_raw' | 'location_tier' | 'employment_type' | 'season_relevance' | 'verification_status' | 'verification_note' | 'canonical_url'> | null
  warnings: string[]
  error: string | null
  migrationMissing: boolean
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/** Company name guess from a hostname: careers.acme.com → Acme. */
function companyFromHost(host: string): string {
  const parts = host.replace(/^www\./, '').split('.')
  const label = parts.length >= 3 && /^(co|com|org|net)$/.test(parts[parts.length - 2]) ? parts[parts.length - 3] : parts[parts.length - 2] ?? parts[0]
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : host
}

export async function addJobFromUrl(userId: string, url: string, opts: AddJobOptions, deps: AddJobDeps = {}): Promise<AddJobResult> {
  const registry = deps.registry ?? getSourceRegistry()
  const fetcher = deps.fetcher ?? getPageFetcher()
  const warnings: string[] = []
  const done = (error: string): AddJobResult => ({ jobId: null, job: null, warnings, error, migrationMissing: false })

  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    return done('not a valid http(s) URL')
  }
  if (!/^https?:$/.test(parsed.protocol)) return done('not a valid http(s) URL')
  if (isExcludedHost(parsed.toString())) return done(EXCLUDED_PLATFORM_MESSAGE)

  // 1. Resolve to a raw posting.
  let raw: RawJobPosting | null = null
  let atsClosed = false
  const m = registry.matchUrl(parsed.toString())
  if (m) {
    if (!m.match.jobId) return done('that is a job board URL, not a single posting — paste the link to one job')
    const res = await m.adapter.fetchPosting(m.match.board, m.match.jobId)
    if (!res.posting) return done(`${m.adapter.id}: ${res.note}`)
    raw = res.posting
    // The ATS is the strongest freshness signal we have (verify.ts): a posting
    // it reports closed is stored CLOSED, never vouched for as open.
    atsClosed = res.status === 'closed'
    if (atsClosed) warnings.push(`the ATS reports this posting as closed`)
  } else {
    const page = await fetcher.fetch(parsed.toString())
    if (page.robots_blocked) return done(`the page cannot be read (${page.error ?? 'robots'}); paste the ATS link if there is one`)
    if (page.error || page.status < 200 || page.status >= 300) return done(`could not read the page: ${page.error ?? `http ${page.status}`}`)
    const other = matchAnyAtsUrl(parsed.toString())
    const title = (page.title ?? '').replace(/\s*[|\-–—]\s*[^|\-–—]*$/, '').trim() || page.title || 'Untitled posting'
    raw = {
      source_type: other ? 'careers_page' : 'manual',
      source_url: parsed.toString(),
      external_id: null,
      company_name: companyFromHost(hostOf(page.final_url || parsed.toString())),
      company_domain: null,
      title,
      location_raw: null,
      description_text: page.text || null,
      description_html: null,
      department: null,
      posted_at: null,
      updated_at: null,
      apply_url: page.final_url || parsed.toString(),
      canonical_url: page.final_url || parsed.toString(),
      ats_type: other ? 'other' : null,
      ats_job_id: null,
      requisition_id: null,
      employment_type_hint: null,
      raw: { manual: true, page_title: page.title, ats_family: other?.family ?? null },
      retrieved_at: page.retrieved_at,
    }
    if (!page.text || page.text.length < MIN_EXTRACT_CHARS) warnings.push('the page carried little readable text; fields may be thin')
  }

  // 2. Extract, when there is enough text to extract from.
  let extraction = null
  if ((raw.description_text ?? '').length >= MIN_EXTRACT_CHARS) {
    const extractor = deps.extractor ?? runJobExtractor
    const res = await extractor({ title: raw.title, company: raw.company_name, location_raw: raw.location_raw, text: raw.description_text ?? '', source_hint: raw.employment_type_hint }, opts.ctx)
    await opts.run?.trace(res, { url: parsed.toString(), manual: true })
    if (res.output) extraction = res.output
    else warnings.push(`extraction ${res.status}: ${res.error ?? 'no output'}`)
  }

  // 3. Normalize; constraints are warnings here.
  const job = buildNormalizedJob(raw, extraction, { geo_tiers: opts.mission?.preferences.geo_tiers })
  if (extraction) job.extraction_version = jobExtractorPrompt.version
  if (opts.mission) for (const f of constraintRejections(job, opts.mission.hard_constraints)) warnings.push(`fails "${f.label}": ${f.reason}`)
  if (job.verification_status === 'CLOSED') warnings.push('the posting text says the role is closed')
  if (atsClosed && job.verification_status !== 'CLOSED') {
    job.verification_status = 'CLOSED'
    job.verification_method = 'ats_api'
    job.verification_note = 'the company ATS reports this posting as closed'
    job.last_verified_at = new Date().toISOString()
  }

  // 4. Verify.
  if (opts.verify !== false && job.verification_status !== 'CLOSED') {
    if (m) {
      job.verification_status = 'VERIFIED_OPEN'
      job.verification_method = 'ats_api'
      job.verification_note = 'fetched from the company ATS'
    } else {
      const v = await verifyWithAgent(job, { registry, fetcher, ctx: opts.ctx, verifier: deps.verifier, run: opts.run })
      job.verification_status = v.status === 'AMBIGUOUS' ? 'UNVERIFIED' : v.status
      job.verification_method = v.method
      job.verification_note = v.note
    }
    job.last_verified_at = new Date().toISOString()
  }

  // 5. Persist. A manually added job is the user's, so it is saved, not 'new'
  // (the store inserts every row as 'new'; disposition is a separate write).
  const up = await (deps.upsertJobs ?? upsertJobs)(userId, [job], { runId: opts.run?.runId ?? null, missionId: opts.mission?.id ?? null })
  if (up.migrationMissing) return { jobId: null, job: null, warnings, error: 'migration 014_career_os.sql has not been applied', migrationMissing: true }
  if (!up.ids.length) return done(up.errors[0] ?? 'could not store the job')
  const disp = await (deps.setDisposition ?? setDisposition)(userId, up.ids[0], 'saved')
  if (disp.error) warnings.push(`could not mark saved: ${disp.error}`)
  return {
    jobId: up.ids[0],
    job: {
      title: job.title, company_name: job.company_name, location_raw: job.location_raw, location_tier: job.location_tier, employment_type: job.employment_type,
      season_relevance: job.season_relevance, verification_status: job.verification_status, verification_note: job.verification_note, canonical_url: job.canonical_url,
    },
    warnings: [...warnings, ...up.errors],
    error: null,
    migrationMissing: false,
  }
}
