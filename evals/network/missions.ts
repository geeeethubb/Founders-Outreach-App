// Five missions for the internal-retrieval eval.
//
// Chosen to test the property that matters: the SAME 897 contacts must produce
// five different shortlists. A retrieval layer that returns roughly the same
// twenty senior industrial names whatever it is asked has learned to rank
// prestige, not relevance — and that failure is invisible when you only ever
// evaluate one mission.
//
// Two of them (startup founders, mentors) deliberately point away from the
// database's centre of mass, which is chemicals, CPG and industrial AI. If the
// system cannot say "the network is thin here" it will pad, and padding is what
// makes external discovery get skipped when it should have run.

export interface NetworkEvalMission {
  key: string
  label: string
  goal: string
  timeframe: string
  geography: string
  constraints: string[]
  /** How many strong internal candidates would make external discovery unnecessary. */
  targetCount: number
}

export const NETWORK_EVAL_MISSIONS: NetworkEvalMission[] = [
  {
    key: 'consulting',
    label: 'Summer 2027 industrial / engineering consulting',
    goal:
      'Find people in my existing network who are relevant to summer 2027 recruiting for an ' +
      'engineering or industrial consulting role — operations consulting, manufacturing ' +
      'transformation, process improvement, or the industrial practice of a professional ' +
      'services firm.',
    timeframe: 'Summer 2027',
    geography: 'United States, Chicago preferred',
    constraints: [
      'undergraduate student, so the ask is an internship, a short project, advice, or a referral',
      'must be a person who could plausibly reply to a well-written email',
    ],
    targetCount: 10,
  },
  {
    key: 'industrial_ai',
    label: 'Industrial AI / manufacturing',
    goal:
      'Find people in my existing network working on AI applied inside industrial and ' +
      'manufacturing operations — plant-floor analytics, predictive maintenance, process ' +
      'optimisation, MES/data platforms, or corporate AI adoption in a manufacturing company.',
    timeframe: 'Winter 2026-27',
    geography: 'United States',
    constraints: [
      'undergraduate student, so the ask is an internship, a short project, advice, or a referral',
    ],
    targetCount: 10,
  },
  {
    key: 'chem_energy',
    label: 'Chemical / energy industry',
    goal:
      'Find people in my existing network in the chemical, materials, or energy industries — ' +
      'process engineering, R&D, plant operations, or technology leadership at a chemicals, ' +
      'materials or energy company.',
    timeframe: 'Winter 2026-27',
    geography: 'United States',
    constraints: [
      'undergraduate chemical engineering student, so the ask is an internship, a project, or advice',
    ],
    targetCount: 10,
  },
  {
    key: 'founders',
    label: 'Startup founders',
    goal:
      'Find founders and very early operators in my existing network — people running a ' +
      'startup who could offer a hands-on project, an internship, or a real conversation ' +
      'about building.',
    timeframe: 'Winter 2026-27',
    geography: 'United States',
    constraints: ['the ask is a project, an internship, or a conversation about their company'],
    targetCount: 8,
  },
  {
    key: 'mentors',
    label: 'Professional mentors',
    goal:
      'Find people in my existing network who would make good professional mentors — senior ' +
      'operators or leaders who have walked a path from engineering into industry leadership, ' +
      'and would plausibly give an undergraduate half an hour of career advice.',
    timeframe: 'Ongoing',
    geography: 'United States',
    constraints: ['the ask is 20-30 minutes of career advice, not a job'],
    targetCount: 8,
  },
]
