// Document QA eval — fixtures and the per-case runner.
//
// The question this suite answers is narrow and fully deterministic: for
// company names that break naive filename code and bullet lengths that push
// against the one-page limit, does the document engine produce a valid DOCX,
// a valid one-page PDF, the right filename, and every approved bullet in the
// text? Target is 100% (docs/CAREER_OS.md §9). No judge: nothing here is a
// matter of opinion.
//
// Bullet texts stay within what evals/phase3/user-profile.ts already says
// about the user; nothing personal beyond that is written here.

import path from 'path'
import fs from 'fs'
import { applyResumePatch, extractBulletTexts, type BulletEdit } from '../../lib/career/documents/docx'
import { readDocx, fontsUsed, fontSizesUsed, sectPrOf } from '../../lib/career/documents/docx-read'
import { buildCoverLetterDocx } from '../../lib/career/documents/cover-letter-docx'
import { renderDocxToPdf, type PdfRenderer } from '../../lib/career/documents/pdf'
import { qaResumeDocument, qaCoverLetterDocument } from '../../lib/career/documents/qa'
import { resumeFilenames, coverLetterFilenames } from '../../lib/career/documents/filenames'
import { fitToOnePage, shrinkStrategies, type ShrinkableChange } from '../../lib/career/documents/fit-page'
import type { DocumentQaReport } from '../../lib/career/types'

export const COMPANY_NAMES = [
  '3M',
  'AT&T',
  'Procter & Gamble',
  'Anduril Industries, Inc.',
  'Boston Dynamics',
  'Schlumberger (SLB)',
  'Shield AI',
  "L'Oréal USA",
  'Zipline',
  'A very long company name that goes on and on for testing purposes LLC',
]

export type BulletVariant = 'short' | 'medium' | 'long'
export const BULLET_VARIANTS: BulletVariant[] = ['short', 'medium', 'long']

const PNG = 'procter-and-gamble-tabler-station__quality-assurance-intern'
const UIUC = 'university-of-illinois-at-urbana-champaign__undergraduate-researcher'

/** A change-set per variant, in the shape the shrink strategies understand plus what the patch needs. */
export interface EvalChange extends ShrinkableChange {
  paragraphIndex: number | null
  experienceKey: string
  afterParagraphIndex?: number
}

const LONG = {
  cs: 'Built and piloted a **Controlled State system** for the Beauty Packing line at the largest global manufacturing site, defining an implementation roadmap for further error reduction and process automation, presenting it to site leadership, and handing off documentation so the line could sustain it without the intern — with $4M+ in projected savings.',
  risk: 'Led the annual Quality risk assessment for mis-pack, mis-code and mis-label failure modes with 20+ stakeholders across operations, maintenance and quality, prioritising controls by severity and detectability and closing every open action before the site audit.',
  agent: 'Built an AI agent to streamline all site validation document approvals, replacing a multi-day email review loop with a structured checklist, a draft decision and a reviewer sign-off, and documenting the prompts and guardrails so quality engineers could maintain it.',
  add1: 'Designed a standard-work packet for line clearance that operators could run without engineering support, and trained two shifts on it during the changeover window.',
  add2: 'Ran a small computational study on the catalysis cluster to benchmark two solver settings, cutting wasted CPU-hours on failed convergence runs.',
}

export function changesFor(variant: BulletVariant): EvalChange[] {
  switch (variant) {
    case 'short':
      return [
        { paragraphIndex: 7, experienceKey: PNG, change_type: 'reword', edit_level: 2, original_text: null, proposed_text: 'Led annual Quality risk assessment with 20+ stakeholders.', confidence: 0.95 },
      ]
    case 'medium':
      return [
        { paragraphIndex: 6, experienceKey: PNG, change_type: 'reword', edit_level: 2, original_text: null, proposed_text: 'Piloted a **Controlled State system** on the Beauty Packing line at P&G’s largest global site, mapping a roadmap for further error reduction with $4M+ in projected savings.', confidence: 0.9 },
        { paragraphIndex: null, experienceKey: PNG, afterParagraphIndex: 9, change_type: 'new', edit_level: 4, original_text: null, proposed_text: LONG.add1, confidence: 0.8 },
      ]
    case 'long':
      return [
        { paragraphIndex: 6, experienceKey: PNG, change_type: 'reword', edit_level: 2, original_text: null, proposed_text: LONG.cs, confidence: 0.9 },
        { paragraphIndex: 7, experienceKey: PNG, change_type: 'reword', edit_level: 2, original_text: null, proposed_text: LONG.risk, confidence: 0.9 },
        { paragraphIndex: 9, experienceKey: PNG, change_type: 'reword', edit_level: 2, original_text: null, proposed_text: LONG.agent, confidence: 0.9 },
        { paragraphIndex: null, experienceKey: PNG, afterParagraphIndex: 10, change_type: 'new', edit_level: 4, original_text: null, proposed_text: LONG.add1, confidence: 0.8 },
        { paragraphIndex: null, experienceKey: UIUC, afterParagraphIndex: 18, change_type: 'new', edit_level: 4, original_text: null, proposed_text: LONG.add2, confidence: 0.7 },
      ]
  }
}

/** Fill `original_text` from the master so the "restore shorter original" strategy has something to restore. */
export function withOriginals(changes: EvalChange[], originals: Map<number, string>): EvalChange[] {
  return changes.map((c) => (c.paragraphIndex !== null ? { ...c, original_text: originals.get(c.paragraphIndex) ?? null } : c))
}

export function toPatch(changes: EvalChange[]): BulletEdit[] {
  return changes
    .filter((c) => c.change_type !== 'keep')
    .map((c) =>
      c.paragraphIndex === null
        ? { paragraphIndex: null, experienceKey: c.experienceKey, action: 'insert' as const, text: c.proposed_text ?? '', afterParagraphIndex: c.afterParagraphIndex }
        : { paragraphIndex: c.paragraphIndex, experienceKey: c.experienceKey, action: 'replace' as const, text: c.proposed_text ?? '' },
    )
}

export const COVER_PARAGRAPHS = [
  'I am applying for the Summer 2027 engineering internship. Last summer I built a Controlled State system for a packing line at a large manufacturing site, and I want to keep working on problems where a quality decision has a dollar figure attached to it.',
  'The work that shaped me most was an annual quality risk assessment with more than twenty stakeholders. Screening mis-pack and mis-code failure modes taught me to argue from data rather than seniority, and the validation SOP I wrote is still in use.',
  'Your team asks for someone comfortable with both process rigor and automation. My research group runs computational catalysis on a cluster, and I built an agent that drafts validation approvals, so that combination is where I already work.',
  'I would welcome the chance to discuss how that experience fits the team, and I am glad to share the risk-assessment template or the agent design on request. Thank you for your time.',
]

// ─── Runner ──────────────────────────────────────────────────────────────────

export interface MasterFingerprint {
  buffer: Buffer
  fonts: string[]
  sizes: string[]
  sectPr: string | null
  paragraphCount: number
  originals: Map<number, string>
}

export async function loadMaster(masterPath: string): Promise<MasterFingerprint> {
  const buffer = fs.readFileSync(masterPath)
  const file = await readDocx(buffer)
  const originals = new Map<number, string>()
  for (const b of await extractBulletTexts(buffer)) originals.set(b.paragraphIndex, b.markdown)
  return { buffer, fonts: fontsUsed(file.documentXml), sizes: fontSizesUsed(file.documentXml), sectPr: sectPrOf(file.documentXml), paragraphCount: file.body.paragraphs.length, originals }
}

export interface ResumeCaseResult {
  company: string
  variant: BulletVariant
  filename: string
  ok: boolean
  pageCount: number | null
  shrinkAttempts: number
  renderMs: number[]
  failedChecks: string[]
  report: DocumentQaReport
}

export async function runResumeCase(master: MasterFingerprint, company: string, variant: BulletVariant, outDir: string, renderer: PdfRenderer | null): Promise<ResumeCaseResult> {
  const names = resumeFilenames(company)
  const strategies = shrinkStrategies(withOriginals(changesFor(variant), master.originals))
  const renderMs: number[] = []
  const docxPath = path.join(outDir, names.docx)
  const pdfPath = path.join(outDir, names.pdf)

  const fit = await fitToOnePage({
    expectedPages: 1,
    maxAttempts: strategies.length,
    render: async (attempt) => {
      const set = strategies[attempt]
      if (!set) return null
      const r = await applyResumePatch(master.buffer, { bullets: toPatch(set) })
      return { docx: r.docx }
    },
    toPdf: async (docx, attempt) => {
      if (!renderer) return { ok: false, pageCount: null, pdfPath: null, error: 'no renderer' }
      const p = attempt === 0 ? pdfPath : path.join(outDir, `${path.basename(names.pdf, '.pdf')}.attempt${attempt}.pdf`)
      const r = await renderDocxToPdf(docx, p)
      renderMs.push(r.ms)
      return { ok: r.ok, pageCount: r.pageCount, pdfPath: r.ok ? p : null, error: r.error, ms: r.ms }
    },
  })
  const docx = fit.docx ?? (await applyResumePatch(master.buffer, { bullets: toPatch(strategies[0]) })).docx
  fs.writeFileSync(docxPath, docx)
  if (fit.pdfPath && fit.pdfPath !== pdfPath) fs.copyFileSync(fit.pdfPath, pdfPath)

  // Expect what the surviving change-set INTENDED, not what the DOCX happens to
  // contain — reading the expectation back from the output would make
  // content_match pass by construction.
  const finalSet = strategies[Math.max(0, fit.attempts - 1)] ?? strategies[0]
  const expectedBullets = finalSet.map((c) => c.proposed_text ?? c.original_text ?? '').filter((t) => t.length > 0)
  const report = await qaResumeDocument({
    docx, pdfPath: fit.pdfPath ? pdfPath : null, expectedBullets, expectedPages: 1,
    allowedFonts: master.fonts, allowedFontSizes: master.sizes, masterSectPr: master.sectPr, masterParagraphCount: master.paragraphCount,
    filename: names.docx, company, renderer: renderer?.id ?? null, docxPath,
  })
  report.shrink_attempts = fit.shrink_attempts
  return {
    company, variant, filename: names.docx, ok: report.ok, pageCount: report.page_count, shrinkAttempts: fit.shrink_attempts, renderMs,
    failedChecks: report.checks.filter((c) => !c.pass).map((c) => `${c.name}: ${c.detail}`), report,
  }
}

export interface CoverCaseResult {
  company: string
  filename: string
  ok: boolean
  pageCount: number | null
  renderMs: number | null
  failedChecks: string[]
  report: DocumentQaReport
}

export async function runCoverCase(company: string, outDir: string, renderer: PdfRenderer | null): Promise<CoverCaseResult> {
  const names = coverLetterFilenames(company)
  const docx = await buildCoverLetterDocx({
    name: 'Zuyu Liu', email: 'zuyu@example.com', phone: '555-000-0000', date: 'August 27, 2026',
    recipient: { company }, greeting: 'Dear Hiring Team,', paragraphs: COVER_PARAGRAPHS, closing: 'Sincerely,', signatureName: 'Zuyu Liu',
  })
  const docxPath = path.join(outDir, names.docx)
  fs.writeFileSync(docxPath, docx)
  let pdfPath: string | null = null
  let renderMs: number | null = null
  if (renderer) {
    const p = path.join(outDir, names.pdf)
    const r = await renderDocxToPdf(docx, p)
    renderMs = r.ms
    if (r.ok) pdfPath = p
  }
  const report = await qaCoverLetterDocument({ docx, pdfPath, expectedParagraphs: COVER_PARAGRAPHS, company, filename: names.docx, renderer: renderer?.id ?? null, docxPath })
  return { company, filename: names.docx, ok: report.ok, pageCount: report.page_count, renderMs, failedChecks: report.checks.filter((c) => !c.pass).map((c) => `${c.name}: ${c.detail}`), report }
}
