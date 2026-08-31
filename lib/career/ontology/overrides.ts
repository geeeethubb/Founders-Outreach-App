// User control over the ontology. Pure.
//
// The derivation is a machine's opinion; these are the founder's corrections,
// and they win. Four decisions per entry:
//
//   BOOST    search this harder than the evidence alone justifies
//   MUTE     keep it visible, search it last
//   EXCLUDE  never search it (kept in `excluded` so it can be undone)
//   ADD      search this, whatever the evidence says
//
// Storage: `career_missions.preferences.ontology_overrides`. V1 owns the
// mission schema and `sanitizePreferences` drops keys it does not know, so
// this module reads DEFENSIVELY (anything at all in, a valid value out) and
// writes by merging into the stored preferences object rather than replacing
// it. Nothing here touches a database.

import { ROLE_FAMILIES, findByLabel } from './table-families'
import {
  EMPTY_OVERRIDES, KIND_FIELD, ONTOLOGY_KINDS, OVERRIDES_KEY,
  type OntologyAction, type OntologyEntry, type OntologyKind, type OntologyOverride,
  type OntologyOverrides, type SearchOntology,
} from './types'

const BOOST_DELTA = 0.25
const MUTE_FACTOR = 0.35
const ADD_CONFIDENCE = 1

export function slugForLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'entry'
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

function isKind(v: unknown): v is OntologyKind {
  return typeof v === 'string' && (ONTOLOGY_KINDS as string[]).includes(v)
}

function isAction(v: unknown): v is OntologyAction {
  return v === 'boost' || v === 'mute' || v === 'exclude' || v === 'add'
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((s) => s.trim()) : []
}

/** One override, or null if it is not well-formed. Malformed input is dropped, never coerced. */
export function normalizeOverride(value: unknown): OntologyOverride | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (!isKind(v.kind) || !isAction(v.action)) return null
  const label = typeof v.label === 'string' ? v.label.trim() : ''
  const id = typeof v.id === 'string' && v.id.trim() ? v.id.trim() : label ? slugForLabel(label) : ''
  if (!id) return null
  if (v.action === 'add' && !label) return null
  const out: OntologyOverride = { id, kind: v.kind, action: v.action }
  if (label) out.label = label
  const variants = strings(v.titleVariants)
  if (variants.length) out.titleVariants = variants
  if (typeof v.note === 'string' && v.note.trim()) out.note = v.note.trim()
  if (typeof v.at === 'string' && v.at.trim()) out.at = v.at.trim()
  return out
}

/**
 * Read the overrides off whatever the mission's `preferences` jsonb turns out
 * to be. A missing key, a null, a string, an array — all mean "no overrides".
 */
export function readOntologyOverrides(preferences: unknown): OntologyOverrides {
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) return { ...EMPTY_OVERRIDES, entries: [] }
  const raw = (preferences as Record<string, unknown>)[OVERRIDES_KEY]
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { entries?: unknown } | null)?.entries) ? (raw as { entries: unknown[] }).entries : []
  const entries: OntologyOverride[] = []
  for (const item of list) {
    const o = normalizeOverride(item)
    if (o) entries.push(o)
  }
  return { version: 1, entries }
}

/** The preferences object to store: everything it already had, plus the overrides. Never mutates its input. */
export function withOntologyOverrides<T extends Record<string, unknown>>(preferences: T | null | undefined, overrides: OntologyOverrides): Record<string, unknown> {
  const base = preferences && typeof preferences === 'object' && !Array.isArray(preferences) ? preferences : ({} as T)
  return { ...base, [OVERRIDES_KEY]: { version: 1, entries: overrides.entries } }
}

const keyOf = (kind: OntologyKind, id: string) => `${kind}:${id}`

/**
 * Record one decision. The last decision about an entry wins, so an earlier
 * override of the same class (add, or one of boost/mute/exclude) is replaced
 * rather than stacked — the stored list stays as small as the number of
 * entries the user has actually touched.
 */
export function recordOntologyOverride(overrides: OntologyOverrides, override: OntologyOverride): OntologyOverrides {
  const next = normalizeOverride(override)
  if (!next) return { version: 1, entries: [...overrides.entries] }
  const sameClass = (o: OntologyOverride) => (o.action === 'add') === (next.action === 'add')
  const entries = overrides.entries.filter((o) => !(keyOf(o.kind, o.id) === keyOf(next.kind, next.id) && sameClass(o)))
  entries.push(next)
  return { version: 1, entries }
}

/** Forget every decision about one entry — the undo behind the panel's "reset". */
export function clearOntologyOverride(overrides: OntologyOverrides, kind: OntologyKind, id: string): OntologyOverrides {
  return { version: 1, entries: overrides.entries.filter((o) => keyOf(o.kind, o.id) !== keyOf(kind, id)) }
}

/** Titles to search for an entry the user typed by hand: the known family's, else the label itself. */
function variantsForAdd(o: OntologyOverride): string[] {
  if (o.titleVariants?.length) return [...o.titleVariants]
  const known = ROLE_FAMILIES.find((f) => f.id === o.id) ?? findByLabel(o.label ?? o.id).family
  if (known && o.kind === 'roleFamily') return [...known.titleVariants]
  return o.kind === 'roleFamily' ? [(o.label ?? o.id).trim()] : []
}

/**
 * Apply the user's decisions to a built ontology. Pure: a new ontology out,
 * the input untouched. Excluded entries move to `ontology.excluded`; boosted
 * and muted ones keep their place in the list with `override` set, so the
 * panel can always show what was changed and why.
 *
 * IDEMPOTENT for the same overrides: `apply(apply(o, ov), ov)` deep-equals
 * `apply(o, ov)`. Boost and mute always recompute from `baseConfidence` — the
 * value the entry had before any override touched it — so re-applying cannot
 * compound them, and an entry whose override has since been cleared is
 * restored to that value. (The canonical caller still applies once, to a fresh
 * build; this is so a caller that re-applies cannot corrupt the numbers.)
 */
export function applyOntologyOverrides(ontology: SearchOntology, overrides: OntologyOverrides): SearchOntology {
  const adds = new Map<string, OntologyOverride>()
  const actions = new Map<string, OntologyAction>()
  for (const o of overrides.entries) {
    if (o.action === 'add') adds.set(keyOf(o.kind, o.id), o)
    else actions.set(keyOf(o.kind, o.id), o.action)
  }

  const next: SearchOntology = {
    ...ontology,
    disciplines: ontology.disciplines.map((d) => ({ ...d })),
    combinations: ontology.combinations.map((c) => ({ ...c })),
    excluded: [...ontology.excluded],
    stats: { ...ontology.stats },
  }
  const excluded = next.excluded

  for (const kind of ONTOLOGY_KINDS) {
    const field = KIND_FIELD[kind]
    const entries: OntologyEntry[] = ontology[field].map((e) => ({ ...e, why: [...e.why], evidenceIds: [...e.evidenceIds], titleVariants: [...e.titleVariants] }))

    for (const [key, o] of [...adds.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (!key.startsWith(`${kind}:`)) continue
      const hit = entries.find((e) => e.id === o.id)
      if (hit) {
        // The derivation found it too; the user saying it out loud still counts.
        hit.source = 'user'
        hit.confidence = Math.max(hit.confidence, ADD_CONFIDENCE)
        if (!hit.why.includes('you added this')) hit.why = ['you added this', ...hit.why].slice(0, 4)
        continue
      }
      entries.push({
        id: o.id,
        label: o.label ?? o.id,
        titleVariants: variantsForAdd(o),
        why: ['you added this'],
        evidenceIds: [],
        confidence: ADD_CONFIDENCE,
        source: 'user',
      })
    }

    const kept: OntologyEntry[] = []
    for (const e of entries) {
      const action = actions.get(keyOf(kind, e.id))
      if (action === 'exclude') {
        excluded.push({ id: e.id, kind, label: e.label })
        continue
      }
      // Always from the pre-override value, never from the current one: that
      // is what stops a second application from boosting or muting twice.
      const base = e.baseConfidence ?? e.confidence
      if (action === 'boost') {
        e.baseConfidence = base
        e.confidence = round(Math.min(1, base + BOOST_DELTA))
        e.override = 'boost'
        e.source = 'user'
      } else if (action === 'mute') {
        e.baseConfidence = base
        e.confidence = round(base * MUTE_FACTOR)
        e.override = 'mute'
        e.source = 'user'
      } else if (e.override) {
        // The decision was cleared since this ontology was last applied to.
        e.confidence = round(base)
        delete e.baseConfidence
        delete e.override
      }
      kept.push(e)
    }

    kept.sort((a, b) =>
      Number(a.override === 'mute') - Number(b.override === 'mute') ||
      b.confidence - a.confidence ||
      a.label.localeCompare(b.label) ||
      a.id.localeCompare(b.id)
    )
    next[field] = kept
  }

  // An entry can be both added and excluded (they are separate decisions), so
  // a second application would list it twice. One row per entry.
  const seenExcluded = new Set<string>()
  next.excluded = excluded
    .filter((e) => (seenExcluded.has(keyOf(e.kind, e.id)) ? false : (seenExcluded.add(keyOf(e.kind, e.id)), true)))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
  next.stats = { ...next.stats, roleFamilies: next.roleFamilies.length }
  return next
}
