// Offline checks for the search ontology.
//
//   npx tsx scripts/test-career-ontology.ts
//
// No network, no keys, no database: every bank here is synthetic. What is
// asserted is the property that matters — the ontology is a FUNCTION OF THE
// BANK. A chemical engineer gets process/manufacturing/materials/quality
// families with justifications; add AI evidence and industrial-AI families
// appear; change the bank and the ontology changes; an empty bank yields an
// empty-but-valid ontology instead of throwing.

import { emptyBank } from '../lib/career/evidence/store'
import {
  applyOntologyOverrides, buildSearchOntology, clearOntologyOverride, cueMatches, normalizeText,
  normalizeOverride, ontologyQueryTerms, ontologyWeightedTerms, readOntologyOverrides,
  recordOntologyOverride, renderOntologyForPrompt, withOntologyOverrides,
  COMBINATIONS, DISCIPLINES, INDUSTRIES, ROLE_FAMILIES, EMPTY_ONTOLOGY_LINE, EMPTY_OVERRIDES,
  type OntologyMission, type OntologyOverrides, type SearchOntology,
} from '../lib/career/ontology'
import { sanitizeMissionPatch, sanitizePreferences } from '../lib/career/missions/store'
import type {
  CareerMissionPreferences,
  EvidenceBank, EvidenceExperience, EvidenceFact, EvidencePreference, EvidenceSkill, ExperienceKind,
  FactCategory, SkillCategory,
} from '../lib/career/types'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const USER = 'user-1'
const T = '2026-01-01T00:00:00.000Z'

function exp(id: string, title: string, organization: string, description: string, kind: ExperienceKind = 'experience', approved = true): EvidenceExperience {
  return {
    id, user_id: USER, kind, organization, title, start_date: '2025-06', end_date: '2025-08',
    location: null, description, display_order: Number(id.replace(/\D/g, '')) || 1, source: 'master_resume',
    approved, created_at: T, updated_at: T,
  }
}

function fact(id: string, experience_id: string | null, statement: string, category: FactCategory = 'achievement', approved = true): EvidenceFact {
  return {
    id, user_id: USER, experience_id, statement, category, source: 'master_resume', source_location: null,
    confidence: 0.9, approved, created_at: T, updated_at: T,
  }
}

function skill(id: string, name: string, category: SkillCategory = 'technical'): EvidenceSkill {
  return { id, user_id: USER, name, category, evidence_fact_ids: [], approved: true, created_at: T }
}

function pref(id: string, category: string, value: string, weight = 0.8, hard_constraint = false): EvidencePreference {
  return { id, user_id: USER, category, value, weight, hard_constraint, note: null, created_at: T }
}

/** A chemical engineer: process work in a plant, a lab class, a couple of tools. */
function chemBank(): EvidenceBank {
  return {
    ...emptyBank(),
    experiences: [
      exp('e1', 'Process Engineering Intern', 'Cabot Corporation', 'Ran distillation and separation trials on a pilot plant unit; sized a reactor and reconciled mass and energy balances.'),
      exp('e2', 'BS Chemical Engineering', 'State University', 'Coursework in thermodynamics, transport phenomena, reaction engineering and unit operations.', 'education'),
    ],
    facts: [
      fact('f1', 'e1', 'Rebuilt the P&ID for a continuous separation train and cut solvent use 12%.'),
      fact('f2', 'e1', 'Ran scale-up trials from bench to pilot plant for a specialty polymer.'),
      fact('f3', 'e2', 'Senior design project: catalyst selection and reactor sizing for a hydrogen process.'),
    ],
    skills: [skill('s1', 'Aspen Plus', 'tool'), skill('s2', 'Process design', 'technical'), skill('s3', 'Thermodynamics', 'domain')],
  }
}

/** The same person, having also built software on the plant floor. */
function chemPlusAiBank(): EvidenceBank {
  const bank = chemBank()
  return {
    ...bank,
    experiences: [
      ...bank.experiences,
      exp('e3', 'Software Intern, Manufacturing Analytics', 'Vertex Industrial', 'Built a Python service and an LLM agent that read shop floor throughput and downtime data from the MES.'),
    ],
    facts: [
      ...bank.facts,
      fact('f4', 'e3', 'Shipped a machine learning model that predicted line downtime across three production lines.'),
      fact('f5', 'e3', 'Wrote a Python and TypeScript dashboard used by plant operations for yield tracking.'),
    ],
    skills: [...bank.skills, skill('s4', 'Python', 'tool'), skill('s5', 'Machine learning', 'technical')],
  }
}

/** Nothing in common with the chemical engineer. */
function bioBank(): EvidenceBank {
  return {
    ...emptyBank(),
    experiences: [exp('b1', 'Research Assistant', 'Genome Lab', 'Ran PCR assays and cell culture for a genomics sequencing study; analysed protein expression.')],
    facts: [fact('b2', 'b1', 'Processed 400 sequencing samples and validated the assay against a clinical reference.')],
    skills: [skill('b3', 'Cell culture', 'technical')],
  }
}

const NO_MISSION: OntologyMission = { objective: null, preferences: { direction: null } }

function familyIds(o: SearchOntology): string[] {
  return o.roleFamilies.map((f) => f.id)
}

// ─── 1. The tables are internally consistent ────────────────────────────────

console.log('\nTables')
{
  const familySet = new Set(ROLE_FAMILIES.map((f) => f.id))
  const industrySet = new Set(INDUSTRIES.map((i) => i.id))
  const badFamily: string[] = []
  const badIndustry: string[] = []
  for (const d of DISCIPLINES) {
    for (const f of [...d.coreFamilies, ...d.adjacentFamilies]) if (!familySet.has(f)) badFamily.push(`${d.id}→${f}`)
    for (const i of d.industries) if (!industrySet.has(i)) badIndustry.push(`${d.id}→${i}`)
  }
  for (const c of COMBINATIONS) {
    for (const f of c.families) if (!familySet.has(f)) badFamily.push(`${c.id}→${f}`)
    for (const i of c.industries) if (!industrySet.has(i)) badIndustry.push(`${c.id}→${i}`)
    for (const r of c.requires) if (!DISCIPLINES.some((d) => d.id === r)) badFamily.push(`${c.id} requires unknown ${r}`)
  }
  for (const i of INDUSTRIES) for (const a of i.adjacent ?? []) if (!industrySet.has(a)) badIndustry.push(`${i.id}→${a}`)
  check('every referenced role family exists', badFamily.length === 0, badFamily.join(', '))
  check('every referenced industry exists', badIndustry.length === 0, badIndustry.join(', '))
  check('family ids are unique', new Set(ROLE_FAMILIES.map((f) => f.id)).size === ROLE_FAMILIES.length)
  check('every family has title variants', ROLE_FAMILIES.every((f) => f.titleVariants.length > 0))
}

// ─── 2. Cue matching ─────────────────────────────────────────────────────────

console.log('\nCue matching')
{
  const norm = normalizeText('We scaled Manufacturing throughput; R&D built the P&ID and a scale-up plan.')
  const stems = new Set(norm.trim().split(' ').map((w) => w))
  check('prefix cue matches an inflection', cueMatches('manufactur*', norm, new Set(['manufactur', 'throughput'])))
  check('a truncated stem without a star does not match', !cueMatches('manufactur', norm, new Set(['manufacturing'])))
  check('phrase cue matches', cueMatches('scale-up', norm, stems))
  check('ampersand terms survive normalization', norm.includes(' p&id '), norm)
  check('unmatched cue stays unmatched', !cueMatches('genomics', norm, stems))
}

// ─── 3. A chemical-engineering bank ──────────────────────────────────────────

console.log('\nChemical engineering bank')
const chem = buildSearchOntology({ bank: chemBank(), mission: NO_MISSION })
{
  const ids = familyIds(chem)
  const expected = [
    'process_engineering', 'process_development', 'manufacturing_engineering', 'quality_engineering',
    'materials_engineering', 'rnd', 'process_controls', 'operations_engineering', 'production_engineering',
    'technical_operations',
  ]
  const missing = expected.filter((e) => !ids.includes(e))
  check('chemical engineering yields the adjacent engineering families', missing.length === 0, missing.join(', '))
  check('it is not only "Chemical Engineering"', ids.length > 5, `${ids.length} families`)
  check('the discipline is detected with confidence', chem.disciplines.some((d) => d.id === 'chemical_engineering' && d.confidence > 0.7))
  check('industries include chemicals', chem.industries.some((i) => i.id === 'chemicals'))
  check('adjacent industries widen beyond the core', chem.adjacentIndustries.length > 0 && !chem.adjacentIndustries.some((a) => chem.industries.some((i) => i.id === a.id)))
  check('tools come from the bank', chem.toolTerms.some((t) => t.label === 'Aspen Plus'))
  check('skills come from the bank', chem.skillTerms.some((t) => t.label === 'Thermodynamics') && chem.skillTerms.some((t) => t.label.toLowerCase() === 'process design'))
  check('function terms follow the families', chem.functionTerms.length > 0)
}

console.log('\nJustification')
{
  const bankIds = new Set([...chemBank().experiences.map((e) => e.id), ...chemBank().facts.map((f) => f.id), ...chemBank().skills.map((s) => s.id)])
  const everyEntry = [...chem.roleFamilies, ...chem.industries, ...chem.adjacentIndustries, ...chem.skillTerms, ...chem.functionTerms, ...chem.toolTerms]
  check('every entry carries a why', everyEntry.every((e) => e.why.length > 0 && e.why.every((w) => w.trim().length > 0)))
  const derived = [...chem.roleFamilies, ...chem.industries]
  check('derived entries cite real evidence ids', derived.every((e) => e.evidenceIds.length > 0 && e.evidenceIds.every((id) => bankIds.has(id))))
  const pe = chem.roleFamilies.find((f) => f.id === 'process_engineering')
  check('the why names the evidence row', !!pe && pe.why.some((w) => w.includes('Process Engineering Intern')), pe?.why.join(' | '))
  const adjacent = chem.roleFamilies.find((f) => f.id === 'ehs')
  check('an adjacent family says it is a transfer', !!adjacent && adjacent.why.some((w) => w.includes('transfers')), adjacent?.why.join(' | '))
  check('every discipline reports the cues that fired', chem.disciplines.every((d) => d.matchedCues.length > 0))
}

// ─── 4. Manufacturing × AI ───────────────────────────────────────────────────

console.log('\nManufacturing × AI')
const chemAi = buildSearchOntology({ bank: chemPlusAiBank(), mission: NO_MISSION })
{
  const ids = familyIds(chemAi)
  const expected = ['industrial_ai', 'digital_manufacturing', 'operations_technology', 'automation_controls', 'technical_product']
  const missing = expected.filter((e) => !ids.includes(e))
  check('manufacturing + AI evidence yields industrial-AI adjacents', missing.length === 0, missing.join(', '))
  check('the combination is reported', chemAi.combinations.some((c) => c.id === 'industrial_ai'))
  const ia = chemAi.roleFamilies.find((f) => f.id === 'industrial_ai')
  check('the combination entry explains both halves', !!ia && ia.why.some((w) => w.includes('×')), ia?.why.join(' | '))
  check('industrial software is an industry now', chemAi.industries.some((i) => i.id === 'industrial_software'))
}

// ─── 5. Changing the bank changes the ontology ───────────────────────────────

console.log('\nThe ontology is a function of the bank')
{
  const before = new Set(familyIds(chem))
  const after = familyIds(chemAi)
  const added = after.filter((id) => !before.has(id))
  check('adding AI evidence adds families', added.length >= 4, added.join(', '))
  check('nothing the chemistry justified was lost', [...before].every((id) => after.includes(id)))

  const bio = buildSearchOntology({ bank: bioBank(), mission: NO_MISSION })
  const bioIds = new Set(familyIds(bio))
  check('a different bank yields different families', ![...before].every((id) => bioIds.has(id)) && bioIds.size > 0, [...bioIds].join(', '))
  check('a life-sciences bank yields life-sciences families', bioIds.has('biotech_research') || bioIds.has('lab_research'))
  check('it does NOT invent chemical process controls', !bioIds.has('process_controls'))

  const stripped = { ...chemBank(), skills: [] }
  const noSkills = buildSearchOntology({ bank: stripped, mission: NO_MISSION })
  check('removing skills removes their terms', !noSkills.toolTerms.some((t) => t.label === 'Aspen Plus') && chem.toolTerms.some((t) => t.label === 'Aspen Plus'))
}

// ─── 6. Determinism ──────────────────────────────────────────────────────────

console.log('\nDeterminism')
{
  const a = buildSearchOntology({ bank: chemPlusAiBank(), mission: NO_MISSION })
  const b = buildSearchOntology({ bank: chemPlusAiBank(), mission: NO_MISSION })
  check('two runs are deep-equal', JSON.stringify(a) === JSON.stringify(b))
  check('query terms are deep-equal', JSON.stringify(ontologyQueryTerms(a)) === JSON.stringify(ontologyQueryTerms(b)))
  check('the prompt rendering is byte-identical', renderOntologyForPrompt(a) === renderOntologyForPrompt(b))
  const reordered: EvidenceBank = { ...chemPlusAiBank(), facts: [...chemPlusAiBank().facts].reverse() }
  const c = buildSearchOntology({ bank: reordered, mission: NO_MISSION })
  check('row order in the bank does not change the families', JSON.stringify(familyIds(a)) === JSON.stringify(familyIds(c)))
}

// ─── 7. Approval and tombstones ──────────────────────────────────────────────

console.log('\nOnly canonical approved evidence')
{
  const bank = chemBank()
  const withDraft: EvidenceBank = {
    ...bank,
    experiences: [...bank.experiences, exp('e9', 'Bioprocess Intern', 'Draft Bio', 'Fermentation and cell culture work.', 'experience', false)],
    facts: [...bank.facts, fact('f9', null, 'Ran genomics sequencing assays and PCR panels.', 'achievement', false)],
  }
  const o = buildSearchOntology({ bank: withDraft, mission: NO_MISSION })
  const ids = new Set(o.roleFamilies.flatMap((f) => f.evidenceIds))
  check('an unapproved experience never reaches the ontology', !ids.has('e9'))
  check('an unapproved fact never reaches the ontology', !ids.has('f9'))
  check('and it does not create a life-sciences family', !familyIds(o).includes('biotech_research'), familyIds(o).join(','))

  const tombstoned: EvidenceBank = { ...bank, facts: bank.facts.map((f) => (f.id === 'f2' ? { ...f, status: 'merged' as const } : f)) }
  const t = buildSearchOntology({ bank: tombstoned, mission: NO_MISSION })
  check('a tombstoned fact never reaches the ontology', !t.roleFamilies.flatMap((f) => f.evidenceIds).includes('f2'))
}

// ─── 8. Empty bank ───────────────────────────────────────────────────────────

console.log('\nEmpty bank')
{
  let threw = ''
  let empty: SearchOntology | null = null
  try {
    empty = buildSearchOntology({ bank: emptyBank(), mission: null })
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e)
  }
  check('an empty bank does not throw', threw === '', threw)
  check('it yields an empty-but-valid ontology', !!empty && empty.roleFamilies.length === 0 && empty.industries.length === 0 && Array.isArray(empty.excluded))
  check('stats say the bank is empty', !!empty && empty.stats.bankEmpty && empty.stats.documents === 0)
  check('rendering says so instead of failing', !!empty && renderOntologyForPrompt(empty) === EMPTY_ONTOLOGY_LINE)
  check('there are no query terms', !!empty && ontologyQueryTerms(empty).length === 0)
  check('overrides still apply to an empty ontology', !!empty && applyOntologyOverrides(empty, EMPTY_OVERRIDES).roleFamilies.length === 0)
}

// ─── 9. The mission and the direction ────────────────────────────────────────

console.log('\nDirection and mission')
{
  const direction = 'Pivot into life sciences and genomics research — wet lab or computational, cell culture and sequencing.'
  const o = buildSearchOntology({ bank: emptyBank(), mission: { objective: null, preferences: { direction } } })
  check('a direction alone drives families', o.roleFamilies.length > 0, familyIds(o).join(', '))
  check('those entries are sourced to the direction', o.roleFamilies.every((f) => f.source === 'direction'))
  check('and the why points at the direction', o.roleFamilies[0]?.why.some((w) => w.includes('stated direction')) === true, o.roleFamilies[0]?.why.join(' | '))

  const seeded = buildSearchOntology({ bank: emptyBank(), mission: { preferences: { role_families: ['Process Engineering'], industries: ['Chemicals'] } } })
  check('a mission role family is honoured verbatim', seeded.roleFamilies.some((f) => f.id === 'process_engineering' && f.source === 'mission'))
  check('and it carries the known title variants', (seeded.roleFamilies.find((f) => f.id === 'process_engineering')?.titleVariants.length ?? 0) > 1)
  check('a mission industry is honoured', seeded.industries.some((i) => i.id === 'chemicals' && i.source === 'mission'))

  const withPrefs: EvidenceBank = { ...emptyBank(), preferences: [pref('p1', 'industry', 'battery manufacturing and energy storage')] }
  const p = buildSearchOntology({ bank: withPrefs, mission: NO_MISSION })
  check('evidence preferences are read too', p.roleFamilies.length > 0 && p.stats.preferencesConsidered === 1, familyIds(p).join(', '))
  check('and a preference-only ontology still reports an empty bank', p.stats.bankEmpty)
}

// ─── 10. Query terms ─────────────────────────────────────────────────────────

console.log('\nQuery terms')
{
  const terms = ontologyQueryTerms(chemAi, { limit: 0 })
  check('title variants are terms, not just labels', terms.includes('Process Development Engineer'), terms.slice(0, 6).join(' | '))
  check('industries contribute terms', terms.some((t) => t === 'Chemicals'))
  check('terms are unique, case-insensitively', new Set(terms.map((t) => t.toLowerCase())).size === terms.length)
  check('the limit is respected', ontologyQueryTerms(chemAi, { limit: 10 }).length === 10)
  const weighted = ontologyWeightedTerms(chemAi, { limit: 0 })
  check('weights descend', weighted.every((t, i) => i === 0 || weighted[i - 1].weight >= t.weight))
  check('each term names the entry it came from', weighted.every((t) => t.from.length > 0))
  const intern = ontologyQueryTerms(chemAi, { limit: 0, expandIntern: true })
  check('intern forms are opt-in', !terms.includes('Process Engineer Intern') && intern.includes('Process Engineer Intern') && intern.includes('Process Engineer Internship'))
  const roleOnly = ontologyQueryTerms(chemAi, { limit: 0, kinds: ['roleFamily'] })
  check('a kind filter narrows the list', roleOnly.length > 0 && roleOnly.length < terms.length && !roleOnly.includes('Chemicals'))
}

// ─── 11. Overrides ───────────────────────────────────────────────────────────

console.log('\nOverrides')
{
  const base = chem
  const target = base.roleFamilies.find((f) => f.id === 'quality_engineering')!
  let ov: OntologyOverrides = { version: 1, entries: [] }
  ov = recordOntologyOverride(ov, { id: 'quality_engineering', kind: 'roleFamily', action: 'boost' })
  ov = recordOntologyOverride(ov, { id: 'ehs', kind: 'roleFamily', action: 'mute' })
  ov = recordOntologyOverride(ov, { id: 'materials_engineering', kind: 'roleFamily', action: 'exclude' })
  ov = recordOntologyOverride(ov, { id: 'technical_product', kind: 'roleFamily', action: 'add', label: 'Technical Product' })
  ov = recordOntologyOverride(ov, { id: 'battery_engineering', kind: 'roleFamily', action: 'add', label: 'Battery Engineering' })
  const applied = applyOntologyOverrides(base, ov)

  const boosted = applied.roleFamilies.find((f) => f.id === 'quality_engineering')
  check('boost raises confidence', !!boosted && boosted.confidence > target.confidence && boosted.override === 'boost')
  const muted = applied.roleFamilies.find((f) => f.id === 'ehs')
  check('mute lowers confidence but keeps the entry', !!muted && muted.override === 'mute' && muted.confidence < (base.roleFamilies.find((f) => f.id === 'ehs')?.confidence ?? 1))
  check('muted entries sort last', applied.roleFamilies[applied.roleFamilies.length - 1]?.override === 'mute')
  check('exclude removes the entry', !applied.roleFamilies.some((f) => f.id === 'materials_engineering'))
  check('and records it so it can be undone', applied.excluded.some((e) => e.id === 'materials_engineering' && e.kind === 'roleFamily'))
  const added = applied.roleFamilies.find((f) => f.id === 'battery_engineering')
  check('add inserts an entry the evidence never justified', !!added && added.source === 'user' && added.confidence === 1)
  check('an added entry says who added it', !!added && added.why.includes('you added this'))
  check('an added entry has something to search', (added?.titleVariants.length ?? 0) > 0, added?.titleVariants.join(', '))
  const known = applied.roleFamilies.find((f) => f.id === 'technical_product')
  check('adding a known family reuses its title variants', (known?.titleVariants.length ?? 0) > 1)

  check('the build itself is untouched', base.roleFamilies.some((f) => f.id === 'materials_engineering') && base.excluded.length === 0)
  check('the same overrides over the same build give the same answer', JSON.stringify(applyOntologyOverrides(base, ov)) === JSON.stringify(applied))

  const cleared = clearOntologyOverride(ov, 'roleFamily', 'materials_engineering')
  check('clearing an override restores the entry', applyOntologyOverrides(base, cleared).roleFamilies.some((f) => f.id === 'materials_engineering'))

  ov = recordOntologyOverride(ov, { id: 'quality_engineering', kind: 'roleFamily', action: 'mute' })
  check('the last decision about an entry wins', applyOntologyOverrides(base, ov).roleFamilies.find((f) => f.id === 'quality_engineering')?.override === 'mute')
  check('and it does not stack', ov.entries.filter((o) => o.id === 'quality_engineering').length === 1)

  const excludedTerms = ontologyQueryTerms(applied, { limit: 0 })
  check('an excluded family contributes no query terms', !excludedTerms.includes('Materials Engineer'))
  check('a muted family can be dropped from the terms', !ontologyQueryTerms(applied, { limit: 0, dropMuted: true }).includes('EHS Engineer'))
  check('the prompt rendering names the exclusion', renderOntologyForPrompt(applied).includes('EXCLUDED BY THE USER'))
}

console.log('\nOverride storage')
{
  let ov = recordOntologyOverride({ version: 1, entries: [] }, { id: 'rnd', kind: 'roleFamily', action: 'boost', at: T })
  ov = recordOntologyOverride(ov, { id: 'genomics', kind: 'industry', action: 'add', label: 'Genomics' })
  const preferences = { geo_tiers: [], company_types: ['x'], direction: 'stay broad' }
  const stored = withOntologyOverrides(preferences, ov)
  check('writing keeps the rest of the preferences', stored.direction === 'stay broad' && Array.isArray(stored.company_types))
  const round = readOntologyOverrides(stored)
  check('overrides survive a round-trip', JSON.stringify(round.entries) === JSON.stringify(ov.entries))
  check('a mission with no overrides reads as empty', readOntologyOverrides({ direction: 'x' }).entries.length === 0)
  const junk = [null, undefined, 'nope', 42, [], { ontology_overrides: 'nope' }, { ontology_overrides: { entries: 'nope' } }]
  const bad = junk.filter((j) => readOntologyOverrides(j).entries.length !== 0)
  check('junk preferences read as empty', bad.length === 0, bad.map((j) => JSON.stringify(j)).join(', '))
  check('a bare array of entries is accepted', readOntologyOverrides({ ontology_overrides: [{ id: 'rnd', kind: 'roleFamily', action: 'mute' }] }).entries.length === 1)
  check('a malformed override is dropped, not coerced', normalizeOverride({ id: 'x', kind: 'nope', action: 'boost' }) === null && normalizeOverride({ kind: 'roleFamily', action: 'add' }) === null)
  check('an add without an id slugs its label', normalizeOverride({ kind: 'roleFamily', action: 'add', label: 'Battery Engineering' })?.id === 'battery_engineering')
  const mixed = readOntologyOverrides({ ontology_overrides: { version: 1, entries: [{ id: 'rnd', kind: 'roleFamily', action: 'boost' }, 'junk', { id: '', kind: 'roleFamily', action: 'mute' }] } })
  check('good entries survive beside bad ones', mixed.entries.length === 1 && mixed.entries[0].id === 'rnd')
}

// ─── 12. Prompt rendering ────────────────────────────────────────────────────

console.log('\nPrompt rendering')
{
  const text = renderOntologyForPrompt(chemAi, { maxPerList: 6, maxVariants: 3 })
  check('it leads with the ontology version', text.startsWith('SEARCH ONTOLOGY v'))
  const firstBullet = text.split(/\r?\n/).find((l) => l.startsWith('- ')) ?? ''
  check('it lists role families with titles', text.includes('ROLE FAMILIES (search these titles):') && / — .+/.test(firstBullet), firstBullet)
  check('it caps the list', (text.match(/^- /gm) ?? []).length === 6)
  check('it stays compact', text.length < 2600, `${text.length} chars`)
  check('why is opt-in', !text.includes('why:') && renderOntologyForPrompt(chemAi, { includeWhy: true }).includes('why:'))
}

// ─── 13. Idempotence ─────────────────────────────────────────────────────────
//
// The published contract says applying the same overrides twice is a no-op.
// Boost used to add +0.25 and mute to multiply by 0.35 on EVERY application,
// so a caller that re-applied silently drove a muted family to zero. The
// assertion is apply(apply(x)) === apply(x), not apply(x) === apply(x).

console.log('\nIdempotence')
{
  const base = chem
  let ov: OntologyOverrides = { version: 1, entries: [] }
  ov = recordOntologyOverride(ov, { id: 'quality_engineering', kind: 'roleFamily', action: 'boost' })
  ov = recordOntologyOverride(ov, { id: 'ehs', kind: 'roleFamily', action: 'mute' })
  ov = recordOntologyOverride(ov, { id: 'materials_engineering', kind: 'roleFamily', action: 'exclude' })
  ov = recordOntologyOverride(ov, { id: 'battery_engineering', kind: 'roleFamily', action: 'add', label: 'Battery Engineering' })
  ov = recordOntologyOverride(ov, { id: 'chemicals', kind: 'industry', action: 'mute' })

  const once = applyOntologyOverrides(base, ov)
  const twice = applyOntologyOverrides(once, ov)
  const thrice = applyOntologyOverrides(twice, ov)
  check('applying twice is the same as applying once', JSON.stringify(twice) === JSON.stringify(once))
  check('and a third time changes nothing either', JSON.stringify(thrice) === JSON.stringify(once))

  const ehsOnce = once.roleFamilies.find((f) => f.id === 'ehs')?.confidence
  const ehsTwice = twice.roleFamilies.find((f) => f.id === 'ehs')?.confidence
  check('mute does not compound', ehsOnce === ehsTwice && (ehsOnce ?? 0) > 0, `${ehsOnce} → ${ehsTwice}`)
  const chemOnce = once.industries.find((i) => i.id === 'chemicals')?.confidence
  const chemTwice = twice.industries.find((i) => i.id === 'chemicals')?.confidence
  check('a muted industry does not compound either', chemOnce === chemTwice, `${chemOnce} → ${chemTwice}`)
  check('an entry is excluded once, not listed twice', twice.excluded.filter((e) => e.id === 'materials_engineering').length === 1)
  check('an added entry is not duplicated', twice.roleFamilies.filter((f) => f.id === 'battery_engineering').length === 1)

  const boostedOnce = once.roleFamilies.find((f) => f.id === 'quality_engineering')
  check('a boosted entry remembers what it was worth', typeof boostedOnce?.baseConfidence === 'number' && boostedOnce.baseConfidence === base.roleFamilies.find((f) => f.id === 'quality_engineering')?.confidence)

  // Clearing a decision must restore the derived number, not leave the damped one.
  const cleared = clearOntologyOverride(ov, 'roleFamily', 'ehs')
  const restored = applyOntologyOverrides(once, cleared).roleFamilies.find((f) => f.id === 'ehs')
  const original = base.roleFamilies.find((f) => f.id === 'ehs')
  check('clearing a mute restores the derived confidence', !!restored && restored.confidence === original?.confidence && !restored.override && restored.baseConfidence === undefined, `${restored?.confidence} vs ${original?.confidence}`)
}

// ─── 14. The direction dial ──────────────────────────────────────────────────
//
// Three behaviours, and they must be distinguishable HERE, not just in the
// scout: off ignores the direction, boost leads with it while keeping the rest
// of the bank, exclusive means the user said everything else is out of scope.

console.log('\nDirection modes')
{
  const bank = chemPlusAiBank()
  const direction = 'I want to move into venture capital and startup strategy consulting.'
  const none = buildSearchOntology({ bank, mission: NO_MISSION })
  const off = buildSearchOntology({ bank, mission: { preferences: { direction, direction_mode: 'off' } } })
  const boost = buildSearchOntology({ bank, mission: { preferences: { direction, direction_mode: 'boost' } } })
  const only = buildSearchOntology({ bank, mission: { preferences: { direction, direction_mode: 'exclusive' } } })

  check('the resolved mode is reported', off.stats.directionMode === 'off' && boost.stats.directionMode === 'boost' && only.stats.directionMode === 'exclusive')
  check('“off” ignores the direction entirely', JSON.stringify(familyIds(off)) === JSON.stringify(familyIds(none)))
  check('“boost” leads with the direction but keeps the evidence', boost.roleFamilies.some((f) => f.id === 'strategy_consulting') && boost.roleFamilies.some((f) => f.id === 'process_engineering'))
  // "Lead with it" is a floor and a reordering, not a guarantee of first place:
  // a direction is worth double mass and never scores below DIRECTION_FLOOR,
  // and it lifts a discipline the bank alone would not have attested at all.
  const bizWith = boost.disciplines.find((d) => d.id === 'business_strategy')?.confidence ?? 0
  const bizWithout = none.disciplines.find((d) => d.id === 'business_strategy')?.confidence ?? 0
  check('a stated direction is never a guess', bizWith >= 0.8 && bizWith > bizWithout, `${bizWithout} → ${bizWith}`)
  check('“exclusive” drops what the direction never names', !familyIds(only).includes('process_engineering') && only.roleFamilies.some((f) => f.id === 'strategy_consulting'), familyIds(only).join(', '))
  check('and says how much it narrowed', only.stats.narrowedByDirection > 0 && boost.stats.narrowedByDirection === 0 && off.stats.narrowedByDirection === 0)
  check('“exclusive” narrows the query terms too', ontologyQueryTerms(only, { limit: 0 }).length < ontologyQueryTerms(boost, { limit: 0 }).length)
  check('the prompt tells the planner the search is restricted', renderOntologyForPrompt(only).includes('ONLY THIS') && !renderOntologyForPrompt(boost).includes('ONLY THIS'))

  // Narrowing to nothing is not a narrower search — it is no search at all.
  const unknown = buildSearchOntology({ bank, mission: { preferences: { direction: 'zorblax quuxing', direction_mode: 'exclusive' } } })
  check('a direction naming no discipline does not empty the ontology', unknown.roleFamilies.length > 0 && unknown.stats.narrowedByDirection === 0)
  const modeOnly = buildSearchOntology({ bank, mission: { preferences: { direction: null, direction_mode: 'exclusive' } } })
  check('a mode with no direction resolves to off', modeOnly.stats.directionMode === 'off' && JSON.stringify(familyIds(modeOnly)) === JSON.stringify(familyIds(none)))
}

// ─── 15. Fields the table does not cover ─────────────────────────────────────
//
// The discipline table is a map, not the territory. Two failures must not
// happen: a person it does not cover getting NOTHING to search, and a single
// generic word ("research") firing a confident engineering family at someone
// who has never seen a plant.

console.log('\nOut of the table')
{
  const nurse: EvidenceBank = {
    ...emptyBank(),
    experiences: [exp('n1', 'Registered Nurse Extern', 'County Hospital', 'Triage, patient care, medication administration and charting in Epic.')],
    facts: [fact('n2', 'n1', 'Carried a six-patient assignment on a medical-surgical floor.')],
    skills: [skill('n3', 'Patient care')],
  }
  const n = buildSearchOntology({ bank: nurse, mission: NO_MISSION })
  check('an uncovered field still yields something to search', n.roleFamilies.length > 0, familyIds(n).join(', '))
  check('and says the families are the person’s own titles', n.stats.usedTitleFallback)
  check('the fallback family is the title, season and “intern” stripped', n.roleFamilies.some((f) => f.label === 'Registered Nurse Extern' || f.label === 'Registered Nurse'), n.roleFamilies.map((f) => f.label).join(', '))
  check('the fallback names the job it came from', n.roleFamilies[0]?.why.some((w) => w.includes('County Hospital')) === true, n.roleFamilies[0]?.why.join(' | '))
  check('the fallback keeps the raw title as a search term', ontologyQueryTerms(n, { limit: 0 }).some((t) => t.toLowerCase().includes('nurse')))
  check('the prompt rendering explains the fallback', renderOntologyForPrompt(n).includes('own job titles'))

  const legal: EvidenceBank = {
    ...emptyBank(),
    experiences: [exp('l1', 'Legal Intern', 'District Attorney', 'Drafted motions, legal research and deposition summaries; contract review.')],
    facts: [fact('l2', 'l1', 'Summarised 40 depositions and cite-checked two appellate briefs.')],
  }
  const l = buildSearchOntology({ bank: legal, mission: NO_MISSION })
  const engineering = ['process_engineering', 'process_development', 'computational_science', 'lab_research', 'rnd', 'biotech_research', 'materials_engineering', 'systems_engineering']
  const wrong = engineering.filter((id) => familyIds(l).includes(id))
  check('a legal bank yields no engineering families', wrong.length === 0, wrong.join(', '))
  check('but it still yields the person’s own role', l.roleFamilies.length > 0 && l.stats.usedTitleFallback, familyIds(l).join(', '))

  const marketing: EvidenceBank = {
    ...emptyBank(),
    experiences: [exp('m1', 'Marketing Intern', 'Brand Co', 'Ran social campaigns, SEO copy, email newsletters and influencer outreach.')],
  }
  const m = buildSearchOntology({ bank: marketing, mission: NO_MISSION })
  check('a marketing bank yields no engineering families', engineering.every((id) => !familyIds(m).includes(id)), familyIds(m).join(', '))
  check('and still has terms to search', ontologyQueryTerms(m, { limit: 0 }).length > 0)

  // One generic word is an inference; a phrase or a prefix is specific enough.
  const oneWord: EvidenceBank = { ...emptyBank(), experiences: [exp('g1', 'Policy Intern', 'City Hall', 'Wrote a research memo on housing permits.')] }
  const g = buildSearchOntology({ bank: oneWord, mission: NO_MISSION })
  check('a lone generic cue does not fire a discipline', g.disciplines.length === 0, g.disciplines.map((d) => d.label).join(', '))
  const twoWords: EvidenceBank = { ...emptyBank(), experiences: [exp('g2', 'Research Assistant', 'State University', 'Ran laboratory experiments and wrote a thesis on numerical simulation.')] }
  const g2 = buildSearchOntology({ bank: twoWords, mission: NO_MISSION })
  check('several cues do', g2.disciplines.some((d) => d.id === 'research_science'), g2.disciplines.map((d) => d.label).join(', '))
  check('and then the fallback is not used', !g2.stats.usedTitleFallback)
}

// ─── 16. A preference row carries its own weight ─────────────────────────────

console.log('\nPreference weights')
{
  const withWeight = (w: number, hard = false) =>
    buildSearchOntology({ bank: { ...emptyBank(), preferences: [pref('p1', 'industry', 'battery manufacturing and energy storage', w, hard)] }, mission: NO_MISSION })
  const faint = withWeight(0.3)
  const strong = withWeight(1)
  const hard = withWeight(0.3, true)
  // Disciplines are scored relative to the strongest in the same run, so the
  // top one reports the row's absolute mass — which is what the weight moves.
  const confidence = (o: SearchOntology) => o.disciplines[0]?.confidence ?? 0
  check('a down-weighted preference counts for less', confidence(faint) < confidence(strong) && confidence(faint) > 0, `${confidence(faint)} vs ${confidence(strong)}`)
  check('a hard constraint counts for more than its weight alone', confidence(hard) > confidence(faint), `${confidence(hard)} vs ${confidence(faint)}`)
  // Down-weighting narrows; it never invents. A row at 0.1 may fall under the
  // confidence floor entirely, which is the point of the dial.
  check('down-weighting only ever narrows', familyIds(faint).every((id) => familyIds(strong).includes(id)) && familyIds(faint).length <= familyIds(strong).length, `${familyIds(faint).length} ⊆ ${familyIds(strong).length}`)
  check('a hard constraint derives at least what its weight alone would', familyIds(faint).length > 0 && familyIds(faint).every((id) => familyIds(hard).includes(id)))
  check('and a preference the user pushed to the floor drops out entirely', withWeight(0.02).roleFamilies.length === 0)

  // The shipped seed preferences must not outvote a career (CLASS_MASS_CAP).
  const boilerplate = Array.from({ length: 18 }, (_, i) => pref(`b${i}`, 'company_type', 'high-growth startup and venture-backed strategy work', 0.6))
  const swamped = buildSearchOntology({ bank: { ...chemBank(), preferences: boilerplate }, mission: NO_MISSION })
  const chemConf = swamped.disciplines.find((d) => d.id === 'chemical_engineering')?.confidence ?? 0
  const bizConf = swamped.disciplines.find((d) => d.id === 'business_strategy')?.confidence ?? 0
  check('eighteen rows of seeded boilerplate do not outrank a career', chemConf > bizConf, `chem ${chemConf} vs business ${bizConf}`)
}

// ─── 17. Overrides survive a mission edit ────────────────────────────────────
//
// The overrides live on `career_missions.preferences`, a jsonb V1 owns.
// `sanitizePreferences` returns a literal of known keys, so without an explicit
// passthrough every boost/mute/exclude was erased the next time the founder
// saved their direction — the control directly above the panel.

console.log('\nOverrides survive a mission edit')
{
  let ov: OntologyOverrides = { version: 1, entries: [] }
  ov = recordOntologyOverride(ov, { id: 'rnd', kind: 'roleFamily', action: 'boost' })
  ov = recordOntologyOverride(ov, { id: 'ehs', kind: 'roleFamily', action: 'exclude' })
  const stored = withOntologyOverrides(sanitizePreferences({}) as unknown as Record<string, unknown>, ov)
  const base = { preferences: stored as unknown as CareerMissionPreferences, hard_constraints: [] }

  const afterDirection = sanitizeMissionPatch({ preferences: { direction: 'chemical engineering internships' } }, base)
  check('a direction-only patch preserves the overrides', JSON.stringify(readOntologyOverrides(afterDirection.preferences).entries) === JSON.stringify(ov.entries))
  const afterLocations = sanitizeMissionPatch({ preferences: { locations: { mode: 'anywhere', regions: [] } } }, base)
  check('a location patch preserves them too', readOntologyOverrides(afterLocations.preferences).entries.length === 2)
  check('and the known keys are still sanitized', Array.isArray((afterDirection.preferences as CareerMissionPreferences).geo_tiers))
  const fresh = sanitizeMissionPatch({ preferences: { direction: 'x' } }, null)
  check('a mission that never had overrides gains none', readOntologyOverrides(fresh.preferences).entries.length === 0)
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL — ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
