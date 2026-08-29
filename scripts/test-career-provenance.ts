// Deterministic tests for provenance and the importer-sees-the-bank flow:
// source labels, the importer's project validation, filing under existing
// experiences, and the bank lookups that join provenance rows to sources.
// No network, no keys, no database.
//
//   npx tsx scripts/test-career-provenance.ts

import { validateImporterOutput, type ResumeImporterInput } from '../lib/agents/resume-importer'
import { resumeImporterPrompt } from '../lib/agents/resume-importer/prompt'
import { existingExperienceInputs, foldOutput, type ImportProposal } from '../lib/career/evidence/import'
import { normalizeOrg, normalizeTitle } from '../lib/career/evidence/normalize'
import { checkFilingHint, planPersist } from '../lib/career/evidence/plan'
import { defaultSourceLabel, sourceKindFor, splitSourceLocation } from '../lib/career/evidence/sources'
import { emptyBank, projectsForExperience, sourceLabelsForFact, sourcesForExperience } from '../lib/career/evidence/store'
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

// ─── Source labels ───────────────────────────────────────────────────────────

check('splitSourceLocation: résumé paragraph', JSON.stringify(splitSourceLocation('master_resume', 'Zuyu_Resume.docx ¶6')) === JSON.stringify({ label: 'Zuyu_Resume.docx', location: '¶6' }))
check('splitSourceLocation: pasted line', JSON.stringify(splitSourceLocation('linkedin', 'pasted.linkedin L350')) === JSON.stringify({ label: 'pasted.linkedin', location: 'L350' }))
check('splitSourceLocation: no location falls back to source', JSON.stringify(splitSourceLocation('manual', null)) === JSON.stringify({ label: 'manual', location: null }))
check('splitSourceLocation: label without index', splitSourceLocation('profile', 'profile.personal_context').label === 'profile.personal_context')
check('sourceKindFor: linkedin', sourceKindFor('linkedin') === 'linkedin_profile')
check('sourceKindFor: manual', sourceKindFor('manual') === 'pasted_context')
check('sourceKindFor: profile', sourceKindFor('profile') === 'profile_field')
check('sourceKindFor: project_notes', sourceKindFor('project_notes') === 'notes')
check('sourceKindFor: résumé', sourceKindFor('master_resume') === 'resume' && sourceKindFor('alternate_resume') === 'resume')
check('defaultSourceLabel: kind + date', defaultSourceLabel('linkedin_profile', new Date('2026-08-28T12:00:00Z')) === 'LinkedIn profile pasted 2026-08-28')

// ─── A bank with provenance rows ─────────────────────────────────────────────

const now = '2026-08-28T00:00:00Z'
function exp(id: string, organization: string, title: string, start_date: string | null, end_date: string | null, extra: Partial<EvidenceExperience> = {}): EvidenceExperience {
  return { id, user_id: 'u', kind: 'experience', organization, title, start_date, end_date, location: null, description: null, display_order: 0, source: 'master_resume', approved: true, created_at: now, updated_at: now, ...extra }
}
function fact(id: string, experience_id: string, statement: string, extra: Partial<EvidenceFact> = {}): EvidenceFact {
  return { id, user_id: 'u', experience_id, statement, category: 'achievement', source: 'master_resume', source_location: 'Zuyu_Resume.docx ¶12', confidence: 1, approved: true, created_at: now, updated_at: now, ...extra }
}
function bankWithProvenance(): EvidenceBank {
  const b = emptyBank()
  b.experiences.push(
    exp('exp-founders', 'Founders: Illinois Entrepreneurs', 'President (previously Head of Events)', '8/2025', 'Present'),
    exp('exp-png', 'Procter & Gamble', 'Quality Assurance Intern', '5/2026', '8/2026'),
    exp('exp-old', 'Acme', 'Intern', '2020', '2020', { status: 'merged', merged_into: 'exp-png' })
  )
  b.facts.push(
    fact('fact-forge', 'exp-founders', 'Organized Forge 2026.'),
    fact('fact-legacy', 'exp-png', 'Wrote the SOP.', { source_location: 'Zuyu_Resume.docx ¶4' }),
    fact('fact-gone', 'exp-png', 'Old wording', { status: 'merged', merged_into: 'fact-legacy' })
  )
  b.sources.push(
    { id: 'src-resume', user_id: 'u', kind: 'resume', label: 'Zuyu_Resume.docx', sha256: 'a', content: null, storage_path: null, resume_document_id: null, metadata: {}, imported_at: now },
    { id: 'src-li', user_id: 'u', kind: 'linkedin_profile', label: 'LinkedIn export', sha256: 'b', content: null, storage_path: null, resume_document_id: null, metadata: {}, imported_at: now }
  )
  b.factSources.push(
    { id: 'fs1', user_id: 'u', fact_id: 'fact-forge', source_id: 'src-resume', location: '¶12', quote: 'Organized Forge 2026.', confidence: 1, created_at: now },
    { id: 'fs2', user_id: 'u', fact_id: 'fact-forge', source_id: 'src-li', location: 'L350', quote: 'organized forge 2026', confidence: 1, created_at: now }
  )
  b.experienceSources = [{ id: 'es1', user_id: 'u', experience_id: 'exp-founders', source_id: 'src-resume', location: null, title_as_written: 'President', dates_as_written: '8/2025 – Present', created_at: now }]
  b.projects.push(
    { id: 'prj-forge', user_id: 'u', experience_id: 'exp-founders', organization_id: null, name: 'Forge 2026', name_norm: 'forge 2026', description: null, fact_ids: ['fact-forge'], approved: true, status: 'active', merged_into: null, created_at: now, updated_at: now },
    { id: 'prj-dead', user_id: 'u', experience_id: 'exp-founders', organization_id: null, name: 'Forge', name_norm: 'forge', description: null, fact_ids: [], approved: true, status: 'merged', merged_into: 'prj-forge', created_at: now, updated_at: now }
  )
  return b
}
const pb = bankWithProvenance()

check('sourceLabelsForFact: joins provenance to sources', JSON.stringify(sourceLabelsForFact(pb, pb.facts[0])) === JSON.stringify(['Zuyu_Resume.docx ¶12', 'LinkedIn export L350']), JSON.stringify(sourceLabelsForFact(pb, pb.facts[0])))
check('sourceLabelsForFact: legacy fallback when no provenance rows', JSON.stringify(sourceLabelsForFact(pb, pb.facts[1])) === JSON.stringify(['Zuyu_Resume.docx ¶4']))
check('sourceLabelsForFact: fallback to source when no location', JSON.stringify(sourceLabelsForFact(emptyBank(), fact('x', 'e', 's', { source_location: null, source: 'manual' }))) === JSON.stringify(['manual']))
check('sourcesForExperience: experience rows first, then fact sources', sourcesForExperience(pb, 'exp-founders').map((s) => s.id).join(',') === 'src-resume,src-li')
check('sourcesForExperience: none', sourcesForExperience(pb, 'exp-png').length === 0)
check('projectsForExperience: tombstones excluded', projectsForExperience(pb, 'exp-founders').map((p) => p.id).join(',') === 'prj-forge')

// ─── Importer: existing experiences and projects ─────────────────────────────

const existing = existingExperienceInputs(pb.experiences.filter((e) => e.status !== 'merged').map((e) => ({ id: e.id, kind: e.kind, organization: e.organization, title: e.title, start_date: e.start_date, end_date: e.end_date, location: e.location })))
check('existingExperienceInputs: key is the row id, no paragraphs', existing[0].key === 'exp-founders' && existing[0].existing_id === 'exp-founders' && existing[0].bullets.length === 0)

const LI_LINES = [
  'President, Founders: Illinois Entrepreneurs · Aug 2025 – Present',
  'Organized Forge 2026, the largest AI hackathon in UIUC history with 400+ participants',
  'Launched Keywords, a founder-matching product',
  'Quality Assurance Intern, P&G · May 2026 – Aug 2026',
  'Built a Controlled State system for the Beauty Packing line',
]
const textInput: ResumeImporterInput = {
  allow_new_experiences: true,
  experiences: existing,
  extra_sources: [{ label: 'pasted.linkedin', lines: LI_LINES.map((text, i) => ({ paragraph_index: i, text })) }],
}
const prompt = resumeImporterPrompt.build(textInput)
check('prompt: version bumped', resumeImporterPrompt.version !== '1.0.0')
check('prompt: existing rows shown by id', prompt.user.includes('[key: exp-founders]') && prompt.system.includes('EXISTING EXPERIENCES'))
check('prompt: projects only when named', prompt.system.includes('ONLY when the text names it'))

const modelOut = {
  experiences: [
    {
      experience_key: 'exp-founders',
      summary: 'President of Founders.',
      new_experience: { title: 'President', organization: 'Founders: Illinois Entrepreneurs', location: null, start_date: 'Aug 2025', end_date: 'Present', kind: 'leadership' },
      facts: [
        { statement: 'Organized Forge 2026', category: 'achievement', source_label: 'pasted.linkedin', paragraph_index: 1, confidence: 1 },
        { statement: 'Forge 2026 had 400+ participants', category: 'metric', source_label: 'pasted.linkedin', paragraph_index: 1, confidence: 1 },
        { statement: 'Launched Keywords', category: 'achievement', source_label: 'pasted.linkedin', paragraph_index: 2, confidence: 1 },
      ],
      metrics: [], skills: [], deliverables: [],
    },
    {
      experience_key: 'exp-png',
      summary: 'QA intern.',
      new_experience: null,
      facts: [{ statement: 'Built a Controlled State system for the Beauty Packing line', category: 'achievement', source_label: 'pasted.linkedin', paragraph_index: 4, confidence: 1 }],
      metrics: [], skills: [], deliverables: [],
    },
  ],
  projects: [
    { name: 'Forge 2026', experience_ref: 0, description: 'AI hackathon', fact_refs: [0, 1] },
    { name: 'Keywords', experience_ref: 'exp-founders', description: null, fact_refs: [2] },
    { name: 'CoLini', experience_ref: 0, description: 'never mentioned', fact_refs: [] },
    { name: 'Controlled State', experience_ref: 'not-a-key', description: null, fact_refs: [] },
  ],
}
const out = validateImporterOutput(modelOut, textInput)
check('validate: output accepted', out !== null)
if (out) {
  check('validate: as-written role kept on an existing key', out.experiences[0].new_experience?.title === 'President' && out.experiences[1].new_experience === null)
  check('validate: named projects kept', out.projects.map((p) => p.name).join(',') === 'Forge 2026,Keywords', JSON.stringify(out.projects))
  check('validate: un-named project dropped', !out.projects.some((p) => p.name === 'CoLini') && out.dropped_projects === 2, `dropped=${out.dropped_projects}`)
  check('validate: project resolves index and id refs', out.projects[0].experience_key === 'exp-founders' && out.projects[1].experience_key === 'exp-founders')
  check('validate: project fact_refs survive remap', out.projects[0].fact_refs.join(',') === '0,1' && out.projects[1].fact_refs.join(',') === '2')

  const proposal: ImportProposal = { experiences: [], bullets: [], facts: [], metrics: [], skills: [], deliverables: [], projects: [], dropped: { unverifiable: 0, metrics: 0, skills: 0, misfiled: 0, experiences: 0, projects: 0 }, trace: null, agentError: null, model: null }
  const existingRows = pb.experiences.filter((e) => e.status !== 'merged')
  foldOutput(proposal, out, { filename: 'pasted.linkedin', extra: [{ label: 'pasted.linkedin', source: 'linkedin', text: LI_LINES.join('\n') }], textSource: 'linkedin', existing: existingRows })
  check('fold: existing-id blocks become hinted proposals', proposal.experiences.length === 2 && proposal.experiences[0].existingId === 'exp-founders' && proposal.experiences[0].title === 'President' && proposal.experiences[0].start_date === 'Aug 2025')
  check('fold: block without as-written uses the row values', proposal.experiences[1].existingId === 'exp-png' && proposal.experiences[1].title === 'Quality Assurance Intern' && proposal.experiences[1].start_date === '5/2026')
  check('fold: projects lifted to proposal fact indexes', proposal.projects.length === 2 && proposal.projects[0].fact_refs.join(',') === '0,1' && proposal.projects[1].fact_refs.join(',') === '2')
  check('fold: facts carry the pasted source', proposal.facts.every((f) => f.source === 'linkedin' && f.source_location.startsWith('pasted.linkedin L')))

  // The plan: résumé rows, then LinkedIn text filed under them → 0 new experiences.
  const plan = planPersist(pb, proposal)
  check('plan: LinkedIn text after résumé creates 0 new experiences', plan.experiences.every((d) => d.action === 'reuse'), JSON.stringify(plan.experiences))
  check('plan: hinted reuse is reported as agent_filed', plan.matched.some((m) => m.existingId === 'exp-founders' && m.rule === 'agent_filed'))
  check('plan: reused fact is corroborated', plan.facts[0].action === 'reuse' && plan.corroborated.some((c) => c.factId === 'fact-forge' && c.source === 'linkedin'), JSON.stringify(plan.corroborated))
  check('plan: new claims under the reused row are inserted', plan.facts[1].action === 'insert' && plan.facts[2].action === 'insert')
}

// ─── The hint is a signal, not the decider ───────────────────────────────────

const rows = pb.experiences.filter((e) => e.status !== 'merged')
const hintOk = checkFilingHint(rows, { organization: 'Founders', title: 'President', start_date: null, end_date: null, existingId: 'exp-founders' })
check('hint: same org, same title → reuse', hintOk.match?.rule === 'agent_filed')
const hintDates = checkFilingHint(rows, { organization: 'P&G', title: 'Quality Assurance Intern', start_date: '5/2025', end_date: '8/2025', existingId: 'exp-png' })
check('hint: incompatible dates → rejected with a near miss', hintDates.match === null && hintDates.nearMiss?.candidateId === 'exp-png')
const hintVp = checkFilingHint(rows, { organization: 'Founders: Illinois Entrepreneurs', title: 'Vice President', start_date: null, end_date: null, existingId: 'exp-founders' })
check('hint: Vice President never reuses President', hintVp.match === null && hintVp.nearMiss !== null)
const hintHoe = checkFilingHint(rows, { organization: 'Founders: Illinois Entrepreneurs', title: 'Head of Events', start_date: '1/2025', end_date: '8/2025', existingId: 'exp-founders' })
check('hint: Head of Events never reuses President', hintHoe.match === null)
check('hint: unknown id is ignored', checkFilingHint(rows, { organization: 'X', title: 'Y', start_date: null, end_date: null, existingId: 'nope' }).match === null && checkFilingHint(rows, { organization: 'X', title: 'Y', start_date: null, end_date: null, existingId: 'nope' }).nearMiss === null)
check('hint: wrong org is rejected', checkFilingHint(rows, { organization: 'Pacific Gas', title: 'Quality Assurance Intern', start_date: '5/2026', end_date: '8/2026', existingId: 'exp-png' }).match === null)

function hinted(organization: string, title: string, start: string | null, end: string | null, existingId: string): ImportProposal {
  return {
    experiences: [{ key: existingId, kind: 'experience', organization, title, location: null, start_date: start, end_date: end, description: null, display_order: 0, source: 'linkedin', bulletParagraphIndexes: [], identityParagraphIndex: null, summary: null, existingId }],
    bullets: [], facts: [], metrics: [], skills: [], deliverables: [], projects: [],
    dropped: { unverifiable: 0, metrics: 0, skills: 0, misfiled: 0, experiences: 0, projects: 0 }, trace: null, agentError: null, model: null,
  }
}
const pDates = planPersist(pb, hinted('P&G', 'Quality Assurance Intern', '5/2025', '8/2025', 'exp-png'))
check('plan: hinted block with incompatible dates → new experience + near miss', pDates.experiences[0].action === 'insert' && pDates.nearMisses.length === 1 && pDates.nearMisses[0].candidateId === 'exp-png', JSON.stringify(pDates))
const pVp = planPersist(pb, hinted('Founders: Illinois Entrepreneurs', 'Vice President', null, null, 'exp-founders'))
check('plan: hinted VP → insert, never reuse', pVp.experiences[0].action === 'insert' && pVp.nearMisses.length === 1)
const pHoe = planPersist(pb, hinted('Founders: Illinois Entrepreneurs', 'Head of Events', '1/2025', '8/2025', 'exp-founders'))
check('plan: hinted Head of Events → insert, never reuse', pHoe.experiences[0].action === 'insert' && pHoe.matched.length === 0)
const pHist = planPersist(pb, hinted('Founders - Illinois Entrepreneurs', 'President; Formerly Head of Events', 'Aug 2025', 'Present', 'exp-founders'))
check('plan: "President; Formerly Head of Events" is the President row', pHist.experiences[0].action === 'reuse' && pHist.experiences[0].existingId === 'exp-founders')
check('plan: tombstoned row is never a match target', planPersist(pb, hinted('Acme', 'Intern', '2020', '2020', 'exp-old')).experiences[0].action === 'insert')

// Conflict detection inputs: the same normalizers persist.ts uses.
check('conflict: "President" vs "President (previously Head of Events)" is not a title conflict', normalizeTitle('President') === normalizeTitle('President (previously Head of Events)'))
check('conflict: "Procter & Gamble, Tabler Station" vs "P&G" is not an org conflict', normalizeOrg('Procter & Gamble, Tabler Station') === normalizeOrg('P&G'))

// ─── Report ──────────────────────────────────────────────────────────────────

console.log(`\ntest-career-provenance: ${passed} passed, ${failed} failed`)
for (const f of failures) console.log(`  FAIL ${f}`)
process.exit(failed === 0 ? 0 : 1)
