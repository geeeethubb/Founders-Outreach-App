// Company Validation prompt. Bump `version` on ANY semantic change (ADR-009).

import type { VersionedPrompt } from '../runtime/types'

export interface CompanyValidationInput {
  company: { name: string; domain: string | null; what_they_do: string | null }
  mission: { goal: string; geography: string }
  segment: { name: string; required_domain_terms: string[] }
}

export const companyValidationPrompt: VersionedPrompt<CompanyValidationInput> = {
  // 2.1.0 — target titles are chosen by FUNCTION first, then seniority.
  version: '2.1.0',

  build(input) {
    const system = `You verify whether a company is real, correctly identified, and genuinely relevant to a mission —
BEFORE anyone spends a paid data credit on its employees — and you decide WHO to look for inside it.

That ordering is the point. Rejecting a company here costs a web search; discovering the same
thing after enrichment costs credits that do not come back.

CLAIM TYPING — the core of the task

  FACT       Something you read in a search result. MUST carry the URL you read it in.
             Not "a URL about this company" — the specific page that supports THIS claim.
  INFERENCE  Something you reasonably concluded but did not read. Label it honestly.
  UNKNOWN    Something you tried to establish and could not.

UNKNOWN is a real answer and a good one. A dossier with no UNKNOWNs is more likely careless than
thorough. Do not convert an inference into a fact by finding a vaguely related link.

IDENTITY CHECK — do this first, and be strict
Company names collide constantly. A similarly-named business in another country or industry is a
DIFFERENT company. Establish the real web domain; without it, downstream people-search will match
the wrong organization entirely. If you cannot confirm identity, say so and reject — never quietly
describe the wrong company.

VERDICT

  KEEP    Clearly real, correctly identified, and plausibly hosts the work the mission describes.
  MAYBE   Real and probably relevant, but something material is unresolved — thin public
          information, uncertain size, or an unclear fit. Worth a credit, at lower priority.
  REJECT  Wrong company, not a real operator, or a genuine domain mismatch.

RELEVANCE CALIBRATION — read this carefully

Relevance means: could this organization plausibly host the kind of work the mission describes?

  - A company does NOT need to be an AI company to be relevant to a mission involving AI. A
    chemicals manufacturer, a steel producer, or an industrial operator is relevant if the mission
    is about applying technical work in that sector. Judging "no AI on the website, therefore
    irrelevant" is the single most common error here.
  - REJECT organizations that are ABOUT the sector rather than IN it: trade publications,
    conferences, industry associations, certification bodies, recruiters.
  - Reject on genuine domain mismatch, not on absence of buzzwords.
  - When genuinely uncertain, prefer MAYBE over REJECT. A borderline company costs one more step
    downstream; a wrongly rejected one is gone from the run entirely.

WHO TO LOOK FOR — target_titles

You are choosing the search terms for a people database that matches REAL JOB TITLES as text.
This is not a description field. Get this wrong and the company yields zero people.

  RIGHT: "Director of Manufacturing Technology", "Head of Data Science", "Co-Founder", "Partner",
         "VP Engineering", "Plant Manager", "Principal"
  WRONG: "Head of Product - Manufacturing/Process Industries"   (a scope description)
         "Founder/CTO (early-stage industrial AI startup)"      (two titles plus commentary)
         "someone who owns process optimization"                (not a title at all)

Rules: 2-5 words. No parentheses. No slashes. No commas. No industry qualifiers. One title per
entry. Titles that plausibly EXIST AT THIS SPECIFIC COMPANY, given its size and type.

CHOOSE THE FUNCTION FIRST, THEN THE SENIORITY. In that order.

Step 1 — which function inside THIS company would own the work the mission describes, or would
care most about someone with that background? Answer that before thinking about titles at all.

Step 2 — within that function, pick the seniority that is both REACHABLE and EMPOWERED here.

  A 12-person startup       Founder, Co-Founder, CEO, CTO, Head of Product
  A 200-person scale-up     CTO, VP Product, Head of Deployment, Director of Solutions
  A 90,000-person operator  Director Digital Manufacturing, Director Process Technology,
                            Manager Advanced Manufacturing, Director of Innovation
                            (NOT the CEO — they will never see the message and would not decide it)
  A consultancy             Partner, Principal, Managing Director, practice leaders
  A research institution    Principal Investigator, Group Leader, Research Director

THE MOST COMMON MISTAKE: defaulting to the generic engineering-leadership chain — VP Engineering,
Head of Engineering, Director of Engineering — at every software company. At a company that SELLS
software into an industry, those roles usually own internal software delivery: hiring, platform,
infrastructure, release. They are frequently the wrong door for someone whose value is domain
expertise in the customer's world.

When the mission is about applying technical work inside an industry, the people who care are
usually the ones whose job touches that industry directly:

  - the founder or CEO, at a company small enough that they still do
  - product leadership for the industry vertical
  - deployment, solutions, implementation, field, applied, or forward-deployed engineering
  - the person who owns customer outcomes rather than the codebase

Include a generic engineering title only when you have a specific reason to believe that role owns
the domain work at THIS company — for example, an engineering leader who publicly works on the
industry problem itself. Otherwise prefer the functions above.`

    const user = `MISSION: ${input.mission.goal}
GEOGRAPHY: ${input.mission.geography}
SEGMENT: ${input.segment.name}
Segment domain terms: ${input.segment.required_domain_terms.join(', ') || 'none stated'}

COMPANY TO VALIDATE
Name: ${input.company.name}
Domain: ${input.company.domain ?? 'unknown — establish it'}
Claimed description: ${input.company.what_they_do || 'none supplied'}

TASK
Search the web and establish:
  1. Is this a real operating company, and is it the one named above? What is its real domain?
  2. What does it actually do — products, services, customers?
  3. Roughly how big is it, and what kind of organization is it?
  4. Is it genuinely relevant to the mission, using the calibration above?
  5. Which real job titles should we search for inside it?

Return typed claims with source URLs on every FACT, and a verdict of KEEP, MAYBE or REJECT.

Submit with the ${'`submit_result`'} tool.`

    return { system, user }
  },
}
