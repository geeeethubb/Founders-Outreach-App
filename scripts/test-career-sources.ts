// Offline tests for job-source detection and the Workday adapter.
//
// No network, no keys. The Workday payloads in evals/career/fixtures/ats/
// workday-*.json were recorded live in Aug 2026 from micron/wd1/External and
// intel/wd1/External, so the parsers are exercised on the real response shapes
// — including the two that bite: Intel prefixes promoted roles' bulletFields
// with "Spotlight Job", and postedOn is a relative English phrase.
//
// The paging loop is tested through `collectWorkdayPostings`, which takes its
// page function as an argument for exactly this reason: pagination, page
// budgets, dedupe and mid-run failures are all reachable deterministically.
//   npx tsx scripts/test-career-sources.ts

process.env.CAREER_SOURCE_CACHE_BYPASS = '1'

import fs from 'fs'
import path from 'path'

import {
  WORKDAY_PAGE_SIZE, chooseWorkdaySite, collectWorkdayPostings, formatWorkdayIdentifier, matchWorkdayUrl,
  normalizeWorkdayPosting, parseWorkdayIdentifier, parseWorkdayPostedOn, pickInternFacet,
  preferredWorkdaySite, requisitionFromBullets, workdayAdapter, workdayAllowed, workdayApiUrl,
  workdayBoardUrl, workdayDetailUrl, workdayPostingUrl,
  type WorkdayBoardId, type WorkdayJobsResponse, type WorkdayPageFn, type WorkdayQuery,
} from '../lib/career/sources/workday'
import { matchAnyAtsUrl, createSourceRegistry, getSourceRegistry } from '../lib/career/sources/registry'
import { atsFamilyHints, atsUrlsInText, scanCareersPage } from '../lib/career/sources/careers'
import { detectAtsForCompany, negativeExpired, NEGATIVE_TTL_MS, type AtsDetection } from '../lib/career/sources/detect'
import { primeRobots } from '../lib/career/sources/robots'
import type { AtsBoardRef, FetchedPage, PageFetcher } from '../lib/career/sources/types'

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) passed++
  else {
    failed++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  }
}
function eq<T>(name: string, actual: T, expected: T): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`)
}

const FIX = path.join(process.cwd(), 'evals', 'career', 'fixtures', 'ats')
const load = <T>(name: string): T => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8')) as T

const MICRON: WorkdayBoardId = { tenant: 'micron', pod: 'wd1', site: 'External' }
const micronBoard: AtsBoardRef = { ats: 'workday', identifier: 'micron/wd1/External', company_name: 'Micron Technology' }

// ─── Identifier round-trip ───────────────────────────────────────────────────

eq('format identifier', formatWorkdayIdentifier(MICRON), 'micron/wd1/External')
eq('parse identifier', parseWorkdayIdentifier('micron/wd1/External'), MICRON)
eq('identifier round-trips', parseWorkdayIdentifier(formatWorkdayIdentifier(MICRON)), MICRON)
eq('parse keeps site case', parseWorkdayIdentifier('illumina/wd1/illumina-earlycareers-europe')?.site, 'illumina-earlycareers-europe')
eq('parse lowercases tenant', parseWorkdayIdentifier('Micron/WD1/External')?.tenant, 'micron')
check('parse rejects two parts', parseWorkdayIdentifier('micron/External') === null)
check('parse rejects four parts', parseWorkdayIdentifier('a/wd1/b/c') === null)
check('parse rejects a non-pod', parseWorkdayIdentifier('micron/east/External') === null)
check('parse rejects empty', parseWorkdayIdentifier('') === null)
eq('high pod number parses', parseWorkdayIdentifier('enovix/wd12/External')?.pod, 'wd12')

// ─── URL construction ────────────────────────────────────────────────────────

eq('board url', workdayBoardUrl(MICRON), 'https://micron.wd1.myworkdayjobs.com/en-US/External')
eq('api url', workdayApiUrl(MICRON), 'https://micron.wd1.myworkdayjobs.com/wday/cxs/micron/External/jobs')
eq('posting url', workdayPostingUrl(MICRON, '/job/Boise/Intern_JR1'), 'https://micron.wd1.myworkdayjobs.com/en-US/External/job/Boise/Intern_JR1')
eq('detail url', workdayDetailUrl(MICRON, '/job/Boise/Intern_JR1'), 'https://micron.wd1.myworkdayjobs.com/wday/cxs/micron/External/job/Boise/Intern_JR1')
eq('posting url tolerates a missing slash', workdayPostingUrl(MICRON, 'job/x/y'), 'https://micron.wd1.myworkdayjobs.com/en-US/External/job/x/y')

// ─── matchUrl ────────────────────────────────────────────────────────────────

eq('match bare site', matchWorkdayUrl('https://intel.wd1.myworkdayjobs.com/External')?.board.identifier, 'intel/wd1/External')
eq('match locale prefix', matchWorkdayUrl('https://amgen.wd1.myworkdayjobs.com/en-US/Careers')?.board.identifier, 'amgen/wd1/Careers')
eq('match trailing slash', matchWorkdayUrl('https://3m.wd1.myworkdayjobs.com/Search/')?.board.identifier, '3m/wd1/Search')
const deep = matchWorkdayUrl('https://intel.wd1.myworkdayjobs.com/en-US/External/job/PRC-Beijing/Executive-Assistant-Intern_JR0285840')
eq('match deep link board', deep?.board.identifier, 'intel/wd1/External')
eq('match deep link job id is the externalPath', deep?.jobId, '/job/PRC-Beijing/Executive-Assistant-Intern_JR0285840')
eq('match cxs api url', matchWorkdayUrl('https://micron.wd1.myworkdayjobs.com/wday/cxs/micron/External/jobs')?.board.identifier, 'micron/wd1/External')
eq('match high pod', matchWorkdayUrl('https://enovix.wd12.myworkdayjobs.com/External')?.board.identifier, 'enovix/wd12/External')
check('match rejects a non-workday host', matchWorkdayUrl('https://boards.greenhouse.io/stripe') === null)
check('match rejects the bare host', matchWorkdayUrl('https://intel.wd1.myworkdayjobs.com/') === null)
check('match rejects garbage', matchWorkdayUrl('not a url') === null)
eq('board_url from a match is canonical', matchWorkdayUrl('https://amgen.wd1.myworkdayjobs.com/en-US/Careers')?.board.board_url, 'https://amgen.wd1.myworkdayjobs.com/en-US/Careers')

// The registry must now claim Workday itself rather than filing it under 'other'.
const any = matchAnyAtsUrl('https://intel.wd1.myworkdayjobs.com/en-US/External')
eq('matchAnyAtsUrl ats', any?.ats, 'workday')
eq('matchAnyAtsUrl identifier carries all three parts', any?.identifier, 'intel/wd1/External')
eq('icims is still an unadapted family', matchAnyAtsUrl('https://us-careers-rivian.icims.com/jobs/search')?.ats, 'other')
check('registry exposes a workday adapter', !!getSourceRegistry().byId('workday'))
check('workday adapter is available without a key', workdayAdapter.isAvailable())

// ─── postedOn and bulletFields ───────────────────────────────────────────────

const NOW = new Date('2026-08-30T12:00:00Z')
eq('postedOn today', parseWorkdayPostedOn('Posted Today', NOW)?.slice(0, 10), '2026-08-30')
eq('postedOn yesterday', parseWorkdayPostedOn('Posted Yesterday', NOW)?.slice(0, 10), '2026-08-29')
eq('postedOn 4 days', parseWorkdayPostedOn('Posted 4 Days Ago', NOW)?.slice(0, 10), '2026-08-26')
eq('postedOn 2 months', parseWorkdayPostedOn('Posted 2 Months Ago', NOW)?.slice(0, 10), '2026-07-01')
// "30+" is unbounded: dating it 30 days back would make a year-old req look fresh.
check('postedOn 30+ is unknown, not 30', parseWorkdayPostedOn('Posted 30+ Days Ago', NOW) === null)
check('postedOn null', parseWorkdayPostedOn(null, NOW) === null)
check('postedOn junk', parseWorkdayPostedOn('Recently', NOW) === null)

eq('requisition from a single bullet', requisitionFromBullets(['JR0285840']), 'JR0285840')
eq('requisition skips the Spotlight badge', requisitionFromBullets(['Spotlight Job', 'JR0284458']), 'JR0284458')
check('requisition of nothing', requisitionFromBullets(null) === null)
check('requisition of a badge only', requisitionFromBullets(['Spotlight Job']) === null)

// ─── Listing parse on the recorded payload ───────────────────────────────────

const listFix = load<WorkdayJobsResponse>('workday-list.json')
const rows = listFix.jobPostings ?? []
check('workday list fixture has a full page', rows.length === WORKDAY_PAGE_SIZE)
const posts = rows.map((j) => normalizeWorkdayPosting(j, micronBoard, { now: '2026-08-30T00:00:00Z', employmentHint: 'Intern - Regular (Fixed Term)' }))
eq('source_type', posts[0].source_type, 'workday')
eq('ats_type', posts[0].ats_type, 'workday')
eq('ats_job_id is the externalPath', posts[0].ats_job_id, rows[0].externalPath)
eq('canonical url', posts[0].canonical_url, `https://micron.wd1.myworkdayjobs.com/en-US/External${rows[0].externalPath}`)
eq('apply url equals canonical', posts[0].apply_url, posts[0].canonical_url)
eq('company name from the board', posts[0].company_name, 'Micron Technology')
check('title is set', posts.every((p) => !!p.title))
check('location captured', posts.some((p) => !!p.location_raw))
check('listing carries no description', posts.every((p) => p.description_text === null && p.description_html === null))
check('employment hint carries the facet descriptor', posts[0].employment_type_hint === 'Intern - Regular (Fixed Term)')
check('raw payload retained', typeof posts[0].raw.externalPath === 'string')

const intelFix = load<WorkdayJobsResponse>('workday-intel-page.json')
const intelBoard: AtsBoardRef = { ats: 'workday', identifier: 'intel/wd1/External', company_name: 'Intel Corporation' }
const intelPosts = (intelFix.jobPostings ?? []).map((j) => normalizeWorkdayPosting(j, intelBoard))
check('spotlight rows still resolve a requisition id', intelPosts.filter((p) => !!p.requisition_id).length === intelPosts.length)
check('no requisition id is the literal badge', intelPosts.every((p) => p.requisition_id !== 'Spotlight Job'))

const detail = load<{ jobPostingInfo: Record<string, unknown> }>('workday-detail.json')
check('detail fixture carries description html', typeof detail.jobPostingInfo.jobDescription === 'string')
eq('detail fixture jobReqId', detail.jobPostingInfo.jobReqId, 'JR0285840')

// ─── Facet selection ─────────────────────────────────────────────────────────

const probeFix = load<WorkdayJobsResponse>('workday-probe.json')
const facet = pickInternFacet(probeFix.facets)
eq('intern facet parameter', facet?.parameter, 'workerSubType')
check('intern facet found both micron subtypes', (facet?.ids.length ?? 0) === 2, JSON.stringify(facet?.descriptors))
// Derived from the fixture rather than hardcoded: the counts move whenever the
// fixture is re-recorded, but the arithmetic must not.
const expectedFacetCount = (probeFix.facets ?? [])
  .find((f) => f.facetParameter === 'workerSubType')!.values!
  .filter((v) => /intern/i.test(v.descriptor ?? ''))
  .reduce((n, v) => n + (v.count ?? 0), 0)
check('intern facet count sums the matching values', facet?.count === expectedFacetCount, `${facet?.count} vs ${expectedFacetCount}`)
check('intern facet descriptors read as intern', (facet?.descriptors ?? []).every((d) => /intern/i.test(d)))

// workerSubType wins over jobFamilyGroup even when both match.
const bothFacets = pickInternFacet([
  { facetParameter: 'jobFamilyGroup', values: [{ descriptor: 'Interns', id: 'fam1', count: 96 }] },
  { facetParameter: 'workerSubType', values: [{ descriptor: 'Intern / Student', id: 'sub1', count: 35 }] },
])
eq('workerSubType preferred', bothFacets?.parameter, 'workerSubType')
// A tenant with no intern facet at all (Argonne is the live example).
check('no intern facet returns null', pickInternFacet([
  { facetParameter: 'jobFamilyGroup', values: [{ descriptor: 'Engineering', id: 'x', count: 4 }] },
  { facetParameter: 'timeType', values: [{ descriptor: 'Full time', id: 'y', count: 90 }] },
]) === null)
check('undefined facets return null', pickInternFacet(undefined) === null)
eq('site preference favours early-career surfaces', preferredWorkdaySite(['illumina-careers', 'illumina-universityrecruiting']), 'illumina-universityrecruiting')
eq('site preference falls back to the first', preferredWorkdaySite(['External']), 'External')
check('site preference of nothing', preferredWorkdaySite([]) === null)

// ─── Pagination ──────────────────────────────────────────────────────────────

interface Call { offset: number; limit: number; facets: Record<string, string[]>; searchText: string }

/** A fake board: `total` rows, page-sized responses, facet-aware. */
function fakeBoard(opts: {
  total: number
  titles: (i: number) => string
  facets?: WorkdayJobsResponse['facets']
  internCount?: number
  failAtPage?: number
  failStatus?: number
  /** searchText values this fake board has no rows for. */
  emptyFor?: string[]
}): { page: WorkdayPageFn; calls: Call[] } {
  const calls: Call[] = []
  const page: WorkdayPageFn = async (q: WorkdayQuery) => {
    calls.push({ offset: q.offset, limit: q.limit, facets: q.appliedFacets, searchText: q.searchText })
    if (q.limit === 1 && q.offset === 0) {
      return { status: 200, data: { total: opts.total, jobPostings: [], facets: opts.facets ?? [] } }
    }
    if (opts.emptyFor?.includes(q.searchText)) return { status: 200, data: { total: opts.total, jobPostings: [] } }
    const pageIndex = q.offset / WORKDAY_PAGE_SIZE
    if (opts.failAtPage !== undefined && pageIndex === opts.failAtPage) {
      return { status: opts.failStatus ?? 500, data: null, error: `http ${opts.failStatus ?? 500}` }
    }
    // With a facet applied the server returns only the intern subset.
    const universe = Object.keys(q.appliedFacets).length ? (opts.internCount ?? opts.total) : opts.total
    const out: WorkdayJobsResponse['jobPostings'] = []
    for (let i = q.offset; i < Math.min(q.offset + q.limit, universe); i++) {
      out.push({ title: opts.titles(i), externalPath: `/job/Loc/Role-${i}_JR${1000 + i}`, locationsText: 'Boise, ID', postedOn: 'Posted 3 Days Ago', bulletFields: [`JR${1000 + i}`] })
    }
    return { status: 200, data: { total: opts.total, jobPostings: out } }
  }
  return { page, calls }
}

const INTERN_FACETS: WorkdayJobsResponse['facets'] = [
  { facetParameter: 'workerSubType', values: [{ descriptor: 'Intern / Student', id: 'sub1', count: 53 }] },
]

async function main() {
// Facet path: 53 internships on a 2777-posting board, want 120.
{
  const { page, calls } = fakeBoard({ total: 2777, internCount: 53, facets: INTERN_FACETS, titles: (i) => `Role ${i}` })
  const res = await collectWorkdayPostings(MICRON, micronBoard, { internshipsOnly: true, want: 120, page })
  eq('facet path returns every internship', res.postings.length, 53)
  eq('facet path reports the whole board as the total', res.total_on_board, 2777)
  check('facet path applied the facet', calls.slice(1).every((c) => c.facets.workerSubType?.[0] === 'sub1'))
  check('facet path never asked for more than the page size', calls.every((c) => c.limit <= WORKDAY_PAGE_SIZE))
  check('facet path stopped on a short page', calls.length === 1 + 3, `${calls.length} calls`)
  check('facet path names the facet in the note', /workerSubType=Intern \/ Student/.test(res.note ?? ''), res.note)
  check('facet path did not truncate', !/partial/.test(res.note ?? ''))
  check('facet path titles need not say intern', res.postings.every((p) => p.employment_type_hint === 'Intern / Student'))
  eq('facet path ids are unique', new Set(res.postings.map((p) => p.ats_job_id)).size, 53)
}

// `want` bounds the paging: 25 wanted from 500 available is two pages, not 25.
{
  const { page, calls } = fakeBoard({ total: 500, internCount: 500, facets: INTERN_FACETS, titles: (i) => `Role ${i}` })
  const res = await collectWorkdayPostings(MICRON, micronBoard, { internshipsOnly: true, want: 25, page })
  check('want bounds the pages read', calls.length === 1 + 2, `${calls.length} calls`)
  check('want is satisfied', res.postings.length >= 25)
}

// No intern facet: titles are scanned and filtered, under the page budget.
{
  const { page } = fakeBoard({ total: 97, titles: (i) => (i % 5 === 0 ? `Summer Intern ${i}` : `Group Leader ${i}`) })
  const res = await collectWorkdayPostings({ tenant: 'argonne', pod: 'wd1', site: 'Argonne_Careers' }, { ats: 'workday', identifier: 'argonne/wd1/Argonne_Careers' }, { internshipsOnly: true, want: 120, page })
  eq('title-scan path keeps only internships', res.postings.length, 20)
  check('title-scan path says it had no facet', /no intern facet/.test(res.note ?? ''), res.note)
  check('title-scan path reports the real board size', res.total_on_board === 97)
  check('title-scan path left the hint empty', res.postings.every((p) => p.employment_type_hint === null))
}

// The scan budget is finite and admits it.
{
  const { page, calls } = fakeBoard({ total: 10_000, titles: () => 'Staff Engineer' })
  const res = await collectWorkdayPostings(MICRON, micronBoard, { internshipsOnly: true, want: 120, page })
  eq('scan budget yields nothing when no title matches', res.postings.length, 0)
  check('scan budget is capped', calls.length === 1 + 15, `${calls.length} calls`)
  check('scan budget admits the list is partial', /partial/.test(res.note ?? ''), res.note)
}

// The title scan RANKS with searchText so a short budget reads the likely rows
// first — 3M has one intern-titled requisition in 648 and it is invisible in
// the first 300 unordered rows. The facet path must not do this.
{
  const { page, calls } = fakeBoard({ total: 400, titles: (i) => `Role ${i}` })
  await collectWorkdayPostings(MICRON, micronBoard, { internshipsOnly: true, want: 120, page })
  const terms = calls.slice(1).map((c) => c.searchText)
  check('the title scan ranks by "intern"', terms.includes('intern'), JSON.stringify(terms))
  check('the title scan never sends an empty query', !terms.includes(''), JSON.stringify(terms))
}
{
  const { page, calls } = fakeBoard({ total: 400, internCount: 30, facets: INTERN_FACETS, titles: (i) => `Role ${i}` })
  await collectWorkdayPostings(MICRON, micronBoard, { internshipsOnly: true, want: 120, page })
  check('the facet path sends no search text', calls.slice(1).every((c) => c.searchText === ''), JSON.stringify(calls.map((c) => c.searchText)))
}
// When "intern" runs dry the scan falls through to the next ranking term.
{
  const { page, calls } = fakeBoard({ total: 400, titles: (i) => `Role ${i}`, emptyFor: ['intern'] })
  await collectWorkdayPostings(MICRON, micronBoard, { internshipsOnly: true, want: 120, page })
  const terms = calls.slice(1).map((c) => c.searchText)
  check('an exhausted ranking term falls through to the next', terms.includes('co-op'), JSON.stringify(terms))
}

// Not internships-only: no facet is applied at all.
{
  const { page, calls } = fakeBoard({ total: 45, facets: INTERN_FACETS, titles: (i) => `Role ${i}` })
  const res = await collectWorkdayPostings(MICRON, micronBoard, { internshipsOnly: false, want: 100, page })
  eq('unfiltered path returns the board', res.postings.length, 45)
  check('unfiltered path applied no facet', calls.slice(1).every((c) => Object.keys(c.facets).length === 0))
}

// Errors are returned, never thrown.
for (const [status, expected, label] of [[404, 'board not found', 'unknown site'], [422, 'tenant not found', 'unknown tenant']] as const) {
  const page: WorkdayPageFn = async () => ({ status, data: null, error: `http ${status}` })
  const res = await collectWorkdayPostings(MICRON, micronBoard, { internshipsOnly: true, want: 20, page })
  eq(`http ${status} (${label}) surfaces as "${expected}"`, res.error, expected)
  eq(`http ${status} returns no postings`, res.postings.length, 0)
  check(`http ${status} still reports a board url`, !!res.board_url)
}

// A failure part-way through keeps what it collected and says the list is partial.
{
  const { page } = fakeBoard({ total: 200, internCount: 200, facets: INTERN_FACETS, titles: (i) => `Intern ${i}`, failAtPage: 2, failStatus: 503 })
  const res = await collectWorkdayPostings(MICRON, micronBoard, { internshipsOnly: true, want: 120, page })
  eq('a mid-run failure keeps the pages that worked', res.postings.length, 40)
  check('a mid-run failure is not an error', !res.error)
  check('a mid-run failure says the list is partial', /partial/.test(res.note ?? ''), res.note)
}

// Duplicate externalPaths across pages collapse.
{
  const page: WorkdayPageFn = async (q) => {
    if (q.limit === 1) return { status: 200, data: { total: 4, jobPostings: [], facets: INTERN_FACETS } }
    if (q.offset > 0) return { status: 200, data: { total: 4, jobPostings: [] } }
    return {
      status: 200,
      data: { total: 4, jobPostings: [
        { title: 'Intern A', externalPath: '/job/X/A_JR1' },
        { title: 'Intern A', externalPath: '/job/X/A_JR1' },
        { title: 'Intern B', externalPath: '/job/X/B_JR2' },
        { title: '', externalPath: '/job/X/C_JR3' },
      ] } }
  }
  const res = await collectWorkdayPostings(MICRON, micronBoard, { internshipsOnly: true, want: 50, page })
  eq('duplicate externalPaths collapse and untitled rows drop', res.postings.map((p) => p.title), ['Intern A', 'Intern B'])
}

// A malformed identifier is reported, not thrown.
{
  const res = await workdayAdapter.listPostings({ ats: 'workday', identifier: 'micron' })
  eq('a bad identifier is an error, not a throw', res.error, 'bad identifier')
  check('a bad identifier explains the format', /tenant\/pod\/site/.test(res.note ?? ''), res.note)
  const one = await workdayAdapter.fetchPosting({ ats: 'workday', identifier: 'micron' }, '/job/x/y')
  eq('fetchPosting rejects a bad identifier', one.status, 'error')
}

// Site choice is measured, not guessed. Illumina publishes illumina-careers
// (150 postings) and illumina-universityrecruiting (zero); the name-based guess
// picks the empty one, which is how the live probe found Illumina listing 0.
{
  const totals: Record<string, { total: number; facets?: WorkdayJobsResponse['facets'] }> = {
    'illumina-careers': { total: 150 },
    'illumina-universityrecruiting': { total: 0 },
    'illumina-earlycareers-europe': { total: 0 },
  }
  const stub = (id: WorkdayBoardId): WorkdayPageFn => async () => ({ status: 200, data: { total: totals[id.site]?.total ?? 0, jobPostings: [], facets: totals[id.site]?.facets ?? [] } })
  const sites = ['illumina-careers', 'illumina-universityrecruiting', 'illumina-earlycareers-europe']
  eq('an empty early-career site never beats a populated one', await chooseWorkdaySite('illumina', 'wd1', sites, stub), 'illumina-careers')
  eq('the offline guess is the one that gets this wrong', preferredWorkdaySite(sites), 'illumina-universityrecruiting')
}
{
  // When both sites have postings, the one with more INTERNSHIPS wins.
  const facets = (n: number): WorkdayJobsResponse['facets'] => [{ facetParameter: 'workerSubType', values: [{ descriptor: 'Intern', id: 'i', count: n }] }]
  const table: Record<string, { total: number; facets: WorkdayJobsResponse['facets'] }> = {
    jobs: { total: 59, facets: facets(3) },
    University: { total: 53, facets: facets(25) },
  }
  const stub = (id: WorkdayBoardId): WorkdayPageFn => async () => ({ status: 200, data: { total: table[id.site].total, jobPostings: [], facets: table[id.site].facets } })
  eq('the site with more internships wins', await chooseWorkdaySite('chevron', 'wd5', ['jobs', 'University'], stub), 'University')
}
{
  const stub = (): WorkdayPageFn => async () => ({ status: 0, data: null, error: 'network down' })
  eq('a single site needs no probe at all', await chooseWorkdaySite('intel', 'wd1', ['External'], stub), 'External')
  eq('unreachable sites fall back to the offline guess', await chooseWorkdaySite('x', 'wd1', ['Main', 'Students'], stub), 'Students')
  eq('no sites, no choice', await chooseWorkdaySite('x', 'wd1', [], stub), null)
}

// ─── robots.txt ──────────────────────────────────────────────────────────────

primeRobots('https://intel.wd1.myworkdayjobs.com', {
  origin: 'https://intel.wd1.myworkdayjobs.com',
  allow: ['/External/'], disallow: ['/refreshFacet/'], fetched: true, crawlDelayMs: null,
})
primeRobots('https://chevron.wd5.myworkdayjobs.com', {
  origin: 'https://chevron.wd5.myworkdayjobs.com',
  allow: ['/jobs/', '/University/'], disallow: ['/ExternalCareerSite_Private/', '/refreshFacet/'], fetched: true, crawlDelayMs: null,
})

check('a public workday site is allowed', (await workdayAllowed({ tenant: 'intel', pod: 'wd1', site: 'External' })).allowed)
const blocked = await workdayAllowed({ tenant: 'chevron', pod: 'wd5', site: 'ExternalCareerSite_Private' })
check('a disallowed site is refused', !blocked.allowed)
check('a disallowed site says why', /robots\.txt disallows/.test(blocked.reason ?? ''), blocked.reason)
check('a sibling public site on the same host is still allowed', (await workdayAllowed({ tenant: 'chevron', pod: 'wd5', site: 'University' })).allowed)

// A robots-disallowed board fails the listing rather than fetching it.
{
  const res = await workdayAdapter.listPostings({ ats: 'workday', identifier: 'chevron/wd5/ExternalCareerSite_Private' }, { internshipsOnly: true, limit: 10 })
  check('a robots-blocked board lists nothing', res.postings.length === 0)
  check('a robots-blocked board reports robots as the reason', /robots\.txt/.test(`${res.error ?? ''}${res.note ?? ''}`), `${res.error} / ${res.note}`)
}

// ─── Careers-page detection ──────────────────────────────────────────────────

function page(over: Partial<FetchedPage>): FetchedPage {
  return { url: 'https://x.com/careers', final_url: 'https://x.com/careers', status: 200, text: 'Careers', title: null, links: [], robots_blocked: false, retrieved_at: '2026-08-30T00:00:00Z', ...over }
}
function stubFetcher(pages: Record<string, Partial<FetchedPage>>): PageFetcher {
  return { async fetch(url) { return pages[url] ? page({ url, final_url: url, ...pages[url] }) : page({ url, final_url: url, status: 404, text: '', error: 'http 404' }) } }
}

eq('atsUrlsInText finds a workday url in prose', atsUrlsInText('Apply at https://illumina.wd1.myworkdayjobs.com/illumina-careers today.'), ['https://illumina.wd1.myworkdayjobs.com/illumina-careers'])
eq('atsUrlsInText strips trailing punctuation', atsUrlsInText('see https://intel.wd1.myworkdayjobs.com/External.').length, 1)
eq('atsUrlsInText ignores non-ats urls', atsUrlsInText('https://example.com/about'), [])
eq('family hints from text', atsFamilyHints(page({ text: 'Our openings live on myworkdayjobs.com' })), ['workday'])
eq('family hints from a link', atsFamilyHints(page({ links: ['https://us-careers-rivian.icims.com/jobs/search'] })), ['icims'])
eq('family hints of nothing', atsFamilyHints(null), [])

// A careers page that REDIRECTS to a Workday board: the final url is the board.
{
  const scan = await scanCareersPage({ companyName: 'Boston Dynamics', domain: 'bostondynamics.com', careersUrl: 'https://bostondynamics.com/careers' },
    stubFetcher({ 'https://bostondynamics.com/careers': { final_url: 'https://bostondynamics.wd1.myworkdayjobs.com/en-US/Boston_Dynamics', text: 'Open roles' } }))
  eq('a redirect to workday resolves the board', scan.boards[0]?.identifier, 'bostondynamics/wd1/Boston_Dynamics')
  eq('the resolved board is workday, not other', scan.boards[0]?.ats, 'workday')
}

// A careers page that only NAMES its tenant in body text (a JS-rendered link).
{
  const scan = await scanCareersPage({ companyName: 'Micron Technology', domain: 'micron.com' },
    stubFetcher({ 'https://micron.com/careers': { text: 'Search all jobs at https://micron.wd1.myworkdayjobs.com/External — summer 2027 internships open.' } }))
  eq('a workday url in text resolves the board', scan.boards[0]?.identifier, 'micron/wd1/External')
  check('hints still come through', scan.hints.some((h) => /intern/.test(h)), JSON.stringify(scan.hints))
}

// The scan no longer stops at the first page that merely loads.
{
  const scan = await scanCareersPage({ companyName: 'Intel Corporation', domain: 'intel.com' },
    stubFetcher({
      'https://intel.com/careers': { text: 'Life at Intel. Our culture.' },
      'https://intel.com/jobs': { text: 'Search openings', links: ['https://intel.wd1.myworkdayjobs.com/External'] },
    }))
  eq('scanning continues past a board-less careers page', scan.boards[0]?.identifier, 'intel/wd1/External')
}

// …and still returns the readable page when nothing anywhere has a board.
{
  const scan = await scanCareersPage({ companyName: 'Acme', domain: 'acme.com' },
    stubFetcher({ 'https://acme.com/careers': { text: 'We are not currently hiring interns.' } }))
  eq('a board-less scan still reports the page it read', scan.careers_url, 'https://acme.com/careers')
  eq('a board-less scan reports no boards', scan.boards.length, 0)
  check('a board-less scan is not an error', !scan.error)
}

// End-to-end detection. The registry is empty of adapters so nothing reaches the
// network; the Workday board must come from the URL/page alone.
const noAdapters = createSourceRegistry([])
{
  const d = await detectAtsForCompany(
    { companyName: 'Amgen', domain: 'amgen.com', careersUrl: 'https://amgen.wd1.myworkdayjobs.com/en-US/Careers' },
    { registry: noAdapters, fetcher: stubFetcher({}), bypassCache: true }
  )
  eq('a stored workday careers url detects by url', d.method, 'url')
  eq('a stored workday careers url yields a listable identifier', d.board?.identifier, 'amgen/wd1/Careers')
  eq('detection records the family', d.families, ['workday'])
  check('detection is stamped', !!Date.parse(d.detected_at))
}
{
  const d = await detectAtsForCompany(
    { companyName: 'Intel Corporation', domain: 'intel.com' },
    { registry: noAdapters, bypassCache: true, fetcher: stubFetcher({ 'https://intel.com/careers': { text: 'Openings at https://intel.wd1.myworkdayjobs.com/External' } }) }
  )
  eq('a careers scan detects workday', d.method, 'careers_scan')
  eq('the scanned board is listable', d.board?.identifier, 'intel/wd1/External')
  check('the scan did not need a tenant probe', d.tenant_probed === false)
}
{
  // The page says "Workday" but hands over no URL — a tenant probe is warranted.
  // skipTenantProbe keeps this test offline while proving the gate is read.
  const d = await detectAtsForCompany(
    { companyName: 'Marathon Petroleum', domain: 'marathonpetroleum.com' },
    { registry: noAdapters, bypassCache: true, skipTenantProbe: true, fetcher: stubFetcher({ 'https://marathonpetroleum.com/careers': { text: 'Applications are handled in Workday.' } }) }
  )
  eq('an unresolved workday shop is still reported as one', d.families, ['workday'])
  eq('no board is found without the probe', d.board, null)
  eq('method is none', d.method, 'none')
}
{
  // No hint anywhere: the tenant probe must NOT run. Any pod probe would need
  // the network, so reaching this result at all proves the gate held.
  const d = await detectAtsForCompany(
    { companyName: 'Acme Widgets', domain: 'acme-widgets.test' },
    { registry: noAdapters, bypassCache: true, fetcher: stubFetcher({ 'https://acme-widgets.test/careers': { text: 'No openings right now.' } }) }
  )
  eq('a company with no ATS hint finds nothing', d.method, 'none')
  eq('a company with no ATS hint is not tenant-probed', d.tenant_probed, false)
  eq('a company with no ATS hint lists no families', d.families, [])
}

// ─── Negative caching expiry ─────────────────────────────────────────────────

const none = (detected_at: string): AtsDetection => ({ board: null, careers_url: null, method: 'none', attempts: [], hints: [], families: [], cacheable: true, tenant_probed: false, detected_at })
const t0 = Date.parse('2026-08-30T00:00:00Z')
check('a fresh negative is kept', !negativeExpired(none(new Date(t0).toISOString()), t0 + 1000))
check('a negative just inside the window is kept', !negativeExpired(none(new Date(t0).toISOString()), t0 + NEGATIVE_TTL_MS - 1))
check('a negative past the window expires', negativeExpired(none(new Date(t0).toISOString()), t0 + NEGATIVE_TTL_MS))
check('an undated negative expires', negativeExpired({ ...none(''), detected_at: '' }, t0))
check('a positive never expires this way', !negativeExpired({ ...none(new Date(0).toISOString()), method: 'careers_scan' }, t0))

}

// ─── Report ──────────────────────────────────────────────────────────────────

main()
  .then(() => {
    console.log(`\ntest-career-sources: ${passed} passed, ${failed} failed`)
    for (const f of failures) console.log(`  FAIL ${f}`)
    process.exit(failed ? 1 : 0)
  })
  .catch((err) => {
    console.error('test-career-sources threw:', err)
    process.exit(1)
  })
