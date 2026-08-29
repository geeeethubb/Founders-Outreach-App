// The deterministic checks behind the Resume Importer's validate().
//
// Pure string functions, no model, no I/O. They are the guarantee: a fact
// whose numbers the cited paragraph does not contain is a fabrication by
// construction, and a skill the text never names is too. The prompt asks the
// model to keep numbers verbatim; these functions are what make it true.

/**
 * Numeric tokens in a piece of text, normalized so that the same quantity
 * written two ways compares equal: "1,600" → "1600", "$4 million" → "4M",
 * "3.8M" → "3.8M", "30 %" → "30%", "73k" → "73k". "+" is dropped — "1,600+"
 * asserts at least 1,600 and a fact saying "1600" is not a fabrication.
 */
export function numberTokens(text: string): string[] {
  const re = /\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(million|billion|thousand|[kKmMbB%])?(?![\w.])/g
  const out: string[] = []
  for (const m of text.matchAll(re)) {
    const core = m[1].replace(/,/g, '')
    const raw = (m[2] ?? '').toLowerCase()
    let suffix = ''
    if (raw === 'million' || raw === 'm') suffix = 'M'
    else if (raw === 'billion' || raw === 'b') suffix = 'B'
    else if (raw === 'thousand' || raw === 'k') suffix = 'k'
    else if (raw === '%') suffix = '%'
    out.push(`${core}${suffix}`)
  }
  return out
}

function coreOf(token: string): string {
  return token.replace(/[Mk%B]$/, '')
}

/**
 * True when every number in `statement` is asserted by `sourceText`. A token
 * matches on identical normalized form, or on identical digits when the
 * statement carries no suffix (the source's "$4M+" covers a statement's "4").
 */
export function numbersSupported(statement: string, sourceText: string): { ok: boolean; missing: string[] } {
  const have = numberTokens(sourceText)
  const haveCores = new Set(have.map(coreOf))
  const haveSet = new Set(have)
  const missing: string[] = []
  for (const t of numberTokens(statement)) {
    if (haveSet.has(t)) continue
    if (t === coreOf(t) && haveCores.has(t)) continue
    missing.push(t)
  }
  return { ok: missing.length === 0, missing }
}

const CONTENT_STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'in', 'at', 'to', 'for', 'and', 'or', 'on', 'by', 'with', 'all', 'across',
  'as', 'from', 'into', 'is', 'was', 'were', 'be', 'been', 'that', 'this', 'its', 'it', 'over', 'per',
  'new', 'our', 'we', 'my', 'i', 'their', 'his', 'her', 'has', 'have', 'had', 'are', 'not', 'via',
])

/** Lowercase alphabetic words carrying meaning: no stopwords, no numbers, no one-letter tokens. */
export function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((w) => w.length > 1 && !CONTENT_STOPWORDS.has(w) && !/\d/.test(w))
  )
}

/**
 * How many content words two texts share. The bar a `corroborates` claim
 * must clear: a line that names none of the existing fact's words cannot be
 * a restatement of it, whatever the model says.
 */
export function sharedContentWords(a: string, b: string): number {
  const wb = contentWords(b)
  let n = 0
  contentWords(a).forEach((w) => { if (wb.has(w)) n++ })
  return n
}

/**
 * A skill is supported when its name appears in the text (case-insensitive),
 * or every word of it does — "techno-economic analysis" against "techno-economic
 * analysis for biofuel separation", "VASP" against "ASE/VASP".
 */
export function skillSupported(name: string, sourceText: string): boolean {
  const hay = sourceText.toLowerCase()
  const needle = name.toLowerCase().trim()
  if (!needle) return false
  if (hay.includes(needle)) return true
  const words = needle.split(/[\s/,()-]+/).filter((w) => w.length > 1)
  if (words.length === 0) return false
  const tokens = new Set(hay.split(/[^a-z0-9+#.]+/).map((t) => t.replace(/[.]+$/, '')))
  return words.every((w) => tokens.has(w))
}
