// Offline tests for the canonical view the Evidence page's first tab reads.
//
//   npx tsx scripts/test-career-canonical-view.ts
//
// Synthetic bank in memory: no database, no keys. Covers grouping (015
// organization_id vs normalized-name fallback), tombstone exclusion, key-fact
// selection (summary_fact_ids, then category rank + support), provenance
// labels with and without 015 rows, and the pending/unattached paths.

import { emptyBank } from '../lib/career/evidence/store'
import { buildCanonicalView, factSourceLabels, keyFactsFor } from '../app/api/career/evidence/canonical/build'
import { buildConsolidationPlan } from '../lib/career/evidence/consolidate'
import { guardPlan } from '../app/api/career/evidence/review/guard'
import type { EvidenceBank, EvidenceExperience, EvidenceFact, FactCategory } from '../lib/career/types'

let passed = 0
let failed = 0
const failures: string[] = []
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) passed++
  else { failed++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`) }
}

const NOW = '2026-08-28T00:00:00Z'
let n = 0
function exp(over: Partial<EvidenceExperience> & { organization: string; title: string }): EvidenceExperience {
  n++
  return {
    id: `exp-${n}`, user_id: 'u', kind: 'experience', start_date: null, end_date: null, location: null, description: null,
    display_order: n, source: 'master_resume', approved: true, created_at: NOW, updated_at: NOW, ...over,
  }
}
function fact(experience_id: string | null, statement: string, category: FactCategory, over: Partial<EvidenceFact> = {}): EvidenceFact {
  n++
  return {
    id: `fact-${n}`, user_id: 'u', experience_id, statement, category, source: 'master_resume', source_location: `¶${n}`,
    confidence: 1, approved: true, created_at: `2026-01-${String(n).padStart(2, '0')}T00:00:00Z`, updated_at: NOW, ...over,
  }
}

// ─── Pre-015 bank: grouping by normalized name ───────────────────────────────
{
  const bank: EvidenceBank = emptyBank()
  const a = exp({ organization: 'Procter & Gamble', title: 'Intern', start_date: 'May 2025', end_date: 'Aug 2025' })
  const b = exp({ organization: 'P&G', title: 'Analyst', kind: 'project', approved: false })
  const c = exp({ organization: 'University of Illinois', title: 'BS', kind: 'education' })
  const gone = exp({ organization: 'P&G', title: 'Intern', status: 'merged', merged_into: a.id })
  bank.experiences = [a, b, c, gone]
  const f1 = fact(a.id, 'Wrote the context fact', 'context')
  const f2 = fact(a.id, 'Cut cycle time 30%', 'achievement')
  const f3 = fact(a.id, 'Owned a $2M line', 'scope')
  const f4 = fact(a.id, 'Corroborated responsibility', 'responsibility', { support_count: 3 })
  const f5 = fact(a.id, 'Single-source responsibility', 'responsibility', { support_count: 1 })
  const dead = fact(a.id, 'Merged away', 'achievement', { status: 'merged' })
  const loose = fact(null, 'Unattached claim', 'other')
  const orphan = fact(gone.id, 'Fact under a tombstone', 'other')
  bank.facts = [f1, f2, f3, f4, f5, dead, loose, orphan]
  bank.metrics = [{ id: 'm1', user_id: 'u', experience_id: a.id, value: '30%', unit: null, context: 'cycle time', fact_ids: [f2.id], source: 'master_resume', approved: true, created_at: NOW }]
  bank.skills = [{ id: 's1', user_id: 'u', name: 'SQL', category: 'technical', evidence_fact_ids: [], approved: true, created_at: NOW } as never]

  const view = buildCanonicalView(bank)
  check('two organizations after alias grouping', view.organizations.length === 2, `${view.organizations.map((o) => o.canonical_name).join(' | ')}`)
  const pg = view.organizations.find((o) => o.canonical_name === 'Procter & Gamble')
  check('P&G group has no id before 015', Boolean(pg) && pg!.id === null)
  check('P&G group holds two active roles, not the tombstone', pg?.roles.length === 2, `${pg?.roles.length}`)
  check('alias recorded from the variant spelling', Boolean(pg?.aliases.includes('P&G')), pg?.aliases.join(','))
  check('kind inferred as company', pg?.kind === 'company')
  const uiuc = view.organizations.find((o) => o.canonical_name === 'University of Illinois')
  check('university kind inferred', uiuc?.kind === 'university')

  const role = pg!.roles.find((r) => r.experience.id === a.id)!
  check('period joins start and end', role.experience.period === 'May 2025 – Aug 2025', role.experience.period)
  check('no merge_status before 015', role.experience.merge_status === null)
  check('tombstoned fact excluded from allFacts', role.allFacts.length === 5 && !role.allFacts.some((f) => f.id === dead.id), `${role.allFacts.length}`)
  check('key facts capped at 3', role.keyFacts.length === 3)
  check('achievement ranks first', role.keyFacts[0].id === f2.id, role.keyFacts[0].statement)
  check('responsibility ranks before scope (summary.ts order)', role.keyFacts[1].id === f4.id, role.keyFacts[1].statement)
  check('higher support wins within a category', role.keyFacts[2].id === f5.id && !role.keyFacts.some((f) => f.id === f3.id), role.keyFacts[2].statement)
  check('context fact not among key facts', !role.keyFacts.some((f) => f.id === f1.id))
  check('metric inline', role.metrics.length === 1 && role.metrics[0].value === '30%')
  check('legacy source label falls back to source + location', role.allFacts[0].sources.length === 1 && /^Résumé ¶\d+$/.test(role.allFacts[0].sources[0]), role.allFacts[0].sources[0])
  check('role source list derived from facts when no provenance rows', role.sources.join() === 'Résumé', role.sources.join(','))
  const pendingRole = pg!.roles.find((r) => r.experience.id === b.id)!
  check('pending role included and flagged', pendingRole.experience.approved === false)
  check('unattached includes null experience and tombstone orphan', view.unattached.facts.length === 2 && view.unattached.facts.some((f) => f.id === loose.id) && view.unattached.facts.some((f) => f.id === orphan.id), `${view.unattached.facts.length}`)
  check('skills counted', view.unattached.skills === 1)
  check('deterministic: same input, same output', JSON.stringify(buildCanonicalView(bank)) === JSON.stringify(view))
}

// ─── 015 bank: organization_id, summary_fact_ids, provenance rows ────────────
{
  const bank: EvidenceBank = emptyBank()
  bank.organizations = [{ id: 'org-1', user_id: 'u', canonical_name: 'Procter & Gamble', normalized_name: 'procter and gamble', aliases: ['P&G'], kind: 'company', company_id: null, created_at: NOW, updated_at: NOW }]
  bank.sources = [
    { id: 'src-r', user_id: 'u', kind: 'resume', label: 'Résumé', sha256: null, content: null, storage_path: null, resume_document_id: null, metadata: {}, imported_at: NOW },
    { id: 'src-l', user_id: 'u', kind: 'linkedin_profile', label: 'LinkedIn', sha256: null, content: null, storage_path: null, resume_document_id: null, metadata: {}, imported_at: NOW },
  ]
  const a = exp({ organization: 'P&G', title: 'Intern', organization_id: 'org-1', merge_status: 'CORROBORATED', source_count: 2, canonical_summary: 'Cut cycle time 30%; Owned a $2M line' })
  const other = exp({ organization: 'Totally Different Co', title: 'Intern', organization_id: 'org-1' })
  bank.experiences = [a, other]
  const f1 = fact(a.id, 'Context', 'context')
  const f2 = fact(a.id, 'Cut cycle time 30%', 'achievement', { support_count: 2, fact_status: 'CORROBORATED' })
  const f3 = fact(a.id, 'Owned a $2M line', 'scope')
  bank.facts = [f1, f2, f3]
  a.summary_fact_ids = [f3.id, f2.id, 'fact-missing']
  bank.factSources = [
    { id: 'fs1', user_id: 'u', fact_id: f2.id, source_id: 'src-r', location: '¶6', quote: null, confidence: 1, created_at: NOW },
    { id: 'fs2', user_id: 'u', fact_id: f2.id, source_id: 'src-l', location: 'L350', quote: null, confidence: 0.9, created_at: NOW },
  ]
  bank.experienceSources = [{ id: 'es1', user_id: 'u', experience_id: a.id, source_id: 'src-r', location: null, title_as_written: null, dates_as_written: null, created_at: NOW }]
  bank.projects = [
    { id: 'p1', user_id: 'u', experience_id: a.id, organization_id: 'org-1', name: 'Forge 2026', name_norm: 'forge 2026', description: 'the hackathon', fact_ids: [f2.id], approved: true, status: 'active', merged_into: null, created_at: NOW, updated_at: NOW },
    { id: 'p2', user_id: 'u', experience_id: a.id, organization_id: 'org-1', name: 'Old', name_norm: 'old', description: null, fact_ids: [], approved: true, status: 'merged', merged_into: 'p1', created_at: NOW, updated_at: NOW },
  ]

  const view = buildCanonicalView(bank)
  check('one organization by id even with a different raw name', view.organizations.length === 1 && view.organizations[0].id === 'org-1', `${view.organizations.length}`)
  check('organization aliases come from the row', view.organizations[0].aliases.join() === 'P&G')
  const role = view.organizations[0].roles.find((r) => r.experience.id === a.id)!
  check('summary_fact_ids order kept, unknown id dropped', role.keyFacts.map((f) => f.id).join() === `${f3.id},${f2.id}`, role.keyFacts.map((f) => f.id).join())
  check('merge_status and source_count pass through', role.experience.merge_status === 'CORROBORATED' && role.experience.source_count === 2)
  check('canonical summary passes through', role.experience.canonical_summary === 'Cut cycle time 30%; Owned a $2M line')
  check('provenance labels: source label + location', factSourceLabels(bank, f2).join(' | ') === 'Résumé ¶6 | LinkedIn L350', factSourceLabels(bank, f2).join(' | '))
  check('fact support and status pass through', role.keyFacts[1].support_count === 2 && role.keyFacts[1].fact_status === 'CORROBORATED')
  check('tombstoned project excluded', role.projects.length === 1 && role.projects[0].name === 'Forge 2026' && role.projects[0].factCount === 1)
  check('role sources: experience provenance first, then fact sources, no locations', role.sources.join(' | ') === 'Résumé | LinkedIn', role.sources.join(' | '))
  check('keyFactsFor falls back to ranking when summary ids are all unknown', keyFactsFor({ ...a, summary_fact_ids: ['nope'] }, role.allFacts, new Map()).length === 3)
}

// ─── Route guard: what "Merge all high-confidence" may never apply unattended ──
{
  const cases: { name: string; a: EvidenceExperience; b: EvidenceExperience; expect: string }[] = [
    {
      name: 'two labs by PI surname, undated',
      a: exp({ organization: 'UIUC (Mironenko)', title: 'Undergraduate Researcher', kind: 'research' }),
      b: exp({ organization: 'University of Illinois (Diao)', title: 'Undergraduate Researcher', kind: 'research', source: 'linkedin' }),
      expect: 'qualifiers_differ_no_dates',
    },
    {
      name: 'qualifier missing on one side, undated',
      a: exp({ organization: 'UIUC', title: 'Research Assistant', kind: 'research' }),
      b: exp({ organization: 'UIUC (Diao Lab)', title: 'Research Assistant', kind: 'research', source: 'linkedin' }),
      expect: 'qualifiers_differ_no_dates',
    },
    {
      name: 'two P&G sites, undated',
      a: exp({ organization: 'Procter & Gamble, Tabler Station', title: 'Intern' }),
      b: exp({ organization: 'Procter & Gamble, Cincinnati', title: 'Intern', source: 'linkedin' }),
      expect: 'qualifiers_differ_no_dates',
    },
    {
      name: 'merge side edited by user',
      a: exp({ organization: 'Procter & Gamble', title: 'Intern', start_date: 'May 2025', end_date: 'Aug 2025' }),
      b: exp({ organization: 'Procter & Gamble', title: 'Intern', start_date: 'May 2025', end_date: 'Aug 2025', source: 'linkedin', edited_by_user: true, location: 'Cincinnati' }),
      expect: 'merge_side_edited_by_user',
    },
  ]
  for (const c of cases) {
    const bank: EvidenceBank = emptyBank()
    bank.experiences = [c.a, c.b]
    const raw = buildConsolidationPlan(bank, { now: NOW })
    const guarded = guardPlan(raw, bank, NOW)
    const p = guarded.experiences[0]
    const downgraded = p ? String((p.signals as { downgraded?: string }).downgraded) : ''
    check(`guard: ${c.name} — engine proposes the pair`, raw.experiences.length === 1, `${raw.experiences.length} proposals`)
    check(`guard: ${c.name} — not HIGH after the guard`, !!p && p.confidence === 'POSSIBLE', p ? `${p.confidence} ${p.rule}` : 'no proposal')
    check(`guard: ${c.name} — reason recorded`, downgraded === c.expect, downgraded)
    check(`guard: ${c.name} — summary counts follow`, guarded.summary.experiences.high === 0 && guarded.summary.experiences.possible === guarded.experiences.length)
  }
  // The safe case stays HIGH: same qualifier, same dates, nothing edited.
  const bank: EvidenceBank = emptyBank()
  bank.experiences = [
    exp({ organization: 'Procter & Gamble', title: 'Intern', start_date: 'May 2025', end_date: 'Aug 2025' }),
    exp({ organization: 'P&G', title: 'Intern', start_date: 'May 2025', end_date: 'Aug 2025', source: 'linkedin' }),
  ]
  const raw = buildConsolidationPlan(bank, { now: NOW })
  const guarded = guardPlan(raw, bank, NOW)
  check('guard: same org, same dates, unedited stays HIGH', raw.experiences.length === 1 && guarded.experiences[0]?.confidence === 'HIGH', raw.experiences.map((p) => `${p.confidence} ${p.rule}`).join())
  check('guard: untouched plan is returned as-is', guarded === raw)
  // Two dated sites: dates tell them apart, so the guard defers to the engine.
  const bank2: EvidenceBank = emptyBank()
  bank2.experiences = [
    exp({ organization: 'Procter & Gamble, Tabler Station', title: 'Intern', start_date: 'May 2025', end_date: 'Aug 2025' }),
    exp({ organization: 'Procter & Gamble, Cincinnati', title: 'Intern', start_date: 'May 2025', end_date: 'Aug 2025', source: 'linkedin' }),
  ]
  const raw2 = buildConsolidationPlan(bank2, { now: NOW })
  check('guard: differing sites with identical dates are left to the engine', guardPlan(raw2, bank2, NOW).experiences.every((p) => !(p.signals as { guarded_by?: string }).guarded_by))
}


console.log(`\n${passed} passed, ${failed} failed`)
for (const f of failures) console.log(`FAIL ${f}`)
if (failed > 0) process.exit(1)
