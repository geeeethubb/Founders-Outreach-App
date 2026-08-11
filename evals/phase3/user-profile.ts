// Resume-derived structured profile — EVAL SCAFFOLD ONLY.
//
// Extracted by hand from my_resume.pdf (not modified, not committed elsewhere).
// This is a temporary structure used for Phase 3 relevance scoring and for the
// resume-grounding eval. It is deliberately NOT the Phase 2 Talent Knowledge
// Base: no database, no tagging dimensions, no retrieval ranking.
//
// Every `id` here is a grounding anchor. The scorer may only cite these ids
// when explaining "why I fit them", which is what makes the 100% resume-
// grounding check mechanically verifiable rather than a matter of trust.

export interface ResumeItem {
  id: string
  kind: 'experience' | 'project' | 'award' | 'education'
  title: string
  org: string
  period: string
  /** One-line form used inside prompts. Keep tight — this is prompt budget. */
  summary: string
  domains: string[]
  credibility: 'strong' | 'moderate' | 'supporting'
}

export const RESUME_ITEMS: ResumeItem[] = [
  {
    id: 'png_controlled_state',
    kind: 'experience',
    title: 'Quality Assurance Intern — Controlled State system',
    org: 'Procter & Gamble (Tabler Station, largest global manufacturing site)',
    period: '5/2026 – 8/2026',
    summary:
      "Built and piloted a Controlled State system for the Beauty Packing line at P&G's largest global manufacturing site, defining the roadmap for error reduction and process automation with $4M+ projected savings.",
    domains: ['manufacturing', 'process automation', 'quality', 'CPG', 'industrial operations'],
    credibility: 'strong',
  },
  {
    id: 'png_ai_agent_validation',
    kind: 'experience',
    title: 'AI agent for site validation document approvals',
    org: 'Procter & Gamble',
    period: '5/2026 – 8/2026',
    summary:
      'Built an AI agent to streamline all site validation document approvals — 30% targeted reduction in manual review, 1,600+ productivity hours returned, $130K+ projected annual savings.',
    domains: ['industrial AI', 'AI agents', 'manufacturing', 'quality systems', 'workflow automation'],
    credibility: 'strong',
  },
  {
    id: 'png_agentic_adoption',
    kind: 'experience',
    title: 'Agentic AI workflow for floor-level managers',
    org: 'Procter & Gamble',
    period: '5/2026 – 8/2026',
    summary:
      'Designed an agentic AI workflow letting floor-level managers identify team-specific use cases and drive bottom-up AI adoption, with $3M+ projected annual site-wide savings, in partnership with Plant Management.',
    domains: ['industrial AI', 'AI adoption', 'change management', 'manufacturing', 'agentic workflows'],
    credibility: 'strong',
  },
  {
    id: 'png_quality_risk',
    kind: 'experience',
    title: 'Annual Quality risk assessment, 20+ stakeholders',
    org: 'Procter & Gamble',
    period: '5/2026 – 8/2026',
    summary:
      'Led the annual Quality risk assessment for mis-pack/mis-code/mis-label detection sensors; coordinated 20+ stakeholders across 4 teams to deliver gap analysis and mitigation for critical quality controls.',
    domains: ['quality', 'manufacturing', 'risk assessment', 'stakeholder management', 'sensors'],
    credibility: 'moderate',
  },
  {
    id: 'png_sop_shelf_life',
    kind: 'experience',
    title: 'SOP extending ingredient shelf life',
    org: 'Procter & Gamble',
    period: '5/2026 – 8/2026',
    summary:
      'Designed, executed and validated a new SOP extending shelf life for a critical body wash ingredient — $300K+ annual scrap reduction and greater supply chain flexibility.',
    domains: ['chemical engineering', 'formulation', 'supply chain', 'manufacturing', 'CPG'],
    credibility: 'moderate',
  },
  {
    id: 'ibc_ma_screening',
    kind: 'experience',
    title: 'Project Manager — Fortune 500 M&A screening',
    org: 'Illinois Business Consulting',
    period: '9/2025 – Present',
    summary:
      'Conducted early-stage M&A screening for a Fortune 500 manufacturing company, evaluating acquisition targets across market opportunity, technical capability and strategic fit.',
    domains: ['consulting', 'M&A', 'manufacturing', 'corporate strategy', 'due diligence'],
    credibility: 'strong',
  },
  {
    id: 'ibc_big_four_agentic',
    kind: 'experience',
    title: 'Agentic AI workflow design for a Big Four firm',
    org: 'Illinois Business Consulting',
    period: '9/2025 – Present',
    summary:
      'Led agentic AI workflow design for a Big Four consulting firm, compressing a fragmented multi-month corporate innovation workflow into a structured sub-5-minute process using n8n, with defined agents, automation logic and human-in-the-loop checkpoints.',
    domains: ['enterprise AI', 'AI agents', 'consulting', 'corporate innovation', 'workflow automation'],
    credibility: 'strong',
  },
  {
    id: 'uiuc_catalysis',
    kind: 'experience',
    title: 'Computational catalysis research (ASE/VASP, 73k CPU-hours)',
    org: 'University of Illinois Urbana-Champaign',
    period: '9/2024 – Present',
    summary:
      'Computational catalysis research using ASE/VASP across 73k CPU-hours, screening 40+ aMOC surface configurations for structural stability in hydrogen fuel cell applications.',
    domains: ['chemical engineering', 'catalysis', 'computational chemistry', 'hydrogen', 'energy', 'materials'],
    credibility: 'strong',
  },
  {
    id: 'uiuc_polymer_supply',
    kind: 'experience',
    title: 'Polymer supply-chain mapping (PET / BTX)',
    org: 'University of Illinois Urbana-Champaign',
    period: '9/2024 – Present',
    summary:
      'Built Sankey diagrams mapping high-performance polymer supply chains (PET), visualizing feedstock flows and gaps and identifying where sustainable BTX alternatives create economic and sustainability value.',
    domains: ['chemicals', 'polymers', 'supply chain', 'sustainability', 'petrochemicals'],
    credibility: 'moderate',
  },
  {
    id: 'argonne_tea',
    kind: 'experience',
    title: 'Techno-Economic Analyst — CDI for biofuels',
    org: 'Argonne National Laboratory',
    period: '9/2023 – 4/2024',
    summary:
      'Delivered a stacked-electrode Capacitive De-Ionization design and techno-economic analysis for biofuel separation, translating lab data and 10+ studies into a feasibility and scalability report.',
    domains: ['energy', 'chemical engineering', 'techno-economic analysis', 'separations', 'biofuels', 'national lab'],
    credibility: 'strong',
  },
  {
    id: 'founders_president',
    kind: 'project',
    title: 'President — Founders: Illinois Entrepreneurs',
    org: 'Founders: Illinois Entrepreneurs (UIUC)',
    period: '12/2024 – Present',
    summary:
      "Leads UIUC's premier entrepreneurship organization. Organized Forge, the largest student-run startup weekend in the Midwest (25+ startups, 30+ investors/mentors), and Keywords, the largest AI hackathon in UIUC history, run with Y Combinator (400+ participants).",
    domains: ['entrepreneurship', 'startups', 'leadership', 'community building', 'AI', 'Y Combinator'],
    credibility: 'strong',
  },
  {
    id: 'colini',
    kind: 'project',
    title: 'CoLini — student/startup matching platform',
    org: 'Founders: Illinois Entrepreneurs',
    period: '12/2024 – Present',
    summary:
      'Created CoLini, a student-startup matching platform connecting 200+ active UIUC students with 30+ student startups to accelerate recruiting, team formation and early growth.',
    domains: ['product', 'startups', 'marketplace', 'entrepreneurship', 'software'],
    credibility: 'moderate',
  },
  {
    id: 'credence_cleantech',
    kind: 'project',
    title: 'Founding team, Core Chemical Engineer',
    org: 'Credence Cleantech Solutions (clean-energy startup)',
    period: '4/2025 – 8/2025',
    summary:
      "Authored two technical whitepapers on Concentrated Solar Power systems defining the company's technical direction and differentiation; sourced investment leads for a $1.5M round.",
    domains: ['energy', 'cleantech', 'startups', 'chemical engineering', 'solar', 'fundraising'],
    credibility: 'strong',
  },
  {
    id: 'loopera',
    kind: 'project',
    title: 'Founding team — Strategy and Sustainability',
    org: 'LoopEra (fashion-tech startup)',
    period: '6/2025 – 8/2025',
    summary:
      "Planned Chicago's first Fashion Tech Summit (210+ participants across fashion, AI, software, materials and sustainability); ran life-cycle analyses of textile fibers to position LoopEra around low-carbon, ethical supply chains.",
    domains: ['sustainability', 'startups', 'materials', 'LCA', 'supply chain'],
    credibility: 'moderate',
  },
  {
    id: 'yc_startup_school',
    kind: 'award',
    title: 'Y Combinator Startup School, Summer 2026 (top 5%)',
    org: 'Y Combinator',
    period: '2026',
    summary: 'Selected for Y Combinator Startup School, Summer 2026 — top 5% of applicants.',
    domains: ['startups', 'entrepreneurship', 'Y Combinator'],
    credibility: 'strong',
  },
  {
    id: 'presidential_scholar',
    kind: 'award',
    title: 'U.S. Presidential Scholar',
    org: 'U.S. Department of Education',
    period: 'High school',
    summary:
      'U.S. Presidential Scholar — 1 of 161 selected nationally from 3.8M U.S. high school graduates.',
    domains: ['academic distinction', 'credibility signal'],
    credibility: 'strong',
  },
  {
    id: 'chancellors_scholar',
    kind: 'award',
    title: "Chancellor's Scholar",
    org: 'UIUC',
    period: 'Current',
    summary: "Chancellor's Scholar — top 125 students of 8,300 in the UIUC class.",
    domains: ['academic distinction', 'credibility signal'],
    credibility: 'moderate',
  },
  {
    id: 'education_cheme',
    kind: 'education',
    title: 'B.S. Chemical Engineering, GPA 3.69',
    org: 'University of Illinois Urbana-Champaign',
    period: 'Expected May 2028',
    summary: 'B.S. Chemical Engineering at UIUC, GPA 3.69/4.00, expected graduation May 2028.',
    domains: ['chemical engineering', 'education'],
    credibility: 'moderate',
  },
]

export const RESUME_ITEM_IDS = RESUME_ITEMS.map((i) => i.id)

/** Rolled-up view used to steer search strategy and scoring. */
export const USER_PROFILE = {
  name: 'Zuyu Liu',
  headline:
    'Chemical Engineer building at the intersection of engineering, entrepreneurship, and AI frontiers to drive industry innovation.',
  education: 'B.S. Chemical Engineering, UIUC (GPA 3.69), expected May 2028',
  graduation: 'May 2028',

  industries: [
    'consumer packaged goods manufacturing',
    'chemicals and petrochemicals',
    'energy and cleantech',
    'industrial manufacturing',
    'management consulting',
    'enterprise / industrial AI',
  ],
  technical_areas: [
    'agentic AI workflow design (n8n, AI agents)',
    'computational chemistry (ASE/VASP, DFT catalysis screening)',
    'techno-economic analysis',
    'process automation and quality systems',
    'life-cycle and supply-chain analysis',
    'separations and electrochemistry',
  ],
  organizations: [
    'Procter & Gamble',
    'Argonne National Laboratory',
    'Illinois Business Consulting',
    'University of Illinois Urbana-Champaign',
    'Y Combinator (Startup School, Keywords hackathon)',
  ],
  entrepreneurial: [
    'President of Founders: Illinois Entrepreneurs',
    'Founding team at Credence Cleantech Solutions',
    'Founding team at LoopEra',
    'Built CoLini',
  ],
  leadership: [
    'President of the premier UIUC entrepreneurship org',
    'Project Manager at Illinois Business Consulting',
    'Coordinated 20+ stakeholders across 4 teams at P&G',
    'Organized 400+ participant AI hackathon with Y Combinator',
  ],
  ai_experience: [
    'Shipped an AI agent into a live regulated manufacturing quality process at P&G',
    'Designed agentic AI adoption workflow for plant floor managers ($3M+ projected)',
    'Agentic workflow redesign for a Big Four consulting firm using n8n',
  ],
  industrial_experience: [
    "P&G's largest global manufacturing site — Controlled State system, $4M+ projected savings",
    'Quality risk assessment for packaging line detection sensors',
    'SOP validation extending ingredient shelf life, $300K+ scrap reduction',
  ],
  consulting_experience: [
    'Fortune 500 manufacturing M&A screening',
    'Big Four corporate innovation workflow redesign',
  ],

  /**
   * The differentiation thesis. Most AI people have never stood on a plant
   * floor; most chemical engineers have never shipped an agent. This specific
   * overlap is the scarce thing, and it is what "Differentiation" scores.
   */
  differentiation_thesis:
    'Chemical engineering fundamentals plus hands-on manufacturing floor experience at the largest P&G site, plus actually shipping agentic AI into live industrial quality and operations workflows with quantified multi-million-dollar impact, plus running the largest student entrepreneurship organization at UIUC. The scarce combination is deep process/industrial domain knowledge AND practical agentic AI delivery AND founder energy — most candidates have at most one.',

  strongest_credibility_signals: [
    'U.S. Presidential Scholar — 1 of 161 nationally from 3.8M graduates',
    "P&G's largest global manufacturing site with $4M+ and $3M+ projected savings initiatives",
    'Argonne National Laboratory techno-economic analysis',
    'Y Combinator Startup School top 5%; ran a 400+ person AI hackathon with YC',
    'President of Founders: Illinois Entrepreneurs',
  ],

  constraints: {
    seeking: 'Winter 2026–27 internship or short-term project, plus Summer 2027 recruiting relevance',
    availability: 'December 2026 – January 2027 for winter; Summer 2027 for full internship',
    location: 'US-based; Illinois/Chicago and remote preferred but open',
    status: 'Undergraduate (graduating May 2028) — needs someone willing to engage a student',
  },
} as const

/** Compact prompt rendering. Kept short on purpose — this goes in every scoring call. */
export function renderProfileForPrompt(): string {
  const lines: string[] = [
    `NAME: ${USER_PROFILE.name}`,
    `HEADLINE: ${USER_PROFILE.headline}`,
    `EDUCATION: ${USER_PROFILE.education}`,
    `SEEKING: ${USER_PROFILE.constraints.seeking}`,
    '',
    'DIFFERENTIATION THESIS:',
    USER_PROFILE.differentiation_thesis,
    '',
    'RESUME ITEMS (cite these ids in why_i_fit_them — no other ids exist):',
  ]
  for (const item of RESUME_ITEMS) {
    lines.push(`[${item.id}] ${item.title} @ ${item.org} (${item.period}) — ${item.summary}`)
  }
  return lines.join('\n')
}
