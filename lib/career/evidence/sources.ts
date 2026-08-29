// Source records (migration 015). A source is a thing the user gave us; it is
// not knowledge. Facts and experiences point at sources through the
// provenance tables. Every helper here degrades to a no-op with
// `migrationMissing: true` when 015 has not been applied, so the import path
// keeps working on a pre-015 database.

import crypto from 'crypto'
import { createServiceClient } from '@/lib/supabase/server'
import type { ConflictCandidate, EvidenceProject, EvidenceSource, SourceKind, FactSource } from '@/lib/career/types'
import { normalizeStatement } from './normalize'
import { isMissingSchema } from './store'

export interface SourceInput {
  kind: SourceKind
  label: string
  /** Raw text as imported; hashed when `sha256` is not given. */
  content?: string | null
  sha256?: string | null
  storage_path?: string | null
  resume_document_id?: string | null
  metadata?: Record<string, unknown>
}

export interface SourceHandle {
  id: string | null
  created: boolean
  migrationMissing: boolean
  error: string | null
}

export function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Map a fact's legacy `source` enum to a source-record kind. */
export function sourceKindFor(source: FactSource | string): SourceKind {
  switch (source) {
    case 'master_resume':
    case 'alternate_resume': return 'resume'
    case 'linkedin': return 'linkedin_profile'
    case 'profile': return 'profile_field'
    case 'project_notes': return 'notes'
    case 'manual': return 'pasted_context'
    case 'outreach':
    case 'story':
    default: return 'other'
  }
}

/** "LinkedIn profile pasted 2026-08-28" — the label a pasted text gets when the caller gives none. */
export function defaultSourceLabel(kind: SourceKind, when: Date = new Date()): string {
  const names: Record<SourceKind, string> = {
    resume: 'Résumé', linkedin_profile: 'LinkedIn profile', linkedin_post: 'LinkedIn post',
    pasted_context: 'Pasted text', notes: 'Notes', profile_field: 'Profile field', other: 'Text',
  }
  return `${names[kind]} pasted ${when.toISOString().slice(0, 10)}`
}

/**
 * Label + location split for a legacy `source_location` such as
 * "Zuyu_Resume.docx ¶6" or "pasted.manual L350". The label identifies the
 * source record; the location is kept on the provenance row.
 */
export function splitSourceLocation(source: string, location: string | null): { label: string; location: string | null } {
  if (!location) return { label: source, location: null }
  const m = location.match(/^(.*?)\s+(¶\d+|L\d+)$/)
  if (m) return { label: m[1], location: m[2] }
  return { label: location, location: null }
}

/** Find a source by (user, sha256) or create it. Idempotent by content hash. */
export async function findOrCreateSource(userId: string, input: SourceInput): Promise<SourceHandle> {
  const supabase = createServiceClient()
  const hash = input.sha256 ?? (input.content ? sha256Text(input.content) : null)

  if (hash) {
    const { data, error } = await supabase
      .from('evidence_sources')
      .select('id')
      .eq('user_id', userId)
      .eq('sha256', hash)
      .limit(1)
      .maybeSingle()
    if (error) {
      return { id: null, created: false, migrationMissing: isMissingSchema(error.message), error: error.message }
    }
    if (data?.id) return { id: String(data.id), created: false, migrationMissing: false, error: null }
  } else {
    // No hash: reuse by (user, kind, label) so backfilled legacy sources stay unique.
    const { data, error } = await supabase
      .from('evidence_sources')
      .select('id')
      .eq('user_id', userId)
      .eq('kind', input.kind)
      .eq('label', input.label)
      .limit(1)
      .maybeSingle()
    if (error) {
      return { id: null, created: false, migrationMissing: isMissingSchema(error.message), error: error.message }
    }
    if (data?.id) return { id: String(data.id), created: false, migrationMissing: false, error: null }
  }

  const { data, error } = await supabase
    .from('evidence_sources')
    .insert({
      user_id: userId,
      kind: input.kind,
      label: input.label,
      sha256: hash,
      content: input.content ?? null,
      storage_path: input.storage_path ?? null,
      resume_document_id: input.resume_document_id ?? null,
      metadata: input.metadata ?? {},
    })
    .select('id')
    .single()
  if (error) {
    return { id: null, created: false, migrationMissing: isMissingSchema(error.message), error: error.message }
  }
  return { id: String(data.id), created: true, migrationMissing: false, error: null }
}

export interface FactSourceRow {
  fact_id: string
  source_id: string
  location?: string | null
  quote?: string | null
  confidence?: number
}

/** Upsert provenance rows. Duplicate (fact, source, location) rows are ignored. */
export async function recordFactSources(
  userId: string,
  rows: FactSourceRow[]
): Promise<{ created: number; migrationMissing: boolean; error: string | null }> {
  if (rows.length === 0) return { created: 0, migrationMissing: false, error: null }
  const supabase = createServiceClient()
  const payload = rows.map((r) => ({
    user_id: userId,
    fact_id: r.fact_id,
    source_id: r.source_id,
    location: r.location ?? null,
    quote: r.quote ?? null,
    confidence: r.confidence ?? 1.0,
  }))
  // The unique index uses coalesce(location,''), which PostgREST cannot target
  // in `onConflict`; insert one by one and treat 23505 as "already recorded".
  let created = 0
  for (const row of payload) {
    const { error } = await supabase.from('evidence_fact_sources').insert(row)
    if (!error) { created++; continue }
    if (error.code === '23505') continue
    return { created, migrationMissing: isMissingSchema(error.message), error: error.message }
  }
  return { created, migrationMissing: false, error: null }
}

export interface ExperienceSourceRow {
  experience_id: string
  source_id: string
  location?: string | null
  title_as_written?: string | null
  dates_as_written?: string | null
}

export async function recordExperienceSources(
  userId: string,
  rows: ExperienceSourceRow[]
): Promise<{ created: number; migrationMissing: boolean; error: string | null }> {
  if (rows.length === 0) return { created: 0, migrationMissing: false, error: null }
  const supabase = createServiceClient()
  let created = 0
  for (const r of rows) {
    const { error } = await supabase.from('evidence_experience_sources').insert({
      user_id: userId,
      experience_id: r.experience_id,
      source_id: r.source_id,
      location: r.location ?? null,
      title_as_written: r.title_as_written ?? null,
      dates_as_written: r.dates_as_written ?? null,
    })
    if (!error) { created++; continue }
    if (error.code === '23505') continue
    return { created, migrationMissing: isMissingSchema(error.message), error: error.message }
  }
  return { created, migrationMissing: false, error: null }
}

export async function loadSources(userId: string): Promise<{ sources: EvidenceSource[]; migrationMissing: boolean }> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('evidence_sources')
    .select('*')
    .eq('user_id', userId)
    .order('imported_at', { ascending: true })
  if (error) return { sources: [], migrationMissing: isMissingSchema(error.message) }
  return { sources: (data ?? []) as EvidenceSource[], migrationMissing: false }
}

// ─── Support counts, conflicts, projects (015 writes; all tolerate 014) ──────

export interface SupportRefresh {
  updated: number
  migrationMissing: boolean
  error: string | null
}

/** Distinct source ids per entity, from provenance rows. */
function distinctSources<K extends string>(rows: Record<K, string>[] | null, key: K): Map<string, number> {
  const sets = new Map<string, Set<string>>()
  for (const r of rows ?? []) {
    const set = sets.get(r[key]) ?? new Set<string>()
    set.add((r as Record<string, string>).source_id)
    sets.set(r[key], set)
  }
  return new Map([...sets].map(([id, set]) => [id, set.size]))
}

/**
 * support_count = distinct sources per fact; fact_status becomes
 * CORROBORATED at ≥2 sources when it was VERIFIED. Anything the user or the
 * consolidation engine set (CONFLICTING, NEEDS_REVIEW) is left alone.
 */
export async function refreshFactSupport(userId: string, factIds: string[]): Promise<SupportRefresh> {
  if (factIds.length === 0) return { updated: 0, migrationMissing: false, error: null }
  const supabase = createServiceClient()
  const { data: prov, error: provErr } = await supabase
    .from('evidence_fact_sources').select('fact_id, source_id').eq('user_id', userId).in('fact_id', factIds)
  if (provErr) return { updated: 0, migrationMissing: isMissingSchema(provErr.message), error: provErr.message }
  const { data: facts, error: factErr } = await supabase
    .from('evidence_facts').select('id, support_count, fact_status').eq('user_id', userId).in('id', factIds)
  if (factErr) return { updated: 0, migrationMissing: isMissingSchema(factErr.message), error: factErr.message }

  const counts = distinctSources(prov as { fact_id: string; source_id: string }[] | null, 'fact_id')
  let updated = 0
  for (const f of (facts ?? []) as { id: string; support_count: number | null; fact_status: string | null }[]) {
    const count = Math.max(1, counts.get(f.id) ?? 0)
    const current = f.fact_status ?? 'VERIFIED'
    const status = count >= 2 && current === 'VERIFIED' ? 'CORROBORATED' : current
    if (count === f.support_count && status === f.fact_status) continue
    const { error } = await supabase.from('evidence_facts').update({ support_count: count, fact_status: status } as never).eq('id', f.id)
    if (error) return { updated, migrationMissing: isMissingSchema(error.message), error: error.message }
    updated++
  }
  return { updated, migrationMissing: false, error: null }
}

/**
 * source_count and merge_status for experiences. Ids in `conflicting` (an
 * OPEN conflict this import raised or re-raised) become CONFLICTING — unless
 * the user has edited the row by hand: a manual edit is a decision, and a
 * re-import never overrides it (docs/KNOWLEDGE_BASE_DEDUP_PLAN.md, manual
 * edits are never overwritten by re-import).
 */
export async function refreshExperienceSupport(
  userId: string,
  experienceIds: string[],
  conflicting: Set<string> = new Set()
): Promise<SupportRefresh> {
  if (experienceIds.length === 0) return { updated: 0, migrationMissing: false, error: null }
  const supabase = createServiceClient()
  const { data: prov, error: provErr } = await supabase
    .from('evidence_experience_sources').select('experience_id, source_id').eq('user_id', userId).in('experience_id', experienceIds)
  if (provErr) return { updated: 0, migrationMissing: isMissingSchema(provErr.message), error: provErr.message }
  const { data: rows, error: rowErr } = await supabase
    .from('evidence_experiences').select('id, source_count, merge_status, edited_by_user').eq('user_id', userId).in('id', experienceIds)
  if (rowErr) return { updated: 0, migrationMissing: isMissingSchema(rowErr.message), error: rowErr.message }

  const counts = distinctSources(prov as { experience_id: string; source_id: string }[] | null, 'experience_id')
  let updated = 0
  for (const e of (rows ?? []) as { id: string; source_count: number | null; merge_status: string | null; edited_by_user: boolean | null }[]) {
    const count = Math.max(1, counts.get(e.id) ?? 0)
    const current = e.merge_status ?? 'VERIFIED'
    let status = current
    if (e.edited_by_user) status = current
    else if (conflicting.has(e.id)) status = 'CONFLICTING'
    else if (count >= 2 && current === 'VERIFIED') status = 'CORROBORATED'
    if (count === e.source_count && status === e.merge_status) continue
    const { error } = await supabase.from('evidence_experiences').update({ source_count: count, merge_status: status } as never).eq('id', e.id)
    if (error) return { updated, migrationMissing: isMissingSchema(error.message), error: error.message }
    updated++
  }
  return { updated, migrationMissing: false, error: null }
}

export interface ConflictInput {
  entity_type: 'experience' | 'fact' | 'metric'
  entity_id: string
  field: string
  candidates: ConflictCandidate[]
}

export type ConflictOutcome =
  /** No row existed; one is now open. */
  | 'created'
  /** An open row existed; it may have learned a new candidate. */
  | 'open'
  /** The user already resolved this (entity, field) — nothing re-raised, nothing touched. */
  | 'resolved'

/**
 * One conflict per (entity, field). A later import stating a third value
 * adds a candidate to an OPEN row; a value already listed is not repeated.
 * A RESOLVED row is a decision the user made, and re-pasting the same text
 * does not reopen it. The canonical row is never touched here — the
 * résumé's value stays.
 */
export async function upsertConflict(
  userId: string,
  input: ConflictInput
): Promise<{ created: boolean; status: ConflictOutcome | null; migrationMissing: boolean; error: string | null }> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('evidence_conflicts')
    .select('id, candidates, status')
    .eq('user_id', userId)
    .eq('entity_type', input.entity_type)
    .eq('entity_id', input.entity_id)
    .eq('field', input.field)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) return { created: false, status: null, migrationMissing: isMissingSchema(error.message), error: error.message }
  if (data) {
    if (data.status === 'resolved') return { created: false, status: 'resolved', migrationMissing: false, error: null }
    const existing = (Array.isArray(data.candidates) ? data.candidates : []) as ConflictCandidate[]
    const merged = [...existing]
    for (const c of input.candidates) if (!merged.some((m) => m.value === c.value)) merged.push(c)
    if (merged.length === existing.length) return { created: false, status: 'open', migrationMissing: false, error: null }
    const { error: upErr } = await supabase.from('evidence_conflicts').update({ candidates: merged } as never).eq('id', data.id)
    return { created: false, status: 'open', migrationMissing: false, error: upErr?.message ?? null }
  }
  const { error: insErr } = await supabase.from('evidence_conflicts').insert({
    user_id: userId,
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    field: input.field,
    candidates: input.candidates,
  })
  if (insErr) return { created: false, status: null, migrationMissing: isMissingSchema(insErr.message), error: insErr.message }
  return { created: true, status: 'created', migrationMissing: false, error: null }
}

export interface ProjectInput {
  experience_id: string | null
  name: string
  description: string | null
  fact_ids: string[]
  approved: boolean
}

/**
 * Projects deduped by (experience, normalized name). An existing project
 * learns the new fact ids; nothing is overwritten.
 */
export async function persistProjects(
  userId: string,
  existing: EvidenceProject[],
  inputs: ProjectInput[]
): Promise<{ created: number; reused: number; migrationMissing: boolean; error: string | null }> {
  if (inputs.length === 0) return { created: 0, reused: 0, migrationMissing: false, error: null }
  const supabase = createServiceClient()
  const key = (experienceId: string | null, nameNorm: string) => `${experienceId ?? 'none'}::${nameNorm}`
  const seen = new Map(existing.filter((p) => p.status !== 'merged').map((p) => [key(p.experience_id, p.name_norm), p]))
  let created = 0
  let reused = 0
  for (const p of inputs) {
    const nameNorm = normalizeStatement(p.name)
    const had = seen.get(key(p.experience_id, nameNorm))
    if (had) {
      reused++
      const merged = [...new Set([...had.fact_ids, ...p.fact_ids])]
      if (merged.length !== had.fact_ids.length) {
        const { error } = await supabase.from('evidence_projects').update({ fact_ids: merged } as never).eq('id', had.id)
        if (error) return { created, reused, migrationMissing: isMissingSchema(error.message), error: error.message }
        had.fact_ids = merged
      }
      continue
    }
    const { data, error } = await supabase
      .from('evidence_projects')
      .insert({ user_id: userId, experience_id: p.experience_id, name: p.name, name_norm: nameNorm, description: p.description, fact_ids: p.fact_ids, approved: p.approved })
      .select('*')
      .single()
    if (error) return { created, reused, migrationMissing: isMissingSchema(error.message), error: error.message }
    created++
    seen.set(key(p.experience_id, nameNorm), data as EvidenceProject)
  }
  return { created, reused, migrationMissing: false, error: null }
}
