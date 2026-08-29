// Pure helpers behind validateImporterOutput (./index): coercions, the
// index of every line and existing fact the model was shown, and the check
// on a `corroborates` claim. No model, no I/O. Split out of ./index to keep
// that file under the ~400-line convention.

import { normalizeModelText } from '../runtime/text'
import type { ExperienceKind } from '@/lib/career/types'
import { sharedContentWords } from './checks'
import type { ImportedNewExperience } from './index'
import type { ResumeImporterInput } from './prompt'
import { EXPERIENCE_KINDS } from './schema'

/**
 * A `corroborates` claim must name an existing fact whose statement shares at
 * least this many content words with the cited line. Below it the claim is
 * dropped (the fact is kept) — a line naming none of the fact's words cannot
 * be a restatement of it, whatever the model says.
 */
export const MIN_SHARED_CONTENT_WORDS = 3

export function clamp01(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 1
  return Math.min(1, Math.max(0, v))
}

export function refs(v: unknown, max: number): number[] {
  if (!Array.isArray(v)) return []
  const out: number[] = []
  for (const x of v) {
    const n = typeof x === 'number' ? x : Number(x)
    if (Number.isInteger(n) && n >= 0 && n < max && !out.includes(n)) out.push(n)
  }
  return out
}

export interface SourceIndex {
  byExperience: Map<string, Map<number, string>>
  extra: Map<string, Map<number, string>>
  headerOf: Map<string, string>
  existingFacts: Map<string, { statement: string; key: string }>
}

/** Every line the code supplied, addressable by (label, index), and every existing fact by id. */
export function buildSourceIndex(input: ResumeImporterInput): SourceIndex {
  const byExperience = new Map<string, Map<number, string>>()
  const headerOf = new Map<string, string>()
  const existingFacts = new Map<string, { statement: string; key: string }>()
  for (const e of input.experiences) {
    byExperience.set(e.key, new Map(e.bullets.map((b) => [b.paragraph_index, b.text])))
    headerOf.set(e.key, [e.title, e.organization, e.location, e.start_date, e.end_date].filter(Boolean).join(' '))
    for (const f of e.existing_facts ?? []) existingFacts.set(f.id, { statement: f.statement, key: e.key })
  }
  const extra = new Map<string, Map<number, string>>()
  for (const s of input.extra_sources) extra.set(s.label, new Map(s.lines.map((l) => [l.paragraph_index, l.text])))
  return { byExperience, extra, headerOf, existingFacts }
}

/**
 * The agent's `corroborates`, checked: the id must be one the input listed,
 * under THIS experience, and the cited line must share content words with
 * the existing statement. A failing claim is dropped with a reason; the fact
 * itself survives as a new fact, which the persist plan may still match.
 */
export function checkCorroborates(
  raw: unknown,
  key: string,
  lineText: string,
  existingFacts: SourceIndex['existingFacts']
): { id: string | null; note: string | null } {
  const id = normalizeModelText(raw)
  if (!id) return { id: null, note: null }
  const hit = existingFacts.get(id)
  if (!hit) return { id: null, note: `corroborates "${id}" is not an existing fact id — dropped` }
  if (hit.key !== key) return { id: null, note: `corroborates "${id}" belongs to another experience — dropped` }
  const shared = sharedContentWords(lineText, hit.statement)
  if (shared < MIN_SHARED_CONTENT_WORDS) {
    return { id: null, note: `corroborates "${id}": the cited line shares ${shared} content word(s) with "${hit.statement}" (need ${MIN_SHARED_CONTENT_WORDS}) — dropped` }
  }
  return { id, note: null }
}

/** The role as THIS text states it, when filing under an existing row. Needs a title and an organization. */
export function asWritten(ne: unknown): ImportedNewExperience | null {
  if (!ne || typeof ne !== 'object') return null
  const n = ne as Record<string, unknown>
  const title = normalizeModelText(n.title)
  const organization = normalizeModelText(n.organization)
  if (!title || !organization) return null
  const kind = String(n.kind ?? '') as ExperienceKind
  return {
    title,
    organization,
    location: normalizeModelText(n.location) || null,
    start_date: normalizeModelText(n.start_date) || null,
    end_date: normalizeModelText(n.end_date) || null,
    kind: EXPERIENCE_KINDS.includes(kind) ? kind : 'other',
  }
}
