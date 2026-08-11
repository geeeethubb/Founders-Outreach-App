// Person Triage prompt. Bump `version` on ANY semantic change (ADR-009).

import type { VersionedPrompt } from '../runtime/types'

export interface TriageCandidate {
  key: string
  name: string
  title: string | null
  seniority: string | null
  department: string | null
  location: string | null
  email_status: string
}

export interface PersonTriageInput {
  company: {
    name: string
    what_they_do: string
    archetype: string
    size_stage: string | null
    relevance: string
  }
  mission: { goal: string; geography: string }
  backgroundSummary: string
  /** Everyone Apollo returned at this company, judged together. */
  candidates: TriageCandidate[]
  /** How many are worth the expensive research step. */
  shortlistSize: number
}

export const personTriagePrompt: VersionedPrompt<PersonTriageInput> = {
  version: '1.0.0',

  build(input) {
    const system = `You decide which people at one company are worth researching in depth.

Deep research costs real money per person, so this step exists to spend it only where it can
change a decision. You are NOT producing the final ranking — you are deciding who advances.

You judge from Apollo metadata and the company's researched profile alone. You have no web
search and you do not need one: title, function, seniority, geography and the company's own
description are enough to tell a plausible entry point from an implausible one.

WHAT MAKES SOMEONE WORTH RESEARCHING

  - Their FUNCTION plausibly owns the work the mission describes at THIS company.
  - Their SENIORITY is both reachable and empowered for this company's size. At a small company
    that is a founder or functional head; at a very large one it is a director or senior manager
    who owns the function, not an executive three levels above it.
  - There is a plausible reason this person specifically would care about the background shown.

WHAT DOES NOT

  - A prestigious employer with an unrelated function inside it. Sales, commercial, IT systems,
    HR, recruiting, finance, legal, and product/flavour R&D are wrong for an industrial or
    technical mission no matter how good the company is.
  - Seniority for its own sake. An SVP at a 90,000-person company will not read a cold email
    from a student and would not personally decide this.
  - Keyword overlap. "AI" appearing in both a title and the background is not a reason.

CALIBRATION

Rate each person 0.0 to 1.0 on how likely they are to end up on a final shortlist:

  0.8-1.0  Strong entry point — right function, right level, clear reason to care.
  0.5-0.8  Plausible; worth researching if there is room.
  0.2-0.5  Weak; the function or level is off.
  0.0-0.2  Wrong person. Do not spend research on them.

Be decisive. If most of a company's people land between 0.5 and 0.7 you have not actually
discriminated, and the step has bought nothing.

Keep every explanation to one short sentence.`

    const list = input.candidates
      .map(
        (c, i) =>
          `${i + 1}. id=${c.key}\n   ${c.name} — ${c.title ?? 'unknown title'}` +
          `${c.seniority ? ` [${c.seniority}]` : ''}${c.department ? ` (${c.department})` : ''}` +
          `\n   location: ${c.location ?? 'unknown'} · email: ${c.email_status}`
      )
      .join('\n')

    const user = `MISSION: ${input.mission.goal}
GEOGRAPHY: ${input.mission.geography}

COMPANY: ${input.company.name}
What they do: ${input.company.what_they_do}
Kind of organization: ${input.company.archetype}${input.company.size_stage ? ` · ${input.company.size_stage}` : ''}
Why it fits the mission: ${input.company.relevance}

BACKGROUND OF THE PERSON WHO WOULD REACH OUT
${input.backgroundSummary}

PEOPLE FOUND AT THIS COMPANY
${list}

TASK
Score every person by id. Then name the ${input.shortlistSize} most worth researching in depth.

Submit with the ${'`submit_result`'} tool.`

    return { system, user }
  },
}
