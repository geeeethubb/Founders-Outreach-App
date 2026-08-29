// Deterministic evidence retrieval for a job.
//
// Principle 5: never dump the résumé. Before any agent sees the bank, code
// picks a SHORTLIST — which experiences, facts and skills plausibly matter for
// this posting — by token overlap with light stemming and a small domain
// synonym map. Pure: no I/O, no model, reproducible to the decimal.
//
// Every experience is returned, the irrelevant ones at the tail with score 0.
// An experience that retrieval cannot see is an experience the matcher can
// never choose, and "why did it ignore my research?" must be answerable by
// reading a number, not by guessing.

import { renderExperienceDetail } from './render'
import type { EvidenceBank, EvidenceFact, EvidenceSkill, EvidenceStory } from '../types'

export interface RetrievalJob {
  title: string
  skills?: string[]
  responsibilities?: string[]
  min_qualifications?: string[]
  preferred_qualifications?: string[]
  industry?: string | null
  description_text?: string | null
}

export interface RetrievedExperience {
  experience_id: string
  score: number
  matched_terms: string[]
}

export interface RetrievedFact {
  fact_id: string
  experience_id: string | null
  score: number
  matched_terms: string[]
}

export interface RetrievedSkill {
  skill_id: string
  name: string
  score: number
  matched_terms: string[]
}

export interface RetrievedStory {
  story_id: string
  score: number
  matched_terms: string[]
}

export interface EvidenceRetrieval {
  experiences: RetrievedExperience[]
  facts: RetrievedFact[]
  skills: RetrievedSkill[]
  stories: RetrievedStory[]
  /** The weighted query terms, for the trace. */
  query: { term: string; weight: number }[]
}

// ─── Vocabulary ──────────────────────────────────────────────────────────────

/**
 * Each group is a family; a query term in a family matches evidence carrying
 * any member. Curated for this domain, deliberately small — a synonym map that
 * grows by accretion becomes a way for everything to match everything.
 */
const SYNONYM_GROUPS: string[][] = [
  ['manufacturing', 'plant', 'production', 'operations', 'site', 'factory', 'line'],
  ['ai', 'machine learning', 'ml', 'agentic', 'llm', 'agent', 'automation', 'workflow'],
  ['process', 'chemical', 'cheme', 'engineering', 'formulation'],
  ['consulting', 'strategy', 'm&a', 'acquisition', 'screening', 'due diligence', 'advisory'],
  ['sustainability', 'lca', 'climate', 'life-cycle', 'carbon', 'clean-energy', 'cleantech'],
  ['supply chain', 'logistics', 'sourcing', 'feedstock', 'procurement'],
  ['quality', 'validation', 'sop', 'qa', 'risk assessment', 'controls', 'compliance'],
  ['catalysis', 'dft', 'computational', 'vasp', 'ase', 'simulation', 'modeling'],
  ['energy', 'hydrogen', 'fuel cell', 'solar', 'biofuel', 'electrode'],
  ['startup', 'entrepreneurship', 'founder', 'founding', 'venture'],
  ['leadership', 'led', 'lead', 'president', 'organized', 'coordinated', 'stakeholders'],
  ['data', 'analysis', 'analytics', 'techno-economic', 'economic', 'feasibility'],
  ['research', 'researcher', 'laboratory', 'lab'],
  ['product', 'platform', 'software', 'built', 'created'],
]

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'you', 'your', 'our', 'are', 'will', 'this', 'that', 'from', 'have', 'has',
  'not', 'but', 'all', 'any', 'can', 'may', 'who', 'what', 'into', 'over', 'per', 'via', 'about', 'across',
  'intern', 'internship', 'role', 'team', 'work', 'working', 'experience', 'ability', 'strong', 'skills',
  'skill', 'required', 'preferred', 'must', 'should', 'able', 'etc', 'including', 'such', 'other', 'well',
  'more', 'than', 'years', 'year', 'student', 'students', 'degree', 'bachelor', 'pursuing', 'currently',
  'summer', 'position', 'candidate', 'candidates', 'plus', 'also', 'within', 'their', 'they', 'them',
  'while', 'through', 'using', 'used', 'use', 'new', 'one', 'two', 'three', 'each', 'both',
])

/** Lower-case, strip punctuation, drop plurals and common verb endings. */
export function stem(word: string): string {
  let w = word.toLowerCase().replace(/[^a-z0-9&+#-]/g, '')
  if (w.length <= 3) return w
  if (w.endsWith('ies') && w.length > 4) w = `${w.slice(0, -3)}y`
  else if (w.endsWith('ing') && w.length > 5) w = w.slice(0, -3)
  else if (w.endsWith('ed') && w.length > 4) w = w.slice(0, -2)
  else if (w.endsWith('es') && w.length > 4 && !w.endsWith('ses')) w = w.slice(0, -2)
  else if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) w = w.slice(0, -1)
  return w
}

const FAMILY_OF = new Map<string, number>()
SYNONYM_GROUPS.forEach((group, i) => {
  for (const term of group) FAMILY_OF.set(stem(term), i)
  // Multi-word members are also registered as phrases so "supply chain" in a
  // JD reaches the family even though tokenization splits it.
  for (const term of group) FAMILY_OF.set(term.toLowerCase(), i)
})

/** Unigrams (stemmed) plus the multi-word synonym phrases present in the text. */
export function terms(text: string): string[] {
  const lower = text.toLowerCase()
  const out: string[] = []
  for (const raw of lower.split(/[^a-z0-9&+#-]+/)) {
    const s = stem(raw)
    if (s.length < 2 || STOPWORDS.has(raw) || STOPWORDS.has(s) || /^\d+$/.test(s)) continue
    out.push(s)
  }
  for (const group of SYNONYM_GROUPS) {
    for (const term of group) if (term.includes(' ') && lower.includes(term)) out.push(term)
  }
  return out
}

/** Synonym family index for a stemmed term, or null. Shared with retrieval.ts. */
export function familyOf(term: string): number | null {
  return FAMILY_OF.get(term) ?? null
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

export interface Weighted {
  term: string
  weight: number
}

/** Skill and qualification terms weigh more than description prose. */
export function buildQuery(job: RetrievalJob): Weighted[] {
  const weights = new Map<string, number>()
  const add = (text: string | null | undefined, w: number) => {
    if (!text) return
    for (const t of new Set(terms(text))) weights.set(t, Math.max(weights.get(t) ?? 0, w))
  }
  add(job.title, 3)
  for (const s of job.skills ?? []) add(s, 3)
  for (const q of job.min_qualifications ?? []) add(q, 2.5)
  for (const q of job.preferred_qualifications ?? []) add(q, 2)
  for (const r of job.responsibilities ?? []) add(r, 1.5)
  add(job.industry, 2)
  add(job.description_text, 1)
  return [...weights.entries()].map(([term, weight]) => ({ term, weight }))
}

/**
 * Score one evidence text against the query: exact stem hits at full weight,
 * family hits at half. Normalized by log length so a long description does
 * not outrank a short, precise fact just by containing more words.
 */
export function scoreText(text: string, query: Weighted[]): { score: number; matched: string[] } {
  const present = new Set(terms(text))
  const families = new Set<number>()
  for (const t of present) {
    const f = familyOf(t)
    if (f !== null) families.add(f)
  }
  let score = 0
  const matched: string[] = []
  for (const q of query) {
    if (present.has(q.term)) {
      score += q.weight
      matched.push(q.term)
      continue
    }
    const f = familyOf(q.term)
    if (f !== null && families.has(f)) {
      score += q.weight * 0.5
      matched.push(`~${q.term}`)
    }
  }
  const norm = Math.log2(8 + present.size)
  return { score: score / norm, matched }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

export function retrieveEvidenceForJob(bank: EvidenceBank, job: RetrievalJob): EvidenceRetrieval {
  const query = buildQuery(job)

  // Facts and skills first; an experience's score is its own text plus the
  // best of what hangs off it, so a thin identity line with strong facts wins.
  const factScores = new Map<string, { score: number; matched: string[] }>()
  const facts: RetrievedFact[] = bank.facts.map((f: EvidenceFact) => {
    const r = scoreText(f.statement, query)
    factScores.set(f.id, r)
    return { fact_id: f.id, experience_id: f.experience_id, score: round(r.score), matched_terms: r.matched }
  })

  const skills: RetrievedSkill[] = bank.skills.map((s: EvidenceSkill) => {
    const r = scoreText(s.name, query)
    return { skill_id: s.id, name: s.name, score: round(r.score), matched_terms: r.matched }
  })

  const stories: RetrievedStory[] = bank.stories.map((s: EvidenceStory) => {
    const r = scoreText([s.title, s.situation, s.task, s.actions, s.result, s.learning].filter(Boolean).join(' '), query)
    return { story_id: s.id, score: round(r.score), matched_terms: r.matched }
  })

  const experiences: RetrievedExperience[] = bank.experiences.map((e) => {
    const own = scoreText([e.title, e.organization, e.description ?? ''].join(' '), query)
    const bulletText = bank.bullets.filter((b) => b.experience_id === e.id).map((b) => b.text).join(' ')
    const bullets = bulletText ? scoreText(bulletText, query) : { score: 0, matched: [] }
    const ownFacts = bank.facts.filter((f) => f.experience_id === e.id)
    const factHits = ownFacts.map((f) => factScores.get(f.id)!).sort((a, b) => b.score - a.score)
    const topFacts = factHits.slice(0, 3)
    const factScore = topFacts.reduce((n, r) => n + r.score, 0)
    const matched = new Set<string>([...own.matched, ...bullets.matched, ...topFacts.flatMap((r) => r.matched)])
    return {
      experience_id: e.id,
      score: round(own.score + bullets.score + factScore),
      matched_terms: [...matched],
    }
  })

  const byScore = <T extends { score: number }>(rows: T[]) => rows.sort((a, b) => b.score - a.score)

  return {
    experiences: byScore(experiences),
    facts: byScore(facts.filter((f) => f.score > 0)),
    skills: byScore(skills.filter((s) => s.score > 0)),
    stories: byScore(stories.filter((s) => s.score > 0)),
    query,
  }
}

/** Full detail for the top N experiences, in retrieval order. What the matcher and tailor read. */
export function renderRetrievedDetail(
  bank: EvidenceBank,
  retrieval: EvidenceRetrieval,
  opts: { maxExperiences?: number } = {}
): string {
  const max = opts.maxExperiences ?? 3
  return retrieval.experiences
    .slice(0, max)
    .map((r) => renderExperienceDetail(bank, r.experience_id))
    .filter(Boolean)
    .join('\n\n')
}
