// Offline tests for the job core and the source adapters' normalizers.
//
// No network, no keys. Adapters are exercised on recorded fixtures in the
// REAL response shapes (evals/career/fixtures/ats/*.json, captured live in
// Aug 2026); the verifier runs against a stubbed registry and fetcher so every
// branch is reachable deterministically.
//   npx tsx scripts/test-career-jobs.ts

import fs from 'fs'
import path from 'path'

import { normalizeGreenhouseJob, matchGreenhouseUrl, type GreenhouseJob } from '../lib/career/sources/greenhouse'
import { normalizeLeverPosting, matchLeverUrl, type LeverPosting } from '../lib/career/sources/lever'
import { normalizeAshbyJob, matchAshbyUrl, type AshbyJob } from '../lib/career/sources/ashby'
import { normalizeSmartRecruitersPosting, matchSmartRecruitersUrl, type SmartRecruitersPosting } from '../lib/career/sources/smartrecruiters'
import { normalizeWorkableJob, matchWorkableUrl, type WorkableJob } from '../lib/career/sources/workable'
import { createSourceRegistry, getSourceRegistry, matchAnyAtsUrl } from '../lib/career/sources/registry'
import { htmlToText, extractLinks, decodeEntities } from '../lib/career/sources/html'
import { parseRobots, isPathAllowed } from '../lib/career/sources/robots'
import { isExcludedHost, slugCandidates, internshipLike } from '../lib/career/sources/fetch'
import { extractHints } from '../lib/career/sources/careers'
import type { FetchedPage, JobSourceAdapter, PageFetcher, RawJobPosting } from '../lib/career/sources/types'

import { parseLocation, locationTier, metroHints } from '../lib/career/jobs/location'
import { normalizeTitle, roleFamilyFromTitle, detectEmploymentType, detectSeason, buildNormalizedJob, titleSaysOtherSeason } from '../lib/career/jobs/normalize'
import { clusterJobs, duplicateRate, shingleJaccard, titleSimilarity, TITLE_SIMILARITY_THRESHOLD } from '../lib/career/jobs/dedupe'
import { verifyJob, applyStaleness, titleCoverage } from '../lib/career/jobs/verify'
import { applyHardConstraints, isInternshipLike } from '../lib/career/jobs/filters'
import { buildSnapshot, descriptionSha } from '../lib/career/jobs/snapshot'
import { DEFAULT_MISSION_PREFERENCES, DEFAULT_HARD_CONSTRAINTS } from '../lib/career/missions/store'

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

const FIX = path.join(process.cwd(), 'evals', 'career', 'fixtures')
const load = <T>(rel: string): T => JSON.parse(fs.readFileSync(path.join(FIX, rel), 'utf8')) as T

// ─── HTML ────────────────────────────────────────────────────────────────────

const text = htmlToText('<div><h2>Who we are</h2><script>alert(1)</script><p>Hello&nbsp;<b>world</b> &amp; friends</p><ul><li>One</li><li>Two</li></ul><style>p{}</style></div>')
check('htmlToText drops script/style', !text.includes('alert') && !text.includes('p{}'))
check('htmlToText decodes entities', text.includes('Hello world & friends'))
check('htmlToText keeps paragraph breaks', /Who we are\n/.test(text) && /One\nTwo/.test(text))
check('htmlToText undoes double escaping', htmlToText('&lt;p&gt;Hi &amp;amp; bye&lt;/p&gt;') === 'Hi & bye')
eq('decodeEntities numeric', decodeEntities('&#8217;s &#x27;x&#x27;'), '’s \'x\'')
const links = extractLinks('<a href="/careers">Careers</a><a href="https://boards.greenhouse.io/acme">Jobs</a><a href="mailto:x@y">m</a>', 'https://acme.com/about')
eq('extractLinks absolute + skip mailto', links.map((l) => l.url), ['https://acme.com/careers', 'https://boards.greenhouse.io/acme'])

// ─── Adapters on fixtures ────────────────────────────────────────────────────

const gh = load<{ jobs: GreenhouseJob[] }>('ats/greenhouse-list.json')
const ghBoard = { ats: 'greenhouse' as const, identifier: 'andurilindustries', company_name: 'Anduril Industries' }
const ghPost = gh.jobs.map((j) => normalizeGreenhouseJob(j, ghBoard, '2026-08-27T00:00:00Z'))
check('greenhouse fixture has 2 jobs', ghPost.length === 2)
eq('greenhouse ats id', ghPost[0].ats_job_id, String(gh.jobs[0].id))
eq('greenhouse canonical url', ghPost[0].canonical_url, `https://boards.greenhouse.io/andurilindustries/jobs/${gh.jobs[0].id}`)
check('greenhouse text stripped of html', !!ghPost[0].description_text && !/<[a-z]+>/.test(ghPost[0].description_text) && !/&lt;/.test(ghPost[0].description_text))
check('greenhouse html retained', !!ghPost[0].description_html)
eq('greenhouse employment hint from metadata', ghPost[0].employment_type_hint, 'Intern')
check('greenhouse intern title', /intern/i.test(ghPost[0].title))
check('greenhouse location', !!ghPost[0].location_raw && ghPost[0].location_raw.includes('United States'))

const lv = load<LeverPosting[]>('ats/lever-list.json')
const lvBoard = { ats: 'lever' as const, identifier: 'palantir', company_name: 'Palantir' }
const lvPost = lv.map((p) => normalizeLeverPosting(p, lvBoard))
eq('lever ats id', lvPost[0].ats_job_id, lv[0].id)
eq('lever canonical', lvPost[0].canonical_url, lv[0].hostedUrl)
eq('lever hint', lvPost[0].employment_type_hint, 'Internship')
eq('lever location', lvPost[0].location_raw, 'New York, NY')
check('lever text has no tags', !!lvPost[0].description_text && !/<\/?[a-z]+>/.test(lvPost[0].description_text))
check('lever lists folded into text', lvPost[0].description_text!.length > (lv[0].descriptionPlain ?? '').length)

const ab = load<{ jobs: AshbyJob[] }>('ats/ashby-list.json')
const abBoard = { ats: 'ashby' as const, identifier: 'ramp', company_name: 'Ramp' }
const abPost = ab.jobs.map((j) => normalizeAshbyJob(j, abBoard))
eq('ashby ats id', abPost[0].ats_job_id, ab.jobs[0].id)
eq('ashby canonical', abPost[0].canonical_url, ab.jobs[0].jobUrl)
eq('ashby hint', abPost[0].employment_type_hint, 'Intern')
check('ashby text is plain', !!abPost[0].description_text && !/<[a-z]+>/.test(abPost[0].description_text))
check('ashby hybrid folded into location', /Hybrid/.test(abPost[1].location_raw ?? ''))

const sr = load<{ content: SmartRecruitersPosting[] }>('ats/smartrecruiters-list.json')
const srSingle = load<SmartRecruitersPosting>('ats/smartrecruiters-single.json')
const srBoard = { ats: 'smartrecruiters' as const, identifier: 'BoschGroup', company_name: 'Bosch Group' }
const srList = sr.content.map((p) => normalizeSmartRecruitersPosting(p, srBoard))
const srOne = normalizeSmartRecruitersPosting(srSingle, srBoard)
eq('smartrecruiters ats id', srList[0].ats_job_id, sr.content[0].id)
check('smartrecruiters canonical from list', srList[0].canonical_url === `https://jobs.smartrecruiters.com/BoschGroup/${sr.content[0].id}-logistics-supply-chain-intern`)
eq('smartrecruiters canonical from single strips oga', srOne.canonical_url, srSingle.postingUrl)
check('smartrecruiters hint carries Intern', /Intern/.test(srList[0].employment_type_hint ?? ''))
check('smartrecruiters single has description text', !!srOne.description_text && srOne.description_text.length > 100 && !/<[a-z]+>/.test(srOne.description_text))
eq('smartrecruiters requisition id', srList[0].requisition_id, sr.content[0].refNumber ?? null)
check('smartrecruiters location', /Grand Rapids, MI, United States/.test(srList[0].location_raw ?? ''))

const wk = load<{ results: WorkableJob[] }>('ats/workable-list.json')
const wkSingle = load<WorkableJob>('ats/workable-single.json')
const wkBoard = { ats: 'workable' as const, identifier: 'blueground', company_name: 'Blueground' }
const wkList = wk.results.map((j) => normalizeWorkableJob(j, wkBoard))
const wkOne = normalizeWorkableJob(wkSingle, wkBoard)
eq('workable ats id', wkList[0].ats_job_id, wk.results[0].shortcode)
eq('workable canonical', wkList[0].canonical_url, `https://apply.workable.com/blueground/j/${wk.results[0].shortcode}/`)
eq('workable hint', wkList[0].employment_type_hint, 'Full-time')
check('workable remote in location', /Remote/.test(wkList[0].location_raw ?? ''))
check('workable single text stripped', !!wkOne.description_text && !/<[a-z]+>/.test(wkOne.description_text) && /Blueground/.test(wkOne.description_text))

// ─── matchUrl ────────────────────────────────────────────────────────────────

const reg = getSourceRegistry()
const m = (u: string) => reg.matchUrl(u)
eq('gh board url', m('https://boards.greenhouse.io/stripe')?.match.board.identifier, 'stripe')
eq('gh job url', m('https://boards.greenhouse.io/stripe/jobs/8026689')?.match.jobId, '8026689')
eq('gh job-boards host', m('https://job-boards.greenhouse.io/anduril/jobs/123456')?.match.board.identifier, 'anduril')
eq('gh embed', m('https://boards.greenhouse.io/embed/job_app?for=acme&token=99')?.match, { board: { ats: 'greenhouse', identifier: 'acme', board_url: 'https://boards.greenhouse.io/acme' }, jobId: '99' })
eq('lever board', m('https://jobs.lever.co/palantir')?.match.board.identifier, 'palantir')
eq('lever job + apply', m('https://jobs.lever.co/palantir/774cf5c9-bf6a-4d77-bf60-d50ef1beb1a0/apply')?.match.jobId, '774cf5c9-bf6a-4d77-bf60-d50ef1beb1a0')
eq('ashby job', m('https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245')?.match, { board: { ats: 'ashby', identifier: 'ramp', board_url: 'https://jobs.ashbyhq.com/ramp' }, jobId: '34413f8d-26bf-4bbc-8ade-eb309a0e2245' })
eq('ashby board only', m('https://jobs.ashbyhq.com/ramp')?.match.jobId ?? null, null)
eq('smartrecruiters slug url', m('https://jobs.smartrecruiters.com/BoschGroup/744000146057040-logistics-supply-chain-intern')?.match.jobId, '744000146057040')
eq('smartrecruiters careers host', m('https://careers.smartrecruiters.com/Ubisoft2/744000145929979')?.match.board.identifier, 'Ubisoft2')
eq('workable job', m('https://apply.workable.com/blueground/j/0FD01ABC66/')?.match.jobId, '0FD01ABC66')
eq('workable board', m('https://apply.workable.com/blueground/')?.match.board.ats, 'workable')
eq('negative: company site', m('https://stripe.com/jobs/search?gh_jid=8026689'), null)
eq('negative: greenhouse marketing', m('https://www.greenhouse.io/'), null)
eq('negative: linkedin', m('https://www.linkedin.com/jobs/view/123'), null)
eq('negative: workable api path', m('https://apply.workable.com/api/v3/accounts/x/jobs'), null)
eq('other: workday', matchAnyAtsUrl('https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Intern_JR1990')?.identifier, 'nvidia')
eq('other: workday ats', matchAnyAtsUrl('https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite')?.ats, 'other')
eq('other: icims', matchAnyAtsUrl('https://careers-acme.icims.com/jobs/1234/intern/job')?.identifier, 'acme')
eq('other: jobvite', matchAnyAtsUrl('https://jobs.jobvite.com/acme/job/oX1')?.identifier, 'acme')
eq('other: breezy', matchAnyAtsUrl('https://acme.breezy.hr/p/abc')?.family, 'breezy')
eq('other: adapted wins', matchAnyAtsUrl('https://jobs.lever.co/acme')?.ats, 'lever')
eq('other: negative', matchAnyAtsUrl('https://acme.com/careers'), null)

// ─── robots / fetch policy ───────────────────────────────────────────────────

const robots = parseRobots('User-agent: *\nDisallow: /private/\nAllow: /private/jobs\n\nUser-agent: OutreachOS-CareerBot\nDisallow: /careers/internal\nCrawl-delay: 2', 'https://x.com')
eq('robots picks our group', robots.disallow, ['/careers/internal'])
eq('robots crawl delay', robots.crawlDelayMs, 2000)
const star = parseRobots('User-agent: *\nDisallow: /private/\nAllow: /private/jobs$\nDisallow: /*.pdf$', 'https://x.com')
check('robots star disallow', !isPathAllowed(star, '/private/x'))
check('robots allow longest match', isPathAllowed(star, '/private/jobs'))
check('robots wildcard', !isPathAllowed(star, '/docs/a.pdf'))
check('robots empty allows all', isPathAllowed(parseRobots('User-agent: *\nDisallow:', 'https://x.com'), '/anything'))
check('excluded hosts', isExcludedHost('https://www.linkedin.com/jobs') && isExcludedHost('https://indeed.com/x') && !isExcludedHost('https://acme.com'))
eq('slugCandidates', slugCandidates('Anduril Industries', 'anduril.com'), ['anduril', 'andurilindustries', 'anduril-industries'])
check('internshipLike', internshipLike('Software Engineer', 'Intern') && internshipLike('Co-op Engineer', null) && !internshipLike('Senior Engineer', 'Full-time'))
const hints = extractHints('We are not currently hiring interns. Our Summer 2027 internship applications open in September.')
check('careers hints', hints.some((h) => h.includes('summer 2027')) && hints.some((h) => h.startsWith('not currently hiring')), JSON.stringify(hints))

// ─── parseLocation ───────────────────────────────────────────────────────────

const L = (raw: string) => parseLocation(raw)
eq('loc SF CA', [L('San Francisco, CA').city, L('San Francisco, CA').state, L('San Francisco, CA').country], ['San Francisco', 'CA', 'US'])
eq('loc NY NY US', [L('New York, NY, United States').city, L('New York, NY, United States').state, L('New York, NY, United States').country], ['New York', 'NY', 'US'])
const r1 = L('Remote - US')
eq('loc Remote - US', [r1.remote, r1.country, r1.city], [true, 'US', null])
const h1 = L('Hybrid · Boston, MA')
eq('loc Hybrid Boston', [h1.hybrid, h1.city, h1.state], [true, 'Boston', 'MA'])
eq('loc SF Bay Area', [L('SF Bay Area').city, L('SF Bay Area').state], ['San Francisco Bay Area', 'CA'])
eq('loc Menlo Park California', [L('Menlo Park, California').city, L('Menlo Park, California').state], ['Menlo Park', 'CA'])
eq('loc NYC', [L('NYC').city, L('NYC').state, L('NYC').country], ['New York', 'NY', 'US'])
const mult = L('Multiple locations')
eq('loc multiple', [mult.multiple, mult.city], [true, null])
eq('loc Cambridge MA', [L('Cambridge, MA').city, L('Cambridge, MA').state], ['Cambridge', 'MA'])
eq('loc Cambridge Massachusetts', L('Cambridge, Massachusetts').state, 'MA')
eq('loc Bellevue WA', L('Bellevue, WA').state, 'WA')
eq('loc Seattle only', [L('Seattle').city, L('Seattle').state, L('Seattle').country], ['Seattle', 'WA', 'US'])
eq('loc London', [L('London, United Kingdom').city, L('London, United Kingdom').country], ['London', 'GB'])
eq('loc London bare', [L('London').city, L('London').country], ['London', null])
eq('loc Paris France', L('Paris, France').country, 'FR')
eq('loc Toronto', L('Toronto, Ontario, Canada').country, 'CA')
eq('loc Remote', [L('Remote').remote, L('Remote').country], [true, null])
eq('loc Remote (US)', [L('Remote (US)').remote, L('Remote (US)').country], [true, 'US'])
eq('loc Remote United States', L('Remote - United States').country, 'US')
eq('loc US only', [L('United States').country, L('United States').city], ['US', null])
eq('loc semicolon multi', [L('Atlanta, Georgia, United States; Boston, Massachusetts, United States').multiple, L('Atlanta, Georgia, United States; Boston, Massachusetts, United States').all.length], [true, 2])
eq('loc comma cities', [L('Toronto, New York, San Francisco').multiple, L('Toronto, New York, San Francisco').all.length], [true, 3])
eq('loc NY (HQ)', [L('New York, NY (HQ)').city, L('New York, NY (HQ)').state], ['New York', 'NY'])
eq('loc Brooklyn', [L('Brooklyn, NY').city, L('Brooklyn, NY').state], ['Brooklyn', 'NY'])
eq('loc Washington DC', [L('Washington, DC').city, L('Washington, DC').state], ['Washington', 'DC'])
eq('loc Chicago IL zip', [L('Chicago, IL 60601').city, L('Chicago, IL 60601').state], ['Chicago', 'IL'])
eq('loc Palo Alto CA or Remote', [L('Palo Alto, CA or Remote').city, L('Palo Alto, CA or Remote').remote], ['Palo Alto', true])
eq('loc empty', L('').city, null)
eq('loc South San Francisco', L('South San Francisco, CA').city, 'South San Francisco')
eq('loc Jersey City', L('Jersey City, NJ').state, 'NJ')

// ─── locationTier ────────────────────────────────────────────────────────────

const tiers = DEFAULT_MISSION_PREFERENCES.geo_tiers
const T = (raw: string) => locationTier(parseLocation(raw), tiers)
eq('tier SF', T('San Francisco, CA'), 1)
eq('tier Brooklyn', T('Brooklyn, NY'), 1)
eq('tier Menlo Park', T('Menlo Park, CA'), 1)
eq('tier SF Bay Area', T('SF Bay Area'), 1)
eq('tier NYC', T('NYC'), 1)
eq('tier Jersey City', T('Jersey City, NJ'), 1)
eq('tier Cambridge MA', T('Cambridge, MA'), 2)
eq('tier Bellevue', T('Bellevue, WA'), 2)
eq('tier Santa Monica', T('Santa Monica, CA'), 2)
eq('tier Arlington VA', T('Arlington, VA'), 2)
eq('tier Washington DC', T('Washington, DC'), 2)
eq('tier Chicago', T('Chicago, IL'), 3)
eq('tier Houston', T('Houston, TX'), 3)
eq('tier Remote-US', T('Remote - US'), 2)
eq('tier Remote-US override', locationTier(parseLocation('Remote - US'), tiers, { remoteUsTier: 3 }), 3)
eq('tier Remote unknown country', T('Remote'), null)
eq('tier London', T('London, United Kingdom'), null)
eq('tier multi incl SF', T('Toronto, New York, San Francisco'), 1)
eq('tier multi no tier1', T('Atlanta, Georgia, United States; Boston, Massachusetts, United States'), 2)
eq('tier empty', T(''), null)

// ─── titles, families, employment, season ────────────────────────────────────

eq('title strip season', normalizeTitle('Summer 2027 Intern - Manufacturing'), 'Intern, Manufacturing')
eq('title strip parenthetical', normalizeTitle('Process Engineering Intern (Summer 2027)'), 'Process Engineering Intern')
eq('title strip req id', normalizeTitle('Mechanical Engineer Intern - Req #12345'), 'Mechanical Engineer Intern')
eq('title suffix intern', normalizeTitle('Supply Chain - Internship'), 'Supply Chain Intern')
eq('title year in title', normalizeTitle('2027 Electrical Engineer Intern'), 'Electrical Engineer Intern')
eq('title untouched', normalizeTitle('Senior Process Engineer'), 'Senior Process Engineer')
eq('title collapses spaces', normalizeTitle('  Data   Science  Intern (Remote) '), 'Data Science Intern')

eq('family process', roleFamilyFromTitle('Process Engineering Intern'), 'process_engineering')
eq('family manufacturing', roleFamilyFromTitle('Summer 2027 Intern - Manufacturing'), 'manufacturing_operations')
eq('family quality', roleFamilyFromTitle('Quality Engineering Co-op'), 'quality')
eq('family supply chain', roleFamilyFromTitle('Logistics/Supply Chain Intern'), 'supply_chain')
eq('family mechanical', roleFamilyFromTitle('Mechanical Design Engineer Intern'), 'mechanical')
eq('family chemical', roleFamilyFromTitle('Chemical Engineering Intern'), 'chemical_engineering')
eq('family materials', roleFamilyFromTitle('Materials Science Intern'), 'materials')
eq('family energy', roleFamilyFromTitle('Energy Storage Analyst Intern'), 'energy')
eq('family data', roleFamilyFromTitle('Data Science Intern'), 'data_ai')
eq('family software', roleFamilyFromTitle('Software Engineer Internship, Android'), 'software')
eq('family product', roleFamilyFromTitle('Product Management Intern'), 'product')
eq('family strategy', roleFamilyFromTitle('Intern, Strategy'), 'strategy_consulting')
eq('family bizops', roleFamilyFromTitle('Business Operations Intern'), 'business_ops')
eq('family finance', roleFamilyFromTitle('Summer Analyst - Investment Banking'), 'finance')
eq('family research', roleFamilyFromTitle('Research Intern'), 'research')
eq('family sustainability', roleFamilyFromTitle('Sustainability Intern'), 'sustainability')
eq('family from department', roleFamilyFromTitle('Intern', 'Manufacturing'), 'manufacturing_operations')
eq('family other', roleFamilyFromTitle('Barista'), 'other')
eq('family forward deployed', roleFamilyFromTitle('Forward Deployed Software Engineer, Internship - Commercial'), 'software')

eq('emp senior not intern', detectEmploymentType('Senior Process Engineer', 'Full-time'), 'full_time')
eq('emp staff not intern', detectEmploymentType('Staff Engineer (mentors interns)', null), 'full_time')
eq('emp intern title', detectEmploymentType('Summer 2027 Intern - Manufacturing', null), 'internship')
eq('emp coop', detectEmploymentType('Fall 2026 Co-op', null), 'co_op')
eq('emp hint intern', detectEmploymentType('Software Engineer', 'Intern'), 'internship')
eq('emp summer analyst', detectEmploymentType('Summer Analyst', null), 'internship')
eq('emp new grad', detectEmploymentType('Software Engineer, New Grad', null), 'full_time')
eq('emp contract hint', detectEmploymentType('Engineer', 'Contract'), 'contract')
eq('emp part-time', detectEmploymentType('Engineer', 'Part-time'), 'part_time')
eq('emp unknown', detectEmploymentType('Engineer', null), 'unknown')
eq('emp from text', detectEmploymentType('Engineering Program', null, 'Join our internship program this summer.'), 'internship')
eq('emp lead', detectEmploymentType('Internal Audit Data Analytics Lead', null), 'full_time')

eq('season summer 2027', detectSeason('Summer 2027 Intern - Manufacturing', ''), 'summer_2027')
eq('season paren', detectSeason('Process Engineering Intern (Summer 2027)', ''), 'summer_2027')
eq('season may 2027 in text', detectSeason('Engineering Intern', 'The program runs from June 2027 through August.'), 'summer_2027')
eq('season fall 2026', detectSeason('Fall 2026 Co-op', ''), 'other_season')
eq('season summer 2026', detectSeason('Summer 2026 Intern', ''), 'other_season')
eq('season spring 2027', detectSeason('Spring 2027 Intern', ''), 'other_season')
eq('season unspecified', detectSeason('Intern, Strategy', ''), 'unspecified')
eq('season 2027 year only', detectSeason('2027 Electrical Engineer Intern', ''), 'unspecified')
eq('season unknown for full-time', detectSeason('Senior Process Engineer', '', 'full_time'), 'unknown')
eq('season summer 27 apostrophe', detectSeason("Summer '27 Intern", ''), 'summer_2027')
eq('season both mentioned prefers target', detectSeason('Intern', 'Summer 2026 cohort closed; now hiring Summer 2027.'), 'summer_2027')

// ─── buildNormalizedJob ──────────────────────────────────────────────────────

const nj = buildNormalizedJob(ghPost[0], null, { geo_tiers: tiers })
eq('nj employment', nj.employment_type, 'internship')
eq('nj family', nj.role_family, 'electrical')
check('nj tier from multi-site', nj.location_tier === 2, `tier ${nj.location_tier}`)
eq('nj season', nj.season_relevance, 'unspecified')
eq('nj company_key', nj.company_key, 'n:anduril industries')
eq('nj canonical', nj.canonical_url, ghPost[0].canonical_url)
const njx = buildNormalizedJob(ghPost[0], {
  employment_type: 'co_op', season_relevance: 'summer_2027', work_mode: 'hybrid', role_family: 'hardware', location_raw: null, deadline: '2026-10-01',
  compensation: '$40/hr', min_qualifications: ['BS EE'], preferred_qualifications: [], graduation_eligibility: null, work_authorization: null,
  skills: ['Altium'], responsibilities: [], industry: 'defense', appears_closed: true, confidence: 0.9,
}, { geo_tiers: tiers })
eq('nj extracted overrides', [njx.employment_type, njx.season_relevance, njx.work_mode, njx.role_family, njx.verification_status], ['co_op', 'summer_2027', 'hybrid', 'hardware', 'CLOSED'])
eq('nj extracted lists', njx.skills, ['Altium'])

// ─── dedupe ──────────────────────────────────────────────────────────────────

const dupes = load<RawJobPosting[]>('jobs/dupes.json').map((r) => buildNormalizedJob(r, null, { geo_tiers: tiers }))
const clustered = clusterJobs(dupes)
eq('dedupe cluster count', clustered.clusters.length, 3)
const big = clustered.clusters.find((c) => c.length === 3)
check('dedupe three-way cluster', !!big)
if (big) {
  const canon = clustered.canonicalOf(big)
  eq('dedupe canonical is greenhouse', canon.ats_type, 'greenhouse')
  eq('dedupe canonical id', canon.ats_job_id, '4400123')
}
const mergedBig = clustered.merged.find((j) => j.ats_job_id === '4400123')
eq('dedupe sources merged', mergedBig?.sources.map((s) => s.source_type).sort(), ['aggregator', 'careers_page', 'greenhouse'])
check('dedupe supply chain separate', clustered.clusters.some((c) => c.length === 1 && c[0].ats_job_id === '4400124'))
check('dedupe other company separate', clustered.clusters.some((c) => c.length === 1 && c[0].company_key === 'd:betaenergy.io'))
check('dedupe rate', Math.abs(duplicateRate(clustered.clusters) - 0.4) < 1e-9, String(duplicateRate(clustered.clusters)))
check('shingle jaccard identical', shingleJaccard('a b c d e f g h', 'a b c d e f g h') === 1)
check('shingle jaccard disjoint', shingleJaccard('a b c d e f g', 'h i j k l m n') === 0)

// ─── verify ──────────────────────────────────────────────────────────────────

function stubAdapter(result: 'open' | 'closed' | 'not_found' | 'error'): JobSourceAdapter {
  return {
    id: 'greenhouse', source_type: 'greenhouse', isAvailable: () => true, matchUrl: matchGreenhouseUrl,
    detectBoard: async () => null,
    listPostings: async () => ({ postings: [], total_on_board: 0, board_url: null }),
    fetchPosting: async () => ({ status: result, posting: null, note: `stub ${result}` }),
  }
}
function stubFetcher(page: Partial<FetchedPage>): PageFetcher {
  return { fetch: async (url) => ({ url, final_url: url, status: 200, text: '', title: null, links: [], robots_blocked: false, retrieved_at: '', ...page }) }
}
const vjob = { title: 'Process Engineering Intern', ats_type: 'greenhouse', ats_job_id: '4400123', canonical_url: 'https://boards.greenhouse.io/acme/jobs/4400123', apply_url: null, verification_status: 'UNVERIFIED' as const }
const pjob = { ...vjob, ats_type: null, ats_job_id: null, canonical_url: 'https://acme.com/careers/x', verification_status: 'LIKELY_OPEN' as const }
const regOf = (a: JobSourceAdapter) => createSourceRegistry([a])
const nofetch = stubFetcher({})

async function verifyTests() {
  eq('verify ats open', (await verifyJob(vjob, { registry: regOf(stubAdapter('open')), fetcher: nofetch })).status, 'VERIFIED_OPEN')
  eq('verify ats not_found', (await verifyJob(vjob, { registry: regOf(stubAdapter('not_found')), fetcher: nofetch })).status, 'CLOSED')
  eq('verify ats closed', (await verifyJob(vjob, { registry: regOf(stubAdapter('closed')), fetcher: nofetch })).status, 'CLOSED')
  eq('verify ats error', (await verifyJob(vjob, { registry: regOf(stubAdapter('error')), fetcher: nofetch })).status, 'ERROR')
  const empty = createSourceRegistry([])
  eq('verify page 404', (await verifyJob(pjob, { registry: empty, fetcher: stubFetcher({ status: 404, error: 'http 404' }) })).status, 'CLOSED')
  eq('verify page 410', (await verifyJob(pjob, { registry: empty, fetcher: stubFetcher({ status: 410, error: 'http 410' }) })).status, 'CLOSED')
  const closedText = await verifyJob(pjob, { registry: empty, fetcher: stubFetcher({ text: 'Process Engineering Intern. This position has been filled.' }) })
  eq('verify page closed phrase', [closedText.status, closedText.closedSignals], ['CLOSED', ['this position has been filled']])
  eq('verify page title present', (await verifyJob(pjob, { registry: empty, fetcher: stubFetcher({ text: 'Join Acme as a process engineering intern this summer.' }) })).status, 'LIKELY_OPEN')
  const amb = await verifyJob(pjob, { registry: empty, fetcher: stubFetcher({ text: 'Welcome to Acme careers. See all openings.' }) })
  eq('verify page ambiguous', amb.status, 'AMBIGUOUS')
  check('verify ambiguous carries page text', !!amb.pageText)
  const rob = await verifyJob(pjob, { registry: empty, fetcher: stubFetcher({ status: 0, robots_blocked: true, error: 'disallowed by robots.txt' }) })
  eq('verify robots keeps prior', rob.status, 'LIKELY_OPEN')
  check('verify robots note', rob.note.startsWith('could not verify: robots'))
  eq('verify fetch error', (await verifyJob(pjob, { registry: empty, fetcher: stubFetcher({ status: 0, error: 'timeout' }) })).status, 'ERROR')
  eq('verify no url', (await verifyJob({ ...pjob, canonical_url: null }, { registry: empty, fetcher: nofetch })).status, 'ERROR')
  eq('verify ats id with no adapter falls to page', (await verifyJob({ ...vjob, ats_type: 'other' }, { registry: empty, fetcher: stubFetcher({ text: 'process engineering intern' }) })).status, 'LIKELY_OPEN')
}

check('titleCoverage', titleCoverage('Process Engineering Intern (Summer 2027)', 'process engineering roles') === 1)
const now = new Date('2026-09-01T00:00:00Z')
eq('stale after window', applyStaleness({ verification_status: 'VERIFIED_OPEN', last_verified_at: '2026-08-01T00:00:00Z' }, now, 14), 'STALE')
eq('fresh within window', applyStaleness({ verification_status: 'VERIFIED_OPEN', last_verified_at: '2026-08-25T00:00:00Z' }, now, 14), 'VERIFIED_OPEN')
eq('closed never stale', applyStaleness({ verification_status: 'CLOSED', last_verified_at: '2026-01-01T00:00:00Z' }, now, 14), 'CLOSED')
eq('never verified not stale', applyStaleness({ verification_status: 'UNVERIFIED', last_verified_at: null }, now, 14), 'UNVERIFIED')

// ─── filters ─────────────────────────────────────────────────────────────────

const base = { employment_type: 'internship' as const, season_relevance: 'unspecified' as const, location_country: 'US', location_tier: 1, work_mode: 'onsite' as const, role_family: 'process_engineering', company_name: 'Acme', title: 'Process Engineering Intern' }
eq('constraints pass default', applyHardConstraints(base, DEFAULT_HARD_CONSTRAINTS).pass, true)
const ft = applyHardConstraints({ ...base, employment_type: 'full_time' }, DEFAULT_HARD_CONSTRAINTS)
eq('constraints fail internship', [ft.pass, ft.failed[0]?.label], [false, 'Internships only'])
eq('constraints fail season', applyHardConstraints({ ...base, season_relevance: 'other_season' }, DEFAULT_HARD_CONSTRAINTS).failed.map((f) => f.label), ['Not a different season'])
eq('constraints fail country', applyHardConstraints({ ...base, location_country: 'GB' }, DEFAULT_HARD_CONSTRAINTS).failed.map((f) => f.label), ['United States'])
eq('constraints empty country passes', applyHardConstraints({ ...base, location_country: null }, DEFAULT_HARD_CONSTRAINTS).pass, true)
eq('constraint contains title', applyHardConstraints(base, [{ dimension: 'title', operator: 'contains', value: ['process', 'quality'], label: 't' }]).pass, true)
eq('constraint not_in family', applyHardConstraints(base, [{ dimension: 'role_family', operator: 'not_in', value: ['software', 'process_engineering'], label: 'f' }]).pass, false)
eq('constraint tier before', applyHardConstraints(base, [{ dimension: 'location_tier', operator: 'before', value: '3', label: 'tier' }]).pass, true)
eq('constraint work_mode', applyHardConstraints(base, [{ dimension: 'work_mode', operator: 'in', value: ['remote', 'hybrid'], label: 'wm' }]).pass, false)
eq('constraint unknown dimension passes', applyHardConstraints(base, [{ dimension: 'graduation_window', operator: 'after', value: '2027', label: 'g' }]).pass, true)
check('isInternshipLike', isInternshipLike({ employment_type: 'unknown', title: 'Summer Analyst' }) && !isInternshipLike({ employment_type: 'full_time', title: 'Intern Coordinator' }) && isInternshipLike({ employment_type: 'co_op', title: 'x' }))

// ─── discovery-eval regressions (wave 2) ─────────────────────────────────────
// Each of these is a case the live discovery eval got wrong once. They stay
// here so the fix cannot quietly come undone.

// Location: suburbs and 'Greater X area' parentheticals name the metro.
eq('tier Newark via Greater NYC parenthetical', T('Newark, NJ (Greater New York City area)'), 1)
eq('tier Woburn is Boston metro', T('Woburn, MA'), 2)
check('metroHints reads Greater Boston area', metroHints('Cambridge, MA (Greater Boston area)').some((h) => h.includes('boston')), JSON.stringify(metroHints('Cambridge, MA (Greater Boston area)')))
// Country: Hungary parsed null before, and an unknown country passes the US constraint by design.
eq('loc Budapest → HU', L('Budapest, Hungary').country, 'HU')
eq('Budapest fails the United States constraint', applyHardConstraints({ ...base, location_country: L('Budapest, Hungary').country }, DEFAULT_HARD_CONSTRAINTS).failed.map((f) => f.label), ['United States'])

// Dedupe: shared templates are not shared jobs.
const TEMPLATE = 'Join our engineering internship program. You will work alongside senior engineers on real projects, present your results and learn our tooling. Requirements: pursuing a BS in engineering, strong fundamentals, curiosity. '.repeat(3)
const rawPost = (over: Partial<RawJobPosting>): RawJobPosting => ({
  source_type: 'greenhouse', source_url: 'https://boards.greenhouse.io/zip/jobs/1', external_id: '1', company_name: 'Zip', company_domain: 'zip.com',
  title: 'Materials Engineer Intern', location_raw: 'South San Francisco, CA', description_text: TEMPLATE, description_html: null, department: null, posted_at: null, updated_at: null,
  apply_url: null, canonical_url: 'https://boards.greenhouse.io/zip/jobs/1', ats_type: 'greenhouse', ats_job_id: '1', requisition_id: null,
  employment_type_hint: 'Intern', raw: {}, retrieved_at: new Date().toISOString(), ...over,
})
const nz = (over: Partial<RawJobPosting>) => buildNormalizedJob(rawPost(over), null, { geo_tiers: tiers })
const pageOnly = (over: Partial<RawJobPosting>): Partial<RawJobPosting> => ({ source_type: 'careers_page', ats_type: null, ats_job_id: null, canonical_url: null, source_url: `https://zip.com/careers/${Math.random()}`, ...over })
eq('dedupe: two ids on the same board never merge, identical bodies or not', clusterJobs([nz({}), nz({ ats_job_id: '2', canonical_url: 'https://boards.greenhouse.io/zip/jobs/2', source_url: 'https://boards.greenhouse.io/zip/jobs/2' })]).clusters.length, 2)
eq('dedupe: control — same posting without ids merges on title + location', clusterJobs([nz(pageOnly({})), nz(pageOnly({}))]).clusters.length, 1)
eq('dedupe: Spring vs Summer 2027 twins never merge', clusterJobs([nz(pageOnly({ title: 'Materials Engineer Intern (Spring 2027)' })), nz(pageOnly({ title: 'Materials Engineer Intern (Summer 2027)' }))]).clusters.length, 2)
check('titleSimilarity: Backend vs Security SWE intern below the threshold', titleSimilarity('backend software engineer intern', 'security engineer intern') < TITLE_SIMILARITY_THRESHOLD, String(titleSimilarity('backend software engineer intern', 'security engineer intern')))
eq('dedupe: identical template bodies with dissimilar titles never merge', clusterJobs([nz(pageOnly({ title: 'Backend Software Engineer Intern' })), nz(pageOnly({ title: 'Security Engineer Intern' }))]).clusters.length, 2)

// Season: a title naming only a non-summer season of the target year overrules the extractor.
eq('titleSaysOtherSeason Spring 2027', titleSaysOtherSeason('Computational Physics Intern (Spring 2027)'), true)
eq('titleSaysOtherSeason Spring & Summer 2027', titleSaysOtherSeason('Materials Engineer Intern (Spring & Summer 2027)'), false)
eq('titleSaysOtherSeason Fall 2027 Co-op', titleSaysOtherSeason('Fall 2027 Co-op'), true)
eq('titleSaysOtherSeason no season', titleSaysOtherSeason('Process Engineering Intern'), false)
const springOverride = buildNormalizedJob(rawPost({ title: 'Computational Physics Intern (Spring 2027)' }), {
  employment_type: 'internship', season_relevance: 'summer_2027', work_mode: 'onsite', role_family: 'research', location_raw: null, deadline: null,
  compensation: null, min_qualifications: [], preferred_qualifications: [], graduation_eligibility: null, work_authorization: null,
  skills: [], responsibilities: [], industry: null, appears_closed: false, confidence: 0.9,
}, { geo_tiers: tiers })
eq('buildNormalizedJob: title season overrides extractor summer_2027', springOverride.season_relevance, 'other_season')

// ─── snapshot ────────────────────────────────────────────────────────────────

const s1 = buildSnapshot(dupes[0])
const s2 = buildSnapshot({ ...dupes[0], title: 'Renamed', description_text: `  ${dupes[0].description_text}\n` })
check('snapshot sha stable over whitespace and title', s1.sha256 === s2.sha256)
check('snapshot sha changes with text', buildSnapshot({ ...dupes[0], description_text: 'different' }).sha256 !== s1.sha256)
check('snapshot sha is hex64', /^[0-9a-f]{64}$/.test(s1.sha256))
check('descriptionSha null', descriptionSha(null) === descriptionSha(''))
check('snapshot structured', s1.structured.employment_type === 'internship')

// ─── run ─────────────────────────────────────────────────────────────────────

verifyTests().then(() => {
  console.log(`\ntest-career-jobs: ${passed} passed, ${failed} failed`)
  for (const f of failures) console.log(`  FAIL ${f}`)
  process.exit(failed ? 1 : 0)
})
