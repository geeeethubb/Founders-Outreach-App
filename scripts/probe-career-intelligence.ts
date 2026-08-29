// LIVE probe for the Career OS intelligence agents. Costs money; env-gated.
//
//   npx tsx scripts/probe-career-intelligence.ts
//
// Runs ONE realistic chain — Company Researcher → Fit Evaluator → Evidence
// Matcher — on an inline Summer 2027 process-engineering internship, with
// evidence synthesized in memory from the eval fixture (one experience per
// RESUME_ITEM, one fact = its summary), then the Network Pathfinder on a stub
// slate. Nothing is persisted. Every agent call carries cacheKeyParts, so a
// second run is free.

import { config } from 'dotenv'
import path from 'path'
config({ path: path.join(process.cwd(), '.env.local') })

import { RESUME_ITEMS } from '../evals/phase3/user-profile'
import type { EvidenceBank, EvidenceExperience, EvidenceFact, EvidenceSkill } from '../lib/career/types'
import type { ToolContext } from '../lib/agents/runtime/types'

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set — this probe makes live model calls and will not run without it.')
  process.exit(2)
}

const COMPANY = { name: 'Dow', domain: 'dow.com', careers_url: 'https://corporate.dow.com/en-us/careers.html' }

const JD = `Process Engineering Intern — Summer 2027 (Freeport, TX)

Dow's Texas Operations site is the largest integrated chemical manufacturing complex in the Western Hemisphere. As a Process Engineering Intern you will be embedded with a production unit team and own a scoped improvement project over 12 weeks.

What you will do
- Analyze unit performance data (DCS historian, LIMS) to identify throughput, yield or reliability losses
- Lead a root-cause investigation with operations and maintenance and propose an engineered fix
- Support process safety reviews (PHA/HAZOP) and Management of Change documentation
- Build or improve a monitoring tool — Excel, Python or Seeq — that operators actually use
- Present results to site leadership at the end of the term

Minimum qualifications
- Currently pursuing a bachelor's degree in Chemical, Mechanical or Industrial Engineering
- Graduating between December 2027 and June 2029
- Available for a full-time 12-week internship starting May or June 2027
- Legally authorized to work in the United States without sponsorship now or in the future

Preferred qualifications
- Prior internship or co-op in a manufacturing or plant environment
- Experience with process data tools (Seeq, PI, Aspen) or scripting (Python, MATLAB)
- Exposure to Lean, Six Sigma or a structured problem-solving method
- Familiarity with process safety management

Housing stipend and relocation assistance provided. Applications reviewed on a rolling basis; interviews begin October 2026.`

function bankFromFixture(): EvidenceBank {
  const experiences: EvidenceExperience[] = []
  const facts: EvidenceFact[] = []
  const skills: EvidenceSkill[] = []
  const now = '2026-08-27T00:00:00Z'
  const skillNames = new Set<string>()
  RESUME_ITEMS.forEach((item, i) => {
    const eid = `exp-${item.id}`
    const fid = `fact-${item.id}`
    experiences.push({
      id: eid, user_id: 'probe', kind: item.kind === 'award' ? 'award' : item.kind === 'education' ? 'education' : item.kind,
      organization: item.org, title: item.title, start_date: item.period.split('–')[0]?.trim() ?? null,
      end_date: item.period.split('–')[1]?.trim() ?? null, location: null, description: null, display_order: i,
      source: 'master_resume', approved: true, created_at: now, updated_at: now,
    })
    facts.push({
      id: fid, user_id: 'probe', experience_id: eid, statement: item.summary, category: 'achievement',
      source: 'master_resume', source_location: item.id, confidence: 0.95, approved: true, created_at: now, updated_at: now,
    })
    for (const d of item.domains) {
      if (skillNames.has(d)) continue
      skillNames.add(d)
      skills.push({ id: `skill-${skills.length + 1}`, user_id: 'probe', name: d, category: 'domain', evidence_fact_ids: [fid], approved: true, created_at: now })
    }
  })
  return { experiences, facts, metrics: [], deliverables: [], skills, stories: [], preferences: [], bullets: [], organizations: [], sources: [], factSources: [], projects: [], masterDocument: null }
}

async function main() {
  const { runCompanyResearcher } = await import('../lib/agents/company-researcher')
  const { runFitEvaluator } = await import('../lib/agents/fit-evaluator')
  const { runEvidenceMatcher } = await import('../lib/agents/evidence-matcher')
  const { runNetworkPathfinder } = await import('../lib/agents/network-pathfinder')
  const { renderCompanyResearchForPrompt, groundedPoints } = await import('../lib/career/research/company')
  const { evaluateFit } = await import('../lib/career/fit/evaluate')
  const { renderExperienceSummaries, renderExperienceDetail, renderSkills, renderStories, renderPreferences } = await import('../lib/career/evidence/render')
  const { renderMission, defaultMission } = await import('../lib/career/missions/store')
  const { setAnthropicBudget, anthropicUsage } = await import('../lib/providers/anthropic/client')

  // A CALL budget, not dollars: four agents, up to three steps each, plus escalation headroom.
  setAnthropicBudget(Number(process.env.PROBE_ANTHROPIC_BUDGET ?? 20))

  const ctx: ToolContext = {
    user_id: 'probe',
    run_id: null,
    budget: { maxCompanies: 1, maxPeoplePerCompany: 1, maxApolloCalls: 0, maxWebSearches: 5, maxAgentSteps: 8 },
  }
  const onStep = (label: string) => (i: { step: number; elapsedMs: number; stopReason: string | null; toolCalls: string[] }) =>
    console.log(`  [${label}] step ${i.step} ${i.elapsedMs}ms stop=${i.stopReason} tools=${i.toolCalls.join(',') || '-'}`)

  const mission = defaultMission('probe')
  const bank = bankFromFixture()
  const job = {
    title: 'Process Engineering Intern — Summer 2027',
    company: COMPANY.name,
    location_raw: 'Freeport, TX',
    location_tier: 3,
    work_mode: 'onsite',
    employment_type: 'internship',
    season_relevance: 'summer_2027',
    posted_at: '2026-08-15',
    deadline: null,
    description_excerpt: JD.slice(0, 3000),
    min_qualifications: [
      "Pursuing a bachelor's in Chemical, Mechanical or Industrial Engineering",
      'Graduating between December 2027 and June 2029',
      'Available full-time for 12 weeks from May/June 2027',
      'Authorized to work in the US without sponsorship',
    ],
    preferred_qualifications: [
      'Prior manufacturing/plant internship', 'Seeq, PI, Aspen, Python or MATLAB',
      'Lean / Six Sigma exposure', 'Process safety management familiarity',
    ],
    graduation_eligibility: 'December 2027 – June 2029',
    work_authorization: 'US work authorization without sponsorship',
    skills: ['Python', 'Seeq', 'PI historian', 'HAZOP', 'root cause analysis'],
    responsibilities: ['analyze unit performance data', 'lead a root-cause investigation', 'support PHA/HAZOP', 'build a monitoring tool'],
    industry: 'chemicals',
    company_size_stage: 'corporate, ~36,000 employees',
  }

  const costs: Record<string, number> = {}
  const cost = (label: string, c: number, cached: boolean | undefined) => {
    costs[label] = c
    console.log(`  cost $${c.toFixed(4)}${cached ? ' (from cache)' : ''}`)
  }

  // ─── 1. Company Researcher ───
  console.log(`\n=== COMPANY RESEARCHER: ${COMPANY.name}`)
  const research = await runCompanyResearcher(
    {
      company: { ...COMPANY, what_we_know: 'Largest integrated chemical manufacturing complex in the Western Hemisphere (from the posting).' },
      job_title: job.title,
      mission_interests: `${mission.preferences.optimize_for.join(' > ')} · ${mission.preferences.company_types.join(', ')}`,
      depth: 'standard',
    },
    ctx,
    { onStep: onStep('research') }
  )
  cost('research', research.trace.cost_usd, research.trace.from_cache)
  console.log(`  status=${research.status} searches=${research.trace.web_searches} error=${research.error ?? '-'}`)
  const r = research.output
  if (r) {
    const facts = r.claims.filter((c) => c.type === 'FACT').length
    console.log(`  claims=${r.claims.length} facts=${facts} downgraded=${r.downgraded_claims} points=${r.why_interesting_for_intern.length} grounded=${groundedPoints(r).length} ungrounded=${r.ungrounded_points}`)
    console.log(`  type=${r.company_type} tags=${r.industry_tags.join(', ')}`)
    console.log(`  SUMMARY: ${r.summary}`)
    for (const p of r.why_interesting_for_intern) console.log(`   ${p.grounded ? '●' : '○'} ${p.point}`)
    console.log(`  UNCERTAINTIES: ${r.uncertainties.join(' | ')}`)
  }

  // ─── 2. Fit Evaluator ───
  console.log(`\n=== FIT EVALUATOR`)
  const fit = await runFitEvaluator(
    {
      mission: renderMission(mission),
      job,
      companyResearch: renderCompanyResearchForPrompt(r),
      evidenceSummaries: renderExperienceSummaries(bank),
      preferences: renderPreferences(bank),
      feedbackContext: [],
    },
    ctx,
    { cacheKeyParts: { probe: 'career-intelligence', job: job.title, company: COMPANY.name, research: r?.summary ?? null }, onStep: onStep('fit') }
  )
  cost('fit', fit.trace.cost_usd, fit.trace.from_cache)
  console.log(`  status=${fit.status} error=${fit.error ?? '-'}`)
  const j = fit.output
  if (j) {
    const ev = evaluateFit({ judgment: j, weights: mission.fit_weights, feedbackAdjustment: 0 })
    console.log(`  OVERALL ${ev.overall} (${ev.band}) · eligibility=${j.eligibility} · confidence=${j.confidence}`)
    for (const c of j.components) console.log(`   ${c.dimension.padEnd(22)} ${c.score.toFixed(2)}  ${c.explanation}`)
    console.log(`  ELIGIBILITY: ${j.eligibility_reasoning}`)
    console.log(`  EXPLANATION: ${j.explanation}`)
    console.log(`  UNCERTAINTIES: ${j.uncertainties.join(' | ')}`)
    console.log(`  RED FLAGS: ${j.red_flags.join(' | ') || '-'}`)
    console.log(`  MISSING: ${j.missing_qualifications.join(' | ') || '-'}`)
  }

  // ─── 3. Evidence Matcher ───
  console.log(`\n=== EVIDENCE MATCHER`)
  const top = bank.experiences.slice(0, 4).map((e) => e.id)
  const validIds = {
    experience_ids: bank.experiences.map((e) => e.id),
    fact_ids: bank.facts.map((f) => f.id),
    metric_ids: bank.metrics.map((m) => m.id),
    skill_ids: bank.skills.map((s) => s.id),
    story_ids: bank.stories.map((s) => s.id),
  }
  const match = await runEvidenceMatcher(
    {
      job,
      evidenceSummaries: renderExperienceSummaries(bank),
      detail: top.map((id) => renderExperienceDetail(bank, id)).join('\n\n'),
      skills: renderSkills(bank),
      stories: renderStories(bank),
      validIds,
    },
    ctx,
    { cacheKeyParts: { probe: 'career-intelligence', job: job.title, company: COMPANY.name, facts: validIds.fact_ids.length }, onStep: onStep('match') }
  )
  cost('match', match.trace.cost_usd, match.trace.from_cache)
  console.log(`  status=${match.status} error=${match.error ?? '-'}`)
  const m = match.output
  if (m) {
    console.log(`  top=${m.top_experience_ids.join(', ')} facts=${m.fact_ids.length} skills=${m.skill_ids.length} ungrounded=${m.ungrounded_ids}`)
    console.log(`  WHY I FIT: ${m.why_i_fit}`)
    console.log(`  DIFFERENTIATOR: ${m.best_differentiator}`)
    console.log(`  EMPHASIZE: ${m.emphasize.join(' | ')}`)
    console.log(`  GAPS: ${m.gaps.join(' | ')}`)
    console.log(`  DO NOT CLAIM: ${m.do_not_claim.join(' | ') || `(none — ${m.no_gaps_reason})`}`)
  }

  // ─── 4. Network Pathfinder on a stub slate ───
  console.log(`\n=== NETWORK PATHFINDER (stub slate)`)
  const slate = [
    { contact_id: '00000000-0000-0000-0000-000000000001', name: 'Priya Raman', title: 'Senior Process Engineer', company: 'Dow', location: 'Freeport, TX', relationship_status: 'never_contacted', relationship_note: 'No prior contact.', index_tags: ['UIUC alumni', 'chemical engineering', 'process safety'], summary: 'ChemE, UIUC 2019. Six years at Dow Texas Operations on ethylene unit reliability.', retrieval_basis: ['company_match', 'alumni_signal'] },
    { contact_id: '00000000-0000-0000-0000-000000000002', name: 'Marcus Lee', title: 'Plant Manager', company: 'Dow', location: 'Midland, MI', relationship_status: 'replied_positive', relationship_note: 'Replied positively before (last touch 2026-03-12). Reference the earlier exchange.', index_tags: ['manufacturing', 'plant management'], summary: 'Runs a Dow specialty materials site; exchanged two emails about AI adoption on the floor.', retrieval_basis: ['company_match', 'prior_outreach'] },
    { contact_id: '00000000-0000-0000-0000-000000000003', name: 'Elena Fischer', title: 'Marketing Director', company: 'Dow Jones', location: 'New York, NY', relationship_status: 'never_contacted', relationship_note: 'No prior contact.', index_tags: ['media', 'marketing'], summary: 'Financial media marketing.', retrieval_basis: ['index_search'] },
    { contact_id: '00000000-0000-0000-0000-000000000004', name: 'Tom Nguyen', title: 'Operations Consultant', company: 'Accenture', location: 'Chicago, IL', relationship_status: 'contacted_no_reply', relationship_note: 'Emailed 2 times with no reply (last touch 2026-05-02). Do not resend the same approach.', index_tags: ['consulting', 'operations'], summary: 'Former Dow process engineer, now consulting; profile mentions Dow Freeport.', retrieval_basis: ['index_search'] },
  ]
  const paths = await runNetworkPathfinder(
    { company: { name: 'Dow', domain: 'dow.com', industry: 'chemicals' }, job_title: job.title, candidates: slate },
    ctx,
    { cacheKeyParts: { probe: 'career-intelligence', slate: slate.map((s) => s.contact_id) }, onStep: onStep('paths') }
  )
  cost('paths', paths.trace.cost_usd, paths.trace.from_cache)
  console.log(`  status=${paths.status} error=${paths.error ?? '-'}`)
  if (paths.output) {
    for (const p of paths.output.paths) {
      const who = slate.find((s) => s.contact_id === p.contact_id)?.name
      console.log(`   ${who?.padEnd(14)} ${p.relationship.padEnd(17)} ${p.strength.toFixed(2)}  ${p.suggested_action}  — ${p.why_relevant}`)
    }
    console.log(`  stripped=${paths.output.stripped_ids} NOTE: ${paths.output.note}`)
  }

  const total = Object.values(costs).reduce((s, c) => s + c, 0)
  const usage = anthropicUsage()
  console.log(`\nTOTAL this run: $${total.toFixed(4)} · session usage $${usage.costUsd.toFixed(4)} across ${usage.calls} calls`)
  const failed = [research, fit, match, paths].filter((x) => x.status !== 'succeeded').length
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
