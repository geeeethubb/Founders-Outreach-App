// Offline tests for the consolidation engine. Synthetic banks in memory; no
// database, no keys. Every real pair from the founder's bank has a case here,
// with the class the engine must give it, and every adversarial pair that
// must NOT merge.
//
//   npx tsx scripts/test-career-consolidation.ts

import { emptyBank } from '../lib/career/evidence/store'
import { buildConsolidationPlan } from '../lib/career/evidence/consolidate'
import { planMutations } from '../lib/career/evidence/consolidate-mutations'
import { renderPlanReport, planToJson } from '../lib/career/evidence/consolidate-report'
import { compareQualifiers, isLocationLike, orgKey, qualifierOf, safestWording, statementTokens } from '../lib/career/evidence/consolidate-rules'
import { buildCanonicalSummary } from '../lib/career/evidence/summary'
import type { ConsolidationPlan, MergeProposal } from '../lib/career/evidence/consolidate-types'
import type { EvidenceBank, EvidenceExperience, EvidenceFact, EvidenceMetric, ExperienceKind, FactCategory, FactSource } from '../lib/career/types'

let passed = 0
let failed = 0
const failures: string[] = []
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) { passed++; console.log(`PASS ${name}`) }
  else { failed++; failures.push(name); console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}

// ─── Builder ─────────────────────────────────────────────────────────────────

const NOW = '2026-08-28T12:00:00.000Z'
let seq = 0
const ts = () => `2026-08-0${(seq % 9) + 1}T00:00:${String(seq++ % 60).padStart(2, '0')}Z`

interface ExpSpec { id: string; org: string; title: string; start?: string | null; end?: string | null; kind?: ExperienceKind; source?: string; approved?: boolean; location?: string | null; description?: string | null; status?: 'active' | 'merged' }
function exp(s: ExpSpec): EvidenceExperience {
  return {
    id: s.id, user_id: 'u', kind: s.kind ?? 'experience', organization: s.org, title: s.title,
    start_date: s.start ?? null, end_date: s.end ?? null, location: s.location ?? null, description: s.description ?? null,
    display_order: seq, source: s.source ?? 'master_resume', approved: s.approved ?? true, created_at: ts(), updated_at: NOW,
    ...(s.status ? { status: s.status } : {}),
  }
}
interface FactSpec { id: string; exp: string | null; text: string; category?: FactCategory; source?: FactSource; approved?: boolean; edited?: boolean; status?: 'active' | 'merged' }
function fact(s: FactSpec): EvidenceFact {
  return {
    id: s.id, user_id: 'u', experience_id: s.exp, statement: s.text, category: s.category ?? 'achievement',
    source: s.source ?? 'master_resume', source_location: s.source === 'manual' ? 'pasted.manual L4' : 'Resume.docx ¶3', confidence: 1,
    approved: s.approved ?? true, created_at: ts(), updated_at: NOW,
    ...(s.edited ? { edited_by_user: true } : {}), ...(s.status ? { status: s.status } : {}),
  }
}
interface MetricSpec { id: string; exp: string | null; value: string; context?: string | null; facts?: string[]; source?: string; unit?: string | null }
function metric(s: MetricSpec): EvidenceMetric {
  return { id: s.id, user_id: 'u', experience_id: s.exp, value: s.value, unit: s.unit ?? null, context: s.context ?? null, fact_ids: s.facts ?? [], source: s.source ?? 'master_resume', approved: true, created_at: ts() }
}
function bank(parts: { experiences?: EvidenceExperience[]; facts?: EvidenceFact[]; metrics?: EvidenceMetric[] } & Partial<EvidenceBank>): EvidenceBank {
  return { ...emptyBank(), ...parts, experiences: parts.experiences ?? [], facts: parts.facts ?? [], metrics: parts.metrics ?? [] }
}
function plan(b: EvidenceBank, extra: Parameters<typeof buildConsolidationPlan>[1] = {}): ConsolidationPlan {
  return buildConsolidationPlan(b, { now: NOW, migration015: true, ...extra })
}
function pairOf(list: MergeProposal[], a: string, b: string): MergeProposal | undefined {
  return list.find((p) => (p.keep_id === a && p.merge_id === b) || (p.keep_id === b && p.merge_id === a))
}
const cls = (p: MergeProposal | undefined) => p?.confidence ?? 'none'

// ─── Rules ───────────────────────────────────────────────────────────────────

check('qualifierOf comma', qualifierOf('Procter & Gamble, Tabler Station') === 'Tabler Station')
check('qualifierOf paren', qualifierOf("UIUC (Professor Alex Mironenko's lab)") === "Professor Alex Mironenko's lab")
check('qualifierOf none', qualifierOf('Argonne National Laboratory') === null)
check('orgKey strips after-comma', orgKey('Procter & Gamble, Tabler Station') === orgKey('P&G'))
check('orgKey LoopEra qualifier', orgKey('LoopEra, Fashion-Tech Startup') === orgKey('LoopEra'))
check('orgKey Founders dash/colon', orgKey('Founders: Illinois Entrepreneurs') === orgKey('Founders - Illinois Entrepreneurs'))
check('orgKey UIUC lab', orgKey("UIUC (Professor Alex Mironenko's lab)") === orgKey('University of Illinois at Urbana-Champaign'))
check('orgKey never substring', orgKey('PG Solutions') !== orgKey('Procter & Gamble'))
check('location-like site', isLocationLike('Tabler Station') && !isLocationLike("Professor Alex Mironenko's lab"))
check('qualifiers: two labs differ', compareQualifiers("UIUC (Professor A's lab)", "UIUC (Professor B's lab)") === 'different')
check('qualifiers: one missing', compareQualifiers('Procter & Gamble, Tabler Station', 'Procter & Gamble') === 'one_missing')
check('numeric tokens', statementTokens('Organized Keywords, 400+ participants, $4M+ savings, #1').numeric.join(',') === '1,400,4m')

// ─── Real pairs ──────────────────────────────────────────────────────────────

const real = bank({
  experiences: [
    exp({ id: 'pg-r', org: 'Procter & Gamble, Tabler Station', title: 'Quality Assurance Intern', start: '5/2026', end: '8/2026' }),
    exp({ id: 'pg-l', org: 'Procter & Gamble', title: 'Quality Assurance Intern', start: 'May 2026', end: 'Present', source: 'manual' }),
    exp({ id: 'ibc-r', org: 'Illinois Business Consulting', title: 'Project Manager, prev. Senior Consultant', start: '9/2025', end: 'Present' }),
    exp({ id: 'ibc-l', org: 'Illinois Business Consulting', title: 'Project Manager (previously Senior Consultant, Consultant)', start: 'September 2025', end: 'Present', source: 'manual' }),
    exp({ id: 'fnd-r', org: 'Founders: Illinois Entrepreneurs', title: 'President; Formerly Head of Events', start: '12/2024', end: 'Present', kind: 'project' }),
    exp({ id: 'fnd-l', org: 'Founders - Illinois Entrepreneurs', title: 'President (previously Head of Events, Events Team Member)', start: 'February 2025', end: 'Present', kind: 'leadership', source: 'manual' }),
    exp({ id: 'arg-r', org: 'Argonne National Laboratory', title: 'Techno-Economic Analyst', start: '9/2023', end: '4/2024', kind: 'research' }),
    exp({ id: 'arg-l', org: 'Argonne National Laboratory', title: 'Student Researcher', start: 'September 2023', end: 'May 2024', kind: 'research', source: 'manual' }),
    exp({ id: 'uiuc-r', org: 'University of Illinois at Urbana-Champaign', title: 'Undergraduate Researcher', start: '9/2024', end: 'Present', kind: 'research' }),
    exp({ id: 'uiuc-l', org: "UIUC (Professor Alex Mironenko's lab)", title: 'Researcher', kind: 'research', source: 'manual' }),
    exp({ id: 'loop-r', org: 'LoopEra, Fashion-Tech Startup', title: 'Founding Team, Strategy and Sustainability', start: '6/2025', end: '8/2025' }),
    exp({ id: 'loop-l', org: 'LoopEra', title: 'Executive Assistant', start: 'June 2025', end: 'August 2025', source: 'manual' }),
    exp({ id: 'edu-r', org: 'University of Illinois Urbana-Champaign', title: 'Chemical Engineering Student', end: '2028', kind: 'education' }),
    exp({ id: 'edu-l', org: 'University of Illinois at Urbana-Champaign', title: 'B.S. Chemical Engineering', end: 'Expected Graduation: May 2028', kind: 'education', source: 'manual' }),
    exp({ id: 'aw-1', org: 'National Merit', title: 'National Merit Scholar', kind: 'award' }),
    exp({ id: 'aw-2', org: 'Illinois', title: 'State Scholar', kind: 'award' }),
    exp({ id: 'aw-u', org: 'Various / National', title: 'Academic and Public Service Honors', kind: 'award', source: 'manual' }),
    exp({ id: 'imsa-e', org: 'IMSA', title: 'Student', start: '8/2020', end: '5/2023', kind: 'education' }),
    exp({ id: 'imsa-r', org: 'IMSA', title: 'Independent Researcher', start: '8/2021', end: '5/2023', kind: 'research' }),
    exp({ id: 'imsa-l', org: 'IMSA', title: 'Senior Representative / President / VP', start: '8/2020', end: '5/2023', kind: 'leadership' }),
  ],
})
const rp = plan(real)
check('P&G alias + site qualifier → HIGH', cls(pairOf(rp.experiences, 'pg-r', 'pg-l')) === 'HIGH', cls(pairOf(rp.experiences, 'pg-r', 'pg-l')))
check('P&G keep = résumé row', pairOf(rp.experiences, 'pg-r', 'pg-l')?.keep_id === 'pg-r')
check('P&G end_date conflict recorded, stays HIGH', pairOf(rp.experiences, 'pg-r', 'pg-l')?.conflicts.some((c) => c.field === 'end_date') === true)
check('P&G 5/2026 vs May 2026 is not a conflict', pairOf(rp.experiences, 'pg-r', 'pg-l')?.conflicts.some((c) => c.field === 'start_date') === false)
check('IBC → HIGH, no conflicts', cls(pairOf(rp.experiences, 'ibc-r', 'ibc-l')) === 'HIGH' && pairOf(rp.experiences, 'ibc-r', 'ibc-l')?.conflicts.length === 0)
check('Founders project↔leadership → HIGH with start conflict', cls(pairOf(rp.experiences, 'fnd-r', 'fnd-l')) === 'HIGH' && pairOf(rp.experiences, 'fnd-r', 'fnd-l')?.conflicts.some((c) => c.field === 'start_date') === true)
check('Argonne analyst vs researcher → POSSIBLE (same dates)', cls(pairOf(rp.experiences, 'arg-r', 'arg-l')) === 'POSSIBLE' && pairOf(rp.experiences, 'arg-r', 'arg-l')?.rule === 'same_org_same_dates')
check('Argonne title conflict on proposal', pairOf(rp.experiences, 'arg-r', 'arg-l')?.conflicts.some((c) => c.field === 'title') === true)
check('UIUC researcher vs undergraduate researcher → POSSIBLE', cls(pairOf(rp.experiences, 'uiuc-r', 'uiuc-l')) === 'POSSIBLE')
check('LoopEra founding team vs EA → POSSIBLE', cls(pairOf(rp.experiences, 'loop-r', 'loop-l')) === 'POSSIBLE')
check('education UIUC pair → POSSIBLE, not HIGH', cls(pairOf(rp.experiences, 'edu-r', 'edu-l')) === 'POSSIBLE')
check('education never pairs with research', !pairOf(rp.experiences, 'edu-r', 'uiuc-r') && !pairOf(rp.experiences, 'edu-l', 'uiuc-l'))
check('umbrella award never pairs', !rp.experiences.some((p) => p.keep_id === 'aw-u' || p.merge_id === 'aw-u'))
check('IMSA rows stay separate', !rp.experiences.some((p) => p.keep_id.startsWith('imsa') || p.merge_id.startsWith('imsa')))
check('no HIGH proposal beyond the three expected', rp.experiences.filter((p) => p.confidence === 'HIGH').length === 3, String(rp.experiences.filter((p) => p.confidence === 'HIGH').map((p) => p.keep_id)))
check('organizations grouped', rp.organizations.some((o) => o.normalized_name === 'procter and gamble' && o.aliases.length === 2 && o.canonical_name === 'Procter & Gamble'))
check('would_tombstone counts HIGH experiences', rp.summary.would_tombstone === 3)

// ─── Adversarial ─────────────────────────────────────────────────────────────

const adv = bank({
  experiences: [
    exp({ id: 'pg', org: 'Procter & Gamble', title: 'QA Intern', start: '5/2026', end: '8/2026' }),
    exp({ id: 'pgs', org: 'PG Solutions', title: 'QA Intern', start: '5/2026', end: '8/2026', source: 'manual' }),
    exp({ id: 'vp', org: 'Founders', title: 'Vice President', start: '1/2025', end: '6/2025', kind: 'leadership' }),
    exp({ id: 'pres', org: 'Founders', title: 'President', start: '1/2025', end: '6/2025', kind: 'leadership', source: 'manual' }),
    exp({ id: 'hoe', org: 'Founders', title: 'Head of Events', start: '9/2024', end: '12/2024', kind: 'leadership' }),
    exp({ id: 'hoe-same', org: 'Founders', title: 'Head of Events', start: '1/2025', end: '6/2025', kind: 'leadership' }),
    exp({ id: 'vp-abbr', org: 'Founders', title: 'VP', start: '1/2025', end: '6/2025', kind: 'leadership', source: 'manual' }),
    exp({ id: 'vp-undated', org: 'Founders', title: 'VP', kind: 'leadership', source: 'manual' }),
    exp({ id: 'labA', org: "University of Illinois (Professor A's lab)", title: 'Undergraduate Researcher', start: '9/2024', end: 'Present', kind: 'research' }),
    exp({ id: 'labB', org: "University of Illinois (Professor B's lab)", title: 'Undergraduate Researcher', start: '9/2024', end: 'Present', kind: 'research', source: 'manual' }),
    exp({ id: 'pg24', org: 'P&G', title: 'Quality Assurance Intern', start: '5/2024', end: '8/2024' }),
    exp({ id: 'pg25', org: 'Procter & Gamble', title: 'Quality Assurance Intern', start: '5/2025', end: '8/2025' }),
  ],
})
const ap = plan(adv)
check('PG Solutions vs P&G → none', !pairOf(ap.experiences, 'pg', 'pgs'))
check('Vice President vs President, same dates → none', !pairOf(ap.experiences, 'vp', 'pres'))
check('Head of Events vs President, different dates → none', !pairOf(ap.experiences, 'hoe', 'pres'))
check('Head of Events vs President, same dates → POSSIBLE (same_org_same_dates), never HIGH', cls(pairOf(ap.experiences, 'hoe-same', 'pres')) === 'POSSIBLE' && pairOf(ap.experiences, 'hoe-same', 'pres')?.rule === 'same_org_same_dates')
check('"VP" vs President, same dates → POSSIBLE at most', cls(pairOf(ap.experiences, 'vp-abbr', 'pres')) === 'POSSIBLE')
check('"VP" vs President, missing dates → none', !pairOf(ap.experiences, 'vp-undated', 'pres'))
check('the only HIGH in the adversarial bank is VP-undated vs VP-dated (same title)', ap.experiences.filter((p) => p.confidence === 'HIGH').every((p) => p.keep_id.startsWith('vp-') && p.merge_id.startsWith('vp-')), String(ap.experiences.filter((p) => p.confidence === 'HIGH').map((p) => `${p.keep_id}<-${p.merge_id}`)))
check('President is never the keep or merge of a HIGH proposal', !ap.experiences.some((p) => p.confidence === 'HIGH' && (p.keep_id === 'pres' || p.merge_id === 'pres')))
check('two UIUC labs, different professors → not HIGH', cls(pairOf(ap.experiences, 'labA', 'labB')) === 'POSSIBLE')
check('same org+title, disjoint summers → none', !pairOf(ap.experiences, 'pg24', 'pg25') && !pairOf(ap.experiences, 'pg', 'pg24'))
check('disjoint summers emit a warning', ap.warnings.some((w) => /disjoint/.test(w)))

// ─── Facts ───────────────────────────────────────────────────────────────────

const fb = bank({
  experiences: [
    exp({ id: 'pg-r', org: 'Procter & Gamble', title: 'QA Intern', start: '5/2026', end: '8/2026' }),
    exp({ id: 'pg-l', org: 'P&G', title: 'QA Intern', start: '5/2026', end: 'Present', source: 'manual' }),
    exp({ id: 'fnd', org: 'Founders', title: 'President', kind: 'leadership' }),
    exp({ id: 'ibc', org: 'IBC', title: 'Project Manager' }),
  ],
  facts: [
    fact({ id: 'f-rank-r', exp: 'pg-r', text: 'Ranked #1 Top Performing QA intern across all North America' }),
    fact({ id: 'f-rank-l', exp: 'pg-l', text: 'Ranked #1 Top Performing QA Intern in North America', source: 'manual' }),
    fact({ id: 'f-exact-r', exp: 'pg-r', text: 'Led the **line audit** program.' }),
    fact({ id: 'f-exact-l', exp: 'pg-l', text: 'led the line audit program', source: 'manual' }),
    fact({ id: 'f-hack-400', exp: 'fnd', text: 'Organized Keywords, the largest AI hackathon in UIUC history, with 400+ participants' }),
    fact({ id: 'f-hack-200', exp: 'fnd', text: 'Organized Keywords, the largest AI hackathon in UIUC history, with 200+ participants', source: 'manual' }),
    fact({ id: 'f-ibc-1', exp: 'ibc', text: 'Led a 5-person team on a market-entry engagement for a Fortune 500 client' }),
    fact({ id: 'f-ibc-2', exp: 'ibc', text: 'Delivered a pricing strategy engagement for a regional healthcare provider' }),
    fact({ id: 'f-safe-long', exp: 'ibc', text: 'Built a financial model projecting $4M in annual savings for the client' }),
    fact({ id: 'f-safe-short', exp: 'ibc', text: 'Built a financial model projecting $4M in savings', source: 'manual' }),
  ],
  metrics: [
    metric({ id: 'm1', exp: 'ibc', value: '$4M+', context: 'projected savings', facts: ['f-safe-long'] }),
    metric({ id: 'm2', exp: 'ibc', value: '$4M', context: 'projected annual savings', facts: ['f-safe-short'], source: 'manual' }),
    metric({ id: 'm-orphan', exp: 'fnd', value: '400+', context: 'participants' }),
    metric({ id: 'm-orphan-2', exp: 'ibc', value: '5', context: 'team members' }),
    metric({ id: 'm-orphan-none', exp: 'ibc', value: '12%', context: 'growth' }),
  ],
})
const fp = plan(fb)
check('identical statements across the P&G pair → HIGH statement_norm', cls(pairOf(fp.facts, 'f-exact-r', 'f-exact-l')) === 'HIGH' && pairOf(fp.facts, 'f-exact-r', 'f-exact-l')?.rule === 'statement_norm')
const rank = pairOf(fp.facts, 'f-rank-r', 'f-rank-l')
check('near-duplicate rank facts → POSSIBLE (suggestion, never automatic)', cls(rank) === 'POSSIBLE' && ['near_duplicate_statement', 'similar_statement'].includes(rank?.rule ?? ''), `${cls(rank)} ${rank?.rule}`)
check('near_duplicate_statement is never HIGH', !fp.facts.some((p) => p.rule === 'near_duplicate_statement' && p.confidence === 'HIGH'))
check('hackathon 200+ vs 400+ → CONFLICT', cls(pairOf(fp.facts, 'f-hack-400', 'f-hack-200')) === 'CONFLICT')
check('conflict carries the numbers', JSON.stringify(pairOf(fp.facts, 'f-hack-400', 'f-hack-200')?.signals).includes('400'))
check('two IBC engagements → none', !pairOf(fp.facts, 'f-ibc-1', 'f-ibc-2'))
check('no fact proposal crosses unrelated experiences', !fp.facts.some((p) => [p.keep_id, p.merge_id].includes('f-hack-400') && [p.keep_id, p.merge_id].includes('f-ibc-1')))
const safe = pairOf(fp.facts, 'f-safe-long', 'f-safe-short')
check('safest wording = subset statement', safe?.keep_id === 'f-safe-short' && safe.signals.safest === 'Built a financial model projecting $4M in savings' && safe.signals.other_wording === 'Built a financial model projecting $4M in annual savings for the client', cls(safe))
check('safestWording direct', safestWording(fb.facts[8], fb.facts[9]).keep.id === 'f-safe-short')
check('similar metrics $4M+ vs $4M → HIGH', cls(pairOf(fp.metrics, 'm1', 'm2')) === 'HIGH')
const orphan = fp.metrics.find((p) => p.keep_id === 'm-orphan')
check('orphan metric links to the one fact holding 400', orphan?.rule === 'link_orphan_to_fact' && orphan.merge_id === 'f-hack-400')
check('orphan with no matching fact stays orphaned + warned', fp.summary.metrics.orphaned >= 1 && fp.warnings.some((w) => /orphan metric "12%/.test(w)))
const orphan2 = fp.metrics.find((p) => p.keep_id === 'm-orphan-2')
check('orphan "5 team members" links to the one IBC fact holding 5', orphan2?.rule === 'link_orphan_to_fact' && orphan2.merge_id === 'f-ibc-1', String(orphan2?.merge_id))

// ─── planMutations invariants ────────────────────────────────────────────────

const mb = bank({
  experiences: [
    exp({ id: 'k', org: 'Procter & Gamble', title: 'QA Intern', start: '5/2026', end: null, location: null, description: null }),
    exp({ id: 'm', org: 'P&G', title: 'QA Intern', start: 'May 2026', end: 'Present', location: 'Tabler Station, WV', description: 'Summer internship', source: 'manual' }),
  ],
  facts: [
    fact({ id: 'fk', exp: 'k', text: 'Led the line audit program' }),
    fact({ id: 'fm', exp: 'm', text: 'Led the line audit program.', source: 'manual' }),
    fact({ id: 'fm2', exp: 'm', text: 'Trained 12 operators on the new SOP', source: 'manual' }),
  ],
  metrics: [metric({ id: 'mm', exp: 'm', value: '12', context: 'operators', facts: ['fm2'] }), metric({ id: 'mk', exp: 'k', value: '3', context: 'audits', facts: ['fm'] })],
  deliverables: [{ id: 'd1', user_id: 'u', experience_id: 'm', description: 'SOP deck', fact_ids: ['fm'], approved: true, created_at: NOW }],
  stories: [{ id: 's1', user_id: 'u', experience_id: 'm', title: 'Audit', situation: null, task: null, actions: null, result: null, learning: null, evidence_fact_ids: ['fm', 'fm2'], approved: true, created_at: NOW, updated_at: NOW }],
  skills: [{ id: 'sk1', user_id: 'u', name: 'Auditing', category: 'domain', evidence_fact_ids: ['fm'], approved: true, created_at: NOW }],
  bullets: [{ id: 'b1', user_id: 'u', resume_document_id: null, experience_id: 'm', paragraph_index: 4, display_order: 1, text: 'Led the line audit program', evidence_fact_ids: ['fm'], source_resume: 'master', is_on_master: true, approved: true, created_at: NOW, updated_at: NOW }],
  factSources: [{ id: 'fs1', user_id: 'u', fact_id: 'fm', source_id: 'src-linkedin', location: 'L4', quote: null, confidence: 1, created_at: NOW }],
  experienceSources: [{ id: 'es1', user_id: 'u', experience_id: 'm', source_id: 'src-linkedin', location: null, title_as_written: 'QA Intern', dates_as_written: null, created_at: NOW }],
})
const mp = plan(mb)
const high = [...mp.experiences, ...mp.facts, ...mp.metrics].filter((p) => p.confidence === 'HIGH')
const muts = planMutations(mp, mb, high)
check('experience pair k/m is HIGH', cls(pairOf(mp.experiences, 'k', 'm')) === 'HIGH')
check('fact pair fk/fm is HIGH', cls(pairOf(mp.facts, 'fk', 'fm')) === 'HIGH')
check('no mutation is a delete', muts.every((x) => x.op === 'insert' || x.op === 'update'))
const repointed = new Set(muts.filter((x) => x.kind === 'repoint').map((x) => `${x.table}:${x.child_id}`))
for (const want of ['evidence_facts:fm', 'evidence_facts:fm2', 'evidence_metrics:mm', 'evidence_deliverables:d1', 'evidence_stories:s1', 'resume_bullets:b1', 'evidence_experience_sources:es1']) {
  check(`experience merge re-points ${want}`, repointed.has(want))
}
for (const want of ['evidence_metrics:mk', 'evidence_deliverables:d1', 'evidence_stories:s1', 'evidence_skills:sk1', 'resume_bullets:b1', 'evidence_fact_sources:fs1']) {
  check(`fact merge re-points ${want}`, repointed.has(want))
}
const fsRepoint = muts.find((x) => x.table === 'evidence_fact_sources' && x.child_id === 'fs1')
check('fact_sources re-point keeps the merged wording as quote', fsRepoint?.values.quote === 'Led the line audit program.')
const fill = muts.find((x) => x.table === 'evidence_experiences' && x.kind === 'fill' && x.id === 'k')
check('null fields filled from merged row', fill?.values.end_date === 'Present' && fill.values.location === 'Tabler Station, WV' && fill.values.description === 'Summer internship' && fill.values.source_count === 2)
check('experience merge_status CORROBORATED (no conflicts)', fill?.values.merge_status === 'CORROBORATED')
const tomb = muts.filter((x) => x.kind === 'tombstone')
check('tombstones for m and fm only', tomb.length === 2 && tomb.every((t) => t.values.status === 'merged' && t.values.merged_into))
const expTomb = muts.findIndex((x) => x.kind === 'tombstone' && x.id === 'm')
const factTomb = muts.findIndex((x) => x.kind === 'tombstone' && x.id === 'fm')
const lastExpRepoint = muts.map((x) => x.kind === 'repoint' && x.values.experience_id === 'k').lastIndexOf(true)
const lastFactRepoint = muts.map((x) => x.kind === 'repoint' && JSON.stringify(x.values).includes('"fk"')).lastIndexOf(true)
check('experience tombstone comes after every re-point of its children', expTomb > lastExpRepoint && lastExpRepoint >= 0)
check('fact tombstone comes after every re-point of its citations', factTomb > lastFactRepoint && lastFactRepoint >= 0)
const factFill = muts.find((x) => x.table === 'evidence_facts' && x.kind === 'fill')
check('fact support_count = distinct sources (2)', factFill?.values.support_count === 2 && factFill.values.fact_status === 'CORROBORATED')
check('story fact ids deduped after replace', (muts.find((x) => x.table === 'evidence_stories' && x.kind === 'repoint' && (x.values.evidence_fact_ids as string[] | undefined)?.includes('fk'))?.values.evidence_fact_ids as string[]).length === 2)
check('plan reports would_repoint > 0', mp.summary.would_repoint >= 10)

// Edited-by-user statement is not rewritten.
const eb = bank({
  experiences: [exp({ id: 'e', org: 'IBC', title: 'PM' })],
  facts: [fact({ id: 'a', exp: 'e', text: 'Built a model projecting $4M in annual savings', edited: true }), fact({ id: 'b', exp: 'e', text: 'Built a model projecting $4M in savings', source: 'manual' })],
})
const ep = plan(eb)
const em = planMutations(ep, eb, ep.facts)
const editedPair = pairOf(ep.facts, 'a', 'b')
check('user-edited fact is the keep even though the other wording is safer', editedPair?.keep_id === 'a' && editedPair.signals.safest === 'Built a model projecting $4M in savings')
check('edited fact keeps its statement (no statement fill)', em.some((x) => x.table === 'evidence_facts' && x.kind === 'fill' && x.id === 'a') && !em.some((x) => x.table === 'evidence_facts' && x.kind === 'fill' && 'statement' in x.values))
const ub = bank({
  experiences: [exp({ id: 'e', org: 'IBC', title: 'PM' })],
  facts: [fact({ id: 'a', exp: 'e', text: 'Built a model projecting $4M in annual savings' }), fact({ id: 'b', exp: 'e', text: 'Built a model projecting $4M in savings', source: 'manual' })],
})
const up = plan(ub)
check('control: without an edit the subset wording is the keep', pairOf(up.facts, 'a', 'b')?.keep_id === 'b')

// ─── Chains, ambiguity, capped children ──────────────────────────────────────

const chain = bank({
  experiences: [
    exp({ id: 'A', org: 'P&G', title: 'QA Intern', start: '5/2026', end: '8/2026', source: 'manual' }),
    exp({ id: 'B', org: 'Procter & Gamble', title: 'QA Intern', start: '5/2026', end: '8/2026', source: 'manual' }),
    exp({ id: 'C', org: 'Procter and Gamble', title: 'QA Intern', start: '5/2026', end: '8/2026', source: 'manual' }),
  ],
  facts: [fact({ id: 'fa', exp: 'A', text: 'Audited line 1' }), fact({ id: 'fb', exp: 'B', text: 'Audited line 2' }), fact({ id: 'fc', exp: 'C', text: 'Audited line 3' })],
})
const chp = plan(chain)
const chainHigh = chp.experiences.filter((p) => p.confidence === 'HIGH')
check('triple duplicate → two proposals, both keep the oldest row', chainHigh.length === 2 && chainHigh.every((p) => p.keep_id === 'A'), String(chp.experiences.map((p) => `${p.keep_id}<-${p.merge_id}`)))
check('triple duplicate: every merge_id appears once', new Set(chainHigh.map((p) => p.merge_id)).size === chainHigh.length)
check('would_tombstone === distinct merged rows (2 of 3)', chp.summary.would_tombstone === 2)
check('redundant chain edge is reported as a warning', chp.warnings.some((w) => /redundant merge dropped/.test(w)))
const chainMuts = planMutations(chp, chain, chainHigh)
const tombstoned = new Set(chainMuts.filter((x) => x.kind === 'tombstone').map((x) => x.id))
check('no re-point targets a row tombstoned in the same mutation list', chainMuts.filter((x) => x.kind === 'repoint').every((x) => !tombstoned.has(String(x.values.experience_id))))
check('every fact of B and C is re-pointed to A', ['fb', 'fc'].every((id) => chainMuts.some((x) => x.kind === 'repoint' && x.child_id === id && x.values.experience_id === 'A')))
check('no tombstoned row is also a keep', !chainMuts.some((x) => x.kind === 'fill' && tombstoned.has(x.id)))
// Applying a stale plan pair-by-pair over a bank where a row was already tombstoned emits nothing.
const afterFirst: EvidenceBank = { ...chain, experiences: chain.experiences.map((e) => (e.id === 'B' ? { ...e, status: 'merged' as const, merged_into: 'A' } : e)) }
check('pair whose merge_id is already tombstoned yields no mutations', planMutations(chp, afterFirst, [{ entity_type: 'experience', keep_id: 'A', merge_id: 'B' }]).length === 0)
check('surviving pair still applies against the reloaded bank', planMutations(chp, afterFirst, [{ entity_type: 'experience', keep_id: 'A', merge_id: 'C' }]).some((x) => x.kind === 'tombstone' && x.id === 'C'))
check('chain plan is deterministic', JSON.stringify(plan(chain)) === JSON.stringify(plan(chain)))

const ambiguous = bank({
  experiences: [
    exp({ id: 'D1', org: 'Procter & Gamble', title: 'QA Intern', start: '5/2024', end: '8/2024' }),
    exp({ id: 'D2', org: 'Procter & Gamble', title: 'QA Intern', start: '5/2025', end: '8/2025' }),
    exp({ id: 'L', org: 'P&G', title: 'QA Intern', source: 'manual' }),
  ],
})
const amp = plan(ambiguous)
check('undated row matching two disjoint summers → no HIGH proposal', amp.experiences.every((p) => p.confidence !== 'HIGH'), String(amp.experiences.map((p) => `${p.confidence} ${p.keep_id}<-${p.merge_id}`)))
check('ambiguous cluster is listed as POSSIBLE for a human', amp.experiences.filter((p) => p.merge_id === 'L' && p.confidence === 'POSSIBLE' && p.signals.downgraded === 'ambiguous_cluster').length === 2)
check('ambiguous cluster warned', amp.warnings.some((w) => /ambiguous duplicate cluster/.test(w)))
check('ambiguous cluster tombstones nothing', amp.summary.would_tombstone === 0)

const labs = bank({
  experiences: [
    exp({ id: 'labA', org: "University of Illinois (Professor A's lab)", title: 'Undergraduate Researcher', start: '9/2024', end: 'Present', kind: 'research' }),
    exp({ id: 'labB', org: "University of Illinois (Professor B's lab)", title: 'Undergraduate Researcher', start: '9/2024', end: 'Present', kind: 'research', source: 'manual' }),
  ],
  facts: [fact({ id: 'fa', exp: 'labA', text: 'Presented findings at the weekly group meeting' }), fact({ id: 'fb', exp: 'labB', text: 'Presented findings at the weekly group meeting', source: 'manual' })],
  metrics: [metric({ id: 'ma', exp: 'labA', value: '12', context: 'samples per week', facts: ['fa'] }), metric({ id: 'mb', exp: 'labB', value: '12', context: 'samples per week', facts: ['fb'], source: 'manual' })],
})
const lp = plan(labs)
check('two labs → POSSIBLE experience pair', cls(pairOf(lp.experiences, 'labA', 'labB')) === 'POSSIBLE')
check('identical fact under a POSSIBLE experience pair is capped at POSSIBLE', cls(pairOf(lp.facts, 'fa', 'fb')) === 'POSSIBLE' && pairOf(lp.facts, 'fa', 'fb')?.signals.downgraded === 'experience_pair_not_high')
check('identical metric under a POSSIBLE experience pair is capped at POSSIBLE', cls(pairOf(lp.metrics, 'ma', 'mb')) === 'POSSIBLE')
const lpHigh = [...lp.experiences, ...lp.facts, ...lp.metrics].filter((p) => p.confidence === 'HIGH')
check('nothing under the two labs would be tombstoned automatically', planMutations(lp, labs, lpHigh).every((x) => x.kind !== 'tombstone') && lp.summary.would_tombstone === 0)
check('POSSIBLE experience disagreements are not plan-level conflicts', !lp.conflicts.some((c) => c.entity_type === 'experience'))
check('HIGH experience conflicts and CONFLICT facts are plan-level conflicts', rp.conflicts.some((c) => c.entity_type === 'experience' && c.entity_id === 'pg-r') && fp.conflicts.some((c) => c.entity_type === 'fact') && !rp.conflicts.some((c) => c.entity_id === 'arg-r'))

// ─── Idempotency, tombstones, suppression ────────────────────────────────────

check('same plan twice is deep-equal', JSON.stringify(plan(real)) === JSON.stringify(plan(real)))
check('plan honours opts.now', plan(real, { now: '2030-01-01T00:00:00Z' }).generated_at === '2030-01-01T00:00:00Z')
const consolidated = bank({
  experiences: [exp({ id: 'k', org: 'P&G', title: 'QA Intern', start: '5/2026', end: '8/2026' }), exp({ id: 'm', org: 'Procter & Gamble', title: 'QA Intern', start: '5/2026', end: '8/2026', status: 'merged' })],
  facts: [fact({ id: 'a', exp: 'k', text: 'Led audits' }), fact({ id: 'b', exp: 'k', text: 'Led audits.', status: 'merged' })],
})
const cp = plan(consolidated)
check('already-consolidated bank yields zero proposals', cp.experiences.length === 0 && cp.facts.length === 0 && cp.metrics.length === 0 && cp.summary.would_tombstone === 0)
const sp = plan(real, { suppressed: [{ entity_type: 'experience', keep_id: 'pg-r', merge_id: 'pg-l' }] })
check('kept_separate pair suppressed', !pairOf(sp.experiences, 'pg-r', 'pg-l') && sp.suppressed.length === 1)
check('suppression works in either orientation', !pairOf(plan(real, { suppressed: [{ entity_type: 'experience', keep_id: 'pg-l', merge_id: 'pg-r' }] }).experiences, 'pg-r', 'pg-l'))
check('migration015 flag reported', plan(real, { migration015: false }).migration015 === false)

// ─── Provenance + summaries + report ─────────────────────────────────────────

check('facts without provenance listed', fp.provenance.facts_missing_provenance.length === fb.facts.length && fp.provenance.sources_to_create.some((s) => s.label === 'Resume.docx' && s.kind === 'resume'))
check('provenance covered facts excluded', mp.provenance.facts_missing_provenance.every((f) => f.fact_id !== 'fm'))

const sb = bank({
  experiences: [exp({ id: 'e', org: 'IBC', title: 'PM' })],
  facts: [
    fact({ id: 'c1', exp: 'e', text: 'Context about the club', category: 'context' }),
    fact({ id: 'a1', exp: 'e', text: 'Won **first place** at the case competition', category: 'achievement' }),
    fact({ id: 'r1', exp: 'e', text: 'Managed a team of four consultants', category: 'responsibility' }),
    fact({ id: 'x1', exp: 'e', text: 'Not approved achievement', category: 'achievement', approved: false }),
  ],
})
const s1 = buildCanonicalSummary(sb, 'e')
check('summary picks achievement then responsibility', s1.fact_ids.join(',') === 'a1,r1', s1.fact_ids.join(','))
check('summary strips markdown', s1.summary === 'Won first place at the case competition; Managed a team of four consultants')
check('summary deterministic', JSON.stringify(buildCanonicalSummary(sb, 'e')) === JSON.stringify(s1))
const longBank = bank({ experiences: [exp({ id: 'e', org: 'X', title: 'Y' })], facts: [fact({ id: 'l1', exp: 'e', text: 'word '.repeat(80).trim() }), fact({ id: 'l2', exp: 'e', text: 'other '.repeat(80).trim() })] })
check('summary ≤ 240 chars', buildCanonicalSummary(longBank, 'e').summary.length <= 240)
check('plan lists changed summaries', plan(sb).summaries.some((s) => s.experience_id === 'e' && s.changed))
const edited = bank({ experiences: [{ ...exp({ id: 'e', org: 'IBC', title: 'PM' }), edited_by_user: true, canonical_summary: 'mine' }], facts: [fact({ id: 'a1', exp: 'e', text: 'Won' })] })
check('edited summaries skipped', plan(edited).summaries.length === 0)

const report = renderPlanReport(rp)
check('report has header counts and sections', /EXPERIENCES — HIGH \(3\)/.test(report) && /CONFLICTS/.test(report) && /WARNINGS/.test(report))
check('planToJson round-trips', JSON.parse(planToJson(rp)).summary.experiences.high === 3)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exitCode = 1 }
