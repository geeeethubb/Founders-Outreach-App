// Contact Classifier prompt. Bump `version` on ANY semantic change (ADR-009).
//
// The version string is load-bearing beyond traceability here: it is part of
// what decides whether a contact is re-classified. Bumping it re-classifies the
// whole database, so bump it when the meaning changes and not otherwise.

import type { VersionedPrompt } from '../runtime/types'

export interface ClassifierContact {
  id: string
  material: string
}

export interface ContactClassifierInput {
  contacts: ClassifierContact[]
}

export const RELEVANCE_KEYS = [
  'recruiting',
  'mentorship',
  'customer_discovery',
  'investor',
  'partnership',
  'speaker_sponsor',
] as const

export const contactClassifierPrompt: VersionedPrompt<ContactClassifierInput> = {
  version: '1.0.0',

  build(input) {
    const system = `You label people so they can be found again later.

You are building a reusable index over someone's existing professional network. You are NOT
deciding whether anyone is good or bad, and you are not scoring them against any particular
goal — a person who is wrong for one search is often exactly right for the next one. Your job
is to describe what each person IS, accurately enough that a later search can find them.

Work only from the material given. You have no web search and you must not invent an employer,
a specialty, or a seniority you were not shown. When something is genuinely unclear, say
"unknown" — an honest gap is findable, a confident guess is not.

WHAT TO PRODUCE FOR EACH PERSON

  industry            The industry their EMPLOYER operates in, in plain words:
                      "specialty chemicals", "industrial automation software", "management
                      consulting", "consumer packaged goods", "venture capital". Not a
                      buzzword, not a stock ticker sector.

  sub_industry        A narrower slice when you can see one, else null.
                      "battery materials", "process simulation software", "flavours".

  function            What this person actually does, in plain words. "owns manufacturing
                      operations at a plant", "leads applied AI research", "invests in
                      industrial software". Better than a job title, because titles lie.

  company_type        One of: startup, growth, corporate, consultancy, investor, academic,
                      nonprofit, government, agency, unknown.

  company_stage       "seed", "series B", "public", "private, ~5,000 people", or null.

  technical_domains   The technical territory they credibly touch. 0-5 short lowercase terms.
                      e.g. process engineering, computer vision, battery chemistry, MES,
                      predictive maintenance, LLM applications.

  business_domains    The business territory. 0-5 short lowercase terms.
                      e.g. plant operations, procurement, corporate innovation, go-to-market,
                      fund investing, university partnerships.

  opportunity_types   What kind of opportunity could plausibly come FROM this person.
                      0-4 of: internship, full_time_role, short_project, research_project,
                      consulting_project, mentorship, referral, introduction, investment,
                      partnership, speaking, sponsorship, customer_interview.

  tags                0-6 free-form lowercase tags for anything the fields above cannot hold.
                      This is where the useful specifics live — "ex-P&G", "yc alum",
                      "runs plant-floor AI council", "chicago based", "chemE background".
                      Do not repeat what is already in another field.

  relevance           A 0-1 number for each of six uses. This is a DISPOSITION, not a verdict:
                      "how naturally does this person fit that kind of ask?"

                        recruiting          could hire, sponsor an internship, or route you to
                                            someone who can
                        mentorship          worth an hour of advice; has walked the path
                        customer_discovery  would be a real user or buyer of an industrial /
                                            technical product
                        investor            invests, or decides on investment
                        partnership         could sponsor or partner with an organisation
                        speaker_sponsor     would speak at, judge, or sponsor a student event

                      Use the full range. If everything you emit is 0.5 you have said nothing.

  note                One short sentence. What makes this person distinctive, if anything.

CALIBRATION

  0.8-1.0   Squarely this. A VP of Manufacturing at a large CPG is 0.9 for recruiting.
  0.4-0.7   Plausible but indirect.
  0.1-0.3   A stretch.
  0.0       No.

Be decisive and be brief. Every field is being written to a database, not read aloud.`

    const list = input.contacts
      .map((c, i) => `── PERSON ${i + 1} (id: ${c.id})\n${c.material}`)
      .join('\n\n')

    const user = `Classify every person below. Return one entry per person, using their id.

${list}

Submit with the ${'`submit_result`'} tool.`

    return { system, user }
  },
}
