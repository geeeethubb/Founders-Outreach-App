// Deterministic tests for the retrieval layer (lib/career/evidence/retrieval.ts),
// the outreach background adapter and the sender resolver. No network, no
// keys, no database.
//
//   npm run test:career-retrieval

import { getRelevantPersonalEvidence, renderRelevantEvidence, toBackgroundItems } from '../lib/career/evidence/retrieval'
import { emptyBank } from '../lib/career/evidence/store'
import { backgroundForOutreach, toScoutItems } from '../lib/outreach/background'
import { buildVerificationPool } from '../lib/outreach/evidence'
import { looksLikePersonName, nameFromBank, resolveSenderFrom, signoffFrom } from '../lib/outreach/sender'
import { buildTailorInput } from '../lib/career/tailor/render'
import { buildLetterInput } from '../lib/career/letter/pipeline'
import { buildSyntheticBank } from './lib/synthetic-evidence-bank'
import type { RetrievalInput } from '../lib/career/evidence/retrieval-types'

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

const bank = buildSyntheticBank()

interface Persona {
  name: string
  input: Omit<RetrievalInput, 'bank'>
  expectFacts: string[]
  expectExperiences: string[]
}

export const PERSONAS: Persona[] = [
  {
    name: 'deep-tech founder',
    input: { mission: 'Find deep-tech founders working on catalysis, clean energy and hard science who might mentor or hire me', target: { kind: 'person', title: 'Co-founder & CTO', company: 'a clean-energy catalysis startup', description: 'Building electrochemical catalysts for hydrogen; ex-national lab researcher; techno-economic modelling of clean energy systems.' } },
    expectFacts: ['f-lab-vasp', 'f-arg-cdi', 'f-cred-wp'],
    expectExperiences: ['exp-uiuc-lab', 'exp-argonne', 'exp-credence'],
  },
  {
    name: 'AI founder',
    input: { mission: 'Meet AI founders building agents and agentic workflows', target: { kind: 'person', title: 'Founder & CEO', company: 'an AI agents startup', description: 'Building LLM agents and agentic workflow automation for enterprises.' } },
    expectFacts: ['f-png-agent', 'f-ibc-agentic', 'f-fnd-keywords'],
    expectExperiences: ['exp-png', 'exp-ibc', 'exp-founders'],
  },
  {
    name: 'industrial exec',
    input: { mission: 'Find manufacturing and quality leaders at industrial plants for a winter internship', target: { kind: 'person', title: 'VP Manufacturing & Quality', company: 'a consumer goods manufacturer', description: 'Runs plant operations, quality systems, SOPs and process automation across production lines.' } },
    expectFacts: ['f-png-cs', 'f-png-4m', 'f-png-sop'],
    expectExperiences: ['exp-png'],
  },
  {
    name: 'VC',
    input: { mission: 'Meet venture investors who back student founders', target: { kind: 'person', title: 'Partner', company: 'a seed-stage venture fund', description: 'Invests in pre-seed and seed rounds; runs an accelerator; Y Combinator alumnus; scouts startups on campuses.' } },
    expectFacts: ['f-cred-round', 'f-yc', 'f-ceas', 'f-iventure'],
    expectExperiences: ['exp-credence', 'exp-ceas', 'exp-yc'],
  },
  {
    name: 'UIUC alumnus',
    input: { mission: 'Reconnect with UIUC alumni active in the campus entrepreneurship community', target: { kind: 'person', title: 'Founder', company: 'a startup founded by a UIUC alumnus', description: 'UIUC alumnus, Founders member, hackathon organizer, supports Illinois student startups.' } },
    expectFacts: ['f-fnd-forge', 'f-fnd-colini', 'f-fnd-lead'],
    expectExperiences: ['exp-founders'],
  },
  {
    name: 'speaker / event organizer',
    input: { mission: 'Invite speakers and event organizers for a campus series', target: { kind: 'person', title: 'Head of Community', company: 'a conference organizer', description: 'Organizes summits and hackathons, hosts a podcast, books speakers for events.' } },
    expectFacts: ['f-pod', 'f-fnd-forge', 'f-loop-summit'],
    expectExperiences: ['exp-podcast', 'exp-founders', 'exp-loopera'],
  },
]

// ─── Personas ────────────────────────────────────────────────────────────────

for (const p of PERSONAS) {
  const rel = getRelevantPersonalEvidence({ bank, ...p.input })
  const factIds = rel.facts.map((f) => f.fact.id)
  const expIds = rel.experiences.map((e) => e.experience.id)
  const hits = p.expectFacts.filter((id) => factIds.includes(id))
  check(`${p.name}: relevant facts in top ${rel.facts.length}`, hits.length >= Math.min(3, p.expectFacts.length), `got ${factIds.join(', ')}`)
  for (const id of p.expectExperiences) check(`${p.name}: ${id} in top experiences`, expIds.includes(id), `got ${expIds.join(', ')}`)
  check(`${p.name}: experiences carry facts`, rel.experiences.every((e) => e.facts.length > 0))
  check(`${p.name}: default caps respected`, rel.experiences.length <= 4 && rel.facts.length <= 8)
}

// ─── Never unapproved, never tombstoned ──────────────────────────────────────

{
  const everything = getRelevantPersonalEvidence({ bank, mission: 'acquisition M&A quality assurance intern P&G', maxExperiences: 50, maxFacts: 500 })
  const expIds = everything.experiences.map((e) => e.experience.id)
  const factIds = new Set([...everything.facts.map((f) => f.fact.id), ...everything.experiences.flatMap((e) => e.facts.map((f) => f.fact.id))])
  check('tombstoned experience never returned', !expIds.includes('exp-png-dup'))
  check('tombstoned fact never returned', !factIds.has('f-png-dup'))
  check('unapproved fact never returned', !factIds.has('f-unapproved'))
  check('tombstones counted', everything.stats.tombstonesSkipped === 2, String(everything.stats.tombstonesSkipped))
  check('every live experience considered', everything.stats.experiencesConsidered === bank.experiences.length - 1)
  check('every returned row is approved', everything.experiences.every((e) => e.experience.approved) && everything.facts.every((f) => f.fact.approved))
}

// ─── Generic / empty query ───────────────────────────────────────────────────

{
  const generic = getRelevantPersonalEvidence({ bank, mission: null, target: { kind: 'generic' } })
  check('generic query returns experiences', generic.experiences.length === 4, String(generic.experiences.length))
  check('generic query returns facts', generic.facts.length === 8, String(generic.facts.length))
  check('generic query ranks a quantified experience first', ['exp-png', 'exp-founders', 'exp-uiuc-lab', 'exp-credence'].includes(generic.experiences[0].experience.id), generic.experiences[0].experience.id)
  check('generic query never returns empty for a non-empty bank', generic.experiences.length > 0)
  const empty = getRelevantPersonalEvidence({ bank: emptyBank(), mission: 'anything' })
  check('empty bank returns empty slices without throwing', empty.experiences.length === 0 && empty.facts.length === 0)
  check('empty bank renders a placeholder', renderRelevantEvidence(empty, { style: 'compact' }).startsWith('(no approved'))
}

// ─── Determinism ─────────────────────────────────────────────────────────────

{
  const a = getRelevantPersonalEvidence({ bank, ...PERSONAS[0].input })
  const b = getRelevantPersonalEvidence({ bank, ...PERSONAS[0].input })
  check('deterministic: deep-equal on two runs', JSON.stringify(a) === JSON.stringify(b))
  check('deterministic: rendered output identical', renderRelevantEvidence(a, { style: 'detailed' }) === renderRelevantEvidence(b, { style: 'detailed' }))
  const shuffled = buildSyntheticBank()
  shuffled.facts.reverse()
  shuffled.experiences.reverse()
  const c = getRelevantPersonalEvidence({ bank: shuffled, ...PERSONAS[0].input })
  check('deterministic: independent of row order', JSON.stringify(a.experiences.map((e) => e.experience.id)) === JSON.stringify(c.experiences.map((e) => e.experience.id)) && JSON.stringify(a.facts.map((f) => f.fact.id)) === JSON.stringify(c.facts.map((f) => f.fact.id)))
}

// ─── Provenance, confidence and rendering ────────────────────────────────────

{
  const rel = getRelevantPersonalEvidence({ bank, ...PERSONAS[2].input })
  const cs = rel.facts.find((f) => f.fact.id === 'f-png-cs')
  check('source labels join fact_sources to sources', cs?.sourceLabels.join('|') === 'LinkedIn export L12|Zuyu_Resume.docx ¶6', cs?.sourceLabels.join('|'))
  check('support_count and status carried', cs?.support_count === 2 && cs?.status === 'CORROBORATED')
  check('corroboration is a reason', cs?.reasons.some((r) => /sources agree/.test(r)) === true)
  const sop = rel.facts.find((f) => f.fact.id === 'f-png-sop')
  check('legacy source_location is the fallback label', sop?.sourceLabels[0] === 'Zuyu_Resume.docx ¶3', sop?.sourceLabels.join('|'))
  const compact = renderRelevantEvidence(rel, { style: 'compact' })
  check('compact: one header line per experience with id', compact.split('\n').filter((l) => l.startsWith('[exp-')).length === rel.experiences.length)
  check('compact: fact lines carry labels', /^ {2}- .*\(Zuyu_Resume\.docx/m.test(compact))
  check('compact: no fact ids', !/\[f-png/.test(compact))
  const detailed = renderRelevantEvidence(rel, { style: 'detailed' })
  check('detailed: fact ids citable', /\[f-png-cs\]/.test(detailed))
  check('detailed: metrics rendered', /METRICS: .*\$4M\+/.test(detailed))
  const founders = getRelevantPersonalEvidence({ bank, ...PERSONAS[4].input })
  check('detailed: projects rendered', /PROJECTS: Forge 2026/.test(renderRelevantEvidence(founders, { style: 'detailed' })))
  check('period formatted from dates', rel.experiences[0].period === '5/2026 – 8/2026', rel.experiences[0].period)
  check('summary is the top two facts', rel.experiences[0].summary.includes(' · ') && rel.experiences[0].summary.length <= 280)
  const noMetrics = getRelevantPersonalEvidence({ bank, ...PERSONAS[2].input, includeMetrics: false })
  check('includeMetrics false drops metrics', noMetrics.experiences.every((e) => e.metrics.length === 0))
  const withOrg = buildSyntheticBank()
  withOrg.organizations.push({ id: 'org-png', user_id: 'u', canonical_name: 'Procter & Gamble', normalized_name: 'procter and gamble', aliases: ['P&G'], kind: 'company', company_id: null, created_at: '', updated_at: '' })
  withOrg.experiences.find((e) => e.id === 'exp-png')!.organization_id = 'org-png'
  withOrg.experiences.find((e) => e.id === 'exp-png')!.canonical_summary = 'QA intern who built the Controlled State system.'
  const canon = getRelevantPersonalEvidence({ bank: withOrg, ...PERSONAS[2].input })
  check('canonical organization used when linked', canon.experiences[0].organization === 'Procter & Gamble', canon.experiences[0].organization)
  check('canonical_summary preferred when present', canon.experiences[0].summary === 'QA intern who built the Controlled State system.')
}

// ─── toBackgroundItems ───────────────────────────────────────────────────────

{
  const rel = getRelevantPersonalEvidence({ bank, mission: 'anything', maxExperiences: 20, maxFacts: 60 })
  const items = toBackgroundItems(rel)
  const kinds = new Set(['experience', 'project', 'award', 'education'])
  const creds = new Set(['strong', 'moderate', 'supporting'])
  check('background: one item per experience', items.length === rel.experiences.length)
  check('background: ids are experience ids', items.every((i) => bank.experiences.some((e) => e.id === i.id)))
  check('background: kinds valid', items.every((i) => kinds.has(i.kind)))
  check('background: credibility valid', items.every((i) => creds.has(i.credibility)))
  const byId = new Map(items.map((i) => [i.id, i]))
  check('background: research → experience, project → project, award → award, education → education',
    byId.get('exp-uiuc-lab')?.kind === 'experience' && byId.get('exp-loopera')?.kind === 'project' && byId.get('exp-yc')?.kind === 'award' && byId.get('exp-edu')?.kind === 'education')
  check('background: P&G is strong', byId.get('exp-png')?.credibility === 'strong')
  check('background: P&G domains include manufacturing and quality', ['manufacturing', 'quality'].every((d) => byId.get('exp-png')!.domains.includes(d)), byId.get('exp-png')!.domains.join(','))
  check('background: lab domains include catalysis and the VASP skill', byId.get('exp-uiuc-lab')!.domains.includes('catalysis') && byId.get('exp-uiuc-lab')!.domains.includes('vasp'), byId.get('exp-uiuc-lab')!.domains.join(','))
  check('background: domains capped at 8', items.every((i) => i.domains.length <= 8))
  check('background: summary ≤ 280 chars', items.every((i) => i.summary.length <= 280))
}

// ─── backgroundForOutreach ───────────────────────────────────────────────────

{
  const fromBank = backgroundForOutreach(bank, { mission: 'industrial AI internships' })
  check('backgroundForOutreach: bank when approved experiences exist', fromBank.source === 'bank' && fromBank.items.length > 0)
  check('backgroundForOutreach: facts scoped to experiences', fromBank.facts.every((f) => fromBank.items.some((i) => i.id === f.experienceId)))
  check('backgroundForOutreach: fixture only for an empty bank', backgroundForOutreach(emptyBank()).source === 'fixture' && backgroundForOutreach(null).source === 'fixture')
  const unapprovedOnly = buildSyntheticBank()
  for (const e of unapprovedOnly.experiences) e.approved = false
  check('backgroundForOutreach: fixture when nothing is approved', backgroundForOutreach(unapprovedOnly).source === 'fixture')
  const scout = toScoutItems(fromBank.items)
  check('toScoutItems: title — org (period): summary', scout.every((s) => /^.+ — .+: .+/.test(s.summary)) && scout.every((s) => bank.experiences.some((e) => e.id === s.id)))

  // Editing Evidence changes Scout personalization: edit a fact that is IN the
  // rendered P&G summary (the summary is the top two facts), then re-render.
  const edited = buildSyntheticBank()
  const pngItem = fromBank.items.find((i) => i.id === 'exp-png')!
  const inSummary = edited.facts.find((f) => f.experience_id === 'exp-png' && pngItem.summary.includes(f.statement))!
  check('P&G summary is built from its facts', inSummary !== undefined)
  inSummary.statement = `${inSummary.statement}, later adopted by three more lines`
  edited.facts.find((f) => f.id === 'f-png-cs')!.statement += ' (three more lines)'
  const before = toScoutItems(backgroundForOutreach(bank, { mission: 'industrial AI internships' }).items).map((s) => s.summary).join('\n')
  const after = toScoutItems(backgroundForOutreach(edited, { mission: 'industrial AI internships' }).items).map((s) => s.summary).join('\n')
  check('editing a fact changes the rendered background', before !== after && after.includes('three more lines'))
  const renderedBefore = renderRelevantEvidence(getRelevantPersonalEvidence({ bank, ...PERSONAS[2].input }), { style: 'compact' })
  const renderedAfter = renderRelevantEvidence(getRelevantPersonalEvidence({ bank: edited, ...PERSONAS[2].input }), { style: 'compact' })
  check('editing a fact changes the rendered retrieval', renderedBefore !== renderedAfter && renderedAfter.includes('three more lines'))

  // Verification pool: chosen experiences' facts only.
  const pool = buildVerificationPool(['SENDER: x'], fromBank.items.map((i) => ({ id: i.id, title: i.title, org: i.org, period: i.period, summary: i.summary })), ['exp-png'], fromBank.facts)
  check('verification pool admits chosen-experience facts', pool.some((l) => l.includes('Controlled State')))
  check('verification pool excludes unchosen facts', !pool.some((l) => l.includes('VASP') && l.startsWith('SENDER')))
  check('verification pool keeps identity lines for the rest', pool.some((l) => l.startsWith('ON RECORD:')))
  check('verification pool unchanged without bankFacts', buildVerificationPool(['a'], [], []).join() === 'a')
}

// ─── Sender ──────────────────────────────────────────────────────────────────

{
  check('name: email local-part rejected', !looksLikePersonName('zuyu.alex06'))
  check('name: real name accepted', looksLikePersonName('Zuyu Liu') && looksLikePersonName('Mary-Jane O’Neil Smith'))
  check('name: digits and @ rejected', !looksLikePersonName('Zuyu Liu2') && !looksLikePersonName('a@b c'))
  check('name from bank education fact', nameFromBank(bank) === 'Zuyu Liu')
  check('name from bank: none when no such fact', nameFromBank(emptyBank()) === null)
  const saved = process.env.OUTREACH_SENDER_NAME
  delete process.env.OUTREACH_SENDER_NAME
  const s1 = resolveSenderFrom({ name: 'zuyu.alex06', major: 'Chemical Engineer' }, bank)
  check('resolveSender: profile local-part falls through to the bank', s1.name === 'Zuyu Liu' && s1.nameSource === 'bank')
  check('resolveSender: signoff from major', s1.signoffContext === 'undergraduate, chemical engineering', s1.signoffContext)
  const s2 = resolveSenderFrom({ name: 'Ada Lovelace', major: null }, bank)
  check('resolveSender: profile name wins', s2.name === 'Ada Lovelace' && s2.nameSource === 'profile')
  check('resolveSender: signoff from education title when no major', s2.signoffContext === 'undergraduate, chemical engineering', s2.signoffContext)
  process.env.OUTREACH_SENDER_NAME = 'Env Person'
  check('resolveSender: env before the literal', resolveSenderFrom(null, emptyBank()).nameSource === 'env')
  delete process.env.OUTREACH_SENDER_NAME
  const s3 = resolveSenderFrom(null, null)
  check('resolveSender: last-resort literal', s3.nameSource === 'fallback' && s3.signoffContext === 'undergraduate, chemical engineering')
  check('signoff: master\'s parsed', signoffFrom(null, { ...emptyBank(), experiences: [{ ...bank.experiences[0], kind: 'education', title: 'M.S. in Materials Science' }] }) === "master's student, materials science")
  if (saved !== undefined) process.env.OUTREACH_SENDER_NAME = saved
}

// ─── Tailor and letter integration ───────────────────────────────────────────

{
  const job = { title: 'Process Engineering Intern', company: 'Acme Chemicals', key_requirements: ['SOPs', 'quality systems', 'process improvement'], responsibilities: ['support production line operations'], description_excerpt: 'Manufacturing plant internship.' }
  const input = buildTailorInput(bank, job, { why_i_fit: null, emphasize: [], do_not_claim: [], top_experience_ids: ['exp-ibc'] })
  const ids = input.experiences.map((e) => e.id)
  check('tailor: matcher top first', ids[0] === 'exp-ibc')
  check('tailor: every résumé experience kept', ['exp-png', 'exp-ibc', 'exp-argonne', 'exp-uiuc-lab', 'exp-founders'].every((id) => ids.includes(id)), ids.join(','))
  check('tailor: tombstone excluded', !ids.includes('exp-png-dup'))
  check('tailor: non-résumé experiences limited to the retrieval top 6', ids.length <= 5 + 6 && ids.length < bank.experiences.length - 1, String(ids.length))
  check('tailor: facts per experience ≤ 8 and approved', input.experiences.every((e) => e.facts.length <= 8 && e.facts.every((f) => f.id !== 'f-unapproved')))
  const png = input.experiences.find((e) => e.id === 'exp-png')!
  check('tailor: P&G facts retrieval-ranked (SOP/Controlled State before risk assessment)', png.facts.findIndex((f) => f.id === 'f-png-risk') > Math.min(png.facts.findIndex((f) => f.id === 'f-png-sop'), png.facts.findIndex((f) => f.id === 'f-png-cs')), png.facts.map((f) => f.id).join(','))

  const letter = buildLetterInput({
    bank,
    job: { title: 'Computational Catalysis Intern', company: 'Catalyst Labs', location: null, summary: 'DFT and VASP work on hydrogen catalysts.' },
    companyResearch: { points: [], summary: '' },
    evidenceMap: { why_i_fit: null, fact_ids: ['f-fnd-colini'], story_ids: [], top_experience_ids: ['exp-uiuc-lab'] },
    user: { name: 'Zuyu Liu' },
  })
  const lids = letter.evidence.facts.map((f) => f.id)
  check('letter: matcher-chosen fact first', lids[0] === 'f-fnd-colini')
  check('letter: filled to 10 with retrieval-ranked facts', lids.length === 10, String(lids.length))
  check('letter: top-experience facts fill first', lids[1] === 'f-lab-vasp' || lids[1] === 'f-lab-design', lids.join(','))
  check('letter: no unapproved fact', !lids.includes('f-unapproved'))
  check('letter: no duplicates', new Set(lids).size === lids.length)
}

console.log(`\n${passed} passed, ${failed} failed`)
for (const f of failures) console.log(`  FAIL ${f}`)
process.exitCode = failed === 0 ? 0 : 1
