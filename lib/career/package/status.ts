// What the human is told when a package fails, and what counts as finished.
//
// Pure functions over strings and paths — no DB, no fs, no model. The server
// uses them to decide READY_FOR_REVIEW; the review screen imports the same
// translation so the sentence in the UI and the sentence in the diagnostics
// can never drift apart.
//
// Two rules behind this file:
//
//   1. An infrastructure failure is not the user's fault and must not read
//      like it. "ENOENT: no such file or directory, mkdir '.career-out/tmp'"
//      told the founder nothing except that something they paid for broke.
//      The raw text is never thrown away — it moves into a disclosure.
//   2. "Ready" is a statement about artifacts that exist, not about a stage
//      counter reaching the end. A half-uploaded package must read as failed.

export type PackageErrorKind = 'temp_workspace' | 'storage' | 'master_missing' | 'renderer' | 'qa' | 'timeout' | 'unknown'

export interface PackageErrorExplanation {
  kind: PackageErrorKind
  /** One sentence, in the founder's language, safe to show as the headline. */
  headline: string
  /** What is still intact. Empty when the failure says nothing about that. */
  reassurance: string
  /** True when `Retry documents` is the right next action (no re-tailoring needed). */
  retryDocuments: boolean
}

const SAFE = 'Your research, fit analysis and approved résumé changes are safe — nothing was re-run and nothing was charged again.'

/**
 * Translate a stored `application_packages.error` for the primary UI.
 * Unknown text is passed through as its own headline: a failure we cannot
 * name is still shown, never swallowed (principle 9).
 */
export function explainPackageError(raw: string | null | undefined): PackageErrorExplanation {
  const text = (raw ?? '').trim()
  const low = text.toLowerCase()
  if (!text) return { kind: 'unknown', headline: 'The package failed and no error text was recorded.', reassurance: '', retryDocuments: true }

  if (/enoent|mkdir|temporary document workspace|temp directory|eacces|eperm|no such file or directory/.test(low) && !/master résumé|master resume/.test(low)) {
    return {
      kind: 'temp_workspace',
      headline: 'Document build failed — the temporary document workspace could not be created.',
      reassurance: SAFE,
      retryDocuments: true,
    }
  }
  // BEFORE the storage test, deliberately. The only sentence that produces this
  // kind — "master résumé file is missing from storage — re-import it"
  // (package/documents.ts) — contains the word "storage", so a storage-first
  // order swallowed it and offered a `Retry documents` button that would fail
  // identically for ever. The remedy here is a different one: re-import.
  if (/master résumé|master resume/.test(low)) {
    return {
      kind: 'master_missing',
      headline: 'Document build failed — your master résumé could not be read from storage.',
      reassurance: 'Re-import the master résumé on the Evidence page, then retry the documents. Your approved changes for this job are untouched.',
      retryDocuments: false,
    }
  }
  if (/storage|bucket|upload|refusing to overwrite|temporary path/.test(low)) {
    return {
      kind: 'storage',
      headline: 'Document build failed — the finished documents could not be stored.',
      reassurance: SAFE,
      retryDocuments: true,
    }
  }
  if (/no pdf renderer|pdf render|word could not be started|libreoffice/.test(low)) {
    return {
      kind: 'renderer',
      headline: 'Document build failed while rendering the PDF.',
      reassurance: SAFE,
      retryDocuments: true,
    }
  }
  if (/document qa failed/.test(low)) {
    return {
      kind: 'qa',
      headline: 'The documents were built but failed QA, so the package was not marked ready.',
      reassurance: 'The QA report below says which check failed. Nothing was submitted anywhere.',
      retryDocuments: true,
    }
  }
  if (/timed out|timeout|deadline/.test(low)) {
    return {
      kind: 'timeout',
      headline: 'Document build ran out of time before it finished.',
      reassurance: SAFE,
      retryDocuments: true,
    }
  }
  return { kind: 'unknown', headline: text, reassurance: '', retryDocuments: true }
}

// ─── Readiness ───────────────────────────────────────────────────────────────

export interface PackageArtifacts {
  resumeDocxPath: string | null
  resumeQaPresent: boolean
  coverDocxPath: string | null
  coverQaPresent: boolean
  coverLetterText: string | null
}

/**
 * What a complete package must have. A PDF is deliberately NOT on the list:
 * a machine with no Word and no LibreOffice produces a DOCX-only package,
 * which is a warning, not a failure (ADR-033).
 */
export function missingArtifacts(a: PackageArtifacts): string[] {
  const missing: string[] = []
  if (!a.resumeDocxPath) missing.push('résumé DOCX')
  if (!a.resumeQaPresent) missing.push('résumé QA report')
  if (!a.coverLetterText) missing.push('cover letter text')
  if (!a.coverDocxPath) missing.push('cover letter DOCX')
  if (!a.coverQaPresent) missing.push('cover letter QA report')
  return missing
}
