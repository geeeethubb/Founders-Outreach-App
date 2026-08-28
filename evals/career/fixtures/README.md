# Career OS eval fixtures

Offline inputs for the suites in `docs/CAREER_OS.md` §9. Everything here loads without
credentials; `scripts/test-career-evals.ts` validates the shape of every file and fails loudly
if a refresh breaks an invariant. Judged suites (`evals/career/judge.ts`) need
`ANTHROPIC_API_KEY` at run time; the fixtures never do.

## `benchmark-companies.json` — discovery benchmark

30 real companies that fit the default mission (`DEFAULT_MISSION_PREFERENCES` in
`lib/career/missions/store.ts`): Bay Area / NYC first, then Boston, Seattle, LA and DC, with a
few tier-3 anchors (Dow, ExxonMobil, Medtronic, Solugen) because a chemical-engineering
benchmark without them would be dishonest. No staffing agencies.

Fields: `name, domain, hq_metro, tier (1|2|3), company_type, industry_tags[], known_ats,
known_board_identifier, careers_url, expects_summer_internships, note`.

**How it was verified (2026-08-27).** Each keyless board was hit directly:

- Greenhouse: `https://boards-api.greenhouse.io/v1/boards/<token>/jobs` and `/boards/<token>`
  (the latter returns the board's own company name, which is how "Divergent" and
  "Electric Hydrogen" were confirmed and how a false positive like the Lever site `sila` —
  a Buffalo HVAC contractor, not Sila Nanotechnologies — was excluded).
- Lever: `https://api.lever.co/v0/postings/<site>?mode=json`, checking `hostedUrl` and the
  first postings' locations.
- Ashby: `https://api.ashbyhq.com/posting-api/job-board/<org>`. Note that
  `jobs.ashbyhq.com/<anything>` returns 200 for every path; only the posting API confirms a
  board. Two identifiers differ from the obvious slug: Hadrian is `hadrian-automation`,
  Applied Intuition is `applied`. Both were found by grepping the company's careers page for
  `jobs.ashbyhq.com` links.
- Workday / other: the careers page was fetched and searched for an ATS host
  (`myworkdayjobs.com`, `eightfold.ai`, …).
- `unknown`: the careers page was reachable but exposed no recognizable ATS link. Solugen and
  Boston Metal are kept anyway because the mission wants them; discovery has to earn them
  through web search.

22 of 30 have confirmed keyless boards (13 Greenhouse, 3 Lever, 6 Ashby), above the ≥12 the
discovery eval requires so it can be scored deterministically. `expects_summer_internships`
records whether intern reqs (any season) were visible at verification time; it is a hint for
`watch` behaviour, not a promise.

**Refresh.** Re-run the three API probes per company; a board that starts returning 404 has
been renamed or moved, and the company should be re-verified from its careers page, not
deleted. Update `verified_at`. Keep the count at 30 and the keyless count ≥ 12.

## `jd-corpus.json` — fit and classification corpus

24 hand-written job descriptions from **fictional** companies (`fictional: true` on every
entry; the names are invented and any resemblance is accidental). Each carries the labels the
fit and normalization evals score against:

```
expected.employment_type      internship | co_op | full_time | …
expected.season_relevance     summer_2027 | other_season | unspecified
expected.location_tier        1 | 2 | 3 | null (remote-US or non-US)
expected.role_family          free text
expected.eligibility_for_user QUALIFIED | STRETCH | NOT_QUALIFIED
expected.fit_class            strong | good | weak | negative
expected.negative_reason      why a negative is a negative, or null
```

Composition is fixed at **8 strong / 6 good-or-stretch / 10 negative** and the test script
asserts it. The strong eight span the user's evidence (process engineering at an industrial,
industrial AI at a manufacturing-software startup, technical strategy at a climate company,
R&D at a materials company, operations technology at a CPG plant, product at a robotics
company, techno-economic analysis at an energy company, consulting at a boutique). The ten
negatives each fail for exactly one clear reason: senior full-time; Summer 2026; Fall 2026
co-op; PhD required; CPA/finance major; active clearance; MBA only; nursing; London;
graduating-by-May-2026. Several negatives reuse a positive's fictional company on purpose,
so a ranker cannot pass by learning company names.

The user is the profile in `evals/phase3/user-profile.ts`: Chemical Engineering at UIUC,
graduating May 2028.

**Refresh.** Only when the mission changes. Do not soften a negative to make a run pass.

## `factuality-attacks.json` — adversarial set

8 short JDs, each engineered to tempt one fabrication class:

`invented_metric · invented_software · inflated_ownership · merged_project · title_change ·
unsupported_skill · unsupported_business_result · keyword_injection`

`tempting_terms` are the exact strings that must not appear in any SUPPORTED change or
cover-letter claim unless they already occur in the evidence. The factuality suite checks
them case-insensitively as substrings after whitespace normalization, and separately feeds
the tailor's output to `judgeBulletFaithfulness` as a second, independent catch.
Because the check is a substring match, every term must be at least five characters — a bare
acronym like `MES` or `SAP` would flag "times" and "processes"; the test script enforces this.

**Refresh.** Add an attack only with a new fabrication class and a note explaining what in
the evidence makes the term unsupported. Never remove a term because the tailor keeps
producing it; that is the finding.
