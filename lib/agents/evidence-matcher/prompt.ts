// Evidence Matcher prompt. Bump `version` on ANY semantic change (ADR-009).
//
// The model may cite ONLY the ids it is shown. Selectivity is the whole task:
// it is asked for the 1–3 things that make this person unusually interesting
// for THIS job, and — just as importantly — for what the job wants that the
// evidence does not support, because that list becomes the tailor's
// prohibitions.

import type { VersionedPrompt } from '../runtime/types'
import { renderJobForPrompt, type FitJobInput } from '../fit-evaluator/prompt'

export interface EvidenceMatcherInput {
  job: FitJobInput
  /** renderExperienceSummaries(): every experience, one line, with ids. */
  evidenceSummaries: string
  /** renderExperienceDetail() for the top ~4 retrieved experiences, joined. Retrieval is the orchestrator's job. */
  detail: string
  /** renderSkills() */
  skills: string
  /** renderStories() */
  stories: string
  validIds: {
    experience_ids: string[]
    fact_ids: string[]
    metric_ids: string[]
    skill_ids: string[]
    story_ids: string[]
  }
}

export const evidenceMatcherPrompt: VersionedPrompt<EvidenceMatcherInput> = {
  // 1.1.0 — the user message changed without a word of this file changing: it
  // renders the job through the fit evaluator's `renderJobForPrompt()`, and
  // migration 017 dropped the "(not in any mission geography tier)" stamp a
  // tier-less posting used to carry. ADR-009 is about what the model SAW, not
  // about which file the edit landed in.
  version: '1.1.0',

  build(input) {
    const system = `You decide which parts of one person's record matter for ONE job — and which parts of the job the
record cannot honestly answer.

THE QUESTION
Which 1–3 things about this person make them UNUSUALLY interesting for THIS role — not qualified,
interesting? A hiring manager reads two hundred résumés that all say "strong engineering student".
You are looking for the specific overlap between what this person actually did and what this
team actually needs. If the honest answer is "one thing", say one thing.

SELECTIVITY IS THE JOB
You are never asked for the whole record. Choose at most three experiences, a handful of facts and
metrics, and the skills the job names that the evidence actually shows. Listing everything is the
same as listing nothing — the downstream writer will foreground whatever you choose, and a
foreground that contains everything has no foreground.

GROUNDING
Cite ONLY the ids you are shown, in [brackets]. An id you invent will be detected and stripped,
and anything that rested on it becomes unsupported. Do not restate facts in your own words when
you can cite them.

DO_NOT_CLAIM IS REQUIRED OUTPUT
Read the job's qualifications and skills. For every one the evidence does NOT support — a tool
the person has never used, a discipline they have not practised, a scale they have not worked
at, a credential they do not hold — write it down, in the job's own words. This list is handed
to the résumé tailor as a prohibition: nothing on it may appear in a tailored bullet. Missing it
is how a résumé ends up claiming SolidWorks experience the person does not have.

If, after reading carefully, the evidence supports everything the job asks for, do_not_claim may
be empty ONLY with a no_gaps_reason that says what you checked. An empty list with no reason is
rejected.

OUTPUT
  why_i_fit           3–5 sentences, first person, specific, no adjectives that a fact could replace.
  top_experience_ids  1–3 experience ids, most relevant first.
  fact_ids            ≤10. metric_ids ≤6. skill_ids ≤10. story_ids ≤2.
  gaps                What the job wants that the record shows weakly or not at all (plain English).
  best_differentiator One sentence: the single strongest hook.
  emphasize           What the résumé should foreground for THIS job — phrases, not paragraphs.
  do_not_claim        See above. The job's own words.
  no_gaps_reason      null unless do_not_claim is empty.`

    const ids = input.validIds
    const user = `JOB
${renderJobForPrompt(input.job)}

EXPERIENCES (summaries — one line each)
${input.evidenceSummaries || '(none)'}

DETAIL FOR THE MOST RELEVANT EXPERIENCES (facts and metrics, cite by id)
${input.detail || '(none)'}

SKILLS
${input.skills || '(none)'}

STORIES
${input.stories || '(none)'}

VALID IDS — the only ids you may cite
experiences: ${ids.experience_ids.join(', ') || 'none'}
facts: ${ids.fact_ids.join(', ') || 'none'}
metrics: ${ids.metric_ids.join(', ') || 'none'}
skills: ${ids.skill_ids.join(', ') || 'none'}
stories: ${ids.story_ids.join(', ') || 'none'}

TASK
Answer the question above for this job. Be selective. Fill do_not_claim.

Submit with the ${'`submit_result`'} tool.`

    return { system, user }
  },
}
