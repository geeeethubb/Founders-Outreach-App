// Offline checks for the Simplify / Pitt CSC feed source.
//
// The corpus is injected, never fetched, so this suite needs no network. The
// fixtures mirror the real file's schema exactly (verified against the live
// 14,964-record listings.json on 2026-08-31 — see docs/JOB_SOURCE_MATRIX.md).

import {
  SIMPLIFY_PAGE_SIZE,
  atsFromUrl,
  clearSimplifyCache,
  isOpen,
  looksLikeInternship,
  matchesSeason,
  primeSimplifyCache,
  simplifySource,
  toRawPosting,
  type SimplifyListing,
} from '../lib/career/sources/simplify'

let passed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failures.push(`${name} — ${detail}`)
    console.log(`  FAIL ${name} — ${detail}`)
  }
}

const DAY = 86_400
const NOW = Math.floor(Date.parse('2026-08-31T00:00:00Z') / 1000)

function listing(over: Partial<SimplifyListing> = {}): SimplifyListing {
  return {
    source: 'Simplify',
    category: 'Hardware',
    company_name: 'Acme Chemicals',
    id: `id-${Math.random().toString(16).slice(2)}`,
    title: 'Process Engineering Intern',
    active: true,
    terms: ['Summer 2027'],
    date_updated: NOW,
    date_posted: NOW,
    url: 'https://boards.greenhouse.io/acme/jobs/1',
    locations: ['Houston, TX'],
    company_url: 'https://simplify.jobs/c/Acme',
    is_visible: true,
    sponsorship: 'Other',
    degrees: [],
    ...over,
  }
}

async function main(): Promise<void> {
  console.log('simplify: what counts as open')
  check('an active, visible listing is open', isOpen(listing()))
  check('active:false is closed — the file\'s own marker for 12,680 of 14,964 rows', !isOpen(listing({ active: false })))
  check('is_visible:false is closed too', !isOpen(listing({ is_visible: false })))

  console.log('\nsimplify: the season is stated, not guessed')
  check('Summer 2027 matches', matchesSeason(listing(), 'Summer 2027'))
  check('Fall 2026 does not match a Summer 2027 filter', !matchesSeason(listing({ terms: ['Fall 2026'] }), 'Summer 2027'))
  check('an underscored season still matches', matchesSeason(listing(), 'summer_2027'))
  check('no season filter keeps everything', matchesSeason(listing({ terms: ['Winter 2027'] }), null))
  check('internship shape is recognised', looksLikeInternship(listing()) && looksLikeInternship(listing({ title: 'Co-Op Engineer', terms: [] })))

  console.log('\nsimplify: the URL is the point — ATS tenants come free')
  const cases: [string, string][] = [
    ['https://boards.greenhouse.io/x/jobs/1', 'greenhouse'],
    ['https://jobs.lever.co/x/abc', 'lever'],
    ['https://jobs.ashbyhq.com/x/abc', 'ashby'],
    ['https://careers.smartrecruiters.com/X/1', 'smartrecruiters'],
    ['https://apply.workable.com/x/j/ABC/', 'workable'],
    ['https://nvidia.wd5.myworkdayjobs.com/en-US/Site/job/X', 'workday'],
  ]
  for (const [url, want] of cases) check(`${want} recognised from its URL`, atsFromUrl(url).ats === want, atsFromUrl(url).ats ?? 'null')
  // Recognised-but-unadapted families are kept as careers pages so the tenant survives for later.
  for (const host of ['egug.fa.us2.oraclecloud.com', 'careers-sig.icims.com', 'x.taleo.net']) {
    const r = atsFromUrl(`https://${host}/job/1`)
    check(`${host.split('.')[1] ?? host} is kept as a careers page, not dropped`, r.ats === 'other' && r.sourceType === 'careers_page', `${r.ats}/${r.sourceType}`)
  }

  console.log('\nsimplify: normalizing a row')
  const raw = toRawPosting(listing())
  check('a posting carries its canonical employer URL', raw?.canonical_url === 'https://boards.greenhouse.io/acme/jobs/1')
  check('the apply URL is the same first-party link', raw?.apply_url === raw?.canonical_url)
  check('description is null — the feed has none, and that is expected', raw?.description_text === null)
  check('the season and category survive as provenance', Array.isArray((raw?.raw.simplify as { terms: string[] }).terms))
  check('posted_at is an ISO date, not a unix stamp', typeof raw?.posted_at === 'string' && raw!.posted_at!.includes('T'))
  check('a row missing a title or url is skipped, not thrown on', toRawPosting(listing({ title: '' })) === null && toRawPosting(listing({ url: '' })) === null)

  console.log('\nsimplify: searching and paging a corpus')
  const corpus: SimplifyListing[] = [
    ...Array.from({ length: 250 }, (_, i) => listing({ id: `open-${i}`, company_name: `Company ${i % 40}` })),
    ...Array.from({ length: 60 }, (_, i) => listing({ id: `closed-${i}`, active: false })),
    ...Array.from({ length: 30 }, (_, i) => listing({ id: `fall-${i}`, terms: ['Fall 2026'] })),
    listing({ id: 'sw', title: 'Software Engineer Intern', category: 'Software', company_name: 'Bytes Inc' }),
    listing({ id: 'old', date_updated: NOW - 40 * DAY, date_posted: NOW - 40 * DAY, company_name: 'Stale Co' }),
  ]
  primeSimplifyCache(corpus)
  const src = simplifySource()

  const health = await src.healthCheck()
  // Health counts what is OPEN, across every season — 250 + 30 Fall + 2 extras.
  // The season filter belongs to `search`, not to "is this feed alive".
  check('health reports the corpus size and how much is open', health.ok && /342 listings, 282 open/.test(health.detail), health.detail)

  const first = await src.search({ internshipsOnly: true })
  check('seen counts everything that matched, not just this page', first.seen === 252, String(first.seen))
  check('a page is capped at the page size', first.postings.length === SIMPLIFY_PAGE_SIZE, String(first.postings.length))
  check('a cursor is offered while more remain', first.nextCursor === String(SIMPLIFY_PAGE_SIZE) && !first.exhausted)

  let cursor: string | null = first.nextCursor
  let total = first.postings.length
  let pages = 1
  while (cursor && pages < 10) {
    const next = await src.search({ internshipsOnly: true }, cursor)
    total += next.postings.length
    cursor = next.nextCursor
    pages++
  }
  check('paging reaches every matching posting exactly once', total === 252, `${total} over ${pages} pages`)
  check('the last page says it is exhausted', cursor === null)

  const closed = (await src.search({ internshipsOnly: true, limit: 400 })).postings
  check('closed listings never appear', !closed.some((p) => String(p.external_id).startsWith('closed-')))
  check('a different season never appears', !closed.some((p) => String(p.external_id).startsWith('fall-')))

  const byTerm = await src.search({ titleTerms: ['software'], limit: 50 })
  check('title terms narrow the result', byTerm.seen === 1 && byTerm.postings[0]?.company_name === 'Bytes Inc', String(byTerm.seen))

  const byLocation = await src.search({ location: 'Houston', limit: 10 })
  check('location narrows the result', byLocation.seen > 0, String(byLocation.seen))
  const elsewhere = await src.search({ location: 'Reykjavik', limit: 10 })
  check('a location with nothing returns empty and exhausted, not an error', elsewhere.seen === 0 && elsewhere.exhausted && !elsewhere.error)

  const recent = await src.search({ since: new Date((NOW - 7 * DAY) * 1000).toISOString(), limit: 400 })
  check('since excludes the stale row', !recent.postings.some((p) => p.company_name === 'Stale Co'), String(recent.seen))

  console.log('\nsimplify: failure degrades, it does not throw')
  clearSimplifyCache()
  const broken = simplifySource({ fetcher: async () => ({ ok: false, status: 503, body: '', error: 'upstream down' }) })
  const failed = await broken.search({})
  check('a dead upstream reports an error and returns no postings', failed.postings.length === 0 && !!failed.error && failed.exhausted, failed.error ?? '')
  const health2 = await broken.healthCheck()
  check('health says why rather than throwing', !health2.ok && /could not read/.test(health2.detail), health2.detail)

  clearSimplifyCache()
  const malformed = simplifySource({ fetcher: async () => ({ ok: true, status: 200, body: '{not json' }) })
  const bad = await malformed.search({})
  check('malformed JSON is an error, not a crash', !!bad.error && bad.postings.length === 0, bad.error ?? '')

  console.log('\nsimplify: it is free and needs no key')
  check('the source is always configured', src.isConfigured() && src.costModel.kind === 'free')
  check('it declares itself a pull feed with canonical URLs and no descriptions',
    src.sourceType === 'feed' && src.capabilities.givesCanonicalUrl && !src.capabilities.givesDescription)

  clearSimplifyCache()
  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) {
    console.log(failures.map((f) => `  - ${f}`).join('\n'))
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
