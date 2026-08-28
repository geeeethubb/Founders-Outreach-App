import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { listJobs, type JobListRow, type ListJobsFilters } from '@/lib/career/jobs/store'
import { fitBand, type FitBand } from '@/lib/career/fit/dimensions'
import { APPLICATION_STATES, VERIFICATION_STATUSES, type ApplicationState, type Eligibility, type JobDisposition, type VerificationStatus } from '@/lib/career/types'

export const dynamic = 'force-dynamic'

export interface JobCard {
  id: string
  title: string
  company_name: string
  company_id: string | null
  location_raw: string | null
  location_tier: number | null
  work_mode: string
  employment_type: string
  season_relevance: string
  role_family: string | null
  posted_at: string | null
  deadline: string | null
  canonical_url: string | null
  apply_url: string | null
  ats_type: string | null
  verification_status: VerificationStatus
  verification_note: string | null
  last_verified_at: string | null
  fit_overall: number | null
  fit_band: FitBand | null
  fit_eligibility: Eligibility | null
  fit_explanation: string | null
  warm_path_count: number
  application_state: ApplicationState | null
  application_id: string | null
  disposition: JobDisposition
  first_seen_at: string
  source_types: string[]
}

type FitRow = { overall: number | null; eligibility: Eligibility | null; explanation: string | null; computed_at: string | null }

function toJobCard(row: JobListRow): JobCard {
  const fits = (row.fit as FitRow[] | undefined) ?? []
  const fit = [...fits].sort((a, b) => (b.computed_at ?? '').localeCompare(a.computed_at ?? ''))[0] ?? null
  const overall = row.fit_overall ?? fit?.overall ?? null
  const app = row.applications?.[0] ?? null
  return {
    id: row.id,
    title: row.title,
    company_name: row.company_name,
    company_id: row.company_id,
    location_raw: row.location_raw,
    location_tier: row.location_tier,
    work_mode: row.work_mode,
    employment_type: row.employment_type,
    season_relevance: row.season_relevance,
    role_family: row.role_family,
    posted_at: row.posted_at,
    deadline: row.deadline,
    canonical_url: row.canonical_url,
    apply_url: row.apply_url,
    ats_type: row.ats_type,
    verification_status: row.verification_status,
    verification_note: row.verification_note,
    last_verified_at: row.last_verified_at,
    fit_overall: overall,
    fit_band: overall == null ? null : fitBand(Number(overall)),
    fit_eligibility: row.fit_eligibility ?? fit?.eligibility ?? null,
    fit_explanation: fit?.explanation ?? null,
    warm_path_count: Number(row.warm_paths?.[0]?.count ?? 0),
    application_state: (app?.state as ApplicationState | undefined) ?? null,
    application_id: app?.id ?? null,
    disposition: row.disposition,
    first_seen_at: row.first_seen_at,
    source_types: sourceTypesOf(row),
  }
}

function sourceTypesOf(row: JobListRow): string[] {
  const out = new Set<string>()
  if (row.ats_type) out.add(row.ats_type)
  const sources = (row as unknown as { sources?: { source_type: string }[] }).sources
  for (const s of sources ?? []) out.add(s.source_type)
  return [...out]
}

const FRESHNESS: Record<string, VerificationStatus[] | undefined> = {
  verified: ['VERIFIED_OPEN'],
  likely: ['VERIFIED_OPEN', 'LIKELY_OPEN'],
  any: undefined,
}

/**
 * GET ?status=&tier=&role_family=&disposition=&minFit=&search=&freshness=verified|likely|any
 *     &hasWarmPath=1&state=<application state>&sort=fit|recent|deadline&limit=&offset=
 * → { jobs: JobCard[], total, filters: { role_families, tiers, statuses } }
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const p = new URL(request.url).searchParams
    const list = (k: string) => (p.get(k) ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const filters: ListJobsFilters = {}
    const statuses = list('status').filter((s): s is VerificationStatus => VERIFICATION_STATUSES.includes(s as VerificationStatus))
    const freshness = p.get('freshness')
    if (statuses.length) filters.status = statuses
    else if (freshness && FRESHNESS[freshness]) filters.status = FRESHNESS[freshness]
    const tiers = list('tier').map(Number).filter((n) => [1, 2, 3].includes(n))
    if (tiers.length) filters.tier = tiers
    const families = list('role_family')
    if (families.length) filters.role_family = families
    const dispositions = list('disposition').filter((d): d is JobDisposition => ['new', 'saved', 'dismissed'].includes(d))
    if (dispositions.length) filters.disposition = dispositions
    const minFit = Number(p.get('minFit'))
    if (p.get('minFit') && Number.isFinite(minFit)) filters.minFit = minFit
    if (p.get('search')) filters.search = p.get('search') as string
    const sort = p.get('sort')
    if (sort === 'fit' || sort === 'recent' || sort === 'deadline') filters.sort = sort
    filters.limit = Math.min(200, Math.max(1, Number(p.get('limit')) || 50))
    filters.offset = Math.max(0, Number(p.get('offset')) || 0)

    const hasWarmPath = p.get('hasWarmPath') === '1'
    const state = p.get('state')
    const wantState = state && APPLICATION_STATES.includes(state as ApplicationState) ? (state as ApplicationState) : null

    const res = await listJobs(user.id, filters)
    if (res.migrationMissing) return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true }, { status: 409 })
    if (res.error) return NextResponse.json({ error: res.error }, { status: 500 })

    // Warm-path and application-state filters are applied in memory: both live
    // on embedded rows PostgREST cannot filter the parent by. When either is
    // set, `total` is the count on this page, not across pages.
    let cards = res.jobs.map(toJobCard)
    const inMemory = hasWarmPath || wantState
    if (hasWarmPath) cards = cards.filter((c) => c.warm_path_count > 0)
    if (wantState) cards = cards.filter((c) => c.application_state === wantState)

    const db = createServiceClient()
    const { data: facets } = await db.from('job_opportunities').select('role_family, location_tier, verification_status').eq('user_id', user.id).eq('is_canonical', true).limit(2000)
    const rows = (facets ?? []) as { role_family: string | null; location_tier: number | null; verification_status: string }[]
    const uniq = <T,>(xs: (T | null)[]) => [...new Set(xs.filter((x): x is T => x != null))]

    return NextResponse.json({
      jobs: cards,
      total: inMemory ? cards.length : res.total ?? cards.length,
      filters: {
        role_families: uniq(rows.map((r) => r.role_family)).sort(),
        tiers: uniq(rows.map((r) => r.location_tier)).sort(),
        statuses: uniq(rows.map((r) => r.verification_status)).sort(),
      },
    })
  } catch (error) {
    if (isDynamicUsage(error)) throw error
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 })
  }
}
