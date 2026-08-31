// Offline tests for read-time relevance and the inbox that depends on it.
//
// No network, no keys, no database. Everything here is a pure function over
// fixtures, and the fixtures are the founder's REAL mission and titles taken
// verbatim from the live inbox on 2026-08-30 — "Summer 2027 Internship -
// Architectural Engineering" and "Office Management and Internal Communications
// Intern" are the two postings that prompted "not all of them are remotely
// relevant", so they are the two the suite has to get right.
//
// The property that matters most is the last one: change the direction, change
// the ranking, with no data change at all. That is the whole argument for
// computing relevance at read time instead of storing a column.
//
//   npx tsx scripts/test-career-relevance.ts

import {
  bandFor,
  bestFirstKey,
  matchingRelevance,
  missionWantsInternships,
  passesRelevance,
  relevanceContext,
  relevanceCounts,
  relevanceHeadline,
  scoreRelevance,
  POSSIBLE_AT,
  STRONG_AT,
  type RelevanceFilter,
} from '../lib/career/jobs/inbox-relevance'
import { rankAndFilter, type CensusRow } from '../app/api/career/jobs/inbox'
import { DEFAULT_FILTERS, filtersToQuery, isDefaultFilters } from '../app/dashboard/jobs/JobFilters'
import type { CareerMission } from '../lib/career/types'

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

// ─── Fixtures ────────────────────────────────────────────────────────────────

type MissionShape = Pick<CareerMission, 'season' | 'preferences' | 'hard_constraints'>

const HARD_CONSTRAINTS: CareerMission['hard_constraints'] = [
  { label: 'Internships only', dimension: 'employment_type', operator: 'in', value: ['internship', 'co_op'] },
  { label: 'Not a different season', dimension: 'season', operator: 'not_equals', value: 'other_season' },
  { label: 'United States', dimension: 'location_country', operator: 'in', value: ['US', 'United States', ''] },
]

function mission(direction: string | null, over: Partial<CareerMission['preferences']> = {}): MissionShape {
  return {
    season: 'summer_2027',
    hard_constraints: HARD_CONSTRAINTS,
    preferences: {
      geo_tiers: [
        { tier: 1, locations: ['San Francisco / Bay Area', 'New York City'] },
        { tier: 2, locations: ['Boston', 'Seattle', 'Los Angeles', 'Washington DC'] },
      ],
      company_types: ['high-quality startups', 'energy / oil & gas', 'advanced manufacturing', 'chemicals', 'materials', 'pharma where relevant'],
      role_families: [],
      industries: [],
      optimize_for: ['learning', 'ownership'],
      work_modes: ['onsite', 'hybrid', 'remote'],
      direction,
      ...over,
    },
  }
}

/** The founder's stated direction, verbatim from the live mission row. */
const CHEM_E =
  "Find me your typical Chemical Engineering internships, so anything that asks for Chemical Engineering internships, R&D, Materials, Process Engineering, etc. Keep this very tailored to just Chemical Engineering internships, but I don't care about location or which company."

const GENOMICS = 'life sciences / genomics research; my chemical engineering background transfers'

function row(over: Partial<CensusRow> & { id: string; title: string }): CensusRow {
  return {
    company_name: 'Some Company',
    role_family: null,
    industry: null,
    skills: null,
    location_tier: null,
    employment_type: 'internship',
    season_relevance: 'unspecified',
    extraction_version: null,
    fit_overall: null,
    deadline: null,
    first_seen_at: '2026-08-20T00:00:00Z',
    last_seen_at: '2026-08-20T00:00:00Z',
    ...over,
  }
}

// Live titles, unedited.
const CHEME = row({
  id: 'cheme',
  title: 'Chemical and Materials Engineering Internship - Summer 2027',
  company_name: 'Kairos Power',
  role_family: 'Chemical Engineering',
  location_tier: 1,
  season_relevance: 'summer_2027',
  extraction_version: 'v1',
  fit_overall: 0.622,
})
const ARCHITECTURAL = row({
  id: 'arch',
  title: 'Summer 2027 Internship - Architectural Engineering',
  company_name: 'General Matter',
  role_family: 'Architectural Engineering',
  location_tier: 2,
  season_relevance: 'summer_2027',
  extraction_version: 'v1',
})
const OFFICE = row({
  id: 'office',
  title: 'Office Management and Internal Communications Intern',
  company_name: 'Solid Power',
  role_family: 'Office Management and Internal Communications',
  location_tier: 3,
  extraction_version: 'v1',
})
const GENOME = row({
  id: 'genome',
  title: 'Genomics Research Intern',
  company_name: 'Xaira Therapeutics',
  role_family: 'Genomics / Computational Biology',
  location_tier: 1,
  season_relevance: 'summer_2027',
  extraction_version: 'v1',
})
/** The common case after a board sweep: a title, a company, a location, nothing else. */
const THIN_CHEME = row({
  id: 'thin-cheme',
  title: 'Process Engineering Intern — Summer 2027',
  company_name: 'Marathon Petroleum',
  season_relevance: 'summer_2027',
})
const THIN_PROGRAMME = row({
  id: 'thin-programme',
  title: 'Summer 2027 Internship Program (Paid) – Engineering',
  company_name: 'Boeing',
  season_relevance: 'summer_2027',
})
const FULL_TIME = row({
  id: 'fulltime',
  title: 'Process Engineer',
  company_name: 'Dow',
  employment_type: 'full_time',
  season_relevance: 'unspecified',
})
const WRONG_SEASON = row({
  id: 'winter',
  title: 'Chemical Engineering Intern — Winter 2026',
  company_name: 'BASF',
  season_relevance: 'other_season',
})
/** Off on keywords, but a real evaluation says otherwise. */
const EVALUATED_SOFTWARE = row({
  id: 'ginkgo-sw',
  title: 'Software Graduate Intern, Autonomous Lab',
  company_name: 'Ginkgo Bioworks',
  role_family: 'Software Engineering',
  location_tier: 1,
  extraction_version: 'v1',
  fit_overall: 0.674,
})

const ALL = [CHEME, ARCHITECTURAL, OFFICE, GENOME, THIN_CHEME, THIN_PROGRAMME, FULL_TIME, WRONG_SEASON, EVALUATED_SOFTWARE]

// ─── The context ─────────────────────────────────────────────────────────────

const chemCtx = relevanceContext(mission(CHEM_E))
check('direction terms drop instruction noise', !chemCtx.terms.includes('find') && !chemCtx.terms.includes('your') && !chemCtx.terms.includes('typical'), chemCtx.terms.join(','))
check('direction terms keep the subject', chemCtx.terms.includes('chemical') && chemCtx.terms.includes('material'), chemCtx.terms.join(','))
check('R&D survives as a discipline even though its letters do not survive stemming', chemCtx.wantedIds.has('research'))
check('the direction names chemical, process and materials', chemCtx.wantedIds.has('chemical') && chemCtx.wantedIds.has('process') && chemCtx.wantedIds.has('materials'))
check('company types never become disciplines', !chemCtx.wantedIds.has('manufacturing') && !chemCtx.wantedIds.has('clinical'), [...chemCtx.wantedIds].join(','))
check('internships-only is read off the hard constraints', chemCtx.internshipsOnly)
eq('missionWantsInternships on a mission without the constraint', missionWantsInternships([]), false)
eq('season label', chemCtx.seasonLabel, 'Summer 2027')

// ─── 1. The founder's complaint, as arithmetic ───────────────────────────────

const sCheme = scoreRelevance(CHEME, chemCtx)
const sArch = scoreRelevance(ARCHITECTURAL, chemCtx)
const sOffice = scoreRelevance(OFFICE, chemCtx)
check('chemical engineering outranks architectural engineering', sCheme.score > sArch.score, `${sCheme.score} vs ${sArch.score}`)
eq('chemical engineering is strong', sCheme.band, 'strong')
eq('architectural engineering is off', sArch.band, 'off')
eq('office management is off', sOffice.band, 'off')
check('the off-direction reason names the discipline', sArch.reasons.some((r) => r.includes('architectural engineering')), sArch.reasons.join(' · '))
check('the on-direction reason names the discipline', sCheme.reasons.some((r) => r.includes('chemical engineering')), sCheme.reasons.join(' · '))
check('reasons are short', sCheme.reasons.every((r) => r.length <= 70), sCheme.reasons.join(' · '))
check('a stem is never quoted raw at the reader', !sCheme.reasons.join(' ').includes('"proces"'))

// The same test for the direction the spec names, on the same fixtures.
const genoCtx = relevanceContext(mission(GENOMICS))
const gGenome = scoreRelevance(GENOME, genoCtx)
const gArch = scoreRelevance(ARCHITECTURAL, genoCtx)
check('genomics outranks architectural engineering under a genomics direction', gGenome.score > gArch.score, `${gGenome.score} vs ${gArch.score}`)
eq('genomics is strong under a genomics direction', gGenome.band, 'strong')
eq('architectural engineering is off under a genomics direction', gArch.band, 'off')

// ─── 2. It runs on a row nothing has read ────────────────────────────────────

const sThin = scoreRelevance(THIN_CHEME, chemCtx)
check('an unextracted posting still scores', sThin.score > POSSIBLE_AT, String(sThin.score))
eq('an unextracted on-subject posting is strong', sThin.band, 'strong')
check('the card is told it was never analysed', sThin.reasons.includes('not analysed yet'))
const sProg = scoreRelevance(THIN_PROGRAMME, chemCtx)
eq('a general engineering programme is possible, not off', sProg.band, 'possible')
check('a title naming no discipline is never called off-direction', !sProg.reasons.some((r) => r.startsWith('off-direction')), sProg.reasons.join(' · '))

// ─── 3. Hard exclusions, and the fit floor ───────────────────────────────────

eq('a full-time role under an internships-only mission is off', scoreRelevance(FULL_TIME, chemCtx).band, 'off')
eq('and says why', scoreRelevance(FULL_TIME, chemCtx).reasons, ['not an internship'])
eq('a different season is off', scoreRelevance(WRONG_SEASON, chemCtx).band, 'off')
const sEvaluated = scoreRelevance(EVALUATED_SOFTWARE, chemCtx)
check('a posting the evaluator scored at MAYBE+ is never banded off by keywords', sEvaluated.band !== 'off', JSON.stringify(sEvaluated))
check('and the floor is the fit number itself', sEvaluated.score >= 0.674, String(sEvaluated.score))
check('and it says the model already read it', sEvaluated.reasons.some((r) => r.startsWith('already evaluated')), sEvaluated.reasons.join(' · '))

// A mission with no direction at all cannot judge, so it must not hide anything.
const blindCtx = relevanceContext(mission(null))
check('with no direction nothing is off-direction', ALL.every((r) => scoreRelevance(r, blindCtx).band !== 'off' || r.id === 'fulltime' || r.id === 'winter'))
check('and the card says why it is not scoring', scoreRelevance(ARCHITECTURAL, blindCtx).reasons.some((r) => r.includes('no direction stated')))

// Bands are exactly the thresholds they claim to be.
eq('band boundary strong', bandFor(STRONG_AT), 'strong')
eq('band boundary possible', bandFor(POSSIBLE_AT), 'possible')
eq('band boundary off', bandFor(POSSIBLE_AT - 0.0001), 'off')

// ─── 4. The default view: nothing dropped, everything counted ────────────────

const defaults = { relevance: 'possible' as RelevanceFilter, view: 'all' as const, sort: 'best' as const }
const inbox = rankAndFilter(ALL, chemCtx, defaults)
eq('every posting is counted', inbox.counts.total, ALL.length)
check('the parts sum to the whole', inbox.counts.strong + inbox.counts.possible + inbox.counts.off === inbox.counts.total)
check('the off-direction postings are filtered out of the default view', !inbox.ids.includes('arch') && !inbox.ids.includes('office'))
check('but they are still counted', inbox.counts.off >= 2, String(inbox.counts.off))
check('and reachable', rankAndFilter(ALL, chemCtx, { ...defaults, relevance: 'any' }).ids.includes('arch'))
eq('showing = strong + possible', inbox.matched, inbox.counts.strong + inbox.counts.possible)
eq('matched never exceeds the ids it can produce', inbox.matched, inbox.ids.length)

// The unranked-but-relevant postings the old fit sort buried.
check('an unranked on-subject posting is in the default view', inbox.ids.includes('thin-cheme'))
check('a generic unranked programme is in the default view', inbox.ids.includes('thin-programme'))
check('and both are ahead of an off-direction posting that has a fit number', inbox.ids.indexOf('thin-cheme') < inbox.ids.indexOf('ginkgo-sw'))
check('needs-a-look counts only relevant unread postings', inbox.counts.needsLook === 2, String(inbox.counts.needsLook))
const needsLook = rankAndFilter(ALL, chemCtx, { ...defaults, view: 'needs_look' })
eq('the needs-a-look queue is exactly those', needsLook.ids.sort(), ['thin-cheme', 'thin-programme'])
check('every row in the queue really is unread', needsLook.ids.every((id) => !needsLook.byId.get(id)!.extracted))

// A strong-only view hides the possibles too, and owns up to it.
const strongOnly = rankAndFilter(ALL, chemCtx, { ...defaults, relevance: 'strong' })
eq('strong-only shows only strong', strongOnly.matched, inbox.counts.strong)
check('strong-only hides the possibles', strongOnly.ids.length < inbox.ids.length)

// ─── 5. Ordering ─────────────────────────────────────────────────────────────

eq('band leads the ordering key', bestFirstKey({ fit_overall: null }, { score: 0.9, band: 'strong', reasons: [] }) > bestFirstKey({ fit_overall: 0.99 }, { score: 0.1, band: 'possible', reasons: [] }), true)
eq('fit breaks ties inside a band', bestFirstKey({ fit_overall: 0.8 }, { score: 0.1, band: 'strong', reasons: [] }) > bestFirstKey({ fit_overall: 0.4 }, { score: 0.99, band: 'strong', reasons: [] }), true)
const byRecent = rankAndFilter(
  [row({ id: 'old', title: 'Chemical Engineering Intern', first_seen_at: '2026-01-01T00:00:00Z' }), row({ id: 'new', title: 'Chemical Engineering Intern', first_seen_at: '2026-08-01T00:00:00Z' })],
  chemCtx,
  { ...defaults, sort: 'recent' }
)
eq('sort=recent is newest first', byRecent.ids, ['new', 'old'])
const byDeadline = rankAndFilter(
  [row({ id: 'none', title: 'Chemical Engineering Intern' }), row({ id: 'soon', title: 'Chemical Engineering Intern', deadline: '2026-09-01' })],
  chemCtx,
  { ...defaults, sort: 'deadline' }
)
eq('sort=deadline puts a missing deadline last, not first', byDeadline.ids, ['soon', 'none'])

// ─── 6. The header never lies ────────────────────────────────────────────────

const counts = relevanceCounts([
  { relevance: { score: 1, band: 'strong', reasons: [] }, read: false },
  { relevance: { score: 0.5, band: 'possible', reasons: [] }, read: true },
  { relevance: { score: 0.1, band: 'off', reasons: [] }, read: false },
])
eq('counts', [counts.total, counts.strong, counts.possible, counts.off, counts.needsLook], [3, 1, 1, 1, 1])
eq('matching under each filter', [matchingRelevance(counts, 'any'), matchingRelevance(counts, 'possible'), matchingRelevance(counts, 'strong')], [3, 2, 1])

const big = { total: 312, strong: 47, possible: 0, off: 265, needsLook: 12 }
eq('the founder-facing headline', relevanceHeadline(big, matchingRelevance(big, 'possible'), [{ label: 'off-direction', count: 265 }]), '312 postings · 47 strong · showing 47 — 265 off-direction hidden')
eq('showing everything hides nothing and says so', relevanceHeadline(big, 312, []), '312 postings · 47 strong · showing 312')
eq('strong-only names both kinds of hidden', relevanceHeadline({ total: 20, strong: 5, possible: 7, off: 8, needsLook: 0 }, 5, [{ label: 'off-direction', count: 8 }, { label: 'possible', count: 7 }]), '20 postings · 5 strong · showing 5 — 8 off-direction, 7 possible hidden')
eq('one posting is singular', relevanceHeadline({ total: 1, strong: 1, possible: 0, off: 0, needsLook: 0 }, 1, []), '1 posting · 1 strong · showing 1')
eq('a zero group is not named', relevanceHeadline(big, 47, [{ label: 'off-direction', count: 265 }, { label: 'already read', count: 0 }]), '312 postings · 47 strong · showing 47 — 265 off-direction hidden')

// The whole point: the header's numbers come from the same pass as the list.
for (const filter of ['strong', 'possible', 'any'] as RelevanceFilter[]) {
  const r = rankAndFilter(ALL, chemCtx, { ...defaults, relevance: filter })
  const hiddenClaimed = r.counts.total - r.matched
  const hiddenActual = r.counts.total - r.ids.length
  eq(`hidden count is exact under relevance=${filter}`, hiddenClaimed, hiddenActual)
  check(`headline under relevance=${filter} names the total`, relevanceHeadline(r.counts, r.matched, r.hidden).startsWith(`${r.counts.total} posting`))
  // The groups are the reasons for THIS list, so they must add up to what is off the screen.
  eq(`hidden groups account for every hidden row under relevance=${filter}`, r.hidden.reduce((n, h) => n + h.count, 0), r.counts.total - r.ids.length)
}
eq('passesRelevance: any hides nothing', ['strong', 'possible', 'off'].every((b) => passesRelevance(b as 'off', 'any')), true)
eq('passesRelevance: strong is strong alone', ['possible', 'off'].some((b) => passesRelevance(b as 'off', 'strong')), false)

// ─── 7. The property that justifies computing at read time ───────────────────
//
// Same rows, same database, a different sentence in the mission — and the
// ranking inverts. Nothing was rewritten, nothing was re-extracted, nothing was
// backfilled.

const underChem = rankAndFilter(ALL, chemCtx, { ...defaults, relevance: 'any' })
const underGeno = rankAndFilter(ALL, genoCtx, { ...defaults, relevance: 'any' })
check('changing the direction changes the order with no data change', underChem.ids.join() !== underGeno.ids.join(), underChem.ids.join())
check('chemical engineering leads under the chemical direction', underChem.ids.indexOf('cheme') < underChem.ids.indexOf('genome'))
check('genomics leads under the genomics direction', underGeno.ids.indexOf('genome') < underGeno.ids.indexOf('cheme'))
eq('and the visible set changes too', rankAndFilter(ALL, genoCtx, defaults).ids.includes('genome'), true)
eq('the rows themselves were never touched', ALL.map((r) => r.id).join(), 'cheme,arch,office,genome,thin-cheme,thin-programme,fulltime,winter,ginkgo-sw')

// A third direction proves it is not two hard-coded cases.
const swCtx = relevanceContext(mission('software engineering, machine learning infrastructure'))
eq('a software direction makes the software posting strong', scoreRelevance(EVALUATED_SOFTWARE, swCtx).band, 'strong')
const chemUnderSoftware = scoreRelevance(CHEME, swCtx)
check('and the chemical posting is called off-direction', chemUnderSoftware.reasons.some((r) => r.startsWith('off-direction')), chemUnderSoftware.reasons.join(' · '))
check('though its own fit evaluation keeps it visible', chemUnderSoftware.band === 'possible' && chemUnderSoftware.reasons[0].startsWith('already evaluated'))
eq('a chemical posting with no evaluation is off under a software direction', scoreRelevance({ ...CHEME, fit_overall: null }, swCtx).band, 'off')

// ─── 8. The inbox's defaults ─────────────────────────────────────────────────

eq('the default relevance filter is strong + possible', DEFAULT_FILTERS.relevance, 'possible')
eq('the default freshness is open, not verified', DEFAULT_FILTERS.freshness, 'open')
eq('the default sort is best-first, not fit', DEFAULT_FILTERS.sort, 'best')
eq('the default disposition is undismissed', DEFAULT_FILTERS.disposition, 'new,saved')
check('the defaults are recognised as defaults', isDefaultFilters(DEFAULT_FILTERS))
check('density alone still counts as default', isDefaultFilters({ ...DEFAULT_FILTERS, dense: true }))
check('a narrowed filter does not', !isDefaultFilters({ ...DEFAULT_FILTERS, relevance: 'strong' }))

const q = new URLSearchParams(filtersToQuery(DEFAULT_FILTERS, 50, 0))
eq('the default query asks for relevance', q.get('relevance'), 'possible')
eq('the default query asks for open', q.get('freshness'), 'open')
eq('the default query asks for best-first', q.get('sort'), 'best')
eq('the default query pages fifty', q.get('limit'), '50')
check('density is never sent to the server', !filtersToQuery({ ...DEFAULT_FILTERS, dense: true }, 50, 0).includes('dense'))
check('the needs-a-look view is sent only when on', !filtersToQuery(DEFAULT_FILTERS, 50, 0).includes('view=') && filtersToQuery({ ...DEFAULT_FILTERS, view: 'needs_look' }, 50, 0).includes('view=needs_look'))
eq('search reaches the server verbatim', new URLSearchParams(filtersToQuery({ ...DEFAULT_FILTERS, search: '  genomics ' }, 50, 0)).get('search'), 'genomics')

// ─── Report ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`)
if (failures.length) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  ✗ ${f}`)
}
process.exit(failed === 0 ? 0 : 1)
