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
   * and a title on each.
   */
  allow_new_experiences: boolean
}

export const RESUME_SOURCE_LABEL = 'master_resume'

export const resumeImporterPrompt: VersionedPrompt<ResumeImporterInput> = {
  version: '1.0.0',

  build(input) {
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

SUMMARY — one sentence per experience, in plain English, that a person skimming the bank would recognize.

${
  input.allow_new_experiences
    ? `EXPERIENCE BLOCKS — no structure was supplied, so infer them from the text. Each block needs an organization
and a title exactly as the text states them; dates and location when present. Use a short slug as the key
("acme__engineering-intern"). Facts cite the source label and line index they came from.`
    : `EXPERIENCE KEYS — use ONLY the keys supplied below, exactly. A fact from a bullet under one experience belongs
to that experience. Do not invent experiences.`
}

CONFIDENCE — 1.0 when the paragraph states it outright; lower only when the wording is genuinely ambiguous.`

    const lines: string[] = []
    if (input.experiences.length) {
      lines.push('EXPERIENCES (cite paragraph indexes exactly as shown):')
      for (const e of input.experiences) {
        const dates = [e.start_date, e.end_date].filter(Boolean).join(' – ')
        lines.push('')
        lines.push(`[key: ${e.key}] ${e.title} — ${e.organization}${dates ? ` (${dates})` : ''}${e.location ? ` · ${e.location}` : ''}${e.section ? ` · section: ${e.section}` : ''}`)
        for (const b of e.bullets) lines.push(`  ¶${b.paragraph_index}: ${b.text}`)
      }
    }
    if (input.extra_sources.length) {
      lines.push('')
      lines.push('ADDITIONAL SOURCES (cite by source_label and line index):')
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
for résumé paragraphs, or the additional source's label with its line index) on every fact.

Submit with the ${'`submit_result`'} tool.`

    return { system, user }
  },
}
