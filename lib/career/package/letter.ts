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
 * Tighter than the writer's DEFAULT_LENGTH. Its validator accepts up to
 * max+40 words, and a 377-word letter in Times 12 / 1.15 spacing with the
 * header block rendered to two pages on the first live run; QA's one_page
 * check then fails the package. 300 keeps the ceiling at 340.
 */
export const LETTER_LENGTH = { min: 220, max: 300 }

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
}

export async function generateCoverLetter(params: GenerateLetterParams): Promise<GenerateLetterResult> {
  const errors: string[] = []
  const letter = await runCoverLetterPipeline({
    bank: params.bank,
    job: { title: params.job.title, company: params.job.company_name, location: params.job.location_raw, summary: letterJobSummary(params.job) },
    companyResearch: params.research,
    evidenceMap: params.evidenceMap,
    ctx: params.ctx,
    user: { name: params.user.name },
    deps: params.deps,
    length: params.length ?? LETTER_LENGTH,
    onStep: params.onStep,
  })
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

  let documents: LetterDocumentsResult | null = null
  if (letter.fullText && letter.greeting && letter.closing) {
    documents = await buildLetterDocuments({
      greeting: letter.greeting, paragraphs: letter.paragraphs, closing: letter.closing, user: params.user, company: params.job.company_name, output: params.output,
    })
  }
  return { letter, row, documents, flagged: letter.flagged, costUsd: letter.costUsd, errors }
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
