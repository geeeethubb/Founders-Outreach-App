// Offline checks for the paid Google Jobs source (lib/career/sources/dataforseo.ts).
//
// Every HTTP call is served from a fixture in evals/career/fixtures/ats/, so
// this suite needs no network, no key and no money. That is not only for speed:
// there is no DataForSEO account on this machine, so the fixtures ARE the
// specification this adapter was built against (they are hand-written to the
// documented shapes, and each one says so in its `_fixture` field).
//
// What matters most here is the third block. This is the only source in the app
// that spends money, and the two properties that keep that safe — a missing key
// is a silent skip, and a budget is checked BEFORE the task is posted — are
// exactly the two that a refactor would quietly break.
//
//   npx tsx scripts/test-career-dataforseo.ts

import fs from 'fs'
import path from 'path'
import {
  COST_PER_PAGE_USD,
  MAX_DEPTH,
  RESULTS_PER_PAGE,
  buildKeyword,
  buildTaskPostBody,
  clampDepth,
  dataForSeoCredentials,
  dataForSeoSource,
  decodeCursor,
  estimateCostUsd,
  parseDataForSeoTimestamp,
  pickApplyUrl,
  toRawPosting,
  type DataForSeoFetcher,
  type DataForSeoRequest,
  type DataForSeoResponse,
} from '../lib/career/sources/dataforseo'

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

const FIXTURES = path.join(process.cwd(), 'evals', 'career', 'fixtures', 'ats')
function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, `dataforseo-${name}.json`), 'utf8')
}

const CONFIGURED = { DATAFORSEO_LOGIN: 'founder@example.com', DATAFORSEO_PASSWORD: 'sekrit' }

/** A fetcher over the fixtures, with a log of what was asked for. */
function recorder(handler: (req: DataForSeoRequest) => DataForSeoResponse): {
  fetcher: DataForSeoFetcher
  calls: DataForSeoRequest[]
} {
  const calls: DataForSeoRequest[] = []
  return {
    calls,
    fetcher: async (req) => {
      calls.push(req)
      return handler(req)
    },
  }
}

function ok(body: string): DataForSeoResponse {
  return { ok: true, status: 200, body }
}

/** A clock the tests drive: `sleep` moves it, so polling is instant and deterministic. */
function clock(start = 1_756_600_000_000): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = start
  return { now: () => t, sleep: async (ms: number) => { t += ms } }
}

async function main(): Promise<void> {
  console.log('dataforseo: without a key, it is inert — never an error')
  // Never the default fetcher: no source built in this suite may be able to
  // reach api.dataforseo.com at all.
  const forbidden: DataForSeoFetcher = async (req) => {
    throw new Error(`offline suite attempted a real request: ${req.method} ${req.url}`)
  }
  const unset = dataForSeoSource({ env: {}, fetcher: forbidden })
  check('isConfigured is false with no env vars', unset.isConfigured() === false)
  check('the cost model names the env var to set', unset.costModel.envVar === 'DATAFORSEO_LOGIN' && unset.costModel.kind === 'per_request', JSON.stringify(unset.costModel))
  check('a login without a password is NOT configured', dataForSeoCredentials({ DATAFORSEO_LOGIN: 'x' }) === null)
  check('both halves make it configured', dataForSeoCredentials(CONFIGURED)?.login === 'founder@example.com')
  const skipped = await unset.search({ query: 'process engineering internship' })
  check('search on an unconfigured source returns empty and exhausted', skipped.postings.length === 0 && skipped.exhausted)
  check('…with NO error — a missing optional key must not colour the run', skipped.error === undefined, skipped.error ?? 'none')
  check('…and a note naming both env vars', /DATAFORSEO_LOGIN/.test(skipped.note ?? '') && /DATAFORSEO_PASSWORD/.test(skipped.note ?? ''), skipped.note ?? '')
  check('it spends nothing and makes no request', skipped.costUsd === 0 && skipped.requests === 0)
  const unsetHealth = await unset.healthCheck()
  check('health says which key is missing rather than throwing', !unsetHealth.ok && /DATAFORSEO_LOGIN/.test(unsetHealth.detail), unsetHealth.detail)
  // The spy must be INSIDE the source. An earlier version of this check built a
  // recorder and never wired it to anything, so it asserted on a log nothing
  // could write to — and, worse, the `search` beside it was running on a source
  // holding the DEFAULT fetcher, one credential-check regression away from
  // issuing a real request to api.dataforseo.com from an offline suite.
  const probe = recorder(() => ok(fixture('task-post')))
  const unsetWithSpy = dataForSeoSource({ env: {}, fetcher: probe.fetcher })
  await unsetWithSpy.search({ query: 'x' })
  await unsetWithSpy.healthCheck()
  check('an unconfigured source touches the network zero times', probe.calls.length === 0, `${probe.calls.length} requests`)

  console.log('\ndataforseo: the task body, as documented')
  const body = buildTaskPostBody({ query: 'process engineering', titleTerms: ['intern', 'co-op'], internshipsOnly: true, limit: 100 })[0]
  check('the body is one task in an array', Array.isArray(buildTaskPostBody({})) && buildTaskPostBody({}).length === 1)
  check("employment_type is ['intern'] — the structured filter this provider was chosen for", JSON.stringify(body.employment_type) === '["intern"]', JSON.stringify(body.employment_type))
  check('the keyword carries the query and OR-ed title terms', body.keyword === 'process engineering (intern OR co-op)', String(body.keyword))
  check('language_code defaults to en', body.language_code === 'en')
  check('location_code defaults to the United States', body.location_code === 2840 && body.location_name === undefined)
  const located = buildTaskPostBody({ location: 'Houston,Texas,United States' })[0]
  check('a named location replaces the code — never both, which this API rejects', located.location_name === 'Houston,Texas,United States' && located.location_code === undefined)
  const noFilter = buildTaskPostBody({ internshipsOnly: false })[0]
  check('internshipsOnly:false drops the filter rather than searching the word "intern"', noFilter.employment_type === undefined)
  check('a keyword is never empty', buildKeyword({}) === 'internship')
  check('a 700-char keyword cap is enforced', buildKeyword({ query: 'x'.repeat(900) }).length <= 700, String(buildKeyword({ query: 'x'.repeat(900) }).length))

  console.log('\ndataforseo: depth is clamped to 200 and billed per 10-result page')
  check('a request for 500 clamps to the documented maximum', clampDepth(500) === MAX_DEPTH, String(clampDepth(500)))
  check('a request for 1 rounds up to one billed page', clampDepth(1) === RESULTS_PER_PAGE, String(clampDepth(1)))
  check('a request for 95 rounds up to 100 — you pay for the page either way', clampDepth(95) === 100, String(clampDepth(95)))
  check('0 and nonsense fall back to the default', clampDepth(0) === 100 && clampDepth(undefined) === 100 && clampDepth(NaN) === 100)
  check('the depth in the body is clamped, not passed through', buildTaskPostBody({ limit: 5000 })[0].depth === MAX_DEPTH, String(buildTaskPostBody({ limit: 5000 })[0].depth))
  check('200 results cost $0.012, 100 cost $0.006', Math.abs(estimateCostUsd(200) - 0.012) < 1e-9 && Math.abs(estimateCostUsd(100) - 0.006) < 1e-9, `${estimateCostUsd(200)} / ${estimateCostUsd(100)}`)
  check('the per-page price is the standard-queue price', COST_PER_PAGE_USD === 0.0006)

  console.log('\ndataforseo: a completed task')
  const happy = recorder((req) => ok(req.method === 'POST' ? fixture('task-post') : fixture('task-get-advanced')))
  const c1 = clock()
  const src = dataForSeoSource({ env: CONFIGURED, fetcher: happy.fetcher, ...c1, depth: 100 })
  check('isConfigured is true with both env vars', src.isConfigured())
  const res = await src.search({ query: 'process engineering internship', internshipsOnly: true })
  check('it posts a task and then polls for it', happy.calls.length === 2 && happy.calls[0].method === 'POST' && happy.calls[1].method === 'GET', String(happy.calls.length))
  check('the poll addresses task_get/advanced/{id}', /\/v3\/serp\/google\/jobs\/task_get\/advanced\/08311200-1234-0139-0000-c0ffee000001$/.test(happy.calls[1].url), happy.calls[1].url)
  const auth = happy.calls[0].headers.authorization ?? ''
  check('HTTP Basic auth is built from login:password', auth.startsWith('Basic ') && Buffer.from(auth.slice(6), 'base64').toString('utf8') === 'founder@example.com:sekrit')
  check('seen counts what the SERP returned, before filtering', res.seen === 4, String(res.seen))
  check('non-job SERP rows are dropped, and the note says how many', res.postings.length === 3 && /1 SERP rows were not job cards/.test(res.note ?? ''), `${res.postings.length} · ${res.note ?? ''}`)
  check('one completed task is one exhausted answer', res.exhausted && res.nextCursor === null)
  check('costUsd is the price the provider charged', Math.abs((res.costUsd ?? 0) - 0.006) < 1e-9, String(res.costUsd))
  check('requests counts the post and the poll', res.requests === 2, String(res.requests))

  const merck = res.postings.find((p) => p.company_name === 'Merck')
  check('a Workday apply link is kept as the canonical URL', merck?.canonical_url?.includes('msd.wd5.myworkdayjobs.com') === true, merck?.canonical_url ?? 'null')
  check('…and its ATS family is recognised', merck?.ats_type === 'workday', merck?.ats_type ?? 'null')
  check("…so its source_type is web_search, which downstream does NOT null the URL for", merck?.source_type === 'web_search', merck?.source_type ?? '')
  check('the description arrives with the result — no second fetch', (merck?.description_text?.length ?? 0) > 300, String(merck?.description_text?.length))
  check('posted_at is parsed to ISO', merck?.posted_at === '2026-08-27T00:00:00.000Z', merck?.posted_at ?? 'null')
  check('the SERP job_id is kept as the external id', (merck?.external_id ?? '').length > 10)
  check('the ATS host is NOT recorded as the company domain', merck?.company_domain === null, merck?.company_domain ?? 'null')
  check('every apply option survives in raw, for provenance', ((merck?.raw.dataforseo as { apply_urls: string[] }).apply_urls ?? []).length === 2)

  const dupont = res.postings.find((p) => p.company_name === 'DuPont')
  check("an Oracle Fusion link is first-party too, as ats 'other'", dupont?.ats_type === 'other' && dupont?.canonical_url?.includes('oraclecloud.com') === true, `${dupont?.ats_type} ${dupont?.canonical_url}`)

  const corning = res.postings.find((p) => p.company_name === 'Corning')
  check('a card with only an aggregator link is typed aggregator', corning?.source_type === 'aggregator', corning?.source_type ?? '')
  check('…and claims no canonical URL, because it has not been followed', corning?.canonical_url === null)
  check('…while the apply link is still kept for a human to click', corning?.apply_url?.includes('linkedin.com') === true, corning?.apply_url ?? 'null')

  // The employer's own careers page is FIRST-PARTY even though no adapter
  // recognises whatever runs behind it. This is the majority case in the live
  // corpus (lifeattiktok.com, jobs.bytedance.com, www.tesla.com, amazon.jobs),
  // and typing it 'aggregator' would make scout/extract.ts strip apply_url off
  // a result that was paid for — arriving with no link at all.
  const employerHosted = toRawPosting(
    { title: 'Process Engineering Intern', employer_name: 'Merck', apply_urls: ['https://careers.merck.com/us/en/job/R123'] },
    { check_url: 'https://www.google.com/search?ibp=htl;jobs' },
    new Date().toISOString()
  )
  check(
    'an employer careers page is first-party, not an aggregator',
    employerHosted?.source_type === 'web_search',
    `${employerHosted?.source_type} · ats ${employerHosted?.ats_type}`
  )
  check(
    '…so its canonical URL survives the all-aggregator rule in extract.ts',
    employerHosted?.canonical_url === 'https://careers.merck.com/us/en/job/R123' && employerHosted?.apply_url === 'https://careers.merck.com/us/en/job/R123',
    `${employerHosted?.canonical_url}`
  )
  check('…and the employer host IS the company domain, since it is not an ATS host', employerHosted?.company_domain === 'careers.merck.com', employerHosted?.company_domain ?? 'null')
  const googleOnly = toRawPosting(
    { title: 'Process Engineering Intern', employer_name: 'Corning', apply_urls: ['https://www.linkedin.com/jobs/view/1'] },
    {},
    new Date().toISOString()
  )
  check('an aggregator-only card is still typed aggregator with no canonical URL', googleOnly?.source_type === 'aggregator' && googleOnly?.canonical_url === null, googleOnly?.source_type ?? '')

  console.log('\ndataforseo: a task that is not ready hands back a resumable cursor')
  const queued = recorder((req) => ok(req.method === 'POST' ? fixture('task-post') : fixture('task-queued')))
  const pending = dataForSeoSource({ env: CONFIGURED, fetcher: queued.fetcher, ...clock(), depth: 100, deadlineMs: 10_000 })
  const p1 = await pending.search({ query: 'process engineering internship' })
  check('"Task In Queue" is not an error', p1.error === undefined, p1.error ?? 'none')
  check('the run is not held open — it returns with no postings', p1.postings.length === 0 && p1.exhausted === false)
  check('a cursor comes back naming the task', decodeCursor(p1.nextCursor)?.task === '08311200-1234-0139-0000-c0ffee000001', p1.nextCursor ?? 'null')
  check('the cursor carries the spend, so a budget survives the resume', (decodeCursor(p1.nextCursor)?.spentUsd ?? 0) > 0, String(decodeCursor(p1.nextCursor)?.spentUsd))
  check('the note explains what to do', /resume with the cursor/.test(p1.note ?? ''), p1.note ?? '')
  check('polling backs off rather than hammering', queued.calls.length >= 2 && queued.calls.length <= 6, `${queued.calls.length} requests`)
  check('the task was charged once, at post time', Math.abs((p1.costUsd ?? 0) - 0.006) < 1e-9, String(p1.costUsd))

  // `now` and `sleep` are both injectable and nothing couples them. A frozen
  // clock with a no-op sleep is the worst case: the deadline never arrives and
  // the wait costs nothing, so the ONLY thing that can stop the loop is a hard
  // iteration cap. Without one this spins against a live API until the process
  // dies (it does, reproducibly, in about 150 seconds).
  const spin = recorder((req) => ok(req.method === 'POST' ? fixture('task-post') : fixture('task-queued')))
  const frozen = dataForSeoSource({
    env: CONFIGURED,
    fetcher: spin.fetcher,
    now: () => 0,
    sleep: async () => {},
    depth: 100,
  })
  const p0 = await frozen.search({ query: 'process engineering internship' })
  check(
    'a frozen clock and a no-op sleep cannot produce a tight request loop',
    spin.calls.length <= 12 && p0.exhausted === false && !!p0.nextCursor,
    `${spin.calls.length} requests`
  )

  const resumeFetch = recorder(() => ok(fixture('task-get-advanced')))
  const resumed = dataForSeoSource({ env: CONFIGURED, fetcher: resumeFetch.fetcher, ...clock(), deadlineMs: 10_000 })
  const p2 = await resumed.search({ query: 'process engineering internship' }, p1.nextCursor)
  check('resuming the cursor fetches the result without posting a second task', resumeFetch.calls.every((c) => c.method === 'GET'), resumeFetch.calls.map((c) => c.method).join(','))
  check('…and pays nothing the second time', p2.costUsd === 0, String(p2.costUsd))
  check('…and returns the postings', p2.postings.length === 3 && p2.exhausted, String(p2.postings.length))

  console.log('\ndataforseo: the budget is enforced BEFORE the money is spent')
  const budgeted = recorder((req) => ok(req.method === 'POST' ? fixture('task-post') : fixture('task-get-advanced')))
  const capped = dataForSeoSource({ env: CONFIGURED, fetcher: budgeted.fetcher, ...clock(), depth: 100, budgetUsd: 0.006 })
  const b1 = await capped.search({ query: 'a' })
  check('the first task fits the budget and runs', b1.postings.length === 3 && Math.abs((b1.costUsd ?? 0) - 0.006) < 1e-9, String(b1.costUsd))
  const callsAfterFirst = budgeted.calls.length
  const b2 = await capped.search({ query: 'b' })
  check('the second task is REFUSED before it is posted', budgeted.calls.length === callsAfterFirst, `${budgeted.calls.length - callsAfterFirst} extra requests`)
  check('…as an exhausted, error-free result with a note', b2.exhausted && b2.error === undefined && /budget/.test(b2.note ?? ''), b2.note ?? '')
  check('…that spends nothing', b2.costUsd === 0 && b2.requests === 0)
  const perCall = dataForSeoSource({ env: CONFIGURED, fetcher: budgeted.fetcher, ...clock(), depth: 200 })
  const b3 = await perCall.search({ query: 'c', extra: { budgetUsd: 0.001 } })
  check('a per-call budget from the caller is honoured too', b3.costUsd === 0 && /budget/.test(b3.note ?? ''), b3.note ?? '')
  const b4 = await perCall.search({ query: 'c', extra: { budgetUsd: 0.05 } })
  check('…and a larger ceiling lets the same call through', (b4.costUsd ?? 0) > 0, String(b4.costUsd))

  // The per-call hint may only TIGHTEN. `extra` is documented as free-form and
  // never load-bearing, so it must not be able to raise a ceiling the
  // constructor set — otherwise the one number protecting the founder from an
  // unbounded bill is writable by any caller that guesses the key.
  const raiseFetch = recorder((req) => ok(req.method === 'POST' ? fixture('task-post') : fixture('task-get-advanced')))
  const hardCapped = dataForSeoSource({ env: CONFIGURED, fetcher: raiseFetch.fetcher, ...clock(), depth: 200, budgetUsd: 0.006 })
  const b5 = await hardCapped.search({ query: 'd', extra: { budgetUsd: 999 } })
  check(
    'a caller cannot RAISE the configured ceiling — the tighter of the two wins',
    b5.costUsd === 0 && b5.requests === 0 && raiseFetch.calls.length === 0 && /budget/.test(b5.note ?? ''),
    `${raiseFetch.calls.length} requests · ${b5.note ?? ''}`
  )
  const tighten = dataForSeoSource({ env: CONFIGURED, fetcher: raiseFetch.fetcher, ...clock(), depth: 100, budgetUsd: 1 })
  const b6 = await tighten.search({ query: 'e', extra: { budgetUsd: 0.0001 } })
  check('…while it can still tighten one', b6.costUsd === 0 && /budget/.test(b6.note ?? ''), b6.note ?? '')
  const b7 = await tighten.search({ query: 'f', extra: { budgetUsd: 'lots' as unknown as number } })
  check('…and a non-numeric hint is ignored rather than disabling the ceiling', (b7.costUsd ?? 0) > 0, String(b7.costUsd))

  console.log('\ndataforseo: every failure is an error field, never a throw')
  const unauthorized = dataForSeoSource({
    env: CONFIGURED,
    fetcher: async () => ({ ok: false, status: 401, body: fixture('error-auth') }),
    ...clock(),
  })
  const e1 = await unauthorized.search({ query: 'x' })
  check('a 401 becomes an error, not an exception', !!e1.error && e1.postings.length === 0, e1.error ?? '')
  check('…and the message names the credentials to check', /DATAFORSEO_LOGIN/.test(e1.error ?? ''), e1.error ?? '')
  check('…and reports the request it paid for making', e1.requests === 1 && e1.costUsd === 0)

  const malformed = dataForSeoSource({ env: CONFIGURED, fetcher: async () => ok('{not json'), ...clock() })
  const e2 = await malformed.search({ query: 'x' })
  check('malformed JSON is an error, not a crash', /malformed JSON/.test(e2.error ?? ''), e2.error ?? '')

  const thrown = dataForSeoSource({
    env: CONFIGURED,
    fetcher: async () => {
      throw new Error('socket hang up')
    },
    ...clock(),
  })
  const e3 = await thrown.search({ query: 'x' })
  check('a fetcher that throws is caught', /socket hang up/.test(e3.error ?? ''), e3.error ?? '')

  const brokenPoll = recorder((req) => (req.method === 'POST' ? ok(fixture('task-post')) : { ok: false, status: 502, body: 'bad gateway' }))
  const e4src = dataForSeoSource({ env: CONFIGURED, fetcher: brokenPoll.fetcher, ...clock(), deadlineMs: 5_000 })
  const e4 = await e4src.search({ query: 'x' })
  check('a failing poll keeps the receipt: an error AND a resumable cursor', !!e4.error && decodeCursor(e4.nextCursor)?.task !== undefined && e4.exhausted === false, `${e4.error} / ${e4.nextCursor}`)

  console.log('\ndataforseo: parsing oddities')
  check('a timestamp with an offset becomes ISO', parseDataForSeoTimestamp('2026-08-01 09:30:00 +00:00') === '2026-08-01T09:30:00.000Z')
  check('an empty or unparseable timestamp is null', parseDataForSeoTimestamp(null) === null && parseDataForSeoTimestamp('4 days ago') === null)
  check('an item with no employer is skipped, not thrown on', toRawPosting({ title: 'x' }, {}, new Date().toISOString()) === null)
  check('a bare string apply_urls array is read', pickApplyUrl({ apply_urls: ['https://boards.greenhouse.io/acme/jobs/1'] }).ats === 'greenhouse')
  check('an {title,url} apply option is read', pickApplyUrl({ apply_urls: [{ title: 'Apply', url: 'https://jobs.lever.co/acme/1' }] }).ats === 'lever')
  check('a first-party link wins over an aggregator link regardless of order', pickApplyUrl({ apply_urls: ['https://www.linkedin.com/jobs/view/1', 'https://jobs.ashbyhq.com/acme/1'] }).ats === 'ashby')
  check('an employer host beats an aggregator link', pickApplyUrl({ apply_urls: ['https://www.indeed.com/viewjob?jk=1', 'https://careers.merck.com/job/1'] }).url === 'https://careers.merck.com/job/1')
  check('an aggregator link is still kept when it is all there is', pickApplyUrl({ apply_urls: ['https://www.indeed.com/viewjob?jk=1'] }).url === 'https://www.indeed.com/viewjob?jk=1')
  check('no link at all is null, not a throw', pickApplyUrl({}).url === null)
  check('garbage in apply_urls is ignored', pickApplyUrl({ apply_urls: [42, null, 'not a url'] }).url === null)
  check('a decoded cursor rejects junk', decodeCursor('nonsense') === null && decodeCursor(null) === null && decodeCursor('{"v":9}') === null)

  console.log('\ndataforseo: what it declares about itself')
  check('it is a paid search source', src.sourceType === 'search' && src.costModel.kind === 'per_request')
  check('it promises descriptions — the reason it is worth its price', src.capabilities.givesDescription)
  check('it does not promise a canonical URL it may not have', !src.capabilities.givesCanonicalUrl)
  check('it does not claim a `since` filter this endpoint has no parameter for', !src.capabilities.supportsSince)
  check('it supports query and location', src.capabilities.supportsQuery && src.capabilities.supportsLocation)

  const healthy = dataForSeoSource({ env: CONFIGURED, fetcher: async () => ok(fixture('user-data')), ...clock() })
  const h = await healthy.healthCheck()
  check('health reports the account balance from the free endpoint', h.ok && /49\.87/.test(h.detail), h.detail)
  const sickly = dataForSeoSource({ env: CONFIGURED, fetcher: async () => ({ ok: false, status: 401, body: fixture('error-auth') }), ...clock() })
  const h2 = await sickly.healthCheck()
  check('an unhealthy account says why, and does not throw', !h2.ok && /authentication/.test(h2.detail), h2.detail)

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
