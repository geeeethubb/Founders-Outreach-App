// Personal Evidence Bank — persistence.
//
// Deterministic reads and writes through the service-role client. Agents never
// touch this; orchestrators load the bank and pass slices of it in.
//
// DEGRADES GRACEFULLY: if migration 014 has not been applied, reads return an
// empty bank with `migrationMissing` set, matching lib/scouting/persist.ts.

import { createServiceClient } from '@/lib/supabase/server'
import type {
  EvidenceBank,
  EvidenceDeliverable,
  EvidenceExperience,
  EvidenceFact,
  EvidenceMetric,
  EvidencePreference,
  EvidenceSkill,
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
    masterDocument: null,
  }
}

export interface LoadBankOptions {
  /** Default true: only approved rows. False loads everything, for the Evidence page. */
  approvedOnly?: boolean
}

/** Everything the bank holds for one user, in nine small queries. */
export async function loadEvidenceBank(
  userId: string,
  opts: LoadBankOptions = {}
): Promise<{ bank: EvidenceBank; migrationMissing: boolean; errors: string[] }> {
  const supabase = createServiceClient()
  const approvedOnly = opts.approvedOnly ?? true
  const errors: string[] = []
  let migrationMissing = false

  async function load<T>(table: string, order: string, extra?: (q: any) => any): Promise<T[]> {
    let q = supabase.from(table).select('*').eq('user_id', userId)
    if (approvedOnly) q = q.eq('approved', true)
    if (extra) q = extra(q)
    q = q.order(order, { ascending: true })
    const { data, error } = await q
    if (error) {
      if (isMissingSchema(error.message)) migrationMissing = true
      else errors.push(`${table}: ${error.message.slice(0, 120)}`)
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

  return {
    bank: {
      experiences,
      facts,
      metrics,
      deliverables,
      skills,
      stories,
      preferences: (prefRows ?? []) as EvidencePreference[],
      bullets,
      organizations: [],
      sources: [],
      factSources: [],
      projects: [],
      masterDocument: ((docRows ?? [])[0] as ResumeDocument | undefined) ?? null,
    },
    migrationMissing,
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

export function factById(bank: EvidenceBank, id: string): EvidenceFact | null {
  return bank.facts.find((f) => f.id === id) ?? null
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
}> {
  const { bank, migrationMissing } = await loadEvidenceBank(userId, { approvedOnly: false })
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
  }
}
