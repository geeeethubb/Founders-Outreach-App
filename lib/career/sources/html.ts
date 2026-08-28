// HTML → text, title and links, without a DOM.
//
// Job boards return descriptions as HTML (Greenhouse even HTML-escapes it once
// more), and careers pages are full documents. Everything downstream — the
// extractor, dedupe shingles, the verifier's title check — wants plain text
// with paragraph breaks preserved so a `<li>` list does not collapse into one
// run-on sentence. A regex pass is enough for that and needs no dependency.

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', bull: '•', middot: '·',
  copy: '©', reg: '®', trade: '™', eacute: 'é', egrave: 'è', uuml: 'ü', ouml: 'ö', auml: 'ä',
}

export function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
}

function safeCodePoint(code: number): string {
  try {
    return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : ''
  } catch {
    return ''
  }
}

/** True when the string is HTML that was escaped once more (Greenhouse `content`). */
export function looksDoubleEscaped(input: string): boolean {
  return /&lt;\/?[a-z][^&]*&gt;/i.test(input.slice(0, 2000))
}

const LINE_TAGS = 'br|li|tr|dd|dt'
const BLOCK_TAGS = 'p|div|ul|ol|h[1-6]|table|section|article|header|footer|blockquote|pre|hr|dl|form|fieldset'

/**
 * Visible text with paragraph breaks. Scripts, styles and comments are dropped
 * entirely; block-level tags become newlines; runs of whitespace collapse.
 */
export function htmlToText(html: string | null | undefined, maxChars = 60_000): string {
  if (!html) return ''
  let s = looksDoubleEscaped(html) ? decodeEntities(html) : html
  s = s
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(new RegExp(`<\\/(${LINE_TAGS})\\s*>`, 'gi'), '')
    .replace(new RegExp(`<(${LINE_TAGS})\\b[^>]*>`, 'gi'), '\n')
    .replace(new RegExp(`<\\/?(${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n\n')
    .replace(/<[^>]+>/g, ' ')
  s = decodeEntities(s)
  s = s
    .replace(/ /g, ' ')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return s.length > maxChars ? s.slice(0, maxChars) : s
}

export function extractTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (!m) return null
  const t = decodeEntities(m[1]).replace(/\s+/g, ' ').trim()
  return t || null
}

export interface ExtractedLink {
  url: string
  text: string
}

/** Absolute http(s) links with their anchor text, deduped by URL, document order. */
export function extractLinks(html: string, baseUrl: string, max = 800): ExtractedLink[] {
  const out: ExtractedLink[] = []
  const seen = new Set<string>()
  const re = /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) && out.length < max) {
    const href = decodeEntities(m[1] ?? m[2] ?? m[3] ?? '').trim()
    if (!href || /^(javascript|mailto|tel|#)/i.test(href)) continue
    let abs: string
    try {
      abs = new URL(href, baseUrl).toString()
    } catch {
      continue
    }
    if (!/^https?:/i.test(abs)) continue
    abs = abs.replace(/#.*$/, '')
    if (seen.has(abs)) continue
    seen.add(abs)
    out.push({ url: abs, text: htmlToText(m[4], 300).replace(/\n+/g, ' ').trim() })
  }
  return out
}
