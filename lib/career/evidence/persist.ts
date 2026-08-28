// Persisting an ImportProposal into the Evidence Bank.
//
// Idempotent by content, not by run: an experience with the same organization
// + title is reused, a bullet at the same paragraph of the same document is
// reused, a fact with the same statement under the same experience is skipped,
// a metric or deliverable already recorded under that experience is skipped,
// a skill with the same name is merged. Re-running is the normal operating
// condition — the same rule migrations live by.
//
// What the résumé itself asserts (experiences, bullets) lands approved: those
// are the document's own identity lines. What the agent DERIVED lands with
// the caller's `approve` flag, false by default (docs/CAREER_OS.md §10).

import { createServiceClient } from '@/lib/supabase/server'
import type { ImportProposal } from './import'
import { insertRows, loadEvidenceBank } from './store'

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
}

export function emptyCounts(): SeedCounts {
  return {
    documents: 0, documentReused: false, experiences: 0, experiencesReused: 0, bullets: 0,
    facts: 0, metrics: 0, skills: 0, deliverables: 0, preferences: 0, missionCreated: false,
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

  // 1. Experiences — reuse by organization + title.
  const experienceId = new Map<string, string>()
  const keyOf = (org: string, title: string) => `${org.trim().toLowerCase()}::${title.trim().toLowerCase()}`
  const existingExp = new Map(bank.experiences.map((e) => [keyOf(e.organization, e.title), e.id]))
  const toInsert = proposal.experiences.filter((e) => {
    const id = existingExp.get(keyOf(e.organization, e.title))
    if (id) {
      experienceId.set(e.key, id)
      counts.experiencesReused++
      return false
    }
    return true
  })
  if (toInsert.length) {
    const res = await insertRows('evidence_experiences', toInsert.map((e) => ({
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
    })))
    if (res.error) return { counts, errors: [`experiences: ${res.error}`], migrationMissing: res.migrationMissing }
    toInsert.forEach((e, i) => experienceId.set(e.key, res.ids[i]))
    counts.experiences += res.ids.length
  }

  // 2. Facts — reuse by (experience, statement). Ids are needed before bullets
  //    and metrics can cite them.
  const factId: (string | null)[] = new Array(proposal.facts.length).fill(null)
  const existingFacts = new Map(bank.facts.map((f) => [`${f.experience_id}::${f.statement.toLowerCase()}`, f.id]))
  const factRows: Record<string, unknown>[] = []
  const factRowIndex: number[] = []
  proposal.facts.forEach((f, i) => {
    const expId = experienceId.get(f.experience_key) ?? null
    const had = existingFacts.get(`${expId}::${f.statement.toLowerCase()}`)
    if (had) {
      factId[i] = had
      return
    }
    factRowIndex.push(i)
    factRows.push({
      user_id: userId,
      experience_id: expId,
      statement: f.statement,
      category: f.category,
      source: f.source,
      source_location: f.source_location,
      confidence: f.confidence,
      approved: opts.approve,
    })
  })
  if (factRows.length) {
    const res = await insertRows('evidence_facts', factRows)
    if (res.error) errors.push(`facts: ${res.error}`)
    else {
      res.ids.forEach((id, j) => { factId[factRowIndex[j]] = id })
      counts.facts += res.ids.length
    }
  }
  const resolve = (refs: number[]) => refs.map((i) => factId[i]).filter((id): id is string => Boolean(id))

  // 3. Bullets — reuse by (document, paragraph). Fact ids by paragraph.
  const factsByParagraph = new Map<number, string[]>()
  proposal.facts.forEach((f, i) => {
    const id = factId[i]
    if (f.paragraph_index === null || !id) return
    const list = factsByParagraph.get(f.paragraph_index) ?? []
    list.push(id)
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

  // 4. Metrics and deliverables — reuse by (experience, value) and
  //    (experience, description). The importer is cached by input hash, so a
  //    re-seed replays the identical proposal; without this every run would
  //    double the metrics while leaving the facts alone.
  const metricKey = (expId: string | null, value: string) => `${expId}::${value.trim().toLowerCase()}`
  const existingMetrics = new Set(bank.metrics.map((m) => metricKey(m.experience_id, m.value)))
  const metricRows = proposal.metrics
    .filter((m) => !existingMetrics.has(metricKey(experienceId.get(m.experience_key) ?? null, m.value)))
    .map((m) => ({
      user_id: userId,
      experience_id: experienceId.get(m.experience_key) ?? null,
      value: m.value,
      unit: m.unit,
      context: m.context,
      fact_ids: resolve(m.fact_refs),
      source: m.source,
      approved: opts.approve,
    }))
  if (metricRows.length) {
    const res = await insertRows('evidence_metrics', metricRows)
    if (res.error) errors.push(`metrics: ${res.error}`)
    else counts.metrics += res.ids.length
  }
  const existingDeliverables = new Set(bank.deliverables.map((d) => metricKey(d.experience_id, d.description)))
  const deliverableRows = proposal.deliverables
    .filter((d) => !existingDeliverables.has(metricKey(experienceId.get(d.experience_key) ?? null, d.description)))
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

  return { counts, errors, migrationMissing: false }
}
