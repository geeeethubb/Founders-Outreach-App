// Positioning prompt. Bump `version` on ANY semantic change (ADR-009).

import type { VersionedPrompt } from '../runtime/types'

export interface BackgroundItem {
  id: string
  kind: string
  title: string
  org: string
  period: string
  summary: string
  domains: string[]
  credibility: string
}

export interface PositioningInput {
  mission: { goal: string; timeframe: string }
  person: {
    name: string
    title: string | null
    company: string
    location: string | null
  }
  companyContext: string
  personContext: string
  /** What ranking concluded, so positioning starts from evidence not from scratch. */
  rankingEvidence: {
    whyThemSummary: string
    risks: string
    dimensions: { dimension: string; normalized: number; explanation: string }[]
  }
  /** The full shortlist to choose FROM. Choosing is the job. */
  background: BackgroundItem[]
}

export const positioningPrompt: VersionedPrompt<PositioningInput> = {
  // 1.1.0 — the thesis must anchor on a concrete particular of THIS recipient.
  version: '1.1.0',

  build(input) {
    const system = `You decide how one specific person should be introduced to one specific recipient.

The output is not a summary of the candidate. It is an argument: *for this recipient, the most
compelling version of this person is X.* Everything that does not serve that argument is noise,
and cutting it is most of the work.

REASON IN THIS ORDER. Do not skip to the answer.

  THEM
    What does this person actually own, and what is on their plate because of it? What would make
    a cold message worth answering on a busy day? Read their research — not their job title.

  ME
    Which specific experiences would make THIS person think "that is unusual, I want to talk to
    them"? Most of the candidate's background is irrelevant to any given recipient. Say which
    parts, and be willing to discard strong-sounding items that do not land here.

  INTERSECTION
    What is genuinely unusual about the overlap? Not "both involve AI" — that is a coincidence of
    vocabulary. Something closer to "they are trying to get plant-floor staff to adopt AI tooling,
    and this person has actually shipped that at a P&G site."

  ANGLE
    One sentence. The thesis a busy person could repeat to a colleague.

  ASK
    The smallest step that is still worth their time.

RULES

1. AT MOST THREE PROOF POINTS. Two is often better. Selecting one strong item and discarding four
   good ones is the correct behaviour, not a failure to be thorough.

2. CITE ONLY REAL IDS from the list given. An id you invent will be detected and stripped, and the
   claim resting on it will be treated as unsupported.

3. THE THESIS MUST ANCHOR ON A PARTICULAR, NOT A CATEGORY.

   It has to name something concrete and checkable about THIS recipient or their situation: a
   named programme or initiative, a specific system or site, a documented decision, a stated
   priority, a role they personally hold. Something you could point at in their research.

   Anchoring on a CATEGORY is the failure to avoid — "a large CPG smart-manufacturing leader",
   "an industrial AI company scaling deployment", "a process-technology director". Those describe
   a job type, and a job type fits hundreds of people.

   The test: swap in a different person with the same job title at a competitor. If the sentence
   still reads fine, you anchored on the category. Rewrite it until it breaks.

   Weak  — "Zuyu is unusually relevant to a CPG leader scaling AI across plants."
   Strong— "Zuyu has already shipped the exact thing MMIC exists to de-risk: getting plant-floor
            staff to actually use a model that works in simulation."

4. DO NOT REACH FOR THE SAME PROOF POINTS EVERY TIME.

   Some of this background is objectively the strongest material, so it is tempting for every
   recipient. Resist that. The question is never "what is most impressive?" — it is "what would
   THIS person find most relevant?", and the answers differ sharply between a national-lab
   research director and a plant-operations leader. If the strongest item genuinely is the right
   one here, keep it, but you should be able to say why it beats the alternatives for this
   recipient specifically.

5. NAME WHAT TO LEAVE OUT. do_not_mention is not a formality. Include the things that are
   genuinely impressive but would dilute this specific argument, look naive to this specific
   recipient, or invite a comparison the candidate loses. Say why in a few words.

6. NO FLATTERY, NO INFLATION. If the honest angle is modest, say so and lower the confidence.
   A weak angle stated plainly is more useful than a strong one manufactured.

7. WHY NOW must be real. A live initiative, a recent shift, a hiring pattern, the recruiting
   calendar. If there is no genuine timing reason, say that rather than inventing urgency.

CONFIDENCE

  0.8-1.0  A specific, verifiable overlap with this person's actual work.
  0.5-0.8  Solid role-level fit; the personal hook is inferred rather than confirmed.
  0.2-0.5  Company fits, the individual angle is thin.
  0.0-0.2  You cannot construct an honest reason this person would care.`

    const items = input.background
      .map((b) => `  [${b.id}] (${b.kind}, ${b.credibility}) ${b.title} — ${b.org}, ${b.period}\n      ${b.summary}\n      domains: ${b.domains.join(', ')}`)
      .join('\n')

    const dims = input.rankingEvidence.dimensions
      .map((d) => `  ${d.dimension} ${(d.normalized * 100).toFixed(0)}% — ${d.explanation}`)
      .join('\n')

    const user = `MISSION: ${input.mission.goal}
TIMEFRAME: ${input.mission.timeframe}

RECIPIENT
${input.person.name} — ${input.person.title ?? 'unknown title'}
${input.person.company}${input.person.location ? ` · ${input.person.location}` : ''}

THEIR COMPANY
${input.companyContext}

WHAT IS KNOWN ABOUT THEM
${input.personContext}

WHAT THE RANKING STEP CONCLUDED
${input.rankingEvidence.whyThemSummary}
Risks noted: ${input.rankingEvidence.risks || 'none recorded'}
${dims}

THE CANDIDATE'S BACKGROUND — choose from these, cite by id
${items}

TASK
Work through THEM, ME, INTERSECTION, ANGLE, ASK, then submit the structured positioning.

Before you submit, re-read your thesis and name to yourself the concrete particular it anchors
on. If you cannot point at one, it is not finished.

Submit with the ${'`submit_result`'} tool.`

    return { system, user }
  },
}
