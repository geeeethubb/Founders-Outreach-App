// Deterministic tests for provenance and the importer-sees-the-bank flow:
// source labels, the importer's project validation, filing under existing
// experiences, and the bank lookups that join provenance rows to sources.
// No network, no keys, no database.
//
//   npx tsx scripts/test-career-provenance.ts

import { sharedContentWords, validateImporterOutput, type ResumeImporterInput } from '../lib/agents/resume-importer'
import { resumeImporterPrompt } from '../lib/agents/resume-importer/prompt'
import { confidenceFor, introducesNumbers, isFullSupport, supportLevel } from '../lib/career/evidence/corroborate'
import { EXISTING_FACTS_PER_EXPERIENCE, existingExperienceInputs, existingFromBank, foldOutput, type ImportProposal, type ProposedFact } from '../lib/career/evidence/import'
import { normalizeOrg, normalizeTitle } from '../lib/career/evidence/normalize'
import { checkFilingHint, findFactMatch, planPersist, resolveFactDecision } from '../lib/career/evidence/plan'
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

// ─── Corroboration: the importer sees existing facts, the code grades support ──
//
// The live failure this guards: a LinkedIn post repeating a résumé fact word
// for word was atomized into two facts, neither matched the exact-statement
// rule, 8 rows were inserted and 0 corroborated. Now the importer is shown
// the facts and says "restates fact X"; the code decides whether the
// restatement carries the numbers (full, 1.0) or only the event (0.5).

const SOP_RESUME = 'Designed a new SOP extending shelf life for a body wash ingredient, reducing scrap costs by $300K+ annually.'
const SOP_EVENT = 'Designed a new SOP extending shelf life for a body wash ingredient'
const SOP_METRIC = 'The new SOP reduced scrap costs by $300K+ annually'
const MODEL_LONG = 'Built a financial model projecting $4M in annual savings for the client'

function corroborationBank(): EvidenceBank {
  const b = bankWithProvenance()
  b.facts.push(
    fact('fact-sop', 'exp-png', SOP_RESUME, { source_location: 'Zuyu_Resume.docx ¶9', support_count: 1 }),
    fact('fact-model', 'exp-png', MODEL_LONG, { source_location: 'Zuyu_Resume.docx ¶10', support_count: 1 }),
    fact('fact-merged', 'exp-png', 'Tombstoned wording', { status: 'merged', merged_into: 'fact-sop' })
  )
  return b
}
const cb = corroborationBank()

// Support level is arithmetic over numeric tokens, never a judgment call.
check('supportLevel: restatement with the numbers → full', supportLevel(SOP_RESUME, SOP_RESUME) === 'full')
check('supportLevel: restatement without the numbers → event_only', supportLevel(SOP_RESUME, SOP_EVENT) === 'event_only')
check('supportLevel: the numbered half alone carries the metric → full', supportLevel(SOP_RESUME, SOP_METRIC) === 'full')
check('supportLevel: existing fact with no numbers → full', supportLevel('Organized Forge 2026', 'organized forge') === 'event_only' && supportLevel('Led the line audit program', 'Led the audit program') === 'full')
check('introducesNumbers: a new number is a disagreement', introducesNumbers(SOP_RESUME, 'Designed a new SOP reducing scrap costs by $500K+ annually') && !introducesNumbers(SOP_RESUME, SOP_EVENT))
check('confidenceFor: full 1.0, event-only 0.5', confidenceFor('full') === 1 && confidenceFor('event_only') === 0.5)
check('isFullSupport: 0.5 is not support', !isFullSupport({ confidence: 0.5 }) && isFullSupport({ confidence: 1 }) && isFullSupport({ confidence: 0.9 }) && isFullSupport({}))
check('sharedContentWords: SOP line vs résumé fact', sharedContentWords(SOP_EVENT, SOP_RESUME) >= 3 && sharedContentWords('Ranked #1 QA intern in North America', SOP_RESUME) < 3)

// The importer input carries the facts, capped and ordered.
const manyFacts = Array.from({ length: 25 }, (_, i) => ({ id: `f${i}`, statement: `Fact number ${i}`, support_count: i === 7 ? 4 : i === 3 ? 2 : 1 }))
const capped = existingExperienceInputs([{ id: 'e1', kind: 'experience', organization: 'X', title: 'Y', start_date: null, end_date: null, facts: manyFacts }])
check('existingExperienceInputs: facts capped and most-supported first', (capped[0].existing_facts?.length ?? 0) === EXISTING_FACTS_PER_EXPERIENCE && capped[0].existing_facts?.[0].id === 'f7' && capped[0].existing_facts?.[1].id === 'f3' && capped[0].existing_facts?.[2].id === 'f0')
check('existingExperienceInputs: no facts → no existing_facts key', !('existing_facts' in existingExperienceInputs([{ id: 'e1', kind: 'experience', organization: 'X', title: 'Y', start_date: null, end_date: null }])[0]))
const fromBank = existingFromBank(cb)
check('existingFromBank: active rows with their active facts only', fromBank.length === 2 && fromBank.find((e) => e.id === 'exp-png')?.facts?.map((f) => f.id).join(',') === 'fact-legacy,fact-sop,fact-model')

const POST_LINES = [
  'Quality Assurance Intern, P&G · May 2026 – Aug 2026',
  SOP_RESUME,
  'Built a financial model projecting $4M in annual savings',
  'Ranked #1 QA intern in North America',
]
const corrInput: ResumeImporterInput = {
  allow_new_experiences: true,
  experiences: existingExperienceInputs(fromBank),
  extra_sources: [{ label: 'pasted.linkedin', lines: POST_LINES.map((text, i) => ({ paragraph_index: i, text })) }],
}
const corrPrompt = resumeImporterPrompt.build(corrInput)
check('prompt: version 1.2.0', resumeImporterPrompt.version === '1.2.0')
check('prompt: existing facts listed by id under their row', corrPrompt.user.includes('[fact: fact-sop] Designed a new SOP') && corrPrompt.system.includes('EXISTING FACTS'))
check('prompt: no facts → corroborates always null', resumeImporterPrompt.build({ ...corrInput, experiences: corrInput.experiences.map((e) => ({ ...e, existing_facts: [] })) }).system.includes('always null'))

const corrOut = validateImporterOutput({
  experiences: [{
    experience_key: 'exp-png',
    summary: 'QA intern.',
    new_experience: null,
    facts: [
      // valid: the line restates fact-sop
      { statement: SOP_EVENT, category: 'achievement', source_label: 'pasted.linkedin', paragraph_index: 1, confidence: 1, corroborates: 'fact-sop' },
      // unknown id → field dropped, fact kept
      { statement: SOP_METRIC, category: 'metric', source_label: 'pasted.linkedin', paragraph_index: 1, confidence: 1, corroborates: 'nope' },
      // another experience's fact → dropped
      { statement: 'Built a financial model projecting $4M in annual savings', category: 'achievement', source_label: 'pasted.linkedin', paragraph_index: 2, confidence: 1, corroborates: 'fact-forge' },
      // line shares < 3 content words with the claimed fact → dropped
      { statement: 'Ranked #1 QA intern in North America', category: 'award', source_label: 'pasted.linkedin', paragraph_index: 3, confidence: 1, corroborates: 'fact-sop' },
      // null is fine
      { statement: 'Ranked #1 QA intern', category: 'award', source_label: 'pasted.linkedin', paragraph_index: 3, confidence: 1, corroborates: null },
    ],
    metrics: [], skills: [], deliverables: [],
  }],
  projects: [],
}, corrInput)
check('validate: corroboration output accepted', corrOut !== null && corrOut.experiences[0].facts.length === 5)
if (corrOut) {
  const f = corrOut.experiences[0].facts
  check('validate: valid corroborates kept', f[0].corroborates === 'fact-sop')
  check('validate: unknown id dropped, fact kept', f[1].corroborates === null && f[1].statement === SOP_METRIC)
  check('validate: another experience\'s fact dropped', f[2].corroborates === null)
  check('validate: too few shared words dropped', f[3].corroborates === null && f[4].corroborates === null)
  check('validate: drops counted with reasons', corrOut.dropped_corroborations === 3 && corrOut.corroboration_notes.length === 3 && corrOut.corroboration_notes.some((n) => /not an existing fact id/.test(n)) && corrOut.corroboration_notes.some((n) => /another experience/.test(n)) && corrOut.corroboration_notes.some((n) => /content word/.test(n)), JSON.stringify(corrOut.corroboration_notes))

  const p: ImportProposal = { experiences: [], bullets: [], facts: [], metrics: [], skills: [], deliverables: [], projects: [], dropped: { unverifiable: 0, metrics: 0, skills: 0, misfiled: 0, experiences: 0, projects: 0 }, trace: null, agentError: null, model: null }
  foldOutput(p, corrOut, { filename: 'pasted.linkedin', extra: [{ label: 'pasted.linkedin', source: 'linkedin', text: POST_LINES.join('\n') }], textSource: 'linkedin', existing: fromBank })
  check('fold: corroborates carried onto the proposed fact', p.facts[0].corroborates === 'fact-sop' && p.facts[1].corroborates === null && p.dropped.corroborations === 3 && (p.corroborationNotes?.length ?? 0) === 3)
}

// planPersist: a verified corroboration is a reuse at the support the numbers justify.
function pngProposal(facts: Partial<ProposedFact>[]): ImportProposal {
  return {
    experiences: [{ key: 'exp-png', kind: 'experience', organization: 'P&G', title: 'Quality Assurance Intern', location: null, start_date: 'May 2026', end_date: 'Aug 2026', description: null, display_order: 0, source: 'linkedin', bulletParagraphIndexes: [], identityParagraphIndex: null, summary: null, existingId: 'exp-png' }],
    bullets: [], metrics: [], skills: [], deliverables: [], projects: [],
    facts: facts.map((f, i) => ({ experience_key: 'exp-png', statement: '', category: 'achievement', source: 'linkedin', source_location: `pasted.linkedin L${i + 1}`, paragraph_index: null, confidence: 1, ...f })),
    dropped: { unverifiable: 0, metrics: 0, skills: 0, misfiled: 0, experiences: 0, projects: 0 }, trace: null, agentError: null, model: null,
  }
}
const pEvent = planPersist(cb, pngProposal([{ statement: SOP_EVENT, corroborates: 'fact-sop' }]))
check('plan: event-only restatement → reuse, no insert', pEvent.facts[0].action === 'reuse' && pEvent.facts[0].existingId === 'fact-sop' && pEvent.facts[0].rule === 'agent_corroborates' && pEvent.facts[0].support === 'event_only' && pEvent.facts[0].quote === SOP_EVENT, JSON.stringify(pEvent.facts))
check('plan: event-only corroboration recorded with its quote', pEvent.corroborated.length === 1 && pEvent.corroborated[0].support === 'event_only' && pEvent.corroborated[0].quote === SOP_EVENT && pEvent.corroborated[0].rule === 'agent_corroborates')
const pFull = planPersist(cb, pngProposal([{ statement: SOP_RESUME, corroborates: 'fact-sop' }]))
check('plan: word-for-word restatement → reuse at full support', pFull.facts[0].action === 'reuse' && pFull.facts[0].support === 'full')
const pAtomized = planPersist(cb, pngProposal([{ statement: SOP_EVENT, corroborates: 'fact-sop' }, { statement: SOP_METRIC, corroborates: 'fact-sop' }]))
check('plan: two halves of one line → one reuse, upgraded to full, second collapses', pAtomized.facts[0].action === 'reuse' && pAtomized.facts[0].support === 'full' && pAtomized.facts[0].quote === SOP_METRIC && pAtomized.facts[1].action === 'collapse' && pAtomized.corroborated.length === 1 && pAtomized.corroborated[0].support === 'full', JSON.stringify(pAtomized.facts))
check('plan: resolveFactDecision follows the collapse to the reuse', resolveFactDecision(pAtomized, 1).action === 'reuse')
const pNewNumber = planPersist(cb, pngProposal([{ statement: 'Designed a new SOP reducing scrap costs by $500K+ annually', corroborates: 'fact-sop' }]))
check('plan: a restatement that introduces a different number is never a corroboration', pNewNumber.facts[0].action === 'insert' && pNewNumber.corroborated.length === 0, JSON.stringify(pNewNumber.facts))
const pWrongExp = planPersist(cb, pngProposal([{ statement: 'Organized Forge 2026 with the team', corroborates: 'fact-forge' }]))
check('plan: corroborates pointing at another experience\'s fact is ignored', pWrongExp.facts[0].action === 'insert')
check('plan: corroborates naming a tombstone is ignored', planPersist(cb, pngProposal([{ statement: SOP_EVENT, corroborates: 'fact-merged' }])).facts[0].action === 'insert')
check('plan: same source and line is not a second corroboration', planPersist(cb, pngProposal([{ statement: SOP_EVENT, corroborates: 'fact-sop', source: 'master_resume', source_location: 'Zuyu_Resume.docx ¶9' }])).corroborated.length === 0)

// The deterministic second check: identical numbers + Jaccard ≥ 0.8, with no hint from the agent.
const NEAR = 'Built a financial model projecting $4M in annual savings'          // 6/7 words → 0.86
const FAR = 'Built a financial model projecting $4M in savings'                  // 5/7 → 0.71
const OTHER_NUMBER = 'Built a financial model projecting $5M in annual savings for the client'
check('findFactMatch: near duplicate at ≥ 0.8 with identical numbers', findFactMatch(cb.facts, 'exp-png', NEAR)?.rule === 'near_duplicate' && findFactMatch(cb.facts, 'exp-png', NEAR)?.id === 'fact-model')
check('findFactMatch: 0.7 overlap is not a match', findFactMatch(cb.facts, 'exp-png', FAR) === null)
check('findFactMatch: different numbers never match', findFactMatch(cb.facts, 'exp-png', OTHER_NUMBER) === null)
check('findFactMatch: exact still reports exact', findFactMatch(cb.facts, 'exp-png', MODEL_LONG.toUpperCase())?.rule === 'exact')
check('findFactMatch: manual-add mode is exact only', findFactMatch(cb.facts, 'exp-png', NEAR, { nearDuplicate: false }) === null)
const pNear = planPersist(cb, pngProposal([{ statement: NEAR }, { statement: FAR }, { statement: OTHER_NUMBER }]))
check('plan: near duplicate reused as a full corroboration with the incoming wording', pNear.facts[0].action === 'reuse' && pNear.facts[0].rule === 'near_duplicate' && pNear.facts[0].support === 'full' && pNear.facts[0].quote === NEAR && pNear.corroborated.some((c) => c.factId === 'fact-model' && c.rule === 'near_duplicate' && c.support === 'full'), JSON.stringify(pNear.facts))
check('plan: 0.7 overlap inserts (the engine\'s POSSIBLE band covers it)', pNear.facts[1].action === 'insert')
check('plan: different numbers insert (the engine\'s CONFLICT covers it)', pNear.facts[2].action === 'insert')

// Provenance labels: an event-only row is visible, and says so.
const eventOnlyBank: EvidenceBank = { ...cb, factSources: [...cb.factSources, { id: 'fs-eo', user_id: 'u', fact_id: 'fact-sop', source_id: 'src-li', location: 'L1', quote: SOP_EVENT, confidence: 0.5, created_at: now }, { id: 'fs-r', user_id: 'u', fact_id: 'fact-sop', source_id: 'src-resume', location: '¶9', quote: SOP_RESUME, confidence: 1, created_at: now }] }
check('sourceLabelsForFact: event-only row labelled', JSON.stringify(sourceLabelsForFact(eventOnlyBank, cb.facts.find((f) => f.id === 'fact-sop') as EvidenceFact)) === JSON.stringify(['LinkedIn export L1 (event only)', 'Zuyu_Resume.docx ¶9']), JSON.stringify(sourceLabelsForFact(eventOnlyBank, cb.facts.find((f) => f.id === 'fact-sop') as EvidenceFact)))

// ─── Report ──────────────────────────────────────────────────────────────────

console.log(`\ntest-career-provenance: ${passed} passed, ${failed} failed`)
for (const f of failures) console.log(`  FAIL ${f}`)
process.exit(failed === 0 ? 0 : 1)
