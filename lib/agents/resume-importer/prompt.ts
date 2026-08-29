// Resume Importer prompt. Bump `version` on ANY semantic change (ADR-009).

import type { VersionedPrompt } from '../runtime/types'

/** One paragraph the agent may cite. In résumé mode the index is the DOCX body index. */
export interface ImporterParagraph {
  paragraph_index: number
  text: string
}

export interface ImporterExperienceInput {
  key: string
  title: string
  organization: string
  location: string | null
  start_date: string | null
  end_date: string | null
  section: string | null
  /** Bullet paragraphs (plain text, `**` stripped) — or the single identity line for education / awards. */
  bullets: ImporterParagraph[]
  /**
   * Set when this block is a row already in the bank (text mode). The key is
   * the row id; the agent files facts from the pasted text under it when the
   * text describes the same role.
   */
  existing_id?: string | null
}

/**
 * Free text with no paragraph map — profile fields, pasted LinkedIn text. Each
 * line is a paragraph so a fact can still name the line it came from.
 */
export interface ImporterExtraSource {
  /** e.g. "profile.resume_text", "pasted.linkedin" — becomes the fact's source_label. */
  label: string
  lines: ImporterParagraph[]
}

export interface ResumeImporterInput {
  experiences: ImporterExperienceInput[]
  extra_sources: ImporterExtraSource[]
  /**
   * True only for pasted text with no résumé structure. The agent may then
   * propose experience blocks of its own; validation requires an organization
   * and a title on each. When `experiences` are also supplied they are the
   * bank's existing rows, and a new block is allowed only when none fits.
   */
  allow_new_experiences: boolean
}

export const RESUME_SOURCE_LABEL = 'master_resume'

export const resumeImporterPrompt: VersionedPrompt<ResumeImporterInput> = {
  version: '1.1.0',

  build(input) {
    const existing = input.allow_new_experiences && input.experiences.length > 0
    const system = `You turn résumé text into an Evidence Bank: atomic facts, metrics, skills and deliverables, each tied to the
experience it belongs to and the exact paragraph that asserts it.

You are NOT writing a résumé and NOT improving one. You are recording what the text ACTUALLY SAYS, so that
later a separate system can check any claim against these facts. Anything you add that the text does not
say will be caught by a deterministic check and thrown away — and every thrown-away fact is a mark against
the run. So:

  - ONE atomic claim per fact. "Built and piloted a Controlled State system for the Beauty Packing line"
    and "the roadmap projected $4M+ savings" are two facts, not one.
  - Keep the text's own numbers VERBATIM, including units and suffixes ("$4M+", "1,600+", "30%", "73k").
    Never round, convert, or infer a number. If the text says "Fortune 500", the fact says "Fortune 500".
  - Cite the paragraph the fact comes from. A fact must come from exactly one paragraph.
  - Scope facts (team size, site, audience) and context facts (what the organization is) count too.

CATEGORIES — responsibility (what they did), achievement (what happened as a result), metric (a number
with meaning), skill, tool, context, award, education, scope, other.

METRICS are the numbers worth citing on their own: value exactly as written ("$4M+"), a unit
("projected savings", "productivity hours", "percent reduction"), a short context, and fact_refs — the
indexes (0-based, within this experience's facts array) of the facts that carry the number.

SKILLS are named things a job description could ask for: tools ("VASP", "n8n"), techniques
("techno-economic analysis"), domains ("quality assurance"). Use the name that appears in the text —
"VASP" from "ASE/VASP" is fine; "Python" when Python is never mentioned is not. Category: technical,
tool, domain, business, language, other.

DELIVERABLES are concrete artifacts: a whitepaper, a report, an SOP, a platform, a system.

PROJECTS are named pieces of work under an experience — a hackathon the text calls "Forge 2026", a product
called "Keywords", a summit with a name. Propose a project ONLY when the text names it; the name must appear
in the text verbatim. A project points at the experience it happened under (experience_ref = the index of
that experience in your output, or an existing experience id) and at the facts about it (fact_refs, within
that experience's facts). Never propose a project for unnamed work.

SUMMARY — one sentence per experience, in plain English, that a person skimming the bank would recognize.

${
  existing
    ? `EXISTING EXPERIENCES — the bank already holds the rows listed below, each with its id as the key. When the
pasted text describes one of those same roles — the same organization and the same or a closely related
title — file its facts under that key. "President" and "President (previously Head of Events)" are the same
role; "Head of Events" and "President" are NOT; "Vice President" and "President" are NOT. In that case also
fill new_experience with the title, organization and dates AS THIS TEXT STATES THEM (that is how a
disagreement between sources gets recorded); leave it null only when the text gives none. Propose a NEW
block (a fresh slug key, e.g. "acme__engineering-intern", with new_experience filled) only when no existing
row fits. Facts cite the source label and line index they came from.`
    : input.allow_new_experiences
    ? `EXPERIENCE BLOCKS — no structure was supplied, so infer them from the text. Each block needs an organization
and a title exactly as the text states them; dates and location when present. Use a short slug as the key
("acme__engineering-intern"). Facts cite the source label and line index they came from.`
    : `EXPERIENCE KEYS — use ONLY the keys supplied below, exactly. A fact from a bullet under one experience belongs
to that experience. Do not invent experiences.`
}

CONFIDENCE — 1.0 when the paragraph states it outright; lower only when the wording is genuinely ambiguous.`

    const lines: string[] = []
    if (input.experiences.length) {
      lines.push(existing ? 'EXISTING EXPERIENCES IN THE BANK (key = row id; file matching facts here):' : 'EXPERIENCES (cite paragraph indexes exactly as shown):')
      for (const e of input.experiences) {
        const dates = [e.start_date, e.end_date].filter(Boolean).join(' – ')
        lines.push('')
        lines.push(`[key: ${e.key}] ${e.title} — ${e.organization}${dates ? ` (${dates})` : ''}${e.location ? ` · ${e.location}` : ''}${e.section ? ` · section: ${e.section}` : ''}`)
        for (const b of e.bullets) lines.push(`  ¶${b.paragraph_index}: ${b.text}`)
      }
    }
    if (input.extra_sources.length) {
      lines.push('')
      lines.push(existing ? 'TEXT TO IMPORT (cite by source_label and line index):' : 'ADDITIONAL SOURCES (cite by source_label and line index):')
      for (const s of input.extra_sources) {
        lines.push('')
        lines.push(`[source_label: ${s.label}]`)
        for (const l of s.lines) lines.push(`  L${l.paragraph_index}: ${l.text}`)
      }
    }

    const user = `${lines.join('\n')}

TASK
For every experience, list the atomic facts the text asserts, the metrics, the skills it names, and the
deliverables it describes. Then one summary sentence. Cite the paragraph (source_label "${RESUME_SOURCE_LABEL}"
for résumé paragraphs, or the additional source's label with its line index) on every fact. List named
projects, if any, in the top-level "projects" array.

Submit with the ${'`submit_result`'} tool.`

    return { system, user }
  },
}
