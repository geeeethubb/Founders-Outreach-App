// Structural model of a résumé DOCX: which paragraph is a section heading,
// which is an experience title, which is a bullet, and how they group.
//
// Deterministic classification from formatting and content. Shared by the
// evidence importer (which turns bullets into Evidence Bank rows) and the
// document engine (which edits bullets in place), so both see the same map.
//
// Tuned on the master résumé's layout — bold section headings in capitals,
// a bold title line with the location tab-aligned to the right, an italic
// organization line carrying the dates, then bullets. Anything that does not
// fit is reported as `text`, never guessed.

import type { DocxFile, DocxParagraph } from './docx-read'
import { paragraphMarkdown } from './docx-read'
import type { ResumeParagraphKind, ResumeParagraphMapEntry } from '../types'

export interface ResumeExperienceBlock {
  /** Stable, human-readable key, e.g. "procter-gamble-tabler-station__quality-assurance-intern". */
  key: string
  section: string | null
  title: string
  organization: string
  location: string | null
  start_date: string | null
  end_date: string | null
  titleParagraphIndex: number
  orgParagraphIndex: number | null
  bulletParagraphIndexes: number[]
}

export interface ResumeModel {
  map: ResumeParagraphMapEntry[]
  experiences: ResumeExperienceBlock[]
  sections: { name: string; paragraphIndex: number }[]
  name: string | null
  headline: string | null
}

const DATE_RE = /(\d{1,2}\/\d{4}|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}|\b20\d{2}\b|\bPresent\b)/i

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

/** Split a tab-aligned line into its left and right halves. */
function splitAligned(text: string): { left: string; right: string | null } {
  const parts = text.split(/\t+|\s{3,}/).map((p) => p.trim()).filter(Boolean)
  if (parts.length <= 1) return { left: parts[0] ?? text.trim(), right: null }
  return { left: parts[0], right: parts.slice(1).join(' ') }
}

/** "5/2026 – 8/2026" → ["5/2026", "8/2026"]; "9/2025 – Present" → ["9/2025", "Present"]. */
function splitDates(s: string | null): { start: string | null; end: string | null } {
  if (!s) return { start: null, end: null }
  const parts = s.split(/\s*[–—-]\s*/).map((p) => p.trim()).filter(Boolean)
  if (parts.length === 0) return { start: null, end: null }
  if (parts.length === 1) return { start: parts[0], end: null }
  return { start: parts[0], end: parts[1] }
}

function isMostlyBold(p: DocxParagraph): boolean {
  const total = p.runs.reduce((n, r) => n + r.text.trim().length, 0)
  if (total === 0) return /<w:b\/>/.test(p.pPr ?? '')
  const bold = p.runs.filter((r) => r.bold).reduce((n, r) => n + r.text.trim().length, 0)
  return bold / total >= 0.6
}

function isMostlyItalic(p: DocxParagraph): boolean {
  const total = p.runs.reduce((n, r) => n + r.text.trim().length, 0)
  if (total === 0) return false
  const italic = p.runs.filter((r) => r.italic).reduce((n, r) => n + r.text.trim().length, 0)
  return italic / total >= 0.5
}

function isSectionHeading(p: DocxParagraph): boolean {
  const t = p.text.replace(/\s+/g, ' ').trim()
  if (!t || t.length > 48 || /\d/.test(t)) return false
  const letters = t.replace(/[^A-Za-z]/g, '')
  return letters.length >= 4 && letters === letters.toUpperCase() && isMostlyBold(p)
}

function classify(p: DocxParagraph, index: number, next: DocxParagraph | null, firstSectionSeen: boolean): ResumeParagraphKind {
  const t = p.text.trim()
  if (p.isBullet) return 'bullet'
  if (!t) return 'text'
  if (/@|linkedin\.com|\(\d{3}\)|\d{3}[-.\s]\d{3}[-.\s]\d{4}/i.test(t)) return 'contact'
  if (!firstSectionSeen && index === 0) return 'name'
  if (isSectionHeading(p)) return 'section'
  if (!firstSectionSeen && isMostlyItalic(p)) return 'headline'
  // An experience title is bold, not a heading, and the next line is the
  // organization line carrying a date. Awards are bold too, but nothing dated
  // follows them.
  if (isMostlyBold(p) && next && !next.isBullet && DATE_RE.test(next.text)) return 'exp_title'
  if (isMostlyBold(p) && DATE_RE.test(t) && next?.isBullet) return 'exp_title'
  return 'text'
}

export function buildResumeModel(file: DocxFile): ResumeModel {
  const paragraphs = file.body.paragraphs
  const map: ResumeParagraphMapEntry[] = []
  const experiences: ResumeExperienceBlock[] = []
  const sections: { name: string; paragraphIndex: number }[] = []
  let name: string | null = null
  let headline: string | null = null
  let firstSectionSeen = false
  let currentSection: string | null = null
  let current: ResumeExperienceBlock | null = null

  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i]
    const next = paragraphs[i + 1] ?? null
    const kind = classify(p, i, next, firstSectionSeen)
    const text = kind === 'bullet' ? paragraphMarkdown(p) : p.text.replace(/\t+/g, ' ').replace(/\s{2,}/g, ' ').trim()

    const entry: ResumeParagraphMapEntry = { index: i, kind, text }

    switch (kind) {
      case 'name':
        name = text
        break
      case 'headline':
        headline = text
        break
      case 'section':
        firstSectionSeen = true
        currentSection = text
        sections.push({ name: text, paragraphIndex: i })
        current = null
        break
      case 'exp_title': {
        const { left, right } = splitAligned(p.text)
        // The org line is the next paragraph unless the title line itself carries the date.
        const orgLine = next && !next.isBullet && DATE_RE.test(next.text) ? next : null
        const org = orgLine ? splitAligned(orgLine.text) : { left: '', right: right }
        const dates = splitDates(orgLine ? org.right : right)
        const block: ResumeExperienceBlock = {
          key: `${slug(org.left || left)}__${slug(left)}`,
          section: currentSection,
          title: left,
          organization: org.left || left,
          location: orgLine ? right : null,
          start_date: dates.start,
          end_date: dates.end,
          titleParagraphIndex: i,
          orgParagraphIndex: orgLine ? i + 1 : null,
          bulletParagraphIndexes: [],
        }
        experiences.push(block)
        current = block
        entry.experience_key = block.key
        break
      }
      case 'bullet':
        if (current) {
          current.bulletParagraphIndexes.push(i)
          entry.experience_key = current.key
        }
        break
      default:
        break
    }

    // The org line was classified as `text` by the loop; relabel it.
    if (current && current.orgParagraphIndex === i) {
      entry.kind = 'exp_org'
      entry.experience_key = current.key
    }

    map.push(entry)
  }

  return { map, experiences, sections, name, headline }
}

/** Bullets in document order for one experience, as markdown text. */
export function bulletsOf(model: ResumeModel, key: string): { paragraphIndex: number; text: string }[] {
  const block = model.experiences.find((e) => e.key === key)
  if (!block) return []
  return block.bulletParagraphIndexes.map((i) => ({ paragraphIndex: i, text: model.map[i].text }))
}
