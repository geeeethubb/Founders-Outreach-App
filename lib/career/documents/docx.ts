// The document engine's write side: apply an approved résumé patch to the
// master DOCX without reconstructing anything.
//
// The master is the template. Every paragraph the patch does not name is
// written back byte-for-byte; a replaced bullet keeps its `<w:pPr>` (numbering,
// indent, spacing, justification) and gets new runs built from the properties
// of the runs it replaces. Nothing here knows what a font is — it copies run
// properties, so the produced file can only ever use what the master used.
// That is what makes the QA checks `fonts_unchanged` / `font_sizes_unchanged`
// cheap: the engine cannot introduce a size it never read.
//
// Everything resolves against ORIGINAL paragraph indexes. The patch is
// authored against the master's paragraph map, and a remove or insert must not
// shift what the next edit means.

import type { DocxBody, DocxFile, DocxParagraph } from './docx-read'
import { encodeXml, joinBody, parseParagraph, paragraphMarkdown, paragraphSegments, readDocx, splitBody, stripMarkdown } from './docx-read'
import { buildResumeModel, type ResumeExperienceBlock, type ResumeModel } from './resume-model'

export interface BulletEdit {
  /** Original paragraph index on the master; null for a new bullet. */
  paragraphIndex: number | null
  experienceKey: string
  action: 'replace' | 'remove' | 'insert'
  /** Markdown with `**bold**` spans; plain otherwise. Required for replace and insert. */
  text?: string
  /** For insert: the bullet it follows, or the experience's org/title paragraph to insert first. */
  afterParagraphIndex?: number
  /** Tie-break among inserts sharing an anchor. */
  order?: number
}

export interface ResumeDocumentPatch {
  bullets: BulletEdit[]
  /** Final order of ORIGINAL paragraph indexes within an experience. Unlisted survivors keep relative order after the listed ones. */
  bulletOrder?: Record<string, number[]>
}

export interface AppliedChange {
  action: BulletEdit['action'] | 'reorder'
  experienceKey: string
  /** Original index (null for inserts). */
  paragraphIndex: number | null
  /** Index in the produced document (null for removes). */
  newParagraphIndex: number | null
  text: string | null
  paraId?: string
}

export interface ApplyResult {
  docx: Buffer
  applied: AppliedChange[]
  warnings: string[]
}

// ─── Run rendering ───────────────────────────────────────────────────────────

interface Segment {
  text: string
  bold: boolean
}

/** `**bold**` markdown → segments. Unbalanced markers are treated as literal text (the QA leak check will catch them). */
export function parseMarkdownSegments(text: string): Segment[] {
  const out: Segment[] = []
  const re = /\*\*(.+?)\*\*/g
  let cursor = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > cursor) out.push({ text: text.slice(cursor, m.index), bold: false })
    out.push({ text: m[1], bold: true })
    cursor = m.index + m[0].length
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), bold: false })
  return out.filter((s) => s.text.length > 0)
}

/** Plain text plus the bold spans to re-apply → segments. First verbatim occurrence of each span wins; overlaps are dropped. */
function segmentsWithSpans(text: string, spans: string[]): Segment[] {
  const marks: { start: number; end: number }[] = []
  for (const span of spans) {
    const at = text.indexOf(span)
    if (at < 0) continue
    const end = at + span.length
    if (marks.some((k) => at < k.end && end > k.start)) continue
    marks.push({ start: at, end })
  }
  marks.sort((a, b) => a.start - b.start)
  const out: Segment[] = []
  let cursor = 0
  for (const k of marks) {
    if (k.start > cursor) out.push({ text: text.slice(cursor, k.start), bold: false })
    out.push({ text: text.slice(k.start, k.end), bold: true })
    cursor = k.end
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), bold: false })
  return out.filter((s) => s.text.length > 0)
}

function runXml(text: string, rPr: string): string {
  return `<w:r>${rPr}<w:t xml:space="preserve">${encodeXml(text)}</w:t></w:r>`
}

/** One `<w:r>` per markdown segment. `baseRPr` / `boldRPr` are raw `<w:rPr>…</w:rPr>` strings (or '' for none). */
export function renderMarkdownRuns(text: string, baseRPr: string, boldRPr: string): string {
  return parseMarkdownSegments(text)
    .map((s) => runXml(s.text, s.bold ? boldRPr : baseRPr))
    .join('')
}

/** Bold rPr from a base one: `<w:b/><w:bCs/>` right after `<w:rFonts…/>`, or at the start. */
export function deriveBoldRPr(baseRPr: string): string {
  if (!baseRPr) return '<w:rPr><w:b/><w:bCs/></w:rPr>'
  if (/<w:b\s*\/>|<w:b\s+w:val="(1|true|on)"\s*\/>/.test(baseRPr)) return baseRPr
  const fonts = baseRPr.match(/<w:rFonts[^>]*\/>/)
  if (fonts && fonts.index !== undefined) {
    const at = fonts.index + fonts[0].length
    return baseRPr.slice(0, at) + '<w:b/><w:bCs/>' + baseRPr.slice(at)
  }
  return baseRPr.replace(/^<w:rPr>/, '<w:rPr><w:b/><w:bCs/>')
}

/** Run properties to build new runs from: the first non-bold text run, else the paragraph mark's rPr, else none. */
function baseRPrOf(p: DocxParagraph): string {
  const run = p.runs.find((r) => !r.bold && r.text.trim().length > 0 && r.rPr)
  if (run?.rPr) return run.rPr.replace(/<w:b\s*\/>|<w:bCs\s*\/>/g, '')
  const mark = p.pPr?.match(/<w:rPr>[\s\S]*?<\/w:rPr>/)?.[0]
  if (mark) return mark.replace(/<w:b\s*\/>|<w:bCs\s*\/>/g, '')
  return ''
}

function boldSpansOf(p: DocxParagraph): string[] {
  return paragraphSegments(p)
    .filter((s) => s.bold)
    .map((s) => s.text.trim())
    .filter((s) => s.length > 0)
}

function openTagOf(xml: string): string {
  return xml.match(/^<w:p(?:\s[^>]*)?>/)?.[0] ?? '<w:p>'
}

/** Replace the runs of a bullet paragraph, keeping its open tag and `<w:pPr>` untouched. */
function rebuildParagraph(p: DocxParagraph, text: string): string {
  const base = baseRPrOf(p)
  const bold = deriveBoldRPr(base)
  // Explicit **spans** win; an original bold span that survives verbatim in the
  // unmarked text stays bold too, so a reword around "$4M+ in projected savings"
  // does not silently drop the emphasis the human put there.
  const spans = boldSpansOf(p)
  const segments = parseMarkdownSegments(text).flatMap((s) => (s.bold ? [s] : segmentsWithSpans(s.text, spans)))
  const runs = segments.map((s) => runXml(s.text, s.bold ? bold : base)).join('')
  return openTagOf(p.xml) + (p.pPr ?? '') + runs + '</w:p>'
}

// ─── paraId generation ───────────────────────────────────────────────────────

/** w14:paraId must be 8 hex digits below 0x80000000 and unique in the document. */
function freshParaId(taken: Set<string>): string {
  for (let i = 0; i < 1000; i++) {
    const n = Math.floor(Math.random() * 0x7fffffff) + 1
    const id = n.toString(16).toUpperCase().padStart(8, '0')
    if (!taken.has(id)) {
      taken.add(id)
      return id
    }
  }
  throw new Error('could not allocate a unique paraId')
}

function newParagraphXml(sibling: DocxParagraph, text: string, taken: Set<string>, hasW14: boolean): { xml: string; paraId: string | null } {
  const base = baseRPrOf(sibling)
  const bold = deriveBoldRPr(base)
  let paraId: string | null = null
  let open = '<w:p>'
  if (hasW14) {
    paraId = freshParaId(taken)
    open = `<w:p w14:paraId="${paraId}" w14:textId="${freshParaId(taken)}">`
  }
  return { xml: open + (sibling.pPr ?? '') + renderMarkdownRuns(text, base, bold) + '</w:p>', paraId }
}

// ─── Patch application ───────────────────────────────────────────────────────

interface Slot {
  originalIndex: number | null
  xml: string
  removed: boolean
  applied: AppliedChange | null
}

function isBulletOf(model: ResumeModel, index: number, key: string): boolean {
  const e = model.map[index]
  return !!e && e.kind === 'bullet' && e.experience_key === key
}

export async function applyResumePatch(master: Buffer, patch: ResumeDocumentPatch): Promise<ApplyResult> {
  const file: DocxFile = await readDocx(master)
  const model = buildResumeModel(file)
  const body = file.body
  const warnings: string[] = []
  const hasW14 = /xmlns:w14=/.test(file.documentXml)
  const takenIds = new Set(Array.from(file.documentXml.matchAll(/w14:(?:paraId|textId)="([^"]+)"/g)).map((m) => m[1]))

  const blocks = new Map<string, ResumeExperienceBlock>(model.experiences.map((e) => [e.key, e]))
  // Per experience: the original bullet slots, then inserts anchored to an original index (or -1 = first).
  const slots = new Map<string, Slot[]>()
  const inserts = new Map<string, { anchor: number; order: number; seq: number; slot: Slot }[]>()
  for (const e of model.experiences) {
    slots.set(e.key, e.bulletParagraphIndexes.map((i) => ({ originalIndex: i, xml: body.paragraphs[i].xml, removed: false, applied: null })))
    inserts.set(e.key, [])
  }

  let seq = 0
  for (const edit of patch.bullets) {
    const block = blocks.get(edit.experienceKey)
    if (!block) {
      warnings.push(`skipped ${edit.action}: unknown experience "${edit.experienceKey}"`)
      continue
    }
    const list = slots.get(block.key)!
    if (edit.action === 'insert') {
      const text = edit.text?.trim()
      if (!text) {
        warnings.push(`skipped insert in ${block.key}: no text`)
        continue
      }
      const sibling = block.bulletParagraphIndexes[0]
      if (sibling === undefined) {
        warnings.push(`skipped insert in ${block.key}: experience has no bullet to clone formatting from`)
        continue
      }
      let anchor = -1
      if (edit.afterParagraphIndex !== undefined) {
        if (isBulletOf(model, edit.afterParagraphIndex, block.key)) anchor = edit.afterParagraphIndex
        else if (edit.afterParagraphIndex === block.titleParagraphIndex || edit.afterParagraphIndex === block.orgParagraphIndex) anchor = -1
        else {
          warnings.push(`insert in ${block.key}: afterParagraphIndex ${edit.afterParagraphIndex} is not in this experience; appended last`)
          anchor = block.bulletParagraphIndexes[block.bulletParagraphIndexes.length - 1]
        }
      } else {
        anchor = block.bulletParagraphIndexes[block.bulletParagraphIndexes.length - 1]
      }
      const built = newParagraphXml(body.paragraphs[sibling], text, takenIds, hasW14)
      inserts.get(block.key)!.push({
        anchor,
        order: edit.order ?? Number.MAX_SAFE_INTEGER,
        seq: seq++,
        slot: {
          originalIndex: null,
          xml: built.xml,
          removed: false,
          applied: { action: 'insert', experienceKey: block.key, paragraphIndex: null, newParagraphIndex: null, text: stripMarkdown(text), paraId: built.paraId ?? undefined },
        },
      })
      continue
    }

    if (edit.paragraphIndex === null || !isBulletOf(model, edit.paragraphIndex, block.key)) {
      warnings.push(`skipped ${edit.action}: paragraph ${edit.paragraphIndex} is not a bullet of "${block.key}"`)
      continue
    }
    const slot = list.find((s) => s.originalIndex === edit.paragraphIndex)!
    if (edit.action === 'remove') {
      slot.removed = true
      slot.applied = { action: 'remove', experienceKey: block.key, paragraphIndex: edit.paragraphIndex, newParagraphIndex: null, text: null }
      continue
    }
    const text = edit.text?.trim()
    if (!text) {
      warnings.push(`skipped replace of paragraph ${edit.paragraphIndex}: no text`)
      continue
    }
    if (slot.removed) {
      warnings.push(`replace of paragraph ${edit.paragraphIndex} ignored: it is also removed`)
      continue
    }
    const p = body.paragraphs[edit.paragraphIndex]
    if (stripMarkdown(text) === stripMarkdown(paragraphMarkdown(p)) && !text.includes('**')) {
      // Same words, no explicit emphasis: leave the paragraph byte-identical.
      continue
    }
    slot.xml = rebuildParagraph(p, text)
    slot.applied = { action: 'replace', experienceKey: block.key, paragraphIndex: edit.paragraphIndex, newParagraphIndex: null, text: stripMarkdown(text) }
  }

  // Final sequence per experience: order originals, drop removed, splice inserts.
  const sequences = new Map<string, Slot[]>()
  for (const e of model.experiences) {
    let originals = slots.get(e.key)!
    const order = patch.bulletOrder?.[e.key]
    if (order) {
      const valid = order.filter((i) => isBulletOf(model, i, e.key))
      if (valid.length !== order.length) warnings.push(`bulletOrder for ${e.key}: ignored indexes not in this experience`)
      const listed = valid.map((i) => originals.find((s) => s.originalIndex === i)!)
      const rest = originals.filter((s) => !valid.includes(s.originalIndex as number))
      const reordered = [...listed, ...rest]
      const moved = reordered.some((s, k) => s !== originals[k])
      if (moved) {
        for (const s of reordered) {
          if (!s.applied && !s.removed) s.applied = { action: 'reorder', experienceKey: e.key, paragraphIndex: s.originalIndex, newParagraphIndex: null, text: null }
        }
      }
      originals = reordered
    }
    const out: Slot[] = []
    const ins = inserts.get(e.key)!.sort((a, b) => a.order - b.order || a.seq - b.seq)
    for (const i of ins.filter((x) => x.anchor === -1)) out.push(i.slot)
    for (const s of originals) {
      if (!s.removed) out.push(s)
      // An insert anchored to a removed bullet still lands where that bullet was.
      for (const i of ins.filter((x) => x.anchor === s.originalIndex)) out.push(i.slot)
    }
    sequences.set(e.key, out)
  }

  // Rebuild the body. Non-bullet paragraphs are copied verbatim; each
  // experience's bullets are emitted at the position of its first original bullet.
  const paragraphs: DocxParagraph[] = []
  const gaps: string[] = []
  const applied: AppliedChange[] = []
  const emitted = new Set<string>()
  for (let i = 0; i < body.paragraphs.length; i++) {
    const entry = model.map[i]
    const key = entry.experience_key
    if (entry.kind === 'bullet' && key && blocks.has(key)) {
      if (emitted.has(key)) continue
      emitted.add(key)
      const block = blocks.get(key)!
      const seqSlots = sequences.get(key)!
      seqSlots.forEach((s, k) => {
        const originalAt = block.bulletParagraphIndexes[k]
        gaps.push(originalAt !== undefined ? body.gaps[originalAt] : '')
        paragraphs.push(parseParagraph(s.xml, paragraphs.length))
        if (s.applied) {
          s.applied.newParagraphIndex = paragraphs.length - 1
          applied.push(s.applied)
        }
      })
      continue
    }
    gaps.push(body.gaps[i])
    paragraphs.push(parseParagraph(body.paragraphs[i].xml, paragraphs.length))
  }
  for (const list of slots.values()) for (const s of list) if (s.removed && s.applied) applied.push(s.applied)
  gaps.push(body.gaps[body.paragraphs.length])

  const newBody: DocxBody = { head: body.head, paragraphs, gaps }
  file.zip.file('word/document.xml', joinBody(newBody))
  const docx = await file.zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  })
  return { docx, applied, warnings }
}

// ─── Reading back, for QA ────────────────────────────────────────────────────

export interface ExtractedBullet {
  paragraphIndex: number
  experienceKey: string | null
  /** Plain text, `**` stripped, tabs collapsed. */
  text: string
  markdown: string
}

/** Every bullet in a produced DOCX, in document order. */
export async function extractBulletTexts(docx: Buffer): Promise<ExtractedBullet[]> {
  const file = await readDocx(docx)
  const model = buildResumeModel(file)
  return model.map
    .filter((e) => e.kind === 'bullet')
    .map((e) => ({ paragraphIndex: e.index, experienceKey: e.experience_key ?? null, text: stripMarkdown(e.text), markdown: e.text }))
}

/** Re-split a document.xml string; exported so tests can inspect produced XML without a second parser. */
export function bodyOf(documentXml: string): DocxBody {
  return splitBody(documentXml)
}
