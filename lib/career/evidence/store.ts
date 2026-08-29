// Personal Evidence Bank — persistence.
//
// Deterministic reads and writes through the service-role client. Agents never
// touch this; orchestrators load the bank and pass slices of it in.
//
// DEGRADES GRACEFULLY: if migration 014 has not been applied, reads return an
// empty bank with `migrationMissing` set, matching lib/scouting/persist.ts.
// If only migration 015 is missing, the 014 tables load as before and the
// 015 entities come back empty with `canonical: false` — never as a missing
// migration, because the bank is still usable.

import { createServiceClient } from '@/lib/supabase/server'
import { isFullSupport } from './corroborate'
import type {
  EvidenceBank,
  EvidenceDeliverable,
  EvidenceExperience,
  EvidenceExperienceSource,
  EvidenceFact,
  EvidenceFactSource,
  EvidenceMetric,
  EvidenceOrganization,
  EvidencePreference,
  EvidenceProject,
  EvidenceSkill,
  EvidenceSource,
  EvidenceStory,
  ResumeBullet,
  ResumeDocument,
} from '../types'

export function isMissingSchema(message: string): boolean {
  return /relation .* does not exist|column .* does not exist|schema cache|could not find/i.test(message)
}

export class MigrationMissingError extends Error {
  constructor(detail: string) {
    super(`migration 014_career_os.sql has not been applied: ${detail}`)
    this.name = 'MigrationMissingError'
  }
}

export function emptyBank(): EvidenceBank {
  return {
    experiences: [],
    facts: [],
    metrics: [],
    deliverables: [],
    skills: [],
    stories: [],
    preferences: [],
    bullets: [],
    organizations: [],
    sources: [],
    factSources: [],
    projects: [],
    experienceSources: [],
    masterDocument: null,
  }
}

export interface LoadBankOptions {
  /** Default true: only approved rows. False loads everything, for the Evidence page. */
  approvedOnly?: boolean
  /** Default false: rows with status 'merged' (015 tombstones) are filtered out in code. */
  includeTombstones?: boolean
}

/** Pre-015 rows have no `status`; they are active. */
function isActive(row: { status?: string | null }): boolean {
  return row.status !== 'merged'
}

/** The 014 tables plus, when migration 015 is applied, the canonical entities. */
export async function loadEvidenceBank(
  userId: string,
  opts: LoadBankOptions = {}
): Promise<{ bank: EvidenceBank; migrationMissing: boolean; canonical: boolean; errors: string[] }> {
  const supabase = createServiceClient()
  const approvedOnly = opts.approvedOnly ?? true
  const errors: string[] = []
  let migrationMissing = false
  let canonical = true

  async function load<T>(table: string, order: string, o: { approved?: boolean; is015?: boolean } = {}): Promise<T[]> {
    let q = supabase.from(table).select('*').eq('user_id', userId)
    if (approvedOnly && (o.approved ?? true)) q = q.eq('approved', true)
    q = q.order(order, { ascending: true })
    const { data, error } = await q
    if (error) {
      if (isMissingSchema(error.message)) {
        if (o.is015) canonical = false
        else migrationMissing = true
      } else errors.push(`${table}: ${error.message.slice(0, 120)}`)
      return []
    }
    return (data ?? []) as T[]
  }

  const [experiences, facts, metrics, deliverables, skills, stories, bullets] = await Promise.all([
    load<EvidenceExperience>('evidence_experiences', 'display_order'),
    load<EvidenceFact>('evidence_facts', 'created_at'),
    load<EvidenceMetric>('evidence_metrics', 'created_at'),
    load<EvidenceDeliverable>('evidence_deliverables', 'created_at'),
    load<EvidenceSkill>('evidence_skills', 'name'),
    load<EvidenceStory>('evidence_stories', 'created_at'),
    load<ResumeBullet>('resume_bullets', 'display_order'),
  ])
  const [organizations, sources, factSources, experienceSources, projects] = await Promise.all([
    load<EvidenceOrganization>('evidence_organizations', 'canonical_name', { approved: false, is015: true }),
    load<EvidenceSource>('evidence_sources', 'imported_at', { approved: false, is015: true }),
    load<EvidenceFactSource>('evidence_fact_sources', 'created_at', { approved: false, is015: true }),
    load<EvidenceExperienceSource>('evidence_experience_sources', 'created_at', { approved: false, is015: true }),
    load<EvidenceProject>('evidence_projects', 'created_at', { is015: true }),
  ])

  // Preferences have no `approved` column.
  const { data: prefRows, error: prefErr } = await supabase
    .from('evidence_preferences')
    .select('*')
    .eq('user_id', userId)
    .order('category')
  if (prefErr) {
    if (isMissingSchema(prefErr.message)) migrationMissing = true
    else errors.push(`evidence_preferences: ${prefErr.message.slice(0, 120)}`)
  }

  const { data: docRows, error: docErr } = await supabase
    .from('resume_documents')
    .select('*')
    .eq('user_id', userId)
    .eq('is_master', true)
    .order('uploaded_at', { ascending: false })
    .limit(1)
  if (docErr) {
    if (isMissingSchema(docErr.message)) migrationMissing = true
    else errors.push(`resume_documents: ${docErr.message.slice(0, 120)}`)
  }

  const keep = <T extends { status?: string | null }>(rows: T[]): T[] => (opts.includeTombstones ? rows : rows.filter(isActive))

  return {
    bank: {
      experiences: keep(experiences),
      facts: keep(facts),
      metrics: keep(metrics),
      deliverables: keep(deliverables),
      skills,
      stories,
      preferences: (prefRows ?? []) as EvidencePreference[],
      bullets,
      organizations,
      sources,
      factSources,
      experienceSources,
      projects: keep(projects),
      masterDocument: ((docRows ?? [])[0] as ResumeDocument | undefined) ?? null,
    },
    migrationMissing,
    canonical: migrationMissing ? false : canonical,
    errors,
  }
}

// ─── Lookups over a loaded bank (pure) ───────────────────────────────────────

export function factsForExperience(bank: EvidenceBank, experienceId: string): EvidenceFact[] {
  return bank.facts.filter((f) => f.experience_id === experienceId)
}

export function metricsForExperience(bank: EvidenceBank, experienceId: string): EvidenceMetric[] {
  return bank.metrics.filter((m) => m.experience_id === experienceId)
}

export function bulletsForExperience(bank: EvidenceBank, experienceId: string): ResumeBullet[] {
  return bank.bullets
    .filter((b) => b.experience_id === experienceId)
    .sort((a, b) => a.display_order - b.display_order)
}

export function projectsForExperience(bank: EvidenceBank, experienceId: string): EvidenceProject[] {
  return bank.projects.filter((p) => p.experience_id === experienceId && p.status !== 'merged')
}

export function factById(bank: EvidenceBank, id: string): EvidenceFact | null {
  return bank.facts.find((f) => f.id === id) ?? null
}

function sourceById(bank: EvidenceBank, id: string): EvidenceSource | null {
  return bank.sources.find((s) => s.id === id) ?? null
}

/** The suffix an event-only provenance row (confidence 0.5) carries in a label. */
export const EVENT_ONLY_LABEL = '(event only)'

/**
 * "Zuyu_Resume.docx ¶6", "LinkedIn export L350" — one label per provenance
 * row, joined to its source record; a row that corroborates the event but not
 * the numbers reads "LinkedIn post L2 (event only)". Falls back to the legacy
 * single-source columns when no provenance rows exist (pre-015, or a fact
 * imported before provenance was recorded), so a fact always has at least
 * one label.
 */
export function sourceLabelsForFact(bank: EvidenceBank, fact: EvidenceFact): string[] {
  const labels: string[] = []
  for (const fs of bank.factSources) {
    if (fs.fact_id !== fact.id) continue
    const src = sourceById(bank, fs.source_id)
    const base = src ? `${src.label}${fs.location ? ` ${fs.location}` : ''}` : fs.location ?? ''
    const label = base && !isFullSupport(fs) ? `${base} ${EVENT_ONLY_LABEL}` : base
    if (label && !labels.includes(label)) labels.push(label)
  }
  if (labels.length === 0) labels.push(fact.source_location ?? fact.source)
  return labels
}

/** Source records that state this experience, provenance rows first, then its facts' sources. */
export function sourcesForExperience(bank: EvidenceBank, experienceId: string): EvidenceSource[] {
  const out: EvidenceSource[] = []
  const add = (id: string) => {
    const s = sourceById(bank, id)
    if (s && !out.some((x) => x.id === s.id)) out.push(s)
  }
  for (const es of bank.experienceSources ?? []) if (es.experience_id === experienceId) add(es.source_id)
  const factIds = new Set(factsForExperience(bank, experienceId).map((f) => f.id))
  for (const fs of bank.factSources) if (factIds.has(fs.fact_id)) add(fs.source_id)
  return out
}

/** True only when every id names an approved fact that belongs to the experience. */
export function factIdsBelongTo(bank: EvidenceBank, ids: string[], experienceId: string): boolean {
  if (ids.length === 0) return false
  return ids.every((id) => {
    const f = factById(bank, id)
    return Boolean(f && f.approved && f.experience_id === experienceId)
  })
}

// ─── Writes ──────────────────────────────────────────────────────────────────

type Table =
  | 'evidence_experiences' | 'evidence_facts' | 'evidence_metrics' | 'evidence_deliverables'
  | 'evidence_skills' | 'evidence_stories' | 'evidence_preferences' | 'resume_bullets' | 'resume_documents'
  | 'evidence_organizations' | 'evidence_sources' | 'evidence_fact_sources' | 'evidence_experience_sources'
  | 'evidence_projects' | 'evidence_merge_suggestions' | 'evidence_conflicts' | 'evidence_snapshots'

export async function insertRows<T extends Record<string, unknown>>(
  table: Table,
  rows: T[]
): Promise<{ ids: string[]; error: string | null; migrationMissing: boolean }> {
  if (rows.length === 0) return { ids: [], error: null, migrationMissing: false }
  const supabase = createServiceClient()
  const { data, error } = await supabase.from(table).insert(rows as never[]).select('id')
  if (error) {
    return { ids: [], error: error.message, migrationMissing: isMissingSchema(error.message) }
  }
  return { ids: (data ?? []).map((r) => String((r as { id: string }).id)), error: null, migrationMissing: false }
}

/**
 * Insert rows that carry 015 columns onto a table that may still be at 014.
 * When the write fails because a column is unknown, the optional columns are
 * stripped and the insert retried; `stripped` says so, so the caller can count
 * it rather than lose the rows or hide the downgrade.
 */
export async function insertRowsTolerant<T extends Record<string, unknown>>(
  table: Table,
  rows: T[],
  optionalColumns: string[]
): Promise<{ ids: string[]; error: string | null; migrationMissing: boolean; stripped: boolean }> {
  const first = await insertRows(table, rows)
  if (!first.error || !first.migrationMissing || optionalColumns.length === 0) return { ...first, stripped: false }
  const bare = rows.map((r) => {
    const copy: Record<string, unknown> = { ...r }
    for (const c of optionalColumns) delete copy[c]
    return copy
  })
  const second = await insertRows(table, bare)
  return { ...second, stripped: true }
}

export async function updateRow(
  table: Table,
  userId: string,
  id: string,
  patch: Record<string, unknown>
): Promise<{ ok: boolean; error: string | null }> {
  const supabase = createServiceClient()
  const { error } = await supabase.from(table).update(patch as never).eq('id', id).eq('user_id', userId)
  return { ok: !error, error: error?.message ?? null }
}

export async function deleteRow(
  table: Table,
  userId: string,
  id: string
): Promise<{ ok: boolean; error: string | null }> {
  const supabase = createServiceClient()
  const { error } = await supabase.from(table).delete().eq('id', id).eq('user_id', userId)
  return { ok: !error, error: error?.message ?? null }
}

/** Approve or un-approve many rows at once — the Evidence page's bulk action. */
export async function setApproved(
  table: Exclude<Table, 'evidence_preferences' | 'resume_documents'>,
  userId: string,
  ids: string[],
  approved: boolean
): Promise<{ updated: number; error: string | null }> {
  if (ids.length === 0) return { updated: 0, error: null }
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from(table)
    .update({ approved } as never)
    .eq('user_id', userId)
    .in('id', ids)
    .select('id')
  return { updated: data?.length ?? 0, error: error?.message ?? null }
}

/** Counts for the Evidence page header and for "is the bank usable yet?". */
export async function bankCounts(userId: string): Promise<{
  experiences: number
  facts: number
  factsApproved: number
  bullets: number
  bulletsApproved: number
  skills: number
  stories: number
  hasMaster: boolean
  migrationMissing: boolean
  canonical: boolean
}> {
  const { bank, migrationMissing, canonical } = await loadEvidenceBank(userId, { approvedOnly: false })
  return {
    experiences: bank.experiences.length,
    facts: bank.facts.length,
    factsApproved: bank.facts.filter((f) => f.approved).length,
    bullets: bank.bullets.length,
    bulletsApproved: bank.bullets.filter((b) => b.approved).length,
    skills: bank.skills.length,
    stories: bank.stories.length,
    hasMaster: bank.masterDocument !== null,
    migrationMissing,
    canonical,
  }
}
