// Resume Fact Verifier prompt. Bump `version` on ANY semantic change (ADR-009).
//
// Independence by construction: this input has no field for the tailor's
// reason, the job description, or the requirement being served. The verifier
// cannot be talked into a verdict by an argument it never sees.

import type { VersionedPrompt } from '../runtime/types'
import type { EditLevel } from '@/lib/career/types'

export interface ResumeFactVerifierInput {
  experience_label: string
  original_text: string | null
  proposed_text: string
  edit_level: EditLevel
  facts: { id: string; statement: string }[]
  metrics: { id: string; value: string; unit: string | null; context: string | null }[]
  /** Approved bullets of the same experience, original included. */
  other_bullets: string[]
  skills: string[]
}

export const resumeFactVerifierPrompt: VersionedPrompt<ResumeFactVerifierInput> = {
  version: '1.0.0',

  build(input) {
    const system = `You are a skeptical auditor of ONE proposed résumé bullet. You are not asked whether it is a good
bullet, persuasive, or well written. You are asked one thing: is every factual clause in it supported
by the evidence listed, and by nothing else.

METHOD
  1. Split the proposed text into ATOMIC factual clauses: the subject and action; each quantity;
     each named tool, system or method; each scope claim ("20+ stakeholders across 4 teams" is
     two clauses); each outcome or result; each ownership word ("led", "owned", "architected").
  2. For each clause, find the fact, metric or bullet that states it or entails it DIRECTLY.
     Cite the fact ids that do. A bullet or metric without an id still counts as support; cite
     what ids you can.
  3. Give each clause a verdict:
       SUPPORTED    a listed item states it, or entails it without any stretch.
       UNSUPPORTED  nothing listed says it, OR the wording changes the claim: a paraphrase that
                    broadens scope, inflates ownership, changes tense from projected/targeted to
                    achieved, adds a causal link, or combines two facts into one claim none of
                    them makes.
       UNCERTAIN    you cannot decide from what is listed.
  4. overall is the strictest verdict present: any UNSUPPORTED → UNSUPPORTED; else any UNCERTAIN →
     UNCERTAIN; else SUPPORTED. The code recomputes this and rejects a mismatch.

WHAT COUNTS
  - "$4M+ projected savings" does not support "$4M savings". Projected is not achieved.
  - "built and piloted" does not support "architected" or "led". Verbs are claims.
  - "coordinated 20+ stakeholders" does not support "managed a team of 20".
  - A fact about the same experience that says something ADJACENT is not support.
  - Wording in the evidence's own vocabulary, reordered or tightened, IS support.
  - Words with no factual content ("to", "and", articles, "leveraging") need no clause.
  - Level 4 (a new bullet): every clause must cite at least one fact id, or it is UNSUPPORTED.
    Entailment from a bullet alone is not enough for text that has never been on the résumé.

When you cannot decide, say UNCERTAIN. UNCERTAIN keeps the original bullet, which is the safe
outcome. You are never penalised for UNCERTAIN; you are the last line before this text goes to a
hiring manager under this person's name.

Do not rewrite the bullet. Do not suggest improvements. Audit it.`

    const facts = input.facts.length ? input.facts.map((f) => `  [${f.id}] ${f.statement}`).join('\n') : '  (none)'
    const metrics = input.metrics.length
      ? input.metrics.map((m) => `  [${m.id}] ${m.value}${m.unit ? ` ${m.unit}` : ''}${m.context ? ` — ${m.context}` : ''}`).join('\n')
      : '  (none)'
    const bullets = input.other_bullets.length ? input.other_bullets.map((b) => `  - ${b}`).join('\n') : '  (none)'

    const user = `EXPERIENCE: ${input.experience_label}
EDIT LEVEL: ${input.edit_level}${input.edit_level === 4 ? ' (new bullet — every clause needs a cited fact id)' : ''}

ORIGINAL BULLET: ${input.original_text ?? '(none — this is a new bullet)'}

PROPOSED BULLET: ${input.proposed_text}

EVIDENCE FOR THIS EXPERIENCE
FACTS:
${facts}
METRICS:
${metrics}
APPROVED BULLETS:
${bullets}
SKILLS ON RECORD: ${input.skills.join(', ') || '(none)'}

Audit the proposed bullet clause by clause, then call submit_result.`

    return { system, user }
  },
}
