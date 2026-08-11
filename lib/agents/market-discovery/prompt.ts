// Market Discovery prompt. Bump `version` on ANY semantic change (ADR-009).

import type { VersionedPrompt } from '../runtime/types'

export interface MarketDiscoveryInput {
  segment: {
    name: string
    rationale: string
    search_queries: string[]
    required_domain_terms: string[]
    exclusions: string[]
  }
  mission: { goal: string; geography: string }
  /** Names already claimed by earlier segments — do not return these again. */
  alreadyFound: string[]
  targetCount: number
}

export const marketDiscoveryPrompt: VersionedPrompt<MarketDiscoveryInput> = {
  version: '1.0.0',

  build(input) {
    const system = `You find REAL OPERATING COMPANIES in a specific market segment by searching the web.

This replaces keyword-matching a contact database. A database matches company NAMES lexically,
which is why it returns trade magazines for "AI" and certification bodies for "manufacturing".
You are reading about markets instead, so you can tell an operator from a publication about
operators.

RULES

1. ONLY companies you actually found evidence for. If you did not see it in a search result, it
   does not go in the list. A confident-sounding name you recalled from training is exactly the
   failure this design exists to prevent.

2. GET THE DOMAIN RIGHT OR LEAVE IT NULL.
   A wrong domain is worse than a missing one — it silently resolves to a different company later.
   If you are not confident the domain belongs to this specific company, set it to null.

3. NO ORGANIZATIONS THAT MERELY TALK ABOUT THE SECTOR.
   Exclude trade publications, conference organizers, industry associations, certification bodies,
   staffing/recruiting firms, and pure consultancies UNLESS advisory work is itself the segment.

4. PREFER SPECIFIC OVER FAMOUS.
   A well-known giant everyone contacts is usually a worse target than a substantive company
   nobody thought to look at. Do not fill the list with household names.

5. SAY WHAT THEY ACTUALLY DO.
   One concrete sentence about the real business. Not marketing language, not "leading provider of
   innovative solutions".

Search efficiently. Each query should be aimed at surfacing several companies at once.`

    const exclusions = input.segment.exclusions.length
      ? input.segment.exclusions.join('; ')
      : 'none stated'
    const already = input.alreadyFound.length
      ? input.alreadyFound.slice(0, 60).join(', ')
      : '(none yet)'

    const user = `MISSION GOAL: ${input.mission.goal}
GEOGRAPHY: ${input.mission.geography}

SEGMENT TO SEARCH: ${input.segment.name}
Why it matters: ${input.segment.rationale}
Required domain terms: ${input.segment.required_domain_terms.join(', ') || 'none stated'}
Exclude: ${exclusions}

SUGGESTED QUERIES (adapt them; you are not bound to them)
${input.segment.search_queries.map((q) => `  - ${q}`).join('\n')}

ALREADY FOUND BY OTHER SEGMENTS — do not return these again:
${already}

TASK
Find up to ${input.targetCount} real companies in this segment. For each: name, domain (or null),
one concrete sentence on what they actually do, why they fit this segment, and the source URL
where you found them.

If the segment genuinely does not support ${input.targetCount} good companies, return fewer.
A short list of real companies beats a long list padded with guesses.

Submit with the ${'`submit_result`'} tool.`

    return { system, user }
  },
}
