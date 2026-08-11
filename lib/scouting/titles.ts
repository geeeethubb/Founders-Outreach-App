// Title pattern normalization — DETERMINISTIC.
//
// Apollo's `person_titles` is a phrase match against real job titles, not a
// semantic search. A model asked for "job titles" will happily emit descriptive
// prose — "Head of Product - Manufacturing/Process Industries", "Founder/CTO
// (early-stage industrial AI startup)" — and every one of those returns zero
// rows. A smoke run lost all 3 companies to exactly this.
//
// Fixing it in the prompt alone is unverifiable: the model complies for a while
// and then drifts. So the prompt asks for real titles AND this runs afterwards,
// which makes the guarantee structural.

/** Qualifier separators. Everything after the first one is scope, not title. */
const QUALIFIER_SPLIT = /,| - | – | — |:|\|/

/** Alternatives within one string: "Founder/CTO", "VP or Head of Data". */
const ALTERNATIVE_SPLIT = /\/| or /i

/** Longer than this and it is a description, not a title Apollo will match. */
const MAX_WORDS = 5

/**
 * Turn one model-supplied string into zero or more Apollo-usable title phrases.
 *
 *   "Founder/CTO (early-stage industrial AI startup)" -> ["Founder", "CTO"]
 *   "Head of Product - Manufacturing/Process Industries" -> ["Head of Product"]
 *   "Solutions Engineering Manager, Process Industries" -> ["Solutions Engineering Manager"]
 *   "Director of Applied AI" -> ["Director of Applied AI"]
 */
export function normalizeTitlePattern(raw: string): string[] {
  if (!raw) return []

  // Parentheticals are always commentary about the company, never the title.
  let t = raw.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()
  if (!t) return []

  // Keep only the head of the phrase: the part before any scope qualifier.
  t = t.split(QUALIFIER_SPLIT)[0].trim()
  if (!t) return []

  const out: string[] = []
  for (const part of t.split(ALTERNATIVE_SPLIT)) {
    const candidate = part.trim().replace(/^(a|an|the)\s+/i, '')
    if (candidate.length < 2) continue
    if (candidate.split(/\s+/).length > MAX_WORDS) continue
    out.push(candidate)
  }
  return out
}

/** Normalize a list, dedupe case-insensitively, preserve order, and cap. */
export function normalizeTitlePatterns(raw: string[], limit = 12): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of raw) {
    for (const title of normalizeTitlePattern(entry)) {
      const key = title.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(title)
      if (out.length >= limit) return out
    }
  }
  return out
}

// ─── Archetype fallbacks ─────────────────────────────────────────────────────
// Used when a company's researched title list comes back empty or unusable.
// Not a default: a fallback. Evidence-derived titles always win.

export type CompanyArchetype =
  | 'startup'
  | 'growth'
  | 'midmarket'
  | 'enterprise'
  | 'consultancy'
  | 'research'
  | 'other'

/**
 * Who owns the relevant work at each kind of organization.
 *
 * The shape of this table IS the "appropriate seniority is not maximum
 * seniority" rule: a founder is the right target at a 12-person startup and the
 * wrong one at a 90,000-person manufacturer, where a director who owns the
 * function is both reachable and empowered.
 */
export const ARCHETYPE_TITLES: Record<CompanyArchetype, string[]> = {
  startup: ['Founder', 'Co-Founder', 'CEO', 'CTO', 'Head of Engineering', 'Head of Product', 'VP Product'],
  growth: ['CTO', 'VP Engineering', 'VP Product', 'Head of Deployment', 'Head of Solutions', 'Director of Engineering'],
  midmarket: [
    'Director of Operations', 'Director of Engineering', 'Head of Manufacturing',
    'Plant Manager', 'Director of Technology', 'VP Operations',
  ],
  enterprise: [
    'Director Digital Manufacturing', 'Director Advanced Manufacturing', 'Director of Innovation',
    'Director Process Technology', 'Head of Data Science', 'Director R&D',
    'Manager Manufacturing Technology', 'Director Operational Excellence',
  ],
  consultancy: ['Partner', 'Principal', 'Managing Director', 'Associate Partner', 'Director'],
  research: ['Principal Investigator', 'Research Director', 'Group Leader', 'Staff Scientist'],
  other: ['Director', 'Head of Engineering', 'VP Operations', 'Founder'],
}

/** Headcount-based archetype, used when research does not state one. */
export function archetypeFromSize(employees: number | null | undefined): CompanyArchetype {
  if (employees == null) return 'other'
  if (employees <= 50) return 'startup'
  if (employees <= 250) return 'growth'
  if (employees <= 2000) return 'midmarket'
  return 'enterprise'
}

/**
 * The titles People Scout should actually search for a given company.
 * Evidence first, archetype fallback second, never an empty list.
 */
export function resolveTitlesForCompany(
  researched: string[],
  archetype: CompanyArchetype,
  limit = 10
): { titles: string[]; usedFallback: boolean } {
  const fromResearch = normalizeTitlePatterns(researched, limit)
  if (fromResearch.length >= 3) return { titles: fromResearch, usedFallback: false }

  // Top up rather than replace: a couple of good researched titles plus the
  // archetype defaults beats discarding either.
  const merged = normalizeTitlePatterns([...fromResearch, ...ARCHETYPE_TITLES[archetype]], limit)
  return { titles: merged, usedFallback: true }
}
