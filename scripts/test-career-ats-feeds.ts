// Offline checks for the four one-call ATS feeds: Recruitee, Gem, Teamtailor
// and Personio.
//
//   npx tsx scripts/test-career-ats-feeds.ts
//
// No network, no keys, no database. Every payload under
// evals/career/fixtures/ats/ is a RECORDED response from a live probe on
// 2026-08-31 — vandebron.recruitee.com, api.gem.com/job_board/v0/fetch,
// career.teamtailor.com, oatly.teamtailor.com, personio.jobs.personio.de and
// jobleads.jobs.personio.de — trimmed to a few rows and otherwise byte-for-byte
// what the endpoint returned. (`personio-edge.xml` is the real feed plus a
// second position derived from it with fields removed, to exercise the shapes a
// smaller tenant emits.)
//
// What is asserted is the part that decides whether these sources are worth
// having: that the full description survives the parse, that dates become ISO,
// that a missing tenant degrades to a NOTE and never to an error, that
// Teamtailor really pages AND says so when the page cap cuts a board short,
// that a 200 whose body is not the API reads as a schema change rather than an
// empty board, that Personio's throttle actually spaces requests, and that
// `givesDescription: true` is a fact about the postings rather than a hopeful
// declaration.
//
// Filter checks assert BOTH directions — how many rows survive AND that `seen`
// still reports the whole board. "kept <= all" is not an assertion; an adapter
// that ignored `location`, or one that dropped every row, would satisfy it.

import fs from 'fs'
import path from 'path'
import type { JsonFetchResult } from '../lib/career/sources/fetch'
import type { JobDiscoverySource } from '../lib/career/sources/discovery-types'
import { emptyCoverageLedger, recordSearchResult } from '../lib/career/discovery/coverage'
import {
  recruiteeSource,
  recruiteeOffersUrl,
  recruiteeDateToIso,
  recruiteeLocation,
  recruiteeWorkMode,
  normalizeRecruiteeOffer,
  type RecruiteeOffer,
} from '../lib/career/sources/recruitee'
import { gemSource, gemJobPostsUrl, gemSlugFromUrl, normalizeGemJobPost, type GemJobPost } from '../lib/career/sources/gem'
import {
  teamtailorSource,
  teamtailorFeedUrl,
  teamtailorLocation,
  teamtailorJobId,
  normalizeTeamtailorItem,
} from '../lib/career/sources/teamtailor'
import {
  personioSource,
  personioFeedUrl,
  parsePersonioXml,
  normalizePersonioPosition,
  personioGate,
  personioThrottleState,
  resetPersonioThrottle,
  type PersonioClock,
  type PersonioFetcher,
  type PersonioResponse,
} from '../lib/career/sources/personio'

const FIX = path.join(process.cwd(), 'evals', 'career', 'fixtures', 'ats')

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

function readText(name: string): string {
  return fs.readFileSync(path.join(FIX, name), 'utf8')
}
function readJson<T>(name: string): T {
  return JSON.parse(readText(name)) as T
}

/**
 * Fixture tenants are deliberately NOT the real slugs. `fetchBoard` writes
 * through the shared disk cache keyed on (source, tenant, UTC day), so a test
 * using the live slug would seed the real cache with a four-row fixture and a
 * later real run would silently serve it.
 */
const R_TENANT = 'vandebron-fixture'
const G_SLUG = 'fetch-fixture'
const T_TENANT = 'career-fixture'
const T_TENANT_2 = 'oatly-fixture'
const P_TENANT = 'personio-fixture'

/** A JSON fetcher over a URL→response table. Anything unlisted is a 404. */
function jsonStub(table: Record<string, { status: number; data?: unknown; error?: string }>, calls: string[]) {
  return <T,>(url: string): Promise<JsonFetchResult<T>> => {
    calls.push(url)
    const hit = table[url]
    if (!hit) return Promise.resolve({ status: 404, data: null, error: 'http 404' })
    return Promise.resolve({ status: hit.status, data: (hit.data ?? null) as T | null, error: hit.error })
  }
}

async function allPostings(source: JobDiscoverySource, input: Parameters<JobDiscoverySource['search']>[0]) {
  return source.search(input)
}

// ─── Recruitee ───────────────────────────────────────────────────────────────

async function testRecruitee() {
  console.log('\nRecruitee — https://{tenant}.recruitee.com/api/offers/')

  const payload = readJson<{ offers: RecruiteeOffer[] }>('recruitee-vandebron.json')
  check('fixture is the recorded payload', payload.offers.length === 4, `${payload.offers.length} offers`)
  check('recorded offers carry 56 fields', Object.keys(payload.offers[0]).length === 56, `${Object.keys(payload.offers[0]).length} fields`)

  // Date: "2026-08-14 08:23:10 UTC" is not ISO and Date.parse may reject it.
  check('published_at → ISO', recruiteeDateToIso('2026-08-14 08:23:10 UTC') === '2026-08-14T08:23:10.000Z', String(recruiteeDateToIso('2026-08-14 08:23:10 UTC')))
  check('an unparseable stamp is null, never a wrong date', recruiteeDateToIso('not a date') === null)
  check('an empty stamp is null', recruiteeDateToIso(null) === null)

  const offer = payload.offers[0]
  check('structured location beats the flat string', recruiteeLocation(offer) === 'Amsterdam, Noord-Holland, Nederland', String(recruiteeLocation(offer)))
  check('work mode read from the three booleans', recruiteeWorkMode(offer) === 'hybrid', String(recruiteeWorkMode(offer)))
  check('flat location is the fallback', recruiteeLocation({ location: 'Remote, EU' }) === 'Remote, EU')

  const posting = normalizeRecruiteeOffer(offer, R_TENANT)
  check('a titleless row normalizes to null, not a throw', normalizeRecruiteeOffer({ id: 1 }, R_TENANT) === null)
  check('normalized', !!posting)
  if (posting) {
    check('description HTML survives intact', (posting.description_html ?? '').length > 8000, `${(posting.description_html ?? '').length} chars`)
    check('description text survives the flatten', (posting.description_text ?? '').length > 4000, `${(posting.description_text ?? '').length} chars`)
    check('description text is text, not markup', !(posting.description_text ?? '').includes('<p>'))
    check('canonical is the tenant own-domain careers_url', posting.canonical_url === offer.careers_url, String(posting.canonical_url))
    check('apply_url is the apply link', (posting.apply_url ?? '').endsWith('/c/new'), String(posting.apply_url))
    check('posted_at is ISO', posting.posted_at === '2026-08-14T08:23:10.000Z', String(posting.posted_at))
    check('external_id is the offer id', posting.external_id === String(offer.id))
    check('work mode preserved in raw', (posting.raw.recruitee as Record<string, unknown>).work_mode === 'hybrid')
  }

  // A live board.
  const calls: string[] = []
  const src = recruiteeSource({
    fetcher: jsonStub({ [recruiteeOffersUrl(R_TENANT)]: { status: 200, data: payload } }, calls),
    skipRobots: true,
    bypassCache: true,
  })
  const res = await allPostings(src, { board: { ats: 'other', identifier: R_TENANT } })
  check('search returns every published offer', res.postings.length === 4, `${res.postings.length} postings`)
  check('seen counts what the board held', res.seen === 4)
  check('one call, exhausted, no cursor', res.exhausted && res.nextCursor === null && res.requests === 1)
  check('no error on a good board', !res.error)
  check('givesDescription is true, and true of every posting', src.capabilities.givesDescription && res.postings.every((p) => (p.description_text ?? '').length > 200))

  // A missing tenant: HTTP 404, {"error":"Not Found"}. An ANSWER, not a failure.
  const missing = readText('recruitee-missing.json').trim()
  check('recorded 404 body', missing === '{"error":"Not Found"}', missing)
  const missSrc = recruiteeSource({ fetcher: jsonStub({}, []), skipRobots: true, bypassCache: true })
  const missRes = await allPostings(missSrc, { board: { ats: 'other', identifier: 'zzznosuchtenantxyz' } })
  check('a missing tenant is a note, NOT an error', missRes.error === undefined && !!missRes.note, missRes.note ?? '(no note)')
  check('a missing tenant is exhausted with nothing', missRes.postings.length === 0 && missRes.exhausted)

  // Filters. Every one of these asserts BOTH directions — the surviving count
  // and `seen` — because "kept <= 4 of 4" cannot fail, and an adapter that
  // ignored `location` outright, or dropped every row, would pass it.
  //
  // All four recorded offers are in Amsterdam, so the subset case needs a row
  // somewhere else: this payload is the recorded one with the FIRST offer moved
  // to Rotterdam and nothing else touched.
  const mixedCity = {
    offers: payload.offers.map((o, i) =>
      i === 0 ? { ...o, city: 'Rotterdam', location: 'Rotterdam, Zuid-Holland, Nederland' } : o
    ),
  }
  const mixedSrc = recruiteeSource({
    fetcher: jsonStub({ [recruiteeOffersUrl(R_TENANT)]: { status: 200, data: mixedCity } }, []),
    skipRobots: true,
    bypassCache: true,
  })
  const inRotterdam = await allPostings(mixedSrc, { board: { ats: 'other', identifier: R_TENANT }, location: 'rotterdam' })
  check(
    'a location matching one row keeps exactly that row',
    inRotterdam.postings.length === 1 && inRotterdam.postings[0].title === payload.offers[0].title,
    `${inRotterdam.postings.length} kept: ${inRotterdam.postings.map((p) => p.location_raw).join(' | ')}`
  )
  check('and `seen` still reports the whole board', inRotterdam.seen === 4)
  const inAmsterdam = await allPostings(mixedSrc, { board: { ats: 'other', identifier: R_TENANT }, location: 'amsterdam' })
  check('the complementary location keeps exactly the other three', inAmsterdam.postings.length === 3 && inAmsterdam.seen === 4, `${inAmsterdam.postings.length} kept`)
  const nowhere = await allPostings(src, { board: { ats: 'other', identifier: R_TENANT }, location: 'zzz-nowhere' })
  check('a location matching nothing keeps 0 while `seen` stays 4', nowhere.postings.length === 0 && nowhere.seen === 4, `${nowhere.postings.length} kept`)
  const none = await allPostings(src, { board: { ats: 'other', identifier: R_TENANT }, internshipsOnly: true })
  check(
    'internshipsOnly keeps exactly 0 of these four titles, and `seen` still says 4',
    none.postings.length === 0 && none.seen === 4,
    `${none.postings.length} kept of ${none.seen}`
  )
  // The term is matched against title AND description, so it has to be one no
  // other row's description mentions: three of these four talk about "gross
  // margin" or "sourcing" somewhere in the body.
  const byTerm = await allPostings(src, { board: { ats: 'other', identifier: R_TENANT }, titleTerms: ['customer experience manager'] })
  check(
    'a term keeps exactly the one posting that carries it',
    byTerm.postings.length === 1 && byTerm.postings[0].title === 'Customer Experience Manager',
    `${byTerm.postings.length} kept: ${byTerm.postings.map((p) => p.title).join(' | ')}`
  )

  // A 200 whose body is not the API's: an empty board with a NOTE, never a
  // healthy-looking empty board (a schema change must surface).
  const oddBody = await allPostings(
    recruiteeSource({
      fetcher: jsonStub({ [recruiteeOffersUrl(R_TENANT)]: { status: 200, data: { offers: null } } }, []),
      skipRobots: true,
      bypassCache: true,
    }),
    { board: { ats: 'other', identifier: R_TENANT } }
  )
  check(
    'a 200 with no offers array is an empty page WITH a note, not a silent empty board',
    oddBody.postings.length === 0 && oddBody.error === undefined && /no offers array/.test(oddBody.note ?? ''),
    oddBody.note ?? '(no note)'
  )
  const emptyRec = await allPostings(
    recruiteeSource({
      fetcher: jsonStub({ [recruiteeOffersUrl(R_TENANT)]: { status: 200, data: { offers: [] } } }, []),
      skipRobots: true,
      bypassCache: true,
    }),
    { board: { ats: 'other', identifier: R_TENANT } }
  )
  check('an empty offers ARRAY is a healthy empty board — no note, no error', emptyRec.postings.length === 0 && !emptyRec.note && !emptyRec.error)

  // The slug-guess path must not pay for the winning board twice.
  const guessCalls: string[] = []
  const guessed = await allPostings(
    recruiteeSource({
      fetcher: jsonStub({ [recruiteeOffersUrl('acmechem-fixture')]: { status: 200, data: payload } }, guessCalls),
      skipRobots: true,
      bypassCache: true,
    }),
    { company: { name: 'AcmeChem', domain: 'acmechem-fixture.example' } }
  )
  check('a guessed slug returns the board', guessed.postings.length === 4, `${guessed.postings.length} postings`)
  check(
    'the winning guess is fetched ONCE, and `requests` says so',
    guessCalls.filter((u) => u === recruiteeOffersUrl('acmechem-fixture')).length === 1 && guessed.requests === guessCalls.length,
    `${guessCalls.length} HTTP call(s), requests=${guessed.requests}`
  )
}

// ─── Gem ─────────────────────────────────────────────────────────────────────

async function testGem() {
  console.log('\nGem — https://api.gem.com/job_board/v0/{slug}/job_posts/')

  check('the trailing slash is in the URL builder', gemJobPostsUrl('acme').endsWith('/job_posts/'), gemJobPostsUrl('acme'))

  const posts = readJson<GemJobPost[]>('gem-fetch.json')
  // The correction that matters: the response is a BARE ARRAY.
  check('the recorded payload is a bare array, not {jobs:[…]}', Array.isArray(posts), Array.isArray(posts) ? 'array' : `object with ${Object.keys(posts as object).join(', ')}`)
  check('fixture rows', posts.length === 4, `${posts.length} posts`)
  check('id is a string, not a number', typeof posts[0].id === 'string', typeof posts[0].id)
  check('the posted date field is first_published_at', typeof posts[0].first_published_at === 'string')

  const posting = normalizeGemJobPost(posts[0], G_SLUG)
  check('normalized', !!posting)
  if (posting) {
    check('content_plain is preferred over re-flattening the HTML', posting.description_text === (posts[0].content_plain ?? '').trim(), `${(posting.description_text ?? '').length} chars`)
    check('description survives intact', (posting.description_text ?? '').length > 8000, `${(posting.description_text ?? '').length} chars`)
    check('description_html is the HTML Gem sent', (posting.description_html ?? '').startsWith('<div>'))
    check('first_published_at maps to posted_at as ISO', posting.posted_at === posts[0].first_published_at, String(posting.posted_at))
    check('updated_at is ISO', posting.updated_at === posts[0].updated_at, String(posting.updated_at))
    check('canonical is the absolute_url Gem gave', posting.canonical_url === posts[0].absolute_url, String(posting.canonical_url))
    check('canonical is a jobs.gem.com URL, not boards.greenhouse.io', (posting.canonical_url ?? '').includes('jobs.gem.com'))
    check('external_id is the string id', posting.external_id === String(posts[0].id))
    check('location comes from location.name', posting.location_raw === posts[0].location?.name)
    check('department from the Greenhouse-shaped departments[]', posting.department === posts[0].departments?.[0]?.name)
    check('employment_type becomes the hint', posting.employment_type_hint === posts[0].employment_type)
    check('requisition_id preserved', posting.requisition_id === posts[0].requisition_id)
  }
  check('a row with no id normalizes to null', normalizeGemJobPost({ title: 'X' }, G_SLUG) === null)

  check('slug read from a jobs.gem.com URL', gemSlugFromUrl('https://jobs.gem.com/fetch/7536752003') === 'fetch')
  check('slug read from the API URL', gemSlugFromUrl('https://api.gem.com/job_board/v0/fetch/job_posts/') === 'fetch')
  check('a non-Gem URL yields no slug', gemSlugFromUrl('https://boards.greenhouse.io/acme') === null)

  const calls: string[] = []
  const src = gemSource({
    fetcher: jsonStub({ [gemJobPostsUrl(G_SLUG)]: { status: 200, data: posts } }, calls),
    skipRobots: true,
    bypassCache: true,
  })
  const res = await allPostings(src, { board: { ats: 'other', identifier: G_SLUG } })
  check('search parses the bare array', res.postings.length === 4, `${res.postings.length} postings`)
  check('the call used the trailing-slash URL', calls[0]?.endsWith('/job_posts/'), calls[0] ?? '(none)')
  check('seen counts the board', res.seen === 4 && res.exhausted && res.nextCursor === null)
  check('givesDescription is true, and true of every posting', src.capabilities.givesDescription && res.postings.every((p) => (p.description_text ?? '').length > 200))

  const missing = await allPostings(gemSource({ fetcher: jsonStub({}, []), skipRobots: true, bypassCache: true }), {
    board: { ats: 'other', identifier: 'zzznosuchslug' },
  })
  check('a missing slug is a note, NOT an error', missing.error === undefined && !!missing.note, missing.note ?? '(no note)')

  // A future envelope must not read as an empty board.
  const wrapped = gemSource({
    fetcher: jsonStub({ [gemJobPostsUrl(G_SLUG)]: { status: 200, data: { job_posts: posts } } }, []),
    skipRobots: true,
    bypassCache: true,
  })
  const wrappedRes = await allPostings(wrapped, { board: { ats: 'other', identifier: G_SLUG } })
  check('a wrapped {job_posts:[…]} envelope still parses', wrappedRes.postings.length === 4)

  // …but a body that is NEITHER shape must not read as a healthy empty board.
  const junk = await allPostings(
    gemSource({
      fetcher: jsonStub({ [gemJobPostsUrl(G_SLUG)]: { status: 200, data: 'not json we know' } }, []),
      skipRobots: true,
      bypassCache: true,
    }),
    { board: { ats: 'other', identifier: G_SLUG } }
  )
  check(
    'an unrecognized 200 body is an empty page WITH a note',
    junk.postings.length === 0 && junk.error === undefined && /shape may have changed/.test(junk.note ?? ''),
    junk.note ?? '(no note)'
  )
  const emptyBoard = await allPostings(
    gemSource({
      fetcher: jsonStub({ [gemJobPostsUrl(G_SLUG)]: { status: 200, data: [] } }, []),
      skipRobots: true,
      bypassCache: true,
    }),
    { board: { ats: 'other', identifier: G_SLUG } }
  )
  check('an empty ARRAY is a healthy empty board — no note, no error', emptyBoard.postings.length === 0 && !emptyBoard.note && !emptyBoard.error)

  // Filters, both directions.
  const android = await allPostings(src, { board: { ats: 'other', identifier: G_SLUG }, titleTerms: ['android'] })
  check('a title term keeps exactly the two Android postings', android.postings.length === 2 && android.seen === 4, `${android.postings.length} kept of ${android.seen}`)
  const gemNowhere = await allPostings(src, { board: { ats: 'other', identifier: G_SLUG }, location: 'zzz-nowhere' })
  check('a location matching nothing keeps 0 while `seen` stays 4', gemNowhere.postings.length === 0 && gemNowhere.seen === 4)
  const gemHere = await allPostings(src, { board: { ats: 'other', identifier: G_SLUG }, location: 'united states' })
  check('the location every row carries keeps all four', gemHere.postings.length === 4 && gemHere.seen === 4)
  const gemInterns = await allPostings(src, { board: { ats: 'other', identifier: G_SLUG }, internshipsOnly: true })
  check('internshipsOnly keeps exactly 0 of these four senior titles', gemInterns.postings.length === 0 && gemInterns.seen === 4, `${gemInterns.postings.length} kept`)

  // The slug guess must not fetch the winning board twice.
  const gemGuessCalls: string[] = []
  const gemGuessed = await allPostings(
    gemSource({
      fetcher: jsonStub({ [gemJobPostsUrl('acmechem-fixture')]: { status: 200, data: posts } }, gemGuessCalls),
      skipRobots: true,
      bypassCache: true,
    }),
    { company: { name: 'AcmeChem', domain: 'acmechem-fixture.example' } }
  )
  check(
    'a guessed slug fetches the winning board ONCE and reports that count',
    gemGuessed.postings.length === 4 &&
      gemGuessCalls.filter((u) => u === gemJobPostsUrl('acmechem-fixture')).length === 1 &&
      gemGuessed.requests === gemGuessCalls.length,
    `${gemGuessCalls.length} HTTP call(s), requests=${gemGuessed.requests}`
  )
}

// ─── Teamtailor ──────────────────────────────────────────────────────────────

interface TtFeed {
  title?: string
  items: unknown[]
}

async function testTeamtailor() {
  console.log('\nTeamtailor — https://{tenant}.teamtailor.com/jobs.json')

  const career = readJson<TtFeed>('teamtailor-career-p1.json')
  const oatly1 = readJson<TtFeed>('teamtailor-oatly-p1.json')
  const oatly2 = readJson<TtFeed>('teamtailor-oatly-p2.json')
  check('recorded feeds', career.items.length === 4 && oatly1.items.length === 3 && oatly2.items.length === 0, `${career.items.length}/${oatly1.items.length}/${oatly2.items.length}`)

  const first = career.items[0] as Record<string, unknown>
  const posting = normalizeTeamtailorItem(first, T_TENANT, career.title ?? null)
  check('normalized', !!posting)
  if (posting) {
    check('content_html survives intact', (posting.description_html ?? '').length > 4000, `${(posting.description_html ?? '').length} chars`)
    check('description text survives the flatten', (posting.description_text ?? '').length > 2000, `${(posting.description_text ?? '').length} chars`)
    check('datePosted becomes ISO UTC', posting.posted_at === '2026-07-24T11:57:16.000Z', String(posting.posted_at))
    check('location built from the PostalAddress', posting.location_raw === 'Stockholm, Sweden, SE', String(posting.location_raw))
    check('company from hiringOrganization', posting.company_name === 'Teamtailor', String(posting.company_name))
    check('external_id is the numeric job id, not the feed UUID', posting.external_id === '8124573', String(posting.external_id))
    check('canonical is the first-party job URL', (posting.canonical_url ?? '').startsWith('https://career.teamtailor.com/jobs/'))
  }

  // validThrough is per POSTING, not per tenant: present on oatly rows, absent on career.
  const withVt = oatly1.items.map((i) => normalizeTeamtailorItem(i, T_TENANT_2, oatly1.title ?? null))
  const vtCount = withVt.filter((p) => p && (p.raw.teamtailor as Record<string, unknown>).valid_through).length
  check('validThrough captured where the feed carries it', vtCount === 2, `${vtCount} of 3`)
  check('validThrough absent elsewhere is null, not an error', withVt.filter((p) => p && !(p.raw.teamtailor as Record<string, unknown>).valid_through).length === 1)

  // Undocumented endpoint: a surprising row is SKIPPED, never thrown.
  check('a null row is skipped', normalizeTeamtailorItem(null, T_TENANT, null) === null)
  check('a string row is skipped', normalizeTeamtailorItem('nope', T_TENANT, null) === null)
  check('a row with no url is skipped', normalizeTeamtailorItem({ title: 'X' }, T_TENANT, null) === null)
  check('a row with a broken _jobposting still normalizes', !!normalizeTeamtailorItem({ title: 'X', url: 'https://x.teamtailor.com/jobs/1-x', _jobposting: 'garbage' }, T_TENANT, null))
  check('a jobLocation that is not an array does not throw', teamtailorLocation({ jobLocation: 'nope' } as never) === null)
  check('the job id falls back to the URL', teamtailorJobId({ url: 'https://x.teamtailor.com/jobs/424242-thing' }) === '424242')

  const calls: string[] = []
  const src = teamtailorSource({
    fetcher: jsonStub(
      {
        [teamtailorFeedUrl(T_TENANT_2, 1)]: { status: 200, data: oatly1 },
        [teamtailorFeedUrl(T_TENANT_2, 2)]: { status: 200, data: oatly2 },
      },
      calls
    ),
    skipRobots: true,
    bypassCache: true,
  })

  const p1 = await src.search({ board: { ats: 'other', identifier: T_TENANT_2 } })
  check('page 1 parses', p1.postings.length === 3 && p1.seen === 3, `${p1.postings.length} postings`)
  check('page 1 hands back a cursor and is not exhausted', p1.nextCursor === '2' && !p1.exhausted, String(p1.nextCursor))
  const p2 = await src.search({ board: { ats: 'other', identifier: T_TENANT_2 } }, p1.nextCursor)
  check('page 2 is empty and exhausted with a null cursor', p2.postings.length === 0 && p2.exhausted && p2.nextCursor === null)
  check('paging asked for ?page=2', calls[1]?.includes('page=2'), calls[1] ?? '(none)')
  check('paginates: true is truthful', src.capabilities.paginates)
  check('givesDescription is true, and true of every posting', src.capabilities.givesDescription && p1.postings.every((p) => (p.description_text ?? '').length > 200))

  // A missing tenant answers 404 with an EMPTY body — a note, not a parse failure.
  const missing = await teamtailorSource({ fetcher: jsonStub({}, []), skipRobots: true, bypassCache: true }).search({
    board: { ats: 'other', identifier: 'zzznosuchtenantxyz' },
  })
  check('a missing tenant is a note, NOT an error', missing.error === undefined && !!missing.note, missing.note ?? '(no note)')

  // A shape change is a note with a count, not a lost page.
  const mixed = { title: 'Mixed', items: [...oatly1.items, null, 42, { nope: true }] }
  const mixedRes = await teamtailorSource({
    fetcher: jsonStub({ [teamtailorFeedUrl(T_TENANT_2, 1)]: { status: 200, data: mixed } }, []),
    skipRobots: true,
    bypassCache: true,
  }).search({ board: { ats: 'other', identifier: T_TENANT_2 } })
  check('unparseable rows are skipped, counted and reported', mixedRes.postings.length === 3 && /3 row\(s\) skipped/.test(mixedRes.note ?? ''), mixedRes.note ?? '(no note)')
  check('a skipped row is not an error — the other 3 survive', mixedRes.error === undefined)

  // items missing entirely.
  const noItems = await teamtailorSource({
    fetcher: jsonStub({ [teamtailorFeedUrl(T_TENANT_2, 1)]: { status: 200, data: { title: 'x' } } }, []),
    skipRobots: true,
    bypassCache: true,
  }).search({ board: { ats: 'other', identifier: T_TENANT_2 } })
  check('a feed with no items array is an empty page with a note', noItems.postings.length === 0 && !!noItems.note && noItems.error === undefined, noItems.note ?? '(no note)')

  // Filters, both directions. `teamtailorLocation` takes the FIRST address, so
  // the two Malmö-first rows and the Philadelphia row split 2/1.
  const philly = await src.search({ board: { ats: 'other', identifier: T_TENANT_2 }, location: 'philadelphia' })
  check('a location matching one row keeps exactly that row', philly.postings.length === 1 && philly.seen === 3, `${philly.postings.length} kept of ${philly.seen}`)
  const malmo = await src.search({ board: { ats: 'other', identifier: T_TENANT_2 }, location: 'malm' })
  check('the complementary location keeps exactly the other two', malmo.postings.length === 2 && malmo.seen === 3, `${malmo.postings.length} kept`)
  const ttNowhere = await src.search({ board: { ats: 'other', identifier: T_TENANT_2 }, location: 'zzz-nowhere' })
  check('a location matching nothing keeps 0 while `seen` stays 3', ttNowhere.postings.length === 0 && ttNowhere.seen === 3)
  const ttInterns = await src.search({ board: { ats: 'other', identifier: T_TENANT_2 }, internshipsOnly: true })
  check('internshipsOnly keeps exactly 0 of these three titles', ttInterns.postings.length === 0 && ttInterns.seen === 3, `${ttInterns.postings.length} kept`)

  // THE PAGE CAP. A feed that is still serving rows when the cap is reached has
  // NOT been fully read, and saying `exhausted` with a clean bill of health is
  // how a gap hides behind a checkmark in the coverage ledger — coverage.ts
  // grants `completed` only to an exhausted source with no errors.
  const capTable: Record<string, { status: number; data?: unknown }> = {}
  for (let p = 1; p <= 25; p++) capTable[teamtailorFeedUrl(T_TENANT_2, p)] = { status: 200, data: oatly1 }
  const capCalls: string[] = []
  const endless = teamtailorSource({ fetcher: jsonStub(capTable, capCalls), skipRobots: true, bypassCache: true })
  const capInput = { board: { ats: 'other' as const, identifier: T_TENANT_2 } }
  let cursor: string | null = null
  let pages = 0
  let last = await endless.search(capInput)
  pages++
  while (last.nextCursor && pages < 40) {
    cursor = last.nextCursor
    last = await endless.search(capInput, cursor)
    pages++
  }
  check('paging stops at the cap rather than walking a feed forever', pages === 20 && capCalls.length === 20, `${pages} pages, ${capCalls.length} calls`)
  check('the capped page is still exhausted with no cursor', last.exhausted && last.nextCursor === null)
  check(
    'truncation at the cap is REPORTED, not silent',
    !!last.error && /cap/.test(last.error) && /NOT fully read/.test(last.note ?? ''),
    `error=${last.error ?? '(none)'} note=${last.note ?? '(none)'}`
  )
  check('the rows that page did find are still returned', last.postings.length === 3, `${last.postings.length} postings`)
  // Asserted through the real ledger, not by reasoning about it.
  const ledger = emptyCoverageLedger()
  const truncRow = recordSearchResult(ledger, endless, last)
  check('the ledger refuses `completed` to the truncated source', truncRow.completed === false && truncRow.errors.length === 1, `completed=${truncRow.completed} errors=${truncRow.errors.length}`)
  const cleanLedger = emptyCoverageLedger()
  const cleanRow = recordSearchResult(cleanLedger, endless, await src.search({ board: { ats: 'other', identifier: T_TENANT_2 } }, '2'))
  check('and grants it to a source that really reached the end', cleanRow.completed === true, `completed=${cleanRow.completed}`)
  // The other cap case: a page that comes back EMPTY at the cap is a real end
  // of feed, and must stay clean.
  const cleanEnd = await teamtailorSource({
    fetcher: jsonStub({ [teamtailorFeedUrl(T_TENANT_2, 20)]: { status: 200, data: oatly2 } }, []),
    skipRobots: true,
    bypassCache: true,
  }).search(capInput, '20')
  check('an empty page at the cap is a clean finish, no error', cleanEnd.exhausted && cleanEnd.error === undefined && cleanEnd.postings.length === 0)
}

// ─── Personio ────────────────────────────────────────────────────────────────

/** Virtual time: `sleep` advances the clock instead of blocking. */
function fakeClock(): PersonioClock & { t: number; sleeps: number[] } {
  const c = {
    t: 0,
    sleeps: [] as number[],
    now() {
      return c.t
    },
    sleep(ms: number) {
      c.sleeps.push(ms)
      c.t += ms
      return Promise.resolve()
    },
  }
  return c
}

function personioStub(responses: PersonioResponse[], calls: string[]): PersonioFetcher {
  let i = 0
  return (url: string) => {
    calls.push(url)
    const res = responses[Math.min(i, responses.length - 1)]
    i++
    return Promise.resolve(res)
  }
}

const XML_OK = (body: string): PersonioResponse => ({ status: 200, body, contentType: 'text/xml' })

async function testPersonio() {
  console.log('\nPersonio — https://{tenant}.jobs.personio.de/xml?language=en')

  const xml = readText('personio-personio.xml')
  const edge = readText('personio-edge.xml')

  const positions = parsePersonioXml(xml)
  check('the recorded feed parses', positions.length === 1, `${positions.length} positions`)
  const p = positions[0]
  check('id read', p.id === '1834171', String(p.id))
  // The trap: <name> is both the job title and every description heading.
  check('title is the position name, not the first description heading', p.name === 'Staff Software Engineer, Data Platform', String(p.name))
  check('office read', p.office === 'Munich', String(p.office))
  // The other trap: <office> also appears inside <additionalOffices>.
  check('additionalOffices lifted out separately', p.additionalOffices.join(',') === 'Berlin', p.additionalOffices.join(','))
  check('department read', p.department === 'Product and Tech', String(p.department))
  check('employmentType / seniority / schedule read', p.employmentType === 'permanent' && p.seniority === 'experienced' && p.schedule === 'full-time')
  check('all four description sections captured', p.descriptions.length === 4, `${p.descriptions.length} sections`)
  check('CDATA HTML preserved in the section value', p.descriptions[0].html.includes('<strong>'))

  const posting = normalizePersonioPosition(p, P_TENANT)
  check('normalized', !!posting)
  if (posting) {
    check('every section reaches the description', (posting.description_text ?? '').length > 2000, `${(posting.description_text ?? '').length} chars`)
    check('section headings survive as structure', (posting.description_text ?? '').includes('The Role'))
    check('description text is text, not markup', !(posting.description_text ?? '').includes('<strong>'))
    check('createdAt becomes ISO', posting.posted_at === '2024-11-13T14:10:41.000Z', String(posting.posted_at))
    check('offices joined into location', posting.location_raw === 'Munich · Berlin', String(posting.location_raw))
    check('company from subcompany', posting.company_name === 'Personio SE & Co. KG', String(posting.company_name))
    check('the constructed job URL is flagged in raw', (posting.raw.personio as Record<string, unknown>).url_constructed === true)
  }

  const edgePositions = parsePersonioXml(edge)
  check('a multi-position feed parses every position', edgePositions.length === 2, `${edgePositions.length} positions`)
  const second = edgePositions[1]
  check('XML entities decoded in the title', second.name === 'Process Engineering Intern (Summer 2027) & Co-op', String(second.name))
  check('a missing createdAt is null, not a crash', second.createdAt === null)
  check('a missing department is null', second.department === null)
  check('a position with one description section parses', second.descriptions.length === 1)
  const secondPosting = normalizePersonioPosition(second, P_TENANT)
  check('a position with no createdAt has posted_at null', secondPosting?.posted_at === null)
  check('a position with no additionalOffices has a single location', secondPosting?.location_raw === 'Rahway, NJ', String(secondPosting?.location_raw))

  // ── The source, throttle disabled by a wide gap of 0 for the parse checks.
  resetPersonioThrottle()
  const calls: string[] = []
  const clock = fakeClock()
  const src = personioSource({
    fetcher: personioStub([XML_OK(edge)], calls),
    clock,
    minGapMs: 0,
    skipRobots: true,
    bypassCache: true,
  })
  const res = await src.search({ board: { ats: 'other', identifier: P_TENANT, board_url: `https://${P_TENANT}.jobs.personio.de` } })
  check('search parses the feed', res.postings.length === 2 && res.seen === 2, `${res.postings.length} postings`)
  check('the feed URL is the documented one', calls[0] === personioFeedUrl(P_TENANT, 'de'), calls[0] ?? '(none)')
  check('givesDescription is true, and true of every posting', src.capabilities.givesDescription && res.postings.every((p2) => (p2.description_text ?? '').length > 200))
  // The feed carries no URL at all, so the capability says so.
  check('givesCanonicalUrl is FALSE — the URL is constructed', src.capabilities.givesCanonicalUrl === false)
  const interns = await src.search({ board: { ats: 'other', identifier: P_TENANT, board_url: `https://${P_TENANT}.jobs.personio.de` }, internshipsOnly: true })
  check('internshipsOnly keeps the intern position', interns.postings.length === 1 && /Intern/.test(interns.postings[0].title), `${interns.postings.length} kept`)

  // Personio never guesses a slug — a miss costs a request against the one
  // source that rate-limits.
  const unnamed = await src.search({ company: { name: 'Merck', domain: 'merck.com' } })
  check('a company with no Personio URL is a note, and costs no request', unnamed.error === undefined && !!unnamed.note && unnamed.postings.length === 0, unnamed.note ?? '(no note)')

  // ── A SECOND real tenant, recorded 2026-08-31 from
  // jobleads.jobs.personio.de/xml?language=en (12 positions live, 2 kept here).
  // It exists because the first tenant proved nothing about the constructed job
  // URL: `personio`'s own HTML board 307s to personio.com while its feed still
  // serves 200. On this one the pattern was checked live — /job/2730769 → HTTP
  // 200 with a <title> matching this position's <name>.
  const jl = parsePersonioXml(readText('personio-jobleads.xml'))
  check('a second real tenant parses', jl.length === 2, `${jl.length} positions`)
  check('its ids are the ones the live feed served', jl.map((q) => q.id).join(',') === '2730769,2730018', jl.map((q) => q.id).join(','))
  check('an entity-escaped title decodes', jl[0].name === 'AI Engineer (Search & Matching) - fully remote within Germany (m/f/d) Remote', String(jl[0].name))
  const jlPosting = normalizePersonioPosition(jl[0], 'jobleads')
  check(
    'the constructed job URL is the one verified live',
    jlPosting?.apply_url === 'https://jobleads.jobs.personio.de/job/2730769',
    String(jlPosting?.apply_url)
  )
  check('every posting keeps a UNIQUE url — the board root would collapse the dedupe key', new Set(jl.map((q) => `https://jobleads.jobs.personio.de/job/${q.id}`)).size === 2)
  check('its description survives', (jlPosting?.description_text ?? '').length > 1000, `${(jlPosting?.description_text ?? '').length} chars`)
  check('company from subcompany, not the tenant slug', jlPosting?.company_name === 'JobLeads GmbH', String(jlPosting?.company_name))

  // ── Addressing. A board whose URL says Personio but whose host the strict
  // parser cannot split still names its tenant in the identifier.
  const idCalls: string[] = []
  const byIdentifier = await personioSource({
    fetcher: personioStub([{ status: 200, body: readText('personio-edge.xml'), contentType: 'text/xml' }], idCalls),
    clock: fakeClock(),
    minGapMs: 0,
    skipRobots: true,
    bypassCache: true,
  }).search({ board: { ats: 'other', identifier: P_TENANT, board_url: 'https://jobs.personio.de/some-landing-path' } })
  check('a Personio-hosted board addresses the feed by identifier', byIdentifier.postings.length === 2 && idCalls[0] === personioFeedUrl(P_TENANT, 'de'), idCalls[0] ?? '(no call)')

  // …but a bare identifier from some OTHER ATS must not fire a request at
  // `{identifier}.jobs.personio.de`. `AtsBoardRef` carries no family, so the
  // host is the only evidence, and this source is the rate-limited one.
  const strayCalls: string[] = []
  const stray = await personioSource({
    fetcher: personioStub([{ status: 200, body: readText('personio-edge.xml'), contentType: 'text/xml' }], strayCalls),
    clock: fakeClock(),
    minGapMs: 0,
    skipRobots: true,
    bypassCache: true,
  }).search({ board: { ats: 'other', identifier: 'acmechem', board_url: 'https://acmechem.breezy.hr' } })
  check(
    "another ATS's board is refused without a request",
    strayCalls.length === 0 && stray.postings.length === 0 && stray.error === undefined && !!stray.note,
    `${strayCalls.length} request(s): ${stray.note ?? '(no note)'}`
  )

  // ── A missing tenant: 307 → personio.com. NOT a rate limit.
  resetPersonioThrottle()
  const redirectCalls: string[] = []
  const redirected = await personioSource({
    fetcher: personioStub([{ status: 307, body: '', contentType: '', redirectTo: 'https://personio.com' }], redirectCalls),
    clock: fakeClock(),
    minGapMs: 0,
    skipRobots: true,
    bypassCache: true,
  }).search({ board: { ats: 'other', identifier: 'zzznosuch', board_url: 'https://zzznosuch.jobs.personio.de' } })
  check('a 307 off the tenant host is "no such board", not an error', redirected.error === undefined && /no Personio board/.test(redirected.note ?? ''), redirected.note ?? '(no note)')
  check('the redirect target is named in the note', /personio\.com/.test(redirected.note ?? ''))

  // ── An HTML body from the feed URL is a checkpoint, not a feed.
  resetPersonioThrottle()
  const html = await personioSource({
    fetcher: personioStub([{ status: 200, body: '<!DOCTYPE html><title>Vercel Security Checkpoint</title>', contentType: 'text/html; charset=utf-8' }], []),
    clock: fakeClock(),
    minGapMs: 0,
    skipRobots: true,
    bypassCache: true,
  }).search({ board: { ats: 'other', identifier: P_TENANT, board_url: `https://${P_TENANT}.jobs.personio.de` } })
  check('an HTML body is detected by content-type and reported', !!html.error && /rather than the XML feed/.test(html.error ?? ''), html.error ?? '(no error)')

  // ── The throttle actually spaces requests. Virtual clock, no real waiting.
  resetPersonioThrottle()
  const gapClock = fakeClock()
  const gapCalls: string[] = []
  const gapSrc = personioSource({
    fetcher: personioStub([XML_OK(xml)], gapCalls),
    clock: gapClock,
    minGapMs: 4_000,
    skipRobots: true,
    bypassCache: true,
  })
  for (const tenant of ['a-fixture', 'b-fixture', 'c-fixture']) {
    await gapSrc.search({ board: { ats: 'other', identifier: tenant, board_url: `https://${tenant}.jobs.personio.de` } })
  }
  check('three requests were made', gapCalls.length === 3, `${gapCalls.length}`)
  check('the 2nd and 3rd waited the full gap', gapClock.sleeps.length === 2 && gapClock.sleeps.every((ms) => ms === 4_000), JSON.stringify(gapClock.sleeps))
  check('virtual time advanced by 2 gaps, not 0', gapClock.t === 8_000, `${gapClock.t} ms`)

  // A direct gate check: the reservation is made even when nothing sleeps.
  resetPersonioThrottle()
  const gateClock = fakeClock()
  const w1 = await personioGate(gateClock, 5_000, 60_000)
  const w2 = await personioGate(gateClock, 5_000, 60_000)
  check('the first call does not wait', w1 === 0)
  check('the second call waits exactly one gap', w2 === 5_000, String(w2))

  // ── A genuine 429 backs off and REFUSES the next call rather than retrying.
  resetPersonioThrottle()
  const rlClock = fakeClock()
  const rlCalls: string[] = []
  const rlSrc = personioSource({
    fetcher: personioStub([{ status: 429, body: '', contentType: 'text/html' }], rlCalls),
    clock: rlClock,
    minGapMs: 0,
    maxWaitMs: 5_000,
    skipRobots: true,
    bypassCache: true,
  })
  const rl1 = await rlSrc.search({ board: { ats: 'other', identifier: 'x-fixture', board_url: 'https://x-fixture.jobs.personio.de' } })
  check('a 429 from the tenant host is surfaced as an error', !!rl1.error && /rate-limited/.test(rl1.error ?? ''), rl1.error ?? '(no error)')
  check('the back-off is armed', personioThrottleState().backoffMs === 30_000, `${personioThrottleState().backoffMs} ms`)
  const rl2 = await rlSrc.search({ board: { ats: 'other', identifier: 'y-fixture', board_url: 'https://y-fixture.jobs.personio.de' } })
  check('the next call is refused, not retried into the wall', !!rl2.error && /backing off/.test(rl2.error ?? ''), rl2.error ?? '(no error)')
  check('and it made NO request', rlCalls.length === 1, `${rlCalls.length} request(s)`)
  check('the run is not held open by the wait', rlClock.sleeps.length === 0)
  resetPersonioThrottle()
}

// ─── Shared contracts ────────────────────────────────────────────────────────

async function testContracts() {
  console.log('\nAll four — the JobDiscoverySource contract')

  const sources: JobDiscoverySource[] = [recruiteeSource(), gemSource(), teamtailorSource(), personioSource()]
  for (const s of sources) {
    check(`${s.id}: sourceType is 'ats'`, s.sourceType === 'ats')
    check(`${s.id}: free, no env var`, s.costModel.kind === 'free' && s.costModel.envVar === undefined)
    check(`${s.id}: configured with no key`, s.isConfigured() === true)
    check(`${s.id}: declares givesDescription`, s.capabilities.givesDescription === true)
  }

  // Rule 1: `search` NEVER throws — for ANY fetcher, not just for `fetchJson`,
  // which happens never to reject. A fetcher that blows up must come back as an
  // `error` field with an empty page.
  const exploding = <T,>(): Promise<JsonFetchResult<T>> => Promise.reject(new Error('socket hang up'))
  const explodingXml = () => Promise.reject(new Error('socket hang up'))
  const board = { ats: 'other' as const, identifier: 'boom-fixture', board_url: 'https://boom-fixture.jobs.personio.de' }
  const blown: { id: string; res: Awaited<ReturnType<JobDiscoverySource['search']>> }[] = []
  for (const s of [
    recruiteeSource({ fetcher: exploding, skipRobots: true, bypassCache: true }),
    gemSource({ fetcher: exploding, skipRobots: true, bypassCache: true }),
    teamtailorSource({ fetcher: exploding, skipRobots: true, bypassCache: true }),
    personioSource({ fetcher: explodingXml, clock: fakeClock(), minGapMs: 0, skipRobots: true, bypassCache: true }),
  ]) {
    let res: Awaited<ReturnType<JobDiscoverySource['search']>>
    try {
      res = await s.search({ board })
    } catch (e) {
      check(`${s.id}: a rejecting fetcher is reported, never thrown`, false, e instanceof Error ? e.message : String(e))
      continue
    }
    blown.push({ id: s.id, res })
    check(`${s.id}: a rejecting fetcher is an error field, not a throw`, res.error === 'socket hang up' && res.postings.length === 0, res.error ?? '(none)')
  }
  check('all four sources survived a rejecting fetcher', blown.length === 4, `${blown.length} of 4`)

  const netErr = await recruiteeSource({
    fetcher: (<T,>() => Promise.resolve({ status: 0, data: null as T | null, error: 'timeout' })) as never,
    skipRobots: true,
    bypassCache: true,
  }).search({ board })
  check('a network failure is an error field with an empty page', netErr.error === 'timeout' && netErr.postings.length === 0, netErr.error ?? '(none)')

  resetPersonioThrottle()
}

async function main() {
  await testRecruitee()
  await testGem()
  await testTeamtailor()
  await testPersonio()
  await testContracts()
  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
