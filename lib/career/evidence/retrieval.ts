// The retrieval layer: "what about this user is relevant to X?"
//
// One synchronous, pure function over a loaded EvidenceBank. Deterministic
// lexical scoring (retrieve.ts terms/stem/synonym families — imported, never
// duplicated) over canonical rows, returning a bounded, ranked slice with
// provenance and confidence attached. Principle 5: never the whole bank.
//
// Rules that hold no matter what the caller asks for:
//   * unapproved rows are never returned
//   * tombstones (status = 'merged') are never returned, and are counted
//   * a generic or empty query still returns the strongest items (ranked by
//     credibility) — an empty result from a non-empty bank is a bug
//   * ties break in a stable order (numbers/metrics first, then display_order,
//     then id), so two runs over the same bank render byte-identical prompts
//
// Works on a 014-only bank: the 015 fields are optional and default to their
// pre-015 meaning (status active, support_count 1, no source records).

import type { Weighted } from './retrieve'
import { buildDocFreq, buildRetrievalQuery, scoreDoc, type DocFreq } from './retrieval-score'
import type {
  RelevantEvidence, RelevantExperience, RelevantFact, RetrievalInput,
} from './retrieval-types'
import type {
  EvidenceBank, EvidenceExperience, EvidenceFact, EvidenceMetric, EvidenceProject, EvidenceSkill, EvidenceStory,
  FactCategory,
} from '../types'

export type { RelevantEvidence, RelevantExperience, RelevantFact, RetrievalInput, RetrievalTarget } from './retrieval-types'
export { renderRelevantEvidence, toBackgroundItems } from './retrieval-render'
export { buildRetrievalQuery } from './retrieval-score'

export const DEFAULT_MAX_EXPERIENCES = 4
export const DEFAULT_MAX_FACTS = 8

// ─── Row liveness ────────────────────────────────────────────────────────────

/** Approved and not a tombstone. Both checks are done here even when the loader already filtered. */
export function isLiveRow(row: { approved?: boolean; status?: string | null }): boolean {
  return row.approved !== false && row.status !== 'merged'
}

function isTombstone(row: { status?: string | null }): boolean {
  return row.status === 'merged'
}

export function hasNumber(text: string): boolean {
  return /\d/.test(text)
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

/** Achievements and metrics are what a reader remembers; context is scaffolding. */
export function categoryWeight(category: FactCategory): number {
  switch (category) {
    case 'achievement':
    case 'metric': return 1
    case 'responsibility':
    case 'scope': return 0.85
    case 'award': return 0.8
    case 'skill':
    case 'tool': return 0.7
    default: return 0.6 // context, education, other
  }
}

const SUPPORT_BONUS = 0.15
const METRIC_BONUS = 0.1

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

interface ScoredFact {
  fact: EvidenceFact
  score: number
  reasons: string[]
  hasMetric: boolean
  supportCount: number
  displayOrder: number
}

function scoreFact(fact: EvidenceFact, query: Weighted[], df: DocFreq, hasMetric: boolean, displayOrder: number): ScoredFact {
  const r = scoreDoc(fact.statement, query, df)
  const reasons: string[] = []
  const exact = r.matched.filter((m) => !m.startsWith('~'))
  const family = r.matched.filter((m) => m.startsWith('~')).map((m) => m.slice(1))
  if (exact.length) reasons.push(`matches ${exact.slice(0, 4).join(', ')}`)
  if (family.length) reasons.push(`related to ${family.slice(0, 3).join(', ')}`)
  let score = r.score * categoryWeight(fact.category)
  const supportCount = fact.support_count ?? 1
  if (supportCount >= 2) { score += SUPPORT_BONUS; reasons.push(`${supportCount} sources agree`) }
  if (hasMetric || fact.category === 'metric') { score += METRIC_BONUS; reasons.push('quantified') }
  return { fact, score: round(score), reasons, hasMetric: hasMetric || fact.category === 'metric', supportCount, displayOrder }
}

/** Stable order: score, then quantified, then corroborated, then the bank's own order, then id. */
function compareFacts(a: ScoredFact, b: ScoredFact): number {
  return (
    b.score - a.score ||
    Number(b.hasMetric || hasNumber(b.fact.statement)) - Number(a.hasMetric || hasNumber(a.fact.statement)) ||
    b.supportCount - a.supportCount ||
    categoryWeight(b.fact.category) - categoryWeight(a.fact.category) ||
    a.displayOrder - b.displayOrder ||
    a.fact.created_at.localeCompare(b.fact.created_at) ||
    a.fact.id.localeCompare(b.fact.id)
  )
}

interface ScoredExperience {
  experience: EvidenceExperience
  score: number
  reasons: string[]
  facts: ScoredFact[]
  metrics: EvidenceMetric[]
  projects: EvidenceProject[]
  skills: EvidenceSkill[]
  credible: boolean
}

function compareExperiences(a: ScoredExperience, b: ScoredExperience): number {
  return (
    b.score - a.score ||
    Number(b.credible) - Number(a.credible) ||
    b.facts.length - a.facts.length ||
    a.experience.display_order - b.experience.display_order ||
    a.experience.id.localeCompare(b.experience.id)
  )
}

// ─── Provenance ──────────────────────────────────────────────────────────────

/**
 * Source labels for a fact: every evidence_fact_sources row joined to its
 * source record ("Zuyu_Resume.docx ¶6"); on a 014-only bank, the legacy
 * source_location (which already carries the label) or the source enum.
 */
export function sourceLabelsFor(bank: EvidenceBank, fact: EvidenceFact): string[] {
  const labels: string[] = []
  const sources = new Map((bank.sources ?? []).map((s) => [s.id, s]))
  for (const fs of bank.factSources ?? []) {
    if (fs.fact_id !== fact.id) continue
    const src = sources.get(fs.source_id)
    if (!src) continue
    labels.push(fs.location ? `${src.label} ${fs.location}` : src.label)
  }
  if (labels.length === 0) labels.push(fact.source_location ?? fact.source)
  return [...new Set(labels)].sort()
}

export function formatPeriod(e: Pick<EvidenceExperience, 'start_date' | 'end_date'>): string {
  const start = (e.start_date ?? '').trim()
  const end = (e.end_date ?? '').trim()
  if (start && end) return `${start} – ${end}`
  if (start) return `${start} – present`
  return end
}

export function canonicalOrganization(bank: EvidenceBank, e: EvidenceExperience): string {
  if (e.organization_id) {
    const org = (bank.organizations ?? []).find((o) => o.id === e.organization_id)
    if (org) return org.canonical_name
  }
  return e.organization
}

const SUMMARY_CHARS = 280

export function summaryFor(e: EvidenceExperience, topFacts: EvidenceFact[]): string {
  if (e.canonical_summary?.trim()) return e.canonical_summary.trim()
  const joined = topFacts.slice(0, 2).map((f) => f.statement.trim()).join(' · ')
  const text = joined || (e.description ?? '').trim()
  return text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS - 1).trimEnd()}…` : text
}

// ─── Main ────────────────────────────────────────────────────────────────────

export function getRelevantPersonalEvidence(input: RetrievalInput): RelevantEvidence {
  const { bank } = input
  const maxExperiences = Math.max(1, input.maxExperiences ?? DEFAULT_MAX_EXPERIENCES)
  const maxFacts = Math.max(1, input.maxFacts ?? DEFAULT_MAX_FACTS)
  const includeMetrics = input.includeMetrics ?? true
  const includeSkills = input.includeSkills ?? true
  const includeStories = input.includeStories ?? false
  const query = buildRetrievalQuery(input.mission, input.target)

  const tombstonesSkipped =
    bank.experiences.filter(isTombstone).length + bank.facts.filter(isTombstone).length +
    bank.metrics.filter(isTombstone).length + (bank.projects ?? []).filter(isTombstone).length

  const experiences = bank.experiences.filter((e) => e.approved === true && !isTombstone(e))
  const liveIds = new Set(experiences.map((e) => e.id))
  const orderOf = new Map(experiences.map((e) => [e.id, e.display_order]))
  const facts = bank.facts.filter((f) => f.approved === true && !isTombstone(f) && (f.experience_id === null || liveIds.has(f.experience_id)))
  const metrics = bank.metrics.filter(isLiveRow)
  const projects = (bank.projects ?? []).filter(isLiveRow)
  const skills = bank.skills.filter(isLiveRow)
  const stories = bank.stories.filter(isLiveRow)

  const ownText = (e: EvidenceExperience) => [canonicalOrganization(bank, e), e.title, e.canonical_summary ?? '', e.description ?? ''].join(' ')
  const df = buildDocFreq([...facts.map((f) => f.statement), ...experiences.map(ownText)], query)
  const factsWithMetric = new Set(metrics.flatMap((m) => m.fact_ids))
  const scoredFacts = facts.map((f) =>
    scoreFact(f, query, df, factsWithMetric.has(f.id), f.experience_id ? (orderOf.get(f.experience_id) ?? 1e9) : 1e9)
  )
  const factsByExperience = new Map<string, ScoredFact[]>()
  for (const sf of scoredFacts) {
    if (!sf.fact.experience_id) continue
    const list = factsByExperience.get(sf.fact.experience_id) ?? []
    list.push(sf)
    factsByExperience.set(sf.fact.experience_id, list)
  }
  for (const list of factsByExperience.values()) list.sort(compareFacts)

  const skillsByFact = new Map<string, EvidenceSkill[]>()
  for (const s of skills) for (const fid of s.evidence_fact_ids) skillsByFact.set(fid, [...(skillsByFact.get(fid) ?? []), s])

  const scoredExperiences: ScoredExperience[] = experiences.map((e) => {
    const own = scoreDoc(ownText(e), query, df)
    const ownFacts = factsByExperience.get(e.id) ?? []
    const top3 = ownFacts.slice(0, 3)
    const factScore = top3.reduce((n, f) => n + f.score, 0)
    const expMetrics = metrics.filter((m) => m.experience_id === e.id)
    const expProjects = projects.filter((p) => p.experience_id === e.id)
    const linkedSkills = [...new Map(ownFacts.flatMap((f) => skillsByFact.get(f.fact.id) ?? []).map((s) => [s.id, s])).values()]
      .sort((a, b) => a.name.localeCompare(b.name))
    const skillScores = linkedSkills.map((s) => scoreDoc(s.name, query, df).score).sort((a, b) => b - a).slice(0, 2)
    const projectScore = expProjects.map((p) => scoreDoc(`${p.name} ${p.description ?? ''}`, query, df).score).sort((a, b) => b - a)[0] ?? 0
    let score = own.score + factScore + skillScores.reduce((n, x) => n + x * 0.5, 0) + projectScore * 0.5
    const reasons: string[] = []
    const exact = own.matched.filter((m) => !m.startsWith('~'))
    if (exact.length) reasons.push(`role matches ${exact.slice(0, 4).join(', ')}`)
    if (top3.some((f) => f.score > 0)) reasons.push(`${top3.filter((f) => f.score > 0).length} relevant fact(s)`)
    if (expMetrics.length) { score += METRIC_BONUS; reasons.push(`${expMetrics.length} metric(s)`) }
    if (ownFacts.some((f) => f.supportCount >= 2)) { score += SUPPORT_BONUS; reasons.push('corroborated by more than one source') }
    const credible = expMetrics.length > 0 || ownFacts.some((f) => hasNumber(f.fact.statement))
    return { experience: e, score: round(score), reasons, facts: ownFacts, metrics: expMetrics, projects: expProjects, skills: linkedSkills, credible }
  })
  scoredExperiences.sort(compareExperiences)

  const chosen = scoredExperiences.slice(0, maxExperiences)
  const toRelevantFact = (sf: ScoredFact): RelevantFact => ({
    fact: sf.fact,
    score: sf.score,
    reasons: sf.reasons,
    sourceLabels: sourceLabelsFor(bank, sf.fact),
    support_count: sf.supportCount,
    status: sf.fact.fact_status ?? 'VERIFIED',
  })

  const relevantExperiences: RelevantExperience[] = chosen.map((se) => {
    const expFacts = se.facts.slice(0, maxFacts).map(toRelevantFact)
    return {
      experience: se.experience,
      organization: canonicalOrganization(bank, se.experience),
      roleTitle: se.experience.title,
      period: formatPeriod(se.experience),
      summary: summaryFor(se.experience, se.facts.map((f) => f.fact)),
      score: se.score,
      reasons: se.reasons,
      facts: expFacts,
      metrics: includeMetrics ? se.metrics : [],
      projects: se.projects,
      status: se.experience.merge_status ?? 'VERIFIED',
      sourceLabels: [...new Set(expFacts.flatMap((f) => f.sourceLabels))].sort().slice(0, 4),
    }
  })

  const flatFacts = [...scoredFacts].sort(compareFacts).slice(0, maxFacts).map(toRelevantFact)

  const chosenIds = new Set(chosen.map((se) => se.experience.id))
  const chosenFactIds = new Set(chosen.flatMap((se) => se.facts.map((f) => f.fact.id)))
  const relevantSkills: EvidenceSkill[] = includeSkills
    ? skills
        .map((s) => ({ s, score: scoreDoc(s.name, query, df).score, linked: s.evidence_fact_ids.some((id) => chosenFactIds.has(id)) }))
        .filter((x) => x.score > 0 || x.linked)
        .sort((a, b) => b.score - a.score || Number(b.linked) - Number(a.linked) || a.s.name.localeCompare(b.s.name))
        .slice(0, 12)
        .map((x) => x.s)
    : []
  const relevantStories: EvidenceStory[] = includeStories
    ? stories
        .map((st) => ({ st, score: scoreDoc([st.title, st.situation, st.task, st.actions, st.result, st.learning].filter(Boolean).join(' '), query, df).score }))
        .filter((x) => x.score > 0 || (x.st.experience_id !== null && chosenIds.has(x.st.experience_id)))
        .sort((a, b) => b.score - a.score || a.st.title.localeCompare(b.st.title))
        .slice(0, 4)
        .map((x) => x.st)
    : []

  return {
    experiences: relevantExperiences,
    facts: flatFacts,
    skills: relevantSkills,
    stories: relevantStories,
    query: query.map((q) => q.term),
    stats: {
      experiencesConsidered: experiences.length,
      factsConsidered: facts.length,
      experiencesReturned: relevantExperiences.length,
      factsReturned: flatFacts.length,
      tombstonesSkipped,
    },
  }
}
