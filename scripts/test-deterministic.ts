// Tests for the deterministic core: scoring arithmetic, weights, dedupe, and
// seniority calibration.
//
// These are the highest-value things to pin down (docs/IMPLEMENTATION_PLAN.md
// §Testing): pure functions, high blast radius, no mocking required. Agent
// prompts are covered by evals, not unit tests — asserting an LLM's exact output
// is brittle and measures the wrong thing.
//
// Deliberately dependency-free so it runs under tsx with no test-runner install.
//   npm run test:deterministic

import { computeOverallScore, clampScore, rankByScore, applyThreshold, reweight, buildScoreResult } from '../lib/scoring/compute'
import { DEFAULT_WEIGHTS, resolveWeights, normalizeWeights, isValidWeights } from '../lib/scoring/weights'
import { SCORING_DIMENSIONS, type ScoreComponent } from '../lib/scoring/types'
import { computeTotal, deriveRecommendation, DIMENSION_MAX, SCOUT_DIMENSIONS, type ScoutComponent } from '../lib/scouting/score'
import { assessSeniority, sizeBand, normalizeSeniority } from '../lib/scouting/seniority'
import { dedupeCompanies, dedupePeople, countResidualDuplicates, companyKey, normalizeLinkedIn } from '../lib/scouting/dedupe'
import { interleave } from '../lib/scouting/concurrency'
import { allocateBudget } from '../lib/scouting/pipeline'
import { filterCompany, filterPerson } from '../lib/scouting/filter'
import type { CompanyCandidate, PersonCandidate } from '../lib/providers/types'

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++
  } else {
    failed++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function close(a: number, b: number, tol = 0.001): boolean {
  return Math.abs(a - b) < tol
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

function company(over: Partial<CompanyCandidate> = {}): CompanyCandidate {
  return {
    name: 'Acme Chemicals', domain: 'acme.com', description: 'Specialty chemicals manufacturer',
    industry: 'chemicals', sub_industries: [], employee_count: 500, employee_range: null,
    stage: null, founded_year: 2001, hq_location: 'Chicago, IL, United States', country: 'United States',
    website_url: 'https://acme.com', linkedin_url: null, raw: {},
    provenance: { provider_id: 'apollo', retrieved_at: '2026-08-10T00:00:00Z' },
    ...over,
  }
}

function person(over: Partial<PersonCandidate> = {}): PersonCandidate {
  return {
    name: 'Jane Doe', first_name: 'Jane', last_name: 'Doe', title: 'Director of Manufacturing',
    seniority: 'director', department: 'operations', email: 'jane@acme.com', email_status: 'verified',
    linkedin_url: 'https://linkedin.com/in/janedoe', location: 'Chicago, IL', company_name: 'Acme Chemicals',
    company_domain: 'acme.com', raw: {},
    provenance: { provider_id: 'apollo', external_id: 'apollo-1', retrieved_at: '2026-08-10T00:00:00Z' },
    ...over,
  }
}

function components(scores: Partial<Record<string, number>>): ScoreComponent[] {
  return SCORING_DIMENSIONS.map((d) => ({
    dimension: d, score: scores[d] ?? 0.5, explanation: 'x', evidence: [],
  }))
}

function scoutComponents(scores: Partial<Record<string, number>>): ScoutComponent[] {
  return SCOUT_DIMENSIONS.map((d) => {
    const normalized = scores[d] ?? 0.5
    return { dimension: d, normalized, points: normalized * DIMENSION_MAX[d], max: DIMENSION_MAX[d], explanation: 'x' }
  })
}

// ─── Scoring arithmetic ──────────────────────────────────────────────────────

check('clampScore bounds', clampScore(1.7) === 1 && clampScore(-3) === 0 && clampScore(0.4) === 0.4)
check('clampScore handles NaN', clampScore(NaN) === 0)

check(
  'all-1.0 components produce 1.0 overall',
  close(computeOverallScore(components(Object.fromEntries(SCORING_DIMENSIONS.map((d) => [d, 1]))), DEFAULT_WEIGHTS), 1)
)
check(
  'all-0 components produce 0 overall',
  close(computeOverallScore(components(Object.fromEntries(SCORING_DIMENSIONS.map((d) => [d, 0]))), DEFAULT_WEIGHTS), 0)
)

// A dimension the agent could not judge must not be treated as a zero — that
// would conflate "no evidence" with "bad".
{
  const partial = components({ opportunity_fit: 1 }).filter((c) => c.dimension === 'opportunity_fit')
  check('missing dimensions excluded from denominator', close(computeOverallScore(partial, DEFAULT_WEIGHTS), 1),
    `got ${computeOverallScore(partial, DEFAULT_WEIGHTS)}`)
}

// Weighting must actually bite: the heaviest dimension moves the score most.
{
  const onlyFit = computeOverallScore(components({ opportunity_fit: 1, decision_making_power: 0, user_differentiation: 0, probability_of_response: 0, company_attractiveness: 0, timing_trigger: 0 }), DEFAULT_WEIGHTS)
  const onlyTiming = computeOverallScore(components({ opportunity_fit: 0, decision_making_power: 0, user_differentiation: 0, probability_of_response: 0, company_attractiveness: 0, timing_trigger: 1 }), DEFAULT_WEIGHTS)
  check('heavier dimension contributes more', onlyFit > onlyTiming, `fit=${onlyFit} timing=${onlyTiming}`)
  check('opportunity_fit contributes exactly its weight', close(onlyFit, 0.25))
}

// ─── Weights ─────────────────────────────────────────────────────────────────

check('default weights sum to 1', close(SCORING_DIMENSIONS.reduce((s, d) => s + DEFAULT_WEIGHTS[d], 0), 1))
check('resolveWeights with null returns defaults', close(resolveWeights(null).opportunity_fit, 0.25))
{
  const r = resolveWeights({ opportunity_fit: 0.5 })
  check('partial override renormalizes to 1', close(SCORING_DIMENSIONS.reduce((s, d) => s + r[d], 0), 1))
  check('overridden dimension gains share', r.opportunity_fit > 0.25, `got ${r.opportunity_fit}`)
}
check('negative weights fall back to default', close(resolveWeights({ opportunity_fit: -1 } as never).opportunity_fit / normalizeWeights(DEFAULT_WEIGHTS).opportunity_fit, 1))
check('zero-total weights fall back to defaults',
  close(normalizeWeights(Object.fromEntries(SCORING_DIMENSIONS.map((d) => [d, 0])) as never).opportunity_fit, 0.25))
check('isValidWeights rejects partial', !isValidWeights({ opportunity_fit: 0.5 }))
check('isValidWeights accepts complete', isValidWeights(DEFAULT_WEIGHTS))

// Re-weighting is the payoff of ADR-004: re-rank with no model call.
{
  const base = buildScoreResult({ subject_id: 'a', components: components({ timing_trigger: 1, opportunity_fit: 0 }), confidence: 0.8, summary: 's' }, null)
  const heavy = reweight([base], { timing_trigger: 0.9 })[0]
  check('reweight raises score when the strong dimension is upweighted', heavy.overall_score > base.overall_score,
    `${base.overall_score} -> ${heavy.overall_score}`)
  check('reweight snapshots the new weights', heavy.weights_used.timing_trigger > base.weights_used.timing_trigger)
  check('reweight leaves components untouched', heavy.components.length === base.components.length)
}

// ─── Ranking and thresholds ──────────────────────────────────────────────────
{
  const items = [
    { overall_score: 0.8, confidence: 0.2 },
    { overall_score: 0.9, confidence: 0.5 },
    { overall_score: 0.8, confidence: 0.9 },
  ]
  const ranked = rankByScore(items)
  check('ranks by score descending', ranked[0].overall_score === 0.9)
  check('ties break on confidence', ranked[1].confidence === 0.9, `got ${ranked[1].confidence}`)
  check('rankByScore does not mutate input', items[0].overall_score === 0.8)
  check('applyThreshold filters by score', applyThreshold(items, 0.85).length === 1)
  // score >= 0.7 AND confidence >= 0.6 keeps only {0.8, 0.9}
  check('applyThreshold filters by confidence too', applyThreshold(items, 0.7, 0.6).length === 1,
    `got ${applyThreshold(items, 0.7, 0.6).length}`)
  check('confidence floor defaults to permissive', applyThreshold(items, 0.7).length === 3)
}

// ─── Phase 3 scout scoring ───────────────────────────────────────────────────

check('scout dimension maxima sum to 100', SCOUT_DIMENSIONS.reduce((s, d) => s + DIMENSION_MAX[d], 0) === 100)
check('perfect scout score is 100', computeTotal(scoutComponents(Object.fromEntries(SCOUT_DIMENSIONS.map((d) => [d, 1])))) === 100)
check('zero scout score is 0', computeTotal(scoutComponents(Object.fromEntries(SCOUT_DIMENSIONS.map((d) => [d, 0])))) === 0)

// Recommendation bands are derived in code so equal scores always get equal labels.
{
  const strong = scoutComponents({ opportunity_fit: 0.9, background_relevance: 0.9, decision_influence: 0.9, differentiation: 0.8, accessibility: 0.8 })
  check('high score with influence is STRONG', deriveRecommendation(computeTotal(strong), strong) === 'STRONG')

  // The influence floor: a high total built on domain fit alone is a trap —
  // someone interesting who cannot create or refer an opportunity is not STRONG.
  const noInfluence = scoutComponents({ opportunity_fit: 1, background_relevance: 1, decision_influence: 0.1, differentiation: 1, accessibility: 1 })
  check('high total but low influence is not STRONG', deriveRecommendation(computeTotal(noInfluence), noInfluence) !== 'STRONG',
    `total=${computeTotal(noInfluence)} rec=${deriveRecommendation(computeTotal(noInfluence), noInfluence)}`)

  const weak = scoutComponents({ opportunity_fit: 0.2, background_relevance: 0.2, decision_influence: 0.2, differentiation: 0.2, accessibility: 0.2 })
  check('low score is WEAK', deriveRecommendation(computeTotal(weak), weak) === 'WEAK')
}

// ─── Seniority calibration ───────────────────────────────────────────────────
// The product rule: appropriate != maximum (docs/PRODUCT.md §5).

check('sizeBand boundaries', sizeBand(10) === 'micro' && sizeBand(100) === 'small' && sizeBand(1000) === 'mid' && sizeBand(5000) === 'large' && sizeBand(50000) === 'enterprise')
check('sizeBand handles unknown', sizeBand(null) === 'unknown' && sizeBand(0) === 'unknown')
check('normalizeSeniority maps unknown values', normalizeSeniority('emperor') === 'unknown' && normalizeSeniority('C_Suite') === 'c_suite')

check('CEO at a 25-person startup is appropriate',
  assessSeniority('c_suite', 'Chief Executive Officer', 25).verdict === 'appropriate')
check('CEO at a 40,000-person corporation is TOO SENIOR',
  assessSeniority('c_suite', 'Chief Executive Officer', 40000).verdict === 'too_senior',
  assessSeniority('c_suite', 'CEO', 40000).verdict)
check('Director at a 40,000-person corporation is appropriate',
  assessSeniority('director', 'Director of Digital Manufacturing', 40000).verdict === 'appropriate')
check('VP at a large company is appropriate',
  assessSeniority('vp', 'VP of Operations', 5000).verdict === 'appropriate')
check('intern is too junior', assessSeniority('intern', 'Intern', 100).verdict === 'too_junior')
check('IC senior is too junior', assessSeniority('senior', 'Senior Engineer', 100).verdict === 'too_junior')
check('plain line manager is too junior', assessSeniority('manager', 'Manager', 500).verdict === 'too_junior')
check('senior manager with real scope is appropriate',
  assessSeniority('manager', 'Senior Manager, Manufacturing Operations', 500).verdict === 'appropriate',
  assessSeniority('manager', 'Senior Manager, Manufacturing Operations', 500).reason)
check('IC title with senior band is rejected',
  assessSeniority('director', 'Research Scientist', 500).verdict === 'too_junior')
check('Head of AI keeps its band despite engineer-ish wording',
  assessSeniority('head', 'Head of AI Engineering', 200).verdict === 'appropriate')

// ─── Dedupe ──────────────────────────────────────────────────────────────────

check('companyKey prefers domain', companyKey({ domain: 'Acme.COM', name: 'Different Name' }) === 'd:acme.com')
check('companyKey falls back to normalized name',
  companyKey({ domain: null, name: 'Acme Chemicals, Inc.' }) === companyKey({ domain: null, name: 'ACME Chemicals LLC' }),
  `${companyKey({ domain: null, name: 'Acme Chemicals, Inc.' })} vs ${companyKey({ domain: null, name: 'ACME Chemicals LLC' })}`)

{
  // Domains arrive already normalized from normalizeOrg(); companyKey normalizes
  // again defensively, which is what collapses raw variants.
  const deduped = dedupeCompanies([
    company({ domain: 'acme.com', employee_count: null, industry: null, description: null, founded_year: null, hq_location: null }),
    company({ domain: 'https://www.acme.com/careers', employee_count: 500, industry: 'chemicals' }),
    company({ domain: 'other.com' }),
  ])
  check('dedupeCompanies collapses domain variants', deduped.unique.length === 2, `got ${deduped.unique.length}`)
  check('dedupeCompanies keeps the richer record',
    deduped.unique.some((c) => c.employee_count === 500 && c.industry === 'chemicals'),
    JSON.stringify(deduped.unique.map((c) => ({ d: c.domain, e: c.employee_count }))))
}

{
  const deduped = dedupePeople([
    person({ provenance: { provider_id: 'apollo', external_id: 'x1', retrieved_at: '' } }),
    person({ provenance: { provider_id: 'apollo', external_id: 'x1', retrieved_at: '' } }),
    person({ provenance: { provider_id: 'apollo', external_id: 'x2', retrieved_at: '' } }),
  ])
  check('dedupePeople collapses on apollo id', deduped.unique.length === 2)
  check('dedupePeople reports removals', deduped.duplicatesRemoved === 1)
}

check('normalizeLinkedIn strips scheme, www, trailing slash and query',
  normalizeLinkedIn('https://WWW.linkedin.com/in/janedoe/?utm=x') === 'linkedin.com/in/janedoe')

// The residual pass is what catches the SAME human under two Apollo ids.
{
  const residual = countResidualDuplicates([
    person({ provenance: { provider_id: 'apollo', external_id: 'a', retrieved_at: '' } }),
    person({ provenance: { provider_id: 'apollo', external_id: 'b', retrieved_at: '' } }),
  ])
  check('residual duplicates catch same LinkedIn under different apollo ids', residual === 1, `got ${residual}`)
  check('distinct people are not flagged',
    countResidualDuplicates([person(), person({ name: 'Bob Smith', linkedin_url: 'https://linkedin.com/in/bob', company_name: 'Other Co' })]) === 0)
}

// ─── Filters ─────────────────────────────────────────────────────────────────

check('staffing agency rejected', !filterCompany(company({ name: 'Apex Staffing Solutions' })).keep)
check('job board rejected', !filterCompany(company({ name: 'Empleos Chile' })).keep)
check('university rejected', !filterCompany(company({ name: 'University at Buffalo' })).keep)
check('recruiting described company rejected',
  !filterCompany(company({ name: 'Neutral Co', description: 'We are a recruiting agency for manufacturers' })).keep)
check('real chemical company kept', filterCompany(company()).keep)
check('company below size floor rejected', !filterCompany(company({ employee_count: 5 }), { minEmployees: 50 }).keep)

// Required-domain terms: Apollo's "operations consulting" keyword returns
// golf-club and hospitality advisories alongside industrial ones.
{
  const terms = ['manufactur', 'industrial', 'chemical', 'process']
  const golf = company({ name: 'GGA Partners', description: 'Advisory firm for private golf and club leisure businesses', industry: 'management consulting', sub_industries: [] })
  const industrial = company({ name: 'Life Cycle Engineering', description: 'Reliability and industrial operations consulting for manufacturing plants', industry: 'management consulting', sub_industries: [] })
  check('off-domain consultancy rejected', !filterCompany(golf, { requiredDomainTerms: terms }).keep)
  check('off-domain rejection is labelled', filterCompany(golf, { requiredDomainTerms: terms }).reason === 'off_domain')
  check('industrial consultancy kept', filterCompany(industrial, { requiredDomainTerms: terms }).keep)
  check('no domain terms means no requirement', filterCompany(golf, {}).keep)
  check('domain term can match keywords',
    filterCompany(company({ name: 'Opaque Co', description: null, industry: null, sub_industries: ['process optimization'] }), { requiredDomainTerms: terms }).keep)
}
check('company above size ceiling rejected', !filterCompany(company({ employee_count: 90000 }), { maxEmployees: 5000 }).keep)

check('sales VP rejected as irrelevant function',
  !filterPerson(person({ title: 'VP of Sales', seniority: 'vp' }), 500).keep)
check('recruiter rejected', !filterPerson(person({ title: 'Technical Recruiter', seniority: 'director' }), 500).keep)
check('AI solutions leader kept despite sales-adjacent wording',
  filterPerson(person({ title: 'VP of AI Solutions Engineering', seniority: 'vp' }), 500).keep)
check('person with no company rejected',
  !filterPerson(person({ company_name: null }), 500).keep)
check('relevant director kept', filterPerson(person(), 500).keep)

// ─── Interleave ──────────────────────────────────────────────────────────────
{
  const items = Array.from({ length: 12 }, (_, i) => i)
  const out = interleave(items, 4)
  check('interleave preserves every element', out.length === 12 && new Set(out).size === 12)
  check('interleave mixes across the pool', out[0] === 0 && out[1] === 4 && out[2] === 8, out.slice(0, 4).join(','))
  check('interleave is deterministic', interleave(items, 4).join(',') === out.join(','))
  check('interleave no-ops on small input', interleave([1, 2], 8).length === 2)
}

// ─── Budget allocation ───────────────────────────────────────────────────────
// Queries are not equal. Earlier (higher-priority) queries must get a larger
// share of the enrichment budget — spreading it uniformly regressed profile 1
// from 65% to 35% in iteration 4.
{
  const stub = (id: string) => ({ apollo_id: id, first_name: null, title: null, company_name: null, has_email: false, query_ref: {} })
  const groups = [
    Array.from({ length: 50 }, (_, i) => stub(`a${i}`)),
    Array.from({ length: 50 }, (_, i) => stub(`b${i}`)),
    Array.from({ length: 50 }, (_, i) => stub(`c${i}`)),
  ]

  const out = allocateBudget(groups, 60)
  check('allocateBudget respects the budget', out.length === 60, `got ${out.length}`)
  check('allocateBudget returns unique stubs', new Set(out.map((s) => s.apollo_id)).size === out.length)

  const counts = { a: 0, b: 0, c: 0 }
  for (const s of out) counts[s.apollo_id[0] as 'a' | 'b' | 'c']++
  check('earlier queries get a larger share', counts.a > counts.c, JSON.stringify(counts))
  check('later queries are not starved', counts.c > 0, JSON.stringify(counts))

  // A query that returned little must not waste its quota.
  const lopsided = [[stub('x0')], Array.from({ length: 80 }, (_, i) => stub(`y${i}`))]
  const redistributed = allocateBudget(lopsided, 40)
  check('unused quota is redistributed', redistributed.length === 40, `got ${redistributed.length}`)

  check('allocateBudget handles empty input', allocateBudget([], 20).length === 0)
  check('allocateBudget handles zero budget', allocateBudget(groups, 0).length === 0)
  check('allocateBudget caps at available stubs',
    allocateBudget([[stub('z0'), stub('z1')]], 500).length === 2)
}

// ─── Title normalization ─────────────────────────────────────────────────────
// Every case here is a real string a model produced that returned 0 Apollo rows.
{
  const { normalizeTitlePattern, normalizeTitlePatterns, resolveTitlesForCompany, archetypeFromSize } =
    require('../lib/scouting/titles') as typeof import('../lib/scouting/titles')

  const eq = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b)

  check('strips trailing scope qualifier after a dash',
    eq(normalizeTitlePattern('Head of Product - Manufacturing/Process Industries'), ['Head of Product']),
    JSON.stringify(normalizeTitlePattern('Head of Product - Manufacturing/Process Industries')))

  check('splits slash alternatives and drops parentheticals',
    eq(normalizeTitlePattern('Founder/CTO (early-stage industrial AI startup)'), ['Founder', 'CTO']),
    JSON.stringify(normalizeTitlePattern('Founder/CTO (early-stage industrial AI startup)')))

  check('strips comma qualifier',
    eq(normalizeTitlePattern('Solutions Engineering Manager, Process Industries'), ['Solutions Engineering Manager']),
    JSON.stringify(normalizeTitlePattern('Solutions Engineering Manager, Process Industries')))

  check('leaves a real title untouched',
    eq(normalizeTitlePattern('Director of Applied AI'), ['Director of Applied AI']))

  // "Director, X" means "Director of X" — the tail is the FUNCTION. Dropping it
  // reduced the title to a bare "Director", and searching a 90,000-person
  // manufacturer for "Director" returns every director in the company.
  check('keeps the function after a bare rank + comma',
    eq(normalizeTitlePattern('Director, Digital Manufacturing'), ['Director Digital Manufacturing']),
    JSON.stringify(normalizeTitlePattern('Director, Digital Manufacturing')))
  check('handles rank + comma + function + trailing scope',
    eq(normalizeTitlePattern('Director, Process Technology - Polymerization'), ['Director Process Technology']),
    JSON.stringify(normalizeTitlePattern('Director, Process Technology - Polymerization')))
  check('handles a multi-word bare rank',
    eq(normalizeTitlePattern('Senior Director, Manufacturing Technology'), ['Senior Director Manufacturing Technology']),
    JSON.stringify(normalizeTitlePattern('Senior Director, Manufacturing Technology')))
  check('never normalizes down to a bare rank',
    normalizeTitlePattern('Director, Digital Manufacturing')[0] !== 'Director')
  // The opposite convention must still work: qualifier after the comma.
  check('still drops a scope qualifier when the head is a real title',
    eq(normalizeTitlePattern('Solutions Engineering Manager, Process Industries'), ['Solutions Engineering Manager']),
    JSON.stringify(normalizeTitlePattern('Solutions Engineering Manager, Process Industries')))

  // The enterprise fallback list must not contain titles that mean product
  // innovation at a CPG manufacturer — they produced 3 of 6 BADs.
  const { ARCHETYPE_TITLES } = require('../lib/scouting/titles') as typeof import('../lib/scouting/titles')
  check('enterprise fallback drops ambiguous innovation/R&D titles',
    !ARCHETYPE_TITLES.enterprise.some((t) => /^Director of Innovation$|^Director R&D$/i.test(t)),
    JSON.stringify(ARCHETYPE_TITLES.enterprise))
  check('every enterprise fallback title names a function',
    ARCHETYPE_TITLES.enterprise.every((t) => t.trim().split(/\s+/).length >= 3),
    JSON.stringify(ARCHETYPE_TITLES.enterprise))

  check('drops prose that is not a title',
    normalizeTitlePattern('someone who owns process optimization end to end').length === 0,
    JSON.stringify(normalizeTitlePattern('someone who owns process optimization end to end')))

  check('dedupes case-insensitively',
    eq(normalizeTitlePatterns(['CTO', 'cto', 'Founder/CTO']), ['CTO', 'Founder']),
    JSON.stringify(normalizeTitlePatterns(['CTO', 'cto', 'Founder/CTO'])))

  check('respects the limit', normalizeTitlePatterns(['A Lead', 'B Lead', 'C Lead'], 2).length === 2)

  // Archetype banding is what encodes "appropriate seniority is not maximum".
  check('tiny company is a startup', archetypeFromSize(12) === 'startup')
  check('huge company is an enterprise', archetypeFromSize(90000) === 'enterprise')
  check('unknown size is not guessed', archetypeFromSize(null) === 'other')

  const usable = resolveTitlesForCompany(['Co-Founder', 'CTO', 'Head of Engineering'], 'startup')
  check('good researched titles are used as-is', !usable.usedFallback && usable.titles.length === 3)

  const unusable = resolveTitlesForCompany(
    ['Head of Product - Manufacturing/Process Industries'], 'enterprise')
  check('unusable titles fall back to the archetype',
    unusable.usedFallback && unusable.titles.length >= 3,
    JSON.stringify(unusable))
  check('fallback keeps the salvageable researched title',
    unusable.titles[0] === 'Head of Product', JSON.stringify(unusable.titles))
  check('never returns an empty title list',
    resolveTitlesForCompany([], 'consultancy').titles.length > 0)

  // Ranking candidates within a company. Apollo returns matches in an order of
  // its own; taking the first N that pass the filter picks by Apollo's sort
  // rather than by fit.
  const { scoreStubTitle, rankStubsByTitle } =
    require('../lib/scouting/titles') as typeof import('../lib/scouting/titles')

  const startupTargets = ['Co-Founder', 'CTO', 'Head of Engineering']
  check('exact target match beats a partial one',
    scoreStubTitle('Co-Founder', startupTargets, 'startup') >
    scoreStubTitle('Engineering Manager', startupTargets, 'startup'))

  check('earlier target titles outrank later ones',
    scoreStubTitle('Co-Founder', startupTargets, 'startup') >
    scoreStubTitle('Head of Engineering', startupTargets, 'startup'))

  // The core rule: appropriate seniority is not maximum seniority.
  const entTargets = ['Director Digital Manufacturing', 'Director Process Technology']
  check('founder outranks director at a startup',
    scoreStubTitle('Founder', startupTargets, 'startup') >
    scoreStubTitle('Director of Operations', startupTargets, 'startup'))
  check('director outranks CEO at an enterprise',
    scoreStubTitle('Director Digital Manufacturing', entTargets, 'enterprise') >
    scoreStubTitle('Chief Executive Officer', entTargets, 'enterprise'),
    `${scoreStubTitle('Director Digital Manufacturing', entTargets, 'enterprise')} vs ${scoreStubTitle('Chief Executive Officer', entTargets, 'enterprise')}`)

  check('an empty title scores below everything', scoreStubTitle(null, startupTargets, 'startup') === -1)

  const pool = [
    { t: 'Executive Assistant' },
    { t: 'Director Digital Manufacturing' },
    { t: 'Process Engineer' },
  ]
  const rankedPool = rankStubsByTitle(pool, (p) => p.t, entTargets, 'enterprise')
  check('ranking surfaces the intended person first',
    rankedPool[0].t === 'Director Digital Manufacturing', JSON.stringify(rankedPool.map((p) => p.t)))

  // Trainees cannot create, sponsor, or refer — the whole test. A "Research
  // Assistant, Masters Student" reached a published top-20 before this existed.
  const { stubPassesCheapFilter } = require('../lib/scouting/filter') as typeof import('../lib/scouting/filter')
  for (const title of [
    'Research Assistant, Masters Student',
    'PhD Candidate',
    'Graduate Student',
    'Manufacturing Co-op',
    'Engineering Trainee',
  ]) {
    check(`filter rejects trainee title: ${title}`,
      !stubPassesCheapFilter(title, 'Acme').keep, title)
  }
  // ...but must not reject real roles that merely contain a similar word.
  for (const title of ['Assistant Director of Manufacturing', 'Director of Process Technology', 'Head of Deployment']) {
    check(`filter keeps real role: ${title}`,
      stubPassesCheapFilter(title, 'Acme').keep, JSON.stringify(stubPassesCheapFilter(title, 'Acme')))
  }

  // Pool depth is a property of the COMPANY. The same global depth that moved
  // chemical/manufacturing 45% -> 75% moved Enterprise AI 65% -> 60%.
  const { peopleDepthFor, PEOPLE_PER_COMPANY } =
    require('../lib/scouting/titles') as typeof import('../lib/scouting/titles')

  check('enterprises are mined deeper than startups',
    PEOPLE_PER_COMPANY.enterprise > PEOPLE_PER_COMPANY.startup,
    JSON.stringify(PEOPLE_PER_COMPANY))
  check('depth respects the run cap', peopleDepthFor('enterprise', 2) === 2)
  check('depth is never zero', peopleDepthFor('startup', 0) === 1)
  check('every archetype has a depth',
    (Object.keys(PEOPLE_PER_COMPANY) as (keyof typeof PEOPLE_PER_COMPANY)[])
      .every((a) => PEOPLE_PER_COMPANY[a] >= 1))

  // Stability matters: an unstable sort makes runs undiffable.
  const tied = [{ t: 'Zeta Manager' }, { t: 'Alpha Manager' }]
  check('equal scores keep provider order',
    rankStubsByTitle(tied, (p) => p.t, ['Manager'], 'midmarket')[0].t === 'Zeta Manager')
}

// ─── Agentic eval metrics ────────────────────────────────────────────────────
// The eval decides whether the phase passes, so its arithmetic gets the same
// scrutiny as the pipeline's.
{
  const m = require('../evals/agentic/metrics') as typeof import('../evals/agentic/metrics')

  const p = m.computePrecision(['GOOD_HIGH_EVIDENCE', 'GOOD_ROLE_BASED', 'MAYBE', 'BAD'])
  check('both GOOD tiers count toward precision', p.precision === 0.5, String(p.precision))
  check('GOOD tiers are reported separately',
    p.goodHighEvidence === 1 && p.goodRoleBased === 1, JSON.stringify(p))
  // The measurement-bug fix: a strong target with a quiet web presence is GOOD.
  check('role-based GOOD is not penalised',
    m.computePrecision(['GOOD_ROLE_BASED', 'GOOD_ROLE_BASED']).precision === 1)
  check('MAYBE is neither hit nor miss', p.maybe === 1 && p.badRate === 0.25, JSON.stringify(p))
  check('empty verdicts do not divide by zero', m.computePrecision([]).precision === 0)

  // A profile that returned nothing must not score 100% by vacuous truth.
  check('empty profile scores zero, not one', m.computePrecision([]).precision === 0)

  const c = m.computeCompanyRate(['GOOD', 'MAYBE', 'BAD', 'BAD'])
  check('company rate gives MAYBE half credit', Math.abs(c.rate - 0.375) < 1e-9, String(c.rate))

  // Search recovery. Only segments that actually hit trouble are counted.
  const round = (over: Partial<import('@/lib/agents/market-discovery').DiscoveryRoundHistory>) => ({
    round: 1, query_used: 'q', companies_found: 0, companies_kept: 0,
    diagnosis: 'HEALTHY', action: 'ACCEPT', note: '', ...over,
  }) as import('@/lib/agents/market-discovery').DiscoveryRoundHistory

  const healthy = m.classifyRecovery([{ segment: 'a', rounds: [round({})] }])
  check('healthy segment is not applicable', healthy[0].outcome === 'not_applicable', healthy[0].outcome)

  const recovered = m.classifyRecovery([{
    segment: 'b',
    rounds: [
      round({ round: 1, diagnosis: 'DOMAIN_DRIFT', action: 'SYNONYMS' }),
      round({ round: 2, companies_kept: 5, action: 'ACCEPT' }),
    ],
  }])
  check('drift then companies counts as recovered', recovered[0].outcome === 'recovered', recovered[0].detail)

  const terminated = m.classifyRecovery([{
    segment: 'c',
    rounds: [round({ round: 1, diagnosis: 'LOW_SUPPLY', action: 'REJECT_HYPOTHESIS' })],
  }])
  check('killing a dead hypothesis is a success', terminated[0].outcome === 'correctly_terminated', terminated[0].detail)

  const ground = m.classifyRecovery([{
    segment: 'd',
    rounds: [
      round({ round: 1, diagnosis: 'LOW_SUPPLY', action: 'REFINE' }),
      round({ round: 2, diagnosis: 'LOW_SUPPLY', action: 'REFINE' }),
    ],
  }])
  check('grinding a dead hypothesis is a failure', ground[0].outcome === 'failed', ground[0].detail)

  const rate = m.recoveryRate([...healthy, ...recovered, ...terminated, ...ground])
  check('recovery denominator excludes healthy segments', rate.applicable === 3, JSON.stringify(rate))
  check('recovery rate counts both success modes', Math.abs(rate.rate - 2 / 3) < 1e-9, String(rate.rate))
  check('no applicable cases means no failure', m.recoveryRate(healthy).rate === 1)

  const eff = m.computeEfficiency({
    apolloSearchCalls: 10, enrichmentCredits: 40, peopleEnriched: 38,
    goodProspects: 8, webSearches: 60, modelCalls: 90, anthropicCostUsd: 16,
  })
  check('enrichments per good prospect', eff.enrichmentsPerGoodProspect === 5, String(eff.enrichmentsPerGoodProspect))
  check('cost per good prospect', eff.costPerGoodProspect === 2, String(eff.costPerGoodProspect))
  check('zero good prospects is infinite cost, not zero',
    m.computeEfficiency({ apolloSearchCalls: 1, enrichmentCredits: 1, peopleEnriched: 1,
      goodProspects: 0, webSearches: 1, modelCalls: 1, anthropicCostUsd: 5 }).costPerGoodProspect === Infinity)

  // Thresholds are from the brief and must not drift.
  check('thresholds match the brief',
    m.THRESHOLDS.avgPrecision === 0.75 && m.THRESHOLDS.minProfilePrecision === 0.65 &&
    m.THRESHOLDS.maxBadRate === 0.10 && m.THRESHOLDS.minDiscoveryPrecision === 0.80 &&
    m.THRESHOLDS.minRejectionAccuracy === 0.90 && m.THRESHOLDS.minSearchRecovery === 0.80 &&
    m.THRESHOLDS.minBestPersonHitRate === 0.70,
    JSON.stringify(m.THRESHOLDS))
}

// ─── Outreach state machine ──────────────────────────────────────────────────
// The transition table is the only thing standing between "update a row" and
// "put mail in a stranger's inbox", so it is tested as such.
{
  const s = require('../lib/outreach/states') as typeof import('../lib/outreach/states')

  check('approved is the door into sending', s.canTransition('approved', 'sending'))
  // `failed` is the only other one, and it is reachable only from `sending`,
  // which is reachable only from `approved` — so retrying cannot smuggle
  // unapproved text out.
  for (const from of s.OUTREACH_STATES) {
    if (from === 'approved' || from === 'failed') continue
    check(`${from} cannot reach sending`, !s.canTransition(from, 'sending'), from)
  }
  check('failed is reachable only from sending',
    s.OUTREACH_STATES.filter((x) => s.canTransition(x, 'failed')).join(',') === 'sending')
  // Nothing may declare itself sent; only the send path does, out of `sending`.
  for (const from of s.OUTREACH_STATES) {
    if (from === 'sending') continue
    check(`${from} cannot jump straight to sent`, !s.canTransition(from, 'sent'), from)
  }

  check('a sent email cannot be unsent', !s.canTransition('sent', 'draft'))
  check('a sent email cannot be re-approved', !s.canTransition('sent', 'approved'))
  check('a failed send keeps its approval retryable', s.canTransition('failed', 'sending'))
  check('closed is terminal', s.nextStates('closed').length === 0)
  check('a skipped prospect can be revived', s.canTransition('skipped', 'draft'))

  check('editing is blocked once committed',
    !s.isEditable('sent') && !s.isEditable('sending') && !s.isEditable('replied'))
  check('editing is allowed before that', s.isEditable('draft') && s.isEditable('approved'))

  check('hasBeenSent covers every post-send state',
    ['sent', 'replied', 'meeting', 'referred', 'closed'].every((x) => s.hasBeenSent(x as never)))
  check('hasBeenSent excludes sending', !s.hasBeenSent('sending'))

  check('meeting request becomes a meeting',
    s.stateForClassification('MEETING_REQUEST', 'sent') === 'meeting')
  check('a referral becomes referred', s.stateForClassification('REFERRAL', 'sent') === 'referred')
  check('a no-fit closes it', s.stateForClassification('NO_FIT', 'sent') === 'closed')
  check('a plain positive reply is just replied',
    s.stateForClassification('POSITIVE', 'sent') === 'replied')
  // A classification cannot resurrect an unsent draft.
  check('classification never moves an unsent draft',
    s.stateForClassification('MEETING_REQUEST', 'draft') === 'draft')
  // Later replies must not walk a meeting backwards.
  check('a later reply does not downgrade a meeting',
    s.stateForClassification('POSITIVE', 'meeting') === 'meeting')

  check('outcome guard rejects nonsense', !s.isOutcome('MAYBE_LATER'))
  check('outcome guard accepts the list', s.isOutcome('CALL_BOOKED'))
}

// ─── Claim-safety gate ───────────────────────────────────────────────────────
// A gate with false negatives sends lies; a gate with false positives gets
// switched off. Both directions are asserted.
{
  const g = require('../lib/outreach/grounding') as typeof import('../lib/outreach/grounding')

  const evidence = [
    'SENDER: HPC catalysis — UIUC (2025): Ran 73,000 CPU-hours of VASP screening.',
    'SENDER: Agentic adoption — Procter & Gamble (2025): $3M+ projected annual savings.',
    'RECIPIENT: Director of Smart Manufacturing at Cargill.',
    'THEIR COMPANY: Argonne National Laboratory operates the Advanced Photon Source.',
  ]
  const safeNames = ['Michael Venteicher', 'Cargill', 'Zuyu Liu']
  const gate = (body: string, subject = 'A note') =>
    g.checkGrounding({ subject, body, evidence, safeNames })

  // Quantity extraction
  const q = g.extractQuantities('We saved $3M+ and 40% of 73k CPU-hours, ranked #2, 3x faster.')
  const kinds = q.map((x) => x.kind)
  check('money is extracted', kinds.includes('money'))
  check('percentages are extracted', kinds.includes('percent'))
  check('rankings are extracted', kinds.includes('ordinal'))
  check('multipliers are extracted', kinds.includes('multiplier'))
  check('$3M normalises to 3,000,000',
    q.some((x) => x.kind === 'money' && x.value === 3_000_000), JSON.stringify(q))
  check('73k normalises to 73,000',
    q.some((x) => x.value === 73_000), JSON.stringify(q))

  check('calendar years are not claims',
    g.extractQuantities('for winter 2026-27').length === 0,
    JSON.stringify(g.extractQuantities('for winter 2026-27')))
  check('meeting durations are not claims',
    g.extractQuantities('Worth 20 minutes?').length === 0)
  check('hyphenated durations are not claims',
    g.extractQuantities('a 15-minute call').length === 0,
    JSON.stringify(g.extractQuantities('a 15-minute call')))

  // Blocking cases
  check('an invented dollar figure blocks', !gate('I saved them $12M last year.').ok)
  check('an invented percentage blocks', !gate('It cut cycle time by 40%.').ok)
  check('an inflated real figure blocks', !gate('I ran 730,000 CPU-hours.').ok)
  check('an invented programme name blocks', !gate('I follow Project Helios closely.').ok)
  check('an invented acronym blocks', !gate('The ACME rollout there is interesting.').ok)
  check('an invented superlative blocks', !gate('Cargill runs the largest mill anywhere.').ok)
  check('an invented responsibility blocks',
    !gate('You lead the quantum photonics roadmap there.').ok)
  check('the subject line is checked too',
    !gate('Grounded body about VASP screening.', 'Re: your $9M programme').ok)

  // Non-blocking cases
  const clean = gate(
    'I ran 73,000 CPU-hours of VASP screening, and the P&G workflow is projected at $3M+ ' +
      'in annual savings. Worth a 15-minute call in winter 2026-27?'
  )
  check('a fully grounded draft passes', clean.ok, JSON.stringify(clean.blocking))
  check('P&G resolves to Procter & Gamble',
    gate('I worked at P&G on the adoption problem.').ok)
  check('naming the recipient is never a claim',
    gate('Michael, the Cargill smart-manufacturing side is the overlap.').ok)
  check('sentence-initial prose is not an entity',
    gate('Separately, I designed the architecture. Surfacing that took a while.').ok)
  check('contractions are not entities',
    gate("That's the adoption gap. You've seen it too.").ok)

  // Findings carry a usable revision, not just a complaint.
  const blocked = gate('I saved them $12M last year.')
  check('a blocking finding names the claim', blocked.blocking[0]?.claim === '$12M')
  check('a blocking finding offers the real figure',
    blocked.blocking[0]?.revision.includes('$3M'), blocked.blocking[0]?.revision)
  check('a blocking finding quotes the sentence',
    blocked.blocking[0]?.sentence.includes('$12M'))

  // Warnings never block.
  check('warnings do not block',
    g.checkGrounding({ subject: 'x', body: 'The most useful part was Adoption.', evidence, safeNames })
      .warnings.length >= 0)

  // No evidence at all must not silently pass claims.
  check('an empty evidence pool blocks a figure',
    !g.checkGrounding({ subject: 'x', body: 'We saved $4M.', evidence: [] }).ok)
}

// ─── Evidence pool ───────────────────────────────────────────────────────────
{
  const e = require('../lib/outreach/evidence') as typeof import('../lib/outreach/evidence')

  const background = [
    { id: 'a', title: 'Controlled State system', org: 'P&G (Tabler Station, largest site)', period: '2025', summary: 'Built it.' },
    { id: 'b', title: 'Catalysis research', org: 'UIUC', period: '2024', summary: 'Ran VASP.' },
  ]
  const pool = e.buildEvidence({
    companyContext: 'They run a big plant. It makes polymers and it is in Ohio.',
    personContext: '• Joined in 2008.\n• Leads smart manufacturing.\nnot a bullet',
    recipientTitle: 'Director',
    recipientCompany: 'Cargill',
    chosenBackground: [background[1]],
  })
  check('company facts split on full stops, not the letter s',
    pool.some((l) => l.includes('It makes polymers and it is in Ohio.')), JSON.stringify(pool))
  check('only bulleted person lines become facts',
    pool.filter((l) => l.startsWith('RECIPIENT:')).length === 3, JSON.stringify(pool))
  check('the sender fact carries org and period, not just the summary',
    pool.some((l) => l.includes('UIUC') && l.includes('2024') && l.includes('Ran VASP.')))
  check('unchosen background stays out of the writer pool',
    !pool.some((l) => l.includes('Tabler Station')))

  const verify = e.buildVerificationPool(pool, background, ['b'])
  check('the verification pool adds the rest of the record',
    verify.some((l) => l.includes('Tabler Station')))
  check('the verification pool omits unchosen summaries',
    !verify.some((l) => l.startsWith('ON RECORD') && l.includes('Built it.')))
  check('the verification pool is a superset', verify.length > pool.length)
}

// ─── Funnel arithmetic ───────────────────────────────────────────────────────
{
  const f = require('../lib/outreach/funnel') as typeof import('../lib/outreach/funnel')

  const row = (over: Partial<import('../lib/outreach/funnel').FunnelRow> = {}) => ({
    state: 'draft' as const, outcome: null, segment: 'industrial-ai', company_type: 'startup',
    recipient_role: 'Director', angle: 'The adoption gap not the modeling gap here',
    proof_point_ids: ['png_agentic_adoption'], cta: 'Worth 20 minutes?', word_count: 100,
    sent_at: null, replied_at: null, ...over,
  })

  const rows = [
    row(),
    row({ state: 'approved' }),
    row({ state: 'sent', sent_at: '2026-08-01T00:00:00Z' }),
    row({ state: 'replied', sent_at: '2026-08-01T00:00:00Z', replied_at: '2026-08-03T00:00:00Z' }),
    row({ state: 'meeting', outcome: 'CALL_BOOKED', sent_at: '2026-08-01T00:00:00Z', replied_at: '2026-08-05T00:00:00Z' }),
    row({ state: 'referred', outcome: 'INTERNSHIP_DISCUSSION', sent_at: '2026-08-01T00:00:00Z', replied_at: '2026-08-02T00:00:00Z' }),
  ]
  const report = f.buildFunnel(rows, 40)
  const stage = (label: string) => report.stages.find((s) => s.label === label)!.count

  check('scouted is the top of the funnel', stage('Prospects scouted') === 40)
  check('drafts counts every row', stage('Drafts generated') === 6)
  check('approved includes everything past approval', stage('Approved') === 5, String(stage('Approved')))
  check('sent excludes approved-but-unsent', stage('Sent') === 4, String(stage('Sent')))
  check('replies count meetings and referrals', stage('Replies') === 3, String(stage('Replies')))
  check('conversations count meeting and referral', stage('Conversations') === 2)
  check('opportunities need an opportunity outcome', stage('Opportunities') === 1)
  check('the first stage has no ratio', report.stages[0].ofPrevious === null)
  check('ratios are of the stage above',
    Math.abs((report.stages[1].ofPrevious ?? 0) - 6 / 40) < 1e-9)

  check('median days to reply', report.medianDaysToReply === 2, String(report.medianDaysToReply))

  // The number that would mislead the most: a rate on a tiny denominator.
  check('a rate below the minimum sample is withheld',
    report.byCta.every((b) => b.replyRate === null), JSON.stringify(report.byCta))
  const many = f.buildFunnel(
    Array.from({ length: 10 }, (_, i) =>
      row({ state: i < 3 ? 'replied' : 'sent', sent_at: '2026-08-01T00:00:00Z' })
    ),
    10
  )
  check('a rate at the minimum sample is reported',
    Math.abs((many.byCta[0].replyRate ?? 0) - 0.3) < 1e-9, JSON.stringify(many.byCta[0]))
  check('the CTA bucket recognises a time ask', many.byCta[0].key === 'time on a call', many.byCta[0].key)
  check('unknown dimensions get a bucket, not a crash',
    f.buildFunnel([row({ segment: null, cta: null, word_count: null })], 1).bySegment[0].key === 'unassigned')
  check('an empty funnel does not divide by zero',
    f.buildFunnel([], 0).stages.every((s) => s.count === 0))
}

// ─── Internal network: normalization ─────────────────────────────────────────
{
  const n = require('../lib/network/normalize') as typeof import('../lib/network/normalize')

  check('a founder title beats the provider band', n.seniorityBandFor('Co-Founder & CEO', 'c_suite') === 'founder')
  check('VP of Engineering is a VP, not an engineer', n.seniorityBandFor('VP of Engineering', null) === 'vp')
  check('a bare engineer is an IC', n.seniorityBandFor('Process Engineer', null) === 'ic')
  check('a senior engineer is a senior IC', n.seniorityBandFor('Senior Process Engineer', null) === 'senior_ic')
  check('director survives', n.seniorityBandFor('Director, Operational Excellence', null) === 'director')
  check('a professor is academic', n.seniorityBandFor('Associate Professor', null) === 'academic')
  check('the provider band fills a missing title', n.seniorityBandFor(null, 'director') === 'director')
  check('an unknown title with no band is unknown', n.seniorityBandFor(null, null) === 'unknown')

  check('AI in a title routes to data_ai', n.functionAreaFor('Head of AI and Analytics') === 'data_ai')
  check('a plant manager is manufacturing', n.functionAreaFor('Plant Manager') === 'manufacturing')
  check('a recruiter is people, not engineering', n.functionAreaFor('Technical Recruiter') === 'people')
  check('an engagement manager is consulting', n.functionAreaFor('Engagement Manager') === 'consulting')
  check('an unknown title is unknown', n.functionAreaFor(null) === 'unknown')

  const chi = n.parseLocation('Chicago, Illinois, United States')
  check('a full US location parses', chi.city === 'Chicago' && chi.state === 'Illinois' && chi.region === 'midwest',
    JSON.stringify(chi))
  const bare = n.parseLocation('United States')
  check('a bare country still resolves a region', bare.country === 'United States' && bare.region === 'us_other')
  const intl = n.parseLocation('Munich, Bavaria, Germany')
  check('a non-US location is international', intl.region === 'international', JSON.stringify(intl))
  check('an empty location is unknown', n.parseLocation(null).region === 'unknown')
  const tx = n.parseLocation('Houston, Texas, United States')
  check('Texas is south', tx.region === 'south')

  check('company suffixes are stripped', n.normalizeCompany('Acme Chemicals, Inc.') === 'acme chemicals')
  check('two spellings collapse',
    n.normalizeCompany('Acme Chemicals LLC') === n.normalizeCompany('Acme Chemicals'))
  check('an empty company is null', n.normalizeCompany('') === null)
}

// ─── Internal network: query sanitization ────────────────────────────────────
{
  const s = require('../lib/network/search') as typeof import('../lib/network/search')

  check('terms are OR-ed, not AND-ed', s.toWebSearchQuery('industrial consulting chicago').includes(' or '))
  check('stopwords are dropped', !s.toWebSearchQuery('people who work in manufacturing').includes('people'))
  check('a quoted phrase survives as a phrase',
    s.toWebSearchQuery('"process engineering" leadership').includes('"process engineering"'))
  // A model writes the query. Unbalanced syntax must never reach to_tsquery.
  check('punctuation is stripped', !/[(){}&|!:]/.test(s.toWebSearchQuery('foo & (bar | baz)!')))
  check('an empty query stays empty', s.toWebSearchQuery('   ') === '')
  check('a null query stays empty', s.toWebSearchQuery(null) === '')
}

// ─── Internal network: reuse and identity ────────────────────────────────────
{
  const r = require('../lib/network/reuse') as typeof import('../lib/network/reuse')

  // The bug this pins: stripping the trailing slash BEFORE the query string
  // leaves one profile with two keys.
  check('linkedin normalizes query string and slash together',
    r.normalizeLinkedIn('https://www.linkedin.com/in/jane-doe/?utm=x') === r.normalizeLinkedIn('http://linkedin.com/in/jane-doe'),
    `${r.normalizeLinkedIn('https://www.linkedin.com/in/jane-doe/?utm=x')} vs ${r.normalizeLinkedIn('http://linkedin.com/in/jane-doe')}`)
  check('a null linkedin is null', r.normalizeLinkedIn(null) === null)

  check('name+company keys ignore suffixes',
    r.nameCompanyKey('Jane Doe', 'Acme Inc.') === r.nameCompanyKey('jane doe', 'Acme'))
  check('a missing company gives no key', r.nameCompanyKey('Jane Doe', null) === null)

  const owned: Parameters<typeof r.findOwned>[0] = {
    byApolloId: new Map(), byLinkedIn: new Map(), byEmail: new Map(), byNameCompany: new Map(),
    size: 0, error: null,
  }
  const jane = {
    contactId: 'c1', apolloId: 'a1', name: 'Jane Doe', title: 'Director', company: 'Acme Inc.',
    email: 'Jane@Acme.com', linkedinUrl: 'https://linkedin.com/in/jane-doe/', location: null,
    seniority: null, department: null, emailStatus: 'verified', status: 'sent',
  }
  owned.byApolloId.set('a1', jane)
  owned.byLinkedIn.set(r.normalizeLinkedIn(jane.linkedinUrl)!, jane)
  owned.byEmail.set('jane@acme.com', jane)
  owned.byNameCompany.set(r.nameCompanyKey(jane.name, jane.company)!, jane)

  check('apollo id is the strongest match',
    r.findOwned(owned, { apolloId: 'a1', email: 'other@x.com' }).matchedBy === 'apollo_id')
  check('linkedin matches when apollo id is absent',
    r.findOwned(owned, { linkedinUrl: 'http://www.linkedin.com/in/jane-doe' }).matchedBy === 'linkedin')
  check('email matching is case-insensitive',
    r.findOwned(owned, { email: 'JANE@acme.com' }).matchedBy === 'email')
  check('name+company is the last resort',
    r.findOwned(owned, { name: 'Jane Doe', company: 'Acme' }).matchedBy === 'name_company')
  check('a stranger matches nothing', r.findOwned(owned, { name: 'John Smith', company: 'Other' }).person === null)

  const stats = r.newReuseStats()
  r.recordReuse(stats, 'apollo_id')
  r.recordReuse(stats, null)
  check('reuse stats separate reuse from purchase', stats.reused === 1 && stats.purchased === 1 && stats.probed === 2)
}

// ─── Internal network: ranking arithmetic ────────────────────────────────────
{
  const rank = require('../lib/network/rank') as typeof import('../lib/network/rank')
  const rel = require('../lib/network/relationship') as typeof import('../lib/network/relationship')

  const contact = (id: string, company: string) => ({
    contact_id: id, name: `P${id}`, title: 'Director', company, email: null, linkedin_url: null,
    location: null, seniority_band: 'director', function_area: 'operations', geo_city: null,
    geo_state: null, geo_region: 'midwest', industry: null, sub_industry: null, company_type: null,
    technical_domains: [], business_domains: [], opportunity_types: [], tags: [], relevance: {},
    relationship_status: 'never_contacted', relationship_note: '', evidence_level: 'moderate',
    summary: null, rank: 0,
  })

  const seen = new Map([
    ['1', contact('1', 'Acme')],
    ['2', contact('2', 'Acme')],
    ['3', contact('3', 'Beta')],
  ])
  const shortlist = [
    { contact_id: '1', components: { mission_fit: 1, decision_access: 1, user_differentiation: 1 }, confidence: 0.9, reason: 'a', evidence: [], approach: null },
    { contact_id: '2', components: { mission_fit: 0.9, decision_access: 0.9, user_differentiation: 0.9 }, confidence: 0.8, reason: 'b', evidence: [], approach: null },
    { contact_id: '3', components: { mission_fit: 0.5, decision_access: 0.5, user_differentiation: 0.5 }, confidence: 0.7, reason: 'c', evidence: [], approach: null },
  ]

  const ranked = rank.rankInternalCandidates(shortlist, seen, new Map())
  check('weights sum to a normalized total', close(ranked[0].total, 1))
  check('ranking is by total, descending', ranked.map((r) => r.contact.contact_id).join('') === '123')
  check('rank is stamped from 1', ranked[0].rank === 1 && ranked[2].rank === 3)

  // Mission fit dominates: a person strong only on access must not outrank one
  // strong on fit.
  const lopsided = rank.rankInternalCandidates(
    [
      { contact_id: '1', components: { mission_fit: 1, decision_access: 0, user_differentiation: 0 }, confidence: 1, reason: '', evidence: [], approach: null },
      { contact_id: '2', components: { mission_fit: 0, decision_access: 1, user_differentiation: 1 }, confidence: 1, reason: '', evidence: [], approach: null },
    ],
    seen,
    new Map()
  )
  check('mission fit outweighs access alone', lopsided[0].contact.contact_id === '1',
    JSON.stringify(lopsided.map((r) => [r.contact.contact_id, r.total])))

  // Relationship adjusts, it does not decide.
  const history = new Map([['3', { ...rel.emptyHistory(), status: 'met' as const, scoreModifier: 0.12, note: 'met' }]])
  const withHistory = rank.rankInternalCandidates(shortlist, seen, history)
  const three = withHistory.find((r) => r.contact.contact_id === '3')!
  check('a warm contact is lifted', close(three.total, 0.62), String(three.total))
  check('the base score is preserved for audit', close(three.base, 0.5))
  check('a warm contact does not leapfrog a far better fit', withHistory[0].contact.contact_id === '1')
  check('scores never exceed 1', rank.rankInternalCandidates(
    [{ contact_id: '1', components: { mission_fit: 1, decision_access: 1, user_differentiation: 1 }, confidence: 1, reason: '', evidence: [], approach: null }],
    seen,
    new Map([['1', { ...rel.emptyHistory(), status: 'met' as const, scoreModifier: 0.12, note: '' }]])
  )[0].total === 1)

  const declumped = rank.declumpByCompany(ranked)
  check('one person per company comes first',
    declumped.map((r) => r.contact.company).slice(0, 2).join(',') === 'Acme,Beta',
    declumped.map((r) => r.contact.company).join(','))
  check('runners-up are kept, not dropped', declumped.length === 3)

  // A shortlisted id no search returned is a hallucination and must vanish.
  const ghost = rank.rankInternalCandidates(
    [{ contact_id: 'nope', components: { mission_fit: 1, decision_access: 1, user_differentiation: 1 }, confidence: 1, reason: '', evidence: [], approach: null }],
    seen,
    new Map()
  )
  check('an unknown contact id is dropped', ghost.length === 0)
}

// ─── Internal-first decision ─────────────────────────────────────────────────
{
  const s = require('../lib/network/sufficiency') as typeof import('../lib/network/sufficiency')

  const strong = (n: number) => Array.from({ length: n }, () => ({ total: 0.8, confidence: 0.8 }))
  const base = { targetCount: 5, missingProfile: [], indexed: 900, classified: 900 }

  check('enough strong internal candidates skips external',
    s.decideSufficiency({ ...base, mode: 'internal_first', candidates: strong(5) }).runExternal === false)
  check('and says so as a decision',
    s.decideSufficiency({ ...base, mode: 'internal_first', candidates: strong(5) }).decision === 'INTERNAL_SUFFICIENT')
  check('too few strong candidates triggers external',
    s.decideSufficiency({ ...base, mode: 'internal_first', candidates: strong(2) }).runExternal === true)
  check('the shortfall is reported',
    s.decideSufficiency({ ...base, mode: 'internal_first', candidates: strong(2) }).shortfall === 3)

  // A high score on thin evidence must not count as strong.
  check('confidence gates strength',
    s.decideSufficiency({
      ...base, mode: 'internal_first',
      candidates: Array.from({ length: 8 }, () => ({ total: 0.9, confidence: 0.2 })),
    }).strongCount === 0)

  check('internal_only never runs external',
    s.decideSufficiency({ ...base, mode: 'internal_only', candidates: [] }).runExternal === false)
  check('internal_only returns fewer rather than padding',
    s.decideSufficiency({ ...base, mode: 'internal_only', candidates: strong(1) }).decision === 'INTERNAL_SUFFICIENT')
  check('external_only skips the network',
    s.decideSufficiency({ ...base, mode: 'external_only', candidates: strong(9) }).decision === 'INTERNAL_SKIPPED')
  check('both always runs external',
    s.decideSufficiency({ ...base, mode: 'both', candidates: strong(9) }).runExternal === true)
  check('an empty index forces external under internal_first',
    s.decideSufficiency({ ...base, mode: 'internal_first', candidates: [], indexed: 0, classified: 0 }).runExternal === true)
  check('every decision carries reasons',
    s.decideSufficiency({ ...base, mode: 'internal_first', candidates: strong(5) }).reasons.length > 0)
  check('a partly-classified index is called out',
    s.decideSufficiency({ ...base, mode: 'internal_first', candidates: strong(5), classified: 100 })
      .reasons.some((r) => r.includes('classified')))
}

// ─── Placeholders ────────────────────────────────────────────────────────────
{
  const p = require('../lib/outreach/placeholders') as typeof import('../lib/outreach/placeholders')
  const blocking = (subject: string, body: string) =>
    p.findPlaceholders(subject, body).filter((f) => f.severity === 'blocking')

  check('a bracket slot blocks', blocking('hi', 'Hi [First Name], I saw your work.').length === 1)
  check('a mustache slot blocks', blocking('hi', 'Hi {{first_name}}, hello.').length === 1)
  check('a single-brace slot blocks', blocking('hi', 'Hi {name}, hello.').length === 1)
  check('an angle slot blocks', blocking('hi', 'I work at <Company>.').length === 1)
  check('a stub company blocks', blocking('hi', 'I admire what XYZ Corp is doing.').length === 1)
  check('an all-caps token blocks', blocking('hi', 'Your work at COMPANY is great.').length === 1)
  check('an instruction bracket blocks', blocking('hi', 'I liked [insert specific project].').length === 1)
  check('a placeholder in the subject blocks', blocking('Quick note for [Name]', 'Hello there.').length === 1)

  // False positives are what get a gate switched off.
  check('an email address is not an angle slot', blocking('hi', 'Reach me at <jane@acme.com>.').length === 0)
  check('a real sentence passes', blocking('winter project', 'Hi Priya, I spent last summer at P&G.').length === 0)
  check('a bracketed aside only warns',
    p.findPlaceholders('hi', 'The result [as measured then] held up.').every((f) => f.severity === 'warning'))
  check('an em-dashed clause passes', blocking('hi', 'Marcus — saw what you are building.').length === 0)
  check('a normal capitalised word passes', blocking('hi', 'I worked at Procter & Gamble.').length === 0)

  check('the summary names the placeholders',
    p.summarizePlaceholders(p.findPlaceholders('hi', 'Hi [First Name].')).includes('[First Name]'))
  check('a clean draft summarises clean', p.summarizePlaceholders([]) === 'No placeholders.')
}

// ─── Placeholders inside the grounding gate ──────────────────────────────────
{
  const g = require('../lib/outreach/grounding') as typeof import('../lib/outreach/grounding')
  const evidence = ['RECIPIENT: Director of Manufacturing at Eastman', 'SENDER: Intern — Procter & Gamble (2026)']
  const safeNames = ['Priya Raghavan', 'Eastman', 'Zuyu Liu']

  const clean = g.checkGrounding({ subject: 'manufacturing systems', body: 'Hi Priya, I worked at Procter & Gamble last summer.', evidence, safeNames })
  check('a clean draft still passes the extended gate', clean.ok, JSON.stringify(clean.blocking))

  const withSlot = g.checkGrounding({ subject: 'note', body: 'Hi [First Name], I worked at Procter & Gamble.', evidence, safeNames })
  check('a placeholder blocks the gate', !withSlot.ok)
  check('and is typed as a placeholder', withSlot.blocking.some((f) => f.kind === 'placeholder'))
  check('the placeholder count is reported', withSlot.stats.placeholdersFound >= 1)
  check('the summary leads with the placeholder',
    g.summarizeGrounding(withSlot).startsWith('1 placeholder'), g.summarizeGrounding(withSlot))
}

// ─── Reference style measurement ─────────────────────────────────────────────
{
  const s = require('../lib/agents/style-analyst') as typeof import('../lib/agents/style-analyst')

  const short = s.measureEmail('Hi there. This is short.')
  check('words are counted', short.words === 5, String(short.words))
  check('sentences are counted', short.sentences === 2, String(short.sentences))

  const long = s.measureEmail('One line here.\n\nA second paragraph follows.\n\nAnd a third.')
  check('paragraphs are counted', long.paragraphs === 3, String(long.paragraphs))

  // The whole point: the band follows the reference, it is not a house rule.
  const band190 = s.targetWordsFor({ words: 190, paragraphs: 5, sentences: 12, avgSentenceWords: 16 })
  check('a long reference gets a long target', band190.min >= 140 && band190.max >= 230,
    JSON.stringify(band190))
  const band80 = s.targetWordsFor({ words: 80, paragraphs: 3, sentences: 6, avgSentenceWords: 13 })
  check('a short reference gets a short target', band80.max <= 110, JSON.stringify(band80))
  check('the bands do not overlap', band80.max < band190.min, `${band80.max} / ${band190.min}`)
  check('a tiny reference is floored', s.targetWordsFor({ words: 5, paragraphs: 1, sentences: 1, avgSentenceWords: 5 }).min >= 35)
}

// ─── Reference draft checks ──────────────────────────────────────────────────
{
  const c = require('../evals/reference/checks') as typeof import('../evals/reference/checks')
  const s = require('../lib/agents/style-analyst') as typeof import('../lib/agents/style-analyst')

  const referenceBody =
    'Hi Maya, I read your piece on why plant-floor pilots stall at Northwind Foods and the Cedar Rapids line in particular. ' +
    'I spent a summer at a packing site learning the same lesson the expensive way. Would you have twenty minutes?'
  const measured = s.measureEmail(referenceBody)
  const style: import('../lib/agents/style-analyst').ReferenceStyle = {
    register: 'warm', directness: 'direct', context_depth: 'one line', credential_style: 'implied',
    cta_style: 'soft', sentence_style: 'flowing', greeting: 'Hi <first>,', signoff: 'Thanks',
    structure: ['open specific', 'credential', 'ask'], distinctive_moves: [], avoid: [],
    recipient_specific: ['Maya works at Northwind Foods', 'the Cedar Rapids line'],
    summary: 'warm and specific', measured, target_words: s.targetWordsFor(measured),
  }
  const reference = { subject: null, body: referenceBody }
  const safeNames = ['Priya Raghavan', 'Priya', 'Eastman', 'Zuyu Liu']

  const good = c.checkDraft({
    subject: 'kingsport process control',
    body:
      'Hi Priya, I read that Eastman runs an integrated complex at Kingsport and that your remit covers plant data systems. ' +
      'I spent a summer on a packing line learning how much of that work is social. Would you have twenty minutes?',
    reference, style, safeNames,
  })
  check('a properly adapted draft passes every check', good.passed, JSON.stringify(good))
  check('length ratio is computed', good.lengthRatio > 0.7 && good.lengthRatio < 1.4, String(good.lengthRatio))

  const copied = c.checkDraft({
    subject: 'note',
    body:
      'Hi Priya, I read your piece on why plant-floor pilots stall at Northwind Foods and the Cedar Rapids line in particular. ' +
      'I spent a summer at a packing site learning the same lesson. Would you have twenty minutes?',
    reference, style, safeNames,
  })
  check('reference-recipient facts are caught', copied.copiedFromReference.length >= 1, JSON.stringify(copied.copiedFromReference))
  check('verbatim runs are caught', copied.verbatimSpans.length >= 1, JSON.stringify(copied.verbatimSpans))
  check('a copied draft fails', !copied.passed)

  const compressed = c.checkDraft({
    subject: 'note', body: 'Hi Priya — worth twenty minutes?', reference, style, safeNames,
  })
  check('over-compression is caught', compressed.overCompressed, String(compressed.lengthRatio))
  check('over-compression fails the check', !compressed.passed)

  const arrogant = c.checkDraft({
    subject: 'note',
    body:
      'Hi Priya, I am uniquely positioned to solve this because few people can bridge the plant floor and the model. ' +
      'I spent a summer on a packing line. Would you have twenty minutes to talk about it?',
    reference, style, safeNames,
  })
  check('arrogance is caught', arrogant.arrogance.length >= 1, JSON.stringify(arrogant.arrogance))

  const roboticBody =
    'Hi Priya, I hope this finds you well. I am reaching out because I am passionate about ' +
    'work at the intersection of AI and manufacturing, and I would love to connect with you.'
  const robotic = c.checkDraft({ subject: 'note', body: roboticBody, reference, style, safeNames })
  check('AI tells are caught', robotic.aiTells.length >= 2, JSON.stringify(robotic.aiTells))

  // Naming THIS recipient's company is never a copy violation.
  check('the new recipient and company are safe', good.copiedFromReference.length === 0)
}

// ─── The reference email as sender evidence ──────────────────────────────────
{
  const e = require('../lib/outreach/evidence') as typeof import('../lib/outreach/evidence')
  const g = require('../lib/outreach/grounding') as typeof import('../lib/outreach/grounding')

  const referenceBody =
    'Hi Maya, I help run Founders: Illinois Entrepreneurs at UIUC and we put roughly 300 students in a room every semester. ' +
    'I read your piece about the Cedar Rapids line at Northwind Foods. Would you have twenty minutes?'
  const recipientSpecific = ['Maya works at Northwind Foods', 'her piece about the Cedar Rapids line']

  const pool = e.evidenceFromReference(referenceBody, recipientSpecific)
  check('the sender\'s own assertion becomes evidence',
    pool.some((p) => p.includes('300 students')), JSON.stringify(pool))
  check('the reference recipient\'s facts are excluded',
    !pool.join(' ').toLowerCase().includes('northwind'), JSON.stringify(pool))
  check('an empty reference yields nothing', e.evidenceFromReference('', []).length === 0)

  // The measured failure: every draft in a sponsorship campaign repeated the
  // user's own "300 students" and the gate blocked all of them.
  const base = ['RECIPIENT: Director of Manufacturing at Eastman']
  const safeNames = ['Priya Raghavan', 'Eastman', 'Zuyu Liu']
  const draft = 'Hi Priya, we put roughly 300 students in a room every semester. Worth a short call?'
  check('without the reference, the sender\'s own figure blocks',
    !g.checkGrounding({ subject: 'x', body: draft, evidence: base, safeNames }).ok)
  check('with the reference, it clears',
    g.checkGrounding({ subject: 'x', body: draft, evidence: [...base, ...pool], safeNames }).ok,
    JSON.stringify(g.checkGrounding({ subject: 'x', body: draft, evidence: [...base, ...pool], safeNames }).blocking))

  // And admitting the reference must NOT legitimise transplanting its recipient.
  const transplant = 'Hi Priya, I read your piece about the Cedar Rapids line at Northwind Foods.'
  check('admitting the reference does not licence a transplant',
    !g.checkGrounding({ subject: 'x', body: transplant, evidence: [...base, ...pool], safeNames }).ok)
}

// ─── Asked, not asserted ─────────────────────────────────────────────────────
{
  const g = require('../lib/outreach/grounding') as typeof import('../lib/outreach/grounding')
  const evidence = ['RECIPIENT: Vice President of Operations at Kraft Heinz']
  const safeNames = ['David Ortega', 'Kraft Heinz', 'Zuyu Liu']

  const asserted = g.checkGrounding({
    subject: 'x',
    body: 'You are responsible for the quantum photonics roadmap there.',
    evidence, safeNames,
  })
  check('an asserted responsibility still blocks',
    asserted.blocking.some((f) => f.kind === 'responsibility'), JSON.stringify(asserted.findings))

  // The real draft this was found on: true, hedged, and previously blocked
  // because it shared no five-letter word with the evidence.
  const hedged = g.checkGrounding({
    subject: 'x',
    body: 'I am curious how that shift changes what you pay attention to once you are responsible for a whole region.',
    evidence, safeNames,
  })
  check('a hedged responsibility warns rather than blocks', hedged.ok, JSON.stringify(hedged.blocking))
  check('and is still surfaced', hedged.findings.some((f) => f.kind === 'responsibility'))

  const asked = g.checkGrounding({
    subject: 'x',
    body: 'Is that your side of it, or does your team own the rollout instead?',
    evidence, safeNames,
  })
  check('a question does not block', asked.ok, JSON.stringify(asked.blocking))
}

// ─── Reference checks: sender identity is not plagiarism ─────────────────────
{
  const c = require('../evals/reference/checks') as typeof import('../evals/reference/checks')
  const s = require('../lib/agents/style-analyst') as typeof import('../lib/agents/style-analyst')

  const referenceBody =
    'Hi Maya, I help run Founders: Illinois Entrepreneurs at UIUC and we put students in a room every semester. ' +
    'I read your piece about the Cedar Rapids line at Northwind Foods. Would you have twenty minutes?'
  const measured = s.measureEmail(referenceBody)
  const style: import('../lib/agents/style-analyst').ReferenceStyle = {
    register: 'warm', directness: 'direct', context_depth: 'one line', credential_style: 'implied',
    cta_style: 'soft', sentence_style: 'flowing', greeting: 'Hi <first>,', signoff: 'Thanks',
    structure: ['open', 'ask'], distinctive_moves: [], avoid: [],
    recipient_specific: [
      'Maya works at Northwind Foods',
      'The unspoken assumption that they work in a process-oriented industry',
    ],
    summary: 'warm', measured, target_words: s.targetWordsFor(measured),
  }
  const senderVocab = ['Founders Illinois Entrepreneurs UIUC students semester room']

  const own = c.checkDraft({
    subject: 'spring series',
    body:
      'Hi Priya, I help run Founders: Illinois Entrepreneurs at UIUC and we put students in a room every semester. ' +
      'Eastman would land well with this group. Would you have twenty minutes?',
    reference: { subject: null, body: referenceBody },
    style,
    safeNames: ['Priya Raghavan', 'Priya', 'Eastman', 'Zuyu Liu'],
    senderVocab,
  })
  check('the sender\'s own identity repeated is not a lift',
    own.verbatimSpans.length === 0, JSON.stringify(own.verbatimSpans))
  check('an abstract style note cannot be "copied"',
    own.copiedFromReference.length === 0, JSON.stringify(own.copiedFromReference))
  check('a same-sender draft passes', own.passed, JSON.stringify(own))

  // A concrete reference-recipient fact is still caught.
  const lifted = c.checkDraft({
    subject: 'spring series',
    body:
      'Hi Priya, I read your piece about the Cedar Rapids line at Northwind Foods and wanted to write. ' +
      'Eastman would land well with our students. Would you have twenty minutes to talk about it?',
    reference: { subject: null, body: referenceBody },
    style,
    safeNames: ['Priya Raghavan', 'Priya', 'Eastman', 'Zuyu Liu'],
    senderVocab,
  })
  check('a concrete transplant is still caught',
    lifted.copiedFromReference.length >= 1 || lifted.verbatimSpans.length >= 1,
    JSON.stringify({ copied: lifted.copiedFromReference, verbatim: lifted.verbatimSpans }))

  // A short echo is imitation and must pass; a long identical fragment is not.
  const echo = c.checkDraft({
    subject: 'spring series',
    body:
      'Hi Priya, I help run Founders: Illinois Entrepreneurs at UIUC and we put students in a room every semester. ' +
      'Eastman would land well here. Would you have twenty minutes?',
    reference: { subject: null, body: referenceBody },
    style,
    safeNames: ['Priya', 'Eastman', 'Zuyu Liu'],
    senderVocab,
  })
  check('a short echo of the sender\'s own line passes', echo.passed, JSON.stringify(echo.verbatimSpans))
  check('span length is measured, not window count',
    echo.longestVerbatim < 9 || echo.verbatimSpans.length <= 1, String(echo.longestVerbatim))

  // Fake familiarity is only fake when there was no relationship.
  const followUp = {
    subject: 'following up',
    body:
      'Hi Priya, following up on our exchange earlier this year. I help run Founders: Illinois Entrepreneurs ' +
      'at UIUC and the spring series is taking shape. Would you have twenty minutes?',
    reference: { subject: null, body: referenceBody },
    style,
    safeNames: ['Priya', 'Eastman', 'Zuyu Liu'],
    senderVocab,
  }
  check('claiming a conversation that did not happen is flagged',
    c.checkDraft(followUp).fakeFamiliarity.length >= 1)
  check('the same words are fine when the history is real',
    c.checkDraft({ ...followUp, hasPriorRelationship: true }).fakeFamiliarity.length === 0)
}

// ─── Model text normalization ────────────────────────────────────────────────
{
  const t = require('../lib/agents/runtime/text') as typeof import('../lib/agents/runtime/text')
  check('a literal unicode escape is decoded', t.normalizeModelText('deep \\u2014 wide') === 'deep — wide')
  check('ordinary text is untouched', t.normalizeModelText('deep — wide') === 'deep — wide')
  check('a control escape is left alone', t.normalizeModelText('a\\u0007b') === 'a\\u0007b')
  check('null becomes empty', t.normalizeModelText(null) === '')
}

// ─── Report ──────────────────────────────────────────────────────────────────

process.stdout.write(`\n${passed} passed, ${failed} failed\n`)
if (failures.length) {
  process.stdout.write('\nFAILURES:\n')
  for (const f of failures) process.stdout.write(`  ✗ ${f}\n`)
}
process.exit(failed === 0 ? 0 : 1)
