// The Search Ontology — the Evidence Bank restated as things to search for.
//
// "Chemical Engineering" must not yield only "Chemical Engineering Intern".
// The ontology turns what the bank says about a person into the ROLE FAMILIES,
// INDUSTRIES and TERMS a query planner can search the whole internet with, and
// it carries the justification for every one of them so the founder can read
// "OutreachOS thinks these are worth searching, because…" and disagree.
//
// Three rules hold:
//   * it is PURE and DETERMINISTIC — no model call, no I/O, no clock. Two runs
//     over the same bank are deep-equal (the offline suite asserts this).
//   * it is DATA-DRIVEN — the discipline → family mapping lives in table.ts and
//     table-families.ts as readable tables, seeded from evidence terms. It is
//     not a taxonomy keyed on one person's résumé; change the bank and the
//     ontology changes.
//   * every entry carries `why` — the evidence labels (and `evidenceIds`) that
//     produced it. An entry nothing justifies is a bug.
//
// The user is the final authority: BOOST / MUTE / EXCLUDE / ADD overrides are
// stored on the mission and applied by `applyOntologyOverrides`, a pure
// function over a built ontology.

import type { DirectionMode } from '../types'

/** Bump on any semantic change to the tables or the derivation, like a prompt version. */
export const ONTOLOGY_VERSION = 2

/** Where an entry came from. Precedence when the same entry is derived twice: user > direction > mission > evidence. */
export type OntologySource = 'evidence' | 'direction' | 'mission' | 'user'

export const SOURCE_RANK: Record<OntologySource, number> = { evidence: 0, mission: 1, direction: 2, user: 3 }

/** The lists an entry can live in. An override names one, so ids need only be unique within a list. */
export type OntologyKind =
  | 'roleFamily'
  | 'industry'
  | 'adjacentIndustry'
  | 'skillTerm'
  | 'functionTerm'
  | 'toolTerm'

export const ONTOLOGY_KINDS: OntologyKind[] = [
  'roleFamily', 'industry', 'adjacentIndustry', 'skillTerm', 'functionTerm', 'toolTerm',
]

/** The list on `SearchOntology` each kind is stored in. */
export const KIND_FIELD: Record<OntologyKind, keyof Pick<SearchOntology,
  'roleFamilies' | 'industries' | 'adjacentIndustries' | 'skillTerms' | 'functionTerms' | 'toolTerms'>> = {
  roleFamily: 'roleFamilies',
  industry: 'industries',
  adjacentIndustry: 'adjacentIndustries',
  skillTerm: 'skillTerms',
  functionTerm: 'functionTerms',
  toolTerm: 'toolTerms',
}

/**
 * One thing worth searching for.
 *
 * `titleVariants` is what a query planner expands into searches and is
 * meaningful for role families; term entries (skills, functions, tools) carry
 * an empty array and are searched by `label`.
 */
export interface OntologyEntry {
  /** Stable slug, unique within its list. Overrides key on it. */
  id: string
  label: string
  /** Searchable job titles for a role family; [] for a term. */
  titleVariants: string[]
  /** Human-readable justification: which evidence produced this, and how. Never empty for a derived entry. */
  why: string[]
  /** The evidence row ids behind `why` (experience / fact / skill / project ids). Empty for direction- and mission-derived entries. */
  evidenceIds: string[]
  /** 0–1. Derived from how strongly the evidence attests the discipline, times how close the family is to it. */
  confidence: number
  source: OntologySource
  /** Set by applyOntologyOverrides when the user has boosted or muted this entry. */
  override?: 'boost' | 'mute'
  /**
   * The confidence this entry had BEFORE an override touched it. Written by
   * `applyOntologyOverrides` alongside `override`, and what makes re-applying
   * the same overrides a no-op: boost and mute always recompute from here, so
   * they cannot compound. Absent on a freshly built entry.
   */
  baseConfidence?: number
}

/**
 * A discipline the bank attests — the middle layer between evidence and
 * families, surfaced so the panel can explain a family in one hop
 * ("Process Engineering, because your evidence shows Chemical Engineering").
 */
export interface DetectedDiscipline {
  id: string
  label: string
  confidence: number
  source: OntologySource
  /** The cues that fired, in table order. */
  matchedCues: string[]
  why: string[]
  evidenceIds: string[]
}

/** A combination that fired (manufacturing × AI ⇒ industrial AI), kept for the same reason. */
export interface DetectedCombination {
  id: string
  label: string
  confidence: number
  disciplines: string[]
}

export interface OntologyStats {
  experiencesConsidered: number
  factsConsidered: number
  skillsConsidered: number
  projectsConsidered: number
  preferencesConsidered: number
  /** Docs the cue matcher read — experiences, facts, skills, projects, preferences, direction, mission. */
  documents: number
  disciplinesDetected: number
  roleFamilies: number
  /** True when the bank contributed nothing: every entry (if any) came from the mission. */
  bankEmpty: boolean
  /**
   * How the stated direction was applied, resolved with `missionDirectionMode`:
   * `off` (none stated), `boost` (lead here, keep everything else) or
   * `exclusive` (the user said anything else is out of scope).
   */
  directionMode: DirectionMode
  /** Disciplines the bank attests that `exclusive` dropped as out of scope. 0 in any other mode. */
  narrowedByDirection: number
  /**
   * True when no discipline in the table fired and the role families are the
   * user's OWN job titles instead. The table is a map, not the territory: an
   * uncovered field must still produce something to search for.
   */
  usedTitleFallback: boolean
}

export interface SearchOntology {
  version: number
  roleFamilies: OntologyEntry[]
  industries: OntologyEntry[]
  adjacentIndustries: OntologyEntry[]
  skillTerms: OntologyEntry[]
  functionTerms: OntologyEntry[]
  toolTerms: OntologyEntry[]
  disciplines: DetectedDiscipline[]
  combinations: DetectedCombination[]
  /** Entries the user excluded, kept so the panel can show and undo them. Empty from `buildSearchOntology`. */
  excluded: { id: string; kind: OntologyKind; label: string }[]
  stats: OntologyStats
}

// ─── User overrides ──────────────────────────────────────────────────────────

export type OntologyAction = 'boost' | 'mute' | 'exclude' | 'add'

/**
 * One user decision about one entry.
 *
 * Stored on the mission at `preferences.ontology_overrides`. V1 owns the
 * mission schema and `sanitizePreferences` drops keys it does not know, so
 * this is read and written DEFENSIVELY: `readOntologyOverrides` accepts
 * anything and returns a valid value, and the writer merges into the stored
 * preferences object rather than replacing it.
 */
export interface OntologyOverride {
  /** Entry id within `kind`. For an `add`, the slug of the label (or a known family id). */
  id: string
  kind: OntologyKind
  action: OntologyAction
  /** `add` only: what the user typed. */
  label?: string
  /** `add` only: titles to search. Defaults to the known family's variants, else derived from the label. */
  titleVariants?: string[]
  note?: string
  /** ISO timestamp, written by the API. Never read by the pure functions. */
  at?: string
}

export interface OntologyOverrides {
  version: 1
  entries: OntologyOverride[]
}

export const EMPTY_OVERRIDES: OntologyOverrides = { version: 1, entries: [] }

/** The key on `career_missions.preferences` that holds the overrides. */
export const OVERRIDES_KEY = 'ontology_overrides'

/**
 * The mission slice the ontology reads. A full `CareerMission` satisfies it;
 * so does `{ preferences: { direction } }`, so callers need not load a row.
 */
export interface OntologyMission {
  objective?: string | null
  preferences?: {
    direction?: string | null
    /**
     * migration 017. NEVER read directly — `missionDirectionMode()` resolves
     * the default. `off` ignores the direction, `boost` leads with it,
     * `exclusive` narrows the ontology to what it names.
     */
    direction_mode?: DirectionMode | null
    role_families?: string[]
    industries?: string[]
    company_types?: string[]
    notes?: string | null
  } | null
}
