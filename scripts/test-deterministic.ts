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

// ─── Report ──────────────────────────────────────────────────────────────────

process.stdout.write(`\n${passed} passed, ${failed} failed\n`)
if (failures.length) {
  process.stdout.write('\nFAILURES:\n')
  for (const f of failures) process.stdout.write(`  ✗ ${f}\n`)
}
process.exit(failed === 0 ? 0 : 1)
