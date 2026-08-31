// Offline checks for the two Oracle adapters: Recruiting Cloud (ORC/Fusion)
// and Taleo.
//
//   npx tsx scripts/test-career-oracle-taleo.ts
//
// No network and no keys. Every payload under evals/career/fixtures/ats/ is a
// RECORDED response, fetched live on 2026-08-31. The nine JSON files are whole
// responses, byte for byte; the three HTML files are EXCERPTS of pages between
// 25 KB and 252 KB, and each one says in its own header comment what was cut:
//
//   oracle-sites.json        eeho.fa.us2.oraclecloud.com — 6 sites, 1 active
//   oracle-sites-multi.json  hcwp.fa.us2.oraclecloud.com — 23 sites, 22 active
//                            (one employer, 22 REGIONAL boards)
//   oracle-list.json/-page2  Coherent CX_1, offsets 0 and 25 of 267
//   oracle-detail.json       Coherent requisition 2011324 "Process Engineer"
//   taleo-list.json          cu.taleo.net, 712 requisitions, linkedColumn 0
//   taleo-list-lbl.json      lbl.taleo.net — linkedColumn 1, contest no at 0
//   taleo-list-bae.json      baesystems.taleo.net — ONE column, no locations
//   taleo-unavailable.json   HTTP 200 + JSON + careerSectionUnAvailable: true
//   taleo-error-page.html    EXCERPT — jacobs.taleo.net error page, HTTP 200
//                            (a 25 KB CSS reset removed)
//   taleo-portal-page.html   EXCERPT — massanf.taleo.net /careersection/ex/
//                            jobsearch.ftl, the 4 KB window around the inline
//                            script that carries the portal id
//   taleo-detail.html        EXCERPT — cu.taleo.net jobdetail.ftl?job=40970,
//                            a 6 KB window of a 252 KB page; the fixture that
//                            proves the detail page is keyed on contestNo
//
// The two tests that matter most are the ones a plausible implementation gets
// wrong: `limit`/`offset` living INSIDE Oracle's finder string, and Taleo's
// positional columns resolved through `linkedColumn` rather than hardcoded —
// Berkeley Lab would otherwise be filed under the job title "107409".

import fs from 'fs'
import os from 'os'
import path from 'path'

// The adapters cache through lib/providers/cache, which reads its root ONCE at
// import time. Point it at a throwaway directory BEFORE anything imports it, or
// this suite's fixture responses land in the real cache keyed by real URLs and
// the next live run replays them.
process.env.PROVIDER_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-taleo-cache-'))
process.env.CAREER_SKIP_ROBOTS = '1'

const FIX = path.join(process.cwd(), 'evals', 'career', 'fixtures', 'ats')

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

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIX, name), 'utf8')
}

function readJson<T>(name: string): T {
  return JSON.parse(readFixture(name)) as T
}

async function main(): Promise<void> {
  // `--live` runs INSTEAD of the offline suite, not after it. The offline suite
  // writes its fixture responses into the cache under the real URLs it is
  // imitating, so a live run in the same process would read a synthetic
  // 3-site tenant back and report it as the truth. (That is the whole reason
  // PROVIDER_CACHE_DIR is redirected above; the isolation is real but it is
  // per-process, and CACHE_ROOT is captured at import.)
  if (process.argv.includes('--live')) {
    await live()
    return
  }

  const oracle = await import('../lib/career/sources/oracle-orc')
  const taleo = await import('../lib/career/sources/taleo')
  type OracleFetcher = import('../lib/career/sources/oracle-orc').OracleFetcher
  type OracleListResponse = import('../lib/career/sources/oracle-orc').OracleListResponse
  type OracleSitesResponse = import('../lib/career/sources/oracle-orc').OracleSitesResponse
  type OracleRequisition = import('../lib/career/sources/oracle-orc').OracleRequisition
  type TaleoFetcher = import('../lib/career/sources/taleo').TaleoFetcher
  type TaleoRequest = import('../lib/career/sources/taleo').TaleoRequest
  type TaleoSearchResponse = import('../lib/career/sources/taleo').TaleoSearchResponse

  const HOST = 'hcwp.fa.us2.oraclecloud.com'
  const sitesEeho = readFixture('oracle-sites.json')
  const sitesMulti = readFixture('oracle-sites-multi.json')
  const listPage1 = readFixture('oracle-list.json')
  const listPage2 = readFixture('oracle-list-page2.json')
  const detailJson = readFixture('oracle-detail.json')
  const ORACLE_CT = 'application/vnd.oracle.adf.resourcecollection+json'

  // ── Oracle: the finder string ─────────────────────────────────────────────
  console.log('oracle: limit and offset go INSIDE the finder, not beside it')
  const finder = oracle.buildFinder({ siteNumber: 'CX_1', limit: 25, offset: 50 })
  check('the finder names the site, the window and the sort', finder === 'findReqs;siteNumber=CX_1,limit=25,offset=50,sortBy=POSTING_DATES_DESC', finder)
  const listUrl = oracle.oracleListUrl(HOST, { siteNumber: 'CX_1', limit: 25, offset: 50 })
  check('the URL carries the finder verbatim', listUrl.includes(`finder=${finder}`))
  check(
    'limit and offset appear ONLY inside the finder — as top-level params Oracle ignores them and every page repeats page 1',
    !/[?&]limit=/.test(listUrl) && !/[?&]offset=/.test(listUrl),
    listUrl
  )
  check('secondary locations are expanded, or multi-site postings lose every location but one',
    listUrl.includes('expand=requisitionList.secondaryLocations'))
  const withKeyword = oracle.buildFinder({ siteNumber: 'CX_1', limit: 25, offset: 0, keyword: 'process engineer' })
  check('a keyword rides inside the finder too, before the window', /keyword=process%20engineer,limit=25,offset=0/.test(withKeyword), withKeyword)
  const detailUrl = oracle.oracleDetailUrl({ host: HOST, siteNumber: 'CX_1' }, '2011324')
  check('the detail finder QUOTES the id — unquoted, Oracle answers with an empty list', detailUrl.includes('Id="2011324",siteNumber=CX_1'), detailUrl)

  // ── Oracle: ORA_ACTIVE ────────────────────────────────────────────────────
  console.log('\noracle: site discovery is public, and most of what it returns is junk')
  const eeho = readJson<OracleSitesResponse>('oracle-sites.json')
  const activeEeho = oracle.activeOracleSites(eeho.items)
  check('Oracle\'s own tenant publishes 6 sites and exactly 1 is live', (eeho.items ?? []).length === 6 && activeEeho.length === 1,
    `${(eeho.items ?? []).length} → ${activeEeho.length}`)
  const dropped = (eeho.items ?? []).filter((s) => s.StatusCode !== 'ORA_ACTIVE').map((s) => s.SiteName ?? '')
  check('the five dropped sites are reference copies, not career sites',
    dropped.some((n) => /FOR REFERENCE ONLY/i.test(n)) && dropped.some((n) => /DO NOT UPDATE/i.test(n)),
    dropped.slice(0, 2).join(' | '))
  const multi = readJson<OracleSitesResponse>('oracle-sites-multi.json')
  const activeMulti = oracle.activeOracleSites(multi.items)
  check('a real employer tenant is the other way round — 22 of Coherent\'s 23 sites are live',
    (multi.items ?? []).length === 23 && activeMulti.length === 22, `${(multi.items ?? []).length} → ${activeMulti.length}`)
  check('the site name is the company name, free', (activeMulti[0].SiteName ?? '').startsWith('Coherent'), String(activeMulti[0].SiteName))

  // ── Oracle: ONE employer per host ─────────────────────────────────────────
  console.log('\noracle: 22 sites on one host are ONE employer\'s regional boards, not 22 employers')
  const employer = oracle.oracleEmployerName(activeMulti)
  check('the 22 active Coherent sites resolve to a single employer identity, so one company does not enter the pipeline as 22 the deduper can never re-join',
    employer === 'Coherent', String(employer))
  check('a plain longest-common-prefix could NOT have produced that — one active site is "II-VI Aerospace & Defense | Coherent" and shares no prefix with the rest',
    activeMulti.some((s) => !(s.SiteName ?? '').startsWith('Coherent')) &&
      activeMulti.filter((s) => (s.SiteName ?? '').startsWith('Coherent')).length === 21,
    activeMulti.find((s) => !(s.SiteName ?? '').startsWith('Coherent'))?.SiteName ?? '')
  check('the name stops where the sites stop agreeing — only 10 of 22 say "Corp.", so the employer is "Coherent" and not "Coherent Corp."',
    employer === 'Coherent' && activeMulti.filter((s) => /^Coherent Corp\./.test(s.SiteName ?? '')).length < 11,
    `${activeMulti.filter((s) => /^Coherent Corp\./.test(s.SiteName ?? '')).length} of 22 say "Corp."`)
  check('a single-site tenant is simply itself', oracle.oracleEmployerName(activeEeho) === 'Oracle', String(oracle.oracleEmployerName(activeEeho)))
  check('two unrelated employers sharing a host produce NO shared identity rather than a wrong one',
    oracle.oracleEmployerName([
      { SiteNumber: 'CX_1', SiteName: 'Merck US', StatusCode: 'ORA_ACTIVE' },
      { SiteNumber: 'CX_2', SiteName: 'Corning Careers', StatusCode: 'ORA_ACTIVE' },
    ]) === null)
  check('and neither does a host with no site names at all', oracle.oracleEmployerName([]) === null)
  check('a word every career site shares is not an identity — "Careers US" and "Careers EMEA" name no employer, so the host is used instead',
    oracle.oracleEmployerName([
      { SiteNumber: 'CX_1', SiteName: 'Careers US', StatusCode: 'ORA_ACTIVE' },
      { SiteNumber: 'CX_2', SiteName: 'Careers EMEA', StatusCode: 'ORA_ACTIVE' },
    ]) === null)

  // ── Oracle: identity round-trip ───────────────────────────────────────────
  console.log('\noracle: a board is a host AND a site code')
  const id = { host: HOST, siteNumber: 'CX_1' }
  const identifier = oracle.formatOracleIdentifier(id)
  check('the documented format is {host}|{siteNumber}', identifier === `${HOST}|CX_1`, identifier)
  const back = oracle.parseOracleIdentifier(identifier)
  check('it round-trips exactly', back?.host === id.host && back?.siteNumber === id.siteNumber)
  check('a non-Oracle host is refused', oracle.parseOracleIdentifier('boards.greenhouse.io|CX_1') === null)
  check('a missing site is refused', oracle.parseOracleIdentifier(HOST) === null)
  check('a slash-separated Workday-style identifier is refused', oracle.parseOracleIdentifier(`${HOST}/CX_1`) === null)
  const matched = oracle.matchOracleUrl(`https://${HOST}/hcmUI/CandidateExperience/en/sites/CX_1/job/2011324`)
  check('a real posting URL yields the board and the requisition id',
    matched?.board.identifier === identifier && matched?.jobId === '2011324', String(matched?.jobId))
  const hostOnly = oracle.matchOracleUrl(`https://${HOST}`)
  check('a bare tenant URL is still recognised, with the site left to discovery', hostOnly?.board.identifier === `${HOST}|`, String(hostOnly?.board.identifier))

  // ── Oracle: normalizing a real requisition ────────────────────────────────
  console.log('\noracle: normalizing a recorded Coherent requisition')
  const rows = (readJson<OracleListResponse>('oracle-list.json').items ?? [])[0]?.requisitionList ?? []
  const processEng = rows.find((r) => r.Title === 'Process Engineer') as OracleRequisition
  check('the recorded page holds the posting this founder is here for', !!processEng, String(rows.length) + ' rows')
  const posting = oracle.normalizeOracleRequisition(processEng, { id, companyName: 'Coherent Corp. US', now: '2026-08-31T00:00:00.000Z' })
  check('title and company survive', posting?.title === 'Process Engineer' && posting?.company_name === 'Coherent Corp. US')
  check('the canonical URL is the page a candidate opens', posting?.canonical_url === `https://${HOST}/hcmUI/CandidateExperience/en/sites/CX_1/job/${processEng.Id}`, String(posting?.canonical_url))
  check('PostedDate becomes an ISO instant, not a bare calendar string', posting?.posted_at === '2026-08-29T00:00:00.000Z', String(posting?.posted_at))
  check('location comes through', (posting?.location_raw ?? '').includes('Woburn'), String(posting?.location_raw))
  check(
    'without a detail call there is NO description_html — only the 255-char teaser, so nothing downstream can cite a teaser as a description',
    posting?.description_html === null && (posting?.description_text ?? '').length > 0,
    `text ${(posting?.description_text ?? '').length} chars`
  )
  const withSecondary = rows.find((r) => (r.secondaryLocations ?? []).length > 0)
  if (withSecondary) {
    const p2 = oracle.normalizeOracleRequisition(withSecondary, { id, now: '2026-08-31T00:00:00.000Z' })
    check('secondary locations are joined onto the primary one', (p2?.location_raw ?? '').includes(' · '), String(p2?.location_raw))
  }
  check('a row with no id or no title is skipped, not thrown on',
    oracle.normalizeOracleRequisition({ Title: 'x' }, { id }) === null && oracle.normalizeOracleRequisition({ Id: '1' }, { id }) === null)

  // ── Oracle: paging by cursor ──────────────────────────────────────────────
  console.log('\noracle: paging one site by cursor')
  const seenUrls: string[] = []
  const oracleFetcher = (bodies: Record<string, string>): OracleFetcher => async (url) => {
    seenUrls.push(url)
    for (const [needle, body] of Object.entries(bodies)) {
      if (url.includes(needle)) return { status: 200, contentType: ORACLE_CT, body }
    }
    return { status: 404, contentType: 'text/html', body: '<html>Not Found</html>' }
  }
  const pagedSource = oracle.oracleOrcSource({
    bypassCache: true,
    fetcher: oracleFetcher({ 'offset=0': listPage1, 'offset=25': listPage2 }),
    now: () => '2026-08-31T00:00:00.000Z',
  })
  const board = { ats: 'other' as const, identifier, company_name: 'Coherent Corp. US' }
  seenUrls.length = 0
  const first = await pagedSource.search({ board, limit: 25 })
  check('a page of 25 comes back with no error', first.postings.length === 25 && !first.error, `${first.postings.length}`)
  check('seen counts what the API returned before any filtering', first.seen === 25, String(first.seen))
  check('the cursor names the site and the next offset', first.nextCursor === 'CX_1@25' && !first.exhausted, String(first.nextCursor))
  check('the note carries the true board size Oracle reported', (first.note ?? '').includes('267'), first.note ?? '')
  const second = await pagedSource.search({ board, limit: 25 }, first.nextCursor)
  check('the cursor is honoured as a finder offset', seenUrls.some((u) => u.includes('offset=25')), seenUrls[seenUrls.length - 1] ?? '')
  const ids1 = new Set(first.postings.map((p) => p.external_id))
  const overlap = second.postings.filter((p) => ids1.has(p.external_id)).length
  check('page two does not repeat page one — the finder offset actually moved', overlap === 0 && second.postings.length === 25, `overlap ${overlap}`)

  // ── Oracle: who the employer is when the board does not say ───────────────
  console.log('\noracle: a Fusion host is an opaque POD CODE, so it is never an employer name')
  const anonUrls: string[] = []
  const anonFetcher: OracleFetcher = async (url) => {
    anonUrls.push(url)
    if (url.includes('recruitingCESites')) return { status: 200, contentType: ORACLE_CT, body: sitesMulti }
    return { status: 200, contentType: ORACLE_CT, body: listPage1 }
  }
  const anonBoard = { ats: 'other' as const, identifier } // no company_name — how a harvested Fusion URL arrives
  const anon = await oracle
    .oracleOrcSource({ bypassCache: true, fetcher: anonFetcher, now: () => '2026-08-31T00:00:00.000Z' })
    .search({ board: anonBoard, limit: 25 })
  check('a board addressed by identifier ALONE resolves the employer through the site list — this is the path the 47 harvested Fusion URLs take, and none of them carries a company name',
    anon.postings.length === 25 && anon.postings.every((p) => p.company_name === 'Coherent'), String(anon.postings[0]?.company_name))
  check('"hcwp" is never recorded as an employer', !anon.postings.some((p) => /^hcwp$/i.test(p.company_name)))
  check('the site\'s own name survives as the BOARD label, kept apart from the employer identity',
    (anon.postings[0]?.raw.oracle as { siteName?: string } | undefined)?.siteName === 'Coherent Corp. US',
    String((anon.postings[0]?.raw.oracle as { siteName?: string } | undefined)?.siteName))
  check('it costs exactly one extra request, and that request is the day-cached site list',
    anonUrls.filter((u) => u.includes('recruitingCESites')).length === 1 && anon.requests === 2, `${anon.requests} requests`)

  const blindUrls: string[] = []
  const blind = await oracle
    .oracleOrcSource({
      bypassCache: true,
      now: () => '2026-08-31T00:00:00.000Z',
      fetcher: async (url) => {
        blindUrls.push(url)
        if (url.includes('recruitingCESites')) return { status: 500, contentType: ORACLE_CT, body: '' }
        return { status: 200, contentType: ORACLE_CT, body: listPage1 }
      },
    })
    .search({ board: anonBoard, limit: 25 })
  check('and when the site list cannot be read the postings still arrive, filed under the FULL HOST — an address, which is honest, rather than an employer invented from the subdomain',
    blind.postings.length === 25 && blind.postings.every((p) => p.company_name === HOST), String(blind.postings[0]?.company_name))

  const namedUrls: string[] = []
  const namedRes = await oracle
    .oracleOrcSource({
      bypassCache: true,
      now: () => '2026-08-31T00:00:00.000Z',
      fetcher: async (url) => {
        namedUrls.push(url)
        return { status: 200, contentType: ORACLE_CT, body: listPage1 }
      },
    })
    .search({ board: { ats: 'other', identifier, company_name: 'Coherent' }, limit: 25 })
  check('a board that already knows its company spends no request finding out',
    namedUrls.every((u) => !u.includes('recruitingCESites')) && namedRes.requests === 1, `${namedRes.requests} request`)

  // ── Oracle: a missing count is not a finished board ───────────────────────
  console.log('\noracle: an absent TotalJobsCount must not read as "complete coverage"')
  const noTotalBody = (() => {
    const clone = JSON.parse(listPage1) as OracleListResponse
    delete (clone.items![0] as { TotalJobsCount?: number }).TotalJobsCount
    return JSON.stringify(clone)
  })()
  const untotalled = await oracle
    .oracleOrcSource({ bypassCache: true, fetcher: oracleFetcher({ 'offset=': noTotalBody }), now: () => '2026-08-31T00:00:00.000Z' })
    .search({ board, limit: 25 })
  check('a FULL page with no count hands back a cursor — declaring itself exhausted there would be a silent claim of complete coverage over one page of a partial read',
    untotalled.postings.length === 25 && untotalled.nextCursor === 'CX_1@25' && !untotalled.exhausted,
    `${untotalled.postings.length} postings, cursor ${String(untotalled.nextCursor)}`)
  const shortNoTotal = (() => {
    const clone = JSON.parse(listPage1) as OracleListResponse
    const item = clone.items![0]
    item.requisitionList = (item.requisitionList ?? []).slice(0, 5)
    delete (item as { TotalJobsCount?: number }).TotalJobsCount
    return JSON.stringify(clone)
  })()
  const shortRes = await oracle
    .oracleOrcSource({ bypassCache: true, fetcher: oracleFetcher({ 'offset=': shortNoTotal }), now: () => '2026-08-31T00:00:00.000Z' })
    .search({ board, limit: 25 })
  check('a SHORT page with no count still ends the board — a page smaller than the window is the end of it',
    shortRes.postings.length === 5 && shortRes.exhausted && shortRes.nextCursor === null, `${shortRes.postings.length} postings`)

  // ── Oracle: the payload shape is Oracle's to change ───────────────────────
  console.log('\noracle: search NEVER throws, whatever shape the payload arrives in')
  const oddLocations = oracle.normalizeOracleRequisition(
    { Id: '1', Title: 'Process Engineer', secondaryLocations: { Name: 'Woburn' } as never },
    { id, companyName: 'Coherent' }
  )
  check('a secondaryLocations that is an OBJECT rather than an array degrades to no secondary locations, not a TypeError mid-sweep',
    oddLocations?.title === 'Process Engineer' && oddLocations?.location_raw === null, String(oddLocations?.location_raw))
  const reshaped = await oracle
    .oracleOrcSource({ bypassCache: true, fetcher: oracleFetcher({ 'offset=': '{"items":{"requisitionList":"nope"}}' }), now: () => '2026-08-31T00:00:00.000Z' })
    .search({ board, limit: 25 })
  check('and a wholly reshaped response is an empty exhausted read rather than an exception',
    reshaped.postings.length === 0 && reshaped.seen === 0 && reshaped.exhausted)

  // ── Oracle: internshipsOnly and since ─────────────────────────────────────
  console.log('\noracle: filtering happens after the fetch, and says so')
  // One self-contained page: 25 rows, and the board says 25, so the sweep ends
  // after a single request and `seen` is unambiguous.
  const onePage = (() => {
    const clone = JSON.parse(listPage1) as OracleListResponse
    clone.items![0].TotalJobsCount = 25
    return JSON.stringify(clone)
  })()
  const internSource = oracle.oracleOrcSource({ bypassCache: true, fetcher: oracleFetcher({ 'offset=': onePage }), now: () => '2026-08-31T00:00:00.000Z' })
  const interns = await internSource.search({ board, internshipsOnly: true, limit: 25 })
  check('seen counts every row the source returned, before the title gate — "25 seen · 0 unique" is the honest line, not "0 seen"',
    interns.seen === 25 && interns.requests === 1 && interns.postings.length < 25, `${interns.postings.length} of ${interns.seen}`)
  const sinceRes = await internSource.search({ board, since: '2026-08-31T00:00:00Z', limit: 25 })
  check('a `since` cutoff drops the older rows and ends the sweep — POSTING_DATES_DESC guarantees the rest are older',
    sinceRes.postings.every((p) => !p.posted_at || Date.parse(p.posted_at) >= Date.parse('2026-08-31T00:00:00Z')) && sinceRes.postings.length < 25,
    `${sinceRes.postings.length} kept`)

  // ── Oracle: descriptions are opt-in ───────────────────────────────────────
  console.log('\noracle: descriptions cost one request each, so they are opt-in')
  const cheapUrls: string[] = []
  const cheapFetcher: OracleFetcher = async (url) => {
    cheapUrls.push(url)
    if (url.includes('RequisitionDetails')) return { status: 200, contentType: ORACLE_CT, body: detailJson }
    return { status: 200, contentType: ORACLE_CT, body: listPage1 }
  }
  const cheap = oracle.oracleOrcSource({ bypassCache: true, fetcher: cheapFetcher, now: () => '2026-08-31T00:00:00.000Z' })
  const listOnly = await cheap.search({ board, limit: 25 })
  check('a listing sweep makes exactly one request for 25 postings, not 26',
    cheapUrls.filter((u) => u.includes('RequisitionDetails')).length === 0 && listOnly.requests === 1, String(listOnly.requests))
  check('and it declares that it carries no description', cheap.capabilities.givesDescription === false)

  cheapUrls.length = 0
  const rich = oracle.oracleOrcSource({ bypassCache: true, withDescriptions: true, fetcher: cheapFetcher, now: () => '2026-08-31T00:00:00.000Z' })
  const withDesc = await rich.search({ board, limit: 2 })
  const first2 = withDesc.postings[0]
  check('with withDescriptions the detail call runs and the real description arrives',
    !!first2?.description_html && (first2?.description_text ?? '').length > 500, `${(first2?.description_text ?? '').length} chars`)
  check('the detail call is keyed on the requisition Id, quoted', cheapUrls.some((u) => /Id="\d+",siteNumber=CX_1/.test(u)))
  check('a source that fetches descriptions says so in its capabilities', rich.capabilities.givesDescription === true)

  // ── Oracle: host-only addressing walks the active sites ───────────────────
  console.log('\noracle: given only a host, discover the sites and walk them')
  const twoRows = JSON.parse(listPage1) as OracleListResponse
  const shrink = (n: number, total: number): string => {
    const clone = JSON.parse(listPage1) as OracleListResponse
    const item = clone.items![0]
    item.requisitionList = (twoRows.items![0].requisitionList ?? []).slice(0, n)
    item.TotalJobsCount = total
    return JSON.stringify(clone)
  }
  const smallSites: OracleSitesResponse = {
    items: [
      { SiteNumber: 'CX_1', SiteName: 'Coherent Corp. US', StatusCode: 'ORA_ACTIVE' },
      { SiteNumber: 'CX_9999', SiteName: 'Retired reference copy', StatusCode: 'ORA_INACTIVE' },
      { SiteNumber: 'CX_2001', SiteName: 'Coherent UK', StatusCode: 'ORA_ACTIVE' },
    ],
    hasMore: false,
  }
  const walkUrls: string[] = []
  const walkFetcher: OracleFetcher = async (url) => {
    walkUrls.push(url)
    if (url.includes('recruitingCESites')) return { status: 200, contentType: ORACLE_CT, body: JSON.stringify(smallSites) }
    if (url.includes('siteNumber=CX_1,')) return { status: 200, contentType: ORACLE_CT, body: shrink(2, 2) }
    if (url.includes('siteNumber=CX_2001,')) return { status: 200, contentType: ORACLE_CT, body: shrink(1, 1) }
    return { status: 404, contentType: 'text/html', body: '<html/>' }
  }
  const walker = oracle.oracleOrcSource({ bypassCache: true, fetcher: walkFetcher, now: () => '2026-08-31T00:00:00.000Z' })
  const walk = await walker.search({ extra: { oracleHost: HOST }, limit: 3 })
  check('the inactive reference copy is never requested', !walkUrls.some((u) => u.includes('CX_9999')))
  check('both active sites are read in one call and the run reports itself exhausted',
    walk.postings.length === 3 && walk.exhausted && walk.nextCursor === null, `${walk.postings.length} postings`)
  check('the note names how many active sites the tenant publishes', (walk.note ?? '').includes('2 active site'), walk.note ?? '')
  check('each posting is attributed to its own site', new Set(walk.postings.map((p) => p.canonical_url?.includes('/sites/CX_1/'))).size === 2)

  // ── Oracle: degradation ───────────────────────────────────────────────────
  console.log('\noracle: failure degrades, it never throws')
  const deadSource = oracle.oracleOrcSource({ bypassCache: true, fetcher: async () => ({ status: 0, contentType: '', body: '', error: 'getaddrinfo ENOTFOUND' }) })
  const dead = await deadSource.search({ extra: { oracleHost: 'nosuchtenant.fa.us2.oraclecloud.com' } })
  check('an unreachable tenant is an error, with no postings and no throw', dead.postings.length === 0 && !!dead.error && dead.exhausted, dead.error ?? '')
  const htmlSource = oracle.oracleOrcSource({ bypassCache: true, fetcher: async () => ({ status: 200, contentType: 'text/html', body: '<html>404</html>' }) })
  const html = await htmlSource.search({ board })
  check('an HTML body served with HTTP 200 is caught by content-type, not status', !!html.error && /text\/html/.test(html.error), html.error ?? '')
  const unaddressed = await deadSource.search({})
  check('a call that names no board is a no-op with an explanation, not an error',
    !unaddressed.error && unaddressed.exhausted && /host\}\|\{siteNumber/.test(unaddressed.note ?? ''), unaddressed.note ?? '')
  const partial = oracle.oracleOrcSource({
    bypassCache: true,
    now: () => '2026-08-31T00:00:00.000Z',
    fetcher: async (url) => {
      if (url.includes('recruitingCESites')) return { status: 200, contentType: ORACLE_CT, body: JSON.stringify(smallSites) }
      if (url.includes('siteNumber=CX_1,')) return { status: 200, contentType: ORACLE_CT, body: shrink(2, 2) }
      return { status: 500, contentType: ORACLE_CT, body: '' }
    },
  })
  const partialRes = await partial.search({ extra: { oracleHost: HOST }, limit: 25 })
  check('one dead site does not discard the postings the live one already produced',
    partialRes.postings.length === 2 && !!partialRes.error && /CX_2001/.test(partialRes.error ?? ''), partialRes.error ?? '')
  check('it is free and always configured', deadSource.isConfigured() && deadSource.costModel.kind === 'free' && deadSource.sourceType === 'ats')

  // ═══ TALEO ════════════════════════════════════════════════════════════════

  console.log('\ntaleo: the tz header is the entire trick')
  const taleoList = readFixture('taleo-list.json')
  const taleoLbl = readFixture('taleo-list-lbl.json')
  const taleoBae = readFixture('taleo-list-bae.json')
  const taleoUnavailable = readFixture('taleo-unavailable.json')
  const taleoErrorPage = readFixture('taleo-error-page.html')
  const taleoPortalPage = readFixture('taleo-portal-page.html')

  const captured: TaleoRequest[] = []
  const taleoFetcher = (respond: (req: TaleoRequest) => { status: number; contentType: string; body: string; finalUrl?: string }): TaleoFetcher =>
    async (req) => {
      captured.push(req)
      return respond(req)
    }
  const okJson = (body: string) => ({ status: 200, contentType: 'application/json', body })

  const cuBoard = { ats: 'other' as const, identifier: 'cu|2|101430233', company_name: 'University of Colorado' }
  captured.length = 0
  const cuSource = taleo.taleoSource({ bypassCache: true, fetcher: taleoFetcher(() => okJson(taleoList)), now: () => '2026-08-31T00:00:00.000Z' })
  const cu = await cuSource.search({ board: cuBoard, limit: 25 })
  const searchReq = captured.find((r) => r.url.includes('searchjobs'))
  check('every search request carries tz: GMT-04:00 — without it the identical request is an HTTP 500 "An Error Occurred in TEE"',
    searchReq?.headers.tz === 'GMT-04:00', String(searchReq?.headers.tz))
  check('the portal id rides in the query string', (searchReq?.url ?? '').includes('portal=101430233'), searchReq?.url ?? '')
  const sentBody = JSON.parse(searchReq?.body ?? '{}') as { fieldData?: { fields?: unknown } }
  check('fieldData.fields is an OBJECT — the array-of-{fieldName,value} form returns HTTP 400',
    !!sentBody.fieldData && typeof sentBody.fieldData.fields === 'object' && !Array.isArray(sentBody.fieldData.fields),
    JSON.stringify(sentBody.fieldData?.fields))
  check('a real page of Colorado postings comes back', cu.postings.length === 25 && !cu.error, `${cu.postings.length}`)
  check('the note carries the true total the career section reported', (cu.note ?? '').includes('712'), cu.note ?? '')

  // ── Taleo: positional columns ─────────────────────────────────────────────
  console.log('\ntaleo: `column` is positional and tenant-configured — never hardcode an index')
  const cuRows = (JSON.parse(taleoList) as TaleoSearchResponse).requisitionList ?? []
  const lblRows = (JSON.parse(taleoLbl) as TaleoSearchResponse).requisitionList ?? []
  const baeRows = (JSON.parse(taleoBae) as TaleoSearchResponse).requisitionList ?? []

  const cuMap = taleo.resolveTaleoColumns(cuRows[0])
  check('cu puts the title at 0, the location at 1 and the date at 2',
    cuMap.titleIndex === 0 && cuMap.locationIndexes[0] === 1 && cuMap.dateIndex === 2, JSON.stringify(cuMap))

  const lblMap = taleo.resolveTaleoColumns(lblRows[0])
  check('Berkeley Lab puts the CONTEST NUMBER at 0 and the title at 1 — linkedColumn says so',
    lblMap.titleIndex === 1 && lblRows[0].linkedColumn === 1, JSON.stringify(lblMap))
  const lblPosting = taleo.normalizeTaleoRow(lblRows[0], { id: { tenant: 'lbl', section: '2', portalId: '101430233' }, now: '2026-08-31T00:00:00.000Z' })
  check('so the title is a job title, not the digits an index-0 assumption would have produced',
    lblPosting?.title === 'Operational Health Physicist' && !/^\d+$/.test(lblPosting?.title ?? ''), String(lblPosting?.title))
  check('the unlabelled remaining column is recognised as the date by shape, never by position',
    lblMap.dateIndex === 2 && lblPosting?.posted_at === '2026-08-31T00:00:00.000Z', `${lblMap.dateIndex} / ${lblPosting?.posted_at}`)
  check('a job title is never mistaken for a date', !taleo.looksLikeTaleoDate('Operational Health Physicist') && taleo.looksLikeTaleoDate('Aug 31, 2026'))

  const baeMap = taleo.resolveTaleoColumns(baeRows[0])
  const baePosting = taleo.normalizeTaleoRow(baeRows[0], { id: { tenant: 'baesystems', section: '2', portalId: '101430233' }, now: '2026-08-31T00:00:00.000Z' })
  check('BAE Systems configures ONE column and no locations — that is a valid tenant, not a parse failure',
    baeRows[0].column?.length === 1 && baeMap.locationIndexes.length === 0 && baeMap.dateIndex === null, JSON.stringify(baeMap))
  check('and it still yields a usable posting with a null location rather than garbage',
    baePosting?.title === 'Metrology Engineer (Calibration)' && baePosting?.location_raw === null && baePosting?.posted_at === null)

  console.log('\ntaleo: the location cell is a JSON array inside a string')
  check('a double-encoded single location is unwrapped', taleo.parseTaleoLocations('["Massachusetts-Boston"]').join('|') === 'Massachusetts-Boston')
  check('several are kept', taleo.parseTaleoLocations('["A","B"]').length === 2)
  check('a plain string still works', taleo.parseTaleoLocations('Boston').join('|') === 'Boston')
  check('malformed JSON falls back to the raw cell rather than throwing', taleo.parseTaleoLocations('[not json').join('|') === '[not json')
  const cuPosting = taleo.normalizeTaleoRow(cuRows[0], { id: { tenant: 'cu', section: '2', portalId: '101430233' }, companyName: 'University of Colorado', now: '2026-08-31T00:00:00.000Z' })
  check('a normalized posting carries the unwrapped location', cuPosting?.location_raw === 'Multiple Locations', String(cuPosting?.location_raw))

  console.log('\ntaleo: the detail page is keyed on contestNo, not jobId')
  check('external_id is the contest number', cuPosting?.external_id === cuRows[0].contestNo && cuRows[0].contestNo !== cuRows[0].jobId,
    `contestNo ${cuRows[0].contestNo} vs jobId ${cuRows[0].jobId}`)
  check('and the canonical URL uses it', cuPosting?.canonical_url === `https://cu.taleo.net/careersection/2/jobdetail.ftl?job=${cuRows[0].contestNo}`, String(cuPosting?.canonical_url))
  check('the jobId is kept as the ATS job id, so nothing is lost', cuPosting?.ats_job_id === cuRows[0].jobId)

  // ── Taleo: identity + portal discovery ────────────────────────────────────
  console.log('\ntaleo: identity and portal discovery')
  const tid = { tenant: 'cu', section: '2', portalId: '101430233' }
  check('the identifier round-trips', JSON.stringify(taleo.parseTaleoIdentifier(taleo.formatTaleoIdentifier(tid))) === JSON.stringify(tid))
  check('a tenant with nothing else is still addressable', JSON.stringify(taleo.parseTaleoIdentifier('cu||')) === JSON.stringify({ tenant: 'cu', section: null, portalId: null }))
  const fromUrl = taleo.matchTaleoUrl('https://massanf.taleo.net/careersection/ex/jobsearch.ftl?portal=101430233')
  check('a Taleo URL yields the tenant, the section and the portal when the URL carries one',
    fromUrl?.board.identifier === 'massanf|ex|101430233', String(fromUrl?.board.identifier))
  check('and a URL without a portal leaves that slot empty for discovery to fill',
    taleo.matchTaleoUrl('https://massanf.taleo.net/careersection/ex/jobsearch.ftl')?.board.identifier === 'massanf|ex|')
  check('the portal id is read out of the page\'s inline script, where PageFetcher cannot see it',
    taleo.extractTaleoPortal(taleoPortalPage) === '101430233', String(taleo.extractTaleoPortal(taleoPortalPage)))
  check('the career-section name comes from the URL path', taleo.extractTaleoSection('https://cu.taleo.net/careersection/2/moresearch.ftl?lang=en') === '2')
  check('and a .ftl in that position is not a section name', taleo.extractTaleoSection('https://cu.taleo.net/careersection/jobsearch.ftl') === null)

  captured.length = 0
  const discovered = await taleo.discoverTaleoPortal(
    'teletech',
    taleoFetcher((req) => (req.url.includes('/careersection/jobsearch.ftl') ? { status: 200, contentType: 'text/html', body: taleoPortalPage.replace(/101430233/g, '160131726'), finalUrl: 'https://teletech.taleo.net/careersection/2/jobsearch.ftl' } : { status: 404, contentType: 'text/html', body: '' })),
    true
  )
  check('discovery finds a tenant-specific portal id — teletech is unavailable on the common default and has 115 requisitions on its own',
    discovered.portalId === '160131726' && discovered.section === '2', JSON.stringify(discovered))
  const noPortal = await taleo.discoverTaleoPortal('kp', taleoFetcher(() => ({ status: 200, contentType: 'text/html', body: '<html>no marker here</html>' })), true)
  check('a tenant that publishes no portal id degrades to a stated reason, not a throw', noPortal.portalId === null && !!noPortal.error, noPortal.error ?? '')

  // ── Taleo: the failure modes that look like successes ─────────────────────
  console.log('\ntaleo: ~50% of tenants fail, and several failures arrive as HTTP 200')
  const errorPage = taleo.classifyTaleoResponse({ status: 200, contentType: 'text/html', body: taleoErrorPage, finalUrl: 'https://jacobs.taleo.net/error_pages/zone_maintenance_503.html' })
  check('an HTML error page served with HTTP 200 is caught — by content-type, because the status says nothing',
    errorPage.kind === 'html_error_page' && !!errorPage.error, errorPage.error ?? '')
  check('and the error names where it actually landed', /error_pages/.test(errorPage.error ?? ''), errorPage.error ?? '')
  const unavailable = taleo.classifyTaleoResponse({ status: 200, contentType: 'application/json', body: taleoUnavailable })
  check('HTTP 200 + valid JSON + careerSectionUnAvailable is also a failure, not an empty board',
    unavailable.kind === 'section_unavailable' && !!unavailable.error, unavailable.error ?? '')
  const five = taleo.classifyTaleoResponse({ status: 500, contentType: 'text/plain', body: 'An Error Occurred in TEE' })
  check('a 500 is named for what it almost always is — a missing tz header — not for a broken employer',
    five.kind === 'transport_error' && /tz/.test(five.error ?? ''), five.error ?? '')
  check('a genuine answer is classified ok', taleo.classifyTaleoResponse({ status: 200, contentType: 'application/json', body: taleoList }).kind === 'ok')

  const brokenSource = taleo.taleoSource({ bypassCache: true, fetcher: taleoFetcher((req) => (req.url.includes('searchjobs') ? { status: 200, contentType: 'text/html', body: taleoErrorPage, finalUrl: 'https://jacobs.taleo.net/error_pages/zone_maintenance_503.html' } : okJson('{}'))) })
  const broken = await brokenSource.search({ board: { ats: 'other', identifier: 'jacobs|2|101430233' } })
  check('the source reports it as a clean error with no postings and no throw',
    broken.postings.length === 0 && !!broken.error && broken.exhausted, broken.error ?? '')
  const unavailableSource = taleo.taleoSource({ bypassCache: true, fetcher: taleoFetcher(() => okJson(taleoUnavailable)) })
  const unavailableRes = await unavailableSource.search({ board: { ats: 'other', identifier: 'kp|external|101430233' } })
  check('so is an unavailable career section', !!unavailableRes.error && unavailableRes.postings.length === 0, unavailableRes.error ?? '')
  const missing = taleo.taleoSource({ bypassCache: true, fetcher: async () => ({ status: 0, contentType: '', body: '', error: 'getaddrinfo ENOTFOUND nosuchtenant.taleo.net' }) })
  const missingRes = await missing.search({ board: { ats: 'other', identifier: 'nosuchtenant|2|101430233' } })
  check('a tenant that does not exist degrades cleanly', !!missingRes.error && missingRes.postings.length === 0 && missingRes.exhausted, missingRes.error ?? '')
  const unaddressedTaleo = await missing.search({})
  check('a call naming no tenant is a no-op with an explanation', !unaddressedTaleo.error && /tenant\}\|\{section/.test(unaddressedTaleo.note ?? ''), unaddressedTaleo.note ?? '')

  // ── Taleo: paging ─────────────────────────────────────────────────────────
  console.log('\ntaleo: paging by page number')
  const page2 = JSON.parse(taleoList) as TaleoSearchResponse
  page2.pagingData = { currentPageNo: 2, pageSize: 25, totalCount: 712 }
  page2.requisitionList = (page2.requisitionList ?? []).map((r, i) => ({ ...r, jobId: `p2-${i}`, contestNo: `p2c-${i}` }))
  const pageBodies: string[] = []
  const pager = taleo.taleoSource({
    bypassCache: true,
    now: () => '2026-08-31T00:00:00.000Z',
    fetcher: taleoFetcher((req) => {
      pageBodies.push(req.body ?? '')
      const no = (JSON.parse(req.body ?? '{}') as { pageNo?: number }).pageNo ?? 1
      return okJson(no >= 2 ? JSON.stringify(page2) : taleoList)
    }),
  })
  const p1 = await pager.search({ board: cuBoard, limit: 25 })
  check('page one hands back a cursor because 712 > 25', p1.nextCursor === '2' && !p1.exhausted, String(p1.nextCursor))
  const p2 = await pager.search({ board: cuBoard, limit: 25 }, p1.nextCursor)
  check('the cursor becomes pageNo in the body', pageBodies.some((b) => /"pageNo":2/.test(b)))
  const p1ids = new Set(p1.postings.map((p) => p.external_id))
  check('page two is different postings', p2.postings.length === 25 && p2.postings.every((p) => !p1ids.has(p.external_id)))
  const smallTotal = JSON.parse(taleoList) as TaleoSearchResponse
  smallTotal.pagingData = { currentPageNo: 1, pageSize: 25, totalCount: 25 }
  const lastPage = taleo.taleoSource({ bypassCache: true, fetcher: taleoFetcher(() => okJson(JSON.stringify(smallTotal))) })
  const only = await lastPage.search({ board: cuBoard, limit: 25 })
  check('a board that fits on one page says it is exhausted and offers no cursor', only.exhausted && only.nextCursor === null)

  // ── Taleo: `since` is only as real as the tenant's date column ────────────
  console.log('\ntaleo: a cutoff a career section cannot honour is said out loud')
  const baeSince = await taleo
    .taleoSource({ bypassCache: true, fetcher: taleoFetcher(() => okJson(taleoBae)), now: () => '2026-08-31T00:00:00.000Z' })
    .search({ board: { ats: 'other', identifier: 'baesystems|2|101430233' }, since: '2030-01-01T00:00:00Z', limit: 25 })
  check('BAE Systems prints no posting date, so a `since` cutoff cannot be applied — and the result SAYS the filter did not run instead of returning a full page as though it had',
    baeSince.postings.length > 0 && /NOT applied/.test(baeSince.note ?? ''), baeSince.note ?? '(no note)')
  const cuSince = await taleo
    .taleoSource({ bypassCache: true, fetcher: taleoFetcher(() => okJson(taleoList)), now: () => '2026-08-31T00:00:00.000Z' })
    .search({ board: cuBoard, since: '2020-01-01T00:00:00Z', limit: 25 })
  check('a section that does print dates carries no such warning', !/NOT applied/.test(cuSince.note ?? ''), cuSince.note ?? '')

  // ── Taleo: the recorded detail page ───────────────────────────────────────
  console.log('\ntaleo: the recorded detail page is the proof that the key is contestNo')
  const taleoDetailPage = readFixture('taleo-detail.html')
  const builtDetail = taleo.taleoDetailUrl({ tenant: 'cu', section: '2', portalId: '101430233' }, String(cuRows[0].contestNo))
  check('the URL the adapter builds from list row 0 is the URL that was recorded, HTTP 200',
    taleoDetailPage.includes(builtDetail), builtDetail)
  check('and the page it returned is that same posting — the og:title matches the row title',
    taleoDetailPage.includes((cuRows[0].column ?? [])[0].trim()), (cuRows[0].column ?? [])[0].trim().slice(0, 48))
  check('the jobId addresses nothing: `job=494704` appears nowhere on the page that `job=40970` returned',
    !taleoDetailPage.includes(`job=${cuRows[0].jobId}`) && cuRows[0].jobId !== cuRows[0].contestNo,
    `jobId ${String(cuRows[0].jobId)} vs contestNo ${String(cuRows[0].contestNo)}`)

  console.log('\ntaleo: a query is a real filter here, not a ranking hint')
  captured.length = 0
  const keywordSource = taleo.taleoSource({ bypassCache: true, fetcher: taleoFetcher(() => okJson(taleoList)) })
  await keywordSource.search({ board: cuBoard, query: 'process engineer' })
  const kwBody = JSON.parse(captured.find((r) => r.url.includes('searchjobs'))?.body ?? '{}') as { fieldData?: { fields?: Record<string, string> } }
  check('the query lands in KEYWORD, which took cu from 712 requisitions to 3 when measured live',
    kwBody.fieldData?.fields?.KEYWORD === 'process engineer', JSON.stringify(kwBody.fieldData?.fields))
  check('it is free, always configured, and declares itself an ATS pull feed',
    keywordSource.isConfigured() && keywordSource.costModel.kind === 'free' && keywordSource.sourceType === 'ats' && keywordSource.capabilities.paginates)

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) {
    console.log(failures.map((f) => `  - ${f}`).join('\n'))
    process.exitCode = 1
  }
}

/**
 * Opt-in live re-verification: `npx tsx scripts/test-career-oracle-taleo.ts --live`.
 *
 * NOT part of the offline suite and never run by test-career-all. It exists
 * because these fixtures are recordings, and a recording goes stale silently —
 * this is how a founder finds out that Oracle changed a field name or that a
 * career section retired, in about a dozen requests. It asserts nothing; it
 * prints what the real endpoints say so the numbers can be compared against
 * the header comments.
 */
async function live(): Promise<void> {
  const { oracleOrcSource, discoverOracleBoards } = await import('../lib/career/sources/oracle-orc')
  const { taleoSource } = await import('../lib/career/sources/taleo')
  process.env.CAREER_SOURCE_CACHE_BYPASS = '1'
  delete process.env.CAREER_SKIP_ROBOTS
  console.log('── live ──────────────────────────────────────────────────────')

  const oracle = oracleOrcSource({ bypassCache: true })
  console.log('oracle health          ', JSON.stringify(await oracle.healthCheck()))
  const boards = await discoverOracleBoards('hcwp.fa.us2.oraclecloud.com')
  console.log('oracle active boards   ', boards.boards.length, boards.boards.slice(0, 3).map((b) => `${b.identifier} (${b.company_name})`).join(', '))
  const listed = await oracle.search({ board: { ats: 'other', identifier: 'hcwp.fa.us2.oraclecloud.com|CX_1', company_name: 'Coherent Corp. US' }, limit: 25 })
  console.log('oracle list            ', JSON.stringify({ postings: listed.postings.length, seen: listed.seen, cursor: listed.nextCursor, requests: listed.requests, note: listed.note, error: listed.error }))
  for (const p of listed.postings.slice(0, 5)) console.log(`   ${p.title} | ${p.location_raw} | ${p.posted_at?.slice(0, 10)}`)
  const rich = await oracleOrcSource({ bypassCache: true, withDescriptions: true }).search({ board: { ats: 'other', identifier: 'hcwp.fa.us2.oraclecloud.com|CX_1' }, limit: 1 })
  console.log('oracle detail          ', rich.postings[0]?.title, `${rich.postings[0]?.description_text?.length ?? 0} chars in`, rich.requests, 'requests')

  const taleoLive = taleoSource({ bypassCache: true })
  console.log('taleo health           ', JSON.stringify(await taleoLive.healthCheck()))
  for (const identifier of ['cu||', 'teletech||', 'lbl||', 'kp||', 'jacobs||']) {
    const r = await taleoLive.search({ board: { ats: 'other', identifier }, limit: 25 })
    console.log(`taleo ${identifier.padEnd(16)}`, JSON.stringify({ postings: r.postings.length, seen: r.seen, requests: r.requests, note: r.note, error: r.error }))
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
