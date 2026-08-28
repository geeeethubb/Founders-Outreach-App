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
