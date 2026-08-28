// Deterministic derivation of Evidence Bank rows from a résumé model.
//
// No model is involved in anything here. Which paragraphs are experiences,
// which are bullets, what the education and award lines say about themselves
// — all of it comes from the structural model, so the same DOCX always yields
// the same rows. The importer agent only ever ADDS facts to what this
// produced; it cannot invent an experience the résumé does not contain.

import { stripMarkdown } from '../documents/docx-read'
import type { ResumeExperienceBlock, ResumeModel } from '../documents/resume-model'
import type { ImporterExperienceInput, ImporterExtraSource, ImporterParagraph } from '@/lib/agents/resume-importer'
import type { ExperienceKind, FactSource } from '../types'

export interface ProposedExperience {
  key: string
  kind: ExperienceKind
  organization: string
  title: string
  location: string | null
  start_date: string | null
  end_date: string | null
  description: string | null
  display_order: number
  source: FactSource
  /** Document paragraphs that are real bullets under this experience. */
  bulletParagraphIndexes: number[]
  /** The line that IS the experience (education, awards) — a fact source, not a bullet. */
  identityParagraphIndex: number | null
  /** One sentence from the importer, or null when the agent never saw it. */
  summary: string | null
}

export interface ProposedBullet {
  experience_key: string
  paragraph_index: number
  display_order: number
  /** Markdown with `**` kept — verbatim master text is the truth. */
  text: string
}

export interface ExtraSourceText {
  /** "profile.resume_text", "profile.linkedin_bio_text", "pasted.linkedin" … */
  label: string
  source: FactSource
  text: string
}

// ─── Deterministic derivation from the résumé model ──────────────────────────

function kindFor(section: string | null, title: string): ExperienceKind {
  const s = (section ?? '').toUpperCase()
  if (/RESEARCHER/i.test(title)) return 'research'
  if (s.includes('EDUCATION')) return 'education'
  if (s.includes('AWARD')) return 'award'
  if (s.includes('ENTREPRENEUR') || s.includes('PROJECT')) return 'project'
  if (s.includes('EXPERIENCE')) return 'experience'
  return 'other'
}

function slug(s: string): string {
  return s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}

/**
 * "B.S. Chemical Engineering, University of Illinois (GPA: 3.69/4.00) Expected May 2028"
 *   → title "B.S. Chemical Engineering", org "University of Illinois", end "Expected May 2028"
 */
function parseEducationLine(text: string): { title: string; organization: string; end_date: string | null } {
  // "Expected May 2028", "Expected Graduation: May 2028", "Exp. May 2028".
  const expected = text.match(/\b(?:Expected|Exp\.?)(?:\s+Graduation)?:?\s+[A-Za-z]+\.?\s+\d{4}/)?.[0] ?? null
  const withoutParens = text.replace(/\([^)]*\)/g, ' ').replace(expected ?? '', '').replace(/\s{2,}/g, ' ').trim()
  const comma = withoutParens.indexOf(',')
  if (comma < 0) return { title: withoutParens, organization: withoutParens, end_date: expected }
  return {
    title: withoutParens.slice(0, comma).trim(),
    organization: withoutParens.slice(comma + 1).trim().replace(/[,\s]+$/, ''),
    end_date: expected,
  }
}

/**
 * "Y Combinator Startup School, Summer 2026 (top 5% of applicants)" → the
 * award name. The parenthetical is a fact about the award, not its issuer,
 * so it stays in the description for the importer to mine and the
 * organization repeats the name — the table requires one.
 */
function parseAwardLine(text: string): { title: string; organization: string } {
  const title = text.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s{2,}/g, ' ').trim()
  return { title, organization: title }
}

/**
 * Experience rows from the structural model: the dated blocks the model
 * found, plus one row per education line and one per award line. Pure.
 */
export function deriveExperiences(model: ResumeModel): ProposedExperience[] {
  const out: ProposedExperience[] = []
  let order = 0

  for (const b of model.experiences) {
    out.push({
      key: b.key,
      kind: kindFor(b.section, b.title),
      organization: b.organization,
      title: b.title,
      location: b.location,
      start_date: b.start_date,
      end_date: b.end_date,
      description: null,
      display_order: order++,
      source: 'master_resume',
      bulletParagraphIndexes: [...b.bulletParagraphIndexes],
      identityParagraphIndex: null,
      summary: null,
    })
  }

  // Education and awards are `text` lines under their section headings; the
  // model does not group them because nothing dated follows.
  let section: string | null = null
  for (const p of model.map) {
    if (p.kind === 'section') {
      section = p.text.toUpperCase()
      continue
    }
    if (p.kind !== 'text' || !p.text.trim() || !section) continue
    if (section.includes('EDUCATION')) {
      const e = parseEducationLine(p.text)
      out.push({
        key: `education__${slug(e.title)}`,
        kind: 'education',
        organization: e.organization,
        title: e.title,
        location: null,
        start_date: null,
        end_date: e.end_date,
        description: p.text,
        display_order: order++,
        source: 'master_resume',
        bulletParagraphIndexes: [],
        identityParagraphIndex: p.index,
        summary: null,
      })
    } else if (section.includes('AWARD')) {
      const a = parseAwardLine(p.text)
      out.push({
        key: `award__${slug(a.title)}`,
        kind: 'award',
        organization: a.organization,
        title: a.title,
        location: null,
        start_date: null,
        end_date: null,
        description: p.text,
        display_order: order++,
        source: 'master_resume',
        bulletParagraphIndexes: [],
        identityParagraphIndex: p.index,
        summary: null,
      })
    }
  }
  return out
}

export function deriveBullets(model: ResumeModel, experiences: ProposedExperience[]): ProposedBullet[] {
  const out: ProposedBullet[] = []
  for (const e of experiences) {
    e.bulletParagraphIndexes.forEach((idx, i) => {
      out.push({ experience_key: e.key, paragraph_index: idx, display_order: i, text: model.map[idx].text })
    })
  }
  return out
}

export function importerExperiences(model: ResumeModel, experiences: ProposedExperience[]): ImporterExperienceInput[] {
  return experiences.map((e) => {
    const bullets: ImporterParagraph[] = e.bulletParagraphIndexes.map((idx) => ({
      paragraph_index: idx,
      text: stripMarkdown(model.map[idx].text),
    }))
    if (e.identityParagraphIndex !== null) {
      bullets.push({ paragraph_index: e.identityParagraphIndex, text: model.map[e.identityParagraphIndex].text })
    }
    const block: ResumeExperienceBlock | undefined = model.experiences.find((b) => b.key === e.key)
    return {
      key: e.key,
      title: e.title,
      organization: e.organization,
      location: e.location,
      start_date: e.start_date,
      end_date: e.end_date,
      section: block?.section ?? e.kind,
      bullets,
    }
  })
}

export function linesOf(text: string): ImporterParagraph[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .map((t, i) => ({ paragraph_index: i, text: t }))
    .filter((l) => l.text.length > 0)
}

export function toExtraSources(extra: ExtraSourceText[]): ImporterExtraSource[] {
  return extra.filter((s) => s.text.trim()).map((s) => ({ label: s.label, lines: linesOf(s.text) }))
}

/** Profile free-text fields as importer sources. Empty fields are skipped. */
export function extraSourcesFromProfile(profile: {
  resume_text?: string | null
  linkedin_bio_text?: string | null
  personal_context?: string | null
}): ExtraSourceText[] {
  const out: ExtraSourceText[] = []
  if (profile.resume_text?.trim()) out.push({ label: 'profile.resume_text', source: 'profile', text: profile.resume_text })
  if (profile.linkedin_bio_text?.trim()) out.push({ label: 'profile.linkedin_bio_text', source: 'linkedin', text: profile.linkedin_bio_text })
  if (profile.personal_context?.trim()) out.push({ label: 'profile.personal_context', source: 'profile', text: profile.personal_context })
  return out
}
