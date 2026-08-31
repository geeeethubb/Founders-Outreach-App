// Is this posting even in the right subject? — deterministic, at read time.
//
// Discovery now hands the inbox hundreds of postings instead of dozens, because
// a company-first sweep takes a company's WHOLE board. That is the right trade
// for inventory (a board listing is free JSON) and the wrong thing to put in
// front of a person: "Office Management and Internal Communications Intern" and
// "Architectural Engineering Intern" arrived through the same door as the
// chemical engineering roles the founder actually asked for.
//
// So the inbox needs a cheap, honest answer to one question — does this posting
// speak the direction's subject? — for EVERY posting, including the ones no
// model has read. That is not judgment. It is term overlap and a vocabulary of
// disciplines, so it is code (CLAUDE.md §1), it costs nothing, and it runs on a
// row that has only a title, a company and a location.
//
// NOT the same thing as ./relevance.ts. That module orders a scout's candidates
// — "which of these rows deserves the next paid extraction?" — as an unbounded
// integer priority, inside a run. This one answers "does this belong on the
// founder's screen?" as a 0–1 score with a band and human reasons, at read
// time, for rows that were stored days ago. Same word, two questions.
//
// Three properties this file exists to guarantee:
//
//   1. It works on an UNEXTRACTED row. After a board sweep that is the common
//      case, and a scorer that needs a description would rank half the
//      inventory as "unknown" — which is how 21 of 43 jobs became invisible
//      behind a fit sort.
//   2. It is computed, never stored. Change "what I'm scouting for" and every
//      posting re-scores on the next page load. No column, no migration, no
//      backfill, no stale score outliving the direction that produced it.
//   3. It never overrules a real evaluation. A posting the Fit Evaluator scored
//      at MAYBE or better can never be banded 'off' by keyword arithmetic — the
//      model read the description; this file read the title.
//
// Nothing is discarded either (ADR-010, CLAUDE.md §11): 'off' is a band, not a
// delete. The inbox filters it, counts it, and shows it on request.
//
// Pure. No model, no database, no I/O.

import { directionTerms } from '../scout/direction'
import type { CareerMission, CareerMissionPreferences, EmploymentType, HardConstraint } from '../types'
import { isInternshipLike } from './filters'

export const RELEVANCE_BANDS = ['strong', 'possible', 'off'] as const
export type RelevanceBand = (typeof RELEVANCE_BANDS)[number]

export interface InboxRelevance {
  /** 0–1. Comparable across postings for the SAME direction, and meaningless across two different ones. */
  score: number
  band: RelevanceBand
  /** Short and human — what the inbox puts under the title. */
  reasons: string[]
}

/**
 * Everything relevance is allowed to read. The first few are what a board
 * listing gives you; the rest are used when extraction happened and ignored
 * when it did not.
 *
 * Two columns are deliberately ABSENT, and their absence is load-bearing:
 *
 *   · `description_text` — the inbox scores from a census that does not select
 *     it (it is the largest column in the table). If this function could read
 *     it, the same posting would score one way in the inbox and another in the
 *     run view, which fetches full rows — a posting could be 'possible' on one
 *     screen and hidden as 'off' on the other. Leaving it off the type makes
 *     the two paths agree by construction, not by discipline.
 *   · `company_name` — matching a direction term against the EMPLOYER's name
 *     turns "materials" into a hit on Applied Materials and prints the reason
 *     `mentions "materials"` under a reinforcement-learning internship. The
 *     company-preference nudge below reads `industry` for the same reason.
 *
 * Both are still on the row objects callers pass; TypeScript's structural
 * typing simply means this function cannot see them.
 */
export interface InboxRelevanceJob {
  title: string
  location_raw?: string | null
  location_tier?: number | null
  role_family?: string | null
  industry?: string | null
  skills?: string[] | null
  employment_type?: string | null
  season_relevance?: string | null
  extraction_version?: string | null
  /** A real evaluation, when one exists. It is a floor, never a penalty. */
  fit_overall?: number | null
}

// ─── The discipline vocabulary ───────────────────────────────────────────────
//
// Term overlap alone fails in both directions. "R&D" and "Materials" survive
// the direction's own phrase extraction as two one-letter fragments and a
// plural; and "Architectural Engineering" shares no word with "Chemical
// Engineering" while being unmistakably a different job. A small vocabulary of
// disciplines fixes both: it recognises a subject by any of its words, and it
// makes "names a DIFFERENT subject" expressible at all.
//
// `defining` disciplines answer "what is this job about". `modifier` ones
// (research, operations, strategy) qualify a subject rather than being one — an
// R&D intern is on-direction for a research-flavoured direction, but a
// machine-learning research intern is not, because ML is defining.
//
// `group` only sets how far away a mismatch is: a mechanical role under a
// chemical direction is adjacent; an office-management role is not.

type DisciplineGroup = 'engineering' | 'science' | 'software' | 'business' | 'creative' | 'support'

interface Discipline {
  id: string
  label: string
  group: DisciplineGroup
  kind: 'defining' | 'modifier'
  re: RegExp
}

// A truncated stem before \b never matches an inflected word (CLAUDE.md's
// `\bmanufactur\b` trap) — every stem here ends in \w*.
const DISCIPLINES: Discipline[] = [
  { id: 'chemical', label: 'chemical engineering', group: 'engineering', kind: 'defining', re: /\bchemical\w*|\bchem\s?e\b|\bchemist\w*|\bcatalys\w*|\bpolymer\w*|\belectrochem\w*|\bformulation\w*|\bslurr\w*|\bcatholyte\w*|\banolyte\w*/i },
  { id: 'process', label: 'process engineering', group: 'engineering', kind: 'defining', re: /\bprocess\s+(?:engineer\w*|development|design|technolog\w*|scien\w*)|\bprocess\s?engineer\w*|\bunit operations\b|\bseparations\b|\bdistillation\b|\bscale[- ]?up\b/i },
  { id: 'materials', label: 'materials science', group: 'engineering', kind: 'defining', re: /\bmaterial\w*|\bmetallurg\w*|\bceramic\w*|\bcomposite\w*|\bcorrosion\w*|\bcoating\w*/i },
  { id: 'mechanical', label: 'mechanical engineering', group: 'engineering', kind: 'defining', re: /\bmechanical\w*|\bthermal\w*|\bhvac\b|\bfluid dynamic\w*/i },
  { id: 'electrical', label: 'electrical engineering', group: 'engineering', kind: 'defining', re: /\belectrical\w*|\belectronic\w*|\bpower systems?\b|\bi\s?&\s?c\b|\bpcb\b|\bsemiconductor\w*|\bcircuit\w*/i },
  { id: 'civil', label: 'civil engineering', group: 'engineering', kind: 'defining', re: /\bcivil\w*|\bstructural engineer\w*|\bgeotechnic\w*|\bsurvey(?:ing|or)\b/i },
  { id: 'architecture', label: 'architectural engineering', group: 'engineering', kind: 'defining', re: /\barchitectur\w*/i },
  { id: 'manufacturing', label: 'manufacturing engineering', group: 'engineering', kind: 'defining', re: /\bmanufactur\w*|\bproduction engineer\w*|\bfabricat\w*|\bassembly line\b|\bmachinist\w*|\bproduction technician\w*/i },
  { id: 'industrial', label: 'industrial engineering', group: 'engineering', kind: 'defining', re: /\bindustrial engineer\w*|\bsupply chain\b|\blogistic\w*|\bwarehous\w*|\bprocurement\b/i },
  { id: 'quality', label: 'quality engineering', group: 'engineering', kind: 'defining', re: /\bquality (?:assurance|engineer\w*|control|systems?)\b|\bqa\/qc\b/i },
  { id: 'environmental', label: 'environmental / EHS', group: 'engineering', kind: 'defining', re: /\benvironmental\w*|\behs\b|\bhealth (?:and|&) safety\b|\bsustainab\w*|\bremediation\b/i },
  { id: 'nuclear', label: 'nuclear engineering', group: 'engineering', kind: 'defining', re: /\bnuclear\w*|\breactor\w*|\bradiolog\w*|\bfission\b|\bfusion\b/i },
  { id: 'aerospace', label: 'aerospace engineering', group: 'engineering', kind: 'defining', re: /\baerospace\w*|\baeronaut\w*|\bastronaut\w*|\bpropulsion\b|\bavionic\w*|\bflight (?:test|control)\b/i },
  { id: 'petroleum', label: 'petroleum engineering', group: 'engineering', kind: 'defining', re: /\bpetroleum\w*|\bdrilling\b|\breservoir\w*|\bsubsurface\b|\bupstream\b/i },
  { id: 'biomedical', label: 'biomedical engineering', group: 'engineering', kind: 'defining', re: /\bbiomedical\w*|\bbioengineer\w*|\bmedical device\w*|\bbioprocess\w*|\bbiomanufactur\w*/i },
  { id: 'robotics', label: 'robotics', group: 'engineering', kind: 'defining', re: /\brobotic\w*|\bautonom\w*|\bmechatronic\w*|\bmotion planning\b|\bperception\b/i },
  { id: 'automation', label: 'automation / controls', group: 'engineering', kind: 'defining', re: /\bautomation\w*|\bcontrols? engineer\w*|\bplc\b|\bscada\b/i },
  { id: 'biology', label: 'life sciences', group: 'science', kind: 'defining', re: /\bbiolog\w*|\bgenomic\w*|\bgenetic\w*|\bbioinformatic\w*|\bmolecular\w*|\bprotein\w*|\bimmunolog\w*|\bmicrobiolog\w*|\bcell (?:biolog\w*|cultur\w*)/i },
  { id: 'clinical', label: 'clinical / pharma', group: 'science', kind: 'defining', re: /\bclinical\w*|\bpharmacolog\w*|\bpharmaceutic\w*|\bdrug (?:discovery|development)\b|\bregulatory affairs\b|\btoxicolog\w*/i },
  { id: 'physics', label: 'physics', group: 'science', kind: 'defining', re: /\bphysic(?:s|ist)\b|\bphoton\w*|\boptic\w*|\bquantum\b/i },
  { id: 'software', label: 'software engineering', group: 'software', kind: 'defining', re: /\bsoftware\w*|\bfull[- ]?stack\b|\bback[- ]?end\b|\bfront[- ]?end\b|\bweb develop\w*|\bdevops\b|\bplatform engineer\w*|\bsite reliability\b|\bcompiler\w*/i },
  { id: 'ml', label: 'machine learning / AI', group: 'software', kind: 'defining', re: /\bmachine learning\b|\bdeep learning\b|\breinforcement learning\b|\bartificial intelligence\b|\bcomputer vision\b|\bnlp\b|\bfoundation model\w*|\bllm\w*|\bgenerative ai\b|\bai scientist\b/i },
  { id: 'data', label: 'data science', group: 'software', kind: 'defining', re: /\bdata (?:scien\w*|engineer\w*|analy\w*|platform)\b|\banalytics\b|\bbusiness intelligence\b/i },
  { id: 'security', label: 'security', group: 'software', kind: 'defining', re: /\bcyber\w*|\binformation security\b|\bpenetration test\w*|\bsecurity engineer\w*/i },
  { id: 'finance', label: 'finance', group: 'business', kind: 'defining', re: /\bfinanc\w*|\baccount(?:ing|ant)\b|\binvestment\w*|\bequity research\b|\btreasury\b|\baudit\w*|\bactuarial\b/i },
  { id: 'marketing', label: 'marketing', group: 'business', kind: 'defining', re: /\bmarketing\b|\bbrand\w*|\bsocial media\b|\badvertis\w*|\bmarket research\b/i },
  { id: 'sales', label: 'sales', group: 'business', kind: 'defining', re: /\bsales\b|\bbusiness development\b|\baccount (?:executive|manager)\b|\bcustomer success\b/i },
  { id: 'product', label: 'product management', group: 'business', kind: 'defining', re: /\bproduct (?:manage\w*|owner|marketing)\b|\bproduct operations\b/i },
  { id: 'people', label: 'people / HR', group: 'support', kind: 'defining', re: /\bhuman resources\b|\brecruit\w*|\btalent acquisition\b|\bpeople operations\b/i },
  { id: 'legal', label: 'legal / compliance', group: 'support', kind: 'defining', re: /\blegal\b|\bcounsel\b|\bparalegal\b|\bcompliance\b/i },
  { id: 'admin', label: 'office / administration', group: 'support', kind: 'defining', re: /\boffice (?:manage\w*|administrat\w*|coordinat\w*)\b|\badministrative assistant\b|\bexecutive assistant\b|\breceptionist\b|\bfacilities\b/i },
  { id: 'comms', label: 'communications', group: 'creative', kind: 'defining', re: /\bcommunications?\b|\bpublic relations\b|\bjournalis\w*|\bcopywrit\w*|\bcontent (?:writ\w*|market\w*)\b/i },
  { id: 'design', label: 'design', group: 'creative', kind: 'defining', re: /\bux\b|\buser experience\b|\bgraphic design\w*|\bindustrial design\w*|\bproduct design\w*|\bvisual design\w*/i },

  { id: 'research', label: 'research / R&D', group: 'science', kind: 'modifier', re: /\bresearch\w*|\br\s?&\s?d\b|\brnd\b|\bscientist\b|\blaborator\w*|\blab\b|\bdiscovery\b/i },
  { id: 'operations', label: 'operations', group: 'engineering', kind: 'modifier', re: /\boperations?\b|\bplant\b|\brefiner\w*|\bfield engineer\w*/i },
  { id: 'strategy', label: 'strategy', group: 'business', kind: 'modifier', re: /\bstrateg\w*|\bcorporate development\b|\bconsult\w*/i },
]

/** A title that announces a programme without announcing a subject — "2027 Summer Internship", "Engineering Intern". */
const GENERIC_PROGRAMME = /\b(?:intern|internship|co-?op|summer analyst)\b|\bengineering (?:program|programme)\b/i

/**
 * Words a direction sentence carries that say nothing about the subject.
 *
 * `directionTerms` is tuned for query building, where a junk term costs one
 * wasted web search. Here a junk term floats an irrelevant posting into the
 * inbox, so the bar is higher: the founder's real direction ("Find me your
 * typical Chemical Engineering internships…") yields `find`, `your` and
 * `typical` alongside `chemical`, `material` and `proces`, and only the last
 * three are about the work. Stems, matching what `directionTerms` emits.
 */
const NOISE_TERMS = new Set([
  'find', 'your', 'typical', 'anything', 'ask', 'keep', 'care', 'just', 'very', 'tailored', 'which', 'company',
  'location', 'want', 'need', 'look', 'please', 'ideal', 'prefer', 'something', 'stuff', 'thing', 'work',
  'job', 'position', 'like', 'love', 'really', 'about', 'more', 'most', 'best', 'good', 'great', 'high',
  'level', 'entry', 'student', 'undergrad', 'graduate', 'year', 'next', 'this', 'that', 'they', 'them',
  'with', 'from', 'have', 'been', 'will', 'would', 'should', 'could', 'other', 'etc', 'don', 'doesn',
  'typical', 'across', 'where', 'while', 'their', 'there', 'these', 'those', 'also', 'able',
])

// ─── Context ─────────────────────────────────────────────────────────────────

export interface RelevanceContext {
  /** The direction verbatim, for the UI to quote. */
  direction: string | null
  /** Direction content words, stemmed, with instruction noise removed. */
  terms: string[]
  /** Disciplines the direction (and any stated role families) is ABOUT. */
  wanted: { id: string; label: string; kind: Discipline['kind'] }[]
  wantedIds: Set<string>
  /** Groups those disciplines belong to — how far away a mismatch is. */
  wantedGroups: Set<DisciplineGroup>
  /** True when the mission states a subject at all. Without one, nothing can be off-direction. */
  canJudge: boolean
  /** Company-level words: company types and industries. They never define a discipline. */
  companyWords: string[]
  season: string
  seasonLabel: string
  /** The mission's hard constraints say internships only, so a full-time posting is off by definition. */
  internshipsOnly: boolean
}

const SEASON_LABELS: Record<string, string> = {
  summer_2027: 'Summer 2027',
  winter_2026_27: 'Winter 2026/27',
  fall_2026: 'Fall 2026',
  spring_2027: 'Spring 2027',
}

function seasonLabel(season: string): string {
  return SEASON_LABELS[season] ?? season.replace(/_/g, ' ')
}

/** True when the mission's hard constraints restrict employment type to internships or co-ops. */
export function missionWantsInternships(constraints: HardConstraint[] | null | undefined): boolean {
  for (const c of constraints ?? []) {
    if (c.dimension !== 'employment_type') continue
    const values = (Array.isArray(c.value) ? c.value : [c.value]).map((v) => String(v).toLowerCase())
    if (values.some((v) => v === 'internship' || v === 'co_op')) return true
  }
  return false
}

function disciplinesIn(text: string, kind: Discipline['kind']): Discipline[] {
  if (!text.trim()) return []
  return DISCIPLINES.filter((d) => d.kind === kind && d.re.test(text))
}

function contentWords(values: (string | null | undefined)[]): string[] {
  const out = new Set<string>()
  for (const v of values) {
    for (const w of (v ?? '').toLowerCase().split(/[^a-z0-9+]+/)) {
      if (w.length >= 4 && !NOISE_TERMS.has(w)) out.add(w.replace(/(ing|ies|es|s)$/, (m) => (m === 'ies' ? 'y' : '')))
    }
  }
  return [...out]
}

/**
 * The mission, reduced to what scoring needs — built ONCE per request and
 * reused for every posting. At 500 rows the difference between compiling the
 * direction once and 500 times is the entire cost of this feature.
 *
 * `company_types` and `industries` deliberately do NOT contribute disciplines.
 * They describe the employer ("advanced manufacturing", "pharma where
 * relevant"); reading them as subjects would make every role at a manufacturing
 * company on-direction and the filter would stop filtering.
 */
export function relevanceContext(
  mission: Pick<CareerMission, 'season' | 'preferences' | 'hard_constraints'> | null | undefined
): RelevanceContext {
  const prefs: Partial<CareerMissionPreferences> = mission?.preferences ?? {}
  const direction = (prefs.direction ?? '').trim() || null
  const roleFamilies = (prefs.role_families ?? []).join(' ')
  // Subject text = the stated direction plus any explicitly stated role families.
  const subject = `${direction ?? ''} ${roleFamilies}`.trim()
  const wanted = [...disciplinesIn(subject, 'defining'), ...disciplinesIn(subject, 'modifier')]
  const terms = [...directionTerms(direction)].filter((t) => !NOISE_TERMS.has(t))
  // Role families are stated subjects too, so their words count as direction terms.
  for (const w of contentWords([roleFamilies])) if (!terms.includes(w)) terms.push(w)
  const season = mission?.season ?? 'summer_2027'
  return {
    direction,
    terms,
    wanted: wanted.map((d) => ({ id: d.id, label: d.label, kind: d.kind })),
    wantedIds: new Set(wanted.map((d) => d.id)),
    wantedGroups: new Set(wanted.filter((d) => d.kind === 'defining').map((d) => d.group)),
    canJudge: wanted.some((d) => d.kind === 'defining'),
    companyWords: contentWords([...(prefs.company_types ?? []), ...(prefs.industries ?? [])]),
    season,
    seasonLabel: seasonLabel(season),
    internshipsOnly: missionWantsInternships(mission?.hard_constraints),
  }
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

const BASE = 0.3
export const STRONG_AT = 0.62
export const POSSIBLE_AT = 0.4
/** A fit at MAYBE or better — `fitBand`'s own threshold — is a real evaluation and outranks keywords. */
const FIT_FLOOR = 0.48
const FIT_STRONG = 0.75

const pct = (n: number) => `${Math.round(n * 100)}%`

/**
 * The whole word a stem matched, for the reason line. `directionTerms` stems
 * crudely — "process" comes back as "proces" — and `title matches "proces"`
 * reads like a bug. Quote what is actually written on the posting instead.
 */
function shown(stem: string, hay: string): string {
  const m = hay.match(new RegExp(`[a-z0-9+]*${stem.replace(/\+/g, '\\+')}[a-z0-9+]*`, 'i'))
  return m ? m[0] : stem
}

function quote(terms: string[], hay: string): string {
  return terms.slice(0, 3).map((t) => `"${shown(t, hay)}"`).join(', ')
}

export function bandFor(score: number): RelevanceBand {
  if (score >= STRONG_AT) return 'strong'
  if (score >= POSSIBLE_AT) return 'possible'
  return 'off'
}

/**
 * How relevant this posting is to the mission's stated direction, 0–1.
 *
 * Two independent signals, because either alone is wrong. Term overlap catches
 * the words the founder actually typed; the discipline vocabulary catches the
 * subject those words belong to.
 *
 * With NO stated direction and no stated role families there is nothing to
 * judge against, so nothing is ever 'off' — an empty direction must widen the
 * inbox, never empty it.
 */
export function scoreRelevance(job: InboxRelevanceJob, ctx: RelevanceContext): InboxRelevance {
  const reasons: string[] = []
  const extracted = !!job.extraction_version
  const fit = typeof job.fit_overall === 'number' && Number.isFinite(job.fit_overall) ? job.fit_overall : null
  const shape = { employment_type: (job.employment_type ?? 'unknown') as EmploymentType, title: job.title }

  // ── Hard exclusions: the mission's own non-negotiables, not a judgment call.
  if (ctx.internshipsOnly && !isInternshipLike(shape)) {
    return { score: 0, band: 'off', reasons: ['not an internship'] }
  }
  if (job.season_relevance === 'other_season') {
    return { score: 0, band: 'off', reasons: [`wrong season — not ${ctx.seasonLabel}`] }
  }

  // Two haystacks. The title and the extracted role family SAY what the job is;
  // the industry and skills only mention things. Both are about the WORK — the
  // employer's name is not in either (see `InboxRelevanceJob`), so a reason line
  // can only ever cite evidence about the job.
  const headline = `${job.title} ${job.role_family ?? ''}`.toLowerCase()
  const body = `${job.industry ?? ''} ${(job.skills ?? []).join(' ')}`.toLowerCase()

  let score = BASE

  // ── Signal 1: the direction's own words.
  const inHeadline = ctx.terms.filter((t) => headline.includes(t))
  const inBody = ctx.terms.filter((t) => !headline.includes(t) && body.includes(t))
  if (inHeadline.length) {
    score += Math.min(inHeadline.length, 3) * 0.16
    reasons.push(`title matches ${quote(inHeadline, headline)}`)
  }
  if (inBody.length) {
    score += Math.min(inBody.length, 2) * 0.05
    reasons.push(`mentions ${quote(inBody, body)}`)
  }

  // ── Signal 2: the subject itself.
  const named = disciplinesIn(headline, 'defining')
  const onDirection = named.filter((d) => ctx.wantedIds.has(d.id))
  const conflicting = named.filter((d) => !ctx.wantedIds.has(d.id))
  const conflicts = ctx.canJudge && onDirection.length === 0 && conflicting.length > 0

  if (onDirection.length) {
    score += onDirection.length >= 2 ? 0.28 : 0.22
    reasons.push(`on direction: ${onDirection.map((d) => d.label).join(' + ')}`)
  } else if (conflicts) {
    // A different subject. How different decides how far it falls — a mechanical
    // role under a chemical direction is adjacent; office management is not. The
    // most generous reading wins, so one stray word cannot bury a posting.
    const penalty = Math.min(...conflicting.map((d) => (ctx.wantedGroups.has(d.group) ? 0.25 : 0.4)))
    score -= penalty
    reasons.push(`off-direction: ${conflicting.map((d) => d.label).slice(0, 2).join(', ')}`)
  } else {
    // No conflicting subject. A research/operations flavour the direction shares
    // is worth something, and a title that names NO subject is not evidence
    // against the posting — a general engineering internship programme is
    // exactly what a thin board listing looks like, and dropping those would
    // recreate the bug where half the inventory was invisible.
    const modifiers = disciplinesIn(headline, 'modifier').filter((d) => ctx.wantedIds.has(d.id))
    if (modifiers.length) {
      score += 0.1
      reasons.push(`on direction: ${modifiers.map((d) => d.label).join(' + ')}`)
    }
    if (named.length === 0 && GENERIC_PROGRAMME.test(job.title)) {
      score += 0.1
      reasons.push('general programme — no discipline stated')
    }
  }

  // ── Company-level preferences: a nudge, never a verdict. Read off the
  // extracted industry only — matching the company NAME turns "materials" into
  // a hit on Applied Materials, which says nothing about the work.
  if (ctx.companyWords.length && job.industry) {
    const where = job.industry.toLowerCase()
    const hit = ctx.companyWords.find((w) => where.includes(w))
    if (hit) {
      score += 0.05
      reasons.push(`company type: ${shown(hit, where)}`)
    }
  }

  // ── Season and geography. Both small: the founder said location does not decide it.
  if (job.season_relevance && job.season_relevance === ctx.season) {
    score += 0.06
    reasons.push(`season: ${ctx.seasonLabel}`)
  }
  const tier = job.location_tier ?? null
  if (tier === 1) {
    score += 0.05
    reasons.push('tier 1 location')
  } else if (tier === 2) {
    score += 0.03
  }
  if (isInternshipLike(shape)) score += 0.02

  score = Math.max(0, Math.min(1, score))
  let band = bandFor(score)

  // Nothing to judge against ⇒ nothing is off. An empty direction must widen
  // the inbox, and a bare base score would otherwise band every posting 'off'
  // and empty the screen — the worst possible answer to "I stated no
  // preference".
  if (!ctx.canJudge && band === 'off') band = 'possible'

  // ── A real evaluation is a floor. The Fit Evaluator read the description;
  // this function read the title. Keyword arithmetic never hides its verdict.
  if (fit !== null && fit >= FIT_FLOOR) {
    if (score < fit) score = fit
    const floor: RelevanceBand = fit >= FIT_STRONG ? 'strong' : 'possible'
    if (band === 'off' || (band === 'possible' && floor === 'strong')) {
      band = floor
      reasons.unshift(`already evaluated — fit ${pct(fit)}`)
    }
  }

  // "Not analysed" and "not read" are different claims. A row can carry a fit
  // evaluation with no extraction — the evaluator read the posting, the
  // extractor never stored its fields — and telling the founder nobody looked
  // at it would be false.
  if (!extracted) reasons.push(fit === null ? 'not analysed yet' : 'listing only — scored but not extracted')
  if (!ctx.canJudge) reasons.push('no direction stated — nothing to score against')

  return { score: Number(score.toFixed(4)), band, reasons }
}

// ─── Using it ────────────────────────────────────────────────────────────────

export const RELEVANCE_FILTERS = ['strong', 'possible', 'any'] as const
export type RelevanceFilter = (typeof RELEVANCE_FILTERS)[number]

/** Does this band pass the filter? `possible` means strong + possible; `any` hides nothing. */
export function passesRelevance(band: RelevanceBand, filter: RelevanceFilter): boolean {
  if (filter === 'any') return true
  if (filter === 'strong') return band === 'strong'
  return band !== 'off'
}

export interface RelevanceCounts {
  total: number
  strong: number
  possible: number
  off: number
  /** Relevant (strong or possible) and read by no model at all — the "needs a look" queue. */
  needsLook: number
}

/**
 * `read` is not `extracted`.
 *
 * The queue's promise to the founder is "nobody has looked at this yet", and a
 * row can carry a Fit Evaluator score with a null `extraction_version` — the
 * evaluator read the posting even though the extractor never stored its fields.
 * Counting those as unread put two already-scored Amgen postings in a queue
 * whose label says they had never been seen.
 */
export function relevanceCounts(scored: { relevance: InboxRelevance; read: boolean }[]): RelevanceCounts {
  const counts: RelevanceCounts = { total: scored.length, strong: 0, possible: 0, off: 0, needsLook: 0 }
  for (const s of scored) {
    counts[s.relevance.band]++
    if (s.relevance.band !== 'off' && !s.read) counts.needsLook++
  }
  return counts
}

/** How many of `counts` a filter shows. The complement is what the header must own up to hiding. */
export function matchingRelevance(counts: RelevanceCounts, filter: RelevanceFilter): number {
  if (filter === 'any') return counts.total
  if (filter === 'strong') return counts.strong
  return counts.strong + counts.possible
}

const BAND_RANK: Record<RelevanceBand, number> = { strong: 2, possible: 1, off: 0 }

/**
 * The inbox's ordering key, descending.
 *
 * Band first, then the fit number when a model produced one and the relevance
 * score otherwise. Band first is the whole fix: the old fit sort put all 21
 * unranked postings below all 22 ranked ones, so half the inventory sat under
 * the fold behind roles the evaluator had already scored at 2%. Fit inside the
 * band keeps a real evaluation meaningful where it exists, and the two scales
 * are never compared across bands — where they would mean different things.
 */
export function bestFirstKey(job: { fit_overall?: number | null }, relevance: InboxRelevance): number {
  const fit = typeof job.fit_overall === 'number' && Number.isFinite(job.fit_overall) ? job.fit_overall : null
  return BAND_RANK[relevance.band] + (fit ?? relevance.score)
}

/** One reason a posting is off the screen, and how many it accounts for. */
export interface HiddenGroup {
  /** Founder-facing and plural-agnostic: "off-direction", "possible", "already read". */
  label: string
  count: number
}

/**
 * "312 postings · 47 strong · showing 47 — 265 off-direction, 10 already read hidden".
 *
 * The one sentence the inbox cannot get wrong. It always names the whole
 * inventory, and it always names what is being kept off the screen and why — a
 * list that quietly shrinks from 312 to 47 with no explanation is how an
 * operator learns to distrust the filter.
 *
 * It takes the hidden groups rather than deriving them from a relevance filter,
 * because the relevance filter is not the only thing that hides a row. The
 * "needs a look" view also removes every already-read posting, and a headline
 * that knew only the filter named 26 off-direction rows while 36 were actually
 * off the screen. Whoever narrows the list owns a group here; the caller that
 * builds the list builds the list of reasons with it, in the same pass.
 */
export function relevanceHeadline(counts: RelevanceCounts, matched: number, hidden: HiddenGroup[]): string {
  const head = `${counts.total} posting${counts.total === 1 ? '' : 's'} · ${counts.strong} strong · showing ${matched}`
  const parts = hidden.filter((h) => h.count > 0).map((h) => `${h.count} ${h.label}`)
  return parts.length ? `${head} — ${parts.join(', ')} hidden` : head
}
