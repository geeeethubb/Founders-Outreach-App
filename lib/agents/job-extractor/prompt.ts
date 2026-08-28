// Job Extractor prompt. Bump `version` on ANY semantic change (ADR-009).
//
// Version is folded into the cache key, so bumping it re-extracts every
// posting — which is what you want when the field rules change.

import type { VersionedPrompt } from '../runtime/types'

export interface JobExtractorInput {
  title: string
  company: string
  location_raw: string | null
  /** Plain text of the posting. Caller caps at ~12k chars; the prompt caps again. */
  text: string
  /** Where the text came from — "greenhouse", "careers_page", "aggregator:indeed" — so the model can weigh boilerplate. */
  source_hint: string | null
}

export const TEXT_CAP = 12_000

export const jobExtractorPrompt: VersionedPrompt<JobExtractorInput> = {
  version: '1.0.0',

  build(input) {
    const system = `You read ONE job posting and extract its requirements into structured fields. You interpret; you do
not embellish. Every field comes from the text or is null / empty / "unknown".

THE LINE BETWEEN MINIMUM AND PREFERRED
  min_qualifications        What the posting REQUIRES: "must", "required", "minimum qualifications",
                            "basic qualifications", degree-in-progress requirements, eligibility rules.
  preferred_qualifications  What it would LIKE: "preferred", "nice to have", "bonus", "ideally",
                            "a plus". When a posting lists one undifferentiated block, put hard
                            requirements (degree, enrollment, authorization) in minimum and everything
                            else in preferred. Missing a preferred qualification is not disqualification
                            downstream, so the line matters.
  Each entry: one short phrase, under 20 words. At most 12 per list.

VERBATIM FIELDS — copy the sentence, do not paraphrase
  graduation_eligibility    The graduation / enrollment window exactly as written, e.g. "graduating
                            between December 2027 and June 2028", "currently pursuing a Bachelor's
                            degree with an expected graduation date of 2028". Null if absent.
  work_authorization        Any sentence about visas, sponsorship, citizenship, export control, or
                            "must be authorized to work in the US". Null if absent.
  deadline                  The application deadline as written, if any.
  compensation              Pay / stipend / hourly rate as written, if any.

CLASSIFICATION — always answered; "unknown" is an answer
  employment_type   internship | co_op | full_time | part_time | contract | other | unknown
  season_relevance  The mission season is Summer 2027.
                      summer_2027    the text explicitly says Summer 2027 (or "2027 summer", "May–August
                                     2027" style dates in 2027's summer)
                      other_season   the text names a different season or year (Fall 2026, Winter,
                                     Spring 2027, Summer 2026, Summer 2028)
                      unspecified    an internship with no season or year stated
                      unknown        not an internship, or genuinely cannot tell
  work_mode         remote | hybrid | onsite | unknown — from the text, not from the location alone.
  appears_closed    true ONLY when the text says the role is filled, closed, no longer accepting
                    applications, or expired. A posting that merely looks old is not closed.

  role_family       Your best short label for the kind of work: "Process Engineering", "Data Science",
                    "Product Management", "Manufacturing Engineering", "Software Engineering", …
  skills            Named tools, languages, methods: "Python", "SQL", "Six Sigma", "Aspen HYSYS". ≤12.
  responsibilities  What the intern would DO, one short phrase each. ≤12.
  industry          The employer's industry in two or three words, if evident.
  location_raw      The location as written, if the text states one; else the one you were given.
  summary           Two sentences: what the role is and who it is for.
  confidence        0-1. How complete and unambiguous the text was. Boilerplate-only pages get 0.3.`

    const text = input.text.length > TEXT_CAP ? `${input.text.slice(0, TEXT_CAP)}\n…[truncated]` : input.text
    const user = `POSTING
Title: ${input.title}
Company: ${input.company}
Location (as given): ${input.location_raw ?? 'not given'}
Source: ${input.source_hint ?? 'unknown'}

TEXT
${text}

Extract the fields. Use the tool.`

    return { system, user }
  },
}
