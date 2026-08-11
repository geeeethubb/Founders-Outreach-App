# Phase 7 — Agentic Scouting: build, evaluation, and iteration log

What was built, what was measured, what was changed in response, and what is
still wrong. Numbers here are measured, not estimated. Where a threshold was not
met, that is stated plainly rather than reframed.

Companion documents: [AGENT_RUNTIME.md](AGENT_RUNTIME.md) for how the agents
execute, [EVALS.md §10](EVALS.md) for the metric definitions,
[ARCHITECTURE.md](ARCHITECTURE.md) ADR-016 through ADR-020 for the decisions.

---

## 1. What changed from Phase 6

Phase 6 was a fixed pipeline with two research steps bolted into it. Phase 7 is
a set of agents that decide what to do.

| | Phase 6 | Phase 7 |
|---|---|---|
| Provider for research | OpenAI Responses `web_search` | Anthropic server-side `web_search` |
| Agent execution | one model call, JSON in prose | bounded tool loop, `submit_result` only |
| Discovery | one query per segment | multi-round session with diagnosis + next action |
| Company outcome | relevant / not relevant | KEEP / MAYBE / REJECT + per-company target titles |
| Person outcome | dossier | KEEP / MAYBE / REJECT / SEARCH_FOR_DIFFERENT_PERSON |
| Apollo's role | discovery **and** resolution | resolution only |
| Feedback edges | none | exactly one, upstream, bounded |
| Agent state | not persisted | `scouting_runs`, `agent_runs`, `research_facts` |

The provider swap was a provider swap: `WebResearchProvider` did not change, so
nothing above the interface knew about it. That was the point of
[ADR-008](ARCHITECTURE.md#adr-008) and it held.

---

## 2. Verification before evaluation

`npm run verify:setup` — Apollo credential (via free `auth/health`, zero
credits), Anthropic credential, and migration 010 confirmed by a real
write→read→delete round-trip through the production persistence path. All three
passed. No secret values are printed; the script reports presence and length
class only.

`npm run smoke:agentic` — the full chain end to end on a minimum budget.

**7/7 checks passed.** Notably, in-memory Anthropic cost and the sum persisted
across `agent_runs` reconcile **exactly**, which is the only reason the
concurrency bug in §3 was visible at all.

---

## 3. Bugs the smoke test found

Every one of these was found by running the system, not by reading it. They are
recorded because each represents a class of error worth recognizing again.

### 3.1 Apollo returned zero people for every company

The Mission Strategist emitted *descriptions* where Apollo wants *job titles*:
`Founder/CTO (early-stage industrial AI startup)`,
`Head of Product - Manufacturing/Process Industries`. `person_titles` is a
phrase match, so all three companies returned **0 rows**.

Fixed structurally rather than by prompt: Company Validation now derives
`target_titles` from each company's researched size and archetype, and
`lib/scouting/titles.ts` normalizes them deterministically. Fourteen test cases,
each a real string that returned zero rows. See
[ADR-018](ARCHITECTURE.md#adr-018).

### 3.2 A name-scoped Apollo search resolved to a different company

"Operon", a 3-person industrial AI startup, matched a **412-person Polish music
publisher** of the same name. Every downstream stage would have researched those
people as the target and reported success.

Validation now establishes a confirmed domain, and People Scout drops rows whose
employer name does not match when no domain is available. Names collide; domains
do not.

### 3.3 `agent_runs` cost summed to more than the run cost

$1.33 persisted against a true total of $0.92. Per-agent cost was measured as a
delta against the *global* usage counter, and agents run concurrently, so the
deltas overlapped. Now accumulated per call inside each loop.

### 3.4 Failed Apollo batches were silent

`enrichMany` did `if (!res.ok) continue`. Credit exhaustion and a network fault
produced the identical observable — "0 enriched" — and the difference decides
whether retrying is even sensible. Now returns the reason.

### 3.5 A failed Apollo response was cached

A `422 insufficient credits` was written to disk and replayed from cache long
after the account was topped up, with nothing in the logs explaining why. 41
poisoned entries were purged and `apolloRequest` now caches successes only
([ADR-015](ARCHITECTURE.md#adr-015)).

### 3.6 The grounding check was destroying real sourcing

The evidence pool was built only from `citations` on text blocks. An agent whose
answer arrives as a `submit_result` **tool call** emits no cited text, so the
pool was empty on every real run and **every genuine FACT** was downgraded to
INFERENCE. Measured: 0 of 9 FACTs kept their source; 12 of 12 after the fix.

This is the most instructive failure in the phase. A grounding check that fails
*open* is obviously bad. One that fails *closed* looks like it is working — the
sourcing ratio reads "100%" because numerator and denominator both collapsed to
zero. **Assert on the absolute count, not only the ratio.** See
[ADR-017](ARCHITECTURE.md#adr-017).

---

## 4. Bugs the eval harness found before it was trusted

The harness was validated on a deliberately tiny run first. This cost about
$2 and caught three problems that would have invalidated or wasted a full run.

### 4.1 The judge was reading the scorer's prose

`judgeProspects` was being passed `why_they_fit` — the **ranking agent's own
justification**. Precision@20 would have measured how consistent the system is
with itself, and would have looked excellent doing it. The judge now receives the
person-research dossier and nothing the scorer wrote.

### 4.2 Every invalid-output retry died with a 400

The retry pushed the assistant's `tool_use` block and replied with a plain text
message. The API requires a `tool_result` for every `tool_use`, so the correction
attempt was a hard 400 that took its whole discovery round with it.

### 4.3 An empty denominator scored 0%, not n/a

A profile that rejected no companies scored 0% rejection accuracy, dragging the
aggregate under threshold. That would have sent an iteration chasing a failure
that did not exist.

---

## 5. Baseline

Run tag `baseline`, judge v2.0.0, 20 prospects published per profile from ~32
researched.

| Profile | Precision@20 | BAD rate | Discovery precision | Best-person |
|---|---|---|---|---|
| Industrial AI startups | 55% (11G/8M/1B) | 5% | 88% | 75%* |
| Chemical / manufacturing innovation | **10%** (2G/11M/7B) | **35%** | **97%** | 67%* |
| Operations / industrial consulting | 45% (9G/7M/4B) | 20% | 89% | 92%* |

\* measured with a `candidatePool` keying bug (looked up by Apollo's company name
rather than the discovery name, so pools were often empty). Fixed; these figures
are not trustworthy and the post-fix numbers supersede them.

### The finding that reframed the phase

**Discovery is not the bottleneck.** Company-level precision measured 88–97%
across every profile. On the worst profile it was 97% — nearly every company was
a correct target — while Precision@20 was 10%.

Essentially all the loss is *which person inside a right company gets
contacted*. That is a different problem from the one Phase 6 was solving, and it
is the reason this phase's changes are concentrated in People Scout and Company
Validation's title selection rather than in discovery.

Consulting is also worth noting: 45% here against **20% in Phase 6**, and Phase 6
concluded that segment was supply-limited. Research-led discovery moved it
substantially, so that conclusion was too pessimistic.

---

## 6. The judge was measuring the wrong thing

Before iterating on the pipeline, the judge itself was audited — every non-GOOD
verdict on the worst profile was read.

**The BADs were real.** All 7 were genuine person-selection failures: a CRM/sales
owner, a fragrance-formulation scientist, food-science product R&D, an S&OP
planner, and a plant manager in Thailand on a US-scoped mission. The BAD rate was
measuring something true, and none of those criteria were touched.

**5 of 11 MAYBEs were an artefact.** The judge praised the fit and then
downgraded for obscurity:

> *"Role template (plant Digital Manufacturing Leader at Kimberly-Clark) is an
> **excellent functional fit**, but there is zero verifiable information about
> this specific individual."*

> *"Title and inferred scope (plant-level Digital Manufacturing Leader) **fit the
> mission well**, but nothing specific is known about this individual beyond a
> generic job description."*

v2.0.0 instructed: *"if nothing specific is known about someone, they cannot be
GOOD."* That conflates **we could not find much about this person** with **this
person is a bad target**. Most directors at large manufacturers have no public
footprint; requiring one measures internet fame rather than whether the prospect
is worth an email.

**v3.0.0** splits GOOD into `GOOD_HIGH_EVIDENCE` and `GOOD_ROLE_BASED`. Both
count as GOOD; the split is reported so a list resting entirely on role fit
remains visible as such. MAYBE is reserved for *material* uncertainty — adjacent
function, ambiguous scope, partial overlap. Geography, function, seniority and
decision influence remain hard BAD criteria.

**Thresholds were not changed.** 75% average, 65% per profile, 10% BAD rate.

### Baseline re-scored under the corrected judge

`scripts/rejudge-run.ts` reconstructs a completed run's top-20 from persisted
`agent_runs` and re-scores it, so before and after are measured with the same
instrument.

| Profile | v2.0.0 | v3.0.0 | GOOD split |
|---|---|---|---|
| Industrial AI startups | 55% | **70%** | 8 high-evidence / 6 role-based |
| Chemical / manufacturing innovation | 10% | **45%** | 2 high-evidence / 7 role-based |

The recalibration is worth roughly 15–35 points depending on how enterprise-heavy
the profile is — and it is not lenient: it still returns 1 BAD and 5 MAYBEs on
profile 1, correctly flagging a *"Research Assistant, Masters Student"* and a
*"Head of Sales Engineering"*.

It also does not close the gap. Profile 2's remaining 6 BADs are all genuine, and
they map cleanly onto the pipeline fixes:

| Remaining BAD | Real cause |
|---|---|
| Plant Manager @ Dow (Thailand) | geography never passed to Apollo |
| Latam IS Lead @ Hershey | geography + IT function |
| Director of Innovation @ General Mills | food-science R&D, not digital |
| Associate Director R&D @ Unilever | product R&D |
| Director of R&D Innovation @ PepsiCo | beverage R&D |

---

## 7. Full baseline (all five profiles, judge v2.0.0)

| Profile | Precision@20 | BAD | Discovery | Best-person |
|---|---|---|---|---|
| Industrial AI startups | 55% | 5% | 88% | 75% |
| Chemical / manufacturing innovation | 10% | 35% | 97% | 67% |
| Operations / industrial consulting | 45% | 20% | 89% | 92% |
| Enterprise AI with industrial relevance | 65% | 0% | 82% | 75% |
| Technically ambitious startups | 65% | 5% | 92% | 67% |
| **Average** | **48%** | 13% | **90%** | 75% |

$67.49 · 149 Apollo credits · **$1.41 per GOOD prospect** · **3.1 credits per GOOD prospect**

Two secondary findings from the completed run:

**Rejection accuracy was 40%**, far below the 90% target, and the losses were
real. The judge on ABB: *"This rejection is clearly wrong and represents exactly
the costly error the mission warns against."* Grantek, a legitimate systems
integrator since 1980, was also dropped. The MAYBE-passes gate is not permissive
enough where it matters.

**Two rejections were penalised unfairly.** The "technically ambitious startups"
profile carries `geography: 'United States'` as a field, but its goal *text*
never says so — so the agent honoured a constraint the judge could not see and
was marked wrong for it. That is a defect in the eval fixture, not the pipeline.

---

## 8. Iteration log

### Iteration 1 — person selection · **REVERTED IN PART**

**Hypothesis.** Precision is capped by *which person inside a right company* gets
contacted. Three specific defects: geography was never passed to Apollo; target
titles were chosen from company size alone and defaulted to engineering
leadership; and People Scout took Apollo's first N candidates rather than the
best N.

**Change.**
1. Pass mission geography to Apollo as `person_locations`.
2. Company Validation prompt 2.1.0 — choose the **function** that owns the
   mission's work first, then the seniority.
3. Order candidates by title fit before applying the per-company cap.

**Expected.** Removal of the geography BADs (Thailand, Latam) and the
product-R&D BADs should lift chemical/manufacturing from 45% toward 60%+.

**Measured** (judge v3.0.0 throughout, baseline re-scored with the same judge):

| Profile | Baseline | Iteration 1 | Δ |
|---|---|---|---|
| Chemical / manufacturing innovation | 45% | **40%** | −5 |
| Industrial AI startups | 70% | **65%** | −5 |

Discovery precision rose to 100% on chemical and BAD rate fell 30% → 25%, but
precision moved the wrong way on both profiles.

**Diagnosis.** Inspecting the run showed the fallback-title rate had *risen*,
6 → 9 of 19 companies. The function-first prompt made the model produce more
descriptive titles, more of them failed normalization, and more companies
therefore fell back to the generic archetype list — which contained the very
titles that generate BADs.

**Verdict.** Geography (proven to bite: Dow plant managers 21 → 10 when
US-scoped) and best-candidate ordering are structurally correct and were
**kept**. The prompt change alone did not earn its place; it was kept only
because iteration 2 addresses the mechanism that punished it, and it is re-tested
there.

---

### Iteration 2 — the title normalizer and its fallback list

**Hypothesis.** The real defect is not *which titles the agent chooses* but what
the deterministic normalizer does to them, plus what it falls back to.

Corporate titles use two opposite comma conventions:

```
"Solutions Engineering Manager, Process Industries"   -> qualifier follows
"Director, Digital Manufacturing"                     -> FUNCTION follows
```

The normalizer discarded everything after the comma, which is right for the first
and catastrophic for the second: it yields a bare `"Director"`. Searching a
90,000-person manufacturer for `"Director"` returns *every* director — which is
precisely how a food-science innovation director and two product-R&D directors
reached an industrial-digitalisation list.

And `ARCHETYPE_TITLES.enterprise` — the fallback — contained `"Director of
Innovation"` and `"Director R&D"`. At a food or CPG manufacturer those mean
**product and flavour** innovation. They produced three of the six remaining BADs
(General Mills, Unilever, PepsiCo).

**Change.**
1. When the head before a separator is a bare rank, rejoin the tail instead of
   discarding it.
2. Remove ambiguous titles from the enterprise fallback; every entry must name a
   function, asserted in tests.
3. Add a `titles_logic` version to the company-validation cache key.

That third item is not incidental. `validate()` normalizes titles, so a **cached**
`AgentResult` replays the already-normalized output — iteration 2 would have
measured iteration 1's titles while appearing to test new ones. The prompt version
cannot cover it, because the prompt did not change.

**Expected.** Fallback rate falls; the three product-R&D BADs and the bare-"Director"
noise disappear from chemical/manufacturing.

**Measured** (judge v3.0.0 throughout):

| Profile | Baseline | Iter 1 | **Iter 2** |
|---|---|---|---|
| Industrial AI startups | 70% | 65% | **70%** |
| Chemical / manufacturing innovation | 45% | 40% | **40%** |

Precision did not move. The failure modes the change targeted did:

| Chemical / manufacturing | Baseline | Iter 1 | Iter 2 |
|---|---|---|---|
| BAD rate | 30% | 25% | **15%** |
| BAD count | 6 | 5 | **3** |
| People dropped by person-level verdict | 17 | 13 | **8** |
| Stubs found | 127 | 127 | **148** |

Efficiency improved sharply across the phase: **$0.77 per GOOD prospect** (from
$1.41) and **1.6 Apollo credits per GOOD prospect** (from 3.1).

**Verdict: KEEP.** The BAD rate halved and the wrong-person drop rate more than
halved, which is exactly what the change targeted. Industrial AI returned to its
baseline 70%, confirming iteration 1's −5 there was the normalizer regression
rather than the geography or ordering work.

**But precision is flat**, and that is the honest headline. The freed slots
became MAYBEs rather than GOODs. Note also that 45% → 40% is a **one-prospect
difference at n=20** and sits inside run-to-run noise — discovery itself returned
a different company set each run (79–100% precision). The BAD-rate trend across
three runs is a far stronger signal than the precision delta.

---

### Iteration 3 — selectivity

**Hypothesis.** Precision@20 is capped by the size of the pool it selects from,
not by the quality of any single agent.

The funnel publishes 20 of roughly 28 qualified people — 71%. That is not
selection; it is *everything that survived*, and Precision@20 is measuring the
funnel rather than the ranking. To publish 13 GOODs (65%) from a pool whose GOOD
density is ~40%, the top 20 has to be drawn from roughly 60 qualified
candidates, not 28.

This is the one lever the previous two iterations did not touch, and it was
visible in the very first profile's numbers.

**Change.** Raise the researched pool from 32 to 64 and companies per segment
from 7 to 10, on the chemical/manufacturing profile only.

**Expected.** If the hypothesis holds, precision rises materially with BAD rate
staying at or below 15%. If precision stays near 40% with twice the pool, the
constraint is not selectivity — it is that this segment's *supply* of people whose
scope can be verified is genuinely thin, which is a finding about the market
rather than about the code.

**Measured.**

| Chemical / manufacturing | Baseline | Iter 2 | **Iter 3** |
|---|---|---|---|
| Precision@20 | 45% | 40% | **55%** |
| BAD rate | 30% | 15% | 30% |
| Discovery precision | 97% | 79% | **69%** |
| Qualified pool for 20 slots | 28 | 28 | **42** |

**The hypothesis held — and the change also broke something.** Precision rose 15
points, confirming the funnel was the binding constraint. But the pool was bought
by asking discovery for **10 companies per segment instead of 7**, which pushed it
past the good candidates into weaker ones: company precision fell 79% → 69%, and
the BAD rate doubled back to 30%.

**Verdict: PARTIAL.** The selectivity finding is real and kept. The method of
obtaining it is wrong and was replaced in iteration 4.

---

### Iteration 4 — deeper, not wider · **KEPT**

**Hypothesis.** The two effects in iteration 3 are separable. Pool size and
company quality only traded against each other because the extra candidates were
bought by *finding more companies*. Mining **already-validated** companies more
deeply costs no company quality at all.

**Change.** Keep `companiesPerSegment` at 7. Raise `maxPeoplePerCompany` from 3
to 6, and the researched pool to 60.

**Measured.**

| Chemical / manufacturing | Baseline | Iter 2 | Iter 3 | **Iter 4** |
|---|---|---|---|---|
| **Precision@20** | 45% | 40% | 55% | **80%** |
| **BAD rate** | 30% | 15% | 30% | **5%** |
| GOOD split (hi / role-based) | 2 / 7 | 3 / 5 | 5 / 6 | **6 / 10** |
| Qualified pool for 20 slots | 28 | 28 | 42 | **52** |
| Selection ratio published | 71% | 71% | 48% | **38%** |
| Cost | $12.55 | $9.47 | $11.23 | **$7.19** |
| Apollo credits | 34 | 26 | 29 | **23** |

**16 GOOD / 3 MAYBE / 1 BAD.** The profile that began at 10% under the original
judge, and 45% under the corrected one, now passes every primary threshold — and
does so **more cheaply than the baseline it replaced**, because credits are no
longer spent on people who are dropped later.

**Verdict: KEEP**, adopted as the default configuration.

### What actually mattered

The lever was never a smarter agent. Ranked by measured contribution on the worst
profile:

1. **Selectivity (+25 points).** Publishing 20 of 28 survivors is not selection;
   Precision@20 was measuring the funnel. Going from a 71% to a 38% publish ratio
   was worth more than every prompt change combined.
2. **The judge recalibration (+35 points, measurement only).** Not an
   improvement to the system — a correction to the instrument. Reported
   separately for that reason.
3. **The title normalizer (BAD 30% → 15%).** A deterministic string bug, not a
   model failure.
4. **Geography (BAD contribution).** One missing API parameter.
5. **Prompt changes: no measurable effect.** The function-first prompt (2.1.0)
   did not move precision on its own and briefly made things worse by raising the
   fallback rate.

Four of the five levers are deterministic code. That is the phase's most
transferable result: when an agentic pipeline underperforms, the prompt is rarely
the first place to look.

---

## 9. Validation — run `final3` (before archetype-holding)

Run tag `final3`, judge v3.0.0 (batched at 10), adopted configuration: 7
companies per segment, 6 people per company, 60 researched, 20 published.

| Profile | Baseline (v3 judge) | **Final** | Δ | BAD | Discovery | Best-person |
|---|---|---|---|---|---|---|
| Industrial AI startups | 70% | **70%** | — | 5% | 88% | 75% |
| Chemical / manufacturing innovation | 45% | **75%** | **+30** | 5% | 79% | 50% |
| Operations / industrial consulting | 45%\* | **65%** | +20 | 5% | 83% | 83% |
| Enterprise AI with industrial relevance | 65%\* | **60%** | −5 | 10% | 80% | 83% |
| Technically ambitious startups | 65%\* | **75%** | +10 | 0% | 89% | 75% |

\* judge v2.0.0 — these three were never re-scored under v3, so their deltas are
conservative: v3 is the more permissive instrument, and the true baselines are
likely higher.

### Threshold status

| Metric | Result | Target | |
|---|---|---|---|
| Average Precision@20 | **69.0%** | ≥ 75% | FAIL |
| Minimum profile Precision@20 | **60%** | ≥ 65% | FAIL |
| BAD rate@20 | **5%** | ≤ 10% | PASS |
| Market discovery precision | **84%** | ≥ 80% | PASS |
| Best-person hit rate | **73%** | ≥ 70% | PASS |
| Company rejection accuracy | **25%** | ≥ 90% | FAIL |
| Search recovery | **50%** (1 of 2) | ≥ 80% | FAIL (n=2) |

**69 of 100 judged prospects were GOOD**, against 48 at baseline.

### Cost

The final run replayed almost entirely from cache — $26.82 and 14 Apollo credits
— so those are **re-run** figures, not from-scratch ones. The honest
from-scratch number comes from iteration 4, which was largely uncached: **$7.19
and 23 credits for one profile producing 16 GOOD prospects**, i.e. roughly
**$0.45 and 1.4 credits per GOOD prospect**, against a baseline of $1.41 and 3.1.

### The milestone was not met

The target is ≥75% average with no profile below 65%. The measured result is
**69.0% average with Enterprise AI at 60%**. Two thresholds are missed, and no
amount of framing changes that.

What did move: the average rose from **48% to 69%**, the worst profile went from
10% to 75%, BAD rate fell from 13% to 5%, and cost per GOOD prospect fell from $1.41 to
about $0.45.

### The one regression, and what it means

Enterprise AI is the only profile that got **worse** (65% → 60%, and the parallel
unbatched run measured 55%). Both runs agree on the direction.

The likely cause is that the deeper-pool configuration is not universally right.
Going from 3 to 6 people per company is clearly correct at a 90,000-person
manufacturer, where many people hold genuinely relevant roles. At an
enterprise-software vendor the relevant population inside each company is
*smaller*, so digging deeper surfaces progressively more marginal people —
platform engineers, generic product managers — who then occupy top-20 slots.

**This suggests `maxPeoplePerCompany` should be a function of company archetype,
not a global constant** — the same lesson as target titles ([ADR-018](ARCHITECTURE.md#adr-018)),
applied one level up. That is the highest-confidence next change, and it is
untested.

---

### Iteration 5 — archetype-aware pool depth · **HYPOTHESIS REJECTED, change kept**

**Hypothesis.** Enterprise AI regressed because pool depth is a global constant.
Six people per company is right at a 90,000-person manufacturer and wrong at a
software vendor, where the relevant population is a handful and digging past them
surfaces platform engineers and generic product managers.

**Change.** Depth derived from the researched archetype — enterprise 6, midmarket
and consultancy 5, growth 4, startup and research 3 — capped by the run budget.

**Measured.**

| Profile | Before | After | BAD before | BAD after |
|---|---|---|---|---|
| Enterprise AI with industrial relevance | 60% | **55%** | 10% | **0%** |
| Operations / industrial consulting | 65% | **65%** | 5% | 5% |

**The precision hypothesis is wrong.** Depth was not what held Enterprise AI
back. The change did eliminate both BADs, but converted them into MAYBEs rather
than GOODs.

**Verdict: KEEP the change, reject the reasoning.** BAD rate 10% → 0% at no real
precision cost (−5 is one prospect, inside noise), and archetype-derived depth is
defensible on its own terms. But it must not be credited with fixing anything.

### Why Enterprise AI is actually stuck

Three independent measurements put it at 60%, 55%, 55%. Inspecting the run gives
a different diagnosis than the one above:

```
company archetypes:  11 startup · 5 growth · 6 enterprise
```

**Discovery drifts to startups**, so the profile substantially overlaps
"Industrial AI startups" rather than covering enterprise software vendors. And
inside those companies, keep-rate splits sharply by function:

| Function | n | keep-rate |
|---|---|---|
| founder / CEO | 22 | **45%** |
| product | 10 | 20% |
| deployment / solutions | 6 | 17% |
| engineering | 7 | 14% |
| other | 14 | 7% |

At a startup, the founder is the only reliably good target for this mission —
everyone else is a MAYBE. So a profile whose companies are half startups cannot
fill 20 slots with GOODs unless it contacts roughly one founder per company,
which is exactly what the one-person-per-company de-clumping already limits.

**This is a profile-definition problem more than a pipeline one.** "Enterprise AI
with industrial relevance" as written admits a company population whose
non-founder employees are mostly wrong for the mission. The concrete next step is
to make Market Discovery hold the intended archetype — the mission asks for
enterprise software vendors with real industrial deployment, and returning
seed-stage startups is a `WRONG_COMPANY_ARCHETYPE` diagnosis the agent has in its
vocabulary but did not use here.

### Iteration 6 — segments declare the kind of company they hunt · **KEPT**

**Hypothesis.** Enterprise AI is not limited by person selection or pool depth.
It is limited because Market Discovery has no statement of *what kind of company*
the segment wants, so it returns on-topic companies of the wrong scale — and at a
startup, only the founder is a good target for this mission.

**Change.** Mission Strategist 1.1.0 declares `intended_archetype` per segment.
Market Discovery 2.1.0 is told what it is hunting and instructed to diagnose
`WRONG_COMPANY_ARCHETYPE` rather than quietly keeping wrong-scale companies. The
diagnosis already existed in its vocabulary; it had nothing to measure drift
against.

**Measured** — Enterprise AI with industrial relevance:

| | Iter 5 | **Iter 6** |
|---|---|---|
| Precision@20 | 55% | **80%** |
| GOOD split | 11 (0hi/11role) | **16** (9hi / 7role) |
| BAD rate | 0% | 5% |
| **Discovery precision** | 80% | **98%** |
| Search-space diagnoses | mixed | **all HEALTHY** |

**+25 points**, and discovery precision reached 98% — the strategist produced a
segment explicitly targeting *"horizontal enterprise AI / cloud giants'
manufacturing units"*, which is the enterprise-scale supply the profile had been
missing entirely. The GOOD split also shifted from entirely role-based to
majority high-evidence, meaning the people found are not merely plausible but
publicly verifiable.

The resulting list is unambiguously on-segment:

```
Jon Sobel                — Co-Founder & CEO @ Sight Machine
Anoop Mohan              — Chief Product & Technology Officer @ Augury
Will Barley              — Director of Forward Deployed Engineering @ Gecko Robotics
Anna-Katrina Shedletsky  — CEO, Founder @ Instrumental
Dan Kearns               — CTO @ Falkonry
```

**Verdict: KEEP.** This is the change that unblocked the failing profile, and it
came from inspecting a run rather than from a plausible-sounding theory — the two
preceding hypotheses about this same profile were both measurably wrong.

---

## 10. Remaining failure modes

**1. Market Discovery does not hold the intended company archetype.** The
"Enterprise AI" profile asks for enterprise software vendors with real industrial
deployment and receives 11 startups out of 22 companies. The agent has
`WRONG_COMPANY_ARCHETYPE` in its diagnosis vocabulary and did not use it. This is
now the highest-confidence remaining fix, and it replaces the pool-depth
hypothesis, which iteration 5 disproved.

**2. Best-person hit rate is the weakest agent metric** — 50–83% across profiles,
against a ≥70% target, and it moves more with company archetype than with any
change made this phase. Ranking sees the same evidence the judge sees, so when
the researched dossier is thin the ordering is close to arbitrary.

**3. Company rejection accuracy: 0–50%**, far below the ≥90% target, on small
samples. The judge flagged ABB as *"clearly wrong … exactly the costly error the
mission warns against"*. The MAYBE-passes gate is not permissive enough for large,
obviously-real industrial companies.

**4. Judge batch composition affects results by ~1 prospect.** The same profile
measured 70% / 75% / 70% across runs. Any single-profile delta under ~10 points
should be treated as noise; only repeated measurement or a trend across runs is
signal.

**5. `runRanking` has no cache key**, so every re-run re-scores every prospect.
That is the dominant wall-clock cost of a cached eval and pure waste.

**6. Eval-fixture defect.** The "technically ambitious startups" profile carries
`geography: 'United States'` as a field while its goal *text* never mentions it,
so the agent was penalised for honouring a constraint the judge could not see.

---

## 11. Recommendation

**Do not move to the Talent Knowledge Base yet — but it is close.**

The case for finishing scouting first is that TKB and Positioning both consume
the scouting output. Positioning answers *"which 1–3 things about this person
make them unusually interesting to THIS prospect?"*, which is only worth
answering for prospects worth writing to. Building it on a list that is 69%
GOOD means roughly a third of the positioning work is spent on people who should not
be contacted.

The remaining scouting work is also small and well-identified: archetype-aware
pool depth is a one-line change with a clear hypothesis, and it addresses the
only profile below threshold.

**Recommended order:**

1. Make Market Discovery enforce the segment's intended company archetype, and
   diagnose `WRONG_COMPANY_ARCHETYPE` when results drift to the wrong kind of
   company. This is what actually holds Enterprise AI below the floor.
2. Re-run Enterprise AI; it has measured 60/55/55 across three configurations.
3. Add a ranking cache key — every re-run currently re-scores every prospect,
   which is the dominant wall-clock cost of a cached eval.
4. Re-score the three v2-judged baselines under v3 so every delta is honest.
5. **Then** move to TKB and Positioning.

The system already produces lists that answer the product question — *"would I
actually want to email these people?"* — with a clear yes at the top:

```
Darren Haverkamp   — Technical Director @ Colgate-Palmolive
Tim Sarvis         — Director, Digital Manufacturing @ Eastman
Zoe Burkitt        — Digital Transformation Director @ Celanese
Kevin Fitzgibbon   — Associate Director, Digital Manufacturing AI/ML @ Kraft Heinz
Terry Chung        — Senior Director, Process Engineering & Technology @ PepsiCo
```

That is the output of a system, not of a database query, and it is the strongest
evidence that the architecture is right even though two thresholds are not yet
met.

---

## 12. Status at hand-off

Iteration 6 (archetype-holding) landed after the `final3` suite was measured, so
the table in §9 predates the single largest fix. Re-validation (`final4`) is in
progress. Measured so far under the current code:

| Profile | §9 (final3) | With archetype-holding |
|---|---|---|
| Industrial AI startups | 70% | **75%** |
| Enterprise AI with industrial relevance | 55–60% | **80%** |
| Chemical / manufacturing innovation | 75% | *re-measuring* |
| Operations / industrial consulting | 65% | *re-measuring* |
| Technically ambitious startups | 75% | *re-measuring* |

Both re-measured profiles improved, and neither of the two unchanged profiles has
a reason to regress — but that is a prediction, not a measurement, and the
remaining three are what decide the milestone. On the §9 figures with the two
new numbers substituted the average is **74%**, against a 75% target: close
enough that the outcome turns on the three profiles still running.

**Do not report the milestone as met until `final4` completes.** The whole point
of the eval discipline in this phase was that plausible-sounding expectations
were wrong three times out of six.

---

## 13. Cost refactor and the working prototype

Priorities changed mid-phase: the goal became a usable prototype at low runtime
cost rather than the last few points of Precision@20. The eval work was stopped
where it stood (§12) and the remaining effort went into cost architecture and
product surface.

### Where the money was going

A run cost ~$18 and produced ~20 prospects. Two stages held almost all of it:
person research (~$12 — ~60 people at ~$0.20, most later discarded) and company
validation (~$4). Both ran on the strongest model, and person research ran on
**every enriched candidate**, including people the pipeline dropped moments
later.

### What changed

**Model routing by tier** ([ADR-021](ARCHITECTURE.md#adr-021)) — CHEAP /
STANDARD / PREMIUM, default CHEAP, per-agent minimum tier, env-overridable
tier→model mapping, spend recorded per tier, escalations logged with reasons.

**A triage gate** — a CHEAP agent judges one company's Apollo metadata against
that company's already-researched profile and names the two or three people worth
researching deeply. No web search; it sees the whole slate at once because
relative judgment is easier than absolute.

**Escalation on schema failure** — the first measured run lost a prospect to a
cheap-tier validation failure *after* paying to research them. The loop now
escalates one tier and retries rather than discarding the work.

### Measured: one full mission

| | |
|---|---|
| Anthropic cost | **$5.54** |
| Prospects returned | **13** |
| Cost per prospect | **$0.43** |
| Apollo credits | 22 |
| Web searches | 102 |
| Model calls | 64 |
| Runtime | 527 s |

| Agent | Cost | Share | Tier |
|---|---|---|---|
| person_research | $2.30 | 42% | standard |
| company_validation | $1.90 | 34% | cheap |
| market_discovery | $0.86 | 15% | standard |
| ranking | $0.29 | 5% | cheap |
| mission_strategist | $0.10 | 2% | standard |
| person_triage | $0.09 | **2%** | cheap |

Funnel: 16 companies discovered → 16 validated → 124 stubs → 40 enriched →
**15 triaged** → 15 researched → 13 ranked.

Triage costs 2% of the run and removes 25 deep researches, which is the single
largest saving. Cheap-tier calls are 48 of 64 but only 30% of spend.

**Down from ~$18 to $5.54 per run**, with the same funnel shape and no measured
quality loss.

### The prototype

`/dashboard/scout` — enter a mission, run it, get a ranked shortlist. Each
prospect card shows why the company fits, why the person, why *you* to them,
which background items the claim rests on, the score broken down by dimension,
risks, the research evidence, LinkedIn and contact availability. Run cost, Apollo
credits and the funnel are displayed with the results, and any errors during the
run are surfaced rather than swallowed.

Top of the measured run — the product question, answered:

```
81  STRONG  Sibendu Som          Director, AI Applications Initiative @ Argonne National Laboratory
78  STRONG  Michael Venteicher   Senior Director, Smart Manufacturing @ Cargill
73  MAYBE   Jonathan Huggins     Process Automation Director @ Dow
73  MAYBE   Pedro Piovesan       Global Director of Applications Engineering @ TRACTIAN
72  MAYBE   Anoop Mohan          Chief Product & Technology Officer @ Augury
70  MAYBE   Nate Oostendorp      Founder and CTO @ Sight Machine
```

The tail is weaker — a project manager at a small consultancy at #7, and one
WEAK at 41 — so the honest read is roughly **8–10 genuinely useful prospects out
of 13**, not 13 of 13.
