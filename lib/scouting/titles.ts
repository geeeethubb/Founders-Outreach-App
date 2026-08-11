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

// ─── Ranking candidates within a company ─────────────────────────────────────

/** Seniority words, roughly ordered by how much scope they usually imply. */
const SENIORITY_TIERS: { pattern: RegExp; tier: number }[] = [
  { pattern: /\b(founder|co-?founder|ceo|cto|chief|president)\b/i, tier: 5 },
  { pattern: /\b(vp|vice president|svp|evp|partner|principal|managing director)\b/i, tier: 4 },
  { pattern: /\b(head of|director)\b/i, tier: 3 },
  { pattern: /\b(manager|lead|supervisor)\b/i, tier: 2 },
  { pattern: /\b(engineer|scientist|analyst|specialist|associate|consultant)\b/i, tier: 1 },
]

function seniorityTier(title: string): number {
  for (const { pattern, tier } of SENIORITY_TIERS) if (pattern.test(title)) return tier
  return 0
}

/** The tier that is actually reachable AND empowered at each kind of company. */
const IDEAL_TIER: Record<CompanyArchetype, number> = {
  startup: 5,
  growth: 4,
  midmarket: 3,
  enterprise: 3,
  consultancy: 4,
  research: 3,
  other: 3,
}

function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2)
}

/**
 * Score how well one real job title matches what we wanted at this company.
 *
 * Two signals, both needed:
 *
 *   PREFERENCE  Company Validation returns target titles in preference order,
 *               so an earlier match is worth more than a later one.
 *   SENIORITY   Distance from the tier that is reachable AND empowered here.
 *               A founder scores best at a startup and worst at a 90,000-person
 *               manufacturer, where a director who owns the function wins.
 *
 * Exists because Apollo returns matches in an order of its own, and taking the
 * first N that survive the filter means the person we contact is chosen by
 * Apollo's sort rather than by fit.
 */
export function scoreStubTitle(
  title: string | null,
  targetTitles: string[],
  archetype: CompanyArchetype
): number {
  if (!title || !title.trim()) return -1

  const t = title.toLowerCase()
  let preference = 0

  for (let i = 0; i < targetTitles.length; i++) {
    const target = targetTitles[i].toLowerCase()
    // Earlier targets are worth more; the decay keeps later ones meaningful.
    const weight = 1 / (1 + i * 0.35)

    if (t === target) {
      preference = Math.max(preference, 12 * weight)
      continue
    }
    if (t.includes(target) || target.includes(t)) {
      preference = Math.max(preference, 9 * weight)
      continue
    }
    const targetTokens = tokens(target)
    if (targetTokens.length === 0) continue
    const titleTokens = new Set(tokens(t))
    const overlap = targetTokens.filter((tok) => titleTokens.has(tok)).length
    if (overlap > 0) {
      preference = Math.max(preference, (6 * weight * overlap) / targetTokens.length)
    }
  }

  const gap = Math.abs(seniorityTier(t) - IDEAL_TIER[archetype])
  const seniorityScore = Math.max(0, 4 - gap * 1.5)

  return preference + seniorityScore
}

/**
 * Order a company's candidates best-first. Stable: equal scores keep Apollo's
 * order, so the function is deterministic and its output diffable across runs.
 */
export function rankStubsByTitle<T>(
  stubs: T[],
  getTitle: (s: T) => string | null,
  targetTitles: string[],
  archetype: CompanyArchetype
): T[] {
  return stubs
    .map((stub, index) => ({ stub, index, score: scoreStubTitle(getTitle(stub), targetTitles, archetype) }))
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.index - b.index))
    .map((x) => x.stub)
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
