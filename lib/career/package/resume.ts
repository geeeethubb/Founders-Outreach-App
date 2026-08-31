// From verified changes to a résumé document.
//
// Two halves. `buildDocumentPatch` is the pure bridge between what the review
// screen approved (changes keyed by resume_bullets ids) and what the document
// engine takes (edits keyed by ORIGINAL paragraph indexes on the master).
// `generateResumeDocuments` runs it inside the one-page fix loop, renders,
// runs QA and writes the files — with every write behind `DocumentOutput`,
// so the same function serves the package pipeline (Supabase Storage) and
// the no-DB CLI (a directory).
//
// Only approved and edited changes reach the document. A pending change is a
// proposal the human has not answered; it is not shipped by default.

import fs from 'fs'
import path from 'path'
import { applyResumePatch, type BulletEdit, type ResumeDocumentPatch } from '../documents/docx'
import { fontSizesUsed, fontsUsed, readDocx, sectPrOf, stripMarkdown } from '../documents/docx-read'
import { resumeFilenames } from '../documents/filenames'
import { fitToOnePage, shrinkStrategies } from '../documents/fit-page'
import { NO_RENDERER_ERROR, renderDocxToPdf } from '../documents/pdf'
import { pdfInfo, type PdfInfo } from '../documents/pdf-text'
import { qaResumeDocument } from '../documents/qa'
import { assertDurablePath, contentTypeFor, saveDocument, type StorageBackend } from '../documents/store'
import { withTempDir } from '../documents/tmp'
import { finalBulletsFor, type VerifiedChange } from '../tailor/pipeline'
import type { DocumentQaReport, EvidenceBank, ResumeBullet } from '../types'

export type ChangeWithId = VerifiedChange & { id?: string }

// ─── Output ──────────────────────────────────────────────────────────────────

/** Where produced files go. `store` = saveDocument (Supabase or local mirror); `dir` = a plain directory. */
export type DocumentOutput =
  | { kind: 'store'; userId: string; relativePrefix: string; backend?: StorageBackend }
  | { kind: 'dir'; dir: string }

export async function writeOutput(output: DocumentOutput, filename: string, data: Buffer): Promise<{ path: string; warning?: string }> {
  if (output.kind === 'dir') {
    fs.mkdirSync(output.dir, { recursive: true })
    const abs = path.join(output.dir, filename)
    fs.writeFileSync(abs, data)
    return { path: abs }
  }
  const saved = await saveDocument({
    userId: output.userId,
    relativePath: `${output.relativePrefix.replace(/\/+$/, '')}/${filename}`,
    data,
    contentType: contentTypeFor(filename),
    backend: output.backend,
  })
  // Belt and braces: saveDocument asserts this too. A produced document that
  // is only in scratch is gone before anyone downloads it.
  assertDurablePath(saved.storage_path, filename)
  return { path: saved.storage_path, warning: saved.warning }
}

// ─── The patch ───────────────────────────────────────────────────────────────

export interface DocumentPatchResult {
  patch: ResumeDocumentPatch
  /** Ids (or `#index`) of the changes that produced an edit. */
  applied: string[]
  skipped: { change_id: string; reason: string }[]
}

function live(c: VerifiedChange, onlyApproved: boolean): boolean {
  if (c.review_status === 'approved' || c.review_status === 'edited') return true
  return !onlyApproved && c.review_status === 'pending'
}

function masterBullets(bank: EvidenceBank): ResumeBullet[] {
  return bank.bullets
    .filter((b) => b.is_on_master && b.approved && b.paragraph_index !== null)
    .sort((a, b) => a.display_order - b.display_order)
}

/**
 * Bullet id → paragraph index → experience key. The paragraph map is the
 * authority for keys: the entry whose bullet_id matches, else the entry at
 * that paragraph index (a map written before bullet ids were stamped).
 */
export function experienceKeyFor(bank: EvidenceBank, bulletId: string | null, paragraphIndex: number | null): string | null {
  const map = bank.masterDocument?.paragraph_map ?? []
  if (bulletId) {
    const byId = map.find((e) => e.bullet_id === bulletId)
    if (byId?.experience_key) return byId.experience_key
  }
  if (paragraphIndex !== null) {
    const at = map.find((e) => e.index === paragraphIndex)
    if (at?.experience_key) return at.experience_key
  }
  return null
}

export function buildDocumentPatch(bank: EvidenceBank, changes: ChangeWithId[], opts: { onlyApproved?: boolean } = {}): DocumentPatchResult {
  const onlyApproved = opts.onlyApproved ?? true
  const bullets: BulletEdit[] = []
  const applied: string[] = []
  const skipped: DocumentPatchResult['skipped'] = []
  const master = masterBullets(bank)
  const byId = new Map(master.map((b) => [b.id, b]))
  const reorderExperiences = new Set<string>()

  changes.forEach((c, i) => {
    const cid = c.id ?? `#${i}`
    if (!live(c, onlyApproved) || c.change_type === 'keep') return
    const masterOfExp = master.filter((b) => b.experience_id === c.experience_id)
    const anchor = masterOfExp[masterOfExp.length - 1] ?? null
    const bullet = c.bullet_id ? byId.get(c.bullet_id) ?? null : null
    const key = experienceKeyFor(bank, c.bullet_id, bullet?.paragraph_index ?? anchor?.paragraph_index ?? null)
    if (!key) {
      skipped.push({ change_id: cid, reason: 'no paragraph map entry for this experience' })
      return
    }

    switch (c.change_type) {
      case 'reorder':
        reorderExperiences.add(c.experience_id)
        applied.push(cid)
        return
      case 'remove':
        if (!bullet) return skipped.push({ change_id: cid, reason: 'bullet not on the master' })
        bullets.push({ paragraphIndex: bullet.paragraph_index, experienceKey: key, action: 'remove' })
        applied.push(cid)
        return
      case 'reword':
      case 'swap':
        if (!bullet) return skipped.push({ change_id: cid, reason: 'bullet not on the master' })
        if (!c.final_text) return skipped.push({ change_id: cid, reason: 'no final text' })
        bullets.push({ paragraphIndex: bullet.paragraph_index, experienceKey: key, action: 'replace', text: c.final_text })
        applied.push(cid)
        if (c.position !== masterOfExp.indexOf(bullet)) reorderExperiences.add(c.experience_id)
        return
      case 'new':
        if (!c.final_text) return skipped.push({ change_id: cid, reason: 'no final text' })
        if (!anchor) return skipped.push({ change_id: cid, reason: 'experience has no master bullet to insert after' })
        bullets.push({ paragraphIndex: null, experienceKey: key, action: 'insert', text: c.final_text, afterParagraphIndex: anchor.paragraph_index as number, order: c.position })
        applied.push(cid)
        return
    }
  })

  // Final order of surviving ORIGINAL bullets, per experience, the way
  // finalBulletsFor orders them: a changed bullet sits at its proposed
  // position, an untouched one at its master index.
  const bulletOrder: Record<string, number[]> = {}
  for (const expId of reorderExperiences) {
    const mine = master.filter((b) => b.experience_id === expId)
    const liveOf = new Map(changes.filter((c) => c.experience_id === expId && c.bullet_id && live(c, onlyApproved) && c.change_type !== 'keep').map((c) => [c.bullet_id as string, c]))
    const entries = mine
      .map((b, i) => ({ b, c: liveOf.get(b.id), i }))
      .filter(({ c }) => c?.change_type !== 'remove')
      .map(({ b, c, i }) => ({ pi: b.paragraph_index as number, position: c ? c.position : i, order: i }))
      .sort((a, b) => a.position - b.position || a.order - b.order)
    const ordered = entries.map((e) => e.pi)
    const original = mine.filter((b) => liveOf.get(b.id)?.change_type !== 'remove').map((b) => b.paragraph_index as number)
    if (ordered.join(',') === original.join(',')) continue
    const key = experienceKeyFor(bank, mine[0]?.id ?? null, mine[0]?.paragraph_index ?? null)
    if (key) bulletOrder[key] = ordered
  }

  return { patch: Object.keys(bulletOrder).length ? { bullets, bulletOrder } : { bullets }, applied, skipped }
}

// ─── Documents ───────────────────────────────────────────────────────────────

export interface ResumeDocumentsParams {
  bank: EvidenceBank
  masterBuffer: Buffer
  changes: ChangeWithId[]
  company: string
  output: DocumentOutput
  /** Default: masterDocument.page_count ?? 1. */
  expectedPages?: number
}

export interface ResumeDocumentsResult {
  docxPath: string | null
  pdfPath: string | null
  filenames: { docx: string; pdf: string }
  qa: DocumentQaReport
  shrink_attempts: number
  /** Change ids dropped or restored by the shrink loop to fit the page. */
  droppedByShrink: string[]
  renderer: string | null
  warnings: string[]
  /** The change-set that produced the document. */
  finalChanges: ChangeWithId[]
  /** True when no PDF exists because no renderer is installed — NOT a document failure. */
  pdfUnavailable: boolean
  error: string | null
}

/** Said the same way everywhere so the UI can distinguish it from a build failure. */
export const PDF_UNAVAILABLE_WARNING = 'PDF unavailable: no PDF renderer is installed (Microsoft Word or LibreOffice). The DOCX was produced and stored; no PDF was.'

/**
 * A renderer IS installed and did not finish. Completely different advice from
 * PDF_UNAVAILABLE_WARNING — "try again", not "install something" — because
 * telling a founder to install Word on the machine Word is running on is the
 * bug this pair of messages exists to prevent. Word's first render after a cold
 * start has been measured at ~106s on this machine.
 */
export function pdfRenderFailedWarning(outcome: 'timeout' | 'failed', detail: string): string {
  return outcome === 'timeout'
    ? `PDF not rendered: the converter did not finish in time (${detail}). The DOCX was produced and stored — retry the documents to get the PDF; nothing needs installing.`
    : `PDF not rendered: the converter refused the document (${detail}). The DOCX was produced and stored.`
}

function effectiveIds(changes: ChangeWithId[]): Set<string> {
  const ids = new Set<string>()
  changes.forEach((c, i) => {
    if (c.change_type !== 'keep') ids.add(c.id ?? `#${i}`)
  })
  return ids
}

/** Change ids present in `before` that the shrink loop dropped or restored in `after`. Ids without a row id are `#<index in before>`. */
export function droppedByShrink(before: ChangeWithId[], after: ChangeWithId[]): string[] {
  // A restored change keeps its position in the array, so an index-based id
  // still names the same change; a dropped one is simply absent.
  const afterIds = new Set<string>()
  after.forEach((c) => {
    if (c.change_type === 'keep') return
    const idx = before.indexOf(c)
    afterIds.add(c.id ?? `#${idx >= 0 ? idx : before.findIndex((b) => b.bullet_id === c.bullet_id && b.proposed_text === c.proposed_text)}`)
  })
  return Array.from(effectiveIds(before)).filter((id) => !afterIds.has(id))
}

export async function generateResumeDocuments(params: ResumeDocumentsParams): Promise<ResumeDocumentsResult> {
  const warnings: string[] = []
  // The scratch directory is OS-owned, absolute and unique per build. It used
  // to be `.career-out/tmp/pkg-…` — RELATIVE — so `mkdirSync` threw ENOENT
  // wherever the working directory is not the repo (every deployment), *after*
  // research and tailoring had been paid for. It is removed on every path —
  // success, failure and throw — and a cleanup failure is a warning, never the
  // reported error.
  return withTempDir(
    'pkg-resume',
    (tmp) => buildResumeDocuments(params, tmp, warnings),
    (e) => warnings.push(`temporary workspace cleanup: ${e.message}`)
  )
}

async function buildResumeDocuments(params: ResumeDocumentsParams, tmp: string, warnings: string[]): Promise<ResumeDocumentsResult> {
  const filenames = resumeFilenames(params.company)
  const approved = params.changes.filter((c) => live(c, true))
  const strategies = shrinkStrategies(approved)
  const expectedPages = params.expectedPages ?? params.bank.masterDocument?.page_count ?? 1
  let renderer: string | null = null
  let noRenderer = false
  /**
   * Set when a renderer exists but did not produce a PDF — retryable, and never
   * "install Word". Held on an object because the assignment happens inside the
   * `toPdf` callback: control-flow analysis cannot see through a callback and
   * would otherwise still believe a plain `let` is its initial `null`.
   */
  const render: { failure: { outcome: 'timeout' | 'failed'; detail: string } | null } = { failure: null }
  let lastApplyWarnings: string[] = []
  let usedSet: ChangeWithId[] = approved

  const fit = await fitToOnePage({
    expectedPages,
    maxAttempts: strategies.length,
    render: async (attempt) => {
      const set = strategies[attempt]
      if (!set) return null
      usedSet = set
      const built = buildDocumentPatch(params.bank, set, { onlyApproved: true })
      for (const s of built.skipped) warnings.push(`change ${s.change_id} skipped: ${s.reason}`)
      const r = await applyResumePatch(params.masterBuffer, built.patch)
      lastApplyWarnings = r.warnings
      return { docx: r.docx }
    },
    toPdf: async (docx, attempt) => {
      const pdfPath = path.join(tmp, `attempt-${attempt}.pdf`)
      const r = await renderDocxToPdf(docx, pdfPath)
      renderer = r.renderer
      if (!r.ok) {
        // Only an absent renderer is "unavailable"; a timeout or a refusal is a
        // failure to retry, and either way the DOCX still stands.
        if (r.outcome === 'no_renderer' || r.error === NO_RENDERER_ERROR) noRenderer = true
        else if (r.outcome === 'timeout' || r.outcome === 'failed') render.failure = { outcome: r.outcome, detail: r.error ?? `${r.renderer ?? 'renderer'} gave no reason` }
      }
      return { ok: r.ok, pageCount: r.pageCount, pdfPath: r.ok ? pdfPath : null, error: r.error, ms: r.ms }
    },
  })
  warnings.push(...lastApplyWarnings)

  if (!fit.docx) {
    return { docxPath: null, pdfPath: null, filenames, qa: emptyQa(filenames.docx, renderer, fit.error ?? 'nothing rendered'), shrink_attempts: fit.shrink_attempts, droppedByShrink: [], renderer, warnings, finalChanges: usedSet, pdfUnavailable: noRenderer, error: fit.error ?? 'nothing rendered' }
  }
  if (noRenderer) warnings.push(PDF_UNAVAILABLE_WARNING)
  else if (render.failure) warnings.push(pdfRenderFailedWarning(render.failure.outcome, render.failure.detail))
  else if (!fit.ok) warnings.push(`page fit: ${fit.error ?? 'over the page budget'}`)

  const dropped = droppedByShrink(approved, usedSet)

  // QA fingerprints come from the master itself; the engine cannot introduce
  // what it never read, and the check proves it.
  const masterFile = await readDocx(params.masterBuffer)
  const shipped = usedSet.filter((c) => c.change_type !== 'keep')
  const expectedBullets = finalBulletsFor(params.bank, shipped, { onlyApproved: true }).flatMap((e) => e.bullets).map(stripMarkdown)
  let info: PdfInfo | undefined
  if (fit.pdfPath) {
    try {
      info = await pdfInfo(fit.pdfPath)
    } catch (e) {
      warnings.push(`pdf read: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const qa = await qaResumeDocument({
    docx: fit.docx,
    pdfPath: fit.pdfPath,
    pdfInfo: info,
    expectedBullets,
    expectedPages,
    allowedFonts: fontsUsed(masterFile.documentXml),
    allowedFontSizes: fontSizesUsed(masterFile.documentXml),
    masterSectPr: sectPrOf(masterFile.documentXml),
    masterParagraphCount: masterFile.body.paragraphs.length,
    filename: filenames.docx,
    company: params.company,
    renderer: noRenderer ? null : renderer,
  })
  qa.shrink_attempts = fit.shrink_attempts

  const docx = await writeOutput(params.output, filenames.docx, fit.docx)
  if (docx.warning) warnings.push(docx.warning)
  let pdfPath: string | null = null
  if (fit.pdfPath && fs.existsSync(fit.pdfPath)) {
    const pdf = await writeOutput(params.output, filenames.pdf, fs.readFileSync(fit.pdfPath))
    if (pdf.warning) warnings.push(pdf.warning)
    pdfPath = pdf.path
  }
  qa.docx_path = docx.path
  qa.pdf_path = pdfPath

  return { docxPath: docx.path, pdfPath, filenames, qa, shrink_attempts: fit.shrink_attempts, droppedByShrink: dropped, renderer, warnings, finalChanges: usedSet, pdfUnavailable: noRenderer, error: null }
}

function emptyQa(filename: string, renderer: string | null, detail: string): DocumentQaReport {
  return {
    ok: false, document: 'resume', docx_path: null, pdf_path: null, page_count: null, expected_pages: null, renderer,
    checks: [{ name: 'docx_valid', pass: false, detail: `${filename}: ${detail}`, blocking: true }], warnings: [],
  }
}
