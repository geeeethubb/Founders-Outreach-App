// Offline checks for the generalized discovery source interface, the coverage
// ledger, the diversity measurement and the run report.
//
//   npx tsx scripts/test-career-coverage.ts
//
// No network, no keys, no database. Every source is a stub. What is asserted is
// the part the audit says was missing: that a run can SAY what it searched,
// that an unconfigured paid source is named rather than fatal, that overlapping
// sources are counted once, and that the GE Vernova shape — 107 of 284 postings
// from one employer — is flagged with the company named.

import { createDiscoveryRegistry, discoveryRegistry, registerDiscoverySource, clearRegisteredDiscoverySources, wrapAtsAdapter } from '../lib/career/sources/registry'
import type { JobSourceAdapter, RawJobPosting } from '../lib/career/sources/types'
import type { JobDiscoverySource } from '../lib/career/sources/discovery-types'
import { emptyDiscoveryResult, estimateCallCostUsd, sourceClassOf } from '../lib/career/sources/discovery-types'
import {
  coverageRows,
  coverageTotals,
  emptyCoverageLedger,
  noteSource,
  postingKey,
  recordPage,
  recordSearchResult,
} from '../lib/career/discovery/coverage'
import { MAX_COMPANY_SHARE, measureDiversity, shouldDiversify, summarizeDiversity, type DiversityItem } from '../lib/career/discovery/diversity'
import { buildScoutReport, renderScoutReport, scoutReportFromRunRow, toReportPayload, SCOUT_REPORT_STATS_KEY } from '../lib/career/scout/report'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

function raw(over: Partial<RawJobPosting> = {}): RawJobPosting {
  return {
    source_type: 'greenhouse',
    source_url: 'https://boards.greenhouse.io/acme/jobs/1',
    external_id: '1',
    company_name: 'Acme',
    company_domain: 'acme.com',
    title: 'Process Engineer Intern',
    location_raw: 'Houston, TX',
    description_text: 'Do process work.',
    description_html: null,
    department: null,
    posted_at: null,
    updated_at: null,
    apply_url: null,
    canonical_url: 'https://boards.greenhouse.io/acme/jobs/1',
    ats_type: 'greenhouse',
    ats_job_id: '1',
    requisition_id: null,
    employment_type_hint: 'Intern',
    raw: {},
    retrieved_at: new Date().toISOString(),
    ...over,
  }
}

/** A stub ATS adapter: the existing interface, untouched. */
function fakeAdapter(over: Partial<JobSourceAdapter> = {}): JobSourceAdapter {
  return {
    id: 'greenhouse',
    source_type: 'greenhouse',
    isAvailable: () => true,
    matchUrl: () => null,
    detectBoard: async ({ companyName }) => (companyName === 'Acme' ? { ats: 'greenhouse', identifier: 'acme' } : null),
    listPostings: async () => ({
      postings: [raw(), raw({ external_id: '2', canonical_url: 'https://boards.greenhouse.io/acme/jobs/2' })],
      total_on_board: 40,
      board_url: 'https://boards.greenhouse.io/acme',
    }),
    fetchPosting: async () => ({ status: 'open', posting: raw(), note: '' }),
    ...over,
  }
}

// ─── 1. The wrapper: an ATS adapter satisfies JobDiscoverySource ─────────────

async function testWrapper() {
  console.log('\nwrapAtsAdapter — the six adapters keep their interface')

  const source: JobDiscoverySource = wrapAtsAdapter(fakeAdapter())
  check('has the discovery shape', source.id === 'greenhouse' && source.name === 'Greenhouse' && source.sourceType === 'ats')
  check('an ATS is a pull feed', sourceClassOf(source.sourceType) === 'pull')
  check('an ATS is free', source.costModel.kind === 'free' && estimateCallCostUsd(source.costModel, 5) === 0)
  check('capabilities are declared', source.capabilities.paginates === false && source.capabilities.givesCanonicalUrl === true)
  check('isConfigured is a pure env check', source.isConfigured() === true)

  const health = await source.healthCheck()
  check('healthCheck does not probe the network', health.ok && /not probed/.test(health.detail), health.detail)

  const res = await source.search({ board: { ats: 'greenhouse', identifier: 'acme' } })
  check('search returns the board', res.postings.length === 2 && res.error === undefined)
  check('seen is what the BOARD held, not what survived filtering', res.seen === 40, `seen=${res.seen}`)
  check('a board is one exhausted page', res.exhausted === true && res.nextCursor === null)

  const page2 = await source.search({ board: { ats: 'greenhouse', identifier: 'acme' } }, 'cursor-2')
  check('a cursor on a non-paginating source is exhausted, not an error', page2.exhausted && page2.postings.length === 0 && !page2.error)

  const byCompany = await source.search({ company: { name: 'Acme', domain: 'acme.com' } })
  check('a company resolves to a board via detectBoard', byCompany.postings.length === 2)
  const noBoard = await source.search({ company: { name: 'Nowhere Inc' } })
  check('no board found is a note, not an error', noBoard.postings.length === 0 && !noBoard.error && /no Greenhouse board/.test(noBoard.note ?? ''), noBoard.note)
  const nothing = await source.search({})
  check('neither board nor company is a note, not an error', !nothing.error && /needs a board/.test(nothing.note ?? ''), nothing.note)

  const throwing = wrapAtsAdapter(fakeAdapter({ listPostings: async () => { throw new Error('boom') } }))
  const failed = await throwing.search({ board: { ats: 'greenhouse', identifier: 'acme' } })
  check('a throwing adapter surfaces an error, never throws', failed.error !== undefined && /boom/.test(failed.error ?? ''), failed.error)

  const disabled = wrapAtsAdapter(fakeAdapter({ isAvailable: () => false }))
  check('a disabled adapter reports unconfigured', disabled.isConfigured() === false)
  const disabledRes = await disabled.search({ board: { ats: 'greenhouse', identifier: 'acme' } })
  check('a disabled adapter is skipped with a reason', disabledRes.postings.length === 0 && /disabled/.test(disabledRes.error ?? ''), disabledRes.error)

  const live = discoveryRegistry()
  const ats = live.byType('ats')
  // These two used to read "all six ATS adapters" and "nothing is unconfigured",
  // which froze the registry at its wave-1 shape: six free boards and no paid
  // source. Wave 2 shipped six more boards and one credentialed search source,
  // and both assertions failed for the good reason. What is worth pinning is not
  // the COUNT — the recall eval already fails on registry drift — but the two
  // properties the product depends on.
  check('the ATS layer still ships every free board adapter', ats.length >= 6, `${ats.length}: ${ats.map((s) => s.id).join(',')}`)

  // 1. An ATS board is public. If one ever starts demanding a key, discovery
  //    silently narrows to whoever has paid, and free-tier runs quietly get worse.
  const gated = ats.filter((s) => !s.isConfigured() || s.costModel.kind !== 'free')
  check('every ATS adapter is free and needs no key', gated.length === 0, gated.map((s) => `${s.id}=${s.costModel.kind}`).join(',') || 'none gated')

  // 2. An unconfigured source is allowed — it is skipped, not fatal (ADR-008) —
  //    but it must name the variable it wants, or the founder cannot act on it.
  const nameless = live.unconfigured().filter((u) => !u.envVar)
  check('every unconfigured source names the env var it needs', nameless.length === 0, live.unconfigured().map((u) => `${u.id}:${u.envVar ?? 'UNNAMED'}`).join(',') || 'all configured')

  // givesDescription is a PROMISE the extractor acts on: a posting under
  // MIN_EXTRACT_CHARS of description is dropped, so an adapter that claims a
  // description it does not deliver loses its jobs entirely.
  const gives = (id: string) => live.byId(id)?.capabilities.givesDescription
  check('greenhouse/lever/ashby give the description on the listing', gives('greenhouse') === true && gives('lever') === true && gives('ashby') === true)
  check(
    'workday/smartrecruiters/workable do NOT — their listings normalize description_text to null',
    gives('workday') === false && gives('smartrecruiters') === false && gives('workable') === false,
    `workday=${gives('workday')} smartrecruiters=${gives('smartrecruiters')} workable=${gives('workable')}`
  )
  check('the capability table is per-adapter, not a constant', new Set(live.byType('ats').map((s) => s.capabilities.givesDescription)).size === 2)
  check('an unknown adapter defaults to NOT promising a description', wrapAtsAdapter(fakeAdapter({ id: 'other' })).capabilities.givesDescription === false)
  check('an explicit override still wins', wrapAtsAdapter(fakeAdapter({ id: 'workday' }), { capabilities: { givesDescription: true } }).capabilities.givesDescription === true)
}

// ─── 2. An unconfigured paid source is named, never fatal ────────────────────

const PAID_ENV = 'CAREER_TEST_FAKE_SERP_KEY'

function paidSource(): JobDiscoverySource {
  return {
    id: 'fake-serp',
    name: 'Fake SERP',
    sourceType: 'search',
    capabilities: { paginates: true, supportsQuery: true, supportsLocation: true, supportsSince: true, givesDescription: false, givesCanonicalUrl: true },
    costModel: { kind: 'per_request', unitCostUsd: 0.005, envVar: PAID_ENV },
    isConfigured: () => Boolean(process.env[PAID_ENV]),
    healthCheck: async () => ({ ok: false, detail: `${PAID_ENV} is not set` }),
    search: async () => emptyDiscoveryResult('not configured'),
  }
}

async function testUnconfigured() {
  console.log('\nan unconfigured paid source — reported, with its env var, never fatal')
  delete process.env[PAID_ENV]

  const paid = paidSource()
  const reg = createDiscoveryRegistry([wrapAtsAdapter(fakeAdapter()), paid])
  check('it is not in configured()', reg.configured().map((s) => s.id).join(',') === 'greenhouse')
  const un = reg.unconfigured()
  check('it is in unconfigured()', un.length === 1 && un[0].id === 'fake-serp')
  check('unconfigured names the env var', un[0].envVar === PAID_ENV && un[0].reason.includes(PAID_ENV), un[0]?.reason)
  check('a search source is the search class', reg.byClass('search').map((s) => s.id).join(',') === 'fake-serp')
  check('describe() prints its cost and its state', reg.describe().some((l) => l.includes('fake-serp') && l.includes('$0.0050/request') && l.includes(PAID_ENV)), reg.describe().join(' | '))
  check('per-request cost is estimated from the model', estimateCallCostUsd(paid.costModel, 4) === 0.02)

  // A source whose isConfigured() throws must be treated as unconfigured, not
  // allowed to take down the registry read.
  const hostile: JobDiscoverySource = { ...paid, id: 'hostile', name: 'Hostile', isConfigured: () => { throw new Error('nope') } }
  const reg2 = createDiscoveryRegistry([hostile])
  check('a throwing isConfigured() is unconfigured, not an exception', reg2.configured().length === 0 && reg2.unconfigured()[0].id === 'hostile')

  registerDiscoverySource(paid)
  registerDiscoverySource({ ...paid, name: 'Fake SERP v2' })
  const live = discoveryRegistry()
  check('registration is idempotent by id', live.all().filter((s) => s.id === 'fake-serp').length === 1)
  check('a registered paid source is skipped, and the ATS lane still runs', live.configured().length >= 6 && live.unconfigured().some((s) => s.envVar === PAID_ENV))
  clearRegisteredDiscoverySources()
  check('the test seam clears the registration', discoveryRegistry().byId('fake-serp') === null)

  // Registering under an id an ATS wrapper already owns must not produce two
  // rows in the table with byId silently returning the wrapper.
  registerDiscoverySource({ ...paid, id: 'greenhouse', name: 'Greenhouse Feed (paid)', sourceType: 'feed' })
  const shadowed = discoveryRegistry()
  check('an id collision with an ATS wrapper yields ONE row', shadowed.all().filter((s) => s.id === 'greenhouse').length === 1, shadowed.all().map((s) => s.id).join(','))
  check('the later registration wins byId', shadowed.byId('greenhouse')?.name === 'Greenhouse Feed (paid)', shadowed.byId('greenhouse')?.name)
  check('describe() prints one line per id', shadowed.describe().filter((l) => l.startsWith('greenhouse ·')).length === 1)
  check('and it keeps the original position', shadowed.all()[0].id === 'greenhouse')
  clearRegisteredDiscoverySources()
  check('the ATS wrapper comes back once the override is cleared', discoveryRegistry().byId('greenhouse')?.name === 'Greenhouse')
}

// ─── 3. Coverage sums across sources with overlapping postings ───────────────

function testCoverage() {
  console.log('\ncoverage — seen, unique, newToDb, across overlapping sources')

  const ledger = emptyCoverageLedger()
  noteSource(ledger, { id: 'simplify', name: 'Simplify', sourceType: 'feed' })
  noteSource(ledger, { id: 'greenhouse', name: 'Greenhouse', sourceType: 'ats' })
  noteSource(ledger, { id: 'never-called', name: 'Never Called', sourceType: 'search' })

  // Simplify: 217 seen over two pages, 192 distinct.
  recordPage(ledger, {
    sourceId: 'simplify',
    seen: 120,
    postings: Array.from({ length: 100 }, (_, i) => ({ key: `u:job/${i}`, newToDb: i < 60 })),
  })
  recordPage(ledger, {
    sourceId: 'simplify',
    seen: 97,
    // 8 repeats of page 1 — the same source seeing the same job twice.
    postings: Array.from({ length: 100 }, (_, i) => ({ key: `u:job/${i < 8 ? i : i + 92}`, newToDb: i >= 8 })),
    exhausted: true,
  })
  // Greenhouse: 87 seen, 59 distinct, 40 of which Simplify already had.
  recordPage(ledger, {
    sourceId: 'greenhouse',
    seen: 87,
    postings: Array.from({ length: 59 }, (_, i) => ({ key: `u:job/${i}`, newToDb: false })),
    exhausted: true,
  })

  const rows = coverageRows(ledger)
  const simplify = rows.find((r) => r.sourceId === 'simplify')!
  const gh = rows.find((r) => r.sourceId === 'greenhouse')!
  const never = rows.find((r) => r.sourceId === 'never-called')!

  check('seen is the sum of what the source reported', simplify.seen === 217, `${simplify.seen}`)
  check('unique dedupes within a source', simplify.unique === 192, `${simplify.unique}`)
  check('pages counts calls', simplify.pages === 2 && gh.pages === 1)
  check('an exhausted, clean source is completed', simplify.completed === true && gh.completed === true)
  check('a source that was never called is present and NOT completed', never.pages === 0 && never.completed === false && never.seen === 0)

  const totals = coverageTotals(ledger)
  check('total seen is the sum of the rows', totals.seen === 217 + 87, `${totals.seen}`)
  check('run-level unique counts an overlapping posting ONCE', totals.unique === 192, `${totals.unique}`)
  check('cross-source duplicates are the gap', totals.crossSourceDuplicates === 192 + 59 - 192, `${totals.crossSourceDuplicates}`)
  check('newToDb is distinct across sources', totals.newToDb === 152, `${totals.newToDb}`)
  check('sourcesAsked excludes the source never called', totals.sourcesAsked === 2 && totals.sources === 3)

  // An error must be surfaced and must forfeit "completed".
  recordPage(ledger, { sourceId: 'greenhouse', postings: [], error: 'HTTP 503', exhausted: true })
  const gh2 = coverageRows(ledger).find((r) => r.sourceId === 'greenhouse')!
  check('an error is kept on the source', gh2.errors.join(',') === 'HTTP 503')
  check('a source that errored is not "completed"', gh2.completed === false)
  check('errors reach the totals, prefixed by source', coverageTotals(ledger).errors[0] === 'Greenhouse: HTTP 503')

  // recordSearchResult derives keys from the postings themselves.
  const l2 = emptyCoverageLedger()
  const src = { id: 'greenhouse', name: 'Greenhouse', sourceType: 'ats' as const, costModel: { kind: 'free' as const } }
  recordSearchResult(l2, src, { postings: [raw(), raw({ canonical_url: 'https://boards.greenhouse.io/acme/jobs/2' }), raw()], nextCursor: null, exhausted: true, seen: 3 }, { isNewToDb: () => true })
  const r2 = coverageRows(l2)[0]
  check('recordSearchResult dedupes by posting identity', r2.seen === 3 && r2.unique === 2, `seen=${r2.seen} unique=${r2.unique}`)

  const a = postingKey(raw({ canonical_url: 'https://Boards.Greenhouse.io/acme/jobs/1?utm=x' }))
  const b = postingKey(raw({ canonical_url: 'https://boards.greenhouse.io/acme/jobs/1/' }))
  check('posting identity ignores case, query and trailing slash', a === b, `${a} vs ${b}`)
  const noUrl = postingKey(raw({ canonical_url: null, apply_url: null, source_url: '' }))
  check('with no URL, identity falls back to company + title', noUrl.startsWith('t:'), noUrl)
}

// ─── 4. The GE Vernova shape ─────────────────────────────────────────────────

function geVernovaInventory(): DiversityItem[] {
  const items: DiversityItem[] = []
  // 107 of 284 from one employer — the measured live inventory.
  for (let i = 0; i < 107; i++) {
    items.push({ key: `gev-${i}`, companyName: 'GE Vernova', companyDomain: 'gevernova.com', title: 'Engineering Intern', sourceId: 'sweep', state: 'NY' })
  }
  for (let i = 0; i < 177; i++) {
    const c = i % 33
    items.push({
      key: `other-${i}`,
      companyName: `Company ${c}`,
      companyDomain: `company${c}.com`,
      title: c % 2 ? 'Process Engineering Intern' : 'Data Science Intern',
      sourceId: 'sweep',
      state: ['CA', 'NY', 'CO', 'TX'][c % 4],
    })
  }
  return items
}

function testDiversity() {
  console.log('\ndiversity — the measured concentration must be flagged, with the company named')

  const d = measureDiversity(geVernovaInventory())
  check('the inventory is counted', d.uniqueJobs === 284 && d.uniqueCompanies === 34, `${d.uniqueJobs} jobs / ${d.uniqueCompanies} companies`)
  check('largest share is 38%', Math.round(d.largestCompanyShare * 100) === 38, `${d.largestCompanyShare}`)
  check('LOW DIVERSITY is the verdict', d.level === 'low')
  check('the warning names GE Vernova', (d.concentrationWarning ?? '').includes('GE Vernova'), d.concentrationWarning ?? '')
  check('the warning gives the numbers', /107 of 284/.test(d.concentrationWarning ?? ''), d.concentrationWarning ?? '')
  check('one surface carrying the run is also a reason', d.reasons.some((r) => /single surface/.test(r)), d.reasons.join(' | '))
  check('the summary prints every reason', summarizeDiversity(d).filter((l) => l.startsWith('LOW DIVERSITY')).length === d.reasons.length)

  // 30 jobs from 5 companies: no single company is over 25%, and it is still narrow.
  const five: DiversityItem[] = []
  for (let i = 0; i < 30; i++) {
    const c = i % 5
    five.push({ key: `f-${i}`, companyName: `Big ${c}`, title: 'Process Engineer Intern', roleFamily: 'process', sourceId: `src-${i % 3}`, state: ['CA', 'NY', 'TX', 'OH', 'MI'][i % 5] })
  }
  const d5 = measureDiversity(five)
  check('30 jobs from 5 companies: no single company exceeds the share ceiling', d5.largestCompanyShare <= MAX_COMPANY_SHARE + 1e-9, `${d5.largestCompanyShare}`)
  check('30 jobs from 5 companies is still LOW DIVERSITY', d5.level === 'low')
  check('the reason names the depth-over-breadth problem', d5.reasons.some((r) => /only 5 companies/.test(r)), d5.reasons.join(' | '))
  check('and the top-5 concentration', d5.reasons.some((r) => /largest employers hold 30 of 30/.test(r)), d5.reasons.join(' | '))

  // A healthy run must NOT be flagged.
  const healthy: DiversityItem[] = []
  for (let i = 0; i < 60; i++) {
    healthy.push({
      key: `h-${i}`,
      companyName: `Co ${i % 30}`,
      title: ['Process Engineer Intern', 'Data Analyst Intern', 'Manufacturing Intern', 'R&D Intern'][i % 4],
      industry: ['energy', 'chemicals', 'cpg'][i % 3],
      sourceId: `src-${i % 4}`,
      state: ['CA', 'NY', 'TX', 'OH', 'MI', 'IL'][i % 6],
    })
  }
  const dh = measureDiversity(healthy)
  check('a broad run is not flagged', dh.level === 'ok' && dh.concentrationWarning === null, dh.reasons.join(' | '))
  check('role families are derived from titles when not given', dh.uniqueRoleFamilies >= 3, `${dh.uniqueRoleFamilies}`)
  check('geographic spread counts regions', dh.geographicSpread === 6, `${dh.geographicSpread}`)

  // Too small to judge.
  const tiny = measureDiversity([{ key: 'a', companyName: 'One' }, { key: 'b', companyName: 'One' }])
  check('a tiny run is "unknown", not "low"', tiny.level === 'unknown' && tiny.concentrationWarning === null)

  // The same job from three sources is one job.
  const dup = measureDiversity([
    { key: 'same', companyName: 'Acme', sourceId: 'a' },
    { key: 'same', companyName: 'Acme', sourceId: 'b' },
    { key: 'same', companyName: 'Acme', sourceId: 'c' },
  ])
  check('a job found by three sources is one job and three sources', dup.uniqueJobs === 1 && dup.uniqueSources === 3)

  // Key-less input is the realistic case: an orchestrator hands over the
  // inventory it has. Thirty copies of one posting must not read as thirty
  // jobs — that is the exact illusion this file exists to break.
  const keyless = measureDiversity(Array.from({ length: 30 }, () => ({ companyName: 'GE Vernova', title: 'Engineering Intern' })))
  check('key-less duplicates collapse to one job', keyless.uniqueJobs === 1, `uniqueJobs=${keyless.uniqueJobs}`)
  check('one job is too small to judge, not "low diversity"', keyless.level === 'unknown', keyless.reasons.join(' | '))
  const keylessMixed = measureDiversity([
    ...Array.from({ length: 20 }, () => ({ companyName: 'GE Vernova', title: 'Engineering Intern' })),
    ...Array.from({ length: 12 }, (_, i) => ({ companyName: `Co ${i}`, title: `Role ${i} Intern` })),
  ])
  check('the fallback identity is company + title, not the array index', keylessMixed.uniqueJobs === 13, `uniqueJobs=${keylessMixed.uniqueJobs}`)
  check('two employers with the same title stay two jobs', measureDiversity([{ companyName: 'A', title: 'Intern' }, { companyName: 'B', title: 'Intern' }]).uniqueJobs === 2)
}

// ─── 5. shouldDiversify names what to search next ────────────────────────────

function testShouldDiversify() {
  console.log('\nshouldDiversify — measurement that drives behaviour')

  const d = measureDiversity(geVernovaInventory())
  const directive = shouldDiversify(d, {
    availableSources: ['sweep', 'simplify', 'serp', 'greenhouse'],
    expectedRoleFamilies: ['process', 'data', 'manufacturing', 'materials'],
    expectedIndustries: ['energy', 'chemicals'],
    expectedRegions: ['CA', 'NY', 'TX', 'OH', 'MI', 'WA'],
  })
  check('it says diversification is needed', directive.needed === true)
  check('it names the surfaces that were never read', directive.underCoveredSources.join(',') === 'simplify,serp,greenhouse', directive.underCoveredSources.join(','))
  check('a surface that DID produce is not under-covered', !directive.underCoveredSources.includes('sweep'))
  check('it names missing role families', directive.underCoveredRoleFamilies.includes('materials'), directive.underCoveredRoleFamilies.join(','))
  check('it names missing industries', directive.underCoveredIndustries.join(',') === 'energy,chemicals', directive.underCoveredIndustries.join(','))
  check('it names missing regions', directive.underCoveredRegions.join(',') === 'OH,MI,WA', directive.underCoveredRegions.join(','))
  check('it names the saturated employer', directive.saturatedCompanies.join(',') === 'GE Vernova')
  check('the suggestion is one actionable line', /^Broaden discovery: /.test(directive.suggestion) && directive.suggestion.includes('serp'), directive.suggestion)
  check('it never asks for anything to be discarded', !/discard|drop|remove|hide/i.test(directive.suggestion), directive.suggestion)

  const healthy = measureDiversity(
    Array.from({ length: 60 }, (_, i) => ({
      key: `h-${i}`,
      companyName: `Co ${i % 30}`,
      title: ['Process Engineer Intern', 'Data Analyst Intern', 'Manufacturing Intern', 'R&D Intern'][i % 4],
      sourceId: `src-${i % 4}`,
      state: ['CA', 'NY', 'TX', 'OH', 'MI', 'IL'][i % 6],
    }))
  )
  const none = shouldDiversify(healthy, { availableSources: ['src-0', 'src-1', 'src-2', 'src-3'] })
  check('a balanced run needs no extra searches', none.needed === false && none.underCoveredSources.length === 0, none.suggestion)

  // The regression that matters. The display lists are capped at ten; the live
  // run had 46 role families. Deciding coverage from a top-10 list reports the
  // 11th-largest family as missing and buys searches for coverage we have.
  const FAMILIES = ['process', 'data', 'manufacturing', 'materials', 'quality', 'design', 'controls', 'reliability', 'supply', 'sales', 'finance', 'research']
  const STATES = ['CA', 'NY', 'TX', 'OH', 'MI', 'IL', 'WA', 'CO', 'PA', 'GA', 'MA', 'NC']
  const INDUSTRIES = FAMILIES.map((_, i) => `ind-${i}`)
  const SOURCES = FAMILIES.map((_, i) => `src-${i}`)
  const wide: DiversityItem[] = []
  for (let f = 0; f < 12; f++) {
    for (let j = 0; j < 20; j++) {
      wide.push({
        key: `w-${f}-${j}`,
        companyName: `Co ${f}-${j % 10}`,
        title: 'Intern',
        roleFamily: FAMILIES[f],
        industry: INDUSTRIES[f],
        sourceId: SOURCES[f],
        state: STATES[f],
      })
    }
  }
  const dWide = measureDiversity(wide)
  check('the wide fixture really has 12 of each', dWide.uniqueRoleFamilies === 12 && dWide.geographicSpread === 12 && dWide.uniqueSources === 12 && dWide.uniqueIndustries === 12,
    `${dWide.uniqueRoleFamilies}/${dWide.geographicSpread}/${dWide.uniqueSources}/${dWide.uniqueIndustries}`)
  check('the DISPLAY lists are still capped at ten', dWide.roleFamilies.length === 10 && dWide.regions.length === 10 && dWide.sources.length === 10)
  check('the COMPLETE tallies are not', Object.keys(dWide.counts.roleFamilies).length === 12 && Object.keys(dWide.counts.regions).length === 12 && Object.keys(dWide.counts.sources).length === 12)

  const wideDirective = shouldDiversify(dWide, {
    availableSources: SOURCES,
    expectedRoleFamilies: FAMILIES,
    expectedIndustries: INDUSTRIES,
    expectedRegions: STATES,
  })
  check('a fully covered run with >10 categories reports NOTHING under-covered', wideDirective.underCoveredRoleFamilies.length === 0, wideDirective.underCoveredRoleFamilies.join(','))
  check('  …not regions ranked 11th and later', wideDirective.underCoveredRegions.length === 0, wideDirective.underCoveredRegions.join(','))
  check('  …not sources ranked 11th and later', wideDirective.underCoveredSources.length === 0, wideDirective.underCoveredSources.join(','))
  check('  …not industries ranked 11th and later', wideDirective.underCoveredIndustries.length === 0, wideDirective.underCoveredIndustries.join(','))
  check('so no further searches are bought', wideDirective.needed === false, wideDirective.suggestion)

  // And a genuinely missing 13th category is still named.
  const missing = shouldDiversify(dWide, { expectedRoleFamilies: [...FAMILIES, 'metallurgy'], expectedRegions: [...STATES, 'AK'] })
  check('a category that really is absent is still named', missing.needed && missing.underCoveredRoleFamilies.join(',') === 'metallurgy' && missing.underCoveredRegions.join(',') === 'AK', missing.suggestion)

  // A report persisted before `counts` existed must degrade loudly, not silently.
  const legacy = JSON.parse(JSON.stringify(dWide)) as Record<string, unknown>
  delete legacy.counts
  const fromLegacy = shouldDiversify(legacy as never, { expectedRoleFamilies: FAMILIES })
  check('a pre-counts report says its answer came from the display lists', fromLegacy.reasons.some((r) => /top-10 display lists/.test(r)), fromLegacy.reasons.join(' | '))

  // A saturated employer outside the top ten is still saturated.
  const lopsided = measureDiversity([
    ...Array.from({ length: 40 }, (_, i) => ({ key: `big-${i}`, companyName: 'GE Vernova', sourceId: 's' })),
    ...Array.from({ length: 60 }, (_, i) => ({ key: `small-${i}`, companyName: `Co ${i}`, sourceId: 's' })),
  ])
  check('saturation is judged on the full company tally', shouldDiversify(lopsided).saturatedCompanies.join(',') === 'GE Vernova', shouldDiversify(lopsided).saturatedCompanies.join(','))
}

// ─── 6. The run report, rendered from a persisted row ────────────────────────

function testReport() {
  console.log('\nthe run report — "did it actually search anything?"')

  const ledger = emptyCoverageLedger()
  noteSource(ledger, { id: 'simplify', name: 'Simplify', sourceType: 'feed' })
  recordPage(ledger, { sourceId: 'simplify', seen: 217, postings: Array.from({ length: 192 }, (_, i) => ({ key: `k${i}`, newToDb: i < 100 })), exhausted: true })
  noteSource(ledger, { id: 'greenhouse', name: 'Greenhouse', sourceType: 'ats' })
  recordPage(ledger, { sourceId: 'greenhouse', seen: 87, postings: Array.from({ length: 59 }, (_, i) => ({ key: `k${i}` })) })

  const diversity = measureDiversity(geVernovaInventory())
  const report = buildScoutReport({
    runId: 'run-1',
    label: 'nightly scout',
    status: 'succeeded',
    ledger,
    extraSources: [{ id: 'watchlist', name: 'Company watchlist', seen: 21, unique: 21, checked: 14, exhausted: true, completed: true, pages: 14 }],
    funnel: { relevant: 88, verifiedOpen: 61, fullyRanked: 27 },
    diversity,
    skipped: [{ id: 'fake-serp', name: 'Fake SERP', sourceType: 'search', envVar: PAID_ENV, reason: `not configured — set ${PAID_ENV}` }],
    costUsd: 4.02,
    latencyMs: 1_020_000,
    generatedAt: '2026-08-31T00:00:00.000Z',
  })

  check('TOTAL RAW is the sum of the per-source rows', report.totals.rawPostings === 217 + 87 + 21, `${report.totals.rawPostings}`)
  check('UNIQUE counts cross-source overlap once', report.totals.uniquePostings === 192 + 21, `${report.totals.uniquePostings}`)
  check('the funnel numbers come through', report.totals.relevant === 88 && report.totals.verifiedOpen === 61 && report.totals.fullyRanked === 27)
  check('company and role-family counts come from the diversity measurement', report.totals.uniqueCompanies === 34 && report.totals.uniqueRoleFamilies === diversity.uniqueRoleFamilies)

  const text = renderScoutReport(report)
  check('the source table is the founder\'s format', /Simplify\s+217 seen ·\s+192 unique · ✓ completed/.test(text), text.split('\n')[1])
  check('a source with pages left says so', /Greenhouse\s+87 seen ·\s+59 unique · more available/.test(text), text.split('\n')[2])
  check('the company lane counts companies, not postings', /Company watchlist\s+14 checked ·\s+21 jobs/.test(text), text.split('\n')[3])
  check('the totals block is printed', /TOTAL RAW\s+325/.test(text) && /UNIQUE COMPANIES\s+34/.test(text) && /FULLY RANKED\s+27/.test(text))
  check('the skipped source is named with its env var', text.includes('SKIPPED') && text.includes(PAID_ENV), '')
  check('the diversity warning is printed', text.includes('LOW DIVERSITY') && text.includes('GE Vernova'))

  // The whole point: the same bytes come back off a persisted row.
  const payload = toReportPayload(report)
  const row = { id: 'run-1', label: 'nightly scout', status: 'succeeded', stats: { cost_usd: 4.02, ...payload } }
  const roundTrip = JSON.parse(JSON.stringify(row)) as typeof row
  const reread = scoutReportFromRunRow(roundTrip)
  check('the report reads back off the run row', reread !== null)
  check('the CLI and the UI print the same bytes', reread !== null && renderScoutReport(reread) === text)
  check('totals re-derive from the persisted rows', reread!.totals.rawPostings === report.sources.reduce((a, s) => a + s.seen, 0))
  check('the stats key is stable', Object.keys(payload)[0] === SCOUT_REPORT_STATS_KEY)

  check('a row with no report returns null', scoutReportFromRunRow({ id: 'x', stats: { cost_usd: 1 } }) === null)
  check('a row with no stats at all returns null', scoutReportFromRunRow({ id: 'x' }) === null)
  const garbage = scoutReportFromRunRow({ id: 'x', stats: { [SCOUT_REPORT_STATS_KEY]: { sources: [{ id: 'a' }, null, 7], totals: 'nope' } } })
  check('a malformed report degrades instead of throwing', garbage !== null && garbage.sources.length === 1 && garbage.totals.uniquePostings === 0)

  const empty = buildScoutReport({})
  check('a run that searched nothing says so', renderScoutReport(empty).includes('searched nothing'))

  testReportInvariants()
}

// ─── 6b. UNIQUE can never exceed TOTAL RAW ───────────────────────────────────

function testReportInvariants() {
  console.log('\nthe run report — no total may contradict the table above it')

  function ledgerOf(seen: number, keys: string[]) {
    const l = emptyCoverageLedger()
    noteSource(l, { id: 'greenhouse', name: 'Greenhouse', sourceType: 'ats' })
    recordPage(l, { sourceId: 'greenhouse', seen, postings: keys.map((k) => ({ key: k })), exhausted: true })
    return l
  }
  const hundred = Array.from({ length: 100 }, (_, i) => `u:job/${i}`)

  // The reviewer's probe: a company-lane row whose `seen` holds a COMPANY count
  // while its `unique` holds postings. Left alone it prints UNIQUE 200 under
  // TOTAL RAW 114.
  const wrongUnit = buildScoutReport({
    ledger: ledgerOf(100, hundred),
    extraSources: [{ id: 'watchlist', name: 'Company watchlist', seen: 14, unique: 100, checked: 14 }],
  })
  check('a company count in `seen` is corrected to the postings count', wrongUnit.totals.rawPostings === 200, `${wrongUnit.totals.rawPostings}`)
  check('UNIQUE never exceeds TOTAL RAW', wrongUnit.totals.uniquePostings <= wrongUnit.totals.rawPostings, `unique ${wrongUnit.totals.uniquePostings} / raw ${wrongUnit.totals.rawPostings}`)
  check('the correction is written onto the row, not swallowed', (wrongUnit.sources[1].notes ?? []).some((n) => /counts postings for TOTAL RAW/.test(n)), (wrongUnit.sources[1].notes ?? []).join(' | '))
  check('the row still displays the company count', /Company watchlist\s+14 checked/.test(renderScoutReport(wrongUnit)))

  // The same 100 jobs read by both lanes: with keys, they are 100, not 200.
  const shared = buildScoutReport({
    ledger: ledgerOf(100, hundred),
    extraSources: [{ id: 'watchlist', name: 'Company watchlist', seen: 100, unique: 100, checked: 14, keys: hundred }],
  })
  check('a lane that hands over posting keys is deduped against the ledger', shared.totals.uniquePostings === 100, `${shared.totals.uniquePostings}`)
  check('TOTAL RAW still counts both readings', shared.totals.rawPostings === 200, `${shared.totals.rawPostings}`)

  // Disjoint keys add up.
  const disjoint = buildScoutReport({
    ledger: ledgerOf(100, hundred),
    extraSources: [{ id: 'watchlist', name: 'Company watchlist', seen: 30, unique: 30, checked: 5, keys: Array.from({ length: 30 }, (_, i) => `u:other/${i}`) }],
  })
  check('disjoint lanes sum', disjoint.totals.uniquePostings === 130, `${disjoint.totals.uniquePostings}`)
  check('newToDb can never exceed UNIQUE', buildScoutReport({ ledger: ledgerOf(100, hundred), extraSources: [{ id: 'w', name: 'W', seen: 1, unique: 1, newToDb: 999 }] }).totals.newToDb <= 101)

  // "not called" is a claim about a source, and must not be made about a lane
  // that reported jobs on the same line.
  const noPages = buildScoutReport({ extraSources: [{ id: 'watchlist', name: 'Company watchlist', seen: 100, unique: 100, checked: 14 }] })
  check('a lane with no `pages` but real jobs is not "not called"', !/not called/.test(renderScoutReport(noPages)), renderScoutReport(noPages).split('\n')[1])
  const reallyNotCalled = buildScoutReport({ extraSources: [{ id: 'idle', name: 'Idle Feed', seen: 0, unique: 0 }] })
  check('a lane with nothing at all IS "not called"', /Idle Feed\s+0 seen ·\s+0 unique · not called/.test(renderScoutReport(reallyNotCalled)), renderScoutReport(reallyNotCalled).split('\n')[1])

  // A persisted blob written by an older build cannot print a contradiction.
  const legacyRow = {
    id: 'run-old',
    stats: {
      [SCOUT_REPORT_STATS_KEY]: {
        sources: [{ id: 'greenhouse', name: 'Greenhouse', seen: 114, unique: 100 }],
        totals: { rawPostings: 114, uniquePostings: 200, newToDb: 150 },
      },
    },
  }
  const legacy = scoutReportFromRunRow(legacyRow)!
  check('a persisted UNIQUE > TOTAL RAW is clamped on read', legacy.totals.uniquePostings === 114, `${legacy.totals.uniquePostings}`)
  check('and so is a persisted newToDb', legacy.totals.newToDb === 114, `${legacy.totals.newToDb}`)
}

async function main() {
  console.log('Discovery coverage checks')
  await testWrapper()
  await testUnconfigured()
  testCoverage()
  testDiversity()
  testShouldDiversify()
  testReport()
  console.log(failures === 0 ? '\nPASS' : `\nFAIL — ${failures} check(s) failed`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
