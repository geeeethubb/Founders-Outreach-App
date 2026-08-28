// Deterministic tests for the Evidence Bank: retrieval ranking, the number
// check, and the importer's validator. No network, no keys, no database.
//
//   npx tsx scripts/test-career-evidence.ts
//
// The synthetic bank is built from evals/phase3/user-profile.ts, which is the
// hand-written résumé summary already committed — nothing personal is added.

import { RESUME_ITEMS } from '../evals/phase3/user-profile'
import { retrieveEvidenceForJob, renderRetrievedDetail, terms, stem } from '../lib/career/evidence/retrieve'
import { emptyBank } from '../lib/career/evidence/store'
import {
  numberTokens,
  numbersSupported,
  skillSupported,
  validateImporterOutput,
  type ResumeImporterInput,
} from '../lib/agents/resume-importer'
import type { EvidenceBank, EvidenceExperience, EvidenceFact } from '../lib/career/types'

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

// ─── Synthetic bank ──────────────────────────────────────────────────────────

function buildBank(): EvidenceBank {
  const bank = emptyBank()
  const now = '2026-08-27T00:00:00Z'
  const expByOrg = new Map<string, EvidenceExperience>()
  let order = 0
  for (const item of RESUME_ITEMS) {
    const orgKey = item.org.split('(')[0].trim()
    let e = expByOrg.get(orgKey)
    if (!e) {
      e = {
        id: `exp-${orgKey.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        user_id: 'u',
        kind: item.kind === 'experience' ? 'experience' : item.kind,
        organization: orgKey,
        title: item.title.split('—')[0].trim(),
        start_date: null,
        end_date: null,
        location: null,
        description: null,
        display_order: order++,
        source: 'master_resume',
        approved: true,
        created_at: now,
        updated_at: now,
      }
      expByOrg.set(orgKey, e)
      bank.experiences.push(e)
    }
    const fact: EvidenceFact = {
      id: `fact-${item.id}`,
      user_id: 'u',
      experience_id: e.id,
      statement: item.summary,
      category: 'achievement',
      source: 'master_resume',
      source_location: null,
      confidence: 1,
      approved: true,
      created_at: now,
      updated_at: now,
    }
    bank.facts.push(fact)
  }
  bank.skills.push(
    { id: 'sk-vasp', user_id: 'u', name: 'VASP', category: 'tool', evidence_fact_ids: [], approved: true, created_at: now },
    { id: 'sk-n8n', user_id: 'u', name: 'n8n', category: 'tool', evidence_fact_ids: [], approved: true, created_at: now },
    { id: 'sk-tea', user_id: 'u', name: 'techno-economic analysis', category: 'technical', evidence_fact_ids: [], approved: true, created_at: now }
  )
  return bank
}

const bank = buildBank()
const orgOf = (id: string) => bank.experiences.find((e) => e.id === id)?.organization ?? '?'

// ─── Retrieval ───────────────────────────────────────────────────────────────

check('stem: plurals', stem('sensors') === 'sensor')
check('stem: -ing', stem('manufacturing') === 'manufactur')
check('stem: -ed', stem('validated') === 'validat')
check('terms: synonym phrase captured', terms('experience with supply chain analytics').includes('supply chain'))

const r1 = retrieveEvidenceForJob(bank, {
  title: 'Process Engineering Intern',
  skills: ['manufacturing', 'quality', 'SOPs', 'process improvement'],
  responsibilities: ['support plant operations', 'write and validate SOPs', 'quality risk assessment'],
  min_qualifications: ['pursuing a degree in chemical engineering'],
  preferred_qualifications: ['experience in a manufacturing environment'],
  industry: 'consumer goods manufacturing',
  description_text: 'Summer internship on a production line supporting quality systems.',
})
check('process/manufacturing JD ranks P&G first', orgOf(r1.experiences[0].experience_id) === 'Procter & Gamble', `got ${orgOf(r1.experiences[0].experience_id)}`)
check('every experience is returned', r1.experiences.length === bank.experiences.length)
check('tail experiences present with score >= 0', r1.experiences.every((e) => e.score >= 0))
check('P&G matched terms include quality', r1.experiences[0].matched_terms.some((t) => t.replace('~', '') === 'quality'))

const r2 = retrieveEvidenceForJob(bank, {
  title: 'Computational Chemistry Intern',
  skills: ['DFT', 'catalysis', 'Python'],
  responsibilities: ['run DFT calculations on catalyst surfaces', 'analyze computational results'],
  min_qualifications: ['chemistry or chemical engineering student'],
  industry: 'materials',
  description_text: 'Computational catalysis research group.',
})
check('DFT/catalysis JD ranks UIUC research first', orgOf(r2.experiences[0].experience_id) === 'University of Illinois Urbana-Champaign', `got ${orgOf(r2.experiences[0].experience_id)}`)
check('VASP skill retrieved via family', r2.skills.some((s) => s.name === 'VASP'))
check('catalysis fact ranks top', r2.facts[0].fact_id === 'fact-uiuc_catalysis', `got ${r2.facts[0].fact_id}`)

const r3 = retrieveEvidenceForJob(bank, {
  title: 'Management Consulting Summer Analyst',
  skills: ['strategy', 'consulting', 'market analysis'],
  responsibilities: ['support client engagements', 'strategy and M&A screening'],
  min_qualifications: [],
  industry: 'consulting',
  description_text: 'Management consulting firm serving Fortune 500 clients.',
})
check('consulting JD ranks IBC first', orgOf(r3.experiences[0].experience_id) === 'Illinois Business Consulting', `got ${orgOf(r3.experiences[0].experience_id)}`)

const detail = renderRetrievedDetail(bank, r1, { maxExperiences: 2 })
check('renderRetrievedDetail renders top experiences', detail.includes('Procter & Gamble') && detail.split('EXPERIENCE [').length === 3)

// Determinism: same input, same output.
const again = retrieveEvidenceForJob(bank, { title: 'Process Engineering Intern', skills: ['manufacturing', 'quality', 'SOPs', 'process improvement'] })
check('retrieval is deterministic', JSON.stringify(again.experiences.map((e) => e.experience_id)) === JSON.stringify(retrieveEvidenceForJob(bank, { title: 'Process Engineering Intern', skills: ['manufacturing', 'quality', 'SOPs', 'process improvement'] }).experiences.map((e) => e.experience_id)))

// ─── Number check ────────────────────────────────────────────────────────────

const SOURCE = 'Built an AI agent to streamline all site validation document approvals, targeting 30% reduction in manual review, 1,600+ productivity hours, and $130K+ projected annual savings; roadmap with $4M+ projected savings across 20+ stakeholders'

check('numberTokens normalizes commas', numberTokens('1,600+ hours').includes('1600'))
check('numberTokens: $4M', numberTokens('$4M+ savings').includes('4M'))
check('numberTokens: $4 million', numberTokens('$4 million savings').includes('4M'))
check('numberTokens: percent', numberTokens('30% reduction').includes('30%'))
check('numberTokens: 73k', numberTokens('73k CPU-hours').includes('73k'))
check('numberTokens: 3.8M', numberTokens('3.8M graduates').includes('3.8M'))
check('numberTokens: months is not a suffix', JSON.stringify(numberTokens('5 months')) === JSON.stringify(['5']))

check('fabricated $9M is rejected', !numbersSupported('Projected $9M in savings', SOURCE).ok)
check('1600 matches 1,600', numbersSupported('Returned 1600 productivity hours', SOURCE).ok)
check('$4 million matches $4M', numbersSupported('Roadmap projected $4 million in savings', SOURCE).ok)
check('30 percent matches 30%', numbersSupported('Targeted a 30 percent reduction in manual review', SOURCE).ok)
check('130K matches $130K+', numbersSupported('$130K annual savings', SOURCE).ok)
check('wrong suffix is rejected', !numbersSupported('$4B in savings', SOURCE).ok)
check('no numbers is fine', numbersSupported('Built an AI agent for document approvals', SOURCE).ok)
check('missing list names the token', numbersSupported('Saved $9M', SOURCE).missing[0] === '9M')

check('skill: literal', skillSupported('n8n', 'built using n8n with agents'))
check('skill: VASP from ASE/VASP', skillSupported('VASP', 'research using ASE/VASP (73k CPU-hours)'))
check('skill: case-insensitive', skillSupported('techno-economic analysis', 'Techno-Economic Analysis for biofuel'))
check('skill: invented Python rejected', !skillSupported('Python', 'research using ASE/VASP'))

// ─── Importer validate() ─────────────────────────────────────────────────────

const input: ResumeImporterInput = {
  allow_new_experiences: false,
  extra_sources: [{ label: 'profile.personal_context', lines: [{ paragraph_index: 0, text: 'I speak Mandarin fluently and have used Python for data analysis.' }] }],
  experiences: [
    {
      key: 'png__qa-intern',
      title: 'Quality Assurance Intern',
      organization: 'Procter & Gamble',
      location: 'Inwood, WV',
      start_date: '5/2026',
      end_date: '8/2026',
      section: 'PROFESSIONAL EXPERIENCE',
      bullets: [
        { paragraph_index: 6, text: 'Built and piloted a Controlled State system for Beauty Packing line, defining the roadmap with $4M+ projected savings.' },
        { paragraph_index: 9, text: SOURCE },
      ],
    },
    {
      key: 'uiuc__researcher',
      title: 'Undergraduate Researcher',
      organization: 'University of Illinois',
      location: null,
      start_date: '9/2024',
      end_date: 'Present',
      section: 'PROFESSIONAL EXPERIENCE',
      bullets: [{ paragraph_index: 18, text: 'Conducted computational catalysis research using ASE/VASP (73k CPU-hours), screening 40+ aMOC surface configurations.' }],
    },
  ],
}

const fake = {
  experiences: [
    {
      experience_key: 'png__qa-intern',
      summary: 'QA intern at P&G.',
      new_experience: null,
      facts: [
        { statement: 'Built and piloted a Controlled State system for the Beauty Packing line', category: 'achievement', source_label: 'master_resume', paragraph_index: 6, confidence: 1 },
        { statement: 'The roadmap projected $4M+ in savings', category: 'metric', source_label: 'master_resume', paragraph_index: 6, confidence: 0.9 },
        { statement: 'Delivered $9M in savings', category: 'metric', source_label: 'master_resume', paragraph_index: 6, confidence: 1 }, // fabricated number
        { statement: 'Returned 1600 productivity hours', category: 'metric', source_label: 'master_resume', paragraph_index: 9, confidence: 1 },
        { statement: 'Screened 40+ aMOC surfaces', category: 'achievement', source_label: 'master_resume', paragraph_index: 18, confidence: 1 }, // paragraph belongs to the other experience
        { statement: 'Uses Python for data analysis', category: 'skill', source_label: 'profile.personal_context', paragraph_index: 0, confidence: 0.8 },
        { statement: 'Started in 5/2026', category: 'context', source_label: 'master_resume', paragraph_index: 6, confidence: 1 }, // date lives in the header
      ],
      metrics: [
        { value: '$4M+', unit: 'projected savings', context: 'Controlled State roadmap', fact_refs: [1] },
        { value: '$12M', unit: 'savings', context: 'invented', fact_refs: [1] },
        { value: '1,600+', unit: 'productivity hours', context: null, fact_refs: [3, 2] },
      ],
      skills: [
        { name: 'Controlled State', category: 'domain', fact_refs: [0] },
        { name: 'Six Sigma', category: 'technical', fact_refs: [0] },
        { name: 'Python', category: 'tool', fact_refs: [5] },
      ],
      deliverables: [{ description: 'Controlled State system', fact_refs: [0, 2] }],
    },
    {
      experience_key: 'acme__invented-intern',
      summary: 'Never happened.',
      new_experience: { title: 'Intern', organization: 'Acme', location: null, start_date: null, end_date: null, kind: 'experience' },
      facts: [{ statement: 'Did things', category: 'other', source_label: 'master_resume', paragraph_index: 6, confidence: 1 }],
      metrics: [],
      skills: [],
      deliverables: [],
    },
  ],
}

const out = validateImporterOutput(fake, input)
check('validate returns output', out !== null)
if (out) {
  check('invented experience key rejected', out.experiences.length === 1 && out.dropped_experiences === 1)
  const png = out.experiences[0]
  check('fabricated $9M fact dropped', !png.facts.some((f) => f.statement.includes('$9M')) && out.dropped_unverifiable === 1, `unverifiable=${out.dropped_unverifiable}`)
  check('misfiled paragraph dropped', !png.facts.some((f) => f.statement.includes('aMOC')) && out.dropped_misfiled === 1, `misfiled=${out.dropped_misfiled}`)
  check('1600 vs 1,600 kept', png.facts.some((f) => f.statement.includes('1600')))
  check('extra-source fact kept', png.facts.some((f) => f.source_label === 'profile.personal_context'))
  check('header date accepted', png.facts.some((f) => f.statement.includes('5/2026')))
  check('surviving facts count', png.facts.length === 5, `got ${png.facts.length}`)
  check('invented $12M metric dropped', !png.metrics.some((m) => m.value === '$12M') && out.dropped_metrics === 1, `metrics=${out.dropped_metrics}`)
  const hours = png.metrics.find((m) => m.value === '1,600+')
  check('metric fact_refs remapped past the dropped fact', hours !== undefined && hours.fact_refs.length === 1 && png.facts[hours.fact_refs[0]].statement.includes('1600'), JSON.stringify(hours))
  check('invented Six Sigma skill dropped', !png.skills.some((s) => s.name === 'Six Sigma') && out.dropped_skills === 1)
  check('Python skill kept via extra source', png.skills.some((s) => s.name === 'Python'))
  check('deliverable refs drop the fabricated fact', png.deliverables[0].fact_refs.length === 1)
}

check('validate rejects non-object', validateImporterOutput('nope', input) === null)
check('validate rejects when nothing matches', validateImporterOutput({ experiences: [{ experience_key: 'x', facts: [] }] }, input) === null)

// Text mode: a new experience needs organization + title.
const textInput: ResumeImporterInput = {
  allow_new_experiences: true,
  experiences: [],
  extra_sources: [{ label: 'pasted.linkedin', lines: [{ paragraph_index: 0, text: 'Engineering Intern at Acme Corp, 2025' }, { paragraph_index: 1, text: 'Reduced downtime 12% across 3 lines' }] }],
}
const textOut = validateImporterOutput(
  {
    experiences: [
      {
        experience_key: 'acme__engineering-intern',
        summary: 'Intern at Acme.',
        new_experience: { title: 'Engineering Intern', organization: 'Acme Corp', location: null, start_date: '2025', end_date: null, kind: 'experience' },
        facts: [
          { statement: 'Reduced downtime 12% across 3 lines', category: 'achievement', source_label: 'pasted.linkedin', paragraph_index: 1, confidence: 1 },
          { statement: 'Reduced downtime 15%', category: 'achievement', source_label: 'pasted.linkedin', paragraph_index: 1, confidence: 1 },
        ],
        metrics: [], skills: [], deliverables: [],
      },
      { experience_key: 'nameless', summary: '', new_experience: { title: '', organization: 'X', location: null, start_date: null, end_date: null, kind: 'other' }, facts: [], metrics: [], skills: [], deliverables: [] },
    ],
  },
  textInput
)
check('text mode: proposed experience accepted', textOut !== null && textOut.experiences.length === 1 && textOut.experiences[0].new_experience?.organization === 'Acme Corp')
check('text mode: nameless block rejected', textOut !== null && textOut.dropped_experiences === 1)
check('text mode: wrong number dropped', textOut !== null && textOut.experiences[0].facts.length === 1 && textOut.dropped_unverifiable === 1)

// ─── Report ──────────────────────────────────────────────────────────────────

console.log(`\ntest-career-evidence: ${passed} passed, ${failed} failed`)
for (const f of failures) console.log(`  FAIL ${f}`)
process.exit(failed === 0 ? 0 : 1)
