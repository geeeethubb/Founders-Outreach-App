// Cover letter DOCX, built from scratch with the `docx` library.
//
// Unlike the résumé there is no template to preserve, so the whole document
// is declared here: Letter size, 1" margins, Times New Roman 12 pt set as the
// document default (so every run inherits it and QA can check a single
// place), 1.15 line spacing, 6 pt after each paragraph, business-letter
// structure. No tables, headers, footers or fields — the simplest possible
// package, because an ATS parser that chokes on a text box has cost people
// interviews.

import { AlignmentType, Document, Packer, Paragraph, TextRun } from 'docx'

export interface CoverLetterDocxInput {
  name: string
  email: string
  phone: string
  linkedin?: string
  /** Already formatted, e.g. "August 27, 2026". */
  date: string
  recipient: { company: string; addressLines?: string[] }
  greeting: string
  paragraphs: string[]
  /** e.g. "Sincerely," */
  closing: string
  signatureName: string
}

const FONT = 'Times New Roman'
const SIZE_HALF_POINTS = 24
const LINE_115 = 276
const AFTER_6PT = 120
const ONE_INCH = 1440

function para(text: string, opts: { bold?: boolean } = {}): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.LEFT,
    spacing: { after: AFTER_6PT, line: LINE_115, lineRule: 'auto' },
    children: text ? [new TextRun({ text, bold: opts.bold, font: FONT, size: SIZE_HALF_POINTS })] : [],
  })
}

/** Formats a Date as "August 27, 2026". Callers pass the string; this is for convenience. */
export function formatLetterDate(d: Date): string {
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}

export async function buildCoverLetterDocx(input: CoverLetterDocxInput): Promise<Buffer> {
  const contact = [input.email, input.phone, input.linkedin].filter((s): s is string => !!s && s.trim().length > 0).join(' | ')
  const children: Paragraph[] = [
    para(input.name, { bold: true }),
    para(contact),
    para(''),
    para(input.date),
    para(''),
    para(input.recipient.company),
    ...(input.recipient.addressLines ?? []).map((l) => para(l)),
    para(''),
    para(input.greeting),
    ...input.paragraphs.map((p) => para(p)),
    para(input.closing),
    para(input.signatureName),
  ]

  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: FONT, size: SIZE_HALF_POINTS } },
      },
      paragraphStyles: [
        {
          id: 'Normal',
          name: 'Normal',
          run: { font: FONT, size: SIZE_HALF_POINTS },
          paragraph: { spacing: { after: AFTER_6PT, line: LINE_115 } },
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 12240, height: 15840 },
            margin: { top: ONE_INCH, right: ONE_INCH, bottom: ONE_INCH, left: ONE_INCH },
          },
        },
        children,
      },
    ],
  })
  return Packer.toBuffer(doc)
}
