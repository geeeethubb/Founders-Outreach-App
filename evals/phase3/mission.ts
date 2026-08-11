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
  /**
   * Lowercased substrings; a company must show at least one across its name,
   * description, industry or keywords. Apollo's keyword tags are lexical, so
   * some spaces are very noisy — "operations consulting" returns golf-club and
   * hospitality advisories. This demands actual domain evidence.
   */
  requiredDomainTerms?: string[]
}

/** Shared vocabulary for "this company is actually industrial/process". */
const INDUSTRIAL_TERMS = [
  'manufactur', 'industrial', 'chemical', 'process', 'plant', 'factory',
  'production', 'supply chain', 'operations', 'energy', 'material',
  'engineering', 'refin', 'pharma', 'automation', 'quality', 'logistics',
  'procurement', 'lean', 'six sigma', 'asset', 'equipment', 'machinery',
]

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
    requiredDomainTerms: INDUSTRIAL_TERMS,
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
    // Iteration 4: capped at 20,000 employees and every query anchored to a
    // process-industry keyword. Iteration 3 scored 35% because the unanchored
    // "Head of Digital Manufacturing" query pulled automotive and biotech
    // (JLR, PowerCo, FUJIFILM), and the uncapped size band pulled mega-caps
    // whose Directors are effectively unreachable by a cold student email.
    // Mid-market industrials (200–20k) are both reachable AND the place where
    // P&G-scale process experience is most transferable.
    companySize: { min: 200, max: 20000 },
    requiredDomainTerms: INDUSTRIAL_TERMS,
    queries: [
      {
        titles: ['Head of Digital Manufacturing', 'Director of Digital Manufacturing', 'VP of Digital Manufacturing'],
        seniorities: OPERATING, orgKeywords: ['chemicals'],
        employeeMin: 200, employeeMax: 20000, locations: US, pages: 2,
      },
      {
        titles: ['Director of Innovation', 'Head of Innovation', 'VP of Innovation'],
        seniorities: OPERATING, orgKeywords: ['chemicals'],
        employeeMin: 200, employeeMax: 20000, locations: US, pages: 2,
      },
      {
        titles: ['Director of R&D', 'VP of R&D', 'Head of R&D'],
        seniorities: OPERATING, orgKeywords: ['specialty chemicals'],
        employeeMin: 200, employeeMax: 20000, locations: US, pages: 2,
      },
      {
        titles: ['Director of Manufacturing Technology', 'Head of Advanced Manufacturing', 'Director of Process Engineering'],
        seniorities: OPERATING, orgKeywords: ['process manufacturing'],
        employeeMin: 200, employeeMax: 20000, locations: US, pages: 2,
      },
      {
        titles: ['Director of Digital Transformation', 'Head of Digital Transformation', 'Director of Continuous Improvement'],
        seniorities: OPERATING, orgKeywords: ['consumer packaged goods'],
        employeeMin: 200, employeeMax: 20000, locations: US, pages: 2,
      },
      {
        titles: ['Director of Operations', 'VP of Operations', 'Head of Manufacturing'],
        seniorities: OPERATING, orgKeywords: ['coatings'],
        employeeMin: 200, employeeMax: 20000, locations: US, pages: 1,
      },
      {
        titles: ['Director of Quality', 'Head of Quality', 'VP of Quality'],
        seniorities: OPERATING, orgKeywords: ['specialty chemicals'],
        employeeMin: 200, employeeMax: 20000, locations: US, pages: 1,
      },
      {
        titles: ['Director of Process Engineering', 'Head of Process Engineering', 'Director of Manufacturing Excellence'],
        seniorities: OPERATING, orgKeywords: ['industrial manufacturing'],
        employeeMin: 200, employeeMax: 20000, locations: US, pages: 1,
      },
    ],
  },
  {
    id: 'industrial_consulting',
    label: 'Operations / industrial consulting',
    description: 'Consulting firms with operations, manufacturing and industrial practices.',
    rationale:
      'Directly leverages the Illinois Business Consulting M&A and Big Four agentic workflow experience; Partners and Principals control staffing.',
    // Iteration 4: capped at 3,000 employees. Iteration 3 scored 30% because
    // uncapped size pulled Big-4-scale firms, where a Partner receives constant
    // student outreach and staffs through campus recruiting. At boutique and
    // mid-market firms a Partner personally decides staffing, and Zuyu's IBC
    // M&A screening plus Big-Four agentic-workflow work is a direct match.
    companySize: { min: 15, max: 3000 },
    requiredDomainTerms: INDUSTRIAL_TERMS,
    queries: [
      {
        titles: ['Partner', 'Principal', 'Managing Director'],
        seniorities: CONSULTING, orgKeywords: ['operations consulting'],
        employeeMin: 15, employeeMax: 3000, locations: US, pages: 2,
      },
      {
        titles: ['Partner', 'Principal', 'Practice Leader'],
        seniorities: CONSULTING, orgKeywords: ['manufacturing consulting'],
        employeeMin: 15, employeeMax: 3000, locations: US, pages: 2,
      },
      {
        titles: ['Partner', 'Principal', 'Managing Director', 'Director'],
        seniorities: CONSULTING, orgKeywords: ['supply chain consulting'],
        employeeMin: 15, employeeMax: 3000, locations: US, pages: 2,
      },
      {
        titles: ['Partner', 'Principal', 'Founder'],
        seniorities: CONSULTING, orgKeywords: ['industrial consulting'],
        employeeMin: 15, employeeMax: 3000, locations: US, pages: 2,
      },
      {
        titles: ['Partner', 'Principal', 'Managing Director'],
        seniorities: CONSULTING, orgKeywords: ['chemical industry consulting'],
        employeeMin: 15, employeeMax: 3000, locations: US, pages: 2,
      },
      {
        titles: ['Partner', 'Principal', 'Founder', 'Managing Partner'],
        seniorities: CONSULTING, orgKeywords: ['process improvement'],
        employeeMin: 15, employeeMax: 3000, locations: US, pages: 2,
      },
      {
        titles: ['Partner', 'Principal', 'Head of Energy Practice'],
        seniorities: CONSULTING, orgKeywords: ['energy consulting'],
        employeeMin: 15, employeeMax: 3000, locations: US, pages: 1,
      },
    ],
  },
  {
    id: 'enterprise_ai_industrial',
    label: 'Enterprise AI with industrial relevance',
    description: 'Enterprise AI companies selling into manufacturing, energy and process industries.',
    rationale:
      'Tests whether the system distinguishes enterprise AI vendors with a real industrial wedge from generic B2B SaaS.',
    // Iteration 4: capped at 5,000 and anchored on INDUSTRIAL verticals.
    // Iteration 3 scored 35% because 'enterprise software' + 'artificial
    // intelligence' is a horizontal query — it returned generic B2B SaaS where
    // a ChemE background confers no advantage. The mission wants enterprise AI
    // WITH an industrial wedge, so every query now names one.
    companySize: { min: 20, max: 5000 },
    requiredDomainTerms: INDUSTRIAL_TERMS,
    queries: [
      {
        titles: ['Head of Industry Solutions', 'VP of Product', 'Head of AI', 'Founder'],
        seniorities: FOUNDER_LED, orgKeywords: ['manufacturing analytics'],
        employeeMin: 20, employeeMax: 5000, locations: US, pages: 2,
      },
      {
        titles: ['VP of Product', 'Head of Product', 'Founder', 'Chief Technology Officer'],
        seniorities: FOUNDER_LED, orgKeywords: ['industrial software'],
        employeeMin: 20, employeeMax: 5000, locations: US, pages: 2,
      },
      {
        titles: ['Founder', 'Chief Technology Officer', 'VP of Engineering', 'Head of AI'],
        seniorities: FOUNDER_LED, orgKeywords: ['digital twin'],
        employeeMin: 11, employeeMax: 5000, locations: US, pages: 2,
      },
      {
        titles: ['VP of Product', 'Head of AI', 'VP of Engineering', 'Founder'],
        seniorities: FOUNDER_LED, orgKeywords: ['process optimization'],
        employeeMin: 20, employeeMax: 5000, locations: US, pages: 2,
      },
      {
        titles: ['Founder', 'Chief Technology Officer', 'VP of Product', 'Head of AI'],
        seniorities: FOUNDER_LED, orgKeywords: ['asset performance management'],
        employeeMin: 20, employeeMax: 5000, locations: US, pages: 2,
      },
      {
        titles: ['Founder', 'Chief Technology Officer', 'Head of AI', 'VP of Engineering'],
        seniorities: FOUNDER_LED, orgKeywords: ['process simulation'],
        employeeMin: 11, employeeMax: 5000, locations: US, pages: 2,
      },
      {
        titles: ['VP of Product', 'Head of Industry Solutions', 'Founder'],
        seniorities: FOUNDER_LED, orgKeywords: ['supply chain software'],
        employeeMin: 20, employeeMax: 5000, locations: US, pages: 1,
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
    requiredDomainTerms: [...INDUSTRIAL_TERMS, 'climate', 'carbon', 'battery', 'hydrogen', 'solar', 'clean', 'sustain', 'catalys'],
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
