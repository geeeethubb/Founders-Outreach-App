// The database surface of DEFERRED extraction.
//
// A posting is stored the moment a board lists it, with the extracted columns
// null. Extraction then becomes a SEPARATE, bounded, prioritised pass over
// those rows, so inventory (hundreds of postings, free — a board listing is
// JSON over HTTP) and extraction (dozens, paid — one model call each) stop
// being the same number. That decoupling is the whole reason 200+ live
// postings costs about what 35 used to.
//
// Split out of store.ts, which was already at its size limit, and kept
// separate for the same reason run-results.ts is: one owner for one question.
// Everything here is a read or a write. WHICH rows are worth spending an
// extraction on is judgment-free arithmetic and lives in
// lib/career/jobs/relevance.ts; the pass that spends the budget lives in
// lib/career/scout/extract.ts.

import { createServiceClient } from '@/lib/supabase/server'
import { isMissingSchema, type Db } from './db'

/** A candidate for extraction, without its description — the pool is ranked on these columns alone. */
export interface ExtractionCandidate {
  id: string
  title: string
  company_name: string
  location_raw: string | null
  location_tier: number | null
  role_family: string | null
  season_relevance: string | null
  employment_type: string | null
  work_mode: string | null
  verification_status: string | null
  canonical_url: string | null
  first_seen_at: string | null
  last_seen_at: string | null
}

const CANDIDATE_COLUMNS =
  'id, title, company_name, location_raw, location_tier, role_family, season_relevance, employment_type, work_mode, verification_status, canonical_url, first_seen_at, last_seen_at'

/** Hard ceiling on the pool one extraction pass ranks. Descriptions are NOT fetched here. */
export const MAX_EXTRACTION_POOL = 500

export interface ExtractionCandidateOptions {
  /** Size of the pool to rank, capped at MAX_EXTRACTION_POOL. */
  limit?: number
  /** Which end of the inventory the pool is taken from. Default 'recent'. */
  order?: 'recent' | 'oldest'
  /** Include rows that already carry an extraction (a re-extract at a new prompt version). Default false. */
  includeExtracted?: boolean
}

/**
 * Rows stored WITHOUT an extraction that have text worth extracting from.
 *
 * CLOSED postings and rows the user dismissed are excluded: paying a model to
 * read a job nobody will apply to is exactly the waste this split exists to
 * stop. `is_canonical` keeps a duplicate from being extracted twice.
 */
export async function listExtractionCandidates(
  userId: string,
  opts: ExtractionCandidateOptions = {},
  db: Db = createServiceClient()
): Promise<{ rows: ExtractionCandidate[]; error: string | null; migrationMissing: boolean }> {
  const limit = Math.max(1, Math.min(MAX_EXTRACTION_POOL, opts.limit ?? MAX_EXTRACTION_POOL))
  let q = db
    .from('job_opportunities')
    .select(CANDIDATE_COLUMNS)
    .eq('user_id', userId)
    .eq('is_canonical', true)
    .not('description_text', 'is', null)
    .neq('verification_status', 'CLOSED')
    .neq('disposition', 'dismissed')
  if (!opts.includeExtracted) q = q.is('extraction_version', null)
  q = q.order('last_seen_at', { ascending: opts.order === 'oldest', nullsFirst: false }).limit(limit)
  const { data, error } = await q
  if (error) return { rows: [], error: error.message, migrationMissing: isMissingSchema(error.message) }
  return { rows: (data ?? []) as unknown as ExtractionCandidate[], error: null, migrationMissing: false }
}

/**
 * The descriptions for the rows that were actually chosen. Deliberately apart
 * from the pool query: a description is kilobytes, and pulling five hundred of
 * them to rank on a title would cost more than the extraction it is rationing.
 */
export async function loadJobTexts(
  userId: string,
  ids: string[],
  db: Db = createServiceClient()
): Promise<{ texts: Map<string, string | null>; error: string | null }> {
  const texts = new Map<string, string | null>()
  if (ids.length === 0) return { texts, error: null }
  const { data, error } = await db.from('job_opportunities').select('id, description_text').eq('user_id', userId).in('id', ids)
  if (error) return { texts, error: error.message }
  for (const r of (data ?? []) as { id: string; description_text: string | null }[]) texts.set(r.id, r.description_text)
  return { texts, error: null }
}

/** Write one extraction onto one row. The patch comes from `extractionPatch`. */
export async function applyExtraction(
  userId: string,
  id: string,
  patch: Record<string, unknown>,
  db: Db = createServiceClient()
): Promise<{ error: string | null; migrationMissing: boolean }> {
  const { error } = await db.from('job_opportunities').update(patch as never).eq('user_id', userId).eq('id', id)
  if (error) return { error: error.message, migrationMissing: isMissingSchema(error.message) }
  return { error: null, migrationMissing: false }
}
