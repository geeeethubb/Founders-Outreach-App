// The canonical view of an Evidence Bank — pure, offline, deterministic.
//
// Groups experiences under organizations (015 organization_id when set, else
// the normalized organization string), attaches projects, facts, metrics and
// source labels, and picks the key facts a reader sees first. No database:
// the route loads the bank and calls buildCanonicalView; the offline test
// builds a synthetic bank and calls the same function.

import type {
  EvidenceBank, EvidenceExperience, EvidenceFact, EvidenceMetric, EvidenceProject, EvidenceSource, ExperienceKind,
  MergeStatus, OrganizationKind,
} from '@/lib/career/types'
import { normalizeOrg } from '@/lib/career/evidence/normalize'
import { organizationKindFor } from '@/lib/career/evidence/consolidate-groups'
import { isFullSupport } from '@/lib/career/evidence/corroborate'
import { splitSourceLocation } from '@/lib/career/evidence/sources'
import { EVENT_ONLY_LABEL } from '@/lib/career/evidence/store'

export interface CanonicalFact {
  id: string
  statement: string
  category: string
  support_count: number
  fact_status: MergeStatus | null
  approved: boolean
  sources: string[]
}

export interface CanonicalRole {
  experience: {
    id: string
    kind: ExperienceKind
    title: string
    period: string
    merge_status: MergeStatus | null
    status: 'active' | 'merged'
    approved: boolean
    source_count: number
    canonical_summary: string | null
  }
  projects: { id: string; name: string; description: string | null; factCount: number }[]
  keyFacts: CanonicalFact[]
  allFacts: CanonicalFact[]
  metrics: { id: string; value: string; unit: string | null; context: string | null }[]
  sources: string[]
}

export interface CanonicalOrganization {
  id: string | null
  canonical_name: string
  kind: OrganizationKind
  aliases: string[]
  roles: CanonicalRole[]
}

export interface CanonicalView {
  organizations: CanonicalOrganization[]
  unattached: { facts: CanonicalFact[]; skills: number; stories: number }
}

export const KEY_FACT_COUNT = 3

/** achievement/metric first — the same order summary.ts uses. */
const CATEGORY_RANK: Record<string, number> = {
  achievement: 0, metric: 1, responsibility: 2, scope: 3, award: 4, other: 5, context: 6,
}

/** Readable names for the legacy single-source column, used only when no provenance row exists. */
const SOURCE_NAMES: Record<string, string> = {
  master_resume: 'Résumé', alternate_resume: 'Alt résumé', linkedin: 'LinkedIn', profile: 'Profile',
  manual: 'Manual', project_notes: 'Notes', story: 'Story', outreach: 'Outreach',
}

function legacyLabel(source: string, location: string | null): string {
  const split = splitSourceLocation(source, location)
  const name = SOURCE_NAMES[source] ?? source
  // "Zuyu_Resume.docx ¶6" keeps its own label; a bare "¶6" gets the source's name in front.
  if (split.location) return `${split.label === source ? name : split.label} ${split.location}`
  return split.label === source ? name : `${name} ${split.label}`
}

const isActive = (row: { status?: string | null }): boolean => (row.status ?? 'active') === 'active'

function sourceById(bank: EvidenceBank, id: string): EvidenceSource | null {
  return bank.sources.find((s) => s.id === id) ?? null
}

/**
 * Same fallback as store.sourceLabelsForFact, computed locally so the view has
 * no store dependency. An event-only row (confidence 0.5 — the source restates
 * the event without its numbers) is labelled as such.
 */
export function factSourceLabels(bank: EvidenceBank, fact: EvidenceFact): string[] {
  const labels: string[] = []
  for (const fs of bank.factSources) {
    if (fs.fact_id !== fact.id) continue
    const src = sourceById(bank, fs.source_id)
    const base = src ? `${src.label}${fs.location ? ` ${fs.location}` : ''}` : fs.location ?? ''
    const label = base && !isFullSupport(fs) ? `${base} ${EVENT_ONLY_LABEL}` : base
    if (label && !labels.includes(label)) labels.push(label)
  }
  if (labels.length === 0) labels.push(legacyLabel(fact.source, fact.source_location))
  return labels
}

function toFact(bank: EvidenceBank, f: EvidenceFact): CanonicalFact {
  return {
    id: f.id,
    statement: f.statement,
    category: f.category,
    support_count: f.support_count ?? 1,
    fact_status: f.fact_status ?? null,
    approved: f.approved,
    sources: factSourceLabels(bank, f),
  }
}

/** Category rank, then support, then age — deterministic. */
export function rankFacts(facts: CanonicalFact[], created: Map<string, string>): CanonicalFact[] {
  return [...facts].sort((a, b) => {
    const r = (CATEGORY_RANK[a.category] ?? 7) - (CATEGORY_RANK[b.category] ?? 7)
    if (r !== 0) return r
    if (a.support_count !== b.support_count) return b.support_count - a.support_count
    const ca = created.get(a.id) ?? '', cb = created.get(b.id) ?? ''
    if (ca !== cb) return ca < cb ? -1 : 1
    return a.id < b.id ? -1 : 1
  })
}

export function keyFactsFor(e: EvidenceExperience, all: CanonicalFact[], created: Map<string, string>): CanonicalFact[] {
  const ids = e.summary_fact_ids ?? []
  if (ids.length > 0) {
    const picked = ids.map((id) => all.find((f) => f.id === id)).filter((f): f is CanonicalFact => Boolean(f))
    if (picked.length > 0) return picked
  }
  return rankFacts(all, created).slice(0, KEY_FACT_COUNT)
}

function period(e: EvidenceExperience): string {
  return [e.start_date, e.end_date].filter(Boolean).join(' – ')
}

/** Experience-level provenance rows first, then the sources of its facts, then the legacy `source` column. */
function roleSources(bank: EvidenceBank, e: EvidenceExperience, facts: CanonicalFact[]): string[] {
  const out: string[] = []
  const add = (label: string) => { if (label && !out.includes(label)) out.push(label) }
  for (const es of bank.experienceSources ?? []) {
    if (es.experience_id !== e.id) continue
    const s = sourceById(bank, es.source_id)
    if (s) add(s.label)
  }
  for (const f of facts) for (const l of f.sources) add(l.replace(/\s+(¶\d+|L\d+(?:–L?\d+)?|p\.?\s?\d+)$/u, ''))
  if (out.length === 0) add(legacyLabel(e.source, null))
  return out
}

function buildRole(bank: EvidenceBank, e: EvidenceExperience, created: Map<string, string>): CanonicalRole {
  const facts = bank.facts.filter((f) => f.experience_id === e.id && isActive(f)).map((f) => toFact(bank, f))
  const metrics = bank.metrics.filter((m: EvidenceMetric) => m.experience_id === e.id && isActive(m))
  const projects = bank.projects.filter((p: EvidenceProject) => p.experience_id === e.id && isActive(p))
  return {
    experience: {
      id: e.id,
      kind: e.kind,
      title: e.title,
      period: period(e),
      merge_status: e.merge_status ?? null,
      status: isActive(e) ? 'active' : 'merged',
      approved: e.approved,
      source_count: e.source_count ?? Math.max(1, roleSources(bank, e, facts).length),
      canonical_summary: e.canonical_summary ?? null,
    },
    projects: projects.map((p) => ({ id: p.id, name: p.name, description: p.description, factCount: (p.fact_ids ?? []).length })),
    keyFacts: keyFactsFor(e, facts, created),
    allFacts: facts,
    metrics: metrics.map((m) => ({ id: m.id, value: m.value, unit: m.unit, context: m.context })),
    sources: roleSources(bank, e, facts),
  }
}

export function buildCanonicalView(bank: EvidenceBank): CanonicalView {
  const created = new Map(bank.facts.map((f) => [f.id, f.created_at]))
  const groups = new Map<string, CanonicalOrganization>()
  const members = new Map<string, EvidenceExperience[]>()
  const experiences = bank.experiences.filter(isActive).sort((a, b) => a.display_order - b.display_order)

  for (const e of experiences) {
    const org = e.organization_id ? bank.organizations.find((o) => o.id === e.organization_id) ?? null : null
    const key = org ? `id:${org.id}` : `norm:${normalizeOrg(e.organization)}`
    let g = groups.get(key)
    if (!g) {
      g = {
        id: org?.id ?? null,
        canonical_name: org?.canonical_name ?? e.organization,
        kind: org?.kind ?? 'company',
        aliases: org?.aliases ?? [],
        roles: [],
      }
      groups.set(key, g)
    }
    if (!org && e.organization !== g.canonical_name && !g.aliases.includes(e.organization)) g.aliases.push(e.organization)
    members.set(key, [...(members.get(key) ?? []), e])
    g.roles.push(buildRole(bank, e, created))
  }
  // A group without an organization row takes the heuristic kind, which
  // reads the kinds of every row under it (award-only → 'other').
  for (const [key, g] of groups) {
    if (g.id === null) g.kind = organizationKindFor(g.canonical_name, members.get(key) ?? [])
  }

  const unattachedFacts = bank.facts
    .filter((f) => isActive(f) && (f.experience_id === null || !experiences.some((e) => e.id === f.experience_id)))
    .map((f) => toFact(bank, f))

  return {
    organizations: [...groups.values()],
    unattached: {
      facts: rankFacts(unattachedFacts, created),
      skills: bank.skills.length,
      stories: bank.stories.length,
    },
  }
}
