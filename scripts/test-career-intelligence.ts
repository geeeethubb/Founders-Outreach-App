// Offline tests for the Career OS intelligence layer: validators, fit
// arithmetic and the feedback modifier. No network, no keys.
//
//   npx tsx scripts/test-career-intelligence.ts
//
// Validators are tested with fake model outputs because what matters is what
// they REJECT and what they STRIP — the model's actual prose is an eval's
// concern, not a unit test's.

import { validateFitJudgment } from '../lib/agents/fit-evaluator'
import { makeEvidenceMatchValidator } from '../lib/agents/evidence-matcher'
import { validateCompanyResearch } from '../lib/agents/company-researcher'
import { makePathfinderValidator } from '../lib/agents/network-pathfinder'
import { evaluateFit, buildFitEvaluationRow, fitGates, redFlagsWithGates, GATE_FLAG_PREFIX, HARD_CONSTRAINT_CAP, ROLE_FIT_FLOOR, NOT_QUALIFIED_FACTOR, HARD_CONSTRAINT_FACTOR } from '../lib/career/fit/evaluate'
import { DEFAULT_FIT_WEIGHTS } from '../lib/career/fit/dimensions'
import { computeFeedbackAdjustment, renderFeedbackHints, type FeedbackRow } from '../lib/career/fit/feedback'
import { groundedPoints, renderCompanyResearchForPrompt, researchClaimsToFactRows } from '../lib/career/research/company'
import { FIT_DIMENSIONS } from '../lib/career/types'

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
const close = (a: number, b: number, tol = 0.0011) => Math.abs(a - b) < tol

// ─── Fit Evaluator validator ─────────────────────────────────────────────────
{
  const components = FIT_DIMENSIONS.map((d, i) => ({
    dimension: d,
    score: 0.5 + i * 0.04,
    explanation: `because ${d}`,
    evidence: ['q1', 'q2', 'q3'],
  }))
  const good = {
    components,
    eligibility: 'stretch',
    eligibility_reasoning: 'missing preferred CAD',
    explanation: 'What it is. Why care. Why fit.',
    uncertainties: ['work auth'],
    red_flags: [],
    missing_qualifications: ['SolidWorks'],
    confidence: 1.4,
  }
  const v = validateFitJudgment(good)
  check('fit: full output accepted', v !== null)
  check('fit: eligibility upper-cased to enum', v?.eligibility === 'STRETCH')
  check('fit: confidence clamped', v?.confidence === 1)
  check('fit: evidence capped at 2', v?.components[0].evidence.length === 2)
  check('fit: components ordered as FIT_DIMENSIONS', v?.components.map((c) => c.dimension).join() === FIT_DIMENSIONS.join())

  check('fit: missing dimension → null', validateFitJudgment({ ...good, components: components.slice(1) }) === null)
  check('fit: duplicate dimension → null', validateFitJudgment({ ...good, components: [...components, components[0]] }) === null)
  check('fit: unknown dimension → null', validateFitJudgment({ ...good, components: [...components.slice(1), { ...components[0], dimension: 'vibes' }] }) === null)
  check('fit: bad eligibility → null', validateFitJudgment({ ...good, eligibility: 'MAYBE' }) === null)
  check('fit: empty explanation → null', validateFitJudgment({ ...good, explanation: '  ' }) === null)
  check('fit: non-numeric score → null', validateFitJudgment({ ...good, components: [{ ...components[0], score: 'high' }, ...components.slice(1)] }) === null)

  // ─── arithmetic ───
  const ev = evaluateFit({ judgment: v!, weights: null, feedbackAdjustment: 0 })
  const expected = FIT_DIMENSIONS.reduce((s, d, i) => s + (0.5 + i * 0.04) * DEFAULT_FIT_WEIGHTS[d], 0)
  check('evaluateFit: default weights give the weighted mean', close(ev.overall, expected), `${ev.overall} vs ${expected}`)
  check('evaluateFit: band derives from the number', ev.band === (ev.overall >= 0.62 ? 'GOOD' : 'MAYBE'))

  const only = evaluateFit({ judgment: v!, weights: { role_fit: 1, learning_upside: 0, ownership: 0, company_quality: 0, mission_interest_fit: 0, location_fit: 0, career_optionality: 0, people_mentorship: 0, differentiation: 0, application_urgency: 0 }, feedbackAdjustment: 0 })
  check('evaluateFit: single-dimension override isolates that score', close(only.overall, 0.5))
  check('evaluateFit: weights_used is normalized', close(FIT_DIMENSIONS.reduce((s, d) => s + only.weights_used[d], 0), 1))

  const adj = evaluateFit({ judgment: v!, weights: null, feedbackAdjustment: -0.25 })
  check('evaluateFit: adjustment applied after the mean', close(adj.overall, Math.max(0, expected - 0.25)))
  check('evaluateFit: base_overall preserved', close(adj.base_overall, expected))
  const floor = evaluateFit({ judgment: v!, weights: null, feedbackAdjustment: -5 })
  check('evaluateFit: clamped at 0', floor.overall === 0)
  const ceil = evaluateFit({ judgment: v!, weights: null, feedbackAdjustment: 5 })
  check('evaluateFit: clamped at 1', ceil.overall === 1)

  const row = buildFitEvaluationRow({ userId: 'u', jobId: 'j', missionId: null, judgment: v!, evaluation: adj, promptVersion: '1.0.0', agentRunId: null })
  check('row: carries overall + adjustment', row.overall === adj.overall && row.feedback_adjustment === -0.25)
  check('row: eligibility copied', row.eligibility === 'STRETCH' && row.missing_qualifications[0] === 'SolidWorks')
  check('row: confidence rounded to 2dp', row.confidence === 1)
}

// ─── Fit gates (wave-2 regressions) ──────────────────────────────────────────
// The eval evidence behind each: a NOT_QUALIFIED Summer 2026 decoy ranked 4th;
// a QUALIFIED verdict on the same decoy still beat a real STRETCH job until the
// WEAK cap; eight software interns at role_fit 0.12–0.25 reached the top 20 on
// location and company alone.
{
  const flat = (roleFit: number) => FIT_DIMENSIONS.map((d) => ({ dimension: d, score: d === 'role_fit' ? roleFit : 0.7, explanation: `because ${d}`, evidence: ['q1'] }))
  const judgment = (eligibility: string, roleFit = 0.7, red_flags: string[] = []) =>
    validateFitJudgment({ components: flat(roleFit), eligibility, eligibility_reasoning: 'r', explanation: 'e', uncertainties: [], red_flags, missing_qualifications: [], confidence: 0.9 })!

  const plain = evaluateFit({ judgment: judgment('QUALIFIED'), weights: null })
  check('gates: QUALIFIED with no failures leaves the mean untouched', close(plain.overall, 0.7) && close(plain.base_overall, 0.7) && plain.gates.length === 0, `${plain.overall} ${plain.gates}`)

  const nq = evaluateFit({ judgment: judgment('NOT_QUALIFIED'), weights: null })
  check('gates: NOT_QUALIFIED halves the ungated mean', close(nq.overall, 0.7 * NOT_QUALIFIED_FACTOR) && close(nq.base_overall, 0.7) && nq.gates.join() === 'NOT_QUALIFIED', `${nq.overall}`)

  const hc = evaluateFit({ judgment: judgment('QUALIFIED'), weights: null, hardConstraintFailures: ['Not a different season'] })
  check('gates: a hard-constraint failure ×0.6 then capped at 0.30, label recorded', hc.overall === HARD_CONSTRAINT_CAP && hc.band === 'WEAK' && hc.gates.includes('Not a different season'), `${hc.overall} ${hc.gates}`)
  const g = fitGates('QUALIFIED', ['Not a different season'], flat(0.7))
  check('fitGates: factor 0.6 and cap 0.30 for one failure', close(g.factor, HARD_CONSTRAINT_FACTOR) && g.cap === HARD_CONSTRAINT_CAP)
  const low = evaluateFit({ judgment: judgment('QUALIFIED'), weights: null, hardConstraintFailures: ['United States'] })
  check('gates: below the cap the factor alone applies', close(low.overall, Math.min(HARD_CONSTRAINT_CAP, 0.7 * HARD_CONSTRAINT_FACTOR)))

  const rf = evaluateFit({ judgment: judgment('QUALIFIED', 0.15), weights: null })
  check('gates: role_fit 0.15 scales the mean by 0.15/0.35', close(rf.overall, rf.base_overall * (0.15 / ROLE_FIT_FLOOR)) && rf.gates.some((x) => x.startsWith('role_fit 0.15')), `${rf.overall} vs ${rf.base_overall * (0.15 / ROLE_FIT_FLOOR)}`)
  check('gates: role_fit at the floor is not gated', evaluateFit({ judgment: judgment('QUALIFIED', ROLE_FIT_FLOOR), weights: null }).gates.length === 0)

  const fb = evaluateFit({ judgment: judgment('NOT_QUALIFIED'), weights: null, feedbackAdjustment: 0.06 })
  check('gates: feedback adjustment applies after the gate', close(fb.overall, 0.7 * NOT_QUALIFIED_FACTOR + 0.06), `${fb.overall}`)
  const fbCap = evaluateFit({ judgment: judgment('QUALIFIED'), weights: null, feedbackAdjustment: 0.06, hardConstraintFailures: ['Internships only'] })
  check('gates: feedback cannot lift a hard-constraint failure past the cap', fbCap.overall === HARD_CONSTRAINT_CAP)

  // Persisting the reason: job_fit_evaluations has no gates column; the UI renders red_flags.
  check('redFlagsWithGates: prefixed, appended, never duplicated', redFlagsWithGates(['visa sponsorship unclear', 'capped: NOT_QUALIFIED'], ['NOT_QUALIFIED', 'United States']).join('|') === 'visa sponsorship unclear|capped: NOT_QUALIFIED|capped: United States')
  check('redFlagsWithGates: stale gate entries are replaced, not stacked', redFlagsWithGates(['capped: old'], ['new']).join('|') === `${GATE_FLAG_PREFIX}new`)
  check('redFlagsWithGates: no gates leaves the flags alone', redFlagsWithGates(['x'], []).join('|') === 'x')
  const j = judgment('QUALIFIED', 0.7, ['visa sponsorship unclear'])
  const row = buildFitEvaluationRow({ userId: 'u', jobId: 'j', missionId: null, judgment: j, evaluation: hc, promptVersion: '1.0.0', agentRunId: null })
  check('row: gate reasons folded into red_flags after the evaluator\'s own', row.red_flags.join('|') === 'visa sponsorship unclear|capped: Not a different season', row.red_flags.join('|'))
  check('row: the judgment\'s red_flags are not mutated', j.red_flags.length === 1)
  const rowPlain = buildFitEvaluationRow({ userId: 'u', jobId: 'j', missionId: null, judgment: j, evaluation: plain, promptVersion: '1.0.0', agentRunId: null })
  check('row: no gates → no capped entries', rowPlain.red_flags.join('|') === 'visa sponsorship unclear')
}

// ─── Evidence Matcher validator ──────────────────────────────────────────────
{
  const validIds = { experience_ids: ['e1', 'e2'], fact_ids: ['f1', 'f2', 'f3'], metric_ids: ['m1'], skill_ids: ['s1'], story_ids: ['st1'] }
  const validate = makeEvidenceMatchValidator(validIds)
  const good = {
    why_i_fit: 'I built the thing.',
    top_experience_ids: ['e1', 'e9', 'e2', 'e1'],
    fact_ids: ['f1', 'f-invented', 'f3'],
    metric_ids: ['m1', 'm-invented'],
    skill_ids: ['s1'],
    story_ids: ['st1', 'st-invented', 'st1'],
    gaps: ['no CAD'],
    best_differentiator: 'AI on a plant floor',
    emphasize: ['controlled state'],
    do_not_claim: ['SolidWorks', 'Six Sigma certification'],
    no_gaps_reason: null,
  }
  const v = validate(good)
  check('matcher: accepted', v !== null)
  check('matcher: invented ids stripped', v?.fact_ids.join() === 'f1,f3' && v?.metric_ids.join() === 'm1' && v?.story_ids.join() === 'st1')
  check('matcher: invented ids counted', v?.ungrounded_ids === 4, String(v?.ungrounded_ids))
  check('matcher: experience ids deduped and in order', v?.top_experience_ids.join() === 'e1,e2')
  check('matcher: no real experience → null', validate({ ...good, top_experience_ids: ['e9'] }) === null)
  check('matcher: no real fact → null', validate({ ...good, fact_ids: ['nope'] }) === null)
  check('matcher: empty do_not_claim without reason → null', validate({ ...good, do_not_claim: [] }) === null)
  const ok = validate({ ...good, do_not_claim: [], no_gaps_reason: 'checked every listed skill against facts f1-f3' })
  check('matcher: empty do_not_claim with reason accepted', ok !== null && ok.no_gaps_reason !== null)
  check('matcher: reason dropped when prohibitions present', validate({ ...good, no_gaps_reason: 'x' })?.no_gaps_reason === null)
  check('matcher: fact_ids capped at 10', (validate({ ...good, fact_ids: Array(20).fill('f1').map((_, i) => (i % 3 === 0 ? 'f1' : i % 3 === 1 ? 'f2' : 'f3')) })?.fact_ids.length ?? 0) <= 10)
}

// ─── Company Researcher validator ────────────────────────────────────────────
{
  const evidence = [{ url: 'https://example.com/about', title: 'About', snippet: null }]
  const good = {
    what_they_do: 'Makes widgets.',
    company_type: 'industrial',
    industry_tags: ['manufacturing'],
    size_stage: '2,000 employees',
    why_interesting_for_intern: [
      { point: 'Runs a real plant', claim_refs: [0] },
      { point: 'Probably growing', claim_refs: [1] },
      { point: 'Cites a URL never retrieved', claim_refs: [2] },
      { point: 'Cites nothing', claim_refs: [] },
      { point: 'Cites out of range', claim_refs: [9] },
    ],
    technical_challenges: ['throughput'],
    recent_developments: [{ description: 'New line', date_approx: '2026-Q1', claim_ref: 0 }, { description: 'x', date_approx: null, claim_ref: 42 }],
    intern_program_signals: ['UNKNOWN — nothing published'],
    leadership: [{ name: 'A. Person', role: 'VP Ops', claim_ref: 0 }],
    claims: [
      { claim: 'Operates a plant in Ohio', type: 'FACT', source_url: 'https://example.com/about', source_title: 'About', confidence: 0.9 },
      { claim: 'Growing', type: 'INFERENCE', source_url: null, source_title: null, confidence: 0.5 },
      { claim: 'Raised $50M', type: 'FACT', source_url: 'https://never-visited.com/x', source_title: null, confidence: 0.8 },
    ],
    uncertainties: ['intern program'],
    summary: 'One. Two. Three. Four.',
  }
  const v = validateCompanyResearch(good, evidence)
  check('researcher: accepted', v !== null)
  check('researcher: point on a FACT is grounded', v?.why_interesting_for_intern[0].grounded === true)
  check('researcher: point on an INFERENCE is ungrounded', v?.why_interesting_for_intern[1].grounded === false)
  check('researcher: FACT with unretrieved URL downgraded', v?.claims[2].type === 'INFERENCE' && v?.downgraded_claims === 1)
  check('researcher: point on a downgraded FACT is ungrounded', v?.why_interesting_for_intern[2].grounded === false)
  check('researcher: point citing nothing is ungrounded', v?.why_interesting_for_intern[3].grounded === false)
  check('researcher: out-of-range ref dropped', v?.why_interesting_for_intern[4].claim_refs.length === 0)
  check('researcher: ungrounded points counted', v?.ungrounded_points === 4, String(v?.ungrounded_points))
  check('researcher: bad development ref → null ref', v?.recent_developments[1].claim_ref === null)
  check('researcher: unknown company_type → other', validateCompanyResearch({ ...good, company_type: 'unicorn' }, evidence)?.company_type === 'other')
  check('researcher: no points → null', validateCompanyResearch({ ...good, why_interesting_for_intern: [] }, evidence) === null)
  check('researcher: no summary → null', validateCompanyResearch({ ...good, summary: '' }, evidence) === null)

  // A blank claim must not shift the indexes of the claims after it.
  const shifted = validateCompanyResearch({ ...good, claims: [{ claim: '', type: 'FACT', source_url: null, confidence: 1 }, ...good.claims] }, evidence)
  check('researcher: blank claim keeps indexes aligned', shifted?.claims.length === 4 && shifted?.claims[1].type === 'FACT')

  const gp = groundedPoints(v!)
  check('groundedPoints: only grounded, with ids and urls', gp.length === 1 && gp[0].id === 'point:0' && gp[0].sourceUrls[0] === 'https://example.com/about')
  const rows = researchClaimsToFactRows(shifted!)
  check('factRows: placeholder dropped', rows.length === 3)
  const rendered = renderCompanyResearchForPrompt(v!)
  check('render: FACT line before INFERENCE line', rendered.indexOf('FACT: Operates') < rendered.indexOf('INFERENCE: Growing'))
  check('render: null → placeholder', renderCompanyResearchForPrompt(null) === '(no research yet)')
}

// ─── Network Pathfinder validator ────────────────────────────────────────────
{
  const slate = [
    { contact_id: 'c1', name: 'A', title: null, company: null, location: null, relationship_status: null, relationship_note: null, index_tags: [], summary: null, retrieval_basis: ['company_match'] },
    { contact_id: 'c2', name: 'B', title: null, company: null, location: null, relationship_status: null, relationship_note: null, index_tags: [], summary: null, retrieval_basis: ['index_search'] },
  ]
  const validate = makePathfinderValidator(slate)
  const good = {
    paths: [
      { contact_id: 'c1', relationship: 'current_employee', strength: 1.7, why_relevant: 'works there', suggested_action: 'ask for a referral', existing_history: null },
      { contact_id: 'ghost', relationship: 'alumni', strength: 0.5, why_relevant: 'x', suggested_action: 'y', existing_history: null },
      { contact_id: 'c1', relationship: 'alumni', strength: 0.5, why_relevant: 'dup', suggested_action: 'y', existing_history: null },
    ],
    note: 'Thin slate.',
  }
  const v = validate(good)
  check('pathfinder: accepted', v !== null)
  check('pathfinder: unknown contact stripped and counted', v?.paths.length === 1 && v?.stripped_ids === 1)
  check('pathfinder: strength clamped', v?.paths[0].strength === 1)
  check('pathfinder: bad relationship → null', validate({ ...good, paths: [{ ...good.paths[0], relationship: 'friend' }] }) === null)
  check('pathfinder: empty paths is valid', validate({ paths: [], note: 'Nobody.' })?.paths.length === 0)
  check('pathfinder: no note → null', validate({ paths: [], note: '' }) === null)
}

// ─── Feedback modifier ───────────────────────────────────────────────────────
{
  const job = { id: 'j1', role_family: 'software', industry: 'saas', company_name: 'BigCo', location_tier: 3, company_type: 'corporate' }
  const fb = (o: Partial<FeedbackRow>): FeedbackRow => ({
    job_id: 'other', verdict: 'NOT_INTERESTED', reasons: [], role_family: null, industry: null, company_name: null, location_tier: null, ...o,
  })

  check('feedback: none → 0', computeFeedbackAdjustment(job, []).adjustment === 0)
  check('feedback: direct NOT_INTERESTED → -0.25', computeFeedbackAdjustment(job, [fb({ job_id: 'j1' })]).adjustment === -0.25)
  check('feedback: direct LOVE → +0.12', computeFeedbackAdjustment(job, [fb({ job_id: 'j1', verdict: 'LOVE' })]).adjustment === 0.12)
  check('feedback: direct MAYBE → -0.05', computeFeedbackAdjustment(job, [fb({ job_id: 'j1', verdict: 'MAYBE' })]).adjustment === -0.05)
  check('feedback: direct INTERESTED → +0.06', computeFeedbackAdjustment(job, [fb({ job_id: 'j1', verdict: 'INTERESTED' })]).adjustment === 0.06)
  check('feedback: latest direct wins', computeFeedbackAdjustment(job, [fb({ job_id: 'j1' }), fb({ job_id: 'j1', verdict: 'LOVE' })]).adjustment === 0.12)
  // created_at, when present, decides "latest" — not array order.
  check('feedback: created_at decides latest, newest-first input', computeFeedbackAdjustment(job, [
    fb({ job_id: 'j1', verdict: 'LOVE', created_at: '2026-08-02T00:00:00Z' }),
    fb({ job_id: 'j1', verdict: 'NOT_INTERESTED', created_at: '2026-08-01T00:00:00Z' }),
  ]).adjustment === 0.12)
  check('feedback: hints newest first by created_at', renderFeedbackHints([
    fb({ verdict: 'LOVE', industry: 'saas', created_at: '2026-08-02T00:00:00Z' }),
    fb({ verdict: 'MAYBE', industry: 'saas', created_at: '2026-08-01T00:00:00Z' }),
  ])[0].startsWith('LOVE'))
  check('feedback: direct dominates aggregates', computeFeedbackAdjustment(job, [
    fb({ role_family: 'software', reasons: ['role'] }), fb({ role_family: 'software', reasons: ['role'] }), fb({ job_id: 'j1', verdict: 'LOVE' }),
  ]).adjustment === 0.12)

  // one NO is not a pattern
  check('feedback: one NOT_INTERESTED on the attribute → 0', computeFeedbackAdjustment(job, [fb({ role_family: 'software', reasons: ['role'] })]).adjustment === 0)
  // two with a matching reason are
  const two = computeFeedbackAdjustment(job, [fb({ role_family: 'software', reasons: ['too_software_heavy'] }), fb({ role_family: 'software', reasons: ['role'] })])
  check('feedback: two NOs citing role → -0.03', close(two.adjustment, -0.03) && two.reasons.length === 1)
  // reason must match the attribute
  check('feedback: NOs citing location do not hit role_family', computeFeedbackAdjustment(job, [fb({ role_family: 'software', reasons: ['location'] }), fb({ role_family: 'software', reasons: ['location'] })]).adjustment === 0)
  // company_type match via too_corporate
  check('feedback: too_corporate matches company_type', close(computeFeedbackAdjustment(job, [
    fb({ company_name: 'OtherCo', company_type: 'corporate', reasons: ['too_corporate'] }),
    fb({ company_name: 'ThirdCo', company_type: 'corporate', reasons: ['brand'] }),
  ]).adjustment, -0.03))
  // negative cap: four attributes × -0.03 = -0.12 → -0.10
  const allNo = [
    fb({ role_family: 'software', industry: 'saas', company_name: 'BigCo', location_tier: 3, reasons: ['role', 'industry', 'company', 'location'] }),
    fb({ role_family: 'software', industry: 'saas', company_name: 'BigCo', location_tier: 3, reasons: ['role', 'industry', 'company', 'location'] }),
  ]
  const capped = computeFeedbackAdjustment(job, allNo)
  check('feedback: negative capped at -0.10', close(capped.adjustment, -0.1), String(capped.adjustment))
  check('feedback: cap is explained', capped.reasons.some((r) => r.includes('capped')))
  // positive: +0.02 per matching attribute, cap +0.06
  const yes = fb({ verdict: 'LOVE', role_family: 'software', industry: 'saas', company_name: 'BigCo', location_tier: 3 })
  const pos = computeFeedbackAdjustment(job, [yes])
  check('feedback: positive capped at +0.06', close(pos.adjustment, 0.06), String(pos.adjustment))
  check('feedback: single positive attribute → +0.02', close(computeFeedbackAdjustment(job, [fb({ verdict: 'INTERESTED', industry: 'saas' })]).adjustment, 0.02))
  // mixed stays within bounds
  const mixed = computeFeedbackAdjustment(job, [...allNo, yes])
  check('feedback: mixed within [-0.25, 0.12]', mixed.adjustment >= -0.25 && mixed.adjustment <= 0.12 && close(mixed.adjustment, -0.04))
  // attribute matching is case-insensitive
  check('feedback: attribute match is case-insensitive', close(computeFeedbackAdjustment(job, [fb({ verdict: 'LOVE', industry: 'SaaS' })]).adjustment, 0.02))

  const hints = renderFeedbackHints([fb({ verdict: 'LOVE', company_name: 'X', reasons: ['growth'], note: 'great team' }), fb({ industry: 'saas', reasons: ['industry'] })])
  check('hints: newest first, rendered', hints.length === 2 && hints[0].startsWith('NOT_INTERESTED on saas') && hints[1].includes('"great team"'))
}

// ─── Report ──────────────────────────────────────────────────────────────────

process.stdout.write(`\n${passed} passed, ${failed} failed\n`)
if (failures.length) {
  process.stdout.write('\nFAILURES:\n')
  for (const f of failures) process.stdout.write(`  ✗ ${f}\n`)
}
process.exit(failed === 0 ? 0 : 1)
