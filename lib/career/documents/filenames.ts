// Filenames for application packages.
//
// Recruiters see the filename before they see the document. It must carry the
// candidate's name and the company's, survive every ATS upload filter (ASCII,
// no spaces, no punctuation an S3 key would mangle), and still read as a name.
// Sanitization is deterministic so QA can recompute the expected name and
// compare rather than trust what was written.

const LEGAL_SUFFIX = /[\s,]+(?:incorporated|inc|corporation|corp|company|co|llc|l\.l\.c|ltd|limited|plc|gmbh|s\.a|ag)\.?$/i

const MAX_LEN = 40
export const DEFAULT_PERSON = 'Zuyu_Liu'

function asciiFold(s: string): string {
  // Decompose accents into base letter + combining mark, then drop the marks.
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[ßẞ]/g, 'ss')
    .replace(/[Øø]/g, 'o')
    .replace(/[Łł]/g, 'l')
    .replace(/[Đđ]/g, 'd')
    .replace(/Æ/g, 'AE')
    .replace(/æ/g, 'ae')
    .replace(/Œ/g, 'OE')
    .replace(/œ/g, 'oe')
}

export function sanitizeCompanyForFilename(raw: string): string {
  let s = asciiFold((raw ?? '').trim())
  // Strip legal suffixes repeatedly ("Foo Holdings Co., Ltd." → "Foo Holdings").
  for (let i = 0; i < 4; i++) {
    const next = s.replace(LEGAL_SUFFIX, '').replace(/[\s,.]+$/, '')
    if (next === s) break
    s = next
  }
  s = s
    .replace(/&/g, ' and ')
    .replace(/\//g, '-')
    .replace(/['’]/g, '')
    .replace(/[^A-Za-z0-9-]+/g, '_')
    .replace(/_?-_?/g, '-')
    .replace(/^_+|_+$/g, '')
  if (s.length > MAX_LEN) s = s.slice(0, MAX_LEN).replace(/_+$/, '')
  return s || 'Company'
}

export interface PackageFilenames {
  docx: string
  pdf: string
}

export function resumeFilenames(company: string, person = DEFAULT_PERSON): PackageFilenames {
  const base = `${person}_${sanitizeCompanyForFilename(company)}_Resume`
  return { docx: `${base}.docx`, pdf: `${base}.pdf` }
}

export function coverLetterFilenames(company: string, person = DEFAULT_PERSON): PackageFilenames {
  const base = `${person}_${sanitizeCompanyForFilename(company)}_Cover_Letter`
  return { docx: `${base}.docx`, pdf: `${base}.pdf` }
}

/** Does a filename match the expected pattern for this company and document kind? */
export function filenameMatches(filename: string, company: string, kind: 'resume' | 'cover_letter', person = DEFAULT_PERSON): boolean {
  const expected = kind === 'resume' ? resumeFilenames(company, person) : coverLetterFilenames(company, person)
  const base = filename.replace(/^.*[\\/]/, '')
  return base === expected.docx || base === expected.pdf
}
