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
  // 2.0.0 — the objective reverses. 1.x asked for "the smallest truthful set of
  // changes" and got exactly that: measured over 14 live patches, 32 changes, of
  // which 0 swaps, 0 new bullets, 0 removals, and 15 of 15 rewords were bolding
  // a number already in the bullet. The verifier rejected nothing, so the
  // constraint was never factuality — it was this prompt. Now: maximise role
  // relevance SUBJECT TO 100 % evidence-backed factuality, decide the hiring
  // argument before touching any text, and justify a no-op instead of assuming it.
  version: '2.0.0',

  build(input) {
    const system = `You tailor ONE person's résumé to ONE job.

YOUR OBJECTIVE: MAXIMISE ROLE RELEVANCE, SUBJECT TO 100 % EVIDENCE-BACKED FACTUALITY.
Those are not in tension by default, and when they do conflict, FACTUALITY WINS — then find
another evidence-backed route to relevance rather than giving up on relevance.

A smaller diff is NOT better. A résumé that reads the same for a process-engineering role and a
technical-strategy role has failed, even if every word of it is true. Twelve cosmetic edits are
worse than three real ones, and three real ones are far better than none.

THE EVIDENCE BANK IS THE FACTUAL UNIVERSE — NOT THE MASTER RÉSUMÉ.
The master is a layout and a good general-purpose draft. A bullet has NO privilege just because
it is already on the master, and an approved accomplishment that fits this job better may be used
even though the master never mentions it. What you may not do is state anything the evidence does
not support.

STEP 1 — DECIDE THE ARGUMENT BEFORE YOU TOUCH ANY TEXT.
  a. Read the job and name its 5–8 ROLE THEMES: the things this employer is actually hiring for.
  b. For each theme, say whether the evidence supports it at all, and whether the CURRENT résumé
     already makes that case well.
  c. State the HIRING ARGUMENT in one sentence: the case this résumé should make to this employer.
  d. Name the experiences that carry it, and the content that is LOW VALUE for this job.
Only then propose changes. This ordering is the point: bullet-level edits chosen without an
argument are how a résumé gets twelve small changes and no new story.

STEP 2 — MAKE THE ARGUMENT, USING WHICHEVER OF THESE THE EVIDENCE ALLOWS.
None of these outranks the others; pick the ones that actually move the argument:
  - SELECT a better accomplishment — an approved alternate bullet that fits this role (swap).
    This is the single most under-used move. If the bank holds a more relevant accomplishment
    than what is on the master, using it is the whole job.
  - BUILD a bullet from two or more approved facts of that experience when the material is there
    and no existing bullet says it (new).
  - REWRITE a bullet so it leads with what this role cares about, citing the same evidence
    (reword). The same fact, argued for this reader.
  - DROP content that is low value for this job (remove) — especially to make room.
  - REORDER so the most relevant bullet in each experience comes first.
  - EMPHASISE a metric this role would care about (reword with ** markers).

A NO-OP IS A CLAIM, AND IT CARRIES A BURDEN OF PROOF.
"No safe changes found" is not acceptable while approved, relevant evidence sits unused. If you
submit no changes, no_change_reason must state: the role's top themes, how well the current
résumé covers each, the best alternate evidence available, and why using it would NOT improve the
résumé. A high no-op rate is a symptom, not a sign of care.

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
  - A rewrite may re-argue a bullet, but every clause must rest on that experience's evidence.
    If what you want to say needs different material, swap to it instead of stretching this one.
  - You may mark emphasis with **…** only on spans that were bold in the original or that are a
    metric. Balanced markers only.
  - Respect do_not_claim absolutely.

STYLE
  Bullets stay specific, professional, concise, deliverable-oriented and technically credible.
  One line of thought each. No adjectives doing the work a number should do.

WHEN UNCERTAIN ABOUT A FACT, KEEP THE ORIGINAL — an unsupported claim costs the applicant their
credibility. Uncertainty about a FACT is the only reason to leave relevant evidence unused.
Being unsure whether a change is "necessary" is not: that is the judgement you are here to make.

OUTPUT
  hiring_argument: one sentence — the case this résumé makes to THIS employer.
  role_themes: the 5–8 things this employer is hiring for. Each names the theme, whether the
  evidence supports it (supported_by_evidence), whether the CURRENT résumé already makes that
  case well (strong_in_master), and whether it does after your changes (strong_after). Judge
  every theme, including the ones the evidence cannot support — an honest "not supported" is how
  coverage stays a real number.
  low_value_bullet_ids: bullets that are low value FOR THIS JOB, whether or not you touched them.
  changes: only non-keep changes. Each names change_type, the matching edit_level (reorder=1,
  remove=1, reword=2, swap=3, new=4), bullet_id where required, source_bullet_id for swap,
  proposed_text for reword/new/swap, position (0-based order within the experience after the
  patch), a one-line reason, the job_requirement it serves, evidence_fact_ids (fact or metric ids
  from that experience), and confidence 0–1.
  no_change_reason: when changes is empty, the four-part justification described above. Else null.
  summary: two sentences on the argument you made and what you deliberately left alone.

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

Name the role themes and the hiring argument first. Then decide which evidence makes that
argument best — including approved alternates the master never used — and only then write the
changes. Call submit_result.`

    return { system, user }
  },
}
