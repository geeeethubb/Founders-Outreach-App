// Resume Tailor prompt. Bump `version` on ANY semantic change (ADR-009).

import type { VersionedPrompt } from '../runtime/types'

export interface TailorJob {
  title: string
  company: string
  /** Minimum + preferred qualifications + top skills, ≤ 15. */
  key_requirements: string[]
  /** ≤ 8. */
  responsibilities: string[]
  /** ≤ 2000 chars. */
  description_excerpt: string
}

export interface TailorBullet {
  id: string
  /** `**` stripped. */
  text: string
  is_on_master: boolean
  fact_ids: string[]
}

export interface TailorExperience {
  id: string
  label: string
  bullets: TailorBullet[]
  facts: { id: string; statement: string }[]
  metrics: { id: string; value: string; unit: string | null; context: string | null }[]
}

export interface TailorEvidenceMap {
  why_i_fit: string | null
  emphasize: string[]
  do_not_claim: string[]
  top_experience_ids: string[]
}

export interface ResumeTailorInput {
  job: TailorJob
  evidenceMap: TailorEvidenceMap
  experiences: TailorExperience[]
  /** Rendered from lib/career/tailor/rules.ts. */
  rules: string
}

function list(items: string[], empty = '(none)'): string {
  return items.length ? items.map((s) => `  - ${s}`).join('\n') : `  ${empty}`
}

function renderExperience(e: TailorExperience): string {
  const lines = [`EXPERIENCE [${e.id}] ${e.label}`]
  lines.push('  BULLETS (on the master unless marked alternate):')
  for (const b of e.bullets) {
    lines.push(`    [${b.id}]${b.is_on_master ? '' : ' (alternate — swap source only)'} ${b.text}`)
  }
  if (e.facts.length) {
    lines.push('  FACTS (cite by id in evidence_fact_ids):')
    for (const f of e.facts) lines.push(`    [${f.id}] ${f.statement}`)
  }
  if (e.metrics.length) {
    lines.push('  METRICS (also citable by id):')
    for (const m of e.metrics) {
      lines.push(`    [${m.id}] ${m.value}${m.unit ? ` ${m.unit}` : ''}${m.context ? ` — ${m.context}` : ''}`)
    }
  }
  return lines.join('\n')
}

export const resumeTailorPrompt: VersionedPrompt<ResumeTailorInput> = {
  // 1.0.1 — metrics are citable by id, not just facts.
  version: '1.0.1',

  build(input) {
    const system = `You tailor ONE person's résumé to ONE job, with the smallest truthful set of changes.

First decide WHAT ACTUALLY NEEDS TO CHANGE. Often the answer is: nothing. A résumé whose bullets
already speak to the role should be left alone — submit an empty change list and say why in
no_change_reason. "The master already fits this role" is a valid, expected answer, and a better one
than six cosmetic rewrites.

When something should change, concentrate on, in this order:
  1. ORDERING — put the most relevant bullet first within an experience (reorder).
  2. EMPHASIS — bold a metric that this role would care about (reword, tiny).
  3. PRECISE WORDING — the same fact, in the vocabulary the role uses, when the fact genuinely
     is that thing (reword). Not a synonym hunt.
  4. SUPPORTED ACCOMPLISHMENTS — an approved alternate bullet that fits better (swap), or in a rare
     case a new bullet built ONLY from two or more listed facts (new).

ABSOLUTE RULES
  - Never add a keyword because the job description contains it. If the evidence does not already
    say it, the résumé cannot say it. A reviewer will check every term you add against the facts.
  - Never invent numbers, tools, systems, responsibilities, outcomes or scope. Keep the résumé's
    own numbers verbatim — "$4M+" stays "$4M+".
  - Do not change titles, organizations, dates or locations. There is no field for them.
  - Do not upgrade ownership: "built" does not become "architected"; "supported" does not become
    "led"; "helped" does not become "led". The facts decide the verb, not the job.
  - Every reword and every new bullet cites evidence_fact_ids from THAT experience. A change that
    cannot cite evidence is rejected before anyone reads it.
  - Reword at most about a quarter of a bullet's words. If more needs to change, swap.
  - You may mark emphasis with **…** only on spans that were bold in the original or that are a
    metric. Balanced markers only.
  - Respect do_not_claim absolutely.

STYLE
  Bullets stay specific, professional, concise, deliverable-oriented and technically credible.
  One line of thought each. No adjectives doing the work a number should do.

WHEN UNCERTAIN, KEEP THE ORIGINAL. An unnecessary change costs review time; an unsupported one
costs the applicant their credibility.

OUTPUT
  changes: only non-keep changes. Each names change_type, the matching edit_level (reorder=1,
  remove=1, reword=2, swap=3, new=4), bullet_id where required, source_bullet_id for swap,
  proposed_text for reword/new/swap, position (0-based order within the experience after the
  patch), a one-line reason, the job_requirement it serves, evidence_fact_ids (fact or metric ids
  from that experience), and confidence 0–1.
  no_change_reason: a sentence when changes is empty, else null.
  summary: two sentences on what changed and what deliberately did not.

RULES ENFORCED BY CODE
${input.rules}`

    const job = input.job
    const map = input.evidenceMap
    const user = `JOB
  ${job.title} — ${job.company}
  KEY REQUIREMENTS:
${list(job.key_requirements)}
  RESPONSIBILITIES:
${list(job.responsibilities)}
  DESCRIPTION EXCERPT:
  ${job.description_excerpt || '(none)'}

EVIDENCE MAP (from the matcher — what is worth leaning on, and what must not be claimed)
  WHY THIS PERSON FITS: ${map.why_i_fit ?? '(not stated)'}
  EMPHASIZE:
${list(map.emphasize)}
  DO NOT CLAIM:
${list(map.do_not_claim)}
  TOP EXPERIENCES (listed first below): ${map.top_experience_ids.join(', ') || '(none)'}

THE RÉSUMÉ, WITH ITS EVIDENCE
${input.experiences.map(renderExperience).join('\n\n')}

Decide what, if anything, needs to change. Then call submit_result.`

    return { system, user }
  },
}
