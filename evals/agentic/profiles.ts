// The five evaluation profiles for the agentic scouting phase.
//
// A profile is a MISSION FRAMING, not a search. It supplies the goal and the
// constraints; the Mission Strategist generates its own market hypotheses from
// there, and the Market Discovery agent refines or kills them. Nothing here
// names a company or a person — that would be the overfitting the eval exists
// to detect.

export interface EvalProfile {
  id: string
  name: string
  goal: string
  timeframe: string
  geography: string
  constraints: string[]
  /** How many segments the strategist should cut this profile into. */
  segmentCount: number
}

const TIMEFRAME =
  'Winter 2026-27 (December 2026 - January 2027) for an internship or short-term project, ' +
  'with the same relationships also relevant to summer 2027 recruiting'

const BASE_CONSTRAINTS = [
  'undergraduate student, so the ask is an internship, a short project, advice, or a referral',
  'must be a person who could plausibly reply to a well-written cold email',
]

export const EVAL_PROFILES: EvalProfile[] = [
  {
    id: 'industrial-ai-startups',
    name: 'Industrial AI startups',
    goal:
      'Find people at industrial AI startups — companies building AI or machine learning products ' +
      'for manufacturing, process industries, energy, or heavy industry — who could realistically ' +
      'lead to a strong winter 2026-27 internship or short-term project, and who would also matter ' +
      'for summer 2027 recruiting.',
    timeframe: TIMEFRAME,
    geography: 'United States',
    constraints: [
      ...BASE_CONSTRAINTS,
      'venture-backed or early-stage companies where a founder or functional lead can create a role',
    ],
    segmentCount: 3,
  },
  {
    id: 'chemical-manufacturing-innovation',
    name: 'Chemical / manufacturing corporate innovation',
    goal:
      'Find people leading digital transformation, advanced manufacturing, process technology, or ' +
      'innovation groups inside established chemical, materials, and manufacturing companies, who ' +
      'could realistically lead to a strong winter 2026-27 internship or short-term project and who ' +
      'would also matter for summer 2027 recruiting.',
    timeframe: TIMEFRAME,
    geography: 'United States',
    constraints: [
      ...BASE_CONSTRAINTS,
      'established operators, not software vendors selling into them',
      'the target owns a function; at a very large company that is a director or senior manager, not the C-suite',
    ],
    segmentCount: 3,
  },
  {
    id: 'operations-industrial-consulting',
    name: 'Operations / industrial consulting',
    goal:
      'Find partners, principals, and practice leaders at consulting firms whose work is operations, ' +
      'manufacturing performance, supply chain, or industrial transformation, who could realistically ' +
      'lead to a strong winter 2026-27 project or internship and who would also matter for summer 2027 ' +
      'recruiting.',
    timeframe: TIMEFRAME,
    geography: 'United States',
    constraints: [
      ...BASE_CONSTRAINTS,
      'the practice must genuinely serve industrial, chemical, energy or manufacturing clients',
      'boutique and specialist firms count and are often better targets than the largest brands',
    ],
    segmentCount: 3,
  },
  {
    id: 'enterprise-ai-industrial',
    name: 'Enterprise AI with industrial relevance',
    goal:
      'Find people at enterprise AI and enterprise software companies whose products are actually ' +
      'deployed in industrial, manufacturing, or process-industry settings, who could realistically ' +
      'lead to a strong winter 2026-27 internship or short-term project and who would also matter for ' +
      'summer 2027 recruiting.',
    timeframe: TIMEFRAME,
    geography: 'United States',
    constraints: [
      ...BASE_CONSTRAINTS,
      'industrial deployment must be real, not a vertical listed on a marketing page',
      'prefer people who own industrial solutions, deployment, or applied AI over generic platform roles',
    ],
    segmentCount: 3,
  },
  {
    id: 'technically-ambitious-startups',
    name: 'Technically ambitious startups',
    goal:
      'Find founders and technical leaders at technically ambitious startups — deep tech, materials, ' +
      'energy, climate, robotics, biomanufacturing, or hard-science companies — where a combination of ' +
      'chemical engineering, applied AI, and entrepreneurial experience is unusually differentiated, ' +
      'who could realistically lead to a strong winter 2026-27 internship or project and who would also ' +
      'matter for summer 2027 recruiting.',
    timeframe: TIMEFRAME,
    geography: 'United States',
    constraints: [
      ...BASE_CONSTRAINTS,
      'small enough that a founder or technical lead answers their own email and can create a role',
      'the technical problem should be genuinely hard, not a consumer app with a technical veneer',
    ],
    segmentCount: 3,
  },
]

export function profileById(id: string): EvalProfile | undefined {
  return EVAL_PROFILES.find((p) => p.id === id)
}
