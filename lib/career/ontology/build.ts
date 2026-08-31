// buildSearchOntology — the Evidence Bank turned into things to search for.
//
// Pure and deterministic. No model call, no I/O, no clock. The pipeline is:
//
//   evidence  ──► DOCS (label + text + weight + source)        detect.ts
//                   │  every doc is a row the founder can point at
//                   ▼
//             CUE MATCH (table.ts)  ──► DISCIPLINES + why      detect.ts
//                   │
//                   ├─► core families      × CORE_STRENGTH     ┐
//                   ├─► adjacent families  × ADJACENT_STRENGTH │ ← the recall lever
//                   ├─► industries, and their adjacents        │   this file
//                   └─► COMBINATIONS (both attested)           ┘
//
// Every entry that leaves here carries the evidence that justified it.

import type { EvidenceBank } from '../types'
import { collectDocs, detectDisciplines, MAX_EVIDENCE_IDS, MAX_WHY, round, short } from './detect'
import {
  ADJACENT_STRENGTH, COMBINATION_STRENGTH, COMBINATIONS, CORE_STRENGTH, DISCIPLINES,
  INDUSTRY_ADJACENT_STRENGTH, type DisciplineDef,
} from './table'
import { INDUSTRIES, ROLE_FAMILIES, industry, roleFamily } from './table-families'
import {
  ONTOLOGY_VERSION, SOURCE_RANK,
  type DetectedCombination, type DetectedDiscipline, type OntologyEntry, type OntologyMission,
  type OntologySource, type SearchOntology,
} from './types'

/** Entries below this are dropped. Discovery biases toward recall, so it is low on purpose. */
const DEFAULT_MIN_CONFIDENCE = 0.15
const DEFAULT_MAX_TERMS = 40

export interface BuildOntologyInput {
  bank: EvidenceBank
  mission?: OntologyMission | null
  options?: {
    /** Entries below this are dropped. Default 0.15 — discovery biases toward recall. */
    minConfidence?: number
    /** Cap per term list (skills, functions, tools). Default 40. */
    maxTermsPerList?: number
    /** Optional cap on role families. Unset means every family the evidence justifies. */
    maxRoleFamilies?: number
  }
}

// ─── Accumulation ────────────────────────────────────────────────────────────

/** One list under construction. Merging keeps the strongest confidence and unions the justifications. */
class EntryBag {
  private byId = new Map<string, OntologyEntry>()

  add(entry: OntologyEntry): void {
    const existing = this.byId.get(entry.id)
    if (!existing) {
      this.byId.set(entry.id, { ...entry, why: [...entry.why], evidenceIds: [...entry.evidenceIds] })
      return
    }
    existing.confidence = Math.max(existing.confidence, entry.confidence)
    if (SOURCE_RANK[entry.source] > SOURCE_RANK[existing.source]) existing.source = entry.source
    for (const w of entry.why) if (!existing.why.includes(w) && existing.why.length < MAX_WHY) existing.why.push(w)
    for (const id of entry.evidenceIds) if (!existing.evidenceIds.includes(id) && existing.evidenceIds.length < MAX_EVIDENCE_IDS) existing.evidenceIds.push(id)
    for (const v of entry.titleVariants) if (!existing.titleVariants.includes(v)) existing.titleVariants.push(v)
  }

  list(minConfidence: number, max?: number): OntologyEntry[] {
    const rows = [...this.byId.values()]
      .filter((e) => e.confidence >= minConfidence)
      .sort((a, b) => b.confidence - a.confidence || SOURCE_RANK[b.source] - SOURCE_RANK[a.source] || a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
    return max && max > 0 ? rows.slice(0, max) : rows
  }
}

function whyFor(d: DetectedDiscipline, relation: 'core' | 'adjacent' | 'industry'): string {
  const from = d.why.slice(0, 2).join('; ')
  const lead = relation === 'adjacent' ? `${d.label} transfers here` : d.label
  return from ? `${lead} — from ${from}` : lead
}

function familyEntry(id: string, confidence: number, why: string, d: DetectedDiscipline): OntologyEntry | null {
  const def = roleFamily(id)
  if (!def) return null
  return {
    id: def.id, label: def.label, titleVariants: [...def.titleVariants],
    why: [why], evidenceIds: [...d.evidenceIds], confidence: round(confidence), source: d.source,
  }
}

function industryEntry(id: string, confidence: number, why: string, d: DetectedDiscipline): OntologyEntry | null {
  const def = industry(id)
  if (!def) return null
  return { id: def.id, label: def.label, titleVariants: [], why: [why], evidenceIds: [...d.evidenceIds], confidence: round(confidence), source: d.source }
}

function termEntry(id: string, label: string, confidence: number, why: string[], source: OntologySource, evidenceIds: string[] = []): OntologyEntry {
  return { id, label, titleVariants: [], why: why.slice(0, MAX_WHY), evidenceIds: evidenceIds.slice(0, MAX_EVIDENCE_IDS), confidence: round(confidence), source }
}

function termId(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'term'
}

/** What the fallback families are worth: a real title, but an unmapped one. */
const TITLE_FALLBACK_CONFIDENCE = 0.6

/**
 * A job title as a searchable role, with the season and the word "intern"
 * taken off ("Summer Analytics Intern" → "Analytics"); the raw title is kept
 * as a second variant, so nothing is lost.
 */
export function cleanTitle(title: string): string {
  const stripped = title
    .replace(/\b(summer|winter|fall|autumn|spring|co-?op)\b/gi, ' ')
    .replace(/\bintern(ship)?s?\b/gi, ' ')
    .replace(/\s+([,;/&|-])/g, '$1')
    .replace(/([,;/&|-])\s*$/g, '')
    .replace(/^\s*[,;/&|-]\s*/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return stripped || title.trim()
}

// ─── Main ────────────────────────────────────────────────────────────────────

export function buildSearchOntology(input: BuildOntologyInput): SearchOntology {
  const { bank, mission } = input
  const minConfidence = input.options?.minConfidence ?? DEFAULT_MIN_CONFIDENCE
  const maxTerms = input.options?.maxTermsPerList ?? DEFAULT_MAX_TERMS
  const collected = collectDocs(bank, mission)
  const detection = detectDisciplines(collected.docs, collected.directionMode)
  const disciplines = detection.disciplines
  const byId = new Map(disciplines.map((d) => [d.id, d]))

  const families = new EntryBag()
  const industries = new EntryBag()
  const adjacentIndustries = new EntryBag()
  const skillTerms = new EntryBag()
  const functionTerms = new EntryBag()
  const toolTerms = new EntryBag()
  const coreIndustryIds = new Set<string>()

  for (const d of disciplines) {
    const def = DISCIPLINES.find((x) => x.id === d.id) as DisciplineDef
    for (const id of def.coreFamilies) {
      const e = familyEntry(id, d.confidence * CORE_STRENGTH, whyFor(d, 'core'), d)
      if (e) families.add(e)
    }
    for (const id of def.adjacentFamilies) {
      const e = familyEntry(id, d.confidence * ADJACENT_STRENGTH, whyFor(d, 'adjacent'), d)
      if (e) families.add(e)
    }
    for (const id of def.industries) {
      const e = industryEntry(id, d.confidence * CORE_STRENGTH, whyFor(d, 'industry'), d)
      if (e) { industries.add(e); coreIndustryIds.add(id) }
    }
    for (const term of def.skillTerms ?? []) {
      skillTerms.add(termEntry(termId(term), term, d.confidence * CORE_STRENGTH, [whyFor(d, 'core')], d.source, d.evidenceIds))
    }
  }

  // Industry adjacency is one more step out, and never demotes a core industry.
  for (const d of disciplines) {
    const def = DISCIPLINES.find((x) => x.id === d.id) as DisciplineDef
    for (const coreId of def.industries) {
      for (const adjId of industry(coreId)?.adjacent ?? []) {
        if (coreIndustryIds.has(adjId)) continue
        const e = industryEntry(adjId, d.confidence * INDUSTRY_ADJACENT_STRENGTH, `adjacent to ${industry(coreId)?.label ?? coreId} — ${whyFor(d, 'industry')}`, d)
        if (e) adjacentIndustries.add(e)
      }
    }
  }

  // Combinations: the roles that exist only where two disciplines meet.
  const combinations: DetectedCombination[] = []
  for (const combo of COMBINATIONS) {
    const parts = combo.requires.map((id) => byId.get(id))
    if (parts.some((p) => !p)) continue
    const present = parts as DetectedDiscipline[]
    const confidence = round(Math.min(...present.map((p) => p.confidence)))
    const source = present.reduce<OntologySource>((s, p) => (SOURCE_RANK[p.source] > SOURCE_RANK[s] ? p.source : s), 'evidence')
    const why = `${present.map((p) => p.label).join(' × ') } — both attested: ${present.map((p) => p.why[0] ?? p.label).slice(0, 2).join('; ')}`
    const evidenceIds = [...new Set(present.flatMap((p) => p.evidenceIds))].slice(0, MAX_EVIDENCE_IDS)
    combinations.push({ id: combo.id, label: combo.label, confidence, disciplines: combo.requires })
    for (const id of combo.families) {
      const def = roleFamily(id)
      if (!def) continue
      families.add({ id: def.id, label: def.label, titleVariants: [...def.titleVariants], why: [why], evidenceIds, confidence: round(confidence * COMBINATION_STRENGTH), source })
    }
    for (const id of combo.industries) {
      const def = industry(id)
      if (!def) continue
      industries.add({ id: def.id, label: def.label, titleVariants: [], why: [why], evidenceIds, confidence: round(confidence * COMBINATION_STRENGTH), source })
      coreIndustryIds.add(id)
    }
  }

  // Explicit mission seeds outrank inference: the user typed them.
  for (const label of mission?.preferences?.role_families ?? []) {
    if (typeof label !== 'string' || !label.trim()) continue
    const known = ROLE_FAMILIES.find((f) => f.label.toLowerCase() === label.trim().toLowerCase())
    families.add({
      id: known?.id ?? termId(label), label: known?.label ?? label.trim(),
      titleVariants: known ? [...known.titleVariants] : [label.trim()],
      why: ['stated in your mission’s role families'], evidenceIds: [], confidence: 0.9, source: 'mission',
    })
  }
  for (const label of mission?.preferences?.industries ?? []) {
    if (typeof label !== 'string' || !label.trim()) continue
    const known = INDUSTRIES.find((i) => i.label.toLowerCase() === label.trim().toLowerCase())
    industries.add({
      id: known?.id ?? termId(label), label: known?.label ?? label.trim(), titleVariants: [],
      why: ['stated in your mission’s industries'], evidenceIds: [], confidence: 0.9, source: 'mission',
    })
  }

  // Terms the bank itself supplies. Change a skill row and these change.
  for (const s of collected.skillTerms) {
    const bag = s.isTool ? toolTerms : skillTerms
    bag.add(termEntry(termId(s.name), s.name, 0.7, [`skill “${short(s.name)}” in your Evidence Bank`], 'evidence', [s.id]))
  }

  // The table is a map, not the territory. When nothing in it fires — a nurse,
  // a paralegal, a marketer — the person's OWN titles become the families, so
  // the query planner always has something to search. Recall never depends on
  // whether we happened to write their discipline down.
  let roleFamilies = families.list(minConfidence, input.options?.maxRoleFamilies)
  const usedTitleFallback = roleFamilies.length === 0 && collected.titles.length > 0
  if (usedTitleFallback) {
    const bag = new EntryBag()
    for (const t of collected.titles) {
      const label = cleanTitle(t.title)
      if (!label) continue
      const variants = [...new Set([label, t.title].map((v) => v.trim()).filter(Boolean))]
      bag.add({
        id: termId(label), label, titleVariants: variants,
        why: [`your title at ${t.organization}`], evidenceIds: [t.id],
        confidence: TITLE_FALLBACK_CONFIDENCE, source: 'evidence',
      })
    }
    roleFamilies = bag.list(minConfidence, input.options?.maxRoleFamilies)
  }
  // Function terms describe what the work IS, and follow the families that survived.
  for (const f of roleFamilies) {
    for (const term of roleFamily(f.id)?.functionTerms ?? []) {
      functionTerms.add(termEntry(termId(term), term, f.confidence, [`from role family ${f.label}`], f.source, f.evidenceIds))
    }
  }

  const st = collected.stats
  return {
    version: ONTOLOGY_VERSION,
    roleFamilies,
    industries: industries.list(minConfidence),
    adjacentIndustries: adjacentIndustries.list(minConfidence),
    skillTerms: skillTerms.list(minConfidence, maxTerms),
    functionTerms: functionTerms.list(minConfidence, maxTerms),
    toolTerms: toolTerms.list(minConfidence, maxTerms),
    disciplines,
    combinations: combinations.sort((a, b) => b.confidence - a.confidence || a.label.localeCompare(b.label)),
    excluded: [],
    stats: {
      experiencesConsidered: st.experiences,
      factsConsidered: st.facts,
      skillsConsidered: st.skills,
      projectsConsidered: st.projects,
      preferencesConsidered: st.preferences,
      documents: collected.docs.length,
      disciplinesDetected: disciplines.length,
      roleFamilies: roleFamilies.length,
      bankEmpty: st.experiences === 0 && st.facts === 0 && st.skills === 0 && st.projects === 0,
      directionMode: collected.directionMode,
      narrowedByDirection: detection.narrowedByDirection,
      usedTitleFallback,
    },
  }
}
