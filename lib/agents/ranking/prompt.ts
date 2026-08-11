// Ranking prompt. Bump `version` on ANY semantic change (ADR-009).
//
// The model NEVER sees point values, weights, or a total. It emits a 0–1
// judgment per dimension; all arithmetic happens in TypeScript. That is what
// stops it reverse-engineering a target score and back-filling components to
// reach it (ADR-004).

import type { VersionedPrompt } from '../runtime/types'
import { DIMENSION_QUESTION, SCOUT_DIMENSIONS } from '@/lib/scouting/score'

export interface RankingInput {
  candidate: {
    key: string
    name: string
    title: string | null
    company_name: string | null
    location: string | null
    email_status: string
  }
  companyContext: string
  personContext: string
  mission: { goal: string; timeframe: string }
  positioningAngle: string
  /** id → summary. The model may cite ONLY these ids (ADR-005). */
  backgroundItems: { id: string; summary: string }[]
}

export const rankingPrompt: VersionedPrompt<RankingInput> = {
  version: '1.0.0',

  build(input) {
    const dimensions = SCOUT_DIMENSIONS.map(
      (d) => `  ${d}\n     ${DIMENSION_QUESTION[d]}`
    ).join('\n\n')

    const system = `You judge how promising one prospect is, one dimension at a time.

For each dimension you give a number from 0.0 to 1.0 and a one-sentence explanation grounded in
the evidence you were given. You do NOT produce an overall score, a rank, or a recommendation —
those are computed elsewhere, and you cannot see how. Judge each dimension on its own merits.

DIMENSIONS

${dimensions}

CALIBRATION — the scale must actually spread

  0.9–1.0  Exceptional. Rare. You would be surprised to see many of these.
  0.7–0.9  Strong and specific.
  0.4–0.7  Plausible but generic — true of many people at many companies.
  0.1–0.4  Weak; the evidence points the other way.
  0.0–0.1  Actively wrong for this dimension.

If most of your numbers land between 0.8 and 0.95, you are not judging, you are approving.
A prospect where the research found nothing specific should score in the middle at best.

TWO RULES THAT OVERRIDE ENTHUSIASM

  1. DECISION INFLUENCE IS NOT SENIORITY.
     Score on whether THIS person could plausibly create, sponsor, or refer this opportunity. A
     hands-on director who owns the relevant function scores higher than an SVP three levels
     removed from the work, and much higher than a C-level executive at a huge company who would
     never see the message.

  2. DIFFERENTIATION MEANS UNUSUAL, NOT QUALIFIED.
     The question is whether THIS person would find THIS background unusually interesting —
     not whether the person is a strong candidate in general. "Strong technical student" is not
     differentiation. A specific overlap with what this person actually works on is.
     If the research found no specific hook, differentiation is low. Say so.

GROUNDING
When you claim something about the background, cite the background item ids that support it. You
may cite ONLY the ids listed. An id you invent will be detected and stripped, and the claim it
supported will be treated as unsupported.

If the research was thin, judge on what you have and say the evidence was thin in your
explanations. Do not invent evidence to justify a number.`

    const items = input.backgroundItems.map((b) => `  [${b.id}] ${b.summary}`).join('\n')

    const user = `MISSION: ${input.mission.goal}
TIMEFRAME: ${input.mission.timeframe}
POSITIONING ANGLE FOR THIS RUN: ${input.positioningAngle}

PROSPECT
Name: ${input.candidate.name}
Title: ${input.candidate.title ?? 'unknown'}
Company: ${input.candidate.company_name ?? 'unknown'}
Location: ${input.candidate.location ?? 'unknown'}
Email availability: ${input.candidate.email_status}

COMPANY RESEARCH
${input.companyContext}

PERSON RESEARCH
${input.personContext}

BACKGROUND ITEMS (cite by id — these are the only valid ids)
${items}

TASK
Score every dimension listed above. Then answer:
  - why_they_fit: why this prospect is worth contacting, in one or two sentences
  - why_i_fit_them: which 1-3 background items make this person unusually interesting to contact,
    and why THEY would care
  - resume_item_ids: the ids backing why_i_fit_them
  - risks: the strongest reason this prospect might be a waste of effort

Submit with the ${'`submit_result`'} tool.`

    return { system, user }
  },
}
