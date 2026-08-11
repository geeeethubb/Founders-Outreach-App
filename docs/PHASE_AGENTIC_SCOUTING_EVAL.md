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

## 8. Remaining failure modes and recommendation

*(Populated after iteration.)*
