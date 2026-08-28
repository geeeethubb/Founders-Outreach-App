// The cover letter, end to end: pipeline → row → DOCX → PDF → QA → files.
//
// runCoverLetterPipeline is pure; this is the orchestration around it. The
// row write is optional (`persist`), so the no-DB CLI and the evals produce
// the same documents from the same code with nothing to connect to.
//
// A letter that failed its grounding gate after the retry is still written
// and still rendered — `flagged` is set, the findings ride along, and the
// package cannot be finalized until a human edits or approves it (ADR-010).

import fs from 'fs'
import path from 'path'
import type { ToolContext } from '@/lib/agents/runtime/types'
import { buildCoverLetterDocx, formatLetterDate } from '../documents/cover-letter-docx'
import { coverLetterFilenames } from '../documents/filenames'
import { NO_RENDERER_ERROR, renderDocxToPdf } from '../documents/pdf'
import { pdfInfo, type PdfInfo } from '../documents/pdf-text'
import { qaCoverLetterDocument } from '../documents/qa'
import { DEFAULT_LENGTH } from '@/lib/agents/cover-letter-writer'
import { runCoverLetterPipeline, type CompanyResearchForLetter, type CoverLetterResult, type EvidenceMapForLetter, type LetterDeps } from '../letter/pipeline'
import type { CareerRun } from '../runs'
import type { CoverLetter, DocumentQaReport, EvidenceBank, ResumeParagraphMapEntry } from '../types'
import { insertCoverLetter, nextLetterVersion, type LetterSigner } from './persist'
import { scratchDir, writeOutput, type DocumentOutput } from './resume'

export interface LetterJob {
  title: string
  company_name: string
  location_raw: string | null
  description_text: string | null
  responsibilities: string[]
}

/** A few sentences on the role: the responsibilities when extracted, else the description's opening. */
export function letterJobSummary(job: LetterJob): string {
  if (job.responsibilities.length) return job.responsibilities.slice(0, 6).join('; ')
  return (job.description_text ?? '').replace(/\s+/g, ' ').slice(0, 500)
}

/** email / phone / LinkedIn from the résumé's own contact line. The résumé is the source of truth for how the applicant presents these. */
export function contactFromParagraphMap(map: ResumeParagraphMapEntry[]): { email: string | null; phone: string | null; linkedin: string | null } {
  const text = map.filter((e) => e.kind === 'contact').map((e) => e.text).join(' | ')
  const email = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0] ?? null
  const phone = text.match(/(?:\(\d{3}\)\s?|\d{3}[-.\s])\d{3}[-.\s]\d{4}/)?.[0] ?? null
  const linkedin = text.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9_-]+\/?/i)?.[0] ?? null
  return { email, phone, linkedin }
}

// ─── Documents from text ─────────────────────────────────────────────────────

export interface LetterDocumentsParams {
  greeting: string
  paragraphs: string[]
  closing: string
  user: LetterSigner
  company: string
  output: DocumentOutput
  date?: Date
}

export interface LetterDocumentsResult {
  docxPath: string | null
  pdfPath: string | null
  filenames: { docx: string; pdf: string }
  qa: DocumentQaReport
  renderer: string | null
  warnings: string[]
}

export async function buildLetterDocuments(params: LetterDocumentsParams): Promise<LetterDocumentsResult> {
  const warnings: string[] = []
  const filenames = coverLetterFilenames(params.company)
  const docx = await buildCoverLetterDocx({
    name: params.user.name,
    email: params.user.email,
    phone: params.user.phone,
    linkedin: params.user.linkedin ?? undefined,
    date: formatLetterDate(params.date ?? new Date()),
    recipient: { company: params.company },
    greeting: params.greeting,
    paragraphs: params.paragraphs,
    closing: params.closing,
    signatureName: params.user.name,
  })

  const tmp = scratchDir()
  const tmpPdf = path.join(tmp, filenames.pdf)
  const render = await renderDocxToPdf(docx, tmpPdf)
  let renderer: string | null = render.renderer
  if (!render.ok) {
    if (render.error === NO_RENDERER_ERROR) {
      renderer = null
      warnings.push(`${NO_RENDERER_ERROR}; DOCX produced, PDF skipped`)
    } else {
      warnings.push(`pdf render failed: ${render.error ?? 'unknown'}`)
    }
  }
  let info: PdfInfo | undefined
  if (render.ok) {
    try {
      info = await pdfInfo(tmpPdf)
    } catch (e) {
      warnings.push(`pdf read: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const qa = await qaCoverLetterDocument({
    docx, pdfPath: render.ok ? tmpPdf : null, pdfInfo: info, expectedParagraphs: params.paragraphs, company: params.company, filename: filenames.docx, renderer,
  })

  const out = await writeOutput(params.output, filenames.docx, docx)
  if (out.warning) warnings.push(out.warning)
  let pdfPath: string | null = null
  if (render.ok && fs.existsSync(tmpPdf)) {
    const pdf = await writeOutput(params.output, filenames.pdf, fs.readFileSync(tmpPdf))
    if (pdf.warning) warnings.push(pdf.warning)
    pdfPath = pdf.path
  }
  qa.docx_path = out.path
  qa.pdf_path = pdfPath
  fs.rmSync(tmp, { recursive: true, force: true })
  return { docxPath: out.path, pdfPath, filenames, qa, renderer, warnings }
}

// ─── Generate ────────────────────────────────────────────────────────────────

/**
 * The writer's own band (200–290, validator ceiling +25). It used to be
 * tighter than the writer's; the writer now carries the one-page band itself.
 */
export const LETTER_LENGTH = DEFAULT_LENGTH

/**
 * When the rendered PDF still says two pages, the writer gets ONE more go at
 * a shorter band with this note. Length is structural — a validator band and
 * a render check — not a hope; and a letter that is still two pages after
 * this stays flagged, never discarded (ADR-010).
 */
export const ONE_PAGE_RETRY_LENGTH = { min: 180, max: 250 }
export const ONE_PAGE_REVISION_NOTE = 'The letter must fit on one page in Times New Roman 12 — cut to at most 250 words'

/** True when QA rendered the PDF and counted more than one page. */
export function spilledPastOnePage(qa: DocumentQaReport): boolean {
  const c = qa.checks.find((x) => x.name === 'one_page')
  return !!c && !c.pass && (qa.page_count ?? 0) > 1
}

export interface GenerateLetterParams {
  bank: EvidenceBank
  job: LetterJob
  research: CompanyResearchForLetter
  evidenceMap: EvidenceMapForLetter
  user: LetterSigner
  ctx: ToolContext
  run?: CareerRun
  deps?: Partial<LetterDeps>
  output: DocumentOutput
  /** Write the cover_letters row. Omit for the no-DB path. */
  persist?: { userId: string; jobId: string; packageId: string } | null
  length?: { min: number; max: number }
  onStep?: (info: { attempt: number; detail: string }) => void
}

export interface GenerateLetterResult {
  letter: CoverLetterResult
  row: CoverLetter | null
  documents: LetterDocumentsResult | null
  flagged: boolean
  costUsd: number
  errors: string[]
  /** The one-page retry ran (first render was more than one page). */
  onePageRetried: boolean
  /** Word count of the draft the retry replaced, when it ran. */
  onePageRetryFrom: number | null
}

export async function generateCoverLetter(params: GenerateLetterParams): Promise<GenerateLetterResult> {
  const errors: string[] = []
  const draft = (length: { min: number; max: number }, revisionNotes?: string[]) =>
    runCoverLetterPipeline({
      bank: params.bank,
      job: { title: params.job.title, company: params.job.company_name, location: params.job.location_raw, summary: letterJobSummary(params.job), postingText: params.job.description_text },
      companyResearch: params.research,
      evidenceMap: params.evidenceMap,
      ctx: params.ctx,
      user: { name: params.user.name },
      deps: params.deps,
      length,
      revisionNotes,
      onStep: params.onStep,
    })
  const buildDocs = (l: CoverLetterResult) =>
    l.fullText && l.greeting && l.closing
      ? buildLetterDocuments({ greeting: l.greeting, paragraphs: l.paragraphs, closing: l.closing, user: params.user, company: params.job.company_name, output: params.output })
      : Promise.resolve(null)

  let letter = await draft(params.length ?? LETTER_LENGTH)
  let documents = await buildDocs(letter)
  let onePageRetried = false
  let onePageRetryFrom: number | null = null

  // The render is the only honest page count. One more draft, shorter, then
  // whatever comes back is what the human sees — flagged if still two pages.
  if (documents && spilledPastOnePage(documents.qa)) {
    onePageRetried = true
    onePageRetryFrom = letter.wordCount
    params.onStep?.({ attempt: letter.attempts + 1, detail: `rendered to ${documents.qa.page_count} pages at ${letter.wordCount} words — redrafting at <= ${ONE_PAGE_RETRY_LENGTH.max}` })
    const shorter = await draft(ONE_PAGE_RETRY_LENGTH, [ONE_PAGE_REVISION_NOTE])
    const runs = [...letter.runs, ...shorter.runs]
    const costUsd = Number(runs.reduce((s, r) => s + (r.trace?.cost_usd ?? 0), 0).toFixed(4))
    if (shorter.fullText) {
      const docs2 = await buildDocs(shorter)
      // Keep the shorter draft unless it made things worse: a grounding
      // failure is a flag the first draft did not carry.
      if (docs2 && (!shorter.flagged || letter.flagged)) {
        letter = { ...shorter, runs, costUsd, attempts: letter.attempts + shorter.attempts }
        documents = docs2
      } else {
        letter = { ...letter, runs, costUsd, attempts: letter.attempts + shorter.attempts }
        errors.push(`one-page retry produced a letter with blocking grounding findings; the first draft is kept (${documents.qa.page_count} pages)`)
      }
    } else {
      letter = { ...letter, runs, costUsd, attempts: letter.attempts + shorter.attempts }
      errors.push(`one-page retry: ${shorter.error ?? 'no letter'}; the first draft is kept (${documents.qa.page_count} pages)`)
    }
  }

  let agentRunId: string | null = null
  if (params.run) for (const r of letter.runs) agentRunId = (await params.run.trace(r, { job_id: params.persist?.jobId ?? null, stage: 'cover_letter' })) ?? agentRunId
  if (letter.error) errors.push(letter.error)

  let row: CoverLetter | null = null
  if (params.persist && letter.fullText) {
    const version = await nextLetterVersion(params.persist.userId, params.persist.jobId)
    const ins = await insertCoverLetter({
      user_id: params.persist.userId, job_id: params.persist.jobId, package_id: params.persist.packageId, version,
      greeting: letter.greeting, paragraphs: letter.paragraphs, closing: letter.closing, full_text: letter.fullText,
      word_count: letter.wordCount, claims: letter.claims, grounding: letter.grounding as unknown as Record<string, unknown> | null,
      review_status: 'pending', prompt_version: letter.prompt_version, agent_run_id: agentRunId,
    })
    if (ins.error) errors.push(`cover letter persist: ${ins.error}`)
    row = ins.letter
  }

  const flagged = letter.flagged || (documents !== null && spilledPastOnePage(documents.qa))
  return { letter, row, documents, flagged, costUsd: letter.costUsd, errors, onePageRetried, onePageRetryFrom }
}

// ─── Regenerate from a stored row ────────────────────────────────────────────

/**
 * Full letter text back into greeting / paragraphs / closing. The human edits
 * the whole text, so the split has to be recovered: a first line starting
 * "Dear" is the greeting, a trailing name is dropped, a short comma-ended
 * line before it is the closing.
 */
export function splitLetterText(text: string, name: string): { greeting: string; paragraphs: string[]; closing: string } {
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean)
  let greeting = 'Dear Hiring Manager,'
  let closing = 'Sincerely,'
  if (blocks.length && /^(dear|hello|hi|to whom)/i.test(blocks[0])) greeting = blocks.shift() as string
  if (blocks.length && blocks[blocks.length - 1].trim().toLowerCase() === name.trim().toLowerCase()) blocks.pop()
  const last = blocks[blocks.length - 1]
  if (last && last.split(/\s+/).length <= 4 && /,$/.test(last)) closing = blocks.pop() as string
  return { greeting, paragraphs: blocks, closing }
}

export async function regenerateLetterDocuments(params: { letter: CoverLetter; user: LetterSigner; company: string; output: DocumentOutput }): Promise<LetterDocumentsResult> {
  const { letter } = params
  const parts = letter.edited_text
    ? splitLetterText(letter.edited_text, params.user.name)
    : { greeting: letter.greeting ?? 'Dear Hiring Manager,', paragraphs: letter.paragraphs, closing: letter.closing ?? 'Sincerely,' }
  return buildLetterDocuments({ ...parts, user: params.user, company: params.company, output: params.output })
}
