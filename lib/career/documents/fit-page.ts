// The one-page fix loop.
//
// A tailored résumé that spills onto page 2 is worse than an untailored one.
// The loop is deliberately generic: it renders, counts pages, and when the
// count is over, asks the caller for the next attempt. The caller decides
// what "smaller" means, through `shrinkStrategies`, which only ever removes
// or restores CONTENT. Fonts, sizes and margins are never candidates — a
// 9 pt résumé is a failure that happens to fit.

import type { ChangeType, EditLevel } from '../types'

export interface FitPageAttempt {
  attempt: number
  pageCount: number | null
  pdfPath: string | null
  ok: boolean
  error?: string
  renderMs?: number
}

export interface FitPageResult {
  ok: boolean
  docx: Buffer | null
  pdfPath: string | null
  pageCount: number | null
  /** Renders performed. */
  attempts: number
  /** Renders beyond the first — what DocumentQaReport.shrink_attempts records. */
  shrink_attempts: number
  history: FitPageAttempt[]
  error?: string
}

export interface FitPageInput {
  /** Produce the DOCX for attempt n (0-based). Return null when no further shrink is possible. */
  render: (attempt: number) => Promise<{ docx: Buffer } | null>
  /** Render to PDF. `pageCount` null means the PDF could not be produced. */
  toPdf: (docx: Buffer, attempt: number) => Promise<{ ok: boolean; pageCount: number | null; pdfPath: string | null; error?: string; ms?: number }>
  expectedPages: number
  maxAttempts?: number
}

export async function fitToOnePage(input: FitPageInput): Promise<FitPageResult> {
  const maxAttempts = input.maxAttempts ?? 3
  const history: FitPageAttempt[] = []
  let last: { docx: Buffer; pdfPath: string | null; pageCount: number | null } | null = null

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const built = await input.render(attempt)
    if (!built) break
    const pdf = await input.toPdf(built.docx, attempt)
    history.push({ attempt, pageCount: pdf.pageCount, pdfPath: pdf.pdfPath, ok: pdf.ok, error: pdf.error, renderMs: pdf.ms })
    last = { docx: built.docx, pdfPath: pdf.pdfPath, pageCount: pdf.pageCount }
    if (!pdf.ok || pdf.pageCount === null) {
      // No page count means no way to judge; hand the DOCX back and let QA say the PDF is missing.
      return { ok: false, docx: built.docx, pdfPath: pdf.pdfPath, pageCount: null, attempts: history.length, shrink_attempts: Math.max(0, history.length - 1), history, error: pdf.error ?? 'no page count' }
    }
    if (pdf.pageCount <= input.expectedPages) {
      return { ok: true, docx: built.docx, pdfPath: pdf.pdfPath, pageCount: pdf.pageCount, attempts: history.length, shrink_attempts: Math.max(0, history.length - 1), history }
    }
  }

  return {
    ok: false,
    docx: last?.docx ?? null,
    pdfPath: last?.pdfPath ?? null,
    pageCount: last?.pageCount ?? null,
    attempts: history.length,
    shrink_attempts: Math.max(0, history.length - 1),
    history,
    error: last ? `still ${last.pageCount} pages after ${history.length} attempt(s)` : 'nothing rendered',
  }
}

// ─── Shrink strategies ───────────────────────────────────────────────────────

/** The subset of ProposedChange the strategies need; anything structurally compatible (bullet ids, paragraph indexes) passes through untouched. */
export interface ShrinkableChange {
  change_type: ChangeType
  edit_level: EditLevel
  original_text: string | null
  proposed_text: string | null
  confidence: number
}

function isReword(c: ShrinkableChange): boolean {
  return (c.change_type === 'reword' || c.change_type === 'swap') && !!c.original_text && !!c.proposed_text && c.original_text !== c.proposed_text
}

function restored<T extends ShrinkableChange>(c: T): T {
  return { ...c, change_type: 'keep', edit_level: 0, proposed_text: c.original_text }
}

/**
 * Successive change-sets, each strictly smaller in content than the last:
 *   1. restore the original for every reworded bullet whose original was shorter
 *   2. drop Level-4 additions one at a time, lowest confidence first
 *   3. restore reworded bullets one at a time, longest proposed text first
 * The first element is the input unchanged (attempt 0). Duplicates are elided,
 * so a patch with nothing to shrink yields a single attempt.
 */
export function shrinkStrategies<T extends ShrinkableChange>(changes: T[]): T[][] {
  const out: T[][] = [changes]
  let current = changes

  const push = (next: T[]) => {
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      out.push(next)
      current = next
    }
  }

  // 1. shorter originals back
  push(current.map((c) => (isReword(c) && (c.original_text as string).length < (c.proposed_text as string).length ? restored(c) : c)))

  // 2. drop Level-4 additions, lowest confidence first
  const additions = current
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.change_type === 'new' && c.edit_level === 4)
    .sort((a, b) => a.c.confidence - b.c.confidence)
  for (const { c } of additions) push(current.filter((x) => x !== c))

  // 3. restore remaining rewords, longest first
  const rewords = current.filter(isReword).sort((a, b) => (b.proposed_text as string).length - (a.proposed_text as string).length)
  for (const r of rewords) push(current.map((c) => (c === r ? restored(c) : c)))

  return out
}
