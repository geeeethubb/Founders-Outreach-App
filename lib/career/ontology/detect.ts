// Evidence → documents → disciplines. The first half of the derivation, kept
// apart from the assembly in build.ts so each file reads on one screen.
//
// A DOCUMENT is one row the founder can point at — an experience, a fact, a
// project, a story, a skill, a stated preference, the direction, the mission.
// Cue matching (the tables in table.ts) turns documents into DISCIPLINES with
// a confidence and a justification. Nothing here knows about role families.
//
// Evidence is read through `getRelevantPersonalEvidence` — the one retrieval
// layer — so unapproved rows and tombstones can never reach the ontology. The
// two exceptions are documented at their call sites: skills (retrieval caps
// them at 12 by relevance to the query, while the ontology needs the whole
// approved skill vocabulary, so `isLiveRow` — retrieval's own liveness
// predicate — filters them instead) and `evidence_preferences`, a table with
// no approval or tombstone concept at all.

import { getRelevantPersonalEvidence, isLiveRow } from '../evidence/retrieval'
import { stem } from '../evidence/retrieve'
import { missionDirectionMode } from '../types'
import type { DirectionMode, EvidenceBank } from '../types'
import { DISCIPLINES, type DisciplineDef } from './table'
import { SOURCE_RANK, type DetectedDiscipline, type OntologyMission, type OntologySource } from './types'

// ─── Tunables ────────────────────────────────────────────────────────────────

/** Evidence weights: what a match in this kind of row is worth. */
const DOC_WEIGHT = {
  experience: 1, education: 0.8, project: 0.7, story: 0.6, fact: 0.5, skill: 0.5,
  preference: 0.4, mission: 0.35, direction: 1.5,
} as const

/**
 * How much mass each class of document may contribute to one discipline.
 *
 * `evidence_preferences` is seeded from DEFAULT_MISSION_PREFERENCES, so a
 * founder who has never said a word about consulting still carries a dozen
 * rows that mention startups and strategy. Uncapped, thirty-four lines of
 * shipped default outweigh a career of process work — which is the exact
 * failure the V2 audit measured. One class of boilerplate is worth about one
 * real experience, and no more.
 */
const CLASS_MASS_CAP: Record<DocClass, number> = { evidence: Infinity, preference: 1, mission: 1, direction: Infinity }

/**
 * A preference row carries its own weight and a hard-constraint flag. A value
 * the user pushed down to 0.1 must not count like one they marked as a hard
 * constraint, so the row's own weight scales the doc (0.5 is the seed default
 * and leaves DOC_WEIGHT.preference exactly where it was), and a hard
 * constraint is worth a whole preference class on its own.
 */
const PREFERENCE_WEIGHT_FLOOR = 0.5
const PREFERENCE_HARD_WEIGHT = 1

const MIN_DISCIPLINE_CONFIDENCE = 0.25
/**
 * How many DISTINCT weak cues (a bare word like "research", "energy",
 * "clinical") a discipline needs before it fires. One phrase cue ("cell
 * culture") or one prefix cue ("manufactur*") is specific enough on its own; a
 * single generic word is not — that is how a legal internship used to be read
 * as computational science. A direction the user typed themselves bypasses
 * this: they said it, it is not an inference.
 */
const MIN_WEAK_CUES = 2
/** A discipline the user's own direction states is not a guess. */
const DIRECTION_FLOOR = 0.8
/**
 * What the user typed counts double. Applied to MASS, before the relative
 * comparison, so a stated direction actually REORDERS the ontology rather than
 * nudging a number that has already saturated. In `boost` it never removes
 * anything — a direction leads the search, it does not narrow the person. In
 * `exclusive` the user has said the rest is out of scope, and it does.
 */
const DIRECTION_MASS_MULTIPLIER = 2
/** The share of confidence a discipline keeps regardless of how it compares to the strongest one. */
const RELATIVE_FLOOR = 0.45
export const MAX_WHY = 4
export const MAX_EVIDENCE_IDS = 8
const LABEL_CHARS = 72

// ─── Cue matching ────────────────────────────────────────────────────────────

/** Lower-case, punctuation to spaces (keeping &+#- so "R&D" and "P&ID" survive), padded for phrase matching. */
export function normalizeText(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9&+#-]+/g, ' ').replace(/\s+/g, ' ').trim()} `
}

function stemSet(norm: string): Set<string> {
  const out = new Set<string>()
  for (const token of norm.trim().split(' ')) if (token) out.add(stem(token))
  return out
}

/** Cue syntax lives in table.ts. A trailing `*` is a prefix; a space makes it a phrase. */
export function cueMatches(cue: string, norm: string, stems: Set<string>): boolean {
  const raw = cue.trim()
  const isPrefix = raw.endsWith('*')
  const base = normalizeText(isPrefix ? raw.slice(0, -1) : raw).trim()
  if (!base) return false
  if (base.includes(' ')) return isPrefix ? norm.includes(` ${base}`) : norm.includes(` ${base} `)
  if (isPrefix) {
    for (const s of stems) if (s.startsWith(base)) return true
    return false
  }
  return stems.has(stem(base)) || norm.includes(` ${base} `)
}

/**
 * A cue is STRONG when it is specific enough to fire a discipline alone: a
 * phrase ("cell culture") or a prefix ("manufactur*"). A bare word is weak —
 * see MIN_WEAK_CUES.
 */
export function isStrongCue(cue: string): boolean {
  const raw = cue.trim()
  return raw.endsWith('*') || normalizeText(raw).trim().includes(' ')
}

// ─── Documents ───────────────────────────────────────────────────────────────

/** Documents are capped by class, not individually — see CLASS_MASS_CAP. */
type DocClass = 'evidence' | 'preference' | 'mission' | 'direction'

export interface OntologyDoc {
  id: string
  label: string
  text: string
  weight: number
  source: OntologySource
  cls: DocClass
  isEvidence: boolean
}

export function short(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > LABEL_CHARS ? `${t.slice(0, LABEL_CHARS - 1).trimEnd()}…` : t
}

export function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

export interface Collected {
  docs: OntologyDoc[]
  skillTerms: { name: string; id: string; isTool: boolean }[]
  /**
   * The user's own job titles, in bank order. The fallback when no discipline
   * in the table fires: a nurse, a paralegal or a marketer is not in
   * `DISCIPLINES`, and must still come out of here with something to search.
   */
  titles: { title: string; organization: string; id: string }[]
  directionMode: DirectionMode
  stats: { experiences: number; facts: number; skills: number; projects: number; preferences: number }
}

function clamp01(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : PREFERENCE_WEIGHT_FLOOR
}

export function collectDocs(bank: EvidenceBank, mission: OntologyMission | null | undefined): Collected {
  const prefs = mission?.preferences ?? null
  const direction = typeof prefs?.direction === 'string' ? prefs.direction.trim() : ''
  const objective = typeof mission?.objective === 'string' ? mission.objective.trim() : ''
  // The sanctioned reader: `off` with no direction, `boost` by default, and
  // `exclusive` only when the user chose it. Never read `direction_mode` raw.
  const directionMode = missionDirectionMode({ direction, direction_mode: prefs?.direction_mode ?? undefined })

  // The retrieval query: the user's own words, so the ranking inside the bank
  // follows their stated direction. Limits are deliberately far above any real
  // bank — the ontology wants every approved row, not a shortlist.
  const relevant = getRelevantPersonalEvidence({
    bank,
    mission: direction || objective || null,
    maxExperiences: 200,
    maxFacts: 500,
    includeSkills: true,
    includeStories: true,
    includeMetrics: false,
  })

  const docs: OntologyDoc[] = []
  for (const e of relevant.experiences) {
    docs.push({
      id: e.experience.id,
      label: `${e.roleTitle} · ${e.organization}`,
      text: [e.roleTitle, e.organization, e.summary, e.experience.description ?? ''].join(' '),
      weight: e.experience.kind === 'education' ? DOC_WEIGHT.education : DOC_WEIGHT.experience,
      source: 'evidence',
      cls: 'evidence',
      isEvidence: true,
    })
  }

  const seenFacts = new Set<string>()
  for (const f of [...relevant.facts, ...relevant.experiences.flatMap((e) => e.facts)]) {
    if (seenFacts.has(f.fact.id)) continue
    seenFacts.add(f.fact.id)
    docs.push({ id: f.fact.id, label: short(f.fact.statement), text: f.fact.statement, weight: DOC_WEIGHT.fact, source: 'evidence', cls: 'evidence', isEvidence: true })
  }

  const seenProjects = new Set<string>()
  for (const p of relevant.experiences.flatMap((e) => e.projects)) {
    if (seenProjects.has(p.id)) continue
    seenProjects.add(p.id)
    docs.push({ id: p.id, label: `project “${short(p.name)}”`, text: `${p.name} ${p.description ?? ''}`, weight: DOC_WEIGHT.project, source: 'evidence', cls: 'evidence', isEvidence: true })
  }

  for (const s of relevant.stories) {
    docs.push({
      id: s.id,
      label: `story “${short(s.title)}”`,
      text: [s.title, s.situation, s.task, s.actions, s.result, s.learning].filter(Boolean).join(' '),
      weight: DOC_WEIGHT.story, source: 'evidence', cls: 'evidence', isEvidence: true,
    })
  }

  // Skills: see the header note — retrieval caps them at 12 by query relevance,
  // so liveness is enforced with retrieval's own predicate instead.
  const skills = (bank.skills ?? []).filter(isLiveRow)
  for (const s of skills) {
    docs.push({ id: s.id, label: `skill “${short(s.name)}”`, text: s.name, weight: DOC_WEIGHT.skill, source: 'evidence', cls: 'evidence', isEvidence: true })
  }

  // evidence_preferences has no `approved` column and no tombstones: these are
  // the user's stated priorities, which is why they count as mission intent.
  const preferences = bank.preferences ?? []
  for (const p of preferences) {
    // The row's own weight scales it, and a hard constraint is worth the whole
    // preference class — the user marked it as non-negotiable.
    const scaled = DOC_WEIGHT.preference * (PREFERENCE_WEIGHT_FLOOR + clamp01(p.weight))
    const weight = p.hard_constraint ? Math.max(scaled, PREFERENCE_HARD_WEIGHT) : scaled
    docs.push({ id: p.id, label: `preference “${short(p.value)}”`, text: `${p.category} ${p.value} ${p.note ?? ''}`, weight, source: 'mission', cls: 'preference', isEvidence: false })
  }

  if (direction && directionMode !== 'off') {
    docs.push({ id: 'direction', label: 'your stated direction', text: direction, weight: DOC_WEIGHT.direction, source: 'direction', cls: 'direction', isEvidence: false })
  }
  const missionText = [objective, ...(prefs?.company_types ?? []), typeof prefs?.notes === 'string' ? prefs.notes : ''].filter(Boolean).join(' ')
  if (missionText.trim()) {
    docs.push({ id: 'mission', label: 'your mission', text: missionText, weight: DOC_WEIGHT.mission, source: 'mission', cls: 'mission', isEvidence: false })
  }

  return {
    docs,
    skillTerms: skills.map((s) => ({ name: s.name, id: s.id, isTool: s.category === 'tool' })),
    titles: relevant.experiences
      .filter((e) => e.experience.kind !== 'education' && e.roleTitle.trim())
      .map((e) => ({ title: e.roleTitle.trim(), organization: e.organization, id: e.experience.id })),
    directionMode,
    stats: {
      experiences: relevant.stats.experiencesConsidered,
      facts: relevant.stats.factsConsidered,
      skills: skills.length,
      projects: seenProjects.size,
      preferences: preferences.length,
    },
  }
}

// ─── Disciplines ─────────────────────────────────────────────────────────────

interface DisciplineHit {
  def: DisciplineDef
  mass: number
  cues: Set<string>
  ordered: { doc: OntologyDoc; count: number }[]
  source: OntologySource
  fromDirection: boolean
}

export interface DisciplineDetection {
  disciplines: DetectedDiscipline[]
  /** Disciplines an `exclusive` direction ruled out of scope. 0 in every other mode. */
  narrowedByDirection: number
}

export function detectDisciplines(docs: OntologyDoc[], directionMode: DirectionMode = 'boost'): DisciplineDetection {
  const prepared = docs.map((d) => {
    const norm = normalizeText(d.text)
    return { doc: d, norm, stems: stemSet(norm) }
  })
  const hitsByDiscipline: DisciplineHit[] = []

  for (const def of DISCIPLINES) {
    const cues = new Set<string>()
    const hits: { doc: OntologyDoc; count: number }[] = []
    let source: OntologySource = 'evidence'
    let rank = -1
    let fromDirection = false
    for (const p of prepared) {
      let count = 0
      for (const cue of def.cues) {
        if (!cueMatches(cue, p.norm, p.stems)) continue
        count++
        cues.add(cue)
      }
      if (count === 0) continue
      hits.push({ doc: p.doc, count })
      if (SOURCE_RANK[p.doc.source] > rank) { rank = SOURCE_RANK[p.doc.source]; source = p.doc.source }
      if (p.doc.source === 'direction') fromDirection = true
    }
    if (hits.length === 0) continue
    // One specific cue fires a discipline; a single generic word does not.
    // The user's own direction is exempt — it is a statement, not an inference.
    if (!fromDirection && ![...cues].some(isStrongCue) && cues.size < MIN_WEAK_CUES) continue

    // Mass: each document contributes its weight, a little more when several
    // cues fire in it, and each CLASS of document is capped (CLASS_MASS_CAP)
    // so seeded boilerplate cannot outvote lived evidence.
    const byClass = new Map<DocClass, number>()
    for (const h of hits) {
      byClass.set(h.doc.cls, (byClass.get(h.doc.cls) ?? 0) + h.doc.weight * Math.min(1, 0.5 + 0.25 * h.count))
    }
    let mass = 0
    for (const [cls, m] of byClass) mass += Math.min(m, CLASS_MASS_CAP[cls])
    if (fromDirection) mass *= DIRECTION_MASS_MULTIPLIER
    const ordered = [...hits].sort(
      (a, b) => b.doc.weight - a.doc.weight || b.count - a.count || a.doc.label.localeCompare(b.doc.label) || a.doc.id.localeCompare(b.doc.id)
    )
    hitsByDiscipline.push({ def, mass, cues, ordered, source, fromDirection })
  }

  // Confidence is SATURATING (a bank of fifty facts does not make every
  // discipline certain) and RELATIVE (a discipline is scored against the
  // strongest one in this bank, so two consulting facts beside a career of
  // process work rank as two consulting facts). Both halves are needed: the
  // absolute half stops a thin bank from claiming certainty, the relative half
  // is what orders the search.
  const maxMass = Math.max(...hitsByDiscipline.map((h) => h.mass), 1e-9)
  const detected: (DetectedDiscipline & { fromDirection: boolean })[] = []
  for (const h of hitsByDiscipline) {
    const saturation = 1 - Math.exp(-1.1 * h.mass)
    let confidence = saturation * (RELATIVE_FLOOR + (1 - RELATIVE_FLOOR) * (h.mass / maxMass))
    if (h.fromDirection) confidence = Math.max(confidence, DIRECTION_FLOOR)
    if (confidence < MIN_DISCIPLINE_CONFIDENCE) continue
    detected.push({
      id: h.def.id,
      label: h.def.label,
      confidence: round(Math.min(1, confidence)),
      source: h.source,
      matchedCues: h.def.cues.filter((c) => h.cues.has(c)),
      why: h.ordered.slice(0, MAX_WHY).map((x) => x.doc.label),
      evidenceIds: h.ordered.filter((x) => x.doc.isEvidence).slice(0, MAX_EVIDENCE_IDS).map((x) => x.doc.id),
      fromDirection: h.fromDirection,
    })
  }

  // `exclusive` means what it says on the mission page: "restrict discovery and
  // ranking to it; anything else is out of scope". A discipline the direction
  // never names is dropped — but only when the direction named SOMETHING, since
  // narrowing to nothing is not a narrower search, it is no search at all.
  let kept = detected
  let narrowedByDirection = 0
  if (directionMode === 'exclusive' && detected.some((d) => d.fromDirection)) {
    kept = detected.filter((d) => d.fromDirection)
    narrowedByDirection = detected.length - kept.length
  }

  return {
    disciplines: kept
      .map((d): DetectedDiscipline => ({
        id: d.id, label: d.label, confidence: d.confidence, source: d.source,
        matchedCues: d.matchedCues, why: d.why, evidenceIds: d.evidenceIds,
      }))
      .sort((a, b) => b.confidence - a.confidence || a.label.localeCompare(b.label)),
    narrowedByDirection,
  }
}

