# Build Log

Concise summaries of meaningful implementation changes, newest first.
One entry per phase or per significant change. Not a commit log — a record of what changed
architecturally and why.

---

## 2026-08-28 — Phase 11: Career OS

**Type:** product extension · **Behavior change:** new surfaces only; the outreach loop and
the email layer are untouched

### What happened

Outreach OS became a Career OS: Summer 2027 internship discovery, verification, fit,
company research, evidence matching, warm paths, conservative résumé tailoring with an
independent fact verifier, DOCX/PDF generation from the master template, cover letters, an
application tracker with immutable submitted documents, feedback that adjusts ranking through a
bounded modifier, and six eval suites. Architecture note: [CAREER_OS.md](CAREER_OS.md);
ADR-030–037; twelve agents in [AGENTS.md](AGENTS.md).

Built in three waves of parallel workstreams (7 → 2 → 4), each with an independent reviewer
who re-ran the tests, checked every column name against migration 014, and fixed what they
found before reporting. Reviewers caught, among others: a non-column in the evidence-map
insert that would have failed every package on the real database; a document-overwrite on
package retry; a 1000-uuid `IN` delete; untraced agent calls; a résumé change that could
silently vanish when two changes named one bullet; a judge that was shown the expected class
in the fixture ids; an eval that compared a document against itself.

### Founder action

```bash
# 1. Supabase SQL editor: supabase/migrations/014_career_os.sql  (013 first if not applied)
# 2. once:
npm run career:seed -- --approve
# 3. then /dashboard/jobs → Scout now, or a deeper run:
npm run career:scout
```

During the build, migration 014 was not yet applied, so every eval ran in no-database mode on
the real master résumé and every store was column-checked by a reviewer. The founder then
applied it, and the live verification below exercised the whole path against the real
database.

### Live verification (2026-08-28, after the founder applied migration 014)

| Step | Result |
|---|---|
| `scripts/verify-career-schema.ts` | 23 tables, 2 extended tables, the `career-docs` bucket — all present |
| `npm run career:seed -- --approve` | master stored in the bucket (23 KB), 11 experiences, 14 bullets (all with fact ids), 23 facts (all with `source_location`), 17 metrics, 7 skills, 34 preferences, the default mission; $0 (importer cached); **second run: 0 new, 11 reused** |
| warm-path retrieval on the 897 real contacts | company matches + index + relationship history work; the alumni signal fired on 27/27 contacts (V1's "Shared:/Hooks:" lines are about the user) — fixed to identity fields and education sentences, now 0/27 |
| `npm run career:scout` (1 strategy · 1 round · 10 companies) | 8 strategies planned, 36 seeds on the watchlist (5 already `opening_available`), 13 companies checked, 17 postings persisted `VERIFIED_OPEN` with sources and snapshots, run + agent traces with cost ($0.67, 328 s) — but the CLI defaulted to the web's 270 s deadline and stored the rows unextracted and unranked |
| fixes from that run | CLI deadline 1200 s; extraction backfill inside the intelligence orchestrator; `parseDeadline` ("August 2026" had failed a timestamp column) |
| intelligence on three jobs | Kairos ChemE/Materials **0.68 GOOD · QUALIFIED** (6 `do_not_claim`); Anduril Manufacturing 0.38 STRETCH; TRI world-models 0.03 NOT_QUALIFIED; research 12–13 claims each |
| `npm run career:package -- --job <kairos>` | 4 reorder-only changes, all SUPPORTED, approved as safe (distance 0) → `Zuyu_Liu_Kairos_Power_Resume.{docx,pdf}` one page, Calibri only, QA clean (Word) → 312-word letter, 8 claims, grounded after one revision → `ready_for_review`, $0.50 |
| last mile | approve letter → finalize → `READY_TO_APPLY` → `APPLIED`: `locked = true`, submitted paths copied, package `locked`, five events recorded; reviews of the locked package are refused. The verification application was then withdrawn back to `SAVED` (its v1 package stays locked, as designed). |

### What running it measured

Every number below is from `.career-out/eval/*/results.json` (gitignored — they carry
résumé text), n-labelled, judged by blinded, independent judges, with targets that were never
lowered. Full tables in [EVALS.md §13](EVALS.md#13-phase-11--career-os-evals).

| Suite | Headline |
|---|---|
| Fit ranking (24 JDs) | 11/11 targets. Negatives above positives: **0** (13 before the gates). Eligibility 95.8%. Judge P@10 **100%**. The senior full-time decoy that shares the positives' vocabulary ranks 23/24. |
| Discovery (22 boards + a live scout) | Duplicates **0%** (31.9% before the dedupe fix — every cluster was a false merge), canonical URL **100%**, stale-shown-open **0%**, tier at HQ **100%**. P@20 **65% → 85%** after widening the pool, **70%** on a concurrent second run: pooled 31/40 = 77.5% against 80%. The limit is the pool — 9 of 22 boards listed no internships on 2026-08-27 — not the ranking (P@10 100% / 80%; the BAD_FIT rows sit in the WEAK band at ranks 18–20). |
| Résumé factuality (8 attacks) | Unsupported claims reaching output: **0** (n = 28 supported changes). Planted fabrications caught: **16/16** (pre-check 13, verifier 16; the invented-event and merged-project plants are verifier-only catches). On every attack the tailor chose reorders and emphasis only and explicitly refused Six Sigma / SAP PM / Palantir Foundry / Kubernetes / $10M / "managed a team of 12". |
| Minimal edit | Matched role: distance **0**, 3 emphasis-only changes. Mismatched role: distance 0, reorder + emphasis; the approved alternate bullet was not used. Adversarial: distance 0. |
| Cover letter (4 real companies + 2 fictional) | Grounded **6/6** (66.7% → 83.3% → 100% across three prompt/pool fixes), one page **6/6**, 278–298 words, banned phrases 0, foreign proper nouns in the fictional letters **0**. Judge means: truthfulness 0.87, professionalism 0.88, filler-absence 0.85, growth narrative 0.66, company specificity 0.49 (0.75–0.95 with research; 0.05 where research returned no claims). |
| Documents | **40/40** valid DOCX + PDF, one page, correct filenames; 20 of 30 résumé variants exercised the shrink loop. Word: 1.4 s median per render. |

Live pipeline on the real résumé (no-DB CLI, one strong fixture JD): extract → research →
fit 0.49 MAYBE / QUALIFIED → evidence map with 5 `do_not_claim` → 2 emphasis-only changes,
both SUPPORTED → `Zuyu_Liu_<Company>_Resume.{docx,pdf}` one page, QA ok → 377-word letter
(the run that exposed the one-page overflow; the band is now 200–290 with a retry).
$1.26, 334 s.

### What the measurements changed — all deterministic, all with the target unchanged

| Failure | Class | Fix |
|---|---|---|
| a Summer 2026 posting ranked 4th at 0.70 while `NOT_QUALIFIED` | ranking arithmetic | `fitGates`: NOT_QUALIFIED ×0.5; failed hard constraint ×0.6 capped at 0.30; role_fit < 0.35 scales proportionally — identical at evaluation, re-sum and in the eval |
| 31.9% "duplicates" | dedupe | same board + different ATS id ⇒ distinct; different title seasons ⇒ distinct; body similarity needs title similarity ≥ 0.5 |
| Newark / Woburn → tier 3; Budapest passed "United States" | normalization | metro suburb aliases + "Greater X area" hints; ~60 countries |
| `(Spring 2027)` in the title, `summer_2027` from the template body | normalization | the title overrules the extractor for non-summer seasons |
| P@20 65% with the ranking correct | source pool | internship-only listings 120 per board (was 40 after the filter), every extracted job ranked |
| scout round "exceeded 7 steps" in 2 of 5 runs | agent budget | maxSteps 10; tool caps unchanged |
| 377-word letter on two pages | docgen | band 200–290, one-page retry at 180–250, kept flagged never discarded |
| letter named competitors from an INFERENCE | grounding pool | company pool = name + domain + grounded points + FACT claims; the posting's own text is a separate pool; the researcher summary is no longer rendered to the writer (prompt 1.0.2) |
| writer rejected with no reason | schema | validator names the reason; one retry carries it |
| `$1.5 million` read as a count of 5 | pre-check | decimal lookbehind |
| a 4120 s job-first run against a 600 s deadline | runtime | Anthropic retries stop at a run deadline the orchestrator sets |
| the planner's plan truncated, failed validation, and job-first found nothing ($4.71) | schema / degradation | planner output budget 8000 → 12000; a failed planner degrades to two deterministic fallback strategies (labelled in the run's errors) instead of "company-first only" |

### Bugs the tests caught

- `job_evidence_maps` insert carried `no_gaps_reason`, a field with no column — every package
  would have run tailoring against an empty evidence map on the real database.
- `finishPackage` retried into the same storage prefix; `saveDocument` refuses overwrites, so
  the retry path after a QA failure would have failed forever.
- Two tailor changes naming one bullet: the later silently overwrote the earlier in
  `finalBulletsFor`.
- The fit judge was shown fixture ids that spell out the expected class, and the top-k in rank
  order. Blinded and shuffled; P@10 held at 100%.
- The document eval's `content_match` compared the produced DOCX against itself.
- `persistProposal` re-inserted metrics and deliverables on every re-seed.
- Concurrent eval runs overwrote one `results.json`; runs are now stamped per file.

### Cost

Phase A probes ≈ $5 · fit suite ≈ $7 (4 paid runs) · discovery ≈ $40 (5 runs; ~$17 of it a
harness cache-key bug) · factuality + minimal-edit ≈ $9 · cover letter ≈ $9.4 · package CLI
$1.26. Re-runs of unchanged inputs are $0.

### Not done

- The pages themselves have not been clicked through in a browser; the stores and
  orchestrators behind every route have now run live (see the verification table).
- P@20 met in one of three post-fix runs (85% / 70% / 70%, pooled 75%); the pool, not the
  ranking, is the binding constraint on this date — the head of the list is right (P@10
  90–100%), the tail runs out of relevant rows.
- The faithfulness judge never saw a wording change: on every attack and minimal-edit JD the
  tailor chose reorders and emphasis. Whether it under-uses Levels 3–4 needs a fixture that
  *requires* a wording change.
- `rank.ts` re-sum writes totals only, so gate labels in `red_flags` reflect the first persist.
- Company Researcher can succeed with zero claims (Formlabs) — its validator should retry on an
  empty claims array.
- `lib/career/scout/orchestrator.ts` is 482 lines and `intelligence/orchestrator.ts` 433.

---

## 2026-08-16 — Phase 10: The existing network, and a voice you supply

**Type:** implementation + eval · **Behavior change:** additive; V1 and Phases 3–9 intact

Two problems, both found by using the product rather than reading it. Full write-up in
[PHASE_NETWORK_AND_REFERENCE.md](PHASE_NETWORK_AND_REFERENCE.md).

**~900 researched contacts were invisible.** Every run started by paying to discover
strangers while 897 people — 635 bought from Apollo, 262 with research summaries, 4,244
grounded facts, 250 already emailed — sat unreachable because nothing indexed them.

**The emails did not sound like the founder.** The house voice was a stack of adjectives
(*founder-to-founder · concise · confident · high-signal*) plus a 60–120 word cap, and it
reliably produced drafts that were arrogant and over-compressed.

### Added

```
supabase/migrations/013_network_and_reference.sql   contact_index + search_contact_index(),
                                                    network_matches, outreach_edits,
                                                    campaign reference columns
lib/network/*                normalize · document · relationship · indexer · search ·
                             facets · rank · sufficiency · matches · context · reuse
lib/agents/contact-classifier/*   mission-independent labelling, cached by content hash
lib/agents/network-retrieval/*    a bounded agent with one tool: search the network
lib/agents/style-analyst/*        what makes this email sound like this person
lib/scouting/internal-first.ts    the phase, extracted rather than added to orchestrator.ts
lib/scouting/prospect.ts          the one shape a prospect has, whatever it came from
lib/campaigns/reference.ts        store, analyse, cache the campaign reference
lib/outreach/placeholders.ts      deterministic, blocking
app/api/{campaigns/[id]/reference,campaigns/references}/route.ts
components/campaigns/ReferenceEmailPanel.tsx
evals/network/* · evals/reference/*
scripts/{index-network,network-eval,reference-eval}.ts
```

### ADRs

[ADR-025](ARCHITECTURE.md#adr-025) search the existing network before discovering anything ·
[ADR-026](ARCHITECTURE.md#adr-026) classification is mission-independent and hash-cached ·
[ADR-027](ARCHITECTURE.md#adr-027) reuse before purchase ·
[ADR-028](ARCHITECTURE.md#adr-028) a campaign's reference email outranks the house style ·
[ADR-029](ARCHITECTURE.md#adr-029) placeholders are a blocking deterministic gate.

### Measured

| | |
|---|---|
| Internal Precision@20, five missions | **82%** average · **2%** BAD |
| Consulting — the profile external discovery was worst at | 15% (P3) → 20% (P6) → **84%** |
| External discovery skipped | **5 of 5 missions** · ~125 Apollo credits avoided |
| Indexing 897 contacts | **$1.59**, once |
| Per mission | **$0.51–$0.74**, no Apollo credits |
| Reference similarity vs house-style control | **3.83** vs **2.00** / 5 |
| "Would a reader believe one person wrote both?" | **83%** vs **17%** |
| Drafts over-compressed against the reference | **0%** vs **58%** |
| Placeholders reaching a draft | **0** |
| Deterministic tests | **345 pass** (was 226) |

### Six things running it found

1. **Every search matched two-thirds of the database.** OR-ed terms plus a body-text match
   meant 500–599 of 897 rows matched anything, so the count carried no signal and the agent
   could not tell "too broad" from "the network is full of these". Fixed with a relevance
   floor set *relative to the best match in the same query* — absolute floors are not
   comparable across queries of different lengths.
2. **A dropped `\w*` had mislabelled most of the network.** `\bmanufactur\b` cannot match
   "Manufacturing" — the `i` is a word character. "Director of Manufacturing", "VP
   Operations", "Chief Technology Officer" and "Head of Sustainability" all indexed as
   `unknown`, the facet counts looked plausible, and the function filters were inert. Caught
   by a unit test asserting a recruiter is not an engineer.
3. **An agent that appeared to hang was truncating and escalating.** `stop_reason: max_tokens`
   on `submit_result` cut the tool call mid-JSON; validation failed; the loop escalated a tier;
   the stronger model wrote *more*, truncated again, and charged 5× for it. One mission cost
   $1.16 and several minutes. Truncation is now its own case in `runtime/loop.ts` and asks for
   a shorter answer instead of a re-read — **a fix that applies to every agent in the system.**
4. **The agent treated its target as a quota.** Asked for 10 it returned exactly 10, and the
   recall probe found ten more it had surfaced, judged GOOD, and discarded. "How many the
   mission needs" and "how many to shortlist" are now separate numbers.
5. **The claim gate blocked the user's own true facts.** A sponsorship reference said "roughly
   300 students"; every draft repeated it; the gate blocked all of them. The reference is an
   email the user *wrote and sent*, so facts in it about themselves are verified by
   construction — the same logic that already admitted an inbound reply. Facts about its own
   recipient are excluded, so this cannot licence a transplant.
6. **The gate blocked a hedged question.** "I am curious how that shift changes what you pay
   attention to … once you are responsible for a whole region", to a VP of Operations: true,
   asked rather than asserted, and blocked because it shared no five-letter word with the
   evidence. Hedged and interrogative frames now warn instead — which is what the writer's own
   instructions already permitted.

### A trade recorded because it goes the "wrong" way

An earlier prompt scored **4.25 similarity and 100% same-writer** — by reproducing whole
sentences from the reference, including a 22-word opening, verbatim, to every recipient.
Prompt 2.1.0 forbids copying sentences even when every fact in them is true and about the
sender. Similarity fell to 3.83, same-writer to 83%, and the deterministic pass rate rose from
50% to 75%. The lower number is the better system.

### Blocked on founder action

`013_network_and_reference.sql` must be applied by hand, then `npm run index:network` run once
(~$1.60). Until both happen the scout finds an empty index and says so, in the run log and in
the UI.

---

## 2026-08-17 — Migration 013 did not parse, and nothing in the repo could have said so

**Type:** fix + tooling · **Behavior change:** none to the app

The founder applied `013` and got `ERROR: 42601: syntax error at or near "floored"` — a CTE
closed with `)`, then a comment, then the next CTE, with no comma. One character.

**The bug is trivial; how it reached a production database is not.** Migrations here are
applied by hand, so the first thing that had ever parsed the file was the founder's Supabase
editor, and the feedback loop for a missing comma was a person reading an error code back to
us.

### Fixed twice over

1. The comma.
2. **`npm run check:sql`** — every migration parsed with PostgreSQL's own parser
   (`libpg-query`, the real thing compiled to wasm). 11 files, 162 statements, clean.

The second one turns on a detail that decides whether it is worth anything: it parses each
`$$ … $$` function body **separately**. To the outer parser a body is just a string literal,
so the outer parse of the broken file *passed* — while Postgres, which validates function
bodies at `CREATE` time, rejected it. A checker without that pass would have signed off on
the exact file that failed. Regression-tested against the committed broken version, where it
reproduces the founder's error verbatim, down to the line number.

Syntax only, and it says so: it cannot tell you a type is wrong or a function is not
`IMMUTABLE` enough for a generated column.

### Also hardened, found while re-reading the file

`create or replace function` **cannot** change a return type or a parameter name — it fails
with "cannot change return type of existing function". Since re-running a migration by hand is
the normal operating condition here, the day someone adds a column to `RETURNS TABLE` a plain
re-run would fail with an error that says nothing about the edit that caused it. A `DO` block
now drops every overload by name first, which also stops an old signature lingering and
winning overload resolution.

### Verified rather than assumed

The `contact_index` column set matches the keys `lib/network/indexer.ts` upserts exactly, and
correctly excludes the generated `search_vector` (inserting into a generated column is an
error). The 11 `p_*` RPC arguments in `lib/network/search.ts` match the function signature,
and the `RETURNS TABLE` order matches the final `SELECT` position for position.

---

## 2026-08-11 — Phase 9: Approval, send, response tracking

**Type:** implementation + eval · **Behavior change:** additive; the V1 email layer is untouched

Closed the production loop: `APPROVE → PERSIST → SEND → TRACK → RESPOND → OUTCOME`.
Full write-up in [PHASE_SENDING.md](PHASE_SENDING.md).

### The audit decided the design

The email layer works and is not to be rewritten, so the question was "what is the smallest
thing I can add so the existing sender works for scouted prospects?" Answer: write an
`emails` row for every send. `syncReplies` already finds replies by re-listing the Gmail
threads recorded there — so **reply tracking required zero changes to `lib/email/*`**.

### Added

```
supabase/migrations/012_outreach.sql   outreach + outreach_events, RLS, CAS-friendly indexes
lib/outreach/states.ts                 transition table, outcomes, classification -> state
lib/outreach/grounding.ts              the deterministic claim-safety gate
lib/outreach/evidence.ts               ONE evidence builder, for the writer and the gate
lib/outreach/store.ts                  upserts, edits, transitions, compare-and-swap claim
lib/outreach/send.ts                   idempotent send over lib/email/resend.ts
lib/outreach/replies.ts                joins synced replies to outreach on the thread id
lib/outreach/funnel.ts                 deterministic funnel arithmetic
lib/agents/conversation/*              reads a reply, recommends an action, drafts a response
lib/agents/followup/*                  one bounded follow-up suggestion, starts from "no"
app/api/outreach/**                    list/funnel, PATCH, send, sync, conversation, followup
app/dashboard/outreach/*               the review queue
app/dashboard/scout/OutreachPanel.tsx  approve / edit / skip / send, server-backed
evals/conversation/fixtures.ts         14 reply fixtures
scripts/{conversation-eval,outreach-e2e,prepare-pilot,probe-grounding}.ts
```

### ADRs

[ADR-022](ARCHITECTURE.md#adr-022) `outreach` owns relationship state, `emails` stays the
message · [ADR-023](ARCHITECTURE.md#adr-023) the gate is deterministic and blocking, and
needs a wider pool than the writer · [ADR-024](ARCHITECTURE.md#adr-024) idempotency is a
compare-and-swap, not a check.

### Five things running it found

1. **An infinite loop in the gate.** `String.replace` with a `/g/` regex resets that
   regex's `lastIndex`; one object used for both scanning and rewriting restarted the scan
   from zero and allocated to 4GB. Found by running it.
2. **The gate blocked 9 of 10 real drafts, and was right.** The evidence pool held proof-point
   *summaries* only, so the site name and the scale — which live on the résumé item's `org` —
   reached the draft via the positioning brief instead. Fixed with two pools, not a looser gate.
3. **`/(?<=.)s+/` was splitting company facts on the letter "s"**, producing evidence lines
   like `"ection the candidate already ha"`. A dropped backslash, invisible until the gate
   read the same pool.
4. **A 3-char prefix match let "there" ground itself against "the"**, waving through an
   invented recipient responsibility.
5. **The state machine and the send path disagreed** about retrying a failed send — caught by
   a test asserting the invariant rather than the implementation.

### Measured

| | |
|---|---|
| Claim gate | 9/10 real drafts clear · **8/8 fabrications blocked** (the 10th block was correct) |
| Conversation agent | **14/14** classification and action · 0 critical misses · 0 ungrounded replies |
| Deterministic tests | 226 pass (was 139) |
| Approve → Send cost | **$0** — no model call on the path |
| Pilot preparation | 5 prospects, all clear the gate, **$0** (cached) |

### Blocked on founder action

`012_outreach.sql` must be applied by hand (this repo has no migration runner, by design).
Until then nothing persists; `npm run check:outreach` says so and exits 2.

---

## 2026-08-11 — Phase 8: Positioning and outreach drafting

**Type:** implementation + eval · **Behavior change:** additive

Two agents — Positioning decides the argument, Outreach writes it — plus their evaluators
and the prospect card. Split on purpose: a flat draft is otherwise undiagnosable as a
writing problem or a positioning problem. Full write-up in
[PHASE_POSITIONING.md](PHASE_POSITIONING.md).

Positioning **4.28** and email **4.38** on the strongest three (both pass);
**3.85 / 4.03 across all ten** (both fail, recorded as failures). The small sample was the
strongest three — an optimistic instrument, and the finding rather than an accident.
Positioning quality tracks prospect quality, so the fix is a better shortlist, not a better
prompt. $0.17 per outreach-ready prospect against a $0.20 target.

---

## 2026-08-11 — Phase 7: Agentic scouting on Anthropic

**Type:** implementation + eval · **Behavior change:** additive; V1, Phase 3 and Phase 6 paths intact

Scouting became a set of agents that decide what to do, rather than a fixed pipeline with
research bolted into it. Anthropic replaced OpenAI for all new research, behind the unchanged
`WebResearchProvider` interface — the swap was a provider swap, which is what
[ADR-008](ARCHITECTURE.md#adr-008) existed to buy.

### What was built

- **`lib/agents/runtime/`** — one bounded tool loop serving every agent. The model gets
  server-side `web_search`, our client tools, and a `submit_result` tool carrying its output
  schema. Text outside that tool call is ignored, so malformed output is a validation failure at
  the boundary rather than a parsing problem later. → [ADR-016](ARCHITECTURE.md#adr-016)
- **Market Discovery as a session** — each round it searches, inspects, diagnoses the search space
  (`DOMAIN_DRIFT`, `LOW_SUPPLY`, `WRONG_COMPANY_ARCHETYPE`, …) and picks the next action, including
  killing its own hypothesis. → [ADR-020](ARCHITECTURE.md#adr-020)
- **Company Validation** — KEEP / MAYBE / REJECT with evidence, plus the real job titles to search
  for at *that* company. → [ADR-018](ARCHITECTURE.md#adr-018)
- **Person Research** — KEEP / MAYBE / REJECT / `SEARCH_FOR_DIFFERENT_PERSON`, the one upstream
  feedback edge. → [ADR-019](ARCHITECTURE.md#adr-019)
- **Migration 011** — `scouting_runs`, `agent_runs`, `research_facts`, the last with a CHECK
  constraint making an unsourceable FACT unstorable.
- **`evals/agentic/`** — five profiles, an independent judge, and metrics for Precision@20, BAD
  rate, discovery precision, rejection accuracy, search recovery, best-person hit rate, and
  Apollo/Anthropic efficiency.

### Bugs found by running it, not reading it

- **Apollo returned zero people for every company.** The strategist emitted descriptions where
  Apollo wants job titles. Fixed structurally with per-company titles plus a deterministic
  normalizer, not with prompt pleading.
- **A name-scoped search resolved to a different company** — a 3-person industrial AI startup
  matched a 412-person Polish music publisher of the same name.
- **The grounding check was destroying real sourcing.** The evidence pool was built only from text
  citations, but an agent that answers via a tool call emits none, so every genuine FACT was
  downgraded. It read as "100% sourced" because numerator and denominator both collapsed to zero.
  0/9 FACTs kept sources before, 12/12 after. → [ADR-017](ARCHITECTURE.md#adr-017)
- **`agent_runs` cost exceeded the run cost** ($1.33 vs $0.92) — per-agent cost was a delta against
  a global counter while agents ran concurrently.
- **Failed Apollo batches were silent**, making credit exhaustion indistinguishable from "no
  results"; and **a failed response was cached**, so a `422` replayed from disk long after the
  account was topped up.
- **The eval judge was reading the ranking agent's own prose**, which would have made Precision@20
  measure self-consistency and look excellent doing it.

### What the eval measured

Full results, the iteration log, and the remaining failure modes are in
[PHASE_AGENTIC_SCOUTING_EVAL.md](PHASE_AGENTIC_SCOUTING_EVAL.md).

The headline finding is that **discovery is not the bottleneck** — company-level precision measured
88–97% — and essentially all of the loss is in *which person inside a right company* gets
contacted.

---

## 2026-08-11 — Phase 6: Grounded research

**Type:** implementation + eval · **Behavior change:** additive; V1 and Phase 3 paths intact

Full report: [PHASE_6_EVAL.md](PHASE_6_EVAL.md)

### What shipped

- `lib/providers/web/openai-search.ts` — `WebResearchProvider` on the OpenAI
  Responses `web_search` tool, returning real `url_citation` provenance.
- `lib/research/` — company and person dossier agents emitting
  FACT/INFERENCE/UNKNOWN claims. A FACT without a resolvable source URL is
  **downgraded to INFERENCE**, and a FACT citing a URL the search never returned
  is downgraded too. Sourcing is an invariant, not an instruction.
- `lib/scouting/pipeline-v2.ts` — research-before-enrichment ordering
  ([ADR-014](ARCHITECTURE.md#adr-014)).
- Per-person enrichment index + backfill ([ADR-015](ARCHITECTURE.md#adr-015)).
- `evals/phase6/` — BAD rate@20, research coverage, fact grounding, and
  **cost per GOOD top-20 prospect**.

### Measured (consulting profile, Phase 3's worst at 15%)

| | Phase 3 | Phase 6 |
|---|---|---|
| Precision@20 | 15% | **20%** |
| BAD rate@20 | 25% | **15%** |
| Research coverage | 0% | **100%** |
| Fact grounding | n/a | **100%** (269/269) |
| Apollo credits | ~700 | **0** |
| Cost per GOOD prospect | — | **$0.98** |

Domain drift is fixed and measurable: **36 of 90 companies (40%) rejected** with
sourced reasoning before any credit was spent.

### The finding that redirects the roadmap

Research did not lift consulting precision — and inspecting why is the most
valuable output of the phase. The research is **correct** and the judge
**agrees with it**: Avid Engineers really is MEP/building systems, Semco Carbon
really is graphite machining. After removing the genuinely-wrong companies, what
Apollo can surface for US industrial consulting is largely MEP firms, ERP
implementers and restructuring shops.

**The binding constraint is candidate supply, not research or ranking.** Phase 3
could only suspect this; Phase 6 has 90 sourced dossiers demonstrating it. The
recommended next step is therefore research-led *discovery* — let the research
layer name companies and use Apollo purely for people lookup.

### Bugs found and fixed

- Batch-keyed enrichment cache made 1,373 purchased Apollo records unreachable
  whenever selection changed — silently wasting credits since Phase 3.
- Failed research dossiers were being cached, making transient errors permanent.
- Researcher JSON truncation: reasoning tokens count against
  `max_completion_tokens`.
- Company research initially rejected *Sunburst Chemicals*, a real chemicals
  manufacturer, for "lacking an AI dimension" — a false negative that would have
  gutted the corporate-innovation profile.

### Blocked

⛔ **OpenAI API credits exhausted** (`429 insufficient_quota`) partway through the
full 5-profile run. Apollo credits were already exhausted but were successfully
worked around; the OpenAI blocker cannot be. Scorer v5.0.0 and judge v1.2.0 are
implemented and committed but **unvalidated**.

### Security

The exposed Apollo key is confirmed **public on GitHub** (`e5029ca` is an
ancestor of `origin/main`; repo visibility is public). Rotation is required and
only the founder can do it — see
[SECURITY_CREDENTIAL_EXPOSURE.md](SECURITY_CREDENTIAL_EXPOSURE.md).
`my_resume.pdf` untracked and gitignored.

---

## 2026-08-10 — Phase 3: Provider abstraction + Apollo integration (eval-driven)

**Type:** implementation + eval harness · **Behavior change:** additive; V1 untouched

Full report: [PHASE_3_EVAL.md](PHASE_3_EVAL.md)

### What shipped

- `lib/providers/` — `CompanyProvider` / `PeopleProvider` / `WebResearchProvider`
  interfaces, an Apollo client (retry, rate limiting, call budget, credit
  accounting), and a content-addressed disk cache.
- `lib/scouting/` — deterministic discovery, dedupe, size-aware seniority
  calibration, junk filtering, and a relevance scorer where **the LLM emits
  components and code computes the total** (ADR-004 in practice).
- `lib/ai/models.ts` — the central model registry from ADR-008.
- `supabase/migrations/010_companies_scouting.sql` — companies as a first-class
  entity (ADR-001), provenance tables, `contacts` extensions (ADR-012).
- `evals/phase3/` — 5 search profiles, 4 deterministic checks, an independent
  LLM judge, Precision@20.
- `scripts/test-deterministic.ts` — 68 assertions over the deterministic core.

### Architecture finding: Apollo discovery must be people-first

Company-first discovery failed. Apollo's `q_organization_keyword_tags` matches
company **names** lexically, so searching "artificial intelligence + manufacturing"
returned AI magazines, certification bodies, conference organizers and
universities — and 9 queries yielded 1 usable candidate.

Applying the same keywords at the **people** search layer works, because the
title filter anchors each query to a real operating company. Recorded as
[ADR-013](ARCHITECTURE.md#adr-013).

### Entitlement finding: search rows are obfuscated

`mixed_people/api_search` returns `last_name_obfuscated`, boolean `has_email`
flags, no LinkedIn, no seniority. Search rows are identifiers only; full records
need `people/bulk_match`, which costs credits. Modeled as a distinct `PersonStub`
type so obfuscated rows can never be mistaken for prospect data.

Also: `mixed_people/search` is deprecated (422), and company descriptions are
absent from person records entirely — **0 of 140** — requiring a separate
`organizations/enrich` call.

### Eval results — 6 iterations, stopped by a real blocker

| Iteration | Change | Avg P@20 | Min P@20 |
|---|---|---|---|
| 1 | People-first inversion | 65%¹ | 65%¹ |
| 2 | + description hydration, scorer v4 | 75%¹ | 75%¹ |
| 3 | Full 5-profile baseline | 47% | 30% |
| 4 | + search rebalance, cross-profile dedupe | **44%** | **15%** |
| 5 | + priority-weighted budget, domain filter | 31%² | 0%² |
| 6 | + one person per company | aborted² | |

¹ single profile · ² invalidated by Apollo credit exhaustion

**Final status (iteration 4, the last valid full run):** all four deterministic
checks pass — data completeness 99%, duplicate rate **0.0%**, seniority
calibration 99%, resume grounding 100%. **Precision@20 does not pass**: 44%
average against a 75% threshold.

⛔ **Blocker: Apollo lead credits exhausted.** Search rows are obfuscated, so
every usable prospect costs one enrichment credit; ~700 per full run drained the
account. Iterations 5–6 are not valid measurements and iteration 6 was aborted
rather than allowed to report meaningless numbers. **Thresholds were not
weakened.**

Failure modes found and fixed: search (keyword name-matching), data (no company
descriptions — 0/140), scoring (compression from batching in discovery order),
profile match (adjacent-but-off-mission verticals), company (wrong end of each
size band), dedupe (cross-profile collisions, 6% → 0%), budget (enrichment spent
on the first queries only — and the over-correction that regressed profile 1
from 65% to 35%), product-rule violation (7% of top-20 slots on a second person
at the same company).

Diagnosis of the residual gap: 25% of non-GOOD verdicts cite thin company
information; the larger share is domain drift in Apollo's noisy consulting
keyword space. The first is what Phase 6 fixes.

### Bugs the tests caught

- `normalizeLinkedIn` stripped the trailing slash **before** the query string, so
  one profile produced two dedupe keys — a silent threat to the duplicate threshold.
- "Technical Recruiter" survived the irrelevant-function filter because the
  override term `technical` rescued it. Split into hard- and soft-excluded functions.
- A cache-key bug: `JSON.stringify(payload, sortedKeys)` uses the array argument
  as a recursive property **allowlist**, not a key sort, collapsing all nine
  search queries onto one cache entry.

### Security

`Apollo API.txt` — a committed credential-shaped string — untracked and
gitignored. **The key still needs rotating**, and history still contains it.

### Not done

Migration 010 is **not applied** (migrations are manual per CLAUDE.md).
`lib/scouting/persist.ts` degrades gracefully until it is.

---

## 2026-08-10 — Phase 0: Repository audit and V2 architecture

**Type:** documentation + type-only scaffolding · **Behavior change:** none

### What happened

Audited the V1 codebase and designed the V2 agentic architecture. No existing file was
modified; no runtime behavior changed. `tsc --noEmit` clean before and after.

### Audit findings that shaped the design

1. **No company entity.** `contacts.company` is free text. The V2 pipeline is company-first,
   so this was the single largest structural gap. → [ADR-001](ARCHITECTURE.md#adr-001)
2. **Research is ungrounded.** `lib/ai/research.ts` queries the model's parametric memory;
   ~40% of its system prompt is anti-hallucination instruction, with no source of truth to
   check against. No web-search capability existed anywhere in the codebase.
   → [ADR-006](ARCHITECTURE.md#adr-006)
3. **The installed OpenAI SDK is 4.104.0**, not the `^4.52.0` in `package.json`, and it
   exposes the Responses API with the `web_search` tool. This settled the web-research
   provider question with no new vendor.
4. **Long work runs inline in HTTP handlers** with `maxDuration = 300` and sequential model
   calls. This already shipped as a bug (`f6e4bb7`). → [ADR-005](ARCHITECTURE.md#adr-005)
5. **The résumé is dumped wholesale** into every generation prompt, sliced to 2000 chars,
   with selection left to the same call that writes the email. → Talent KB + retrieval
6. **Scoring is one opaque float** with no components and no configurable weights.
   → [ADR-004](ARCHITECTURE.md#adr-004)
7. **The email layer is excellent** — narrow OAuth scopes, encrypted tokens, correct MIME,
   working threading, idempotent reply sync with backfill. Preserved unchanged.
   → [ADR-007](ARCHITECTURE.md#adr-007)
8. **The Resend surface is dead** — the webhook is unreachable, and its signature verifier
   returns `false` unconditionally. `lib/email/resend.ts` actually sends via Gmail.
9. **`/dashboard/drafts` is already an approval queue** with edit, multi-select, and
   approve-all. V2 extends it rather than replacing it.
10. **⚠ `Apollo API.txt`** — a 22-byte credential-shaped string tracked in git. Flagged for
    founder action; not remediated automatically because history rewriting is destructive.

### Decisions recorded

Twelve ADRs in [ARCHITECTURE.md](ARCHITECTURE.md). The ones that materially change the
product:

- **ADR-001** — companies become first-class
- **ADR-002** — missions replace the hardcoded goal enum
- **ADR-004** — the model judges component scores; code computes the weighted sum
- **ADR-005** — durable Postgres task rows advanced by an idempotent worker tick, rather
  than a queue service or long HTTP handlers
- **ADR-006** — grounded research via a `WebResearchProvider`
- **ADR-010** — evals gate outbound mail but never silently discard a draft
- **ADR-011** — claim citation makes hallucination a foreign-key problem

### Where the spec was deliberately not followed

- **One `talent_items` table, not four** (`experiences` / `projects` / `skills` /
  `proof_points`). They share a lifecycle, tagging dimensions, and exactly one retrieval
  path. Four tables would mean four queries and a `UNION` for no gain.
  → [ADR-003](ARCHITECTURE.md#adr-003)
- **No `people` table.** `contacts` already is the person entity, with RLS, a unique index,
  and six screens on it. → [ADR-012](ARCHITECTURE.md#adr-012)
- **`meetings` and `referrals` are outcome types, not tables.** Separate tables would
  fragment the analytics they exist to serve.
- **`mission_preferences` is a column, not a table.** Always read with its mission; never
  queried independently.

### Delivered

```
docs/CURRENT_STATE.md          How V1 works today
docs/PRODUCT.md                V2 product definition and North Star
docs/ARCHITECTURE.md           Target architecture + 12 ADRs
docs/PIPELINE.md               13-stage state machine
docs/AGENTS.md                 7 agents: inputs, outputs, boundaries
docs/DATA_MODEL.md             10 new tables, 4 extended, 3 dropped
docs/EVALS.md                  Gate evals for outreach, research, ranking, positioning
docs/IMPLEMENTATION_PLAN.md    11 phases with dependencies and risks
docs/BUILD_LOG.md              This file
CLAUDE.md                      Conventions for future sessions
README.md                      Orientation

lib/providers/types.ts         Provider interfaces (types only)
lib/providers/registry.ts      Availability + feature flags
lib/agents/types.ts            Agent contracts (types only)
lib/pipeline/types.ts          Run and task state (types only)
lib/scoring/types.ts           Scoring contracts
lib/scoring/weights.ts         Default weights + per-mission resolution
lib/scoring/compute.ts         Pure weighted-sum arithmetic — first real V2 code
```

`lib/scoring/compute.ts` is implemented rather than stubbed because it is pure arithmetic
with no dependencies — the cheapest possible demonstration of the ADR-004 boundary.

### Next

Phase 1 — missions and preferences. Independent of Phases 2 and 3; any order works.
