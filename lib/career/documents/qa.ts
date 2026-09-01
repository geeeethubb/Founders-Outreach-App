// Document QA — deterministic, every check measurable, results shown to the human.
//
// This is the rejected "Document QA agent" done as code (docs/CAREER_OS.md §3).
// A model asked "does this look right?" is less reliable than pdfjs counting
// pages, so nothing here is a judgment call: a page count is a number, a
// font set is a set, a bullet is present in the extracted text or it is not.
// Blocking checks stop a package from becoming READY_FOR_REVIEW; the rest are
// surfaced as warnings and never hidden (principle 11).

import { findPlaceholders } from '../../outreach/placeholders'
import type { DocumentQaCheck, DocumentQaReport } from '../types'
import { documentText, fontSizesUsed, fontsUsed, readDocx, sectPrOf, stripMarkdown, type DocxFile } from './docx-read'
import { filenameMatches } from './filenames'
import { pdfInfo, type PdfInfo } from './pdf-text'

// ─── Text normalization ──────────────────────────────────────────────────────

/** Quotes, dashes, soft hyphens and NBSP normalized; whitespace collapsed. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[­​‌‍﻿]/g, '')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[–—−‐‑]/g, '-')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** For PDF matching. pdfjs splits words at glyph-position boundaries ("847 - 962"), so whitespace is removed entirely. */
function squash(s: string): string {
  return normalizeText(s).replace(/\s/g, '').toLowerCase()
}

// ─── Well-formedness proxy ───────────────────────────────────────────────────

/** Cheap structural sanity for WordprocessingML: paired `<w:p>` / `<w:r>` counts and a balanced-tag walk. */
export function xmlLooksWellFormed(xml: string): { ok: boolean; detail: string } {
  const count = (re: RegExp) => (xml.match(re) ?? []).length
  const pOpen = count(/<w:p(?=[\s>])/g)
  const pClose = count(/<\/w:p>/g)
  if (pOpen !== pClose) return { ok: false, detail: `${pOpen} <w:p> vs ${pClose} </w:p>` }
  const rOpen = count(/<w:r(?=[\s>])/g)
  const rClose = count(/<\/w:r>/g)
  if (rOpen !== rClose) return { ok: false, detail: `${rOpen} <w:r> vs ${rClose} </w:r>` }

  const stack: string[] = []
  const re = /<\/?([A-Za-z][\w:.-]*)(?:\s[^<>]*?)?(\/?)>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    const tok = m[0]
    if (tok.startsWith('<?') || tok.startsWith('<!')) continue
    if (m[2] === '/') continue
    if (tok.startsWith('</')) {
      const open = stack.pop()
      if (open !== m[1]) return { ok: false, detail: `</${m[1]}> closes <${open ?? 'nothing'}>` }
    } else {
      stack.push(m[1])
    }
  }
  if (stack.length) return { ok: false, detail: `unclosed <${stack[stack.length - 1]}>` }
  return { ok: true, detail: `${pOpen} paragraphs, ${rOpen} runs` }
}

// ─── Shared pieces ───────────────────────────────────────────────────────────

function check(name: string, pass: boolean, detail: string, blocking = true): DocumentQaCheck {
  return { name, pass, detail, blocking }
}

async function loadDocx(docx: Buffer): Promise<{ file: DocxFile | null; error: string | null }> {
  try {
    return { file: await readDocx(docx), error: null }
  } catch (err) {
    return { file: null, error: err instanceof Error ? err.message : String(err) }
  }
}

async function loadPdf(pdfPath: string | null, given?: PdfInfo): Promise<{ info: PdfInfo | null; error: string | null }> {
  if (given) return { info: given, error: null }
  if (!pdfPath) return { info: null, error: null }
  try {
    return { info: await pdfInfo(pdfPath), error: null }
  } catch (err) {
    return { info: null, error: err instanceof Error ? err.message : String(err) }
  }
}

/** The company the caller named is real by definition; blank it so "Company Name Holdings" or "Boston Dynamics" cannot trip a slot or filler pattern. */
function maskCompany(text: string, company: string): string {
  const c = company.trim()
  if (!c) return text
  const escaped = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(escaped, 'gi'), 'COMPANYNAMEMASKED')
}

function placeholderCheck(text: string, company: string): DocumentQaCheck {
  const findings = findPlaceholders('', maskCompany(text, company))
  const blocking = findings.filter((f) => f.severity === 'blocking')
  if (blocking.length) return check('no_placeholders', false, blocking.map((f) => f.match).join(', '))
  if (findings.length) return check('no_placeholders', true, `warnings: ${findings.map((f) => f.match).join(', ')}`)
  return check('no_placeholders', true, 'none')
}

function finish(document: DocumentQaReport['document'], checks: DocumentQaCheck[], rest: Omit<DocumentQaReport, 'ok' | 'document' | 'checks' | 'warnings'>): DocumentQaReport {
  const warnings = checks.filter((c) => !c.pass && !c.blocking).map((c) => `${c.name}: ${c.detail}`)
  return { ok: checks.every((c) => c.pass || !c.blocking), document, checks, warnings, ...rest }
}

// ─── Résumé ──────────────────────────────────────────────────────────────────

export interface ResumeQaInput {
  docx: Buffer
  pdfPath: string | null
  pdfInfo?: PdfInfo
  /** Plain text, `**` stripped. */
  expectedBullets: string[]
  /**
   * Text the tailor proposed and the pipeline REFUSED — auto-rejected changes,
   * and anything the verifier did not support. None of it may reach the page.
   *
   * `expectedBullets` proves the approved changes arrived; this proves the
   * refused ones did not, and the two failure modes are opposite. A rejected
   * change keeps its original bullet, so a caller must pass only text that
   * actually differs from the original — an emphasis-only rejection strips to
   * the original and would otherwise report itself as leaked.
   */
  rejectedTexts?: string[]
  /** The master's page count, normally 1. */
  expectedPages: number
  /** The master's fonts (`fontsUsed`). */
  allowedFonts: string[]
  /** The master's sizes (`fontSizesUsed`). Omitted → the check is skipped. */
  allowedFontSizes?: string[]
  /** The master's `<w:sectPr>`. Omitted → the check is skipped. */
  masterSectPr?: string | null
  /** The master's paragraph count. Omitted → the check is skipped. */
  masterParagraphCount?: number
  filename: string
  company: string
  renderer: string | null
  /**
   * The caller asked for no PDF. Distinct from `renderer === null`, which means
   * one was wanted and none exists — the detail line must not tell someone to
   * install Word when nobody asked for a PDF in the first place.
   */
  pdfSkipped?: boolean
  docxPath?: string | null
}

export async function qaResumeDocument(input: ResumeQaInput): Promise<DocumentQaReport> {
  const checks: DocumentQaCheck[] = []
  const { file, error } = await loadDocx(input.docx)
  const rest = { docx_path: input.docxPath ?? null, pdf_path: input.pdfPath, page_count: null as number | null, expected_pages: input.expectedPages, renderer: input.renderer }

  if (!file) {
    checks.push(check('docx_valid', false, error ?? 'unreadable'))
    return finish('resume', checks, rest)
  }
  const wf = xmlLooksWellFormed(file.documentXml)
  checks.push(check('docx_valid', wf.ok, wf.detail))

  const paragraphs = file.body.paragraphs
  if (input.masterParagraphCount !== undefined) {
    const diff = Math.abs(paragraphs.length - input.masterParagraphCount)
    checks.push(check('paragraph_count_sane', diff <= 3, `${paragraphs.length} paragraphs, master ${input.masterParagraphCount}`))
  }

  const emptyBullets = paragraphs.filter((p) => p.isBullet && p.text.trim().length === 0).map((p) => p.index)
  checks.push(check('no_empty_bullets', emptyBullets.length === 0, emptyBullets.length ? `empty bullet paragraphs at ${emptyBullets.join(', ')}` : 'none'))

  const fonts = fontsUsed(file.documentXml)
  const strange = fonts.filter((f) => !input.allowedFonts.includes(f))
  checks.push(check('fonts_unchanged', strange.length === 0, strange.length ? `unexpected: ${strange.join(', ')}` : fonts.join(', ') || 'inherited only'))

  if (input.allowedFontSizes) {
    const sizes = fontSizesUsed(file.documentXml)
    const same = sizes.length === input.allowedFontSizes.length && sizes.every((s) => input.allowedFontSizes!.includes(s))
    checks.push(check('font_sizes_unchanged', same, same ? sizes.join(',') : `document ${sizes.join(',')} vs master ${input.allowedFontSizes.join(',')}`))
  }
  if (input.masterSectPr !== undefined) {
    const sect = sectPrOf(file.documentXml)
    checks.push(check('sectpr_unchanged', sect === input.masterSectPr, sect === input.masterSectPr ? 'identical' : 'page setup differs from master'))
  }

  const text = documentText(file)
  checks.push(placeholderCheck(text, input.company))
  checks.push(check('no_markdown_leak', !text.includes('**'), text.includes('**') ? 'literal ** in document text' : 'none'))

  // PDF
  const { info, error: pdfError } = await loadPdf(input.pdfPath, input.pdfInfo)
  const rendererAvailable = input.renderer !== null
  if (!info) {
    const why = input.pdfSkipped
      ? 'not requested — DOCX only; the one-page guarantee was not checked'
      : pdfError ?? (rendererAvailable ? 'no PDF produced' : 'no PDF renderer available')
    checks.push(check('pdf_present', false, why, rendererAvailable && !input.pdfSkipped))
  } else {
    rest.page_count = info.pageCount
    checks.push(check('pdf_present', true, `${info.pageCount} page(s) via ${info.method}${info.fonts.length ? `; fonts ${info.fonts.join(', ')}` : ''}`))
    checks.push(check('pdf_page_count', info.pageCount === input.expectedPages, `${info.pageCount} vs expected ${input.expectedPages}`))
    if (info.pageCount > input.expectedPages) {
      const overflow = info.pages.slice(input.expectedPages).join(' ').trim()
      checks.push(check('no_orphan_line', false, `overflow: "${overflow.slice(0, 160)}"`, false))
    } else {
      checks.push(check('no_orphan_line', true, 'none', false))
    }
  }

  // Content
  const docxSquashed = squash(text)
  const pdfSquashed = info ? squash(info.pages.join('\n')) : null
  const missingDocx: string[] = []
  const missingPdf: string[] = []
  for (const b of input.expectedBullets) {
    const needle = squash(stripMarkdown(b))
    if (!needle) continue
    if (!docxSquashed.includes(needle)) missingDocx.push(b)
    if (pdfSquashed !== null && !pdfSquashed.includes(needle)) missingPdf.push(b)
  }
  const contentOk = missingDocx.length === 0 && missingPdf.length === 0
  const contentDetail = contentOk
    ? `${input.expectedBullets.length} bullet(s) present${pdfSquashed !== null ? ' in DOCX and PDF' : ' in DOCX (no PDF)'}`
    : [missingDocx.length ? `missing from DOCX: ${missingDocx.map((b) => `"${b.slice(0, 60)}"`).join('; ')}` : '', missingPdf.length ? `missing from PDF: ${missingPdf.map((b) => `"${b.slice(0, 60)}"`).join('; ')}` : ''].filter(Boolean).join(' | ')
  checks.push(check('content_match', contentOk, contentDetail))

  // The opposite failure: text the pipeline refused, printed anyway. This is the
  // one that cannot be caught by reading the patch — the patch says "rejected",
  // and only the rendered bytes can say whether anything acted on it.
  const rejected = input.rejectedTexts ?? []
  const leaked: string[] = []
  for (const t of rejected) {
    const needle = squash(stripMarkdown(t))
    if (!needle) continue
    if (docxSquashed.includes(needle) || (pdfSquashed !== null && pdfSquashed.includes(needle))) leaked.push(t)
  }
  checks.push(
    check(
      'no_rejected_text',
      leaked.length === 0,
      leaked.length ? `refused text in the document: ${leaked.map((t) => `"${t.slice(0, 60)}"`).join('; ')}` : `${rejected.length} refused change(s), none present`
    )
  )

  checks.push(check('filename_pattern', filenameMatches(input.filename, input.company, 'resume'), input.filename))

  return finish('resume', checks, rest)
}

// ─── Cover letter ────────────────────────────────────────────────────────────

export interface CoverLetterQaInput {
  docx: Buffer
  pdfPath: string | null
  pdfInfo?: PdfInfo
  expectedParagraphs: string[]
  company: string
  filename: string
  renderer?: string | null
  docxPath?: string | null
}

/** Phrases that mark a letter nobody wrote for this job. A warning, because a human may keep one on purpose. */
export const BANNED_FILLER = [
  'i am writing to express my interest',
  'i am writing to apply',
  'to whom it may concern',
  'passionate about',
  'fast-paced environment',
  'team player',
  'hit the ground running',
  'proven track record',
  'i believe i would be a great fit',
  'perfect fit',
  'dynamic environment',
  'synergy',
  'leverage my skills',
  'thank you for considering my application',
]

const TIMES = 'Times New Roman'

async function fontsDeclaredInStyles(file: DocxFile): Promise<string[]> {
  const entry = file.zip.file('word/styles.xml')
  if (!entry) return []
  const xml = await entry.async('string')
  return fontsUsed(xml)
}

export async function qaCoverLetterDocument(input: CoverLetterQaInput): Promise<DocumentQaReport> {
  const checks: DocumentQaCheck[] = []
  const renderer = input.renderer ?? null
  const rest = { docx_path: input.docxPath ?? null, pdf_path: input.pdfPath, page_count: null as number | null, expected_pages: 1, renderer }

  const { file, error } = await loadDocx(input.docx)
  if (!file) {
    checks.push(check('docx_valid', false, error ?? 'unreadable'))
    return finish('cover_letter', checks, rest)
  }
  const wf = xmlLooksWellFormed(file.documentXml)
  checks.push(check('docx_valid', wf.ok, wf.detail))

  // Every run either names Times New Roman or inherits the document default, which must be Times New Roman.
  const runFonts = fontsUsed(file.documentXml)
  const styleFonts = await fontsDeclaredInStyles(file)
  const allTimes = runFonts.every((f) => f === TIMES) && styleFonts.every((f) => f === TIMES) && (runFonts.length + styleFonts.length > 0)
  checks.push(check('font_is_times', allTimes, allTimes ? TIMES : `runs: ${runFonts.join(', ') || 'inherit'}; styles: ${styleFonts.join(', ') || 'none'}`))

  const text = documentText(file)
  const norm = normalizeText(text).toLowerCase()
  const missing = input.expectedParagraphs.filter((p) => !norm.includes(normalizeText(p).toLowerCase()))
  checks.push(check('paragraphs_present', missing.length === 0, missing.length ? `missing: ${missing.map((p) => `"${p.slice(0, 50)}"`).join('; ')}` : `${input.expectedParagraphs.length} paragraph(s) present`))

  checks.push(placeholderCheck(text, input.company))

  const masked = normalizeText(maskCompany(text, input.company)).toLowerCase()
  const filler = BANNED_FILLER.filter((f) => masked.includes(f))
  checks.push(check('no_banned_filler', filler.length === 0, filler.length ? filler.join(', ') : 'none', false))

  const words = input.expectedParagraphs.join(' ').split(/\s+/).filter(Boolean).length
  checks.push(check('word_count_band', words >= 150 && words <= 450, `${words} words (band 150-450)`, false))

  checks.push(check('filename_pattern', filenameMatches(input.filename, input.company, 'cover_letter'), input.filename))

  const { info, error: pdfError } = await loadPdf(input.pdfPath, input.pdfInfo)
  if (!info) {
    checks.push(check('one_page', false, pdfError ?? (renderer ? 'no PDF produced' : 'no PDF renderer available'), renderer !== null))
  } else {
    rest.page_count = info.pageCount
    checks.push(check('one_page', info.pageCount === 1, `${info.pageCount} page(s)`))
  }

  return finish('cover_letter', checks, rest)
}
