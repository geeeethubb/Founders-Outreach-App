// Two renderings of one ontology. Pure.
//
//   renderOntologyForPrompt  compact prose for the query planner's prompt —
//                            what to search for, how confident, and what the
//                            user has muted or excluded.
//   ontologyQueryTerms       the deterministic term list a query planner
//                            expands into searches. No model involved: same
//                            ontology in, byte-identical list out.
//
// Nothing here re-derives anything. Both read a built (and, where the caller
// wants it, override-applied) ontology.

import type { OntologyEntry, OntologyKind, SearchOntology } from './types'

// ─── Prompt ──────────────────────────────────────────────────────────────────

export interface RenderOntologyOptions {
  /** Entries per list. Default 14. */
  maxPerList?: number
  /** Title variants shown per role family. Default 5. */
  maxVariants?: number
  /** Include the one-line justification under each role family. Default false — the planner needs the terms, not the argument. */
  includeWhy?: boolean
}

export const EMPTY_ONTOLOGY_LINE = 'SEARCH ONTOLOGY: (empty — nothing in the Evidence Bank or the mission to derive from)'

function pct(entry: OntologyEntry): string {
  return entry.confidence.toFixed(2)
}

function line(label: string, entries: OntologyEntry[], max: number): string | null {
  if (!entries.length) return null
  return `${label}: ${entries.slice(0, max).map((e) => `${e.label} [${pct(e)}]${e.override === 'mute' ? ' (muted)' : ''}`).join('; ')}`
}

export function renderOntologyForPrompt(ontology: SearchOntology, opts: RenderOntologyOptions = {}): string {
  const max = opts.maxPerList ?? 14
  const maxVariants = opts.maxVariants ?? 5
  const lists = [ontology.roleFamilies, ontology.industries, ontology.adjacentIndustries, ontology.skillTerms, ontology.functionTerms, ontology.toolTerms]
  if (lists.every((l) => l.length === 0)) return EMPTY_ONTOLOGY_LINE

  const out: string[] = [
    `SEARCH ONTOLOGY v${ontology.version} — derived from the Evidence Bank and the mission. Search WIDELY across these; a posting need not resemble a previous title to be worth finding.`,
  ]
  if (ontology.stats.directionMode === 'exclusive') {
    out.push(
      `DIRECTION — ONLY THIS: the user restricted the search to what their direction names.` +
      (ontology.stats.narrowedByDirection > 0
        ? ` ${ontology.stats.narrowedByDirection} discipline(s) the Evidence Bank attests were dropped as out of scope.`
        : '')
    )
  }
  if (ontology.stats.usedTitleFallback) {
    out.push('NOTE: no discipline in the ontology table matched this bank, so the role families below are the user’s own job titles. Search widely around them.')
  }
  if (ontology.disciplines.length) {
    out.push(`DISCIPLINES ATTESTED: ${ontology.disciplines.slice(0, max).map((d) => `${d.label} [${d.confidence.toFixed(2)}]`).join('; ')}`)
  }
  if (ontology.combinations.length) {
    out.push(`COMBINATIONS: ${ontology.combinations.slice(0, max).map((c) => `${c.label} [${c.confidence.toFixed(2)}]`).join('; ')}`)
  }
  if (ontology.roleFamilies.length) {
    out.push('ROLE FAMILIES (search these titles):')
    for (const f of ontology.roleFamilies.slice(0, max)) {
      const variants = f.titleVariants.slice(0, maxVariants).join(', ')
      const flag = f.override === 'mute' ? ' (muted — search last)' : f.override === 'boost' ? ' (boosted by the user)' : ''
      out.push(`- ${f.label} [${pct(f)}]${flag}${variants ? ` — ${variants}` : ''}`)
      if (opts.includeWhy && f.why.length) out.push(`  why: ${f.why.slice(0, 2).join(' | ')}`)
    }
  }
  for (const [label, entries] of [
    ['INDUSTRIES', ontology.industries],
    ['ADJACENT INDUSTRIES', ontology.adjacentIndustries],
    ['FUNCTIONS', ontology.functionTerms],
    ['SKILLS', ontology.skillTerms],
    ['TOOLS', ontology.toolTerms],
  ] as const) {
    const l = line(label, entries, max)
    if (l) out.push(l)
  }
  if (ontology.excluded.length) {
    out.push(`EXCLUDED BY THE USER (never search): ${ontology.excluded.map((e) => e.label).join('; ')}`)
  }
  return out.join('\n')
}

// ─── Query terms ─────────────────────────────────────────────────────────────

/** How much each list contributes to a term's weight. Role-family titles are what a job board is actually searched with. */
const KIND_WEIGHT: Record<OntologyKind, number> = {
  roleFamily: 1,
  industry: 0.8,
  adjacentIndustry: 0.6,
  functionTerm: 0.5,
  skillTerm: 0.45,
  toolTerm: 0.4,
}

/** The label of a role family is a search term too, just below its concrete titles. */
const LABEL_FACTOR = 0.95

export interface WeightedQueryTerm {
  term: string
  weight: number
  kind: OntologyKind
  /** The entry id the term came from, so a run can say which family produced a query. */
  from: string
}

export interface QueryTermOptions {
  /** Cap on returned terms. Default 60; pass 0 for all of them. */
  limit?: number
  /** Which lists to draw from. Default: every list. */
  kinds?: OntologyKind[]
  /** Also emit "<title> Intern" / "<title> Internship" forms. Default false — the planner owns season wording. */
  expandIntern?: boolean
  /** Drop entries the user muted. Default false: muted entries stay, at their reduced weight. */
  dropMuted?: boolean
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

/** Every term with its weight and provenance. Deterministic: weight desc, then term asc. */
export function ontologyWeightedTerms(ontology: SearchOntology, opts: QueryTermOptions = {}): WeightedQueryTerm[] {
  const kinds = opts.kinds ?? (Object.keys(KIND_WEIGHT) as OntologyKind[])
  const wanted = new Set(kinds)
  const best = new Map<string, WeightedQueryTerm>()

  const push = (term: string, weight: number, kind: OntologyKind, from: string) => {
    const clean = term.replace(/\s+/g, ' ').trim()
    if (!clean) return
    const key = clean.toLowerCase()
    const existing = best.get(key)
    if (existing && existing.weight >= weight) return
    best.set(key, { term: existing?.term ?? clean, weight: round(weight), kind, from })
  }

  const lists: [OntologyKind, OntologyEntry[]][] = [
    ['roleFamily', ontology.roleFamilies],
    ['industry', ontology.industries],
    ['adjacentIndustry', ontology.adjacentIndustries],
    ['functionTerm', ontology.functionTerms],
    ['skillTerm', ontology.skillTerms],
    ['toolTerm', ontology.toolTerms],
  ]
  for (const [kind, entries] of lists) {
    if (!wanted.has(kind)) continue
    for (const e of entries) {
      if (opts.dropMuted && e.override === 'mute') continue
      const base = e.confidence * KIND_WEIGHT[kind]
      for (const v of e.titleVariants) {
        push(v, base, kind, e.id)
        if (opts.expandIntern) {
          push(`${v} Intern`, base * 0.9, kind, e.id)
          push(`${v} Internship`, base * 0.85, kind, e.id)
        }
      }
      push(e.label, base * (e.titleVariants.length ? LABEL_FACTOR : 1), kind, e.id)
    }
  }

  return [...best.values()].sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term))
}

/**
 * The term list a query planner expands into searches. Deliberately plain
 * strings: the planner decides how to combine them with a season, a location
 * or a source's own syntax.
 */
export function ontologyQueryTerms(ontology: SearchOntology, opts: QueryTermOptions = {}): string[] {
  const limit = opts.limit ?? 60
  const terms = ontologyWeightedTerms(ontology, opts).map((t) => t.term)
  return limit > 0 ? terms.slice(0, limit) : terms
}
