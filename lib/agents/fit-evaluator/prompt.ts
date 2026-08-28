// Fit Evaluator prompt. Bump `version` on ANY semantic change (ADR-009).
//
// The model NEVER sees weights or a total. It emits a 0–1 judgment per
// dimension; lib/career/fit/evaluate.ts does the arithmetic (ADR-004). It also
// never sees the feedback ADJUSTMENT — only the human's reasons as hints, so it
// can explain a mismatch the user has already flagged rather than rediscover it.

import type { VersionedPrompt } from '../runtime/types'
import { FIT_DIMENSIONS } from '@/lib/career/types'
import { FIT_DIMENSION_QUESTIONS } from '@/lib/career/fit/dimensions'

/**
 * The job as the fit evaluator and the evidence matcher see it. A projection
 * of JobOpportunity — the orchestrator trims `description_excerpt` to ≤ 3000
 * chars so a 12,000-character posting cannot crowd out the evidence.
 */
export interface FitJobInput {
  title: string
  company: string
  location_raw: string | null
  location_tier: number | null
  work_mode: string
  employment_type: string
  season_relevance: string
  posted_at: string | null
  deadline: string | null
  description_excerpt: string
  min_qualifications: string[]
  preferred_qualifications: string[]
  graduation_eligibility: string | null
  work_authorization: string | null
  skills: string[]
  responsibilities: string[]
  industry: string | null
  company_size_stage: string | null
}

export interface FitEvaluatorInput {
  /** renderMission() output. */
  mission: string
  job: FitJobInput
  /** renderCompanyResearchForPrompt() output, or '(no research yet)'. */
  companyResearch: string
  /** renderExperienceSummaries() output — summaries, never the whole bank. */
  evidenceSummaries: string
  /** renderPreferences() output. */
  preferences: string
  /** renderFeedbackHints() output. Read, never applied — code applies the adjustment. */
  feedbackContext: string[]
}

const list = (items: string[], empty = 'none stated'): string =>
  items.length ? items.map((s) => `  - ${s}`).join('\n') : `  ${empty}`

export function renderJobForPrompt(job: FitJobInput): string {
  return `Title: ${job.title}
Company: ${job.company}
Location: ${job.location_raw ?? 'unknown'}${job.location_tier ? ` (mission geography tier ${job.location_tier})` : ' (not in any mission geography tier)'}
Work mode: ${job.work_mode} · Employment type: ${job.employment_type} · Season: ${job.season_relevance}
Posted: ${job.posted_at ?? 'unknown'} · Deadline: ${job.deadline ?? 'none stated'}
Industry: ${job.industry ?? 'unknown'} · Company size/stage: ${job.company_size_stage ?? 'unknown'}
Graduation eligibility: ${job.graduation_eligibility ?? 'not stated'}
Work authorization: ${job.work_authorization ?? 'not stated'}

MINIMUM QUALIFICATIONS
${list(job.min_qualifications)}

PREFERRED QUALIFICATIONS
${list(job.preferred_qualifications)}

SKILLS NAMED
${list(job.skills)}

RESPONSIBILITIES
${list(job.responsibilities)}

DESCRIPTION (excerpt)
${job.description_excerpt || '(none)'}`
}

export const fitEvaluatorPrompt: VersionedPrompt<FitEvaluatorInput> = {
  version: '1.0.0',

  build(input) {
    const dimensions = FIT_DIMENSIONS.map((d) => `  ${d}\n     ${FIT_DIMENSION_QUESTIONS[d]}`).join('\n\n')

    const system = `You judge how well ONE job fits ONE person, one dimension at a time.

For each dimension you give a number from 0.0 to 1.0, a one-sentence explanation grounded in the
inputs, and at most two short quotes from the job or the evidence that support it. You do NOT
produce an overall score, a rank, or a recommendation — those are computed elsewhere, and you
cannot see how. Judge each dimension on its own merits.

WHO THE PERSON IS
An undergraduate graduating in May 2028, looking for an internship. The evidence lines describe
what they have actually done. Judge on the evidence, not on the fact that they are a student.

DIMENSIONS — every one must be answered, exactly once

${dimensions}

CALIBRATION — the scale must actually spread

  0.9–1.0  Exceptional. Rare. You would be surprised to see many of these.
  0.7–0.9  Strong and specific.
  0.4–0.7  Plausible but generic — true of many jobs at many companies.
  0.1–0.4  Weak; the evidence points the other way.
  0.0–0.1  Actively wrong for this dimension.

If most of your numbers land between 0.8 and 0.95, you are not judging, you are approving.
A dimension where the inputs say nothing specific should score in the middle at best, and
your explanation should say the evidence was thin. Do not invent evidence to justify a number.

RULES THAT OVERRIDE ENTHUSIASM

  1. PRESTIGE IS NOT QUALITY. company_quality is about trajectory, technical seriousness and
     what people who know the field think — where the research shows it. A famous name with no
     evidence of either scores in the middle. A small company with a real technical problem and
     strong people can score high.

  2. DIFFERENTIATION MEANS UNUSUAL, NOT QUALIFIED. "Strong engineering student" is not
     differentiation. A specific overlap between what this person has done and what THIS role
     needs is. If there is none, differentiation is low — say so.

  3. ROLE FIT IS ABOUT THE WORK, NOT THE TITLE. Read the responsibilities and the description.

ELIGIBILITY — a verdict, not a score

  QUALIFIED      Meets every stated minimum qualification, given the evidence.
  STRETCH        Meets the minimums but misses preferred qualifications, OR there is a discipline
                 gap the evidence only partly bridges. STRETCH is a good answer, not a
                 consolation prize. Missing PREFERRED qualifications NEVER makes a role
                 NOT_QUALIFIED.
  NOT_QUALIFIED  A hard requirement this person cannot meet: a graduation window that excludes
                 May 2028 given what the posting allows (e.g. "graduating December 2026 or
                 earlier"), a security clearance they do not hold, a degree level they are not
                 pursuing, a licence they do not have.
  UNKNOWN        The posting's requirements are too vague to judge.

  WORK AUTHORIZATION: you do NOT know this person's status. If the posting requires something
  specific (citizenship, no sponsorship, export-control eligibility), record it as an
  uncertainty and, where material, a red flag — never as NOT_QUALIFIED.

  A NOT_QUALIFIED verdict must name the exact requirement and quote the posting in
  eligibility_reasoning. If you cannot quote it, it is not a hard requirement.

FEEDBACK HINTS
You may be shown the person's earlier reactions to similar jobs. Use them to understand what
they mean by their preferences. Do not adjust your numbers to please them — the adjustment
happens elsewhere, in code, and doing it twice double-counts.

OUTPUT, BEYOND THE DIMENSIONS
  explanation             3–4 sentences a person can act on: what the role actually is, why it
                          would matter to this person, why the fit is what it is.
  uncertainties           What you could not establish from the inputs.
  red_flags               Anything that should give the person pause before applying.
  missing_qualifications  Stated qualifications (minimum or preferred) the evidence does not show.
  confidence              0–1: how much evidence your judgments rest on.`

    const hints = input.feedbackContext.length
      ? `\nFEEDBACK HINTS (read, do not apply)\n${input.feedbackContext.map((h) => `  - ${h}`).join('\n')}\n`
      : ''

    const user = `MISSION
${input.mission}

PERSONAL PREFERENCES
${input.preferences}

JOB
${renderJobForPrompt(input.job)}

COMPANY RESEARCH
${input.companyResearch}

EVIDENCE — what this person has actually done (summaries)
${input.evidenceSummaries}
${hints}
TASK
Score every dimension listed above, then give the eligibility verdict and the explanation.

Submit with the ${'`submit_result`'} tool.`

    return { system, user }
  },
}
