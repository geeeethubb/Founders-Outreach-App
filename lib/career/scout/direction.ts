// The stated direction, as deterministic code.
//
// "What I'm scouting for" is the strongest strategic input the user gives, and
// three different stages need to act on it without asking a model: the
// deterministic fallback strategies (used when the planner fails), the choice
// of which postings get a fit number first, and the crude term matching that
// decides whether a posting speaks the direction's language at all.
//
// None of that is judgment — it is splitting, stemming and arithmetic — so
// none of it is an agent. Pure functions, no I/O, all testable in memory.

import type { SearchStrategy } from '@/lib/agents/job-mission-planner'
import { isInternshipLike } from '../jobs/filters'
import type { NormalizedJob } from '../jobs/normalize'
import type { CareerMission } from '../types'

const DIRECTION_STOP = new Set(['into', 'with', 'where', 'that', 'this', 'from', 'also', 'open', 'very', 'internship', 'internships', 'intern', 'summer', 'role', 'roles', 'experience', 'transfers', 'transferable', 'engineer', 'engineering'])

const DIRECTION_FILLER = /\b(?:i(?:'d| would)? (?:want|like|love|hope|plan|intend|am looking|'m looking) to|i want|i'd like|i would like|i am|i'm|pivot(?:ing)? (?:in)?to|move (?:in)?to|transition(?:ing)? (?:in)?to|break(?:ing)? into|go into|get into|looking for|interested in|something in|ideally|maybe|also open to|open to|my|me|as a)\b/gi
const MAX_DIRECTION_PHRASES = 4

/**
 * The direction's key phrases, deterministically: split on commas, slashes,
 * semicolons, " and " / " or ", drop filler ("pivot into", "I want"), keep the
 * first four. Used by the fallback strategy; no judgment, so no agent.
 */
export function directionPhrases(direction: string | null | undefined): string[] {
  if (!direction) return []
  const out: string[] = []
  for (const part of direction.split(/[,;\/\n]|\s+(?:and|or)\s+|\s+[—–-]\s+/i)) {
    // A pivot statement often ends in a clause about the person ("— as a chemical
    // engineer my experience transfers"); keep the target, not the credential.
    const head = part.split(/\b(?:because|since|as a|as an|given|with my|my )\b/i)[0]
    const phrase = head.replace(DIRECTION_FILLER, ' ').replace(/[^\w\s&+'.-]/g, ' ').replace(/\s+/g, ' ').trim()
    // Two-letter acronyms people actually write as a direction (AI, ML, EV, VR)
    // are kept; two-letter lowercase fragments are filler residue.
    const minLength = /^[A-Z][A-Z0-9]$/.test(phrase) ? 2 : 3
    if (phrase.length < minLength || phrase.split(' ').length > 6) continue
    if (!out.some((p) => p.toLowerCase() === phrase.toLowerCase())) out.push(phrase)
    if (out.length >= MAX_DIRECTION_PHRASES) break
  }
  return out
}

/**
 * Content words of the stated direction, stemmed crudely (trailing s/es/ing
 * dropped), so "genomics research" matches "Genomic", "researcher". Empty when
 * there is no direction.
 */
export function directionTerms(direction: string | null | undefined): Set<string> {
  const out = new Set<string>()
  for (const phrase of directionPhrases(direction)) {
    for (const w of phrase.toLowerCase().split(/[^a-z0-9+]+/)) {
      if (w.length < 4 || DIRECTION_STOP.has(w)) continue
      out.add(w.replace(/(ing|ies|es|s)$/, (m) => (m === 'ies' ? 'y' : '')))
    }
  }
  return out
}

/** How many direction terms the posting's title, company or description carries (0 when no direction). */
export function directionMatches(job: Pick<NormalizedJob, 'title' | 'company_name' | 'description_text'>, terms: Set<string>): number {
  if (terms.size === 0) return 0
  const hay = `${job.title} ${job.company_name} ${(job.description_text ?? '').slice(0, 1_500)}`.toLowerCase()
  let n = 0
  for (const t of terms) if (hay.includes(t)) n++
  return n
}

export function rankCandidatePriority(job: NormalizedJob, terms: Set<string> = new Set()): number {
  const tier = job.location_tier ?? 4
  // A posting that speaks the direction's language outranks an explicit
  // Summer 2027 posting in the old industry (300 > 100), but never an
  // unextracted or unverified one.
  const direction = Math.min(directionMatches(job, terms), 2) * 300
  return (
    (job.extraction_version ? 10_000 : 0) +
    (job.verification_status === 'VERIFIED_OPEN' ? 1_000 : 0) +
    direction +
    (job.season_relevance === 'summer_2027' ? 100 : 0) +
    (4 - tier) * 10 +
    (isInternshipLike(job) ? 1 : 0)
  )
}

/**
 * Which of this run's stored jobs get a fit number first, best first. Store
 * order is arrival order — whichever board answered first — and a large run
 * left the mission-targeted rows past the cap. Deterministic preference:
 * extracted this run (a thin heuristic row is a weaker candidate for the
 * evaluator), then confirmed open, then direction-relevant, then the target
 * season, then the closest tier (unknown last), then an internship-shaped
 * title. Ties keep store order, so the choice is stable across runs.
 *
 * Falls back to store order when ids and jobs do not line up (a partial upsert).
 */
export function selectJobsToRank(jobs: NormalizedJob[], ids: string[], max: number, direction: string | null | undefined = null): string[] {
  if (ids.length !== jobs.length) return ids.slice(0, max)
  const terms = directionTerms(direction)
  return jobs
    .map((job, i) => ({ id: ids[i], i, priority: rankCandidatePriority(job, terms) }))
    .sort((a, b) => b.priority - a.priority || a.i - b.i)
    .slice(0, max)
    .map((x) => x.id)
}

/**
 * Strategies built from the mission alone, used only when the planner fails.
 * Three surfaces at most: the stated direction (first, when there is one), the
 * keyless ATS boards (where a first-party posting is one hop away) and the
 * mission's own company types. No role inference — that is the planner's
 * judgment, and this is the deterministic floor beneath it.
 */
export function fallbackStrategies(mission: Pick<CareerMission, 'preferences' | 'season'>): SearchStrategy[] {
  const season = mission.season === 'summer_2027' ? 'Summer 2027' : mission.season.replace(/_/g, ' ')
  const tier1 = mission.preferences.geo_tiers.find((t) => t.tier === 1)?.locations ?? []
  const geo = tier1.length ? tier1 : ['United States']
  const types = mission.preferences.company_types.slice(0, 3)
  const phrases = directionPhrases(mission.preferences.direction)
  const direction: SearchStrategy | null = phrases.length
    ? {
        name: 'fallback · stated direction',
        kind: 'job_first',
        rationale: 'deterministic fallback — the mission planner failed; queries built from the stated direction',
        queries: phrases.flatMap((p, i) => [`${p} "${season}" internship`, `${p} intern "${season}" site:${['job-boards.greenhouse.io', 'jobs.lever.co', 'jobs.ashbyhq.com'][i % 3]}`]),
        target_titles: phrases.map((p) => `${p} Intern`),
        geo_focus: geo,
        priority: 0.6,
      }
    : null
  const boards: SearchStrategy = {
    name: 'fallback · public ATS boards',
    kind: 'job_first',
    rationale: 'deterministic fallback — the mission planner failed',
    queries: [
      `"${season}" internship site:job-boards.greenhouse.io`,
      `"${season}" intern site:jobs.lever.co`,
      `"${season}" internship site:jobs.ashbyhq.com`,
      `"${season}" engineering intern ${geo[0]}`,
    ],
    target_titles: ['Process Engineering Intern', 'Manufacturing Engineering Intern', 'Engineering Intern', 'Strategy Intern'],
    geo_focus: geo,
    priority: 0.5,
  }
  const byType: SearchStrategy = {
    name: 'fallback · mission company types',
    kind: 'job_first',
    rationale: 'deterministic fallback — the mission planner failed',
    queries: types.length
      ? types.map((t) => `${t} "${season}" internship ${geo[0]}`)
      : [`"${season}" internship ${geo[0]}`, `"${season}" intern ${geo[geo.length - 1]}`],
    target_titles: ['Intern'],
    geo_focus: geo,
    priority: 0.4,
  }
  return direction ? [direction, boards, byType] : [boards, byType]
}
