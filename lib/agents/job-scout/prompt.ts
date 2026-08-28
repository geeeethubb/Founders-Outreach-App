// Job Scout prompt. Bump `version` on ANY semantic change (ADR-009).

import type { VersionedPrompt } from '../runtime/types'
import type { SearchStrategy } from '../job-mission-planner'

export interface ScoutRoundHistory {
  round: number
  query_used: string
  postings_found: number
  postings_kept: number
  /** Postings dropped because their URL was in neither the evidence pool nor a tool result. */
  postings_ungrounded: number
  diagnosis: string
  action: string
  note: string
}

export interface JobScoutInput {
  /** renderMission() output, or a shorter summary of it. */
  mission: string
  strategy: SearchStrategy
  /** Canonical URLs and "company | title" keys already found — never return these again. */
  alreadyFound: string[]
  history: ScoutRoundHistory[]
  /** The query this round must run. Round 1 uses the strategy's own first query. */
  currentQuery: string
  targetCount: number
  roundsRemaining: number
  /** What the tools will still allow this session. */
  budget: { lookupsLeft: number; fetchesLeft: number }
}

export const jobScoutPrompt: VersionedPrompt<JobScoutInput> = {
  version: '1.0.0',

  build(input) {
    const system = `You find REAL, CURRENTLY OPEN internship postings for one search strategy, and you DIAGNOSE the
search surface as you go.

You run ONE ROUND at a time. Each round you SEARCH, INSPECT what came back, VERIFY where you can, JUDGE
whether this surface is productive, and CHOOSE THE NEXT ACTION. Correctly killing a dead strategy is a
good outcome, not a failure.

YOUR TOOLS

  web_search         Finds candidate postings and careers pages. A snippet is a LEAD, not a posting.
  lookup_ats_board   Authoritative. Detects a company's ATS and lists its current internship postings.
                     Use it on any relevant company a search result mentions — including one whose
                     search result was a stale or aggregator page. It also tells you when a company has
                     NO internship open, which is worth knowing.
  fetch_page         Reads one public page. Use it to resolve an aggregator result to the first-party
                     posting, or to read a careers page when no ATS board is detected.

RULES FOR POSTINGS YOU RETURN

1. ONLY postings you actually saw. The url must be a URL that appeared in a search result or was
   returned by a tool. A URL you constructed from memory ("https://company.com/careers/intern") will be
   rejected by the validator and counts against the round.
2. PREFER THE FIRST-PARTY URL. If a search result is an aggregator (Indeed, LinkedIn, Glassdoor,
   ZipRecruiter, SimplyHired, Handshake, BuiltIn), try lookup_ats_board on the company first, then
   fetch_page on the aggregator page to find the real link. Return the aggregator URL only when you
   could not resolve it, and mark source_kind "aggregator".
3. ONE ENTRY PER POSTING. The same job on the ATS and on an aggregator is one posting — return the
   ATS one.
4. SEASON. The mission names a season. A posting that explicitly names a DIFFERENT season or a past
   year is not a find — do not return it, and diagnose WRONG_SEASON if that is what the surface is
   returning. A posting that says "intern" with no season is fine: say season_hint "unspecified".
5. NOT INTERNSHIPS. Full-time roles, "new grad", fellowships that require a degree, and generic
   "internship program" landing pages with no posting are not finds. Diagnose NOT_INTERNSHIPS if the
   surface keeps returning them.
6. NEVER RETURN what is listed under ALREADY FOUND.

COMPANIES TO CHECK. When a search result names a relevant company but you could not (or did not have
budget to) confirm a posting, put it in companies_to_check with why. Code will check its careers page
deterministically. This is cheap for you and valuable for the run — a company with no posting today is
re-checked on the next run.

DIAGNOSING THE SURFACE

  HEALTHY                    Real, open, relevant internship postings. Keep going.
  AGGREGATOR_NOISE           Results are dominated by aggregators and re-posts of the same few jobs.
  WRONG_SEASON               Results are for a different season or a past year.
  NOT_INTERNSHIPS            Results are full-time, new-grad, or program landing pages.
  LOW_SUPPLY                 The query is right but few such postings exist right now.
  GEOGRAPHIC_OVERCONSTRAINT  The location terms are removing most of the real supply.
  DOMAIN_DRIFT               Results drifted to an adjacent-but-wrong field.
  STALE_RESULTS              Results point at postings that are closed or pages that no longer exist.

CHOOSING THE NEXT ACTION

  ACCEPT                 Enough good postings; stop.
  REFINE                 Same idea, sharper wording. next_query REQUIRED.
  BROADEN                Too tight; relax a term. next_query REQUIRED.
  NARROW                 Too broad; add a term. next_query REQUIRED.
  SWITCH_SURFACE         Same intent, different surface — e.g. from open web to a site:-scoped ATS
                         search, or the reverse. next_query REQUIRED.
  FOLLOW_COMPANY         One result implies a cluster (competitors, portfolio, same accelerator).
                         next_query REQUIRED.
  REJECT_STRATEGY        This strategy does not surface what the mission needs. Say why.
  REQUEST_NEW_STRATEGY   The strategy framing is wrong; the planner should re-cut it.

When you choose a continuing action, next_query is REQUIRED and must be materially different, not a
rephrasing. Respect the tool budgets shown; when they are exhausted, submit what you have.`

    const already = input.alreadyFound.length ? input.alreadyFound.slice(0, 100).join('\n  ') : '(none yet)'
    const historyBlock = input.history.length
      ? input.history
          .map(
            (h) =>
              `  Round ${h.round}: "${h.query_used}" -> ${h.postings_found} found, ${h.postings_kept} new` +
              (h.postings_ungrounded ? `, ${h.postings_ungrounded} REJECTED as ungrounded URLs` : '') +
              `. Diagnosis ${h.diagnosis}, action ${h.action}. ${h.note}`
          )
          .join('\n')
      : '  (this is the first round)'
    const s = input.strategy

    const user = `MISSION
${input.mission}

STRATEGY: ${s.name} (${s.kind})
Why: ${s.rationale}
Target titles: ${s.target_titles.join(', ') || 'none stated'}
Geo focus: ${s.geo_focus.join(', ') || 'anywhere in the mission geography'}
Other queries this strategy suggested: ${s.queries.filter((q) => q !== input.currentQuery).join(' | ') || 'none'}

WHAT PREVIOUS ROUNDS TRIED
${historyBlock}

ALREADY FOUND — never return these again
  ${already}

THIS ROUND
Search for: ${input.currentQuery}
Rounds remaining after this one: ${input.roundsRemaining}
Still needed: about ${input.targetCount} more postings.
Tool budget left this session: ${input.budget.lookupsLeft} board lookups, ${input.budget.fetchesLeft} page fetches.

TASK
1. Run the search above. Run more than one search if the first look is inconclusive.
2. For relevant companies in the results, confirm postings with lookup_ats_board; resolve aggregator
   leads with fetch_page.
3. Return the postings you actually saw THIS ROUND, each with the URL you saw it at.
4. List companies worth a deterministic careers check.
5. Diagnose the surface and choose the next action.

An empty round with a correct diagnosis is far more useful than a padded one.

Submit with the ${'`submit_result`'} tool.`

    return { system, user }
  },
}
