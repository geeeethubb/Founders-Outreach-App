import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { isDynamicUsage } from '@/lib/http/dynamic'
import { isMissingSchema, listJobs, type JobListRow } from '@/lib/career/jobs/store'
import { listMissions } from '@/lib/career/missions/store'
import {
  relevanceContext,
  relevanceHeadline,
  scoreRelevance,
  type InboxRelevance,
  type RelevanceContext,
  type RelevanceFilter,
} from '@/lib/career/jobs/inbox-relevance'
import { fetchJobRows, orderInbox, type CensusFilters, type InboxSort, type InboxView } from './inbox'
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
  /** The application's current package, if one was ever generated. Tracking alone leaves it null. */
  package_id: string | null
  /** The newest verdict the user recorded on this job, so a reload does not look unrecorded. */
  last_verdict: string | null
  disposition: JobDisposition
  first_seen_at: string
  source_types: string[]
  /**
   * Has the Job Extractor ever read this posting? After a board sweep most rows
   * are listing-only, and a card that renders empty extracted fields as if they
   * were findings is lying about what is known.
   */
  extracted: boolean
  /** Where this posting sits against the stated direction — computed now, stored nowhere. */
  relevance: InboxRelevance | null
}

type FitRow = { overall: number | null; eligibility: Eligibility | null; explanation: string | null; computed_at: string | null }

function toJobCard(row: JobListRow, relevance: InboxRelevance | null): JobCard {
  const fits = (row.fit as FitRow[] | undefined) ?? []
  const fit = [...fits].sort((a, b) => (b.computed_at ?? '').localeCompare(a.computed_at ?? ''))[0] ?? null
  const overall = row.fit_overall ?? fit?.overall ?? null
  const app = row.applications?.[0] ?? null
  const lastFeedback = [...(row.feedback ?? [])].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))[0] ?? null
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
    package_id: app?.current_package_id ?? null,
    last_verdict: lastFeedback?.verdict ?? null,
    disposition: row.disposition,
    first_seen_at: row.first_seen_at,
    source_types: sourceTypesOf(row),
    extracted: !!row.extraction_version,
    relevance,
  }
}

function sourceTypesOf(row: JobListRow): string[] {
  const out = new Set<string>()
  if (row.ats_type) out.add(row.ats_type)
  const sources = (row as unknown as { sources?: { source_type: string }[] }).sources
  for (const s of sources ?? []) out.add(s.source_type)
  return [...out]
}

/** The active mission's direction, compiled once per request. A missing mission scores nothing as off. */
async function contextFor(userId: string): Promise<RelevanceContext> {
  const { missions } = await listMissions(userId)
  const mission = missions.find((m) => m.status === 'active') ?? missions[0] ?? null
  return relevanceContext(mission)
}

// ─── One run's jobs ──────────────────────────────────────────────────────────
//
// `?run=<id>` is a different question from the inbox's. The inbox curates —
// open, relevant, not dismissed — which is right for daily use and wrong for
// "what did that run find?": an off-direction, unverified or unranked posting
// from the run is exactly what the founder wants to see. So this path applies
// NO defaults and NO relevance filtering; it only ATTACHES the band, so a run
// that swept 300 postings can still be read at a glance.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function jobsForRun(userId: string, runId: string, limit: number, offset: number): Promise<NextResponse> {
  if (!UUID.test(runId)) return NextResponse.json({ error: 'run must be a run id' }, { status: 400 })
  const res = await listJobs(userId, { runId, limit, offset })
  if (res.migrationMissing) return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true }, { status: 409 })
  if (res.error) return NextResponse.json({ error: res.error }, { status: 500 })

  const ctx = await contextFor(userId)
  const cards = res.jobs.map((row) => toJobCard(row, scoreRelevance(row, ctx)))
  const touched = (res.total ?? cards.length) + (res.truncated ?? 0)
  return NextResponse.json({
    jobs: cards,
    // Every job the run touched, not the size of this page.
    total: touched,
    filters: { role_families: [], tiers: [], statuses: [] },
    direction: ctx.direction,
    run: {
      id: runId,
      ids: touched,
      shown: cards.length,
      /** Jobs beyond the id ceiling that were counted but not fetched. */
      truncated: res.truncated ?? 0,
    },
  })
}

/**
 * `open` is the inbox default: everything not known to be closed, stale or
 * errored. `likely` and `verified` narrow it. The old default hid every
 * UNVERIFIED posting — which after a wide sweep is most of the new inventory,
 * and the founder was told "35 jobs" while eight sat behind this filter.
 */
const FRESHNESS: Record<string, VerificationStatus[] | undefined> = {
  verified: ['VERIFIED_OPEN'],
  likely: ['VERIFIED_OPEN', 'LIKELY_OPEN'],
  open: ['VERIFIED_OPEN', 'LIKELY_OPEN', 'UNVERIFIED'],
  any: undefined,
}

/** The window fetched when a filter that only exists on embedded rows is on. See the note at its use. */
const EMBEDDED_FILTER_WINDOW = 200

/** How many rows the facet read scans to build the filter dropdowns. */
const CENSUS_FACETS = 2_000

/**
 * GET ?status=&tier=&role_family=&disposition=&minFit=&search=&freshness=verified|likely|open|any
 *     &relevance=strong|possible|any&view=all|needs_look&hasWarmPath=1&state=<application state>
 *     &sort=best|fit|recent|deadline&limit=&offset=
 * → { jobs, total, matched, relevance: { counts, headline, filter, direction }, filters }
 *
 * GET ?run=<scouting run id>
 * → every job that run touched, with none of the inbox defaults applied.
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const p = new URL(request.url).searchParams
    const run = p.get('run')
    if (run) {
      return await jobsForRun(user.id, run, Math.min(200, Math.max(1, Number(p.get('limit')) || 200)), Math.max(0, Number(p.get('offset')) || 0))
    }

    const list = (k: string) => (p.get(k) ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const filters: CensusFilters = {}
    const statuses = list('status').filter((s): s is VerificationStatus => VERIFICATION_STATUSES.includes(s as VerificationStatus))
    const freshness = p.get('freshness') ?? 'open'
    if (statuses.length) filters.status = statuses
    else if (FRESHNESS[freshness]) filters.status = FRESHNESS[freshness]
    const tiers = list('tier').map(Number).filter((n) => [1, 2, 3].includes(n))
    if (tiers.length) filters.tier = tiers
    const families = list('role_family')
    if (families.length) filters.role_family = families
    const dispositions = list('disposition').filter((d): d is JobDisposition => ['new', 'saved', 'dismissed'].includes(d))
    if (dispositions.length) filters.disposition = dispositions
    const minFit = Number(p.get('minFit'))
    if (p.get('minFit') && Number.isFinite(minFit)) filters.minFit = minFit
    if (p.get('search')) filters.search = p.get('search') as string

    const rawSort = p.get('sort')
    const sort: InboxSort = rawSort === 'fit' || rawSort === 'recent' || rawSort === 'deadline' ? rawSort : 'best'
    const rawRelevance = p.get('relevance')
    const relevance: RelevanceFilter = rawRelevance === 'strong' || rawRelevance === 'any' ? rawRelevance : 'possible'
    const rawView = p.get('view')
    const view: InboxView = rawView === 'needs_look' ? 'needs_look' : rawView === 'best' ? 'best' : 'all'
    const limit = Math.min(200, Math.max(1, Number(p.get('limit')) || 50))
    const offset = Math.max(0, Number(p.get('offset')) || 0)

    const hasWarmPath = p.get('hasWarmPath') === '1'
    const stateParam = p.get('state')
    const wantState = stateParam && APPLICATION_STATES.includes(stateParam as ApplicationState) ? (stateParam as ApplicationState) : null
    const embedded = hasWarmPath || !!wantState

    const db = createServiceClient()
    const ctx = await contextFor(user.id)
    const order = await orderInbox(db, user.id, ctx, filters, { relevance, view, sort })
    if (order.error) {
      if (isMissingSchema(order.error)) return NextResponse.json({ error: 'Apply supabase/migrations/014_career_os.sql first', migrationMissing: true }, { status: 409 })
      return NextResponse.json({ error: order.error }, { status: 500 })
    }

    // Warm-path and application-state live on embedded rows PostgREST cannot
    // filter the parent by. Rather than filter one page and report a number the
    // header cannot stand behind, fetch a wide window, filter it, then page —
    // and say so when the window itself was full.
    const window = embedded ? order.ids.slice(0, EMBEDDED_FILTER_WINDOW) : order.ids.slice(offset, offset + limit)
    const page = await fetchJobRows(db, user.id, window)
    if (page.error) return NextResponse.json({ error: page.error }, { status: 500 })

    let cards = page.rows.map((row) => toJobCard(row, order.byId.get(row.id)?.relevance ?? null))
    let matched = order.matched
    if (embedded) {
      if (hasWarmPath) cards = cards.filter((c) => c.warm_path_count > 0)
      if (wantState) cards = cards.filter((c) => c.application_state === wantState)
      matched = cards.length
      cards = cards.slice(offset, offset + limit)
    }

    const { data: facets } = await db.from('job_opportunities').select('role_family, location_tier, verification_status').eq('user_id', user.id).eq('is_canonical', true).limit(CENSUS_FACETS)
    const rows = (facets ?? []) as { role_family: string | null; location_tier: number | null; verification_status: string }[]
    const uniq = <T,>(xs: (T | null)[]) => [...new Set(xs.filter((x): x is T => x != null))]

    return NextResponse.json({
      jobs: cards,
      /** How many postings this page is drawn from — after relevance, before paging. */
      total: matched,
      matched,
      relevance: {
        filter: relevance,
        view,
        direction: ctx.direction,
        counts: order.counts,
        headline: relevanceHeadline(order.counts, matched, order.hidden),
        /** True when the census hit its ceiling and the totals are a floor, not the whole. */
        truncated: order.truncated,
        /** True when a warm-path or application-state filter narrowed a window rather than the whole set. */
        windowed: embedded && order.ids.length > EMBEDDED_FILTER_WINDOW,
      },
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

