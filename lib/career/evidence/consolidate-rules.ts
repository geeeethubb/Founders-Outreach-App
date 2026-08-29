// Consolidation rules — the pure comparisons the plan builder is made of.
//
// Everything here is deterministic and side-effect free. Nothing guesses:
// a rule either fires with a named reason and the numbers that made it fire,
// or it does not. The thresholds are the ones plan.ts already uses for
// imports, so a pair the importer would have merged on the way in is the
// pair the consolidation pass merges after the fact — and nothing more.
//
// The founder's constraints, verbatim, that these rules encode:
//   "The system should favor false negatives over destructive false positives."
//   "Do NOT auto-merge based only on embeddings or fuzzy title similarity."

import type { EvidenceExperience, EvidenceFact, ExperienceKind } from '../types'
import {
  datesCompatible,
  normalizeOrg,
  normalizeStatement,
  normalizeTitle,
  parseResumeDate,
  titleSimilarity,
  type ParsedDate,
} from './normalize'
import { NEAR_MISS_THRESHOLD, SIMILAR_TITLE_THRESHOLD } from './plan'

// ─── Organizations and their qualifiers ──────────────────────────────────────

/**
 * The part of an organization string that names a site, a lab or a
 * descriptor rather than the organization: "Procter & Gamble, Tabler Station"
 * → "Tabler Station"; "UIUC (Professor Alex Mironenko's lab)" → the lab.
 * Local fallback for E1's orgQualifier(); TODO(wave2): switch to it once exported.
 */
export function qualifierOf(org: string): string | null {
  const paren = org.match(/\(([^)]*)\)/)
  if (paren && paren[1].trim()) return paren[1].trim()
  const comma = org.indexOf(',')
  if (comma >= 0) {
    const tail = org.slice(comma + 1).trim()
    if (tail) return tail
  }
  return null
}

/** The organization string with its qualifier removed. */
export function orgHead(org: string): string {
  const withoutParens = org.replace(/\([^)]*\)/g, ' ')
  const comma = withoutParens.indexOf(',')
  return (comma >= 0 ? withoutParens.slice(0, comma) : withoutParens).replace(/\s+/g, ' ').trim()
}

/**
 * The key two experiences must share before any rule may compare them.
 * normalizeOrg of the head (alias table applied). Never a substring test.
 */
export function orgKey(org: string): string {
  return normalizeOrg(orgHead(org))
}

const NON_LOCATION_WORDS = new Set([
  'lab', 'laboratory', 'labs', 'professor', 'prof', 'dr', 'group', 'team', 'department', 'dept',
  'startup', 'start', 'company', 'program', 'programme', 'project', 'division', 'center', 'centre',
  'institute', 'school', 'college', 'club', 'formerly', 'previously', 'uiuc', 'chapter', 'fellowship',
])

/** "Tabler Station", "Lemont, IL", "Chicago" look like places; "Professor X's lab" does not. */
export function isLocationLike(qualifier: string): boolean {
  const w = qualifier.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean)
  if (w.length === 0 || w.length > 4) return false
  return !w.some((t) => NON_LOCATION_WORDS.has(t))
}

export type QualifierVerdict = 'same' | 'one_missing' | 'location' | 'different'

export function compareQualifiers(a: string, b: string): QualifierVerdict {
  const qa = qualifierOf(a)
  const qb = qualifierOf(b)
  if (!qa || !qb) return 'one_missing'
  const na = normalizeOrg(qa)
  const nb = normalizeOrg(qb)
  if (na === nb) return 'same'
  if (isLocationLike(qa) && isLocationLike(qb)) return 'location'
  return 'different'
}

// ─── Kinds ───────────────────────────────────────────────────────────────────

const WORK_KINDS = new Set<ExperienceKind>(['experience', 'project', 'leadership', 'research', 'other'])

/** education/award never merge with work; award↔award needs equal titles (checked by the caller). */
export function kindsMergeable(a: ExperienceKind, b: ExperienceKind): boolean {
  if (WORK_KINDS.has(a) && WORK_KINDS.has(b)) return true
  return a === b
}

// ─── Titles ──────────────────────────────────────────────────────────────────

/** normalizeTitle with parentheticals dropped first: "President (previously Head of Events)" → "president". */
export function titleKey(title: string): string {
  return normalizeTitle(title.replace(/\([^)]*\)/g, ' '))
}

export function titleScore(a: string, b: string): number {
  return titleSimilarity(a.replace(/\([^)]*\)/g, ' '), b.replace(/\([^)]*\)/g, ' '))
}

/**
 * Words that make a contained title a DIFFERENT job, not a graded one: the
 * vice president is not the president, the assistant manager is not the
 * manager. When one title is the other plus one of these, no rule may fire.
 */
const RANK_MODIFIERS = new Set(['vice', 'deputy', 'assistant', 'associate', 'interim', 'acting', 'chief', 'head', 'lead', 'co'])

export function differsByRankModifier(a: string, b: string): boolean {
  const ta = new Set(titleKey(a).split(' ').filter(Boolean))
  const tb = new Set(titleKey(b).split(' ').filter(Boolean))
  if (ta.size === 0 || tb.size === 0 || ta.size === tb.size) return false
  const [larger, smaller] = ta.size > tb.size ? [ta, tb] : [tb, ta]
  let contained = true
  smaller.forEach((t) => { if (!larger.has(t)) contained = false })
  if (!contained) return false
  let rank = false
  larger.forEach((t) => { if (!smaller.has(t) && RANK_MODIFIERS.has(t)) rank = true })
  return rank
}

// ─── Dates ───────────────────────────────────────────────────────────────────

function monthOf(d: ParsedDate, bound: 'start' | 'end', nowMonth: number): number | null {
  if (d === null) return null
  if (d === 'present') return nowMonth
  return d.year * 12 + (d.month ?? (bound === 'start' ? 1 : 12))
}

export function nowMonthIndex(now: string): number {
  const m = now.match(/^(\d{4})-(\d{2})/)
  return m ? Number(m[1]) * 12 + Number(m[2]) : 2026 * 12 + 8
}

/**
 * Fraction of the shorter range covered by the overlap, or null when either
 * side lacks a parsed start and end. "Present" resolves to `now`, so the
 * answer for a given `now` never changes.
 */
export function dateOverlapRatio(
  a: { start_date: string | null; end_date: string | null },
  b: { start_date: string | null; end_date: string | null },
  nowMonth: number
): number | null {
  const aS = monthOf(parseResumeDate(a.start_date), 'start', nowMonth)
  const aE = monthOf(parseResumeDate(a.end_date), 'end', nowMonth)
  const bS = monthOf(parseResumeDate(b.start_date), 'start', nowMonth)
  const bE = monthOf(parseResumeDate(b.end_date), 'end', nowMonth)
  if (aS === null || aE === null || bS === null || bE === null) return null
  const overlap = Math.min(aE, bE) - Math.max(aS, bS) + 1
  if (overlap <= 0) return 0
  const shorter = Math.min(aE - aS, bE - bS) + 1
  return shorter <= 0 ? 0 : Math.min(1, overlap / shorter)
}

/** Both sides parsed and non-overlapping: two jobs, whatever the title says. */
export function datesDisjoint(a: { start_date: string | null; end_date: string | null }, b: { start_date: string | null; end_date: string | null }): boolean {
  return !datesCompatible(a, b)
}

/** True when two date strings mean the same month. "5/2026" = "May 2026"; "8/2026" ≠ "Present". */
export function sameDate(a: string | null, b: string | null): boolean {
  const pa = parseResumeDate(a)
  const pb = parseResumeDate(b)
  if (pa === null || pb === null) return pa === pb
  if (pa === 'present' || pb === 'present') return pa === pb
  return pa.year === pb.year && (pa.month ?? 0) === (pb.month ?? 0)
}

// ─── Statements ──────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'in', 'at', 'to', 'for', 'and', 'or', 'on', 'by', 'with', 'all', 'across',
  'as', 'from', 'into', 'is', 'was', 'were', 'be', 'been', 'that', 'this', 'its', 'it', 'over', 'per',
])

export interface StatementTokens {
  numeric: string[]   // sorted multiset; ["none"] when there are no numbers
  words: Set<string>  // non-numeric, stopwords removed
}

/** "$4M+", "400+", "#1", "20%" → "4m", "400", "1", "20%". */
export function numericTokens(text: string): string[] {
  const out: string[] = []
  const re = /\$?(\d[\d,]*(?:\.\d+)?)\s*(%|percent|k|m|b|mm|million|billion|thousand|x)?/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const num = m[1].replace(/,/g, '')
    let suffix = (m[2] ?? '').toLowerCase()
    if (suffix === 'million' || suffix === 'mm') suffix = 'm'
    if (suffix === 'billion') suffix = 'b'
    if (suffix === 'thousand') suffix = 'k'
    if (suffix === 'percent') suffix = '%'
    out.push(num + suffix)
  }
  return out.sort()
}

export function statementTokens(statement: string): StatementTokens {
  const norm = normalizeStatement(statement)
  const numeric = numericTokens(norm)
  const words = new Set(
    norm
      .replace(/[^a-z0-9%$ ]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t && !STOPWORDS.has(t) && !/\d/.test(t))
  )
  return { numeric: numeric.length ? numeric : ['none'], words }
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let common = 0
  a.forEach((t) => { if (b.has(t)) common++ })
  const union = a.size + b.size - common
  return union === 0 ? 0 : common / union
}

function isSubset(a: Set<string>, b: Set<string>): boolean {
  let ok = true
  a.forEach((t) => { if (!b.has(t)) ok = false })
  return ok
}

export type FactVerdict =
  | { class: 'HIGH'; rule: 'statement_norm'; jaccard: number }
  | { class: 'POSSIBLE'; rule: 'near_duplicate_statement' | 'similar_statement'; jaccard: number }
  | { class: 'CONFLICT'; rule: 'same_claim_different_numbers'; jaccard: number; numbers: [string[], string[]] }
  | null

export const FACT_HIGH_JACCARD = 0.8
export const FACT_POSSIBLE_JACCARD = 0.6

export function compareFacts(a: EvidenceFact, b: EvidenceFact): FactVerdict {
  if (normalizeStatement(a.statement) === normalizeStatement(b.statement)) {
    return { class: 'HIGH', rule: 'statement_norm', jaccard: 1 }
  }
  const ta = statementTokens(a.statement)
  const tb = statementTokens(b.statement)
  const j = jaccard(ta.words, tb.words)
  const sameNumbers = ta.numeric.join('|') === tb.numeric.join('|')
  if (!sameNumbers) {
    if (j >= FACT_POSSIBLE_JACCARD) {
      return { class: 'CONFLICT', rule: 'same_claim_different_numbers', jaccard: j, numbers: [ta.numeric, tb.numeric] }
    }
    return null
  }
  // Near-duplicates are a suggestion, never automatic (KNOWLEDGE_BASE_DEDUP_PLAN
  // "Fact merging rules"): only statement_norm equality is HIGH.
  if (j >= FACT_HIGH_JACCARD) return { class: 'POSSIBLE', rule: 'near_duplicate_statement', jaccard: j }
  if (j >= FACT_POSSIBLE_JACCARD) return { class: 'POSSIBLE', rule: 'similar_statement', jaccard: j }
  return null
}

/**
 * The wording both sources support: the statement whose words are a subset
 * of the other's (the weaker claim), else the résumé's, else the shorter.
 */
export function safestWording(a: EvidenceFact, b: EvidenceFact): { keep: EvidenceFact; other: EvidenceFact } {
  const ta = statementTokens(a.statement).words
  const tb = statementTokens(b.statement).words
  const aSub = isSubset(ta, tb)
  const bSub = isSubset(tb, ta)
  if (aSub && !bSub) return { keep: a, other: b }
  if (bSub && !aSub) return { keep: b, other: a }
  if (a.source === 'master_resume' && b.source !== 'master_resume') return { keep: a, other: b }
  if (b.source === 'master_resume' && a.source !== 'master_resume') return { keep: b, other: a }
  return a.statement.length <= b.statement.length ? { keep: a, other: b } : { keep: b, other: a }
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

export function contextTokens(context: string | null): Set<string> {
  return statementTokens(context ?? '').words
}

export const METRIC_CONTEXT_OVERLAP = 0.5

// ─── Experience pair verdicts ────────────────────────────────────────────────

export type ExperienceVerdict =
  | { class: 'HIGH'; rule: 'exact_title' | 'similar_title'; similarity: number }
  | { class: 'POSSIBLE'; rule: 'near_title' | 'same_org_same_dates' | 'different_qualifier'; similarity: number; overlap: number | null; titleConflict: boolean }
  | { class: 'NEVER'; rule: 'disjoint_dates' | 'different_title' | 'kind' | 'org'; similarity: number }

export const DATE_OVERLAP_THRESHOLD = 0.8

/**
 * Which of the two rows is the canonical one: a row the user edited by hand
 * first (their edits must survive), then the résumé row, then the older.
 */
export function preferKeep(a: EvidenceExperience, b: EvidenceExperience): [EvidenceExperience, EvidenceExperience] {
  const ae = a.edited_by_user ?? false
  const be = b.edited_by_user ?? false
  if (ae !== be) return ae ? [a, b] : [b, a]
  const am = a.source === 'master_resume'
  const bm = b.source === 'master_resume'
  if (am !== bm) return am ? [a, b] : [b, a]
  return a.created_at <= b.created_at ? [a, b] : [b, a]
}

export function compareExperiences(a: EvidenceExperience, b: EvidenceExperience, nowMonth: number): ExperienceVerdict {
  if (orgKey(a.organization) !== orgKey(b.organization)) return { class: 'NEVER', rule: 'org', similarity: 0 }
  if (!kindsMergeable(a.kind, b.kind)) return { class: 'NEVER', rule: 'kind', similarity: 0 }
  const similarity = Number(titleScore(a.title, b.title).toFixed(2))
  const sameTitle = titleKey(a.title) === titleKey(b.title)
  if (a.kind === 'award' && b.kind === 'award' && !sameTitle) return { class: 'NEVER', rule: 'different_title', similarity }
  const compatible = datesCompatible(a, b)
  if (!compatible) return { class: 'NEVER', rule: 'disjoint_dates', similarity }
  if (!sameTitle && differsByRankModifier(a.title, b.title)) return { class: 'NEVER', rule: 'different_title', similarity }

  const qualifiers = compareQualifiers(a.organization, b.organization)
  if (sameTitle || similarity >= SIMILAR_TITLE_THRESHOLD) {
    if (qualifiers === 'different') {
      return { class: 'POSSIBLE', rule: 'different_qualifier', similarity, overlap: null, titleConflict: !sameTitle }
    }
    // One side carries a qualifier the other lacks ("UIUC (Mironenko lab)" vs
    // "University of Illinois") or the two differ by a site, and no dates on
    // either side can tell two labs or two sites apart: hold for a human.
    const anyQualifier = qualifierOf(a.organization) !== null || qualifierOf(b.organization) !== null
    if (anyQualifier && qualifiers !== 'same' && dateOverlapRatio(a, b, nowMonth) === null) {
      return { class: 'POSSIBLE', rule: 'different_qualifier', similarity, overlap: null, titleConflict: !sameTitle }
    }
    return { class: 'HIGH', rule: sameTitle ? 'exact_title' : 'similar_title', similarity }
  }
  if (similarity >= NEAR_MISS_THRESHOLD) {
    return { class: 'POSSIBLE', rule: 'near_title', similarity, overlap: null, titleConflict: true }
  }
  // Same org, same period, any title — but only for rows that could be the
  // same job: equal kinds, or a plain 'experience'/'other' row on either side.
  // Two IMSA rows of different kinds (research vs leadership) stay apart.
  const kindOk = a.kind === b.kind || ['experience', 'other'].includes(a.kind) || ['experience', 'other'].includes(b.kind)
  const overlap = kindOk ? dateOverlapRatio(a, b, nowMonth) : null
  if (overlap !== null && overlap >= DATE_OVERLAP_THRESHOLD) {
    return { class: 'POSSIBLE', rule: 'same_org_same_dates', similarity, overlap: Number(overlap.toFixed(2)), titleConflict: true }
  }
  return { class: 'NEVER', rule: 'different_title', similarity }
}
