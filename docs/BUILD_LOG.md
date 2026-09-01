# Build Log

Concise summaries of meaningful implementation changes, newest first.
One entry per phase or per significant change. Not a commit log — a record of what changed
architecturally and why.

---

## 2026-09-01 — Package generation always terminates

**Type:** incident fix · **Behavior change:** a hard 5-minute SLA, enforced at four levels.

### The incident

A Rondo Energy package read `status='generating'`, `stage='intelligence'`,
`cost_usd=$0` for over a day. Its run row: `kind='package'`, `status='running'`,
`heartbeat_at=NULL`, `completed_at=NULL`. Four sibling packages started in the same minute
finished in ~4 minutes.

### Three root causes, all real, all needed

1. **Package runs could never be reaped.** `run-reaper.ts:53` skipped every run whose
   `kind !== 'job_scout'`, and `run-record.ts:155` returned `false` for a pulseless non-scout
   run. A dead package run was *structurally invisible* to the only recovery mechanism.
2. **The package row had no liveness.** No heartbeat, no deadline, no attempt count.
   `'generating'` was only ever changed by the process that set it.
3. **The declared deadline was never enforced.** `DEFAULT_PACKAGE_BUDGET.deadlineMs` was
   already 280 s — read only by the scout orchestrator.

And the multiplier that turned "slow" into "days": `anthropic/client.ts` retries a failed call
**4×** at a 120 s timeout, and an SDK timeout throws with `status === undefined`, which its
policy treats as transient. One logical LLM call is worth **8.2 minutes**; a package makes up
to 76 of them. Measured worst case: **10.5 hours**, against a route promising 300 s. The client
*has* a deadline check — `setAnthropicDeadline` — whose only caller was the scout.

### The fix, at four levels

| level | what it bounds |
|---|---|
| `deadline.ts` | one absolute clock; per-stage ceilings; a finalize reserve; a 60 s floor under optional retries |
| `auto.ts` | `try/catch/finally` — a terminal status is written on **every** exit path; arms the provider deadline |
| `client.ts` | the deadline is a **set**, not a slot (batch runs were clearing each other's); truncation is no longer retried identically |
| `liveness.ts` / `recover.ts` | a stale package is finalised **on read**, not only by a cron |

Research is bounded at 105 s and **degrades to the job description** rather than blocking.
Documents are not started under 60 s left — the résumé patch is saved and a retry finishes it.
Intelligence's three branches (research→fit ∥ match ∥ paths) now run concurrently: only one
data edge is real, and their cache keys and writes are disjoint.

### Measured

```
5 stuck packages recovered, Rondo among them
Rondo cold      stopped at exactly 300.0s, NEEDS ATTENTION   (was: 3 days)
Rondo warm      READY TO APPLY in 20.3s
Medtronic cold  292.9s -> 271.8s after parallelisation, complete package
Abbott cold     244.9s, resume saved, documents deferred with 55s left
```

Intelligence fell from 292 s to 213 s on the same cold shape. The test that asserted
*"a package run is untouched (different kind)"* was asserting the bug; it now asserts the fix.

`tsc` clean · `test:career` 37/37 · `check:sql` clean · `next build` clean.

---

## 2026-09-01 — One click from a job to a ready-to-submit package

**Type:** productization · **Behavior change:** the package flow stops asking permission for
decisions code has already made.

### What was actually wrong

Every safety check already ran automatically. What did not run was ACTING on the result. The
flow stopped at `resume_review` and needed four more clicks:

```
Generate → Approve all safe → Approve résumé & build documents → Approve letter → Finalize
```

`safeToApprove` is `pending && SUPPORTED && edit_level <= 3` — a deterministic predicate, not a
judgement. Pressing it was ceremony. Same for finalize, which mostly checked that a letter which
had already passed `gateCoverLetter` had also been clicked.

### What changed

`generateCompletePackage` runs the lot and answers **READY TO APPLY** or **NEEDS ATTENTION**.
`assessPackage` is the pure decision, read from the SAVED rows rather than a run's return value,
and the package UI imports the same function so the badge cannot disagree with the status.

**Nothing was relaxed.** Fact Verifier, precheck, grounding gate, blocking document QA, and the
human yes for a Level-4 new bullet all still decide. Four clicks removed, zero checks removed.

### An adversarial review of this change found four holes; all are fixed

1. **The one-page gate was keyed on a rendered page count**, so a DOCX-only run disarmed it end
   to end *and* QA reported "passed". Fixed with an argument that survives without a renderer:
   QA already proves fonts, sizes and `sectPr` are identical to the one-page master, so a body
   no LONGER than the master cannot need more pages. `one_page_safe` blocks when the text grew
   and nothing rendered.
2. **A Level-4 bullet that passed every gate stayed `pending` for ever** — uncounted, invisible
   in a finished package, and unapprovable once the status moved on. The one class automation
   may not decide was the one class nobody was asked about. Now `change_needs_your_yes`.
3. **A letter DOCX can exist while its row does not.** The read error was dropped and a missing
   row read as "no letter", so the grounding verdict was never consulted. Now
   `letter_row_missing`.
4. **Per-change persist failures** went to `r.errors` while `r.error` stayed null, so the
   summary could claim changes the document does not contain.

### And the live run found a fifth

A five-job batch produced a Solid Power package whose résumé DOCX was built, stored and passing
every QA check, and whose cover-letter writer then stopped without calling `submit_result`. The
package was recorded **`failed`** and the usable résumé was unreachable. Most applications do
not require a cover letter at all. A letter failure is now `letter_failed` — an attention item
beside an intact résumé — and `missingArtifacts` takes `letterExpected`.

Re-run after the fix: **READY TO APPLY in 92.7 s for $0.43** (intelligence was cached).

### Measured — five real jobs, batch, concurrency 2

```
3 ready automatically · 2 needed attention · 0 failed        $5.7577 · 825 s wall
  Kairos Power   Nuclear Engineering Intern   READY   $1.12  325 s
  Solid Power    R&D Intern (Catholyte)       letter writer died → fixed, now READY
  Freeform       Process Engineering Intern   1 new bullet needs a yes  (correct)
  Solcoa         Metallurgical Eng Intern     READY   $0.56  163 s
  Anduril        2027 Manufacturing Eng       READY   $1.19  325 s

approval clicks on a successful package: 0
unsupported claims in final documents:   0
blocking DOCX QA failures:               0
```

Freeform is the interesting one: the tailor produced a **Level-4 new bullet that passed
verification** — the first `new` change seen in production — and before finding #2 it would have
vanished silently into a package marked ready.

### Also

DOCX is the default output (`renderPdf` opts a PDF in). Batch generation at concurrency 2 with a
hard cap of 25. A **Best opportunities** view — open, not dismissed, not already applied, fit
first with freshness a bounded tiebreak. `redoPackage` was deleted rather than left as a second
path that would quietly reintroduce the four clicks. The `READY_TO_APPLY` audit event records
actor `system` on this path, because no user pressed anything.

**External applications are still never submitted. The last action is still a link.**

`tsc` clean · `test:career` 36/36 · `next build` clean.

---

## 2026-08-31 — Résumé tailoring: the objective reverses

**Type:** agent behaviour (prompt 2.0.0) + migration 018 + eval rename ·
**Behavior change:** the tailor argues for the role instead of minimising the diff.

### Measured before anything was changed

The spec said "do not guess — measure where the changes disappear". Over the 14
patches already in the database, for $0:

```
proposed              32          types used:  reorder 17 · reword 15
fact-verified         32                       swap 0 · new 0 · remove 0
reached the document  24          no-op:       4/14 patches (29%)
                                  cosmetic:    15/15 rewords (>80% overlap)
```

Of the six candidate causes, **B** (verifier rejects) is ruled out — it rejected
nothing. **E** (representation cannot express it) is ruled out — `change_type`
has accepted `swap/new/remove` since migration 014, and so does the agent schema.
**C** is not the leak: 24 of 32 reached the page and the rest were `pending`.

It was **F**, plus a budget that agreed with it. The prompt opened *"with the
smallest truthful set of changes"* and ranked swap/new last, *"in a rare case"*,
under caps of 6 / 1 / 0.25. Every reword it produced looked like this:

```
- Screened 40+ configurations using 73k CPU-hours of ASE/VASP.
+ Screened 40+ configurations using **73k CPU-hours** of ASE/VASP.
```

### What changed

Prompt **2.0.0**: maximise role relevance subject to 100 % evidence-backed
factuality; a smaller diff is not better; the Evidence Bank, not the master, is
the factual universe; decide the **hiring argument** and the employer's **role
themes** before writing any text; a no-op carries a burden of proof.

Budgets 6 → 14 non-reorder, 1 → 3 new bullets, reword fraction 0.25 → 0.6.
**This trades nothing away** — factuality was never the binding constraint. The
Fact Verifier, `validateChangeShape`, the precheck and the ownership audit are
untouched, and case C of the eval still requires a near-empty patch.

New measurement, because edit distance cannot tell a re-argued bullet from a
bolded number: `classifyChange` splits reword into `rewrite` and `emphasis`, and
only reorder/rewrite/swap/new/remove are **meaningful**. Role-theme coverage is
computed over evidence-**supported** themes only — counting the rest would make
coverage a number the résumé could raise only by claiming things.

### Migration 018, applied by hand like all the others

Stores the argument, themes, counts and coverage. `insertResumePatch` writes the
full row and, on "column does not exist", retries with the pre-018 row and
reports the degradation — losing a package someone just paid for because a
migration has not been pasted in yet is the wrong trade every time.

### The eval was part of the problem

`minimal-edit` scored restraint, and its own recorded result was the evidence:
case A passed with three changes that were all emphasis-only, and case B's
planted alternate bullet went unused — EVALS.md said so in words. Renamed to
`tailoring` (`npm run eval:career-tailoring`) and re-scored: A must not regress
coverage, B needs **≥ 3 meaningful changes**, C is unchanged. It has not been
run — it costs money.

### The other half of the end-to-end guarantee

`content_match` already proved approved bullets reach the DOCX and the PDF. The
opposite failure had no check: refused text printed anyway. `no_rejected_text`
now fails the QA report if any of it appears, tested in both directions.

### Still open

The package UI, the three-archetype acceptance test, and the baseline run over
8–10 real jobs — the last of which costs money and is the founder's call.

`tsc` clean · `test:career` 32/32 · `check:sql` clean.

---

## 2026-08-31 — Wave 2 sources go live, and the benchmark stops crediting itself

**Type:** discovery coverage + eval integrity · **Behavior change:** the registry ships
**14 sources (13 configured)** instead of 6, and the recall benchmark measures Oracle boards
it previously listed as unreadable.

### The six adapters were built but not wired

`oracleOrcSource`, `taleoSource`, `recruiteeSource`, `gemSource`, `teamtailorSource` and
`personioSource` existed, had passing suites, and were reachable from nothing —
`discoveryRegistry()` still returned the wave-1 six plus Simplify. They are now in
`v2DiscoverySources()`, and the registry reports:

```
ats (12, all free, no key)  greenhouse lever ashby smartrecruiters workable workday
                            oracle-orc taleo recruitee gem teamtailor personio
feed (1)                    simplify
search (1)                  dataforseo — unconfigured, needs DATAFORSEO_LOGIN
```

### The eval caught the wiring, which is what it was for

`configuredPlatformDrift()` failed the moment the registry changed —
*"shipped-but-unscored: gem, oracle-orc, personio, recruitee, taleo, teamtailor"* — and named
its own fix. Rather than widen the constant and move on, the six platforms were registered
**and** the corpus was extended with live evidence.

### The Oracle coverage gap was real, and is now closed

The benchmark recorded three Oracle boards as unreadable (Honeywell 697 postings, Vertiv
1041, CSX 13) because the probe could not get a requisition list out of them. The shipped
adapter can: **limit and offset go inside the finder string.** All three answered on
2026-08-31. Sweeping the Oracle tenants named by the Simplify file — free tenant discovery —
returned **40 live internships across 46 employers**, including DNV's *Process Safety Risk
Intern*, Howmet, Cummins, Emerson and onsemi. None of them were visible to any wave-1 source.

Eight of those postings are now benchmark entries (corpus **44 → 52**, 29 companies), and CSX
— previously a gap — turned out to hold nine paid Summer 2027 internships.

### Two truths that had rotted

- The report's closing caveat named *"3 Oracle boards"* in prose with only the count
  interpolated, so once the gap closed it printed **"3 Oracle boards reported 0 postings that
  no configured source can read"**. It is now computed from `coverage_gaps`, with a different
  sentence when the list is empty.
- `UNADAPTED_REASONS` still said *"no Oracle Recruiting adapter exists"* and *"no Taleo
  adapter exists"*. Both were deleted; Phenom and iCIMS remain, because both are still true.

### A test that had frozen the registry's shape

`test-career-coverage.ts` asserted *"the live registry wraps all six ATS adapters"* and
*"every ATS is configured with no key"* via `unconfigured().length === 0`. Both failed
correctly. The count assertion was the wrong invariant — registry drift is already the recall
eval's job — so they were replaced with the two properties the product actually depends on:
**every ATS adapter is free and needs no key** (a board that starts demanding one silently
narrows discovery to whoever paid), and **every unconfigured source names its env var**
(ADR-008 skips it, so the founder must be able to act on it).

### Results

```
recall (reachable corpus)      100.0%   50/50          >= 90%     PASS
reachable share                96.2%    50/52          >= 90%     PASS
platform drift                 12 adapters, in sync               PASS
corpus size                    52 entries, 29 companies           PASS
unique companies in top 50     25                     >= 20       PASS
largest single company         AMD 6/50 (12%)         <= 25%      PASS
areas in top 50                8 of 8                 >= 5        PASS
surfaces in top 50             3                      >= 2        PASS
closed shown as open           0                      == 0        PASS
```

`npm run test:career` 32/32 · `npx tsc --noEmit` clean · `npx next build` exit 0.

### New: `npm run career:stats`

Read-only inventory — totals, verification status, source surface, ATS, company
concentration, freshness, recent runs. Written because "how many jobs do I have?" was being
answered by scrolling the Jobs page, which counts what the page chose to show. It reads a
live database honestly, and the first thing it reported is below.

### What the live database still says

**284 jobs, 276 open, 34 companies** — the >200 target is met. But **GE Vernova is 107 of 284
(38%)**, the exact concentration the audit flagged, and the source breakdown is
workday/greenhouse/lever/ashby only. Every wave-2 source has contributed **zero live rows**,
because wiring them changes what the *next* run can reach, not what past runs stored. The
benchmark's 12% is what a run over the new sources looks like; 38% is what the stored
inventory looks like. Closing that gap needs a fresh scout, which costs money and is the
founder's call.

---

## 2026-08-31 — Geography stops being a built-in preference; direction becomes a dial

**Type:** architecture (ADR-042) + migration 017 · **Behavior change:** the product ships no
city, no coastal tier and no `location` in `optimize_for`; "where" is a three-way choice the
user makes; a stated direction says whether it boosts the search or restricts it.

### What was actually wrong

The default mission put "San Francisco / Bay Area" and "New York City" in geography tier 1
and four coastal cities in tier 2 — and said the same thing four more times: in the objective
prose, in `optimize_for`, in six weighted `location` rows seeded into `evidence_preferences`,
and in `fallbackStrategies()`, which appended a tier-1 city to every deterministic query.
`locationTier()` then stamped a tier on every posting so ranking could score it. The founder's
own stated direction read *"I don't care about location or which company"*. A preference the
product invented was outranking the one the user stated.

### What changed

- **`lib/career/missions/preferences.ts`** (new, pure, no value imports) — the two dials and
  their resolvers: `missionLocations`, `locationHardFilter`, `rankingGeoTiers`,
  `geoTiersForLocations`, `missionDirectionMode`, `withoutPlacePreferences`. Split out of
  `types.ts`, which was 1016 lines against CLAUDE.md's ~400 rule; `types.ts` re-exports
  everything so no import path changed.
- **Three named location behaviours** — `anywhere` (ships as the default: no city anywhere),
  `prefer` (ranking only), `only` (a **real** hard filter: `locationOnlyConstraint()` writes a
  `location_tier` constraint onto the mission, and `applyHardConstraints()` enforces it before
  fit is scored). `reconcileLocationConstraints()` keeps the derived rule in step with the dial
  on every patch, and never touches a constraint a person typed.
- **Direction is a mode** — `boost` (default whenever a direction is set) or `exclusive`.
  Derived, never stored as `off`. `renderMission()` states the mode in words; no direction
  renders as "explore broadly from the evidence".
- **`locationTier()` returns `null` on an empty tier table.** It used to fall through and stamp
  every US posting tier 3, which reached ranking as a penalty and the fit prompt as
  "(mission geography tier 3)" — geography reasserting itself under a mission with no opinion.
- **`withoutPlacePreferences()`** strips `location` rows (and `optimize_for: location`) out of
  the Evidence Bank block in both prompts, so one user message can never say "no place
  preference" and "location: San Francisco / Bay Area (weight 1)" at once. A `[HARD]` row a
  person typed is left alone.
- **Prompts bumped** — planner `1.4.0`, fit evaluator `1.3.0`, and evidence matcher `1.1.0`
  (its user message renders the job through the fit prompt's `renderJobForPrompt`, which
  changed; ADR-009 is about what the model saw, not which file the edit landed in).
- **UI** — the Mission page offers "Anywhere in the US / Prefer these places / Only these
  places" and refuses to save either non-neutral choice with nowhere to point; the Jobs page
  now actually renders, saves and dirties the "Search harder for this / Only show me this"
  choice, and hands the Scout panel the resolved mode so a paid run cannot start without
  saying "Scouting for **ONLY**:" when it will hide things.

### Migration 017 — migrate what shipped, flag what a person wrote

`career_missions.preferences.geo_tiers`, the objective, and the six seeded
`evidence_preferences` rows are replaced **only when byte-identical** to what shipped.
`isShippedPreV2Geography()` and the SQL `where … = '[…]'::jsonb` are the same predicate twice;
`scripts/test-career-mission.ts` parses the literal out of the `.sql` file and feeds it to the
TypeScript one so they cannot drift. Anything edited gets a **suggestion** in the new
`mission_migration_notes` jsonb, which the Mission page shows with a Dismiss button. Because
that array is dismissible it cannot be the "have I run yet?" guard, so a second column,
`mission_migrations_applied`, is the durable ledger — written only by migration SQL, unknown to
`sanitizeMissionPatch`. Re-running the file is a genuine no-op. **Not yet applied.**

### Tests

`scripts/test-career-mission.ts` (new, offline, ~150 checks): the shipped default names no
city and no coastal language; `prefer` never filters and `only` does; the three renders differ;
a stale tier table is suppressed under `anywhere`; the SQL and TypeScript predicates agree; the
call sites really pass the dial through (the "Scouting for ONLY:" warning passed as a unit test
for a whole review cycle while the panel called it with one argument). Fixtures in
`test-career-jobs`, `test-career-scout` and `test-career-discovery-agents` were updated — the
prompt-version pins there are now `atLeast(...)` rather than equality, so the next honest bump
in another workstream does not turn the gate red. `npm run test:career`: 23/23 suites pass.
`npx tsc --noEmit`: clean.

### Left undone, deliberately

Seven call sites still pass `mission.preferences.geo_tiers` into `buildNormalizedJob()` rather
than `rankingGeoTiers(...)`; two of them are in `lib/career/scout/`, owned by another
workstream in flight. The write path clears tiers under `anywhere` and an empty table is now
inert, so the invariant holds — but a row written outside the API could still hold both.
`fallbackStrategies()` (also scout-owned) reads tier 1 directly, which is harmless under the
neutral default and would narrow queries under `prefer`.

---

## 2026-08-31 — A run is a mode, a ceiling and a cursor (not four sliders and a counter)

**Type:** architecture (ADR-041) · **Behavior change:** the Jobs page offers three run
modes and one spend limit instead of four sliders; a run stops when its sources stop
producing anything new, when its money runs out or when its clock does; and a run that
stopped short can be continued instead of started again.

### What was actually wrong

The audit measured 284 postings from 34 companies, 37 extracted, 27 ranked — and the
binding limits were not supply. `targetCount: 12` per strategy (scout/stages.ts) and
twelve jobs given a fit evaluation were the product's ceiling: a $4 run returned twelve
jobs however much the market held. Nothing bounded what a run could spend. Nothing let a
run that hit Vercel's 300-second function ceiling continue rather than restart.

### The three pieces

- `lib/career/discovery/modes.ts` — QUICK · BROAD · EXHAUSTIVE as declarative budgets.
  Pure objects: no behaviour, no I/O. A caller that names no mode gets `LEGACY_BUDGET`,
  which keeps today's numbers **and** today's absence of a ceiling, so the CLI, the eval
  and the offline suites are unchanged until they opt in.
- `lib/career/discovery/budget.ts` — a spend ledger asked *before* each paid stage and
  reconciled against the run's own trace afterwards, plus `saturated()`: a pure function
  over marginal unique yield. A productive strategy is never cut off; one that adds almost
  nothing new twice in a row ends the loop.
- The task cursor (`ScoutCursor` in `scout/run-dispatch.ts`) — stages, strategies and
  companies done, the plan already paid for, dollars and milliseconds already used —
  persisted on the run row by the worker as it works, and read back by
  `POST /api/career/scout { continueRun }`.

### What the review caught, and what it cost

Two blockers, both the same shape: the pieces existed and the product could not reach
them.

1. The durable worker — the only executor the Jobs page ever uses — built the
   orchestrator's argument object by hand and omitted `mode`, `maxSpendUsd` and `cursor`.
   Every web run therefore executed the legacy budget with no ceiling at all, whichever
   card was pressed and whatever number was typed into "Spend at most". It now maps the
   row through `toJobScoutParams`, the one function every executor shares.
2. Nothing wrote a cursor to a run row, so "continue" re-planned, re-swept and re-executed
   every strategy at full price while reporting "nothing done yet". `recordRunCursor`
   patches the row while the run is alive and once more at the end, and `readRunCursor`
   also reads the copy the orchestrator's own report leaves in `stats.discovery`.

Also fixed: a budget stop was recorded as `succeeded` (a green run that in fact ran out of
money); `LEGACY_BUDGET` had silently inherited BROAD's 40/40 counts on the one path with
no ceiling; `attempts` was incremented twice per continuation; a posted ceiling was
clamped to $1000 and echoed back while $100 would be enforced; a saturated run reported
itself resumable when saturation is the *good* ending; and the mode's runtime is now a
real bound across invocations (`cursor.elapsed_ms`) rather than a sentence in the UI.

### Honest limits

Saturation is applied at STRATEGY granularity. `maxPagesPerSource`, `maxQueryFamilies` and
the cursor's `pages`/`families` are declared and persisted and consumed by nothing yet —
per-source pagination and query-family planning are the next workstream's. `usePaidSources`
is a declared constraint with no paid provider to constrain today, and the UI copy claims
nothing more than the ceiling. The mode cost estimates ($0.25–0.75 / $4 / $15) are
estimates: no live run was made.

**Files:** `lib/career/discovery/{modes,budget}.ts` · `lib/career/scout/{orchestrator,
stages,run-dispatch,run-report,rank-stage,run-store,run-record}.ts` ·
`app/api/career/scout/{route.ts,worker/route.ts}` · `app/dashboard/jobs/{ScoutPanel.tsx,
run-copy.ts}` · `scripts/test-career-modes.ts` (95 offline checks).

---

## 2026-08-31 — Inventory stops being capped by what we can afford to read

**Type:** architecture · **Behavior change:** the watchlist is swept in full for
free, postings are stored without being extracted, relevance is computed on read,
and a slow PDF converter no longer claims to be a missing one. Measured: **43
postings → 174, in 107 seconds, at $0.00.**

### The two ceilings

The founder asked for "over 200 postings at any given time" against an inventory
of 43, "not all of them remotely relevant". Neither number was a tuning problem.

**Ceiling one: five adapters.** Greenhouse, Lever, Ashby, SmartRecruiters and
Workable were the entire discovery surface. `registry.ts` *recognised*
Workday/iCIMS/Taleo/SuccessFactors URLs as families but had no adapter, so every
company on one answered "no public board detected" — and those are exactly the
employers a chemical engineer wants: Illumina, 3M, ExxonMobil, Intel, Amgen,
Medtronic, Abbott, GlobalFoundries, Marathon. 126 of 188 watchlist companies had
never been checked at all.

**Ceiling two: a posting could not exist until it had been read.** Extraction is
one model call per posting and is capped at ~40 per run, so INVENTORY was capped
at ~40 per run. The pipeline could not store what it could not afford to analyse.

### What changed

- **A Workday adapter** (`lib/career/sources/workday.ts`) over the public `cxs`
  JSON board: paginated, robots-respecting, `tenant/wdN/site` round-tripping
  through `ats_identifier` because a Workday board needs all three to address.
  Detection now also follows a careers page to the tenant it redirects to.
  **18 of the 91 boards a live sweep read came through it.**
- **The sweep** (`lib/career/jobs/sweep.ts`, `npm run career:sweep`,
  `POST /api/career/sweep`, a daily cron): every company with a readable board,
  listed and normalized deterministically, with bounded concurrency, per-company
  error isolation and incremental persistence. **No model calls at all.**
- **Deferred extraction.** A posting persists from its listing alone — title,
  company, location, canonical URL, posted date, ATS ids — with the extracted
  columns null. Extraction became a separate, bounded, relevance-ordered step
  (`extraction-store.ts`), so spend follows relevance instead of arrival order.
- **Relevance at read time** (`relevance.ts` + `inbox-relevance.ts`): a
  deterministic score against the stated direction, role families, season and
  tier, computed when the list is read — so changing the direction re-ranks
  everything with no data change and no migration. The inbox header owns what it
  hides ("312 postings · 47 strong · showing 47 — 265 off-direction hidden"), and
  a thin row says it has not been analysed rather than faking empty fields.

### A regression the change surfaced

`resolve.ts` guarded on `ats === 'other'` to decide whether to read a recognised
board's page. The moment Workday became a known `AtsType` that guard stopped
matching Workday, and a Workday posting URL fell through to the generic
web-page path, losing its board reference. The condition was never "is it
other" — it was "do we have an adapter for it", which is what it now asks.

### The PDF converter

`selectPdfRenderer()` returns `word-com` on the founder's machine and a real
render of the master résumé succeeded — in **106 seconds**, against
`RENDER_TIMEOUT_MS = 90_000`. The timeout was then reported as *"no PDF renderer
available (install Microsoft Word or LibreOffice)"*: install advice for software
that was running. `renderDocxToPdf` now answers with `ok | no_renderer | timeout
| failed`; only the absent case names software to install, a timeout says the
DOCX was produced and a retry is the remedy, and `status.ts` gives a slow
converter its own headline. The DOCX survives all of it.

### Measured

A dry-run sweep of all 188 companies read **91 boards** and found **173
postings in 109 s at $0.00**; the real sweep left **174 canonical rows** (166
VERIFIED_OPEN, 140 not yet extracted) across 31 companies — up from 43. 102
companies still have no readable board (robots-disallowed, or an ATS with no
adapter); they are named in the sweep report rather than silently dropped.
23 offline suites pass; `tsc` and `next build` clean.

---

## 2026-08-30 — Scout explores; the company list is memory, not the search universe

**Type:** architecture · **Behavior change:** the planner and the scout can no longer create a
preference. Every company they propose is a **suggestion** the founder promotes (or does not);
a scout run is a durable row that survives a refresh and persists what it finds as it finds it;
and a run's own results are a page rather than a claim. Migration `016`. ADR-039, ADR-040.

### What was wrong

`seedWatchlistFromPlan` wrote every planner-invented company as `watch_status: 'target'` — the
value the Companies page defines as *"you want to work here — checked first, every scout run."*
On the live database that was **160 targets, none of them the founder's**, and a loop that fed
itself: guess → preference → priority → more results from that guess. Two smaller faults hid in
the same column: a board check with an opening **overwrote** the user's intent with
`opening_available`, and `watch_priority` was read descending by the store and the scout but
ascending by the Companies page. Meanwhile the browser scout was one 300-second HTTP request:
shallower than the CLI by construction, lost on a refresh, and — when it timed out — the panel
said the jobs were "already in the list", where the inbox's default filters hid the unverified
ones.

### Intent, and only a person writes it

`watch_status` now means **target · watching · suggested · ignored** and nothing else; openings
live in `open_roles_count`. `lib/career/companies/intent.ts` holds the rule in one place —
`resolveAgentIntent` lets an agent land exactly one value (`suggested`) and never touch a row
the user owns, including `ignored`. Migration 016 demoted the 160 (plus one `watching` a board
check had written, which the attribute learner was already reading as *"chose: Redwood
Materials"*), leaving `watch_source = 'user'` rows alone — the only reliable record of a choice.
`markCareersChecked` no longer writes intent at all. Priority is one direction everywhere,
asserted by tests.

Discovery is budgeted rather than list-driven: `selectCompaniesToCheck` takes every Target, then
Watching, then a **rotating least-recently-checked sample** of Explore capped at a share of the
run — and hands the unused slots back to market discovery instead of re-checking old guesses.
The planner (prompt **1.2.0**) receives the four groups separately plus `learnCompanyAttributes`
— the company types, industry tags and names behind the founder's own promotions and job
verdicts — and is told seeds are exploration candidates that will be stored as suggestions, that
Explore is its own earlier guessing and therefore weak evidence, and that a plan which only
re-proposes known names has failed.

### A run is a row

`POST /api/career/scout` **enqueues** (`status='queued'`, params, a single-use claim token) and
answers in about a second; `POST /api/career/scout/worker` claims by token — so a duplicate
dispatch cannot spend twice — runs the same orchestrator the CLI runs, and writes `stage`,
`heartbeat_at` and a bounded `progress` payload as it goes. `GET /api/career/scout/runs/[id]` is
the only progress source, so the panel survives a refresh, a closed tab and a navigation. The
worker takes Vercel's ceiling when deployed and the CLI's deadline when not, which is what makes
a local browser run as deep as `npm run career:scout`.

The orchestrator now **persists incrementally** — extract, cluster, verify and store after
company-first and after each strategy — and records every job a run touched in
`scouting_run_jobs`, including ones it re-saw, which `discovery_run_id` could never express. A
run that dies keeps what it already paid for, finishes as `partial`, and links to it.
`/dashboard/jobs?run=<id>` shows exactly that run **without the inbox's defaults**, beside the
curated inbox rather than replacing it.

**Death is detected, not assumed.** `isRunStale` calls a run dead only when it is *both* silent
and past the deadline it was claimed with (one live planner call took 226 s — a pulse-only
reaper would close healthy runs). A scout run with no pulse at all is judged on `started_at`
instead, because a pre-016 row and a synchronous-fallback run whose request died will never
heartbeat: without that, five real runs sat at `running` forever, one of them holding 11 jobs.
The reaper runs on poll, on enqueue, and now in the daily cron, so a run that dies while nobody
is watching still resolves.

### Verified against the migrated database

18/18 schema checks (no agent-written target survives, no `opening_available` row, openings
preserved as state, `scouting_run_jobs` backfill complete, constraints reject invented values)
and 24/24 live behaviour checks: the enqueue → claim → progress → partial lifecycle, a second
claim refused, status surviving a fresh read, a run view showing two `UNVERIFIED` jobs the inbox
hides, an agent's `target` write landing as `suggested`, and the reaper both leaving a quiet
in-deadline run alone and closing a genuinely dead one. The five orphaned legacy runs were then
reaped for real: one `partial` (11 jobs), four `failed`.

20 offline suites pass (`test:career-companies`, `test:career-scout-run` and `test:career-tmp`
are new); `tsc` clean; `next build` clean.

---

## 2026-08-30 — Documents build in a real runtime, and a failure says where it actually failed

**Type:** bug fix + honesty pass (workstream W5 of the scout-durability redesign) · **Behavior
change:** package document generation no longer depends on the repo being the working
directory; a failed package reports the stage that was running and offers a retry that reuses
what was already paid for. No prompt change, no migration, no schema read added.

### Why

`lib/career/documents/pdf.ts` exported `TMP_DIR = path.join('.career-out', 'tmp')` — a
**relative** path — and `resume.ts` did `mkdirSync(path.join(TMP_DIR, 'pkg-…'))`. In any
runtime whose working directory is not the repo that is `ENOENT: no such file or directory,
mkdir '.career-out/tmp/pkg-…'`, raised *after* research and tailoring had been charged and the
founder had approved the résumé changes. Two things then made it worse: the failure path wrote
`stage: pkg.stage` — the stage read *before* the work started — so the UI said "failed during:
Waiting for your review" about a mkdir inside document generation; and the raw ENOENT was the
whole message, arriving one click after the approval, reading as though the approval caused it.

### What changed

- **One temp abstraction** (`lib/career/documents/tmp.ts`, already written; now the only
  scratch path in the codebase). `TMP_DIR` is deleted from `pdf.ts`; the buffer-render path and
  the package builders go through `withTempDir`. Absolute, under `os.tmpdir()` by default
  (`CAREER_TMP_DIR` overrides), `mkdtemp` so two concurrent builds cannot collide, removed in a
  `finally` on success and on a throw, and a cleanup failure is a warning — never a replacement
  for the error that broke the build. Every `.career-out` hit in the repo was classified:
  final CLI output (left alone), temporary workspace (moved), persistent web output (must go
  through `documents/store.ts`).
- **Durable finals, asserted.** Résumé and letter DOCX + PDF are stored through `saveDocument`,
  and `assertDurablePath` (`isTempPath`, case-insensitive on Windows) refuses to let a temp
  path be written into `application_packages`. The stray-path check runs *before* the row is
  updated, not after.
- **No renderer is a warning, not a corruption.** With neither Word nor LibreOffice the DOCX is
  still built and stored, QA states the reason, `pdf_present` does not block, and no PDF is
  invented. A renderer that *was* available and produced nothing still blocks — the two cases
  are distinguished.
- **Stage reporting tells the truth** (`lib/career/package/documents.ts`). The current stage is
  a mutable variable, persisted *before* the risky work that belongs to it
  (`resume_documents` → `cover_letter` → `documents`), and the failure path records the stage
  that was running.
- **Retry ≠ Redo.** `finishPackage` reaches the world through a `DocumentsIo` seam that
  contains no intelligence run, no tailoring pipeline and no package insert, so a retry cannot
  research, re-tailor or create a version; `planDocumentWork` decides what is reused (résumé
  documents only when the failure was past them, the patch still `applied` and their QA not
  blocking; an existing letter verbatim). `redoPackage` remains the only path to v2. Readiness
  is computed from artifacts and QA that exist, so a half-uploaded package reads as failed.
- **Sentences, not stack traces** (`package/status.ts`, `PackageFailure.tsx`). Workspace,
  storage, master-résumé, renderer, QA and timeout each get their own headline, reassurance and
  remedy; the raw error stays in a disclosure and in the run diagnostics. Two orderings matter
  and are pinned by tests: the master-résumé case is tested *before* the storage case (its only
  producer, "master résumé file is missing from storage — re-import it", contains the word
  "storage", and offering `Retry documents` for it would fail identically for ever), and the
  retry sentence is conditional — after a résumé-stage failure no letter exists yet, so the
  screen says writing it is the one model call the retry still costs rather than promising
  "nothing charged again".

### Tests

`npm run test:career-tmp` (new, offline, ~2 s): scratch is absolute and under
`os.tmpdir()`/`CAREER_TMP_DIR` and never `.career-out/tmp`; creation works from a working
directory with no `.career-out`; concurrent `makeTempDir` calls differ; `withTempDir` removes
the directory after success and after a throw; a cleanup failure does not mask the original
exception; `isTempPath` catches a case-differing OS temp path. `npm run test:career-package`
adds 35 checks driving the real `finishPackage` through its io seam — a failed résumé build
records `resume_documents` and keeps the approved changes, a retry re-runs neither research nor
tailoring and creates no version, redo does, and no stored path is a temp path.
`npm run test:career-documents` pins the renderer policy against the real `qa.ts` and watches
the temp root while a buffer render is in flight, so the "no scratch is leaked" check cannot
pass vacuously.

---

## 2026-08-30 — The surfaces: a run you can watch, a run you can open, a company list that speaks intent

**Type:** UI + two read routes (workstream W4 of the scout-durability redesign) · **Behavior
change:** the Scout panel shows real server state instead of a timer; `/dashboard/jobs?run=<id>`
is a new surface; the Companies page is grouped by intent and sorts priority the right way.
No prompt change, no migration (016 is W1's and is not applied to the live database yet).

### Why

Three untruths were on screen. The Scout panel animated a 25-second stage timer that had
nothing to do with the run and told the founder "leave the tab open — a closed tab still spends
the money". A finished run said "whatever it stored is already in the list", which is only true
if you can find it. And the Companies page sorted `watch_priority` **ascending** while the
store and the scout sorted it descending, so the page's "most important" was the system's
least — on a list where 168 of 168 rows were agent guesses labelled as the founder's targets.

### What changed

- **ScoutPanel is a monitor** (`app/dashboard/jobs/ScoutPanel.tsx`). Press Run scout → `POST`
  → `runId` → poll `GET /api/career/scout/runs/[id]` every 3 s and render what the server
  said: queued, running (stage, the last progress lines, live counts), partial, succeeded,
  failed. The fake timer and the tab warning are gone. It survives a refresh — on mount it
  reads `GET /api/career/runs?active=1` and resumes the newest run **the server itself calls
  queued or running**, trusting only `active` and only those two words verbatim (the `runs`
  list carries a derived display status where a dead run reads `stalled`; resuming one of those
  would open the monitor on a corpse). A second click while the first POST is in flight is
  refused: one press, one paid run.
- **Honest about durability.** Before migration 016 the route still executes the scout inside
  the request. Both answers carry `durable`, the panel reads it before it says anything about
  the tab, and it defaults to the pre-016 wording until the server says otherwise. It never
  guesses that sentence in either direction.
- **`/dashboard/jobs?run=<id>`** (`RunResults.tsx`, `app/api/career/jobs/route.ts`): the run's
  status, six counts, a partial-run reason in plain English, and every job the run touched with
  **none** of the inbox's freshness/disposition defaults. Ordering and counting moved into the
  database over the whole id set — paging an id list in the route showed an arbitrary subset
  while the header counted everything, so the two numbers on screen disagreed. The inbox keeps
  its defaults and the two surfaces are deliberately different objects.
- **Companies by intent** (`page.tsx`, `CompanyRow.tsx`, `company-view.ts`): Opening available
  / Targets / Watching / Explore, plus a collapsed Ignored section so a rejection is reversible
  — the list route returns ignored rows (`?include=active` opts out) so the undo survives a
  reload. One-click Target / Watch / Ignore on Explore rows, origin in plain words from
  `ORIGIN_LABEL`, and the priority sort is `byCheckOrder` everywhere. "Opening available" is
  driven by `open_roles_count` alone — sectioning on stored postings put the whole Explore list
  above the founder's own targets, on a page whose job is to keep them apart.
- **Runs page** (`RunRow.tsx`): the persisted `partial` status and the stage a run reached; a
  `job_scout` row links to its results.

### Shape

`run-view.ts` (parsing) and `run-copy.ts` (sentences) are pure and hold everything the two
monitors share — poll interval, the failure budget, status vocabulary, the pre-016 fallback
reader. `company-view.ts` is the same idea for the Companies page. That is what let the polling
shapes be verified offline against synthetic payloads (`npm run test:career-ui-direction`,
`npm run test:career-companies`) with no database, no keys and no paid run.

---

## 2026-08-30 — Usability pass: one word per concept, no paid work without a click, docs that match the code

**Type:** usability fixes across four workstreams · **Behavior change:** UI labels, copy,
navigation, a few one-line guards; no migration, no prompt change, no change to `lib/email/*`.

### Why

A five-lens usability audit (`.career-out/audit-synth.json`) verified ~68 findings against the
code. The founder's brief: "as simple, as straightforward, as functional, and as user friendly
as possible." Everything below was confirmed in code before it was changed; anything needing a
migration, a one-off SQL update, or a prompt-version bump was deferred and is listed in the
audit file.

### D — Navigation, docs, dead code

- **Dashboard** (`app/dashboard/page.tsx`): subtitle no longer names a student club; the four
  shortcuts now reach Scout, Jobs, Outreach and Conversations; the empty state starts on Scout.
- **Sidebar** (`components/layout/Sidebar.tsx`): the same 14 items, grouped under small
  headings — People (Scout, Outreach, Conversations, Contacts), Internships (Jobs, Companies,
  Applications, Evidence), Manual email (Compose, Draft Emails, Templates, Campaigns), Me.
  "My Profile" is now **Profile & Settings**, matching the frozen "Connect your Gmail in
  Settings" strings in `lib/email/*`. The "New Outreach" CTA (which opened Compose) is gone.
- **Runs**: `GET /api/career/runs` reports a run still "running" 25 minutes after it started as
  `abandoned` — display-only, nothing is written (`finish()` is only called on normal
  completion, so a run killed by a timeout stayed sky-blue forever). `RunRow` prints "did not
  finish" for it; the kind filter reads Job scouts / Verifications / Packages / Evidence
  imports; the subtitle says these are Career OS runs only.
- **Setup docs describe the app that exists**: README Status is Phase 11 with 014 + 015 applied
  and no outstanding founder actions, plus a "Founder commands" table; "29 decision records"
  → 38, "thirteen agents" → seven outreach + twelve Career OS; the Resend caveat and "four
  GOOGLE_*" (oauth.ts reads three) are gone. `.env.local.example` drops the Resend block, lists
  the real scopes (`gmail.send`, `gmail.readonly`) and adds the optional `CAREER_USER_ID`.
  SETUP.md replaces the Resend step with the Google OAuth client, runs all migrations in Step 2,
  and its feature/stack tables name Gmail. `MigrationNotice` names 014 *then* 015 and
  `career:seed -- --approve`. CLAUDE.md drops the `Apollo API.txt` trap (untracked 2026-08-10,
  not in the tree) and the webhook trap; CURRENT_STATE §6/§9 record both as done.
- **Dead code**: `app/api/webhooks/resend/route.ts` deleted (its verifier returned `false`
  unconditionally; nothing sent via Resend). `react-hot-toast`, `@heroicons/react` and
  `date-fns` uninstalled — a grep across `app/`, `components/`, `lib/`, `scripts/`, `evals/`
  found zero imports. `verifyWebhookSignature` in `lib/email/resend.ts` is now unreferenced and
  left alone (do-not-touch zone).
- **Guide** (`docs/HOW_TO_USE_OUTREACH_OS.md`): the "Things That May Be Confusing" list loses
  the five items this pass fixed (two Saved's, two sync buttons, campaign stats missing Scout
  sends, Compose orphans, Preferences in two places) and gains Save-vs-Track, Preferences-is-
  not-the-editor and the Runs "abandoned" meaning; page names follow the sidebar.

### Workstream A

2026-08-30 — Usability pass, workstream A (Jobs & Applications). A1: the application state SAVED is labelled 'Tracked' everywhere (tracker group, StateBadge, STATE_LABELS); copy on the Application tab and the empty tracker says a package or 'Track this job' creates the record and the card's Save only shortlists. A2: a verdict now POSTs fit/recompute {} (mission-wide, arithmetic only) and the Jobs list reloads in place so the order updates; the list query embeds job_feedback(verdict, created_at) and applications.current_package_id, so cards show the last verdict after a reload and key 'Open package' on an actual package, not on a tracked-only application. A3: PackagePanel reloads before judging a generate response (a 504 shows the server's row, not the empty state); a redo beside an applied application is no longer called 'locked' and no longer offers the illegal READY_TO_APPLY finalize; generating-progress list extracted to PackageProgress.tsx. A4: ScoutPanel refreshes the list on every outcome, explains a timeout in plain words, disables Close mid-run, adds 'Run again', and tucks the sliders under 'Run size'. A5: the job detail page has the same Love/Interested/Maybe/Not-interested buttons as the card, saved/dismissed chips, no fake 'Generate package' header button; JobTab shows the verification badge once. A6: the tracker confirms before Applied (it locks documents) and shows 'Generate package' instead of a dead 'Redo package' when no package exists. A7: the Mission page drops Season, Status and the mission switcher (the name is the heading); CAREER_OS.md §5 records that the season is Summer 2027 by construction. PATCH /api/career/missions/[id] still accepts season/status.

### Workstream B

Usability pass, workstream B (Evidence & Profile). Review conflicts carry entity_label (experience 'title — org', fact statement, metric 'value context') resolved in the review route from the tombstone-inclusive bank; ConflictCard shows it instead of a UUID prefix. Review/Experiences/Canonical/Stories copy moved to plain language: 'Keeps'/'Folds into it', no rule: or confidence spans, one setup sentence (npm run career:seed -- --approve) on all three banners, H1 'Evidence'. Preferences tab drops the 'hard' checkbox (nothing in lib/career enforced it — hard_constraints on career_missions do) and points at Jobs → Mission; weight saves on blur. Profile page is 'Profile & Settings' with Gmail at the top under 'Settings' (matches the frozen lib/email strings) and says its Career Context feeds only the older outreach loop. Documents upload now honours include_profile (it was ignored by the route). Experience header (title/org/dates/location) is editable on the Experiences tab through the allow-listed rows route, which stamps edited_by_user so merges and re-imports keep the human's value. Column and prompt versions unchanged.

### Workstream C

fix(usability/C): Scout background banner compared against 'evidence' but the API emits 'bank'|'fixture', so every Evidence-Bank run was mislabeled as fixture — check now uses !== 'bank' and the field is typed as the union. Compose regenerate deleted the previous variants' draft rows before calling /api/generate; on failure the screen still offered rows that no longer existed — old rows are now discarded only after new variants arrive.

---

## 2026-08-30 — "What I'm scouting for": a stated direction leads the job search

**Type:** feature · **Behavior change:** the Jobs page has a free-text direction; when set, the
Job Mission Planner starts from it (a pivot is planned as a transfer, not retreated from), the
Fit Evaluator judges transferability toward it, and stored fit rows are invalidated when it
changes. Empty → everything behaves exactly as before.

### Why

The planner inferred role families **from the evidence** ("never from a fixed taxonomy"), so a
chemical engineer's bank implied process / manufacturing / industrial-AI roles. The founder
wants to pivot ("Life Sciences / genomic bio research — my experience is very transferable")
and had no input that could say so; the Mission page's objective was one line among many.

### What was built

- `career_missions.preferences.direction` (jsonb, no migration). `sanitizeDirection` trims,
  collapses whitespace, caps at 1,500 chars (surrogate-safe), null when empty. `updateMission`
  now **merges** a partial `preferences` patch over the stored row — a real bug: a partial patch
  used to wipe the other lists.
- `renderMission` puts `DIRECTION (what I want to scout for — this leads the plan)` first and
  relabels company types as default examples the direction overrides; the default NOTES line no
  longer says "infer roles from the evidence" when a direction exists. Without a direction the
  output is byte-identical (pinned fixture in `test-career-scout`).
- **Job Mission Planner 1.1.0**: with a direction, role families serve it and each carries *why
  this person is credible* from the evidence; a pivot names the roles an intern with this
  background can win in that industry, with honest 0.3–0.6 confidence; seeds and strategies
  match the direction first; roles squarely in the old industry are off-target unless the
  direction says "also open to". **Fit Evaluator 1.1.0**: `role_fit` and `mission_interest_fit`
  are transferability toward the direction, never past-title match. Both bumps invalidate
  stored fit rows; the intelligence orchestrator also folds a hash of the direction into the
  fit cache key so a *changed* direction re-ranks.
- Deterministic floor: `fallbackStrategies` prepends a "stated direction" job-first strategy
  built from the direction's key phrases (`directionPhrases`) when the planner fails.
  `npm run career:scout -- --direction "…"` overrides for one run (never persisted; ranking is
  skipped under an override so no fit row is stored against a direction the mission does not have).
- UI: `DirectionCard` on the Jobs page (save → "leads the next Scout run"; **Scout now** saves a
  dirty textarea first and refuses to run on a failed save); the same field on the Mission page's
  Goal section; the Scout panel shows "Scouting for: …" or "No direction stated — planning from
  your evidence".

### Tests

`test:career-scout` (+ direction block), `test:career-discovery` (prompt 1.1.0 assertions for
both agents), `test:career-ui-direction` (new, wired into `test:career`). Live run below.

---

### Which jobs get ranked

The first direction-led run found the genomics postings (Ginkgo, Xaira, Amgen process
development) but ranked none of them: `selectJobsToRank` picked the 12 best by *extracted >
verified > explicit Summer 2027 > tier*, and the stored Kairos / Anduril postings say "Summer
2027" while the new ones do not. `rankCandidatePriority` now adds +300 per direction term the
posting carries (capped at two), above the season bonus and below extraction/verification, so a
posting that speaks the direction's language is ranked first; without a direction the order is
unchanged (tested).

### CLI user resolution

The first live run from the direction went to the **other** profile on the database: every
Career OS CLI defaulted to `profiles … limit(1)`, the first row in arbitrary order. It was
stopped after the planner started (one `scouting_runs` row and one default mission were created
under that account; nothing else). `scripts/lib/cli-user.ts` now resolves `--user` →
`CAREER_USER_ID` → the only profile → otherwise lists the profiles and refuses. All nine CLIs
use it.

### Review fixes: a saved direction now invalidates stored fit rows

- `fitJudgmentVersion(mission)` (`lib/career/intelligence/orchestrator.ts`) is the identity a fit
  row is stored and reused under: the Fit Evaluator prompt version, plus `+direction.<sha12>` of
  the sanitized direction when one is set. No migration — `job_fit_evaluations.prompt_version` is
  text. Editing the direction therefore forces re-evaluation on the next rank; the `agent_runs`
  trace keeps the bare prompt version. The agent cache key carries it too.
- `renderMission` relabels NOTES as defaults under a direction, and the default notes say the
  evidence-inference rule applies only when no direction is stated.
- `sanitizePreferences` emits `direction` only when non-null (as `notes`), so a preferences write
  without one is byte-for-byte what it was.
- `scripts/test-career-ui-direction.ts` joined `test:career` and gained checks for all three.

## 2026-08-29 — The applicant's real name on every cover letter, and a Redo path

**Type:** fix + feature · **Behavior change:** cover letters, their DOCX header and signature,
and the outreach sign-off resolve the applicant's name through one resolver that can never
return an email local-part; every package has an explicit "Redo package (new version)"

### What was observed

The founder's first live cover letter opened "Dear … zuyu.alex06" and signed "zuyu.alex06".
The signup trigger (`001_initial.sql`) sets `profiles.name` to the email local-part, and
`letterSigner` in `lib/career/package/orchestrator.ts` trusted `profiles.name` first, falling
back to the master résumé's name line only when it was null. `lib/outreach/sender.ts` already
rejected that shape for the outreach loop; the letter loop did not share the rule.

### What changed

- **`lib/career/identity.ts`** (new): `resolveApplicantName({ profileName, bank, env })` →
  `{ name, source }` with source ∈ profile · resume · bank · env · fallback, in that order;
  `looksLikePersonName` and `nameFromBank` moved here (re-exported from `sender.ts`);
  `isEmailLikeName` for the repair; `printableName` as the boundary guard. `sender.ts`'s
  `resolveSenderFrom` delegates to it (new `resume` source; its last-resort literal kept).
- **Every name boundary** goes through it: `letterSigner` (now also reports `nameSource`, and
  `finishPackage` warns when it is the fallback), `runCoverLetterPipeline` (signature and
  `safeNames`), `generateCoverLetter`, `regenerateLetterDocuments`, `buildLetterDocuments`,
  `buildCoverLetterDocx`. The résumé engine is untouched — the master document already carries
  the real name (ADR-033).
- **`finishPackage({ letterFromStored })`** + `reuseCoverLetter` in `package/letter.ts`: a new
  `cover_letters` row and fresh documents from stored text, no writer call; approved/edited
  status travels with the verbatim body.
- **`lib/career/package/redo.ts`** (new): `redoPackage` (the generate path as version N+1;
  locked packages untouched) and `clonePackageVersion` (N+1 carrying the old reviewed patch
  and snapshots, positioned for `finishPackage`). Route `POST /api/career/packages/[id]/redo`.
- **UI:** the Package tab has one "Redo package (new version)" confirm box for every status
  but generating, with the locked-documents hint; the letter panel's button is "Redo letter
  only"; every Applications row links "Redo package" to `?tab=package&redo=1`.
- **`npm run career:fix-names [-- --dry-run] [--user <id>]`** (`scripts/career-fix-names.ts`
  → `lib/career/package/repair.ts`): rewrites email-like name tokens in every `cover_letters`
  text column to the resolved name, and for the current letter of a locked / ready package
  creates a new version rendered from the corrected text. Prints letter · package · fields ·
  new version · docs · QA. Superseded packages get text-only correction.
- **Tests:** `scripts/test-career-identity.ts` (new, offline, in `test:career`);
  `test-career-letter` and `test-career-package` assert a `zuyu.alex06` signer with a résumé
  name line produces "Zuyu Liu" in the letter text, the gate's safe names, and the rendered
  DOCX header and signature.

### Founder action

`npm run career:fix-names -- --dry-run`, then without the flag. `profiles.name` itself is not
changed by this; setting it to the real name on the profile makes `source: profile` win.

---

## 2026-08-28 — Corroboration: one fact, two sources, and a support level the numbers decide

**Type:** fix + feature · **Behavior change:** a pasted text that restates a bank fact no
longer inserts a second wording; a number-less restatement is recorded as event-only
support (0.5) and never raises `support_count`; the engine classes it POSSIBLE, not CONFLICT

### What was observed

A LinkedIn post repeating a résumé fact word for word ("Designed a new SOP … reducing scrap
costs by $300K+ annually.") went through `seedEvidenceFromText`. The importer filed it under
the right experience but atomized the sentence into two facts, so the exact-statement match in
`planPersist` never fired: 8 pending rows inserted, 0 corroborated. The consolidation engine
then classed the number-less half against the résumé fact as CONFLICT ("different numbers":
none vs $300K) — wrong; it restates the event and says nothing about the metric.

### What changed

- **Importer 1.2.0** (`lib/agents/resume-importer`) is shown each existing experience's
  active facts (`existing_facts`, ≤20 per row, most-supported first —
  `existingExperienceInputs` / `existingFromBank` in `import.ts`) and emits
  `corroborates: <fact id>` on a sentence that restates one instead of inventing a wording.
  Validation drops the *field* (never the fact) when the id was not in the input, belongs to
  another experience, or the cited line shares fewer than 3 content words with the fact
  (`checkCorroborates`, `sharedContentWords`); drops are counted and their reasons returned
  (`dropped_corroborations`, `corroboration_notes`) and printed by `summarizeSeed`.
- **Code computes the support level** (`lib/career/evidence/corroborate.ts`): `full` when
  every numeric token of the bank statement appears in the incoming wording (or the bank
  statement has none), `event_only` otherwise. A restatement that *introduces* a number the
  bank fact lacks is never a corroboration — it inserts, and the engine's CONFLICT covers it.
- **`planPersist`** turns a verified corroboration into a `reuse` decision carrying
  `{ rule, support, quote }`; two halves of one line pointing at the same fact become one
  reuse at the stronger support. The deterministic second check (`findFactMatch`) now also
  reuses a fact with identical numeric multiset and content-word Jaccard ≥ 0.8; the
  manual-add route passes `nearDuplicate: false`. `Corroboration` records carry
  `support`, `rule`, `quote`; `summarizeSeed` prints "corroborated: N full, M event-only".
- **Provenance** rows for a reused fact quote the incoming wording at confidence 1.0 (full)
  or 0.5 (event-only). `refreshFactSupport` and the mutation planner's `distinctSources`
  count only rows at ≥ 0.9; an event-only row is visible in labels as "… (event only)"
  (`sourceLabelsForFact`, canonical `factSourceLabels`) but never makes a metric look
  supported.
- **Engine rule** (`compareFacts`): one side number-less, its content words ≥ 0.8 contained
  in the other → POSSIBLE `weaker_restatement` ("restates the event without its numbers —
  corroborates the event, not the metric"). CONFLICT stays for two statements that both carry
  numbers and differ. A `weaker_restatement` merge keeps the numbered statement, re-points the
  bare wording's provenance at 0.5, and leaves `support_count` alone.
- **Organization kinds** read the group: award-only → `other`; "Self" / "Self (public
  profile)" → `other`; "Startup School" → `program`. `planOrganizations` carries `kind`;
  apply refreshes an existing organization's kind and aliases (`organizations_updated`) and
  backfills `statement_norm` on facts where it is null (`statement_norms_backfilled`).
- `numericTokens`: a suffix must end the word ("5 members" is `5`, not `5m`).
- `SIMILAR_TITLE_THRESHOLD` / `NEAR_MISS_THRESHOLD` moved to `normalize.ts` (re-exported
  from `plan.ts`) so `consolidate-rules` no longer imports from `plan` — `plan` now imports
  `corroborate`, which imports the rules.

### Tests

`test:career-provenance` (importer validation of `corroborates`, support levels, plan reuse,
near-duplicate bands, event-only labels) and `test:career-consolidation` (the SOP pair is
POSSIBLE `weaker_restatement`, different numbers still CONFLICT, mutation confidences,
`organizationKindFor`). All five evidence suites and `tsc` pass. Not yet exercised live: a
re-run of the LinkedIn-post import against the founder's bank.

---

## 2026-08-28 — Knowledge base consolidation: sources, provenance, canonical identity, one retrieval layer

**Type:** architecture + feature · **Behavior change:** imports corroborate instead of
duplicating; the bank merges only what it can prove and shows the rest for review; every agent —
including People Scout and positioning, which read a hardcoded fixture until today — takes its
personal evidence from `getRelevantPersonalEvidence`. Migration `015_evidence_canonical.sql`
(applied by the founder the same day). ADR-038. Status doc: `KNOWLEDGE_BASE_DEDUP_PLAN.md`.

### What was built (four reviewed workstreams + an integration pass)

- **Sources and provenance** (`sources.ts`, `provenance.ts`, `persist.ts`). Every import creates one
  `evidence_sources` row (kind, label, raw content, sha256 — the same text twice is one source) and
  provenance rows for inserted *and* reused facts and experiences, with the wording each source
  used. Title/date disagreements become `evidence_conflicts`; the résumé's value stays canonical.
  `support_count` / `CORROBORATED` count only sources at confidence ≥ 0.9.
- **The importer sees the bank** (prompt 1.1.0 → 1.2.0). `importFromText` passes existing
  experiences and their facts; the agent files sentences under existing ids and marks a
  restatement with `corroborates`. Code computes the support level from the numbers — full
  (1.0) or event-only (0.5) — and the deterministic matcher (`plan.ts`, now with a near-duplicate
  rule at identical numbers + ≥ 0.8 word overlap) remains the second check. Projects are proposed
  only when the text names them (validated as a substring of the source).
- **Consolidation engine** (`consolidate*.ts`, `summary.ts`): a pure plan over normalized
  organization keys, head titles, parsed dates and qualifiers → HIGH / POSSIBLE / CONFLICT with
  why, data preserved and risk; `planMutations` lists every write before it happens (re-points,
  fills, tombstones — never a delete); `applyConsolidation` snapshots first, applies HIGH only,
  stores the rest as open suggestions, refreshes deterministic canonical summaries. Review found
  and the pass fixed: chained merges applied against a stale bank, near-duplicate facts
  auto-applied (now POSSIBLE), two labs at one university HIGH when undated, an edited row on the
  tombstoned side (edited rows now win the keep side; both edited → POSSIBLE), a number-less
  restatement classed as a numeric CONFLICT (now `weaker_restatement`, POSSIBLE).
- **CLI**: `npm run evidence:audit` (read-only report + JSON), `npm run evidence:consolidate`
  (`--dry-run` default, `--apply`, `--apply --pair keep:merge [--possible]`),
  `npm run evidence:benchmark`.
- **Retrieval layer** (`retrieval.ts` + score/render/targets): deterministic lexical ranking with
  BM25-style idf over the bank, one hit per synonym family, category weights, corroboration and
  metric bonuses, stable tie-breaks; never unapproved, never tombstoned, never empty for a
  non-empty bank. `toBackgroundItems` produces the outreach loop's proof-point shape with derived
  domains and credibility. Consumers migrated: scout route + CLI, positioning, conversation and
  follow-up sender identity (`lib/outreach/sender.ts` — profile name only when it looks like a
  person, else an education fact about a student, else env, else the old literal), fit, matcher,
  planner, tailor (résumé experiences always, facts ranked), letter.
- **UI**: Evidence → **Canonical** (organization → role → projects → key facts → source chips)
  and **Review (N)** (Merge · Keep separate · Merge all high-confidence · conflict resolution),
  behind `/api/career/evidence/{canonical,review,consolidate}`; read-only with a banner on a
  014-only database.

### Live run on the founder's bank (28 experiences, 59 facts, 25 metrics after a résumé + a LinkedIn export)

Audit → dry run: 3 HIGH (Founders president, IBC project manager, P&G QA intern), 4 POSSIBLE
(Argonne analyst vs student researcher, LoopEra founding team vs executive assistant, two UIUC
education rows, Mironenko lab vs undergraduate researcher), 1 POSSIBLE fact, 0 CONFLICT, 6 orphan
metrics, 2 date conflicts. Apply: snapshot `d1ff7e5d…` → 18 organizations, 4 backfilled sources,
59 + 28 provenance rows, 3 merges, 17 children re-pointed, **0 rows deleted**, 8 suggestions,
2 conflicts, 24 summaries. Verified directly: 0 children left on a tombstone, 59/59 facts active.
Second apply linked one orphan metric; third dry run had nothing to apply.

**Corroboration, exercised live.** A LinkedIn-post text restating two résumé facts filed under
the right experiences (0 new experiences) but the 1.1.0 importer atomized the sentences, so 0
facts were corroborated and 8 pending facts were created — the reason the 1.2.0 `corroborates`
contract and the near-duplicate rule exist. The 1.2.0 re-run (entry above): 0 new experiences, 3 full + 1 event-only corroborations, 1 new fact.

**Context compression** (`evidence:benchmark`, live bank): persona prompts 1,835 → 468–699
tokens (6 personas); tailor input 6,334 → 4,245; outreach background 1,205 (fixture) → 768
(bank); total 18,549 → 8,749 (−53 %).

### Tests

`test:career-evidence` 130 · `test:career-provenance` 47+ · `test:career-consolidation` 123 ·
`test:career-retrieval` 107 · `test:career-canonical-view` 51 — idempotency (same résumé /
text twice, résumé↔LinkedIn in both orders), aliases (P&G, Founders, UIUC), `PG Solutions` ≠
P&G, VP ≠ President, Head of Events ≠ President, two labs, two summers, two hackathons with
different numbers, two IBC engagements, similar metrics, safest wording, no-loss mutations,
six retrieval personas, tombstone exclusion, fixture-only-when-empty, and "editing a fact
changes the rendered background".

---

## 2026-08-28 — Evidence page: the Canonical and Review tabs, and the routes behind them

**Type:** feature · **Behavior change:** the Evidence page opens on a per-organization
canonical view; merge suggestions and conflicts are reviewed in the UI; nothing merges
before migration 015 is applied

### What was built

- `GET /api/career/evidence/canonical` — the bank grouped by organization
  (`organization_id` when 015 has assigned one, else `normalizeOrg(organization)`),
  tombstones excluded, pending rows included and badged. Each role carries its projects,
  key facts (`summary_fact_ids` when present, else the top 3 by category rank then
  support), all facts, metrics and source chips ("Résumé ¶6", "LinkedIn L350"). The
  builder is pure (`canonical/build.ts`) and tested offline.
- `GET /api/career/evidence/review` — `buildConsolidationPlan` over the live bank
  (approved and pending), kept-separate pairs passed as suppressed when 015 exists,
  plus open `evidence_conflicts` rows. `POST` takes `merge` / `keep_separate` /
  `merge_all_high` / `resolve_conflict`. CONFLICT proposals never merge through it.
- `POST /api/career/evidence/consolidate { dryRun }` — the plan and the CLI's text
  report, or the HIGH apply with the bank-wide backfill.
- `CanonicalTab.tsx` (first tab) and `ReviewTab.tsx` ("Review (N)", N = open
  HIGH + POSSIBLE + CONFLICT; no count until the fetch succeeds). Both under 300 lines.

### The two guards

**Migration 015.** Every route degrades on a 014-only database: reads report
`migration015: false`, writes answer 400 with the message the banner shows
("Merging needs migration 015 — suggestions are shown read-only"). A missing 015 never
marks the bank as `migrationMissing`.

**Unattended merges.** Review found the engine classing two pairs HIGH that must not be
applied without a person: two UIUC labs whose qualifiers are PI surnames (or one row with
no qualifier) and no dates on either side, and a HIGH pair whose merge side was
`edited_by_user`. `app/api/career/evidence/review/guard.ts` demotes both to POSSIBLE
before the plan reaches the UI or "Merge all high-confidence" / `consolidate
{dryRun:false}`, recording `signals.downgraded` and a warning. The single-card Merge
button still works on them — that is a human confirming. The engine rule itself is a
wave-2 item (`TODO(wave2)` in the guard); the CLI `evidence:consolidate --apply` does
not yet pass through this guard.

`merge_all_high` runs `applyConsolidation` with `backfill: false` — it merges the HIGH
pairs and nothing else; the organization/provenance backfill is the consolidate route's
job. Keep-separate preserves the audit row: an existing suggestion only changes
`status`/`resolved_at`, a new one is stamped with the proposal's confidence and rule.

### Tests

`npm run test:career-canonical-view` — 50 checks: grouping, tombstones, key-fact
selection, provenance labels, and the four guard counter-examples from review (plus the
same-org-same-dates case that must stay HIGH).

---


## 2026-08-28 — The Evidence Bank dedupes by what a row IS, not how it was spelled

**Type:** correctness · **Behavior change:** imports and manual adds reuse existing rows
under normalized keys; a new master résumé demotes the old master's bullets

### What happened

An audit of the founder's bank found the same job three times: the DOCX said
`Founders: Illinois Entrepreneurs / President; Formerly Head of Events`, LinkedIn said
`Founders — Illinois Entrepreneurs (UIUC) / President`, and `persistProposal` compared
raw lowercase `org::title` strings. Facts, metrics and deliverables followed the same rule
(`'Organized Forge 2026.'` ≠ `'organized forge 2026'`, `'$4M+'` ≠ `'4M'`), the
existing-row map was built from the bank only so two blocks in one proposal both landed,
and a reused fact silently dropped the second source. Uploading a second master DOCX
demoted the old `resume_documents` row but left its bullets `is_on_master=true`, so the
tailor and the package read two full bullet sets as the current résumé.

- `lib/career/evidence/normalize.ts` (new, pure): `normalizeOrg` (diacritics,
  parentheticals, `&`→`and`, legal suffixes, a founder-editable `ORG_ALIASES` table like
  `SYNONYM_GROUPS`), `normalizeTitle` (drops what follows a comma/dash/semicolon and
  `formerly`/`prev.`), `experienceKey`, `titleSimilarity` (token Jaccard; containment
  is 1 only when the extra words are seniority qualifiers — review caught `Vice
  President` ≡ `President` and `Intern` ≡ `Software Intern` merging silently when a text
  import carried no dates; those now score 0.5 and land in the near-miss report),
  `parseResumeDate`/`datesCompatible` (free-text résumé dates; unknown is
  compatible, disjoint is not), `normalizeStatement`, `normalizeMetricValue`.
- `lib/career/evidence/plan.ts` (new, pure): `planPersist(bank, proposal)` decides every
  reuse, insert, collapse, near-miss and corroboration before a row is written.
  Experiences: same key and compatible dates → reuse; same org, similarity ≥ 0.6 and
  compatible dates → reuse (reported as `matched`); similarity in [0.3, 0.6) → **insert
  and report as a near-miss** — never guess. Two P&G summers with the same title stay two
  rows. `persistProposal` now executes the plan; `SeedCounts` gained `matched`,
  `nearMisses`, `corroborated` and `summarizeSeed` prints them. A corroborating source
  is reported, not stored — real multi-source provenance is in
  [KNOWLEDGE_BASE_DEDUP_PLAN.md](KNOWLEDGE_BASE_DEDUP_PLAN.md).
- `ensureMasterDocument` demotes the old master's bullets (`is_on_master=false`, still
  approved — exactly the alternates the tailor's Level-3 swap draws from) and re-promotes a
  previously demoted document's bullets when its hash is uploaded again.
- `POST /api/career/evidence/rows` returns `{ id, existing: true, rule }` for a fact,
  skill or experience the bank already has, instead of a second row or a unique-violation
  500. Manual experience adds use exact/alias only — a human typing a distinct title means it.

53 new checks in `scripts/test-career-evidence.ts` (104 total). No migration, no prompt
change, no downstream consumer touched, seed not re-run against the live bank.

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
