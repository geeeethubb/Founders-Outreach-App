// The fixed Phase 3 eval mission and its five search profiles.
//
// Hand-authored stand-in for what the Mission Strategist agent will generate in
// Phase 4. Fixed on purpose: an eval must hold its inputs constant so a metric
// change is attributable to a code change rather than to the strategist
// rewording its own queries.
//
// ─── WHY THESE ARE PEOPLE-FIRST QUERIES (iteration 1 finding) ───────────────
// Company-first discovery via Apollo `mixed_companies/search` FAILED badly:
// `q_organization_keyword_tags` matches company NAMES lexically, so a search for
// "artificial intelligence + manufacturing" returned AI magazines, certification
// bodies, conference organizers and universities — almost no operating companies.
//
// Applying the same keyword tags at the PEOPLE search layer works, because the
// title filter anchors the query to real operating companies. "Director of
// Manufacturing" + keyword "chemicals" returns DuBois Chemicals and Sunburst
// Chemicals, not chemistry magazines. See docs/PHASE_3_EVAL.md §Iteration 1.

export const TEST_MISSION = {
  id: 'winter-2026-27',
  objective:
    'Find people who could realistically lead to a strong winter 2026–27 internship or short-term project, while also being relevant to longer-term summer 2027 recruiting.',
  priority_intersections: [
    'industrial AI',
    'manufacturing',
    'chemicals / chemical engineering',
    'energy / industrial technology',
    'enterprise AI',
    'consulting',
    'technically ambitious startups',
  ],
  company_types: ['startups', 'growth-stage', 'corporations', 'consulting firms', 'industrial companies'],
  target_person_profile:
    'Founders, executives at smaller companies, VPs, Heads of function, Directors, Partners, Principals, and highly relevant Senior Managers. NOT blindly the most senior person available.',
  ideal_contact_rule:
    'The ideal contact has BOTH (1) enough influence to create, shape, or refer into an opportunity, and (2) a plausible reason to find this specific background interesting.',
  timing: 'Winter window December 2026 – January 2027; summer window 2027.',
} as const

/** One Apollo people-search query. Titles anchor it; org keywords give context. */
export interface PeopleQuerySpec {
  titles: string[]
  seniorities: string[]
  /** Apollo org keyword tags — filters the company behind the person. */
  orgKeywords?: string[]
  employeeMin?: number
  employeeMax?: number
  locations?: string[]
  /** Pages to pull. More pages = more candidates, linearly more credits. */
  pages?: number
}

export interface SearchProfile {
  id: string
  label: string
  description: string
  /** What hypothesis this profile tests. */
  rationale: string
  queries: PeopleQuerySpec[]
  /** Company-size window used for post-hoc company filtering. */
  companySize: { min?: number; max?: number }
}

// Apollo `person_seniorities` vocabulary:
// owner, founder, c_suite, partner, vp, head, director, manager, senior, entry, intern
const FOUNDER_LED = ['founder', 'c_suite', 'owner', 'vp', 'head', 'director']
const OPERATING = ['vp', 'head', 'director']
const CONSULTING = ['partner', 'c_suite', 'vp', 'head', 'director']

const US = ['United States']

export const SEARCH_PROFILES: SearchProfile[] = [
  {
    id: 'industrial_ai_startups',
    label: 'Industrial AI startups',
    description: 'Startups applying AI to manufacturing, process industries and physical operations.',
    rationale:
      'Highest-fit segment: small enough that a founder answers their own email, and the P&G agentic-AI work is directly on-thesis.',
    // Iteration 2: keywords rebalanced toward PROCESS industries. Iteration 1
    // leaned on 'industrial automation' / 'predictive maintenance' / 'computer
    // vision', which surfaced discrete-manufacturing and generic Industry 4.0
    // startups the judge rejected as interchangeable. The user's edge is
    // chemical/process/quality, so the queries now target that first.
    companySize: { min: 10, max: 1000 },
    queries: [
      {
        titles: ['Founder', 'Co-Founder', 'Chief Executive Officer', 'Chief Technology Officer'],
        seniorities: FOUNDER_LED,
        orgKeywords: ['process manufacturing'],
        employeeMin: 11, employeeMax: 500, locations: US, pages: 2,
      },
      {
        titles: ['Founder', 'Co-Founder', 'Chief Executive Officer', 'Chief Technology Officer'],
        seniorities: FOUNDER_LED,
        orgKeywords: ['process control'],
        employeeMin: 11, employeeMax: 500, locations: US, pages: 2,
      },
      {
        titles: ['Founder', 'Co-Founder', 'Chief Technology Officer', 'Head of AI'],
        seniorities: FOUNDER_LED,
        orgKeywords: ['chemical manufacturing'],
        employeeMin: 11, employeeMax: 1000, locations: US, pages: 2,
      },
      {
        titles: ['Founder', 'Co-Founder', 'Chief Executive Officer', 'VP of Engineering'],
        seniorities: FOUNDER_LED,
        orgKeywords: ['quality management software'],
        employeeMin: 11, employeeMax: 500, locations: US, pages: 2,
      },
      {
        titles: ['Head of AI', 'VP of Engineering', 'Head of Product', 'VP of Product'],
        seniorities: OPERATING,
        orgKeywords: ['manufacturing software'],
        employeeMin: 11, employeeMax: 1000, locations: US, pages: 2,
      },
      {
        titles: ['Founder', 'Co-Founder', 'Chief Executive Officer', 'Chief Technology Officer'],
        seniorities: FOUNDER_LED,
        orgKeywords: ['industrial automation'],
        employeeMin: 11, employeeMax: 500, locations: US, pages: 1,
      },
      {
        titles: ['Founder', 'Chief Technology Officer', 'Head of Machine Learning'],
        seniorities: FOUNDER_LED,
        orgKeywords: ['laboratory informatics'],
        employeeMin: 11, employeeMax: 500, locations: US, pages: 1,
      },
    ],
  },
  {
    id: 'chem_mfg_corporate_innovation',
    label: 'Chemical / manufacturing corporate innovation',
    description: 'Innovation, digital and R&D leadership inside chemical and manufacturing corporations.',
    rationale:
      'Tests whether the system finds the operative decision layer (Director/Head of Digital Manufacturing) rather than unreachable C-suite at 40,000-person corporations.',
    companySize: { min: 200 },
    queries: [
      {
        titles: ['Head of Digital Manufacturing', 'Director of Digital Manufacturing', 'VP of Digital Manufacturing'],
        seniorities: OPERATING, locations: US, pages: 2,
      },
      {
        titles: ['Director of Innovation', 'Head of Innovation', 'VP of Innovation'],
        seniorities: OPERATING, orgKeywords: ['chemicals'],
        employeeMin: 200, locations: US, pages: 2,
      },
      {
        titles: ['Director of R&D', 'VP of R&D', 'Head of R&D'],
        seniorities: OPERATING, orgKeywords: ['specialty chemicals'],
        employeeMin: 200, locations: US, pages: 2,
      },
      {
        titles: ['Director of Manufacturing Technology', 'Head of Advanced Manufacturing', 'Director of Process Engineering'],
        seniorities: OPERATING, orgKeywords: ['manufacturing'],
        employeeMin: 500, locations: US, pages: 2,
      },
      {
        titles: ['Director of Digital Transformation', 'Head of Digital Transformation'],
        seniorities: OPERATING, orgKeywords: ['consumer packaged goods'],
        employeeMin: 500, locations: US, pages: 1,
      },
      {
        titles: ['Director of Operations', 'VP of Operations', 'Head of Operations'],
        seniorities: OPERATING, orgKeywords: ['chemicals'],
        employeeMin: 200, locations: US, pages: 1,
      },
    ],
  },
  {
    id: 'industrial_consulting',
    label: 'Operations / industrial consulting',
    description: 'Consulting firms with operations, manufacturing and industrial practices.',
    rationale:
      'Directly leverages the Illinois Business Consulting M&A and Big Four agentic workflow experience; Partners and Principals control staffing.',
    companySize: { min: 20 },
    queries: [
      {
        titles: ['Partner', 'Principal', 'Managing Director'],
        seniorities: CONSULTING, orgKeywords: ['management consulting'],
        employeeMin: 51, locations: US, pages: 2,
      },
      {
        titles: ['Partner', 'Principal', 'Practice Leader'],
        seniorities: CONSULTING, orgKeywords: ['operations consulting'],
        employeeMin: 20, locations: US, pages: 2,
      },
      {
        titles: ['Partner', 'Principal', 'Managing Director', 'Director'],
        seniorities: CONSULTING, orgKeywords: ['supply chain consulting'],
        employeeMin: 20, locations: US, pages: 2,
      },
      {
        titles: ['Head of Manufacturing Practice', 'Partner', 'Principal'],
        seniorities: CONSULTING, orgKeywords: ['industrial consulting'],
        employeeMin: 20, locations: US, pages: 1,
      },
      {
        titles: ['Partner', 'Principal', 'Managing Director'],
        seniorities: CONSULTING, orgKeywords: ['digital transformation consulting'],
        employeeMin: 51, locations: US, pages: 1,
      },
    ],
  },
  {
    id: 'enterprise_ai_industrial',
    label: 'Enterprise AI with industrial relevance',
    description: 'Enterprise AI companies selling into manufacturing, energy and process industries.',
    rationale:
      'Tests whether the system distinguishes enterprise AI vendors with a real industrial wedge from generic B2B SaaS.',
    companySize: { min: 30, max: 20000 },
    queries: [
      {
        titles: ['Head of Industry Solutions', 'VP of Industry Solutions', 'Director of Industry Solutions'],
        seniorities: OPERATING, orgKeywords: ['artificial intelligence'],
        employeeMin: 51, employeeMax: 20000, locations: US, pages: 2,
      },
      {
        titles: ['VP of Product', 'Head of Product', 'Director of Product Management'],
        seniorities: OPERATING, orgKeywords: ['supply chain software'],
        employeeMin: 51, employeeMax: 10000, locations: US, pages: 2,
      },
      {
        titles: ['Founder', 'Chief Technology Officer', 'VP of Engineering', 'Head of AI'],
        seniorities: FOUNDER_LED, orgKeywords: ['digital twin'],
        employeeMin: 11, employeeMax: 5000, locations: US, pages: 2,
      },
      {
        titles: ['VP of Product', 'Head of AI', 'VP of Engineering'],
        seniorities: OPERATING, orgKeywords: ['process optimization'],
        employeeMin: 51, employeeMax: 10000, locations: US, pages: 2,
      },
      {
        titles: ['Director of Solutions Engineering', 'VP of Solutions', 'Head of Solutions'],
        seniorities: OPERATING, orgKeywords: ['enterprise software'],
        employeeMin: 200, employeeMax: 10000, locations: US, pages: 1,
      },
    ],
  },
  {
    id: 'ambitious_startups',
    label: 'Technically ambitious startups',
    description: 'Deep-tech, climate, materials and energy startups where ChemE + AI + entrepreneurship is rare.',
    rationale:
      'Tests differentiation: at a climate/materials startup the combination of chemical engineering depth and shipped AI is unusually valuable, and the Credence/Argonne/catalysis work is directly on point.',
    companySize: { min: 10, max: 2000 },
    queries: [
      {
        titles: ['Founder', 'Co-Founder', 'Chief Executive Officer', 'Chief Technology Officer'],
        seniorities: FOUNDER_LED, orgKeywords: ['clean energy'],
        employeeMin: 11, employeeMax: 500, locations: US, pages: 2,
      },
      {
        titles: ['Founder', 'Co-Founder', 'Chief Technology Officer', 'Chief Scientist'],
        seniorities: FOUNDER_LED, orgKeywords: ['advanced materials'],
        employeeMin: 11, employeeMax: 500, locations: US, pages: 2,
      },
      {
        titles: ['Founder', 'Co-Founder', 'Chief Executive Officer', 'Head of R&D'],
        seniorities: FOUNDER_LED, orgKeywords: ['hydrogen'],
        employeeMin: 11, employeeMax: 1000, locations: US, pages: 2,
      },
      {
        titles: ['Founder', 'Chief Technology Officer', 'VP of Engineering', 'Head of R&D'],
        seniorities: FOUNDER_LED, orgKeywords: ['battery technology'],
        employeeMin: 11, employeeMax: 1000, locations: US, pages: 2,
      },
      {
        titles: ['Founder', 'Co-Founder', 'Chief Technology Officer', 'Chief Scientist'],
        seniorities: FOUNDER_LED, orgKeywords: ['carbon capture'],
        employeeMin: 11, employeeMax: 500, locations: US, pages: 1,
      },
    ],
  },
]

export function renderMissionForPrompt(): string {
  return [
    `OBJECTIVE: ${TEST_MISSION.objective}`,
    `PRIORITY INTERSECTIONS: ${TEST_MISSION.priority_intersections.join(', ')}`,
    `TARGET PEOPLE: ${TEST_MISSION.target_person_profile}`,
    `IDEAL CONTACT RULE: ${TEST_MISSION.ideal_contact_rule}`,
    `TIMING: ${TEST_MISSION.timing}`,
  ].join('\n')
}
