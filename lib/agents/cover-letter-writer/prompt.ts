// Cover Letter Writer prompt. Bump `version` on ANY semantic change (ADR-009).

import type { VersionedPrompt } from '../runtime/types'

export interface CoverLetterInput {
  job: { title: string; company: string; location: string | null; summary: string }
  companyResearch: {
    /** Grounded why-interesting points and recent developments, each with the research_facts id. */
    points: { id: string; text: string }[]
    summary: string
  }
  evidence: {
    why_i_fit: string | null
    /** ≤ 10 chosen facts. */
    facts: { id: string; text: string }[]
    /** ≤ 2 stories. */
    stories: { id: string; text: string }[]
  }
  user: { name: string }
  /** The growth narrative, drives, structure and avoid-list — NARRATIVE below unless overridden. */
  narrative: string
  length: { min: number; max: number }
  /** Grounding findings from a rejected draft, fed back for one revision. */
  revisionNotes?: string[]
}

export const DEFAULT_LENGTH = { min: 220, max: 340 }

/**
 * Phrases that mark a letter nobody would write by hand. Also enforced as
 * warnings by lib/career/letter/grounding.ts — the prompt says it, the gate
 * checks it.
 */
export const BANNED_PHRASES = [
  'i am impressed by your innovative company',
  'passionate about',
  'i would be honored',
  'dynamic',
  'fast-paced',
  'leverage',
  'synergy',
  'i believe i would be a great fit',
  'hit the ground running',
  'to whom it may concern',
  'esteemed',
  'i am writing to express my interest',
  'proven track record',
  'i am confident that',
  'align with my',
]

export const NARRATIVE = `THE NARRATIVE IS GROWTH.
The through-line of this person is curiosity that leads to action: finding a hard problem, going
after it, building something, and coming out better at the craft. They seek new environments on
purpose — a national lab, a factory floor, a consulting engagement, a startup — because each one
teaches something the last could not. What drives them: learning fast, taking ownership of
difficult problems, building things that work, and getting better. They are direct about that.

STRUCTURE (4–5 paragraphs, 220–340 words)
  1. Why this company, specifically. One or two of the provided research points, in your own
     words, and what about them is interesting to THIS person. Not praise — interest.
  2. The one experience that best answers the role. What the problem was, what they did, what
     came of it. Numbers only from the provided facts, verbatim.
  3. A second angle — a different environment or a story — that shows the growth pattern: the
     move into something unfamiliar and what was learned.
  4. What they would bring and what they want to learn here. Concrete on both.
  5. (optional) One short closing line. A specific ask or a plain statement of interest.

AVOID
  - Sentimentality. No "ever since I was a child", no "dream", no "journey".
  - Résumé narration. Do not walk through experiences in order; choose.
  - Buzzword dumping and adjective stacks. A number or a specific beats an adjective every time.
  - Clichés and the banned phrases below.
  - Flattery of the company. Interest is specific; flattery is generic.
  - Fake company knowledge. Every company-specific fact comes from a provided research point,
    and is listed in claims with that point's id. Nothing from memory.
  - Apologising, hedging about being a student, or over-explaining eligibility.`

export const coverLetterWriterPrompt: VersionedPrompt<CoverLetterInput> = {
  version: '1.0.0',

  build(input) {
    const system = `You write a cover letter for ONE person applying to ONE role. It must read as written by a specific,
curious engineer in their own voice — plain, concrete, a little understated — and it must contain
no claim that cannot be traced to the material you are given.

${input.narrative}

BANNED PHRASES (a deterministic check flags these; do not paraphrase around them into equivalents)
  ${BANNED_PHRASES.map((p) => `"${p}"`).join(', ')}

GROUNDING — the part that is checked by code
  - Every company-specific factual statement (a product, technology, initiative, date, number,
    name, or recent development) MUST come from the provided research points, and MUST appear in
    claims as kind "company" with that point's id as research_fact_id.
  - Every personal quantitative or scope claim (a number, a headcount, a dollar figure, a named
    tool or system) MUST come from the provided facts, and MUST appear in claims as kind
    "personal" with that fact's id as evidence_fact_id.
  - Numbers are copied verbatim from the facts. "$4M+ projected" does not become "$4M saved".
  - If you cannot cite it, do not write it.

FORM
  greeting: "Dear ${input.job.company} Hiring Team," unless a name is given.
  paragraphs: 4 or 5 plain-text paragraphs, no headings, no bullet points.
  closing: "Sincerely," — the name is added by the document.
  Length: ${input.length.min}–${input.length.max} words across the paragraphs.`

    const points = input.companyResearch.points.length
      ? input.companyResearch.points.map((p) => `  [${p.id}] ${p.text}`).join('\n')
      : '  (none — write no company-specific facts; interest must stay general)'
    const facts = input.evidence.facts.length ? input.evidence.facts.map((f) => `  [${f.id}] ${f.text}`).join('\n') : '  (none)'
    const stories = input.evidence.stories.length ? input.evidence.stories.map((s) => `  [${s.id}] ${s.text}`).join('\n') : '  (none)'
    const revision = input.revisionNotes?.length
      ? `\n\nREVISION — the previous draft failed the grounding gate. Fix EXACTLY these and change nothing else:\n${input.revisionNotes.map((n) => `  - ${n}`).join('\n')}`
      : ''

    const user = `APPLICANT: ${input.user.name}

ROLE: ${input.job.title} — ${input.job.company}${input.job.location ? ` (${input.job.location})` : ''}
  ${input.job.summary}

COMPANY RESEARCH (the only source of company facts; cite by id)
  SUMMARY: ${input.companyResearch.summary}
  POINTS:
${points}

WHY THIS PERSON FITS: ${input.evidence.why_i_fit ?? '(not stated)'}

PERSONAL FACTS (the only source of personal numbers and scope; cite by id)
${facts}

STORIES (may be told, briefly)
${stories}${revision}

Write the letter, list every claim with its id, then call submit_result.`

    return { system, user }
  },
}
