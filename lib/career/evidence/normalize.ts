// Canonical forms for the strings the Evidence Bank dedupes on.
//
// The bank is idempotent by content, and "content" arrives spelled three
// ways: the DOCX says "Procter & Gamble", LinkedIn says "P&G", the founder
// types "Procter & Gamble, Tabler Station". Text imports let the importer
// agent author organization and title strings outright, so every re-import is
// a fresh chance for a variant. Comparing raw lowercase strings made each
// variant a second experience row — and every fact, metric and bullet under
// it a second copy.
//
// Everything here is pure and deterministic. Nothing guesses: a normalizer
// maps a spelling to a canonical spelling, and the persist plan decides what
// to do with equal keys. The alias table is the one place judgment lives, and
// it is a founder-editable list, like SYNONYM_GROUPS in ./retrieve.

// ─── Organizations ───────────────────────────────────────────────────────────

/**
 * Canonical org spellings, keyed by the already-normalized form. Deliberately
 * small: an alias table that grows by accretion becomes a way for every org to
 * match every other. Add a line when a real duplicate shows up in the bank.
 */
export const ORG_ALIASES: Record<string, string> = {
  'p and g': 'procter and gamble',
  'pg': 'procter and gamble',
  'procter and gamble tabler station': 'procter and gamble',
  'uiuc': 'university of illinois',
  'university of illinois at urbana champaign': 'university of illinois',
  'university of illinois urbana champaign': 'university of illinois',
  'university of illinois urbana': 'university of illinois',
  'founders': 'founders illinois entrepreneurs',
  'founders illinois entrepreneurs uiuc': 'founders illinois entrepreneurs',
  'argonne': 'argonne national laboratory',
  'argonne national lab': 'argonne national laboratory',
  'ibc': 'illinois business consulting',
  'yc': 'y combinator',
}

const LEGAL_SUFFIXES = new Set(['inc', 'llc', 'ltd', 'corp', 'co', 'company', 'corporation', 'incorporated', 'plc', 'gmbh'])

export function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

/** Lowercase words separated by single spaces; punctuation is a separator. */
function words(s: string): string[] {
  return stripDiacritics(s)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
}

/**
 * Alias table or exact normalized equality only — never substring. "PG
 * Solutions" and "Pacific Gas" normalize to their own keys and stay there;
 * only the exact key "pg" is Procter & Gamble.
 */
export function normalizeOrg(raw: string): string {
  // "(UIUC)", "(formerly X)" — a qualifier, not the name.
  const withoutParens = raw.replace(/\([^)]*\)/g, ' ')
  let w = words(withoutParens)
  if (w[0] === 'the') w = w.slice(1)
  while (w.length > 1 && LEGAL_SUFFIXES.has(w[w.length - 1])) w = w.slice(0, -1)
  const joined = w.join(' ')
  return ORG_ALIASES[joined] ?? joined
}

/**
 * The part of an organization string that normalizeOrg throws away: the
 * parentheticals and what follows the first comma. "University of Illinois
 * (Professor Alex Mironenko's lab)" → "Professor Alex Mironenko's lab";
 * "Procter & Gamble, Tabler Station" → "Tabler Station". Two rows with the
 * same normalized org and different qualifiers may be two labs, not one —
 * the consolidation engine reads this before proposing a merge.
 */
export function orgQualifier(raw: string): string {
  const parts: string[] = []
  for (const m of raw.matchAll(/\(([^)]*)\)/g)) {
    const inner = m[1].trim()
    // A bare acronym in parentheses ("(UIUC)") names the org, not a sub-unit.
    if (inner && !/^[A-Z&.]{2,8}$/.test(inner)) parts.push(inner)
  }
  const head = raw.replace(/\([^)]*\)/g, ' ')
  const comma = head.indexOf(',')
  if (comma >= 0) {
    const tail = head.slice(comma + 1).replace(/\s+/g, ' ').trim()
    if (tail) parts.push(tail)
  }
  return parts.join('; ')
}

// ─── Titles ──────────────────────────────────────────────────────────────────

const TITLE_NOISE = new Set(['former', 'formerly', 'prev', 'previously', 'previous', 'ex'])

/**
 * "President, Founders" → "president"; "Project Manager, prev. Senior
 * Consultant" → "project manager". What follows a comma, dash, semicolon or
 * pipe is a qualifier (the org again, an earlier role), and the résumé's
 * own title is what came first. A slash is NOT a separator: "Co-Founder /
 * CEO" and "Co-Founder / CTO" are two jobs, and splitting there would make
 * them one.
 */
export function normalizeTitle(raw: string): string {
  // "President (previously Head of Events, Events Team Member)" — the
  // parenthetical is history, and it must go before the comma split or the
  // head would be "President (previously Head of Events".
  const withoutParens = stripDiacritics(raw).replace(/\([^)]*\)/g, ' ')
  const head = withoutParens.split(/[,;|]|\s[-–—]\s|[–—]/)[0]
  return words(head).filter((t) => !TITLE_NOISE.has(t)).join(' ')
}

export function experienceKey(organization: string, title: string): string {
  return `${normalizeOrg(organization)}::${normalizeTitle(title)}`
}

/**
 * Title-similarity bands shared by the persist plan (./plan) and the
 * consolidation rules (./consolidate-rules). They live here, below both, so
 * neither has to import the other: ≥ 0.6 is the same job, [0.3, 0.6) is a
 * near miss a human decides.
 */
export const SIMILAR_TITLE_THRESHOLD = 0.6
export const NEAR_MISS_THRESHOLD = 0.3

/**
 * Words that grade a title without changing what the job is. Only these may
 * be ignored when one title contains the other: "Senior Project Manager" IS
 * a project manager, but "Vice President" is not the president and a
 * "Software Intern" is not every intern. Anything else that differs is a
 * different job until the plain overlap says otherwise.
 */
const SENIORITY_QUALIFIERS = new Set(['senior', 'sr', 'junior', 'jr', 'staff', 'principal', 'summer', 'co'])

/**
 * Token Jaccard over normalized titles, 0–1. One title contained in the other
 * counts as 1 only when the leftover words are all seniority qualifiers
 * ("project manager" / "senior project manager"); "president" inside "vice
 * president" scores 0.5 and lands in the near-miss band, where a human decides.
 */
export function titleSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeTitle(a).split(' ').filter(Boolean))
  const tb = new Set(normalizeTitle(b).split(' ').filter(Boolean))
  if (ta.size === 0 || tb.size === 0) return 0
  let common = 0
  ta.forEach((t) => { if (tb.has(t)) common++ })
  if (common === ta.size || common === tb.size) {
    const larger = ta.size >= tb.size ? ta : tb
    const smaller = larger === ta ? tb : ta
    let onlyQualifiers = true
    larger.forEach((t) => { if (!smaller.has(t) && !SENIORITY_QUALIFIERS.has(t)) onlyQualifiers = false })
    if (onlyQualifiers) return 1
  }
  return common / (ta.size + tb.size - common)
}

// ─── Dates ───────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
}

export type ParsedDate = { year: number; month: number | null } | 'present' | null

/**
 * Free-text résumé dates: "5/2026", "May 2026", "2024-09", "Sep. 2024",
 * "Present", "2025". Null when there is nothing to parse — the caller treats
 * that as "unknown", never as a mismatch.
 */
export function parseResumeDate(raw: string | null | undefined): ParsedDate {
  if (!raw) return null
  const s = raw.trim().toLowerCase()
  if (/^(present|current|now|ongoing|today)\b/.test(s)) return 'present'
  let m = s.match(/^(\d{1,2})\s*[/.-]\s*(\d{4})$/)
  if (m) return { year: Number(m[2]), month: Number(m[1]) }
  m = s.match(/^(\d{4})\s*[/.-]\s*(\d{1,2})$/)
  if (m) return { year: Number(m[1]), month: Number(m[2]) }
  m = s.match(/^([a-z]+)\.?\s+(\d{4})$/)
  if (m && MONTHS[m[1]]) return { year: Number(m[2]), month: MONTHS[m[1]] }
  m = s.match(/^(\d{4})$/)
  if (m) return { year: Number(m[1]), month: null }
  m = s.match(/(\d{4})/)
  if (m) return { year: Number(m[1]), month: null }
  return null
}

/** Month index; a bare year spans the whole year, in the direction the bound leans. */
function monthIndex(d: ParsedDate, bound: 'start' | 'end'): number | null {
  if (d === null) return null
  if (d === 'present') return Number.POSITIVE_INFINITY
  const month = d.month ?? (bound === 'start' ? 1 : 12)
  return d.year * 12 + month
}

export interface DateRange {
  start_date: string | null | undefined
  end_date: string | null | undefined
}

/**
 * True unless both ranges are known and disjoint. Overlapping or touching
 * (one ends the month the other starts) is compatible; an unparseable or
 * missing side is compatible, because absence of a date is not evidence of a
 * different job.
 */
export function datesCompatible(a: DateRange, b: DateRange): boolean {
  const aStart = monthIndex(parseResumeDate(a.start_date), 'start')
  const aEnd = monthIndex(parseResumeDate(a.end_date), 'end')
  const bStart = monthIndex(parseResumeDate(b.start_date), 'start')
  const bEnd = monthIndex(parseResumeDate(b.end_date), 'end')
  const lo = (s: number | null) => (s === null ? Number.NEGATIVE_INFINITY : s)
  const hi = (e: number | null) => (e === null ? Number.POSITIVE_INFINITY : e)
  const aS = lo(aStart), aE = hi(aEnd), bS = lo(bStart), bE = hi(bEnd)
  // A start-only range with no end is open-ended; a range that is entirely
  // unknown is (-inf, +inf) and overlaps everything.
  return aS <= bE && bS <= aE
}

// ─── Statements, metric values ───────────────────────────────────────────────

/**
 * "Organized Forge 2026." and "organized forge 2026" are the same claim.
 * Different words are different claims — this never touches vocabulary.
 */
export function normalizeStatement(raw: string): string {
  return raw
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—‒―]/g, '-')
    .replace(/…/g, '...')
    .replace(/\*\*|__|(?<!\w)[*_](?=\w)|(?<=\w)[*_](?!\w)/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.]+$/, '')
    .trim()
}

/** "$4M+" / "4M" / "4 million" / "$4,000,000" collapse; "4M" and "4B" do not. */
export function normalizeMetricValue(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\bbillion\b/g, 'b')
    .replace(/\bmillion\b/g, 'm')
    .replace(/\bthousand\b/g, 'k')
    .replace(/\bpercent\b|\bpct\b/g, '%')
    .replace(/[+$€£¥,\s]/g, '')
    .replace(/(\d)mm\b/g, '$1m')
    .trim()
}
