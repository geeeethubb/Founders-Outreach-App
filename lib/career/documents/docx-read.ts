// Read-only view of a DOCX body: paragraphs, runs, bullets, emphasis.
//
// This is the shared parsing layer under both the résumé importer (which maps
// paragraphs to Evidence Bank bullets) and the document engine (which edits
// paragraphs in place). It deliberately works on the raw WordprocessingML
// string rather than a DOM, because the editing layer needs to write back
// byte-identical XML for every paragraph it did not touch — a parse/serialize
// round trip through a generic XML library reorders attributes and drops
// namespace declarations, and Word notices.
//
// Scope: top-level body paragraphs. The master résumé has no tables; a table
// cell paragraph would be reported at top level, which is acceptable for the
// documents this handles and is asserted by the QA layer.

import JSZip from 'jszip'

export interface DocxRun {
  /** Raw `<w:r>…</w:r>` XML. */
  xml: string
  /** Decoded text, with tabs as "\t" and breaks as "\n". */
  text: string
  bold: boolean
  italic: boolean
  /** Raw `<w:rPr>…</w:rPr>` or null when the run has none. */
  rPr: string | null
}

export interface DocxParagraph {
  /** Position among top-level body paragraphs, 0-based. */
  index: number
  /** Raw `<w:p …>…</w:p>` XML, exactly as stored. */
  xml: string
  /** Raw `<w:pPr>…</w:pPr>` or null. */
  pPr: string | null
  text: string
  isBullet: boolean
  numId: string | null
  ilvl: number | null
  runs: DocxRun[]
}

export interface DocxBody {
  /** Everything before the first top-level paragraph (the `<w:body>` open tag and any leading content). */
  head: string
  /** Paragraph XML and the inter-paragraph gaps, alternating: gaps[i] precedes paragraphs[i]; gaps[n] is the tail. */
  paragraphs: DocxParagraph[]
  gaps: string[]
}

export interface DocxFile {
  zip: JSZip
  documentXml: string
  body: DocxBody
}

// ─── XML text helpers ────────────────────────────────────────────────────────

export function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
}

export function encodeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Text of one run: `<w:t>` content, `<w:tab/>` → "\t", `<w:br/>` → "\n". */
export function runText(runXml: string): string {
  let out = ''
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:t\s*\/>|<w:tab\s*\/>|<w:br(?:\s[^>]*)?\/>|<w:cr\s*\/>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(runXml))) {
    const token = m[0]
    if (token.startsWith('<w:tab')) out += '\t'
    else if (token.startsWith('<w:br') || token.startsWith('<w:cr')) out += '\n'
    else if (m[1] !== undefined) out += decodeXml(m[1])
  }
  return out
}

function extractBlock(xml: string, tag: string): string | null {
  const open = xml.indexOf(`<${tag}>`)
  const openAttr = xml.indexOf(`<${tag} `)
  const start = open >= 0 && (openAttr < 0 || open < openAttr) ? open : openAttr
  if (start < 0) return null
  const selfClose = xml.indexOf('/>', start)
  const gt = xml.indexOf('>', start)
  if (selfClose >= 0 && selfClose < gt) return xml.slice(start, selfClose + 2)
  const end = xml.indexOf(`</${tag}>`, start)
  if (end < 0) return null
  return xml.slice(start, end + tag.length + 3)
}

function hasToggle(rPr: string | null, tag: 'w:b' | 'w:i'): boolean {
  if (!rPr) return false
  // `<w:b/>` or `<w:b w:val="1"/>` is on; `<w:b w:val="0"/>` / "false" is off.
  const m = rPr.match(new RegExp(`<${tag}(?:\\s+w:val="([^"]*)")?\\s*/>`))
  if (!m) return false
  const v = m[1]
  return v === undefined || v === '1' || v === 'true' || v === 'on'
}

// ─── Paragraph parsing ───────────────────────────────────────────────────────

/** Split a paragraph's XML into runs. Hyperlinks contribute their inner runs. */
export function parseRuns(paragraphXml: string): DocxRun[] {
  const runs: DocxRun[] = []
  const re = /<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(paragraphXml))) {
    const xml = m[0]
    const rPr = extractBlock(xml, 'w:rPr')
    runs.push({
      xml,
      text: runText(xml),
      bold: hasToggle(rPr, 'w:b'),
      italic: hasToggle(rPr, 'w:i'),
      rPr,
    })
  }
  return runs
}

export function parseParagraph(xml: string, index: number): DocxParagraph {
  const pPr = extractBlock(xml, 'w:pPr')
  const numPr = pPr ? extractBlock(pPr, 'w:numPr') : null
  const numId = numPr?.match(/<w:numId\s+w:val="([^"]+)"/)?.[1] ?? null
  const ilvlRaw = numPr?.match(/<w:ilvl\s+w:val="([^"]+)"/)?.[1]
  const runs = parseRuns(xml)
  return {
    index,
    xml,
    pPr,
    text: runs.map((r) => r.text).join(''),
    isBullet: numId !== null,
    numId,
    ilvl: ilvlRaw !== undefined ? Number(ilvlRaw) : null,
    runs,
  }
}

/**
 * Tokenize the body into top-level paragraphs and the gaps between them, so
 * that `head + gaps[0] + p[0].xml + gaps[1] + p[1].xml + … + gaps[n]` is the
 * original document byte-for-byte.
 */
export function splitBody(documentXml: string): DocxBody {
  const bodyOpen = documentXml.indexOf('<w:body>')
  if (bodyOpen < 0) throw new Error('document.xml has no <w:body>')
  const head = documentXml.slice(0, bodyOpen + '<w:body>'.length)
  const rest = documentXml.slice(bodyOpen + '<w:body>'.length)

  const paragraphs: DocxParagraph[] = []
  const gaps: string[] = []
  let cursor = 0
  let index = 0
  const openRe = /<w:p(?=[\s>])/g
  openRe.lastIndex = 0

  while (true) {
    openRe.lastIndex = cursor
    const open = openRe.exec(rest)
    if (!open) break
    const start = open.index
    const close = rest.indexOf('</w:p>', start)
    if (close < 0) break
    const end = close + '</w:p>'.length
    gaps.push(rest.slice(cursor, start))
    paragraphs.push(parseParagraph(rest.slice(start, end), index++))
    cursor = end
  }
  gaps.push(rest.slice(cursor))

  return { head, paragraphs, gaps }
}

export function joinBody(body: DocxBody): string {
  let out = body.head
  for (let i = 0; i < body.paragraphs.length; i++) {
    out += body.gaps[i] + body.paragraphs[i].xml
  }
  out += body.gaps[body.paragraphs.length]
  return out
}

// ─── Emphasis-aware text ─────────────────────────────────────────────────────

export interface TextSegment {
  text: string
  bold: boolean
}

/** Adjacent runs with the same bold state are merged. Tabs collapse to a single space. */
export function paragraphSegments(p: DocxParagraph): TextSegment[] {
  const segments: TextSegment[] = []
  for (const r of p.runs) {
    const text = r.text.replace(/\t+/g, ' ')
    if (!text) continue
    const last = segments[segments.length - 1]
    if (last && last.bold === r.bold) last.text += text
    else segments.push({ text, bold: r.bold })
  }
  return segments
}

/**
 * Plain text with `**bold**` markers around emphasized spans. Whitespace at a
 * span boundary is moved outside the markers so `** **` never appears. This is
 * the format `resume_bullets.text` stores.
 */
export function paragraphMarkdown(p: DocxParagraph): string {
  let out = ''
  for (const seg of paragraphSegments(p)) {
    if (!seg.bold) {
      out += seg.text
      continue
    }
    const lead = seg.text.match(/^\s*/)?.[0] ?? ''
    const trail = seg.text.match(/\s*$/)?.[0] ?? ''
    const core = seg.text.trim()
    if (!core) {
      out += seg.text
      continue
    }
    out += `${lead}**${core}**${trail}`
  }
  return out.replace(/[  ]{2,}/g, ' ').trim()
}

/** Strip `**` markers. What the verifier and the QA text-match see. */
export function stripMarkdown(s: string): string {
  return s.replace(/\*\*/g, '')
}

// ─── Loading ─────────────────────────────────────────────────────────────────

export async function readDocx(buffer: Buffer | Uint8Array): Promise<DocxFile> {
  const zip = await JSZip.loadAsync(buffer)
  const entry = zip.file('word/document.xml')
  if (!entry) throw new Error('not a DOCX: word/document.xml missing')
  const documentXml = await entry.async('string')
  return { zip, documentXml, body: splitBody(documentXml) }
}

/** Rewrite word/document.xml from a (possibly edited) body and return the new package bytes. */
export async function writeDocx(file: DocxFile, body: DocxBody): Promise<Buffer> {
  const xml = joinBody(body)
  file.zip.file('word/document.xml', xml)
  const out = await file.zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  })
  return out
}

/** Page size and margins from the final section, in twips. */
export function readPageSetup(documentXml: string): { widthTwips: number; heightTwips: number; margins: Record<string, number> } | null {
  const sect = documentXml.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/)?.[0]
  if (!sect) return null
  const pg = sect.match(/<w:pgSz\s+w:w="(\d+)"\s+w:h="(\d+)"/)
  const mar = sect.match(/<w:pgMar([^>]*)\/>/)?.[1] ?? ''
  const margins: Record<string, number> = {}
  for (const m of mar.matchAll(/w:(\w+)="(-?\d+)"/g)) margins[m[1]] = Number(m[2])
  return { widthTwips: pg ? Number(pg[1]) : 12240, heightTwips: pg ? Number(pg[2]) : 15840, margins }
}

/** Distinct font families named in run properties. QA asserts nothing new appears. */
export function fontsUsed(documentXml: string): string[] {
  const set = new Set<string>()
  for (const m of documentXml.matchAll(/w:rFonts\s+[^>]*w:ascii="([^"]+)"/g)) set.add(m[1])
  return Array.from(set)
}

// ─── Fingerprints the document engine must not change ────────────────────────

/** Distinct `w:sz` values (half-points) in run and paragraph-mark properties. The "no tiny fonts" rule compares sets. */
export function fontSizesUsed(documentXml: string): string[] {
  const set = new Set<string>()
  for (const m of documentXml.matchAll(/<w:sz\s+w:val="(\d+)"/g)) set.add(m[1])
  return Array.from(set).sort((a, b) => Number(a) - Number(b))
}

/** The final `<w:sectPr>` verbatim — page size, margins, columns. Null when absent. */
export function sectPrOf(documentXml: string): string | null {
  const all = documentXml.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/g)
  return all ? all[all.length - 1] : null
}

/** Every paragraph's text joined by newlines, tabs as single spaces. */
export function documentText(file: DocxFile): string {
  return file.body.paragraphs.map((p) => p.text.replace(/\t+/g, ' ')).join('\n')
}
