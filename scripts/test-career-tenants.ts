// Offline checks for tenant discovery (lib/career/sources/tenant-discovery.ts).
//
// Everything here is a pure function over hand-built postings, so the suite
// needs no network and no keys. The URLs are REAL shapes taken from the live
// Simplify corpus and from docs/ATS_ENDPOINTS.md (both read 2026-08-31) — the
// point of this file is that a change to the host table cannot silently stop
// recognising `*.fa.us2.oraclecloud.com` or `careers-*.icims.com`.
//
//   npx tsx scripts/test-career-tenants.ts
//   npx tsx scripts/test-career-tenants.ts --live   # census the real feed (1 HTTP GET, ~11 MB)

import {
  atsFamilyFromUrl,
  discoverTenantsFromPostings,
  isAggregatorHost,
  summarizeTenants,
  toAtsBoardRef,
  type DiscoveredTenant,
} from '../lib/career/sources/tenant-discovery'
import type { RawJobPosting } from '../lib/career/sources/types'
import { isOpen, loadSimplifyCorpus, toRawPosting } from '../lib/career/sources/simplify'

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

function posting(over: Partial<RawJobPosting> = {}): RawJobPosting {
  return {
    source_type: 'careers_page',
    source_url: 'https://example.com/jobs/1',
    external_id: null,
    company_name: 'Acme Chemicals',
    company_domain: null,
    title: 'Process Engineering Intern',
    location_raw: 'Houston, TX',
    description_text: null,
    description_html: null,
    department: null,
    posted_at: null,
    updated_at: null,
    apply_url: null,
    canonical_url: null,
    ats_type: null,
    ats_job_id: null,
    requisition_id: null,
    employment_type_hint: 'Internship',
    raw: {},
    retrieved_at: new Date().toISOString(),
    ...over,
  }
}

function at(url: string, company = 'Acme Chemicals'): RawJobPosting {
  return posting({ canonical_url: url, source_url: url, company_name: company })
}

function find(list: DiscoveredTenant[], ats: string): DiscoveredTenant | undefined {
  return list.find((t) => t.ats === ats)
}

async function live(): Promise<void> {
  console.log('tenant discovery: census of the live Simplify corpus\n')
  const { rows, error } = await loadSimplifyCorpus({ force: true })
  if (error) {
    console.log(`  could not read the feed: ${error}`)
    process.exitCode = 1
    return
  }
  const postings = rows.map(toRawPosting).filter((p): p is RawJobPosting => p !== null)
  const openPostings = rows.filter(isOpen).map(toRawPosting).filter((p): p is RawJobPosting => p !== null)
  const result = discoverTenantsFromPostings(postings)
  const openResult = discoverTenantsFromPostings(openPostings)
  console.log(`  ${rows.length} rows · ${postings.length} usable postings · ${result.urlsExamined} URLs examined`)
  console.log(`  ${result.tenants.length} recognised boards · ${result.unrecognized.length} unrecognised hosts`)
  console.log(`  open postings only: ${openResult.tenants.length} recognised boards · ${openResult.unrecognized.length} unrecognised hosts`)
  const tenantsOf = (r: typeof result): number =>
    new Set(r.tenants.filter((t) => t.ats === 'workday').map((t) => (t.identifier ?? '').split('/')[0])).size
  console.log(`  distinct Workday TENANTS (sites collapsed): ${tenantsOf(result)} all · ${tenantsOf(openResult)} open\n`)
  for (const line of summarizeTenants(result)) console.log(`  ${line}`)
  console.log('\n  top unrecognised hosts (the next adapters to write):')
  for (const t of result.unrecognized.slice(0, 15)) {
    console.log(`    ${String(t.postings).padStart(4)}  ${t.host}`)
  }
  console.log('\n  a sample of what was found:')
  for (const t of result.tenants.slice(0, 10)) {
    console.log(`    ${String(t.postings).padStart(4)}  ${t.ats.padEnd(15)} ${t.identifier ?? `(host only: ${t.host})`}`)
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--live')) {
    await live()
    return
  }

  console.log('tenant discovery: the host table, on real URL shapes')
  const cases: [string, string, string | null][] = [
    // Workday — the identifier the adapter is actually addressed by.
    ['https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA/Intern_JR123', 'workday', 'nvidia/wd5/NVIDIAExternalCareerSite'],
    ['https://illumina.wd1.myworkdayjobs.com/illumina-careers', 'workday', 'illumina/wd1/illumina-careers'],
    ['https://mmm.wd1.myworkdayjobs.com/wday/cxs/mmm/Search/jobs', 'workday', 'mmm/wd1/Search'],
    // Workday's OTHER host family. Real URLs from the live feed; 148 postings
    // were landing in "unrecognised" before this was handled. Verified
    // 2026-08-31 that devonenergy/wd5/Careers lists 53 postings through the
    // existing adapter's CXS path on BOTH hosts.
    ['https://wd5.myworkdaysite.com/en-US/recruiting/devonenergy/Careers/job/Oklahoma-City-OK/Intern_R262', 'workday', 'devonenergy/wd5/Careers'],
    ['https://wd3.myworkdaysite.com/recruiting/magna/Magna/job/Novi-Michigan-US/Product-Engineering-Intern_R00225566', 'workday', 'magna/wd3/Magna'],
    ['https://wd1.myworkdaysite.com/recruiting/clorox/Clorox/job/Spring-Hill-KS---USA/Data-Analytics-Intern_20760', 'workday', 'clorox/wd1/Clorox'],
    // Oracle Fusion — `host|siteNumber`, which is what the ORC finder needs.
    ['https://egug.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/12345', 'oracle_fusion', 'egug.fa.us2.oraclecloud.com|CX_1'],
    ['https://ehhh.fa.us6.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_2/requisitions/preview/998', 'oracle_fusion', 'ehhh.fa.us6.oraclecloud.com|CX_2'],
    // iCIMS — the tenant is the whole subdomain, `careers-` and all.
    ['https://careers-sig.icims.com/jobs/12345/process-engineer-intern/job', 'icims', 'careers-sig'],
    ['https://merck.icims.com/jobs/search', 'icims', 'merck'],
    // Greenhouse, all four shapes.
    ['https://boards.greenhouse.io/acme/jobs/1', 'greenhouse', 'acme'],
    ['https://job-boards.greenhouse.io/acme/jobs/1', 'greenhouse', 'acme'],
    ['https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true', 'greenhouse', 'acme'],
    ['https://boards.eu.greenhouse.io/acme', 'greenhouse', 'acme'],
    // The rest of the required twelve.
    ['https://jobs.lever.co/scaleai/abc-123', 'lever', 'scaleai'],
    ['https://api.lever.co/v0/postings/scaleai?mode=json', 'lever', 'scaleai'],
    ['https://jobs.ashbyhq.com/openai/1234', 'ashby', 'openai'],
    ['https://api.ashbyhq.com/posting-api/job-board/openai', 'ashby', 'openai'],
    ['https://jobs.smartrecruiters.com/BoschGroup/744000', 'smartrecruiters', 'BoschGroup'],
    ['https://careers.smartrecruiters.com/BoschGroup', 'smartrecruiters', 'BoschGroup'],
    ['https://apply.workable.com/acme/j/ABC123/', 'workable', 'acme'],
    ['https://acme.workable.com/jobs/1', 'workable', 'acme'],
    ['https://acme.recruitee.com/o/process-intern', 'recruitee', 'acme'],
    ['https://acme.jobs.personio.de/job/12345', 'personio', 'acme'],
    ['https://acme.teamtailor.com/jobs/1', 'teamtailor', 'acme'],
    ['https://jobs.gem.com/acme/AAABBB', 'gem', 'acme'],
    ['https://api.gem.com/job_board/v0/acme/job_posts/', 'gem', 'acme'],
    // Recognised beyond the twelve — they belong in the report, not the unknown pile.
    ['https://exxonmobil.taleo.net/careersection/jobdetail.ftl?job=1', 'taleo', 'exxonmobil'],
    ['https://acme.bamboohr.com/careers/42', 'bamboohr', 'acme'],
    ['https://ats.rippling.com/acme/jobs/uuid', 'rippling', 'acme'],
    ['https://acme.eightfold.ai/careers?pid=123', 'eightfold', 'acme'],
    ['https://workforcenow.adp.com/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions?cid=abc-uuid', 'adp', 'abc-uuid'],
  ]
  for (const [url, wantAts, wantId] of cases) {
    const m = atsFamilyFromUrl(url)
    check(
      `${wantAts}: ${wantId ?? 'host only'}`,
      m?.ats === wantAts && m?.identifier === wantId,
      `${m?.ats ?? 'null'} / ${m?.identifier ?? 'null'}`
    )
  }

  console.log('\ntenant discovery: what a URL cannot say, it does not guess')
  const bareOracle = atsFamilyFromUrl('https://egug.fa.us2.oraclecloud.com/')
  check(
    'an Oracle host with no /sites/ segment withholds the siteNumber and says so',
    bareOracle?.ats === 'oracle_fusion' && bareOracle.identifier === null && /recruitingCESites/.test(bareOracle.needs ?? ''),
    bareOracle?.needs ?? 'null'
  )
  check('the host survives so a probe can resolve it', bareOracle?.host === 'egug.fa.us2.oraclecloud.com')
  const dayforce = atsFamilyFromUrl('https://can01.dayforcehcm.com/CandidatePortal/en-US/acme')
  check(
    'Dayforce is recognised and then refused, not left as an unknown host',
    dayforce?.ats === 'dayforce',
    dayforce?.needs ?? ''
  )
  check('a non-URL is null, not a throw', atsFamilyFromUrl('not a url') === null && atsFamilyFromUrl(null) === null)
  check('a non-http scheme is null', atsFamilyFromUrl('mailto:jobs@acme.com') === null)
  check('an employer careers page is unrecognised, not mis-assigned', atsFamilyFromUrl('https://careers.merck.com/us/en/job/123') === null)
  check('aggregator hosts are named', isAggregatorHost('www.linkedin.com') && isAggregatorHost('simplify.jobs') && !isAggregatorHost('boards.greenhouse.io'))

  // A vendor's marketing site lives on the same domain as its customers'
  // boards. `www.greenhouse.io/pricing` differs from `boards.greenhouse.io/acme`
  // only in the two parts this file reads, so without a reserved-label set it
  // becomes a Greenhouse board whose token is "www" — marked listable, and
  // handed to the real adapter to fetch. The live Simplify corpus contains none
  // of these, but this function is advertised as safe on ANY batch of postings,
  // including careers-page scrapes and SERP results, where such a link is
  // ordinary.
  const vendorPages: [string, string][] = [
    ['https://www.greenhouse.io/pricing', 'greenhouse'],
    ['https://www.lever.co/customers', 'lever'],
    ['https://www.icims.com/', 'icims'],
    ['https://www.taleo.net/', 'taleo'],
    ['https://www.jobvite.com/pricing/', 'jobvite'],
  ]
  for (const [url, family] of vendorPages) {
    const m = atsFamilyFromUrl(url)
    check(
      `a vendor's own page is not a board: ${url}`,
      m?.ats === family && m.identifier === null && !!m.needs,
      `${m?.ats} id=${m?.identifier ?? 'null'}`
    )
  }
  const vendorWalk = discoverTenantsFromPostings([at('https://www.greenhouse.io/pricing'), at('https://www.lever.co/customers')])
  check(
    '…and nothing a vendor page produced is ever marked listable',
    vendorWalk.tenants.every((t) => !t.listable),
    JSON.stringify(vendorWalk.tenants.map((t) => `${t.ats}:${t.identifier}`))
  )
  const ripplingApi = atsFamilyFromUrl('https://api.rippling.com/platform/api/ats/v1/board/acme/jobs')
  check(
    "Rippling's documented API path yields the board slug, not 'platform'",
    ripplingApi?.ats === 'rippling' && ripplingApi.identifier === 'acme',
    ripplingApi?.identifier ?? 'null'
  )
  check(
    'a Rippling careers link still resolves from the first segment',
    atsFamilyFromUrl('https://ats.rippling.com/acme/jobs/123')?.identifier === 'acme'
  )

  // SuccessFactors: on the shared SAP pods the first host label is the POD and
  // the company is in the query string. Reading `career5` as a tenant reports a
  // complete identifier that names SAP's infrastructure.
  const sfPod = atsFamilyFromUrl('https://career5.successfactors.eu/career?company=Acme')
  check(
    'a shared SuccessFactors pod resolves the company from ?company=, not the subdomain',
    sfPod?.ats === 'successfactors' && sfPod.identifier === 'Acme',
    sfPod?.identifier ?? 'null'
  )
  const sfBare = atsFamilyFromUrl('https://performancemanager.successfactors.eu/sfcareer/jobreqcareer?jobId=1')
  check(
    '…and a pod host with no company parameter admits it cannot say',
    sfBare?.ats === 'successfactors' && sfBare.identifier === null && /company parameter/.test(sfBare.needs ?? ''),
    sfBare?.needs ?? 'null'
  )
  const sfRmk = atsFamilyFromUrl('https://assaabloy.jobs2web.com/search/')
  check(
    '…while a dedicated rmk domain still resolves from the host',
    sfRmk?.ats === 'successfactors' && sfRmk.identifier === 'assaabloy',
    sfRmk?.identifier ?? 'null'
  )

  console.log('\ntenant discovery: a Workday board round-trips')
  const wd = atsFamilyFromUrl('https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/X')
  const [tenant, pod, site] = (wd?.identifier ?? '').split('/')
  check('tenant/wdN/site are all three present', tenant === 'nvidia' && /^wd\d+$/.test(pod ?? '') && site === 'NVIDIAExternalCareerSite', wd?.identifier ?? '')
  check('the board URL is rebuilt from the parts', wd?.boardUrl === 'https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite', wd?.boardUrl ?? '')
  const wdFound = find(discoverTenantsFromPostings([at('https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/X')]).tenants, 'workday')
  const ref = wdFound ? toAtsBoardRef(wdFound) : null
  check('it hands the six adapters a board ref they can list', ref?.ats === 'workday' && ref?.identifier === 'nvidia/wd5/NVIDIAExternalCareerSite', JSON.stringify(ref))
  const oracleRef = toAtsBoardRef(
    discoverTenantsFromPostings([at('https://egug.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/1')]).tenants[0]
  )
  check("an unadapted family is kept as ats:'other', not dropped", oracleRef?.ats === 'other' && oracleRef?.identifier === 'egug.fa.us2.oraclecloud.com|CX_1', JSON.stringify(oracleRef))

  console.log('\ntenant discovery: walking a batch of postings')
  const batch: RawJobPosting[] = [
    // Same Greenhouse board, three postings, two spellings of the host.
    at('https://boards.greenhouse.io/acme/jobs/1'),
    at('https://job-boards.greenhouse.io/acme/jobs/2'),
    at('https://boards.greenhouse.io/acme/jobs/3'),
    // Same Workday board, differing only in the case of the site.
    at('https://illumina.wd1.myworkdayjobs.com/en-US/illumina-careers/job/A', 'Illumina'),
    at('https://illumina.wd1.myworkdayjobs.com/en-US/Illumina-Careers/job/B', 'Illumina'),
    // A second Workday SITE at the same tenant is a different board.
    at('https://illumina.wd1.myworkdayjobs.com/en-US/illumina-university/job/C', 'Illumina'),
    // canonical + apply pointing at the same board must count once.
    posting({
      company_name: 'DuPont',
      canonical_url: 'https://dupont.wd1.myworkdayjobs.com/en-US/Careers/job/D',
      apply_url: 'https://dupont.wd1.myworkdayjobs.com/en-US/Careers/job/D?src=x',
      source_url: 'https://dupont.wd1.myworkdayjobs.com/en-US/Careers',
    }),
    // Unrecognised employer host, twice.
    at('https://careers.corning.com/job/17482', 'Corning'),
    at('https://careers.corning.com/job/17483', 'Corning'),
    // Aggregator noise.
    at('https://simplify.jobs/p/abc', 'Acme'),
    at('https://www.linkedin.com/jobs/view/1', 'Acme'),
    // Unusable.
    at('not-a-url', 'Broken Co'),
  ]
  const r = discoverTenantsFromPostings(batch)
  const gh = r.tenants.filter((t) => t.ats === 'greenhouse')
  check('two greenhouse host spellings collapse to one board', gh.length === 1 && gh[0].postings === 3, `${gh.length} boards / ${gh[0]?.postings} postings`)
  const wds = r.tenants.filter((t) => t.ats === 'workday')
  check('a Workday site differing only in case is one board', wds.filter((t) => /illumina-careers/i.test(t.identifier ?? '')).length === 1, JSON.stringify(wds.map((t) => t.identifier)))
  check('a different site at the same tenant is a different board', wds.filter((t) => t.identifier?.startsWith('illumina/')).length === 2, String(wds.length))
  const dupont = wds.find((t) => t.identifier?.startsWith('dupont/'))
  check('canonical + apply + source pointing at one board count once', dupont?.postings === 1, String(dupont?.postings))
  check('the company name rides along', dupont?.companyName === 'DuPont', dupont?.companyName ?? '')
  check('every recognised board carries a sample URL', r.tenants.every((t) => t.sampleUrl.startsWith('http')))
  check('boards are ranked by how many postings pointed at them', r.tenants[0]?.postings === 3, String(r.tenants[0]?.postings))

  const corning = r.unrecognized.find((t) => t.host === 'careers.corning.com')
  check('an unrecognised host is REPORTED, not dropped', !!corning && corning.postings === 2, JSON.stringify(corning))
  check('and it says what a probe must resolve', /ATS family/.test(corning?.needs ?? ''), corning?.needs ?? '')
  check('aggregator hosts are not filed as unrecognised ATSes', !r.unrecognized.some((t) => /linkedin|simplify/.test(t.host)), r.unrecognized.map((t) => t.host).join(', '))
  check('a malformed URL is counted, not thrown on', r.unusable === 1, String(r.unusable))
  check('the census counts boards per family', r.byFamily.workday === 3 && r.byFamily.greenhouse === 1, JSON.stringify(r.byFamily))
  check('listable means an adapter exists AND the identifier is complete', r.tenants.filter((t) => t.listable).length === 4, String(r.tenants.filter((t) => t.listable).length))
  check('postingsScanned reports the input size', r.postingsScanned === batch.length, String(r.postingsScanned))

  const noApply = discoverTenantsFromPostings(batch, { includeApplyUrls: false })
  check('apply/source URLs can be excluded', noApply.urlsExamined < r.urlsExamined, `${noApply.urlsExamined} < ${r.urlsExamined}`)
  const quiet = discoverTenantsFromPostings(batch, { includeUnrecognized: false })
  check('unrecognised reporting can be turned off', quiet.unrecognized.length === 0)
  const noisy = discoverTenantsFromPostings(batch, { dropAggregatorHosts: false })
  check('…and aggregators can be kept when a caller wants them', noisy.unrecognized.some((t) => /linkedin/.test(t.host)))

  console.log('\ntenant discovery: degenerate input')
  const empty = discoverTenantsFromPostings([])
  check('an empty batch is an empty result, not a crash', empty.tenants.length === 0 && empty.unrecognized.length === 0 && empty.postingsScanned === 0)
  // The fixture posting still carries a `source_url`, so state what is actually
  // being asserted: no board is invented from a host no family claims, and the
  // host is reported once rather than dropped.
  const bare = discoverTenantsFromPostings([posting()])
  check(
    'a posting whose only URL belongs to no family invents no board',
    bare.tenants.length === 0 && bare.unrecognized.length === 1 && bare.unrecognized[0].host === 'example.com',
    JSON.stringify(bare.unrecognized.map((t) => t.host))
  )
  const noUrls = discoverTenantsFromPostings([posting({ source_url: '', canonical_url: null, apply_url: null })])
  check(
    'a posting with no URLs at all examines nothing',
    noUrls.urlsExamined === 0 && noUrls.tenants.length === 0 && noUrls.unrecognized.length === 0,
    String(noUrls.urlsExamined)
  )
  check('the summary renders', summarizeTenants(r).length === Object.keys(r.byFamily).length)

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
