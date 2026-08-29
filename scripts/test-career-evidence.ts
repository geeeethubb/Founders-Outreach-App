// Deterministic tests for the Evidence Bank: retrieval ranking, the number
// check, the importer's validator, and the persist plan's matching. No network, no keys, no database.
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
import type { EvidenceBank, EvidenceExperience, EvidenceFact, FactSource } from '../lib/career/types'
import {
  datesCompatible,
  experienceKey,
  normalizeMetricValue,
  normalizeOrg,
  normalizeStatement,
  normalizeTitle,
  orgQualifier,
  parseResumeDate,
  titleSimilarity,
} from '../lib/career/evidence/normalize'
import { SIMILAR_TITLE_THRESHOLD, checkFilingHint, findExperienceMatch, findFactMatch, planPersist, qualifiersConflict } from '../lib/career/evidence/plan'
import type { ImportProposal, ProposedExperience, ProposedFact, ProposedMetric } from '../lib/career/evidence/import'

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

// ─── Normalization and the persist plan ──────────────────────────────────────
//
// planPersist is the pure half of persistProposal: given a bank and a
// proposal it decides every reuse, insert, near-miss and corroboration
// without a database. These are the cases the audit found doubled in the
// founder's bank.

check('normalizeOrg: P&G == Procter & Gamble', normalizeOrg('P&G') === normalizeOrg('Procter & Gamble'))
check('normalizeOrg: site qualifier folds', normalizeOrg('Procter & Gamble, Tabler Station') === normalizeOrg('Procter & Gamble'))
check('normalizeOrg: parenthetical + dash variants', normalizeOrg('Founders: Illinois Entrepreneurs (UIUC)') === normalizeOrg('Founders — Illinois Entrepreneurs'))
check('normalizeOrg: UIUC == full name', normalizeOrg('UIUC') === normalizeOrg('University of Illinois at Urbana-Champaign'))
check('normalizeOrg: legal suffix and leading the', normalizeOrg('The Acme Co.') === 'acme')
check('normalizeOrg: diacritics', normalizeOrg('Société Générale') === 'societe generale')
check('normalizeOrg: unrelated orgs stay apart', normalizeOrg('Argonne National Laboratory') !== normalizeOrg('Illinois Business Consulting'))

check('normalizeTitle: drops org qualifier', normalizeTitle('President, Founders') === 'president')
check('normalizeTitle: drops previous role', normalizeTitle('Project Manager, prev. Senior Consultant') === 'project manager')
check('normalizeTitle: semicolon clause', normalizeTitle('President; Formerly Head of Events') === 'president')
check('normalizeTitle: parenthetical history', normalizeTitle('President (previously Head of Events, Events Team Member)') === 'president')
check('normalizeTitle: parenthetical previous roles', normalizeTitle('Project Manager (previously Senior Consultant, Consultant)') === 'project manager')
check('normalizeTitle: slash is not a separator (CEO vs CTO)', normalizeTitle('Co-Founder / CEO') !== normalizeTitle('Co-Founder / CTO'))
check('qualifiersConflict: two labs', qualifiersConflict("University of Illinois (Professor Mironenko's lab)", "University of Illinois (Professor Flaherty's lab)"))
check('qualifiersConflict: one side unqualified is not a conflict', !qualifiersConflict('University of Illinois', "University of Illinois (Professor Flaherty's lab)"))
check('qualifiersConflict: acronym is not a qualifier', !qualifiersConflict('Founders: Illinois Entrepreneurs (UIUC)', 'Founders: Illinois Entrepreneurs'))
check('normalizeOrg: Founders dash / colon / (UIUC) meet', new Set([normalizeOrg('Founders - Illinois Entrepreneurs'), normalizeOrg('Founders: Illinois Entrepreneurs'), normalizeOrg('Founders: Illinois Entrepreneurs (UIUC)')]).size === 1)
check('normalizeOrg: P&G three spellings meet', new Set([normalizeOrg('Procter & Gamble, Tabler Station'), normalizeOrg('Procter & Gamble'), normalizeOrg('P&G')]).size === 1)
check('normalizeOrg: PG Solutions is not P&G', normalizeOrg('PG Solutions') !== normalizeOrg('P&G'))
check('normalizeOrg: Pacific Gas is not P&G', normalizeOrg('Pacific Gas') !== normalizeOrg('Procter & Gamble'))
check('orgQualifier: lab in parentheses', orgQualifier("University of Illinois (Professor Alex Mironenko's lab)") === "Professor Alex Mironenko's lab")
check('orgQualifier: acronym is not a qualifier', orgQualifier('Founders: Illinois Entrepreneurs (UIUC)') === '')
check('orgQualifier: site after comma', orgQualifier('Procter & Gamble, Tabler Station') === 'Tabler Station')
check('orgQualifier: two labs differ', orgQualifier('UIUC (Mironenko lab)') !== orgQualifier('UIUC (Flaherty lab)'))
check('experienceKey: aliases meet', experienceKey('P&G', 'Quality Assurance Intern') === experienceKey('Procter & Gamble', 'Quality Assurance Intern'))

check('titleSimilarity: identical', titleSimilarity('President', 'President') === 1)
check('titleSimilarity: containment counts as 1', titleSimilarity('Project Manager', 'Senior Project Manager') === 1)
check('titleSimilarity: disjoint is 0', titleSimilarity('Head of Events', 'President') === 0)
check('titleSimilarity: partial', titleSimilarity('Process Engineering Intern', 'Process Intern') >= SIMILAR_TITLE_THRESHOLD && titleSimilarity('Quality Assurance Engineer', 'Quality Assurance Intern') === 0.5)
// Containment is not identity when the extra word changes the job.
check('titleSimilarity: Vice President is not President', titleSimilarity('Vice President', 'President') < SIMILAR_TITLE_THRESHOLD)
check('titleSimilarity: Software Intern is not every Intern', titleSimilarity('Intern', 'Software Intern') < SIMILAR_TITLE_THRESHOLD)
check('titleSimilarity: co-president is president', titleSimilarity('Co-President', 'President') === 1)

check('parseResumeDate: 5/2026', JSON.stringify(parseResumeDate('5/2026')) === JSON.stringify({ year: 2026, month: 5 }))
check('parseResumeDate: May 2026', JSON.stringify(parseResumeDate('May 2026')) === JSON.stringify({ year: 2026, month: 5 }))
check('parseResumeDate: Present', parseResumeDate('Present') === 'present')
check('parseResumeDate: garbage is null', parseResumeDate('n/a') === null)
check('datesCompatible: null side', datesCompatible({ start_date: null, end_date: null }, { start_date: '5/2026', end_date: '8/2026' }))
check('datesCompatible: overlap', datesCompatible({ start_date: '5/2026', end_date: '8/2026' }, { start_date: 'Jun 2026', end_date: 'Present' }))
check('datesCompatible: touching months', datesCompatible({ start_date: '1/2025', end_date: '5/2025' }, { start_date: '5/2025', end_date: '8/2025' }))
check('datesCompatible: disjoint summers', !datesCompatible({ start_date: '5/2025', end_date: '8/2025' }, { start_date: '5/2026', end_date: '8/2026' }))
check('datesCompatible: bare years', datesCompatible({ start_date: '2024', end_date: 'Present' }, { start_date: '9/2024', end_date: null }))

check('normalizeStatement: case, period', normalizeStatement('Organized Forge 2026.') === normalizeStatement('organized forge 2026'))
check('normalizeStatement: quotes, dashes, markdown', normalizeStatement('Led “Forge” — a **hackathon**') === 'led "forge" - a hackathon')
check('normalizeStatement: different claims differ', normalizeStatement('Hosted an AI hackathon with 200+ participants') !== normalizeStatement('Organized the largest AI hackathon in UIUC history'))
check('normalizeMetricValue: $4M+ == 4M', normalizeMetricValue('$4M+') === normalizeMetricValue('4M'))
check('normalizeMetricValue: 4 million == 4M', normalizeMetricValue('4 million') === normalizeMetricValue('$4M'))
check('normalizeMetricValue: 1,600+ == 1600', normalizeMetricValue('1,600+') === '1600')
check('normalizeMetricValue: M vs B differ', normalizeMetricValue('4M') !== normalizeMetricValue('4B'))

// A bank as the DOCX seed leaves it.
function planBank(): EvidenceBank {
  const b = emptyBank()
  const now = '2026-08-27T00:00:00Z'
  const exp = (id: string, organization: string, title: string, start_date: string | null, end_date: string | null): EvidenceExperience => ({
    id, user_id: 'u', kind: 'experience', organization, title, start_date, end_date, location: null, description: null,
    display_order: 0, source: 'master_resume', approved: true, created_at: now, updated_at: now,
  })
  b.experiences.push(
    exp('exp-founders', 'Founders: Illinois Entrepreneurs', 'President; Formerly Head of Events', '8/2025', 'Present'),
    exp('exp-png-2025', 'Procter & Gamble', 'Quality Assurance Intern', '5/2025', '8/2025'),
    exp('exp-uiuc', 'University of Illinois Urbana-Champaign', 'Undergraduate Researcher', '9/2024', 'Present')
  )
  b.facts.push({
    id: 'fact-forge', user_id: 'u', experience_id: 'exp-founders', statement: 'Organized Forge 2026.', category: 'achievement',
    source: 'master_resume', source_location: 'resume.docx ¶12', confidence: 1, approved: true, created_at: now, updated_at: now,
  })
  b.metrics.push({ id: 'm-4m', user_id: 'u', experience_id: 'exp-png-2025', value: '$4M+', unit: 'projected savings', context: null, fact_ids: [], source: 'master_resume', approved: true, created_at: now })
  return b
}

function proposalWith(experiences: ProposedExperience[], facts: ProposedFact[] = [], metrics: ProposedMetric[] = []): ImportProposal {
  return { experiences, bullets: [], facts, metrics, skills: [], deliverables: [], projects: [], dropped: { unverifiable: 0, metrics: 0, skills: 0, misfiled: 0, experiences: 0, projects: 0 }, trace: null, agentError: null, model: null }
}
function pexp(key: string, organization: string, title: string, start_date: string | null = null, end_date: string | null = null): ProposedExperience {
  return { key, kind: 'experience', organization, title, location: null, start_date, end_date, description: null, display_order: 0, source: 'linkedin', bulletParagraphIndexes: [], identityParagraphIndex: null, summary: null }
}
function pfact(experience_key: string, statement: string, source: FactSource = 'linkedin', source_location = 'pasted.linkedin L3'): ProposedFact {
  return { experience_key, statement, category: 'achievement', source, source_location, paragraph_index: null, confidence: 1 }
}

const pb = planBank()

// LinkedIn spelling of the DOCX's Founders role → one experience.
const p1 = planPersist(pb, proposalWith([pexp('li-founders', 'Founders — Illinois Entrepreneurs (UIUC)', 'President')]))
check('plan: LinkedIn Founders block reuses the DOCX row', p1.experiences[0].action === 'reuse' && p1.experiences[0].existingId === 'exp-founders', JSON.stringify(p1.experiences[0]))
check('plan: alias match is reported', p1.matched.length === 1 && p1.matched[0].rule === 'alias' && p1.nearMisses.length === 0)

// Head of Events vs President at the same org → two rows, no merge.
const p2 = planPersist(pb, proposalWith([pexp('li-events', 'Founders: Illinois Entrepreneurs', 'Head of Events', '1/2025', '8/2025')]))
check('plan: different title at same org is inserted', p2.experiences[0].action === 'insert' && p2.matched.length === 0)

// Two P&G internships in different summers → two rows even with the same title.
const p3 = planPersist(pb, proposalWith([pexp('li-png-2026', 'P&G', 'Quality Assurance Intern', '5/2026', '8/2026')]))
check('plan: same title, disjoint dates → insert', p3.experiences[0].action === 'insert', JSON.stringify(p3.experiences[0]))
check('plan: same title, same dates → exact reuse (re-import is idempotent)', planPersist(pb, proposalWith([pexp('x', 'Procter & Gamble', 'Quality Assurance Intern', '5/2025', '8/2025')])).experiences[0].action === 'reuse')

// Same org, similar title, overlapping dates → one.
const p4 = planPersist(pb, proposalWith([pexp('li-png', 'Procter & Gamble', 'Quality Assurance Summer Intern', 'Jun 2025', 'Aug 2025')]))
check('plan: similar title + compatible dates → reuse', p4.experiences[0].action === 'reuse' && p4.experiences[0].existingId === 'exp-png-2025' && p4.matched[0]?.rule === 'similar_title', JSON.stringify(p4))

// Promotion at the same org with no dates (a text import): two rows, reported, never merged.
const pVp = planPersist(pb, proposalWith([pexp('li-vp', 'Founders: Illinois Entrepreneurs', 'Vice President')]))
check('plan: Vice President at the org of a President → insert + near-miss', pVp.experiences[0].action === 'insert' && pVp.matched.length === 0 && pVp.nearMisses.length === 1, JSON.stringify(pVp))

// Near miss: same org, similarity in [0.3, 0.6) → inserted AND reported.
const p5 = planPersist(pb, proposalWith([pexp('li-png-eng', 'Procter & Gamble', 'Quality Assurance Engineer', '5/2025', '8/2025')]))
check('plan: near-miss is inserted', p5.experiences[0].action === 'insert')
check('plan: near-miss is reported with the candidate', p5.nearMisses.length === 1 && p5.nearMisses[0].candidateId === 'exp-png-2025', JSON.stringify(p5.nearMisses))

// Within one proposal, two blocks with the same key collapse; their facts land under one experience.
const p6 = planPersist(pb, proposalWith(
  [pexp('a', 'Acme Corp', 'Engineering Intern', '2025', null), pexp('b', 'Acme', 'Engineering Intern', '2025', null)],
  [pfact('a', 'Reduced downtime 12%'), pfact('b', 'Reduced downtime 12%'), pfact('b', 'Wrote the SOP')]
))
check('plan: duplicate block collapses into the first', p6.experiences[0].action === 'insert' && p6.experiences[1].action === 'collapse' && p6.experiences[1].intoKey === 'a')
check('plan: facts under the collapsed block dedupe against the first', p6.facts[0].action === 'insert' && p6.facts[1].action === 'collapse' && p6.facts[2].action === 'insert', JSON.stringify(p6.facts))
check('plan: fact under a new experience never matches an orphan bank fact', planPersist(
  { ...pb, facts: [{ ...pb.facts[0], id: 'orphan', experience_id: null }] },
  proposalWith([pexp('n', 'Nowhere Labs', 'Intern')], [pfact('n', 'Organized Forge 2026')])
).facts[0].action === 'insert')

// Two P&G summers pasted TOGETHER: same key, disjoint dates → two inserts, never a collapse.
const pTwoSummers = planPersist(emptyBank(), proposalWith([
  pexp('png-2025', 'P&G', 'Quality Assurance Intern', '5/2025', '8/2025'),
  pexp('png-2026', 'Procter & Gamble', 'Quality Assurance Intern', '5/2026', '8/2026'),
]))
check('plan: two summers in one paste stay two rows', pTwoSummers.experiences.every((d) => d.action === 'insert'), JSON.stringify(pTwoSummers.experiences))
// Bank holds 2025; the paste lists 2026 first, then 2025 → 2026 inserts, 2025 reuses the bank row.
const pOrder = planPersist(pb, proposalWith([
  pexp('k1', 'P&G', 'Quality Assurance Intern', '5/2026', '8/2026'),
  pexp('k2', 'P&G', 'Quality Assurance Intern', '5/2025', '8/2025'),
], [pfact('k2', 'Wrote the line SOP')]))
check('plan: later block reaches the bank row past an incompatible earlier block', pOrder.experiences[0].action === 'insert' && pOrder.experiences[1].action === 'reuse' && pOrder.experiences[1].existingId === 'exp-png-2025', JSON.stringify(pOrder.experiences))
// Two labs at one university, same title, overlapping dates → two rows + a near miss; the filing hint is rejected too.
const labBank: EvidenceBank = { ...pb, experiences: [...pb.experiences, { ...pb.experiences[2], id: 'lab-m', organization: "University of Illinois (Professor Mironenko's lab)" }] }
const flaherty = pexp('lab-f', "University of Illinois (Professor Flaherty's lab)", 'Undergraduate Researcher', '1/2026', 'Present')
const pLabs = planPersist({ ...labBank, experiences: labBank.experiences.filter((e) => e.id !== 'exp-uiuc') }, proposalWith([flaherty]))
check('plan: a second lab at the same university is inserted', pLabs.experiences[0].action === 'insert' && pLabs.matched.length === 0, JSON.stringify(pLabs.experiences))
check('plan: the second lab is reported as a near miss of the first', pLabs.nearMisses.length === 1 && pLabs.nearMisses[0].candidateId === 'lab-m', JSON.stringify(pLabs.nearMisses))
check('plan: filing hint at the other lab is rejected', checkFilingHint(labBank.experiences, { ...flaherty, existingId: 'lab-m' }).match === null)
check('plan: unqualified university row still matches a lab-qualified block', checkFilingHint(labBank.experiences, { ...flaherty, existingId: 'exp-uiuc' }).match?.id === 'exp-uiuc')
check('plan: two labs in one paste do not collapse', planPersist(emptyBank(), proposalWith([
  pexp('m', "UIUC (Professor Mironenko's lab)", 'Undergraduate Researcher', '9/2024', 'Present'), flaherty,
])).experiences.every((d) => d.action === 'insert'))
// Co-Founder / CEO and Co-Founder / CTO at one org are two people’s jobs, not one.
check('plan: CEO and CTO co-founders do not collapse', planPersist(emptyBank(), proposalWith([
  pexp('ceo', 'Acme', 'Co-Founder / CEO'), pexp('cto', 'Acme', 'Co-Founder / CTO'),
])).experiences.every((d) => d.action === 'insert'))

// Fact dedupe with corroboration.
const p7 = planPersist(pb, proposalWith([pexp('li-founders', 'Founders', 'President')], [
  pfact('li-founders', 'organized forge 2026'),
  pfact('li-founders', 'Hosted an AI hackathon with 200+ participants'),
  pfact('li-founders', 'Organized the largest AI hackathon in UIUC history'),
]))
check('plan: same claim, different spelling → reused', p7.facts[0].action === 'reuse' && p7.facts[0].existingId === 'fact-forge')
check('plan: second source is recorded as corroboration', p7.corroborated.length === 1 && p7.corroborated[0].factId === 'fact-forge' && p7.corroborated[0].source === 'linkedin', JSON.stringify(p7.corroborated))
check('plan: different claims stay two facts', p7.facts[1].action === 'insert' && p7.facts[2].action === 'insert')
check('plan: same source is not a corroboration', planPersist(pb, proposalWith([pexp('li-founders', 'Founders', 'President')], [pfact('li-founders', 'Organized Forge 2026.', 'master_resume', 'resume.docx ¶12')])).corroborated.length === 0)

// Metrics: '$4M+' vs '4M' under the same experience → one; within-proposal duplicates → one.
const p8 = planPersist(pb, proposalWith([pexp('li-png', 'P&G', 'Quality Assurance Intern', '5/2025', '8/2025')], [], [
  { experience_key: 'li-png', value: '4M', unit: 'savings', context: null, fact_refs: [], source: 'linkedin' },
  { experience_key: 'li-png', value: '1,600+', unit: 'hours', context: null, fact_refs: [], source: 'linkedin' },
  { experience_key: 'li-png', value: '1600', unit: 'hours', context: null, fact_refs: [], source: 'linkedin' },
]))
check('plan: metric $4M+ vs 4M → skipped', p8.metrics[0] === false)
check('plan: within-proposal metric duplicate → one', p8.metrics[1] === true && p8.metrics[2] === false)

// Manual add (the rows route): the pure lookups it uses.
check('manual add: fact with same normalized statement is found', findFactMatch(pb.facts, 'exp-founders', 'Organized Forge 2026')?.id === 'fact-forge')
check('manual add: fact under another experience is not found', findFactMatch(pb.facts, 'exp-uiuc', 'Organized Forge 2026') === null)
check('manual add: experience by alias, no similar-title guessing', findExperienceMatch(pb.experiences, { organization: 'UIUC', title: 'Undergraduate Researcher', start_date: null, end_date: null }, { allowSimilar: false }).match?.rule === 'alias')
check('manual add: distinct title typed by a human is not matched', findExperienceMatch(pb.experiences, { organization: 'UIUC', title: 'Undergraduate Research Assistant', start_date: null, end_date: null }, { allowSimilar: false }).match === null)
check('manual add: exact key reports exact', findExperienceMatch(pb.experiences, { organization: 'Procter & Gamble', title: 'Quality Assurance Intern', start_date: null, end_date: null }).match?.rule === 'exact')

// ─── Report ──────────────────────────────────────────────────────────────────

console.log(`\ntest-career-evidence: ${passed} passed, ${failed} failed`)
for (const f of failures) console.log(`  FAIL ${f}`)
process.exit(failed === 0 ? 0 : 1)
