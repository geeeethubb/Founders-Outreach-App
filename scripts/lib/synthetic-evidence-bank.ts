// A synthetic Evidence Bank modelled on the real one, for offline tests and
// the --fixture benchmark. No database, no keys. Includes one tombstoned
// experience (status = 'merged') and one unapproved fact so the "never
// returned" rules have something to catch. Ids are readable on purpose.

import { emptyBank } from '../../lib/career/evidence/store'
import type { EvidenceBank, EvidenceExperience, EvidenceFact, ExperienceKind, FactCategory } from '../../lib/career/types'

const NOW = '2026-08-28T00:00:00Z'
const USER = 'u-synthetic'

interface ExpSpec {
  id: string
  kind: ExperienceKind
  org: string
  title: string
  start: string | null
  end: string | null
  facts: [string, string, FactCategory][] // [id, statement, category]
  metrics?: { id: string; value: string; context: string; facts: string[] }[]
  status?: 'active' | 'merged'
  merged_into?: string
  approved?: boolean
}

const SPECS: ExpSpec[] = [
  {
    id: 'exp-png', kind: 'experience', org: 'Procter & Gamble, Tabler Station', title: 'Quality Assurance Intern', start: '5/2026', end: '8/2026',
    facts: [
      ['f-png-cs', "Built and piloted a Controlled State system for the Beauty Packing line at P&G's largest global manufacturing site", 'achievement'],
      ['f-png-4m', 'The Controlled State roadmap projected $4M+ in savings from error reduction and process automation', 'metric'],
      ['f-png-sop', 'Designed a new SOP extending shelf life for a body wash ingredient, reducing scrap costs by $300K+ annually', 'achievement'],
      ['f-png-agent', 'Built an AI agent for site validation document approvals, targeting a 30% reduction in manual review and 1,600+ productivity hours returned', 'achievement'],
      ['f-png-risk', 'Led the annual Quality risk assessment for mis-pack, mis-code and mis-label detection sensors', 'responsibility'],
    ],
    metrics: [
      { id: 'm-png-4m', value: '$4M+', context: 'projected savings, Controlled State roadmap', facts: ['f-png-4m'] },
      { id: 'm-png-300k', value: '$300K+', context: 'annual scrap cost reduction', facts: ['f-png-sop'] },
    ],
  },
  {
    id: 'exp-ibc', kind: 'experience', org: 'Illinois Business Consulting', title: 'Project Manager (previously Senior Consultant)', start: '9/2025', end: 'Present',
    facts: [
      ['f-ibc-ma', 'Led M&A screening for a Fortune 500 client, evaluating acquisition targets across specialty chemicals', 'achievement'],
      ['f-ibc-agentic', 'Built an agentic workflow in n8n that automated client deliverable drafting for the consulting team', 'achievement'],
      ['f-ibc-team', 'Manage a team of six consultants across two client engagements', 'scope'],
    ],
  },
  {
    id: 'exp-argonne', kind: 'research', org: 'Argonne National Laboratory', title: 'Techno-Economic Analyst', start: '9/2023', end: '4/2024',
    facts: [
      ['f-arg-cdi', 'Delivered a stacked-electrode Capacitive De-Ionization (CDI) design and techno-economic analysis for biofuel separation', 'achievement'],
      ['f-arg-tea', 'Modeled capital and operating costs for the CDI process against conventional separation', 'responsibility'],
    ],
  },
  {
    id: 'exp-uiuc-lab', kind: 'research', org: "UIUC (Professor Alex Mironenko's lab)", title: 'Undergraduate Researcher, computational catalysis', start: '9/2024', end: 'Present',
    facts: [
      ['f-lab-vasp', 'Ran DFT catalysis simulations with ASE and VASP on fuel-cell electrocatalysts, using 73,000 CPU-hours on the campus cluster', 'achievement'],
      ['f-lab-design', 'Designed catalyst candidates for hydrogen fuel cells from first principles', 'responsibility'],
    ],
    metrics: [{ id: 'm-lab-cpu', value: '73,000', context: 'CPU-hours of DFT simulation', facts: ['f-lab-vasp'] }],
  },
  {
    id: 'exp-founders', kind: 'leadership', org: 'Founders: Illinois Entrepreneurs', title: 'President (formerly Head of Events)', start: '12/2024', end: 'Present',
    facts: [
      ['f-fnd-forge', 'Organized Forge 2026, the largest AI hackathon in UIUC history, with 400+ participants', 'achievement'],
      ['f-fnd-keywords', 'Ran Keywords, a weekly AI builders series where students ship agent projects', 'achievement'],
      ['f-fnd-colini', 'Created CoLini, a student-startup matching platform connecting 200+ UIUC students with 30+ student startups', 'achievement'],
      ['f-fnd-lead', "Lead UIUC's largest entrepreneurship organization as President", 'scope'],
    ],
    metrics: [{ id: 'm-fnd-400', value: '400+', context: 'Forge 2026 participants', facts: ['f-fnd-forge'] }],
  },
  {
    id: 'exp-loopera', kind: 'project', org: 'LoopEra', title: 'Founding Team, Strategy and Sustainability', start: '6/2025', end: '8/2025',
    facts: [
      ['f-loop-summit', "Planned Chicago's first Fashion Tech Summit, bringing 150 attendees and 12 speakers to the fashion-tech startup", 'achievement'],
      ['f-loop-sust', 'Wrote the sustainability strategy for a fashion-tech startup', 'responsibility'],
    ],
  },
  {
    id: 'exp-credence', kind: 'project', org: 'Credence Cleantech Solutions', title: 'Founding Team, Core Chemical Engineer', start: '4/2025', end: '8/2025',
    facts: [
      ['f-cred-wp', "Authored two technical whitepapers on Concentrated Solar Power (CSP) systems, defining Credence's clean-energy technical direction", 'achievement'],
      ['f-cred-round', 'Supported the founding team through a $1.5M pre-seed round', 'achievement'],
    ],
    metrics: [{ id: 'm-cred-1_5m', value: '$1.5M', context: 'pre-seed round', facts: ['f-cred-round'] }],
  },
  {
    id: 'exp-yc', kind: 'award', org: 'Y Combinator Startup School', title: 'Y Combinator Startup School, Summer 2026', start: null, end: null,
    facts: [['f-yc', 'Selected for Y Combinator Startup School, Summer 2026, building a startup with a founding team', 'award']],
  },
  {
    id: 'exp-scholar', kind: 'award', org: 'National / UIUC', title: 'U.S. Presidential Scholar; Chancellor’s Scholar', start: null, end: null,
    facts: [
      ['f-pres', 'Named U.S. Presidential Scholar, one of 161 selected nationally', 'award'],
      ['f-chanc', "Named Chancellor's Scholar, top 125 of 8,300 students", 'award'],
    ],
  },
  {
    id: 'exp-podcast', kind: 'project', org: 'From Campus to C-Suite (podcast)', title: 'Creator and Host', start: null, end: null,
    facts: [['f-pod', "Created and host the podcast 'From Campus to C-Suite', interviewing executives and speakers about early-career decisions", 'achievement']],
  },
  {
    id: 'exp-ceas', kind: 'experience', org: 'CEAS Investments', title: 'Venture Scout', start: '5/2026', end: 'Present',
    facts: [
      ['f-ceas', 'Source and screen early-stage startups as a Venture Scout for CEAS Investments', 'responsibility'],
      ['f-iventure', 'Cohort 11 Fellow of the iVenture Accelerator, UIUC’s startup accelerator', 'context'],
    ],
  },
  {
    id: 'exp-edu', kind: 'education', org: 'University of Illinois Urbana-Champaign', title: 'B.S. Chemical Engineering', start: null, end: '5/2028',
    facts: [
      ['f-edu-name', 'Zuyu Liu is a Chemical Engineering student at the University of Illinois Urbana-Champaign', 'education'],
      ['f-edu-gpa', 'Pursuing B.S. Chemical Engineering at UIUC with GPA 3.69/4.00, expected graduation May 2028', 'education'],
    ],
  },
  // A duplicate P&G row that consolidation merged into exp-png: a tombstone.
  {
    id: 'exp-png-dup', kind: 'experience', org: 'Procter & Gamble', title: 'Quality Assurance Intern', start: 'May 2026', end: 'Present',
    facts: [['f-png-dup', 'Quality Assurance Intern at P&G Beauty Packing (duplicate wording, merged)', 'context']],
    status: 'merged', merged_into: 'exp-png',
  },
]

export function buildSyntheticBank(): EvidenceBank {
  const bank = emptyBank()
  SPECS.forEach((spec, order) => {
    const e: EvidenceExperience = {
      id: spec.id, user_id: USER, kind: spec.kind, organization: spec.org, title: spec.title,
      start_date: spec.start, end_date: spec.end, location: null, description: null, display_order: order,
      source: 'master_resume', approved: spec.approved ?? true, created_at: NOW, updated_at: NOW,
      status: spec.status ?? 'active', merged_into: spec.merged_into ?? null,
    }
    bank.experiences.push(e)
    spec.facts.forEach(([id, statement, category], i) => {
      const f: EvidenceFact = {
        id, user_id: USER, experience_id: e.id, statement, category, source: 'master_resume',
        source_location: `Zuyu_Resume.docx ¶${order * 4 + i + 1}`, confidence: 1, approved: true,
        created_at: `2026-08-28T00:${String(order).padStart(2, '0')}:${String(i).padStart(2, '0')}Z`, updated_at: NOW,
        status: spec.status ?? 'active', support_count: 1,
      }
      bank.facts.push(f)
    })
    for (const m of spec.metrics ?? []) {
      bank.metrics.push({ id: m.id, user_id: USER, experience_id: e.id, value: m.value, unit: null, context: m.context, fact_ids: m.facts, source: 'master_resume', approved: true, created_at: NOW })
    }
  })
  // Two sources agree on the Controlled State fact (015 provenance rows).
  bank.sources.push(
    { id: 'src-resume', user_id: USER, kind: 'resume', label: 'Zuyu_Resume.docx', sha256: null, content: null, storage_path: null, resume_document_id: null, metadata: {}, imported_at: NOW },
    { id: 'src-linkedin', user_id: USER, kind: 'linkedin_profile', label: 'LinkedIn export', sha256: null, content: null, storage_path: null, resume_document_id: null, metadata: {}, imported_at: NOW }
  )
  bank.factSources.push(
    { id: 'fs-1', user_id: USER, fact_id: 'f-png-cs', source_id: 'src-resume', location: '¶6', quote: null, confidence: 1, created_at: NOW },
    { id: 'fs-2', user_id: USER, fact_id: 'f-png-cs', source_id: 'src-linkedin', location: 'L12', quote: null, confidence: 1, created_at: NOW }
  )
  const cs = bank.facts.find((f) => f.id === 'f-png-cs')!
  cs.support_count = 2
  cs.fact_status = 'CORROBORATED'

  // An unapproved fact: a claim the user has not accepted yet.
  bank.facts.push({
    id: 'f-unapproved', user_id: USER, experience_id: 'exp-ibc', statement: 'Closed a $50M acquisition single-handedly (UNAPPROVED)', category: 'achievement',
    source: 'manual', source_location: 'pasted.manual L1', confidence: 0.5, approved: false, created_at: NOW, updated_at: NOW, status: 'active',
  })

  bank.skills.push(
    { id: 'sk-vasp', user_id: USER, name: 'VASP', category: 'tool', evidence_fact_ids: ['f-lab-vasp'], approved: true, created_at: NOW },
    { id: 'sk-n8n', user_id: USER, name: 'n8n', category: 'tool', evidence_fact_ids: ['f-ibc-agentic'], approved: true, created_at: NOW },
    { id: 'sk-tea', user_id: USER, name: 'Techno-economic analysis', category: 'technical', evidence_fact_ids: ['f-arg-cdi'], approved: true, created_at: NOW },
    { id: 'sk-cs', user_id: USER, name: 'Controlled State system', category: 'technical', evidence_fact_ids: ['f-png-cs'], approved: true, created_at: NOW },
    { id: 'sk-events', user_id: USER, name: 'Event organizing', category: 'other', evidence_fact_ids: ['f-fnd-forge', 'f-loop-summit'], approved: true, created_at: NOW }
  )
  bank.projects.push({
    id: 'proj-forge', user_id: USER, experience_id: 'exp-founders', organization_id: null, name: 'Forge 2026', name_norm: 'forge 2026',
    description: 'AI hackathon', fact_ids: ['f-fnd-forge'], approved: true, status: 'active', merged_into: null, created_at: NOW, updated_at: NOW,
  })
  bank.bullets.push(
    { id: 'b-png-1', user_id: USER, resume_document_id: null, experience_id: 'exp-png', paragraph_index: 6, display_order: 0, text: "Built and piloted a **Controlled State** system for the Beauty Packing line at P&G's largest global manufacturing site", evidence_fact_ids: ['f-png-cs'], source_resume: 'master', is_on_master: true, approved: true, created_at: NOW, updated_at: NOW },
    { id: 'b-ibc-1', user_id: USER, resume_document_id: null, experience_id: 'exp-ibc', paragraph_index: 12, display_order: 0, text: 'Led M&A screening for a Fortune 500 client', evidence_fact_ids: ['f-ibc-ma'], source_resume: 'master', is_on_master: true, approved: true, created_at: NOW, updated_at: NOW },
    { id: 'b-arg-1', user_id: USER, resume_document_id: null, experience_id: 'exp-argonne', paragraph_index: 14, display_order: 0, text: 'Delivered a stacked-electrode CDI design and techno-economic analysis', evidence_fact_ids: ['f-arg-cdi'], source_resume: 'master', is_on_master: true, approved: true, created_at: NOW, updated_at: NOW },
    { id: 'b-lab-1', user_id: USER, resume_document_id: null, experience_id: 'exp-uiuc-lab', paragraph_index: 16, display_order: 0, text: 'Ran DFT catalysis simulations with ASE and VASP', evidence_fact_ids: ['f-lab-vasp'], source_resume: 'master', is_on_master: true, approved: true, created_at: NOW, updated_at: NOW },
    { id: 'b-fnd-1', user_id: USER, resume_document_id: null, experience_id: 'exp-founders', paragraph_index: 18, display_order: 0, text: 'Organized Forge 2026, the largest AI hackathon in UIUC history', evidence_fact_ids: ['f-fnd-forge'], source_resume: 'master', is_on_master: true, approved: true, created_at: NOW, updated_at: NOW }
  )
  return bank
}

export const SYNTHETIC_USER = USER
