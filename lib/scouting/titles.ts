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

/** Qualifier separators. Everything after the first one is usually scope. */
const QUALIFIER_SPLIT = /,| - | – | — |:|\|/

/**
 * A bare rank with no function attached.
 *
 * Corporate titles use two opposite comma conventions:
 *
 *   "Solutions Engineering Manager, Process Industries"  -> qualifier follows
 *   "Director, Digital Manufacturing"                    -> FUNCTION follows
 *
 * Discarding everything after the comma is right for the first and catastrophic
 * for the second: it reduces the title to "Director", and searching a 90,000-
 * person manufacturer for "Director" returns every director in the company —
 * which is how food-science "Director of Innovation" and "Director R&D" ended up
 * in an industrial-digitalization list.
 *
 * So when the head is a bare rank, the tail is rejoined rather than dropped.
 */
const BARE_RANK =
  /^(director|manager|head|lead|vp|vice president|svp|evp|avp|principal|partner|chief|president|senior director|senior manager|associate director|global director|regional director|executive director|managing director)$/i

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

  // Keep the head of the phrase — unless the head is a bare rank, in which case
  // the segment after the separator is the function and must be kept.
  const segments = t.split(QUALIFIER_SPLIT).map((s) => s.trim()).filter(Boolean)
  if (segments.length === 0) return []

  if (segments.length > 1 && BARE_RANK.test(segments[0])) {
    t = `${segments[0]} ${segments[1]}`.replace(/\s+/g, ' ').trim()
  } else {
    t = segments[0]
  }
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
  // Every title here must name a FUNCTION, not just a rank plus a vague noun.
  //
  // "Director of Innovation" and "Director R&D" were removed: at a food or CPG
  // manufacturer they mean product and flavour innovation, and they produced
  // three of the six BADs on the chemical/manufacturing profile — a General
  // Mills innovation director, a Unilever R&D associate director, and a PepsiCo
  // R&D innovation director, none of whom touch digital manufacturing.
  enterprise: [
    'Director Digital Manufacturing', 'Director Advanced Manufacturing',
    'Director Process Technology', 'Director Manufacturing Technology',
    'Head of Data Science', 'Director Operational Excellence',
    'Manager Advanced Manufacturing', 'Director Process Automation',
  ],
  consultancy: ['Partner', 'Principal', 'Managing Director', 'Associate Partner', 'Director'],
  research: ['Principal Investigator', 'Research Director', 'Group Leader', 'Staff Scientist'],
  other: ['Director', 'Head of Engineering', 'VP Operations', 'Founder'],
}

/**
 * How many candidates are worth pulling from one company of each kind.
 *
 * A single global depth is wrong in both directions. At a 90,000-person
 * manufacturer, many people genuinely hold mission-relevant roles, so going
 * deeper keeps finding real targets. At a 40-person software vendor the relevant
 * population is a handful of people, and digging past them only surfaces
 * platform engineers and generic product managers — who then occupy top-20 slots.
 *
 * Measured: raising the global depth from 3 to 6 moved the chemical/manufacturing
 * profile 45% -> 75%, and moved Enterprise AI 65% -> 60%. Same change, opposite
 * signs, split by archetype.
 *
 * This is [ADR-018](../../docs/ARCHITECTURE.md#adr-018) applied one level up:
 * the company's own research decides how it should be mined, rather than a
 * constant that has to be right everywhere at once.
 */
export const PEOPLE_PER_COMPANY: Record<CompanyArchetype, number> = {
  startup: 3,
  growth: 4,
  midmarket: 5,
  enterprise: 6,
  consultancy: 5,
  research: 3,
  other: 4,
}

export function peopleDepthFor(archetype: CompanyArchetype, cap: number): number {
  return Math.max(1, Math.min(cap, PEOPLE_PER_COMPANY[archetype]))
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
