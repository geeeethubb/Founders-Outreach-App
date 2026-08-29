// Recording where every fact and experience came from (migration 015).
//
// Executed after persistProposal has written the 014 rows and knows every
// id. Source record → fact/experience provenance → conflicts → support
// counts. The first missing-schema answer stops the whole step: on a 014
// database there is nothing to write, and `provenanceSkipped` says so.
//
// A conflict the user already RESOLVED is never re-raised by a re-import,
// and a row the user edited by hand keeps whatever merge_status they left it
// with — see refreshExperienceSupport and upsertConflict in ./sources.

import type { ConflictCandidate, EvidenceBank, SourceKind } from '../types'
import type { ImportProposal } from './import'
import { normalizeTitle, parseResumeDate, type ParsedDate } from './normalize'
import type { PersistPlan } from './plan'
import type { PersistOptions, SeedCounts } from './persist'
import {
  defaultSourceLabel, findOrCreateSource, recordExperienceSources, recordFactSources,
  refreshExperienceSupport, refreshFactSupport, sourceKindFor, splitSourceLocation, upsertConflict,
  type ExperienceSourceRow, type FactSourceRow,
} from './sources'
import { sourcesForExperience } from './store'

const RESUME_SOURCES = new Set(['master_resume', 'alternate_resume'])

export interface ResolvedIds {
  experienceId: Map<string, string>
  factId: (string | null)[]
}

function sameDate(a: ParsedDate, b: ParsedDate): boolean {
  // Unknown on either side is not a contradiction; "Present" vs a month is.
  if (a === null || b === null) return true
  if (a === 'present' || b === 'present') return a === b
  if (a.year !== b.year) return false
  return a.month === null || b.month === null || a.month === b.month
}

/**
 * Source record → fact/experience provenance → conflicts → support counts.
 * The first missing-schema answer stops the whole step: on a 014 database
 * there is nothing to write, and the count says so.
 */
export async function recordProvenance(
  userId: string,
  bank: EvidenceBank,
  proposal: ImportProposal,
  plan: PersistPlan,
  ids: ResolvedIds,
  opts: PersistOptions,
  counts: SeedCounts
): Promise<string[]> {
  const errors: string[] = []
  const skip = () => { counts.provenanceSkipped++; return errors }

  const firstSource = proposal.facts[0]?.source ?? proposal.experiences[0]?.source ?? 'manual'
  const kind: SourceKind = opts.sourceKind ?? (opts.documentId ? 'resume' : sourceKindFor(firstSource))
  const label = opts.sourceLabel ?? (opts.documentId ? 'resume.docx' : defaultSourceLabel(kind))
  const content = opts.rawText ?? (proposal.model ? proposal.model.map.map((p) => p.text).join('\n') : null)
  const primary = await findOrCreateSource(userId, {
    kind, label, content, sha256: opts.sourceSha256 ?? null, resume_document_id: opts.resumeDocumentId ?? opts.documentId ?? null,
  })
  if (primary.migrationMissing) return skip()
  if (!primary.id) { errors.push(`source: ${primary.error}`); return errors }
  if (primary.created) counts.sources.created++
  else counts.sources.reused++

  // Facts from a profile field carried along with a résumé import belong to
  // that field's own source, not the résumé's.
  const secondary = new Map<string, string | null>()
  const sourceIdFor = async (f: ImportProposal['facts'][number]): Promise<string | null> => {
    const split = splitSourceLocation(f.source, f.source_location)
    const isPrimary = opts.documentId ? RESUME_SOURCES.has(f.source) : !split.label.startsWith('profile.')
    if (isPrimary) return primary.id
    if (secondary.has(split.label)) return secondary.get(split.label) ?? null
    const h = await findOrCreateSource(userId, { kind: sourceKindFor(f.source), label: split.label, content: null })
    if (h.created) counts.sources.created++
    else if (h.id) counts.sources.reused++
    secondary.set(split.label, h.id)
    return h.id
  }

  // (b) fact ↔ source, inserted and reused alike — a reused fact is corroborated.
  const factRows: FactSourceRow[] = []
  for (const [i, f] of proposal.facts.entries()) {
    const id = ids.factId[i]
    if (!id) continue
    const sourceId = await sourceIdFor(f)
    if (!sourceId) continue
    factRows.push({ fact_id: id, source_id: sourceId, location: splitSourceLocation(f.source, f.source_location).location, quote: f.statement, confidence: f.confidence })
  }
  const fs = await recordFactSources(userId, factRows)
  if (fs.migrationMissing) return skip()
  if (fs.error) errors.push(`fact sources: ${fs.error}`)
  counts.factSources += fs.created

  // (c) experience ↔ source with the title and dates as this source wrote them;
  // (e) a reused row whose title or dates this source states differently.
  const expRows: ExperienceSourceRow[] = []
  const conflicting = new Set<string>()
  for (const [i, e] of proposal.experiences.entries()) {
    const d = plan.experiences[i]
    if (d.action === 'collapse') continue
    const id = ids.experienceId.get(e.key)
    if (!id) continue
    const dates = [e.start_date, e.end_date].filter(Boolean).join(' – ') || null
    expRows.push({ experience_id: id, source_id: primary.id, title_as_written: e.title, dates_as_written: dates })
    if (d.action !== 'reuse') continue
    const row = bank.experiences.find((x) => x.id === id)
    if (!row) continue
    const rowLabel = sourcesForExperience(bank, row.id)[0]?.label ?? row.source
    const candidates = (a: string | null, b: string | null): ConflictCandidate[] => [
      { value: a ?? '', source_id: null, source_label: rowLabel },
      { value: b ?? '', source_id: primary.id, source_label: label },
    ]
    const fields: { field: string; differs: boolean; a: string | null; b: string | null }[] = [
      { field: 'title', differs: normalizeTitle(row.title) !== normalizeTitle(e.title), a: row.title, b: e.title },
      { field: 'start_date', differs: !sameDate(parseResumeDate(row.start_date), parseResumeDate(e.start_date)), a: row.start_date, b: e.start_date },
      { field: 'end_date', differs: !sameDate(parseResumeDate(row.end_date), parseResumeDate(e.end_date)), a: row.end_date, b: e.end_date },
    ]
    for (const f of fields) {
      if (!f.differs) continue
      const c = await upsertConflict(userId, { entity_type: 'experience', entity_id: id, field: f.field, candidates: candidates(f.a, f.b) })
      if (c.migrationMissing) return skip()
      if (c.error) { errors.push(`conflict: ${c.error}`); continue }
      // Only an OPEN conflict marks the row; a resolved one is the user's
      // decision and stays decided.
      if (c.status === 'open' || c.status === 'created') conflicting.add(id)
      if (c.created) counts.conflicts++
    }
  }
  const es = await recordExperienceSources(userId, expRows)
  if (es.migrationMissing) return skip()
  if (es.error) errors.push(`experience sources: ${es.error}`)
  counts.experienceSources += es.created

  // (d) support counts and statuses.
  const rf = await refreshFactSupport(userId, [...new Set(factRows.map((r) => r.fact_id))])
  if (rf.migrationMissing) return skip()
  if (rf.error) errors.push(`fact support: ${rf.error}`)
  const re = await refreshExperienceSupport(userId, [...new Set(expRows.map((r) => r.experience_id))], conflicting)
  if (re.migrationMissing) return skip()
  if (re.error) errors.push(`experience support: ${re.error}`)
  return errors
}
