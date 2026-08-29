// Persisting an ImportProposal into the Evidence Bank.
//
// Idempotent by content, not by run: an experience that IS one already in the
// bank (normalized org + title, or a same-org row with a similar title and
// compatible dates — see ./plan) is reused, a bullet at the same paragraph of
// the same document is reused, a fact with the same normalized statement
// under the same experience is reused, a metric or deliverable already
// recorded under that experience is skipped, a skill with the same name is
// merged. Re-running is the normal operating condition — the same rule
// migrations live by.
//
// The decisions are made by planPersist, a pure function; this file executes
// them in dependency order (experiences → facts → bullets → metrics,
// deliverables → skills → provenance) because fact ids are needed before
// anything can cite them.
//
// Every import is also a SOURCE RECORD (015): facts inserted or reused point
// at it through evidence_fact_sources, experiences through
// evidence_experience_sources, and a reused experience whose title or dates
// this source states differently becomes a conflict — the résumé's value is
// never overwritten. On a 014-only database every one of those writes is
// skipped and counted in `provenanceSkipped`, never thrown.
//
// What the résumé itself asserts (experiences, bullets) lands approved: those
// are the document's own identity lines. What the agent DERIVED lands with
// the caller's `approve` flag, false by default (docs/CAREER_OS.md §10).

import { createServiceClient } from '@/lib/supabase/server'
import type { SourceKind } from '../types'
import type { ImportProposal } from './import'
import { normalizeMetricValue, normalizeOrg, normalizeStatement, normalizeTitle } from './normalize'
import { planPersist, type Corroboration, type MatchedExperience, type NearMiss } from './plan'
import { recordProvenance } from './provenance'
import { persistProjects } from './sources'
import { insertRows, insertRowsTolerant, loadEvidenceBank } from './store'

export interface SeedCounts {
  documents: number
  documentReused: boolean
  experiences: number
  experiencesReused: number
  bullets: number
  facts: number
  metrics: number
  skills: number
  deliverables: number
  preferences: number
  missionCreated: boolean
  /** Experiences reused under a rule other than the exact string — worth a glance. */
  matched: MatchedExperience[]
  /** Same org, title too different to merge on: inserted, and flagged for a human. */
  nearMisses: NearMiss[]
  /** Facts already in the bank that a second source also states. */
  corroborated: Corroboration[]
  // 015 provenance. Zero on a 014-only database, with provenanceSkipped saying why.
  sources: { created: number; reused: number }
  factSources: number
  experienceSources: number
  conflicts: number
  projects: number
  /** 015 writes skipped because the schema is not there yet. */
  provenanceSkipped: number
}

export function emptyCounts(): SeedCounts {
  return {
    documents: 0, documentReused: false, experiences: 0, experiencesReused: 0, bullets: 0,
    facts: 0, metrics: 0, skills: 0, deliverables: 0, preferences: 0, missionCreated: false,
    matched: [], nearMisses: [], corroborated: [],
    sources: { created: 0, reused: 0 }, factSources: 0, experienceSources: 0, conflicts: 0, projects: 0, provenanceSkipped: 0,
  }
}

// ─── Persisting a proposal ───────────────────────────────────────────────────

export interface PersistOptions {
  approve: boolean
  documentId: string | null
  /** Source label for bullets: 'master' or the alternate's label. */
  sourceResume?: string
  isOnMaster?: boolean
  counts?: SeedCounts
  // The source record this import becomes (015).
  sourceKind?: SourceKind
  /** Résumé: the filename. Text: caller-supplied, else "<Kind> pasted <date>". */
  sourceLabel?: string
  /** Raw text as imported. Résumé imports default to the extracted paragraph text. */
  rawText?: string | null
  /** Hash of the file/text; computed from rawText when absent. */
  sourceSha256?: string | null
  resumeDocumentId?: string | null
}

/**
 * Writes a proposal's rows, reusing what already exists. fact_refs resolve to
 * inserted ids; bullets get the ids of the facts that cite their paragraph.
 */
export async function persistProposal(
  userId: string,
  proposal: ImportProposal,
  opts: PersistOptions
): Promise<{ counts: SeedCounts; errors: string[]; migrationMissing: boolean }> {
  const counts = opts.counts ?? emptyCounts()
  const errors: string[] = []
  const { bank, migrationMissing } = await loadEvidenceBank(userId, { approvedOnly: false })
  if (migrationMissing) return { counts, errors: ['migration 014_career_os.sql has not been applied'], migrationMissing: true }

  const plan = planPersist(bank, proposal)
  counts.matched.push(...plan.matched)
  counts.nearMisses.push(...plan.nearMisses)
  counts.corroborated.push(...plan.corroborated)
  const stripped = (s: boolean) => { if (s) counts.provenanceSkipped++ }

  // 1. Experiences.
  const experienceId = new Map<string, string>()
  const toInsert = proposal.experiences.filter((e, i) => {
    const d = plan.experiences[i]
    if (d.action === 'reuse') {
      experienceId.set(e.key, d.existingId)
      counts.experiencesReused++
      return false
    }
    return d.action === 'insert'
  })
  if (toInsert.length) {
    const res = await insertRowsTolerant('evidence_experiences', toInsert.map((e) => ({
      user_id: userId,
      kind: e.kind,
      organization: e.organization,
      title: e.title,
      start_date: e.start_date,
      end_date: e.end_date,
      location: e.location,
      description: e.summary ?? e.description,
      display_order: e.display_order,
      source: e.source,
      // The résumé's own identity lines. Not a model's claim.
      approved: e.source === 'master_resume' ? true : opts.approve,
      organization_norm: normalizeOrg(e.organization),
      title_norm: normalizeTitle(e.title),
    })), ['organization_norm', 'title_norm'])
    if (res.error) return { counts, errors: [`experiences: ${res.error}`], migrationMissing: res.migrationMissing }
    stripped(res.stripped)
    toInsert.forEach((e, i) => experienceId.set(e.key, res.ids[i]))
    counts.experiences += res.ids.length
  }
  // A second block of the same job in this proposal points at the first.
  plan.experiences.forEach((d) => {
    if (d.action !== 'collapse') return
    const id = experienceId.get(d.intoKey)
    if (id) experienceId.set(d.key, id)
    counts.experiencesReused++
  })

  // 2. Facts. Ids are needed before bullets and metrics can cite them.
  const factId: (string | null)[] = new Array(proposal.facts.length).fill(null)
  const factRows: Record<string, unknown>[] = []
  const factRowIndex: number[] = []
  proposal.facts.forEach((f, i) => {
    const d = plan.facts[i]
    if (d.action === 'reuse') {
      factId[i] = d.existingId
      return
    }
    if (d.action === 'collapse') return // resolved after inserts, below
    factRowIndex.push(i)
    factRows.push({
      user_id: userId,
      experience_id: experienceId.get(f.experience_key) ?? null,
      statement: f.statement,
      category: f.category,
      source: f.source,
      source_location: f.source_location,
      confidence: f.confidence,
      approved: opts.approve,
      statement_norm: normalizeStatement(f.statement),
    })
  })
  if (factRows.length) {
    const res = await insertRowsTolerant('evidence_facts', factRows, ['statement_norm'])
    if (res.error) errors.push(`facts: ${res.error}`)
    else {
      stripped(res.stripped)
      res.ids.forEach((id, j) => { factId[factRowIndex[j]] = id })
      counts.facts += res.ids.length
    }
  }
  proposal.facts.forEach((f, i) => {
    const d = plan.facts[i]
    if (d.action !== 'collapse') return
    factId[i] = factId[d.intoIndex]
    if (d.corroborates && factId[i]) counts.corroborated.push({ factId: factId[i] as string, source: f.source, source_location: f.source_location })
  })
  const resolve = (refs: number[]) => [...new Set(refs.map((i) => factId[i]).filter((id): id is string => Boolean(id)))]

  // 3. Bullets — reuse by (document, paragraph). Fact ids by paragraph.
  const factsByParagraph = new Map<number, string[]>()
  proposal.facts.forEach((f, i) => {
    const id = factId[i]
    if (f.paragraph_index === null || !id) return
    const list = factsByParagraph.get(f.paragraph_index) ?? []
    if (!list.includes(id)) list.push(id)
    factsByParagraph.set(f.paragraph_index, list)
  })
  const existingBullets = new Set(
    bank.bullets.filter((b) => b.resume_document_id === opts.documentId).map((b) => b.paragraph_index)
  )
  const bulletRows = proposal.bullets
    .filter((b) => !existingBullets.has(b.paragraph_index))
    .map((b) => ({
      user_id: userId,
      resume_document_id: opts.documentId,
      experience_id: experienceId.get(b.experience_key) ?? null,
      paragraph_index: b.paragraph_index,
      display_order: b.display_order,
      text: b.text,
      evidence_fact_ids: factsByParagraph.get(b.paragraph_index) ?? [],
      source_resume: opts.sourceResume ?? 'master',
      is_on_master: opts.isOnMaster ?? true,
      // Verbatim master text is the truth.
      approved: true,
    }))
  if (bulletRows.length) {
    const res = await insertRows('resume_bullets', bulletRows)
    if (res.error) errors.push(`bullets: ${res.error}`)
    else counts.bullets += res.ids.length
  }
  // Bullets that already existed still learn about the new facts.
  const supabase = createServiceClient()
  for (const b of bank.bullets) {
    if (b.resume_document_id !== opts.documentId || b.paragraph_index === null) continue
    const fresh = factsByParagraph.get(b.paragraph_index) ?? []
    const merged = [...new Set([...b.evidence_fact_ids, ...fresh])]
    if (merged.length !== b.evidence_fact_ids.length) {
      await supabase.from('resume_bullets').update({ evidence_fact_ids: merged } as never).eq('id', b.id)
    }
  }

  // 4. Metrics and deliverables. The importer is cached by input hash, so a
  //    re-seed replays the identical proposal; without the plan's sets every
  //    run would double the metrics while leaving the facts alone.
  const metricRows = proposal.metrics
    .filter((_, i) => plan.metrics[i])
    .map((m) => ({
      user_id: userId,
      experience_id: experienceId.get(m.experience_key) ?? null,
      value: m.value,
      unit: m.unit,
      context: m.context,
      fact_ids: resolve(m.fact_refs),
      source: m.source,
      approved: opts.approve,
      value_norm: normalizeMetricValue(m.value),
    }))
  if (metricRows.length) {
    const res = await insertRowsTolerant('evidence_metrics', metricRows, ['value_norm'])
    if (res.error) errors.push(`metrics: ${res.error}`)
    else { stripped(res.stripped); counts.metrics += res.ids.length }
  }
  const deliverableRows = proposal.deliverables
    .filter((_, i) => plan.deliverables[i])
    .map((d) => ({
      user_id: userId,
      experience_id: experienceId.get(d.experience_key) ?? null,
      description: d.description,
      fact_ids: resolve(d.fact_refs),
      approved: opts.approve,
    }))
  if (deliverableRows.length) {
    const res = await insertRows('evidence_deliverables', deliverableRows)
    if (res.error) errors.push(`deliverables: ${res.error}`)
    else counts.deliverables += res.ids.length
  }

  // 5. Skills — unique per (user, lower(name)); merge fact ids into an existing row.
  const existingSkills = new Map(bank.skills.map((s) => [s.name.toLowerCase(), s]))
  const skillRows: Record<string, unknown>[] = []
  for (const s of proposal.skills) {
    const had = existingSkills.get(s.name.toLowerCase())
    const ids = resolve(s.fact_refs)
    if (had) {
      const merged = [...new Set([...had.evidence_fact_ids, ...ids])]
      if (merged.length !== had.evidence_fact_ids.length) {
        await supabase.from('evidence_skills').update({ evidence_fact_ids: merged } as never).eq('id', had.id)
      }
      continue
    }
    skillRows.push({ user_id: userId, name: s.name, category: s.category, evidence_fact_ids: ids, approved: opts.approve })
  }
  if (skillRows.length) {
    const res = await insertRows('evidence_skills', skillRows)
    if (res.error) errors.push(`skills: ${res.error}`)
    else counts.skills += res.ids.length
  }

  // 6. Projects (015) — deduped by (experience, name); tolerated on 014.
  if (proposal.projects.length) {
    const res = await persistProjects(userId, bank.projects, proposal.projects.map((p) => ({
      experience_id: experienceId.get(p.experience_key) ?? null,
      name: p.name,
      description: p.description,
      fact_ids: resolve(p.fact_refs),
      approved: opts.approve,
    })))
    if (res.migrationMissing) counts.provenanceSkipped++
    else if (res.error) errors.push(`projects: ${res.error}`)
    counts.projects += res.created
  }

  // 7. Provenance (015) — ./provenance.
  errors.push(...await recordProvenance(userId, bank, proposal, plan, { experienceId, factId }, opts, counts))

  return { counts, errors, migrationMissing: false }
}
