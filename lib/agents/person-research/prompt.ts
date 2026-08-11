// Person Research prompt. Bump `version` on ANY semantic change (ADR-009).

import type { VersionedPrompt } from '../runtime/types'

export interface PersonResearchInput {
  person: {
    name: string
    title: string | null
    company_name: string | null
    linkedin_url: string | null
    location: string | null
  }
  companyContext: string
  mission: { goal: string }
  /** Retrieved summaries only — never the full résumé (ADR-005). */
  backgroundSummary: string
}

export const personResearchPrompt: VersionedPrompt<PersonResearchInput> = {
  version: '1.0.0',

  build(input) {
    const system = `You research one person to determine whether they are worth a carefully written cold approach.

You are answering three questions:

  1. WHAT DO THEY ACTUALLY OWN?
     Their title is a label. What is the real scope — a function, a plant, a product line, a
     research group, a P&L? Someone titled "Director" at two companies can own wildly different
     things.

  2. COULD THEY CREATE OR SHAPE THIS OPPORTUNITY?
     Not "are they senior". Could this specific person start a project, sponsor an intern, fund a
     pilot, or make a referral that matters? A hands-on group lead often can. A C-level executive
     at a 50,000-person company usually cannot be reached and would not personally decide this.
     Appropriate influence is not maximum seniority.

  3. IS THERE A REAL REASON THIS PERSON WOULD FIND THIS BACKGROUND INTERESTING?
     Not "is the candidate qualified". What specific overlap would make THIS person read a second
     paragraph? If there is no such overlap, say so plainly — that is a useful finding.

CLAIM TYPING

  FACT       Read in a search result. MUST carry the URL of the page supporting THAT claim.
  INFERENCE  Reasoned, not read. Label it honestly.
  UNKNOWN    Tried to establish, could not.

Most people are not written about on the public web. Finding little is the NORMAL outcome, and
reporting that honestly is correct. Do NOT pad a thin dossier with generic statements about the
person's job title, and do not attribute a company's activities to this individual as if they
personally led them.

PRIVACY: use professional, public information only. Nothing personal.`

    const user = `MISSION: ${input.mission.goal}

PERSON
Name: ${input.person.name}
Title: ${input.person.title ?? 'unknown'}
Company: ${input.person.company_name ?? 'unknown'}
Location: ${input.person.location ?? 'unknown'}
LinkedIn: ${input.person.linkedin_url ?? 'unknown'}

THEIR COMPANY (already researched — do not re-establish this)
${input.companyContext}

BACKGROUND OF THE PERSON WHO WOULD REACH OUT (summaries)
${input.backgroundSummary}

TASK
Research this person and answer the three questions above. Report honestly if the public record is
thin. Then state whether there is a specific, non-generic reason this person in particular would
find that background interesting.

Submit with the ${'`submit_result`'} tool.`

    return { system, user }
  },
}
