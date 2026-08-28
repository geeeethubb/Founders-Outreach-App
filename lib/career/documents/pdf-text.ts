// What a rendered PDF actually contains: pages, text per page, fonts.
//
// This is the ground truth QA reads. A DOCX can claim anything; the PDF is
// what the recruiter opens. pdfjs is loaded lazily (its legacy Node build is
// an ES module) and failure to load degrades to a page count from the raw
// bytes — a weaker signal, reported as such, never a silent zero.

import fs from 'fs'

export interface PdfInfo {
  pageCount: number
  /** Text per page, reading order as pdfjs reports it, with line breaks where the baseline moves. */
  pages: string[]
  /** Base font names with subset prefixes stripped, e.g. "Calibri", "Calibri-Bold". Empty when unavailable. */
  fonts: string[]
  /** Which path produced the numbers. */
  method: 'pdfjs' | 'regex'
  fontsNote?: string
}

type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs')

let pdfjsPromise: Promise<PdfjsModule | null> | null = null

async function loadPdfjs(): Promise<PdfjsModule | null> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').catch(() => null)
  }
  return pdfjsPromise
}

/** `/Type /Page` objects (not `/Pages`). Works on uncompressed object dictionaries, which Word emits. */
export function pdfPageCountFallback(bytes: Buffer): number | null {
  const latin = bytes.toString('latin1')
  const n = (latin.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length
  return n > 0 ? n : null
}

/** `/BaseFont /ABCDEF+Calibri-Bold` → "Calibri-Bold". */
function stripSubsetPrefix(name: string): string {
  return name.replace(/^[A-Z]{6}\+/, '')
}

function fontsFromBytes(bytes: Buffer): string[] {
  const latin = bytes.toString('latin1')
  const set = new Set<string>()
  for (const m of latin.matchAll(/\/BaseFont\s*\/([^\s/>\]]+)/g)) set.add(stripSubsetPrefix(m[1]))
  return Array.from(set).sort()
}

interface TextItemLike {
  str?: string
  transform?: number[]
  hasEOL?: boolean
}

function pageText(items: TextItemLike[]): string {
  let out = ''
  let lastY: number | null = null
  for (const it of items) {
    if (typeof it.str !== 'string') continue
    const y = it.transform ? it.transform[5] : null
    if (lastY !== null && y !== null && Math.abs(y - lastY) > 1.5) out += '\n'
    else if (out.length && !out.endsWith('\n') && !out.endsWith(' ') && it.str && !it.str.startsWith(' ')) out += ' '
    out += it.str
    if (it.hasEOL) out += '\n'
    if (y !== null) lastY = y
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim()
}

export async function pdfInfo(pdfPath: string): Promise<PdfInfo> {
  const bytes = fs.readFileSync(pdfPath)
  const pdfjs = await loadPdfjs()
  if (!pdfjs) {
    return {
      pageCount: pdfPageCountFallback(bytes) ?? 0,
      pages: [],
      fonts: fontsFromBytes(bytes),
      method: 'regex',
      fontsNote: 'pdfjs failed to load; fonts read from raw /BaseFont entries, text unavailable',
    }
  }

  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, verbosity: 0 }).promise
  const pages: string[] = []
  const fonts = new Set<string>()
  let fontsNote: string | undefined
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      pages.push(pageText(content.items as TextItemLike[]))
      // Font objects are only resolved once the operator list has been built;
      // after that the text items' internal font ids map to real names.
      try {
        await page.getOperatorList()
        for (const it of content.items as { fontName?: string }[]) {
          if (!it.fontName) continue
          const obj = page.commonObjs.has(it.fontName) ? (page.commonObjs.get(it.fontName) as { name?: string }) : null
          if (obj?.name) fonts.add(stripSubsetPrefix(obj.name))
        }
      } catch (err) {
        fontsNote = `font names unavailable from pdfjs: ${err instanceof Error ? err.message : String(err)}`
      }
    }
  } finally {
    await doc.destroy()
  }
  let fontList = Array.from(fonts).sort()
  if (fontList.length === 0) {
    fontList = fontsFromBytes(bytes)
    if (fontList.length === 0) fontsNote = fontsNote ?? 'no font names found by pdfjs or in raw /BaseFont entries'
  }
  return { pageCount: doc.numPages, pages, fonts: fontList, method: 'pdfjs', fontsNote }
}
