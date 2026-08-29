// Source records (migration 015). A source is a thing the user gave us; it is
// not knowledge. Facts and experiences point at sources through the
// provenance tables. Every helper here degrades to a no-op with
// `migrationMissing: true` when 015 has not been applied, so the import path
// keeps working on a pre-015 database.

import crypto from 'crypto'
import { createServiceClient } from '@/lib/supabase/server'
import type { EvidenceSource, SourceKind, FactSource } from '@/lib/career/types'
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
