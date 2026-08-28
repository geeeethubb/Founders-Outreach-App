# Evals — Outreach OS V2

> Evaluation criteria for research, ranking, positioning, and outreach.
> Companion docs: [PIPELINE.md](PIPELINE.md) · [AGENTS.md](AGENTS.md)

---

## 1. Two kinds of evaluation

Do not confuse them. They answer different questions and run at different times.

| | **Gate evals** | **Offline evals** |
|---|---|---|
| Question | Is *this* output good enough to proceed? | Is the *system* getting better? |
| When | Inline, every run | On a fixed dataset, when prompts change |
| Blocking | Yes | No |
| Phase | 8 | 8+, grown over time |

Phase 8 ships gate evals. Offline evals come after, once there is a corpus of real drafts and
real outcomes to build a fixture set from.

---

## 2. Structure of a gate eval

Every gate runs **deterministic checks first, then an LLM judge.**

Deterministic checks are free, instant, reproducible, and catch the most common failures.
Running them first means the judge is never spent on a draft that is already disqualified by
a word count or an unresolvable citation.

```
draft ──► deterministic checks ──► fail ──► revise (≤2) ──┐
              │ pass                                       │
              ▼                                            │
          LLM judge ──► fail ──────────────────────────────┘
              │ pass                            │ budget exhausted
              ▼                                 ▼
       approval queue                  approval queue (FLAGGED)
```

**A draft is never silently discarded.** ([ADR-010](ARCHITECTURE.md#adr-010).) One that
exhausts its revision budget still reaches the human, flagged with its failures shown. A
pipeline that hides its failures trains its operator to trust it more than it has earned.

---

## 3. Outreach evals — the eight criteria

The gate before the approval queue. Each criterion scores **0–1** with a written justification.

### Scoring bands

| Band | Meaning |
|---|---|
| 0.8–1.0 | Strong — no action |
| 0.6–0.79 | Acceptable — passes, noted |
| 0.4–0.59 | Weak — triggers revision |
| 0.0–0.39 | Failing — triggers revision; two of these block the pass |

---

### 3.1 RELEVANCE — *Does this recipient genuinely make sense?*

**Threshold: 0.7. Hard blocker.**

| Score | Looks like |
|---|---|
| 1.0 | Directly owns the relevant initiative; opportunity plausibly exists here |
| 0.7 | Right function, right company; ownership uncertain |
| 0.4 | Right company, wrong function |
| 0.0 | No credible path from this person to the mission objective |

Failing relevance is **not** revisable by rewriting. The person is wrong, not the email.
Revision is skipped and the draft is rejected back to ranking with a reason. Rewriting a
well-crafted email to the wrong person is the most expensive way to fail.

---

### 3.2 SPECIFICITY — *Could this have been sent to 100 other people?*

**Threshold: 0.7. Hard blocker.**

The operative test: **swap in a different recipient at a different company. Does the email
still read as coherent?** If yes, it is a mail merge and fails.

| Score | Looks like |
|---|---|
| 1.0 | Only sendable to this person — references their specific work, decision, or situation |
| 0.7 | Company-specific but not person-specific |
| 0.4 | Industry-specific only |
| 0.0 | Fully swappable |

**Named-entity insertion is not specificity.** "I saw Acme is doing great things in
manufacturing" scores 0.2 — the company name is a variable, not an insight. This is the most
common way personalized outreach fails while looking personalized, so the judge is instructed
on it explicitly.

---

### 3.3 POSITIONING — *Does it feature the strongest relevant evidence about the user?*

**Threshold: 0.6.**

Cross-checked against the `positioning_angles` row: did the email actually use the selected
proof points, and did it use them well?

| Score | Looks like |
|---|---|
| 1.0 | Leads with the strongest proof point, framed for this recipient's priorities |
| 0.7 | Uses selected proof points but frames them generically |
| 0.4 | Uses weaker evidence than what was available |
| 0.0 | Generic self-description, or a résumé dump |

Also fails if the email uses **more than 3** proof points. Cramming is a positioning failure,
not a brevity failure — it means no selection actually happened.

---

### 3.4 BREVITY — *Is every sentence earning its place?*

**Threshold: 0.6.**

**Deterministic pre-check:** > 200 words → automatic revision, no judge call.

There is deliberately **no minimum word count.** V1 mandated 120–160 words, which caused the
model to pad to reach the floor. The judge asks a better question: *which sentence could be
deleted without loss?* If the answer is "any of them," it fails.

| Score | Looks like |
|---|---|
| 1.0 | Nothing removable |
| 0.7 | One sentence could go |
| 0.4 | A paragraph could go |
| 0.0 | Half could go |

---

### 3.5 PERSONALITY — *Does the writing sound human and confident?*

**Threshold: 0.6.**

Targets the voice in [PRODUCT.md §9](PRODUCT.md#9-outreach-voice): founder-to-founder,
direct, curious, confident.

Fails on: hedging stacks ("I was just wondering if you might possibly"), apologizing for
existing ("sorry to bother you"), and — importantly — on **over-correction into fake
swagger**. Confidence that isn't earned reads worse than politeness.

---

### 3.6 CLAIM ACCURACY — *Are personalization claims supported?*

**Threshold: 1.0. Zero tolerance. Hard blocker.**

**Deterministic first — this is the check with real teeth.** Every entry in the draft's
`citations` array must resolve to a `research_facts` row with `type='FACT'` and a non-null
`source_url`. An unresolvable citation fails immediately, before any judge runs.

Then the judge verifies the harder half: does each cited fact **actually support** the claim
as phrased? A fact saying "Acme raised a Series B in March" does not support "congrats on
your recent Series C."

Then the judge sweeps for **uncited factual claims** — assertions about the recipient with no
citation entry at all. Each one fails the criterion.

This is [ADR-011](ARCHITECTURE.md#adr-011) in practice: hallucination becomes a foreign-key
problem rather than a matter of prompt discipline. No amount of persuasive writing gets a
claim past a `NULL` lookup.

**Inferences may appear**, but only hedged — "it looks like," "I'd guess" — never asserted.
An inference phrased as fact fails.

---

### 3.7 CTA — *Is the ask obvious and easy to respond to?*

**Threshold: 0.7.**

| Score | Looks like |
|---|---|
| 1.0 | One ask, specific, low-commitment, answerable with "yes" |
| 0.7 | Clear but vague on scope ("would love to chat sometime") |
| 0.4 | Multiple asks, or unclear what a yes commits to |
| 0.0 | No ask, or a large one |

**Deterministic pre-check:** more than one question mark in the final paragraph is a strong
multiple-ask signal and is flagged for the judge.

---

### 3.8 CRINGE TEST — *Flattery, buzzwords, fake familiarity, generic networking?*

**Threshold: 0.7. Hard blocker.**

**Deterministic banned-phrase list** (matched case-insensitively, maintained in
`lib/evals/deterministic.ts`):

```
"I hope this email finds you well"        "reaching out"
"I came across your profile"              "picking your brain"
"touch base"                              "circle back"
"synergy" / "synergies"                   "leverage" (as a verb)
"game-changer"                             "revolutionary"
"I'm a huge fan of your work"             "your inspiring journey"
"quick question" (as an opener)           "let me know if you'd be open"
```

Then the judge catches what a word list cannot:

- **Flattery inflation** — praise disproportionate to what the user could actually know
- **Fake familiarity** — writing as though a relationship exists
- **Buzzword density** — jargon substituting for a specific thought
- **Networking-speak** — "expand my network," "connect and learn from you"
- **Visible AI personalization** — the tell where a fact is inserted with no reason for
  mentioning it: *"I noticed you studied at X. Anyway, I'm reaching out because…"*

That last pattern is the one worth catching hardest. It is the signature of automated
personalization and it makes the recipient trust nothing else in the email.

---

### Pass rule

A draft passes when:

1. Every **hard blocker** meets its threshold: relevance ≥ 0.7, specificity ≥ 0.7,
   claim accuracy = 1.0, cringe ≥ 0.7
2. **No** criterion scores below 0.4
3. Mean of all eight ≥ 0.7

Otherwise: revise with the specific failing critiques, **maximum 2 revisions**, then queue
flagged.

---

## 4. Research evals

Runs on the dossier before positioning. Cheap, mostly deterministic.

| Check | Rule | Type |
|---|---|---|
| **Sourcing** | Every `type='FACT'` has a resolvable `source_url` | Deterministic — **hard fail** |
| **Minimum grounding** | ≥ 2 items of `type='FACT'` | Deterministic — gates stage 7 |
| **Type honesty** | Judge samples items: is anything typed `FACT` actually an inference? | Judge |
| **Mission relevance** | ≥ 60% of facts bear on the mission, not generic biography | Judge |
| **Uncertainty honesty** | A thin dossier with zero `UNKNOWN` items is suspicious | Judge — warn |
| **Recency** | `recent_developments` are actually recent | Deterministic where dated |

The uncertainty check exists because the natural failure mode of a research agent is
confident completeness. A dossier on an obscure Director at a private company that contains
twelve confident facts and no unknowns is far more likely to be fabricated than thorough.

---

## 5. Ranking evals

Ranking has no single right answer, so these check **coherence and calibration**, not accuracy.

| Check | Rule | Type |
|---|---|---|
| **Explanation present** | Every component has a non-boilerplate explanation | Deterministic |
| **Evidence present** | Components above 0.7 cite evidence | Deterministic |
| **Confidence coherence** | High confidence requires evidence volume to match | Deterministic |
| **Range use** | A batch where everything scores 0.7–0.8 is not discriminating | Deterministic — warn |
| **Score/explanation agreement** | Does the explanation justify the number? | Judge, sampled |
| **Anti-fame** | Is `opportunity_fit` tracking mission fit, or company prestige? | Judge, sampled |

The anti-fame check directly targets V1's known failure. V1's own prompt fought this in prose
("Fame is not fit"); V2 measures it. A famous company that fails the mission's opportunity
criteria should score low on fit and possibly high on attractiveness — those are different
dimensions, and conflating them is the failure to detect.

The range-use check catches a subtler problem: an agent that scores everything near 0.75 has
produced a ranking with no information in it, while looking like it did its job.

---

## 6. Positioning evals

| Check | Rule | Type |
|---|---|---|
| **Proof point count** | 1–3 selected, never more | Deterministic — **hard fail** |
| **Real references** | Every `talent_item_id` exists | Deterministic — **hard fail** |
| **Evidence refs resolve** | `evidence_refs` point to real dossier facts | Deterministic — **hard fail** |
| **Thesis completeness** | All four fields present and non-empty | Deterministic |
| **What-not-to-mention** | Present (may be empty **only** with reasoning) | Deterministic |
| **Intersection is real** | Is the intersection specific, or "both interested in AI"? | Judge |
| **Priority grounding** | Are their priorities inferred from evidence or assumed? | Judge |

The intersection check is the important one. A vague intersection produces a vague email, and
every downstream eval will then fail in ways that look like writing problems but are not.
When specificity fails at stage 9, the cause is usually here.

---

## 7. Implementation

```
lib/evals/
  types.ts           EvalCriterion, EvalResult, EvalVerdict
  deterministic.ts   Word count, banned phrases, citation resolution, count checks
  judge.ts           LLM rubric evaluation (reasoning role)
  rubrics/
    outreach.ts      The eight criteria
    research.ts
    ranking.ts
    positioning.ts
  run.ts             Orchestrates: deterministic → judge → thresholds → verdict
```

Every result persists to `evaluations`:

```ts
{
  subject_type: 'draft' | 'dossier' | 'score' | 'positioning'
  subject_id:   string
  criterion:    string
  score:        number
  verdict:      'pass' | 'fail' | 'warn'
  justification: string
  is_deterministic: boolean
  revision_number: number   // 0 = original
  agent_run_id:  string | null
}
```

Keeping every revision's evaluations — rather than overwriting — makes the revision loop
inspectable. "It failed specificity twice and passed on the third try" is a much more useful
record than a final pass, and it is the raw material for improving the Outreach Agent's prompt.

---

## 8. Scouting evals (Phase 3 — implemented)

The first gate that actually ships. It sits **before** research and positioning:
it asks whether the people the system surfaced are worth spending those
expensive stages on at all.

Implemented in `evals/phase3/`, run with `npm run eval:phase3 -- <iteration>`.
Results and iteration history: [PHASE_3_EVAL.md](PHASE_3_EVAL.md).

### Four deterministic checks

| Check | Rule | Threshold |
|---|---|---|
| **Data completeness** | name, title, company, Apollo id, and a resolvable company relationship | ≥ 95% |
| **Duplicate rate** | residual duplicates after dedupe, cross-checked on LinkedIn URL and name+company | < 2% |
| **Seniority calibration** | in a strategically appropriate band **for the company's size** | ≥ 80% |
| **Resume grounding** | every "why I fit them" cites only real resume item ids | 100% |

LinkedIn URL and email availability are **tracked but never fail a prospect** —
Apollo does not always expose them, and dropping otherwise-strong people for a
provider gap would distort the funnel rather than improve it.

Seniority calibration deliberately treats *appropriate* as distinct from
*maximum*: a C-suite exec at a 40,000-person corporation scores as **too
senior**, because they will not answer a cold student email, while a Director at
the same company is correct. See `lib/scouting/seniority.ts`.

### LLM-as-judge — Precision@20

A **separate prompt** (`evals/phase3/judge.ts`) that never sees the scorer's
numbers, explanations, or ranking. It is asked a different question — "would a
careful advisor keep this person on a high-priority list?" — and returns
GOOD / MAYBE / BAD.

The independence is the point. A judge shown the scores would anchor on them,
and Precision@20 would measure self-consistency rather than quality.

```
Precision@20 = GOOD verdicts in the top 20 / 20
```

The denominator is 20 by definition, not the number judged: a profile that could
only produce 14 prospects has genuinely underperformed at @20.

### Pass thresholds

Average Precision@20 ≥ 75%, no individual profile below 65%, and all four
deterministic checks passing.

### Why the judge's bar is set where it is

GOOD requires *all* of: the company operates where the user's background is a
real asset; the role touches that work; the person can create, sponsor or refer;
a cold email has a realistic chance of a reply; and you could state a specific
reason **this** person would care about **this** user.

"Not obviously bad" is MAYBE, not GOOD. That strictness is deliberate — the top
20 is supposed to feel curated, not scraped, and a looser bar would let the
metric rise while the product got worse.

---

## 9. Phase 6 additions — research evals in the scouting loop

Implemented in `evals/phase6/checks.ts`, running alongside the four Phase 3
checks. Full results: [PHASE_6_EVAL.md](PHASE_6_EVAL.md).

| Check | Rule | Threshold | Measured (consulting) |
|---|---|---|---|
| **BAD rate@20** | Share of the top 20 a careful advisor would strike off | ≤ 10% | 15% ❌ |
| **Research coverage** | Final top 20 with grounded company context | ≥ 95% | 100% ✅ |
| **Fact grounding** | FACT-typed claims carrying a source URL | 100% | 269/269 ✅ |
| **Cost per GOOD top-20 prospect** | Total model spend ÷ GOOD verdicts | operational | $0.98 |

### Why BAD rate is tracked separately from precision

They move independently. A list can be 50% GOOD with 0% BAD (lots of defensible
maybes) or 50% GOOD with 30% BAD (erratic). The second is far worse for trust:
every BAD entry teaches the operator to second-guess the whole list, including
the good half.

### Fact grounding is true by construction

`validateClaims()` downgrades a `FACT` without a resolvable URL to `INFERENCE`,
and separately downgrades any FACT citing a URL the web search did not return.
So the check is a **regression guard on an invariant**, not a hopeful
measurement — which is the same pattern as the claim-citation gate in §3.6.

### A limit of Precision@20 this phase exposed

When research and judge independently agree that a candidate *pool* is mediocre,
Precision@20 correctly reports a low number while the system is behaving
correctly. That is a supply problem wearing a ranking problem's clothes.

Pair it with a **supply-quality metric** — the share of researched companies
rated mission-relevant (60% on the consulting profile; 40% rejected) — so the two
are distinguishable at a glance.

---

## 12. Phase 10 — internal retrieval and reference writing

Two new evals, and they answer two questions that had never been asked.

### 12.1 Internal network retrieval — `npm run eval:network`

> **Can Outreach OS mine an existing network of ~900 contacts for a new mission,
> without the founder sorting them by hand?**

Five missions over the same 897 contacts: industrial/engineering consulting,
industrial AI, chemicals and energy, startup founders, professional mentors.
Chosen so that the **same database must produce five different shortlists** — a
retrieval layer that returns the same twenty senior industrial names whatever it
is asked has learned to rank prestige, not relevance, and that failure is
invisible when only one mission is ever evaluated. Two of the five point away
from the database's centre of mass on purpose, so "the network is thin here" has
to be sayable.

| Metric | What it catches |
|---|---|
| Pool considered | The denominator. How many contacts retrieval could reach at all. |
| Survived cheap retrieval | Distinct contacts any search surfaced — the free filter's yield. |
| **Precision@20** | Judged GOOD among the top 20. Same judge, same rubric as Phase 7's external number, so internal and external lists are directly comparable. |
| **BAD rate@20** | Tracked separately, for the reason in §9: a list can be 50% good and still unusable if the rest are embarrassing. |
| **Missed** | People a search surfaced, the judge called GOOD, and the agent did not shortlist. This is the recall side, and it is the number that moved most. |
| External runs avoided | How often the sufficiency decision skipped discovery entirely. |
| Apollo credits avoided | The direct saving. |
| Index cost | One-off, amortised across every future mission. |

**The judge is reused deliberately.** `evals/agentic/judge.ts` produced Phase 7's
Precision@20 for externally discovered prospects. Using the same instrument makes
"is mining the network as good as buying strangers?" a question the numbers can
answer, rather than two incomparable scales.

**The judge never sees the retrieval agent's reasoning or its scores** — only the
stored research. Showing it either would make precision measure self-consistency.

**One disclosed substitution.** Migrations are applied by hand, so until 013 is
applied the eval injects an in-memory full-text backend through a seam on the
search tool (`evals/network/local-index.ts`). Everything carrying judgment is
real: the classifier over the real database, the retrieval agent and its
reformulation, the ranking agent, the sufficiency decision. What is not measured
is Postgres FTS itself, which is an index lookup rather than a decision. Every
report states which backend produced its numbers.

### 12.2 Campaign reference writing — `npm run eval:reference`

> **Does pasting one real email actually change how the system writes, in the
> direction the user asked for?**

Deliberately **not** "is this a good cold email?". That question has a house
answer, and the house answer is exactly what this milestone removes.

**It is a controlled comparison.** Every prospect is written twice — once in
reference mode, once in the house style — and both are judged blind, in the same
batch, against the same reference. Without the control a similarity score is
unreadable: 3.8 could mean the feature works, or that the house style already
happened to sound like this user. **The delta is the measurement.**

Four campaigns with genuinely conflicting voices, three recipients, all twelve
pairings. Two campaigns deliberately violate the old house rules — one is 190
words where the rule said 60–120, one stacks two asks where the rule said exactly
one. If the system still produces a punchy 90-word single-ask email, the
reference is decorative.

Six judged criteria, from the requirement:

| Criterion | Question |
|---|---|
| Reference similarity | Does it read as the same writer, same campaign, different recipient? |
| Recipient relevance | Genuinely adapted, or would it work for a hundred others? |
| Fact grounding | Is every claim about the recipient supported? |
| Naturalness | Does it avoid machine cadence? |
| CTA fit | Does the ask suit this recipient *and* match the reference's shape? |
| Template avoidance | Did it avoid transplanting the reference recipient's own details? |

Plus deterministic detectors that run first and have teeth — placeholders,
over-compression against the reference's length, verbatim spans, reference-
recipient facts reused, arrogance, fake familiarity, AI tells. Anything
mechanically checkable is checked in code so the judge is only asked what
genuinely needs judgment.

**Two calibrations worth recording**, both found by unit tests:

- A verbatim span is only copying when it carries *content*. "would you have
  twenty minutes" is the CTA pattern, which a new email in the same campaign
  **should** reproduce — flagging it would mark the feature working as the
  feature failing.
- An AI tell the reference itself uses is not a tell. The reference wins.

---

## 10. Phase 7 — agentic scouting evals

The scouting pipeline became a set of decision-making agents, so the eval had to
grow past "is the final list good?" to "is each agent making good decisions?".
A list can be mediocre because discovery found the wrong companies, because the
right company yielded the wrong person, or because ranking mis-ordered a good
pool — and those need different fixes.

Run with `npm run eval:agentic -- <tag> [profileId ...]`. Results land in
`.eval-runs/<tag>.json` so runs are comparable.

### The five profiles

| Profile | What it stresses |
|---|---|
| Industrial AI startups | small companies where a founder can create a role |
| Chemical / manufacturing corporate innovation | large operators; appropriate-seniority targeting |
| Operations / industrial consulting | a segment Phase 6 measured at 20% precision |
| Enterprise AI with industrial relevance | distinguishing real deployment from a marketing vertical |
| Technically ambitious startups | differentiation rather than qualification |

A profile is a **mission framing**, not a search. It supplies the goal and
constraints; the Mission Strategist generates its own hypotheses. Nothing in
`evals/agentic/profiles.ts` names a company or a person — that would be the
overfitting the eval exists to detect.

### Primary metric — Precision@20

| Metric | Threshold |
|---|---|
| Average Precision@20 | ≥ 75% |
| Minimum profile Precision@20 | ≥ 65% |
| BAD rate@20 | ≤ 10% |

`GOOD` means: *I would genuinely send this person a thoughtful, personalized
email for this mission.* `MAYBE` counts as neither a hit nor a miss.

### Agent-level metrics

| Metric | Question | Threshold |
|---|---|---|
| Market Discovery Precision | of companies passed into Apollo, how many were good targets? | ≥ 80% |
| Company Rejection Accuracy | of companies rejected, how many *should* have been? | ≥ 90% |
| Search Recovery | when a search space is bad, does the agent recover or correctly abandon it? | ≥ 80% |
| Best-Person Hit Rate | inside a good company, did we find one of the best available people? | ≥ 70% |

Plus efficiency: Apollo enrichments per GOOD prospect, and Anthropic cost per
GOOD prospect.

### Judge independence is a structural property, not an intention

The judge:

- runs from a **different prompt with different rubric vocabulary**
- **never sees** component scores, totals, ranks, or the ranking agent's prose
- is asked a **different question** — "would you send this?" rather than "score
  these dimensions"
- **cannot search the web**, so it evaluates the candidate the pipeline actually
  produced rather than a better-informed version of them

> The first implementation passed the judge `why_they_fit` — which is the
> *ranking agent's own justification*. Precision@20 would have measured how
> consistent the system is with itself, and it would have looked excellent doing
> it. The judge now receives the person-research dossier and nothing the scorer
> wrote.

### Search Recovery is measured only where it applies

A segment that was healthy throughout is `not_applicable` and is **excluded from
the denominator**, so a run of easy segments cannot inflate the rate.

Where a round did diagnose trouble, there are exactly two successes:

- **recovered** — a later round produced companies after the bad diagnosis
- **correctly_terminated** — the agent killed the hypothesis instead of grinding

and one failure: **kept searching, kept finding nothing**. Abandoning a
`LOW_SUPPLY` segment scores exactly as highly as rescuing one. An agent that
cannot give up will always spend its entire budget on its worst segment, because
refinement always *looks* like progress. See
[ADR-020](ARCHITECTURE.md#adr-020).

### Best-Person is judged against the real alternatives

The judge sees who was chosen **and every other person Apollo surfaced at that
company**. "Was this the best person?" is meaningless against an imaginary ideal
who may not work there. If every alternative was worse, the choice was correct
even if imperfect.

### Empty denominators are `n/a`, never 0%

A profile that rejected no companies has no rejection accuracy. Averaging a zero
in dragged the aggregate under threshold and would have sent an iteration
chasing a failure that did not exist. `averageWhereMeasured` skips them and
reports how many profiles actually contributed.

### Precision@20 only measures selection if there is selection

**This turned out to be the single largest lever in the phase**, worth more than
every prompt change combined.

At baseline the pipeline researched ~32 people and published 20 — a **71% publish
ratio**. That is not a curated list; it is everything that survived, and
Precision@20 was largely measuring the funnel rather than the ranking. Widening
the pool to 60 researched (38% publish ratio) moved the worst profile from 45% to
80%.

Two rules learned from getting this wrong once:

- **Widen by going deeper inside validated companies, not by finding more
  companies.** Iteration 3 raised the pool by asking discovery for 10 companies
  per segment instead of 7. Precision rose, but company precision fell 79% → 69%
  and the BAD rate doubled — discovery had been pushed past the good candidates.
  Mining already-validated companies more deeply costs no company quality.
- **A wider pool is also cheaper.** Credits stop being spent on people who are
  dropped later: the 80% run cost $7.19 and 23 credits against the 45%
  baseline's $12.55 and 34.

### The judge is the instrument — change it deliberately, and re-score

Changing the judge invalidates every prior number. When the v2 → v3
recalibration was made, the baseline was **re-scored** with
`scripts/rejudge-run.ts`, which reconstructs a completed run's top-20 from
persisted `agent_runs`. Before and after are always compared under the same
instrument.

Never freeze a judge you have shown to be wrong, and never quietly swap one in
either.

### Cache keys must cover deterministic post-processing

`company_validation` normalizes the model's titles inside `validate()`, so a
cached `AgentResult` replays the **already-normalized** output. A fix to the
normalizer would have silently not applied to any cached company — and iteration
2 would have measured iteration 1's titles while appearing to test new ones.

That is the worst class of eval bug, because it produces a confident wrong number
rather than an error. The prompt version cannot cover it, since the prompt did not
change. `cacheKeyParts` carries an explicit `titles_logic` version instead.

---

## 11. Offline evals — later, deliberately

Once ~50 real drafts with outcomes exist, build a fixture set:

- **Golden set** — hand-labeled prospect/draft pairs with expected verdicts
- **Regression set** — real drafts that previously failed, to confirm they still fail
- **Calibration set** — drafts with known outcomes, to check whether eval scores correlate
  with replies at all

**Do not build this in Phase 8.** With fewer than 50 examples, a fixture set encodes today's
guesses as tomorrow's ground truth — the tests would then measure agreement with an early
opinion rather than quality, and would actively resist improvement.

The same reasoning governs the learning system in
[PRODUCT.md §10](PRODUCT.md#10-outcomes-and-learning): at these volumes, statistics mislead.
Wait for signal.

---

## 12. Phase 9 — the send loop

Correctness evals, not quality evals. The question is whether the loop behaves, not whether
a model wrote something good — so most of this is deterministic assertion rather than
judgment, and there is no LLM judge anywhere in it.

### Claim-safety gate — `npm run probe:grounding`

Two rates, and both matter. A gate with false negatives sends lies; a gate with false
positives gets switched off, and then it protects nothing.

| Measure | Target | Result |
|---|---|---|
| Fabrications blocked | 100% | **8/8** |
| Real drafts cleared | high | **9/10** — the block was correct |

The eight fabrications are one per detector: invented dollar figure, invented percentage,
inflated real number, invented programme name, invented acronym, invented superlative,
invented recipient responsibility, plus a grounded control that must PASS.

**A blocked real draft is not automatically a false positive.** The first run blocked 9 of 10
and the cause was an impoverished evidence pool, not an over-eager gate
([ADR-023](ARCHITECTURE.md#adr-023)). Diagnose before loosening.

### Conversation agent — `npm run eval:conversation`

14 hand-written reply fixtures, one agent call each. No judge: the ground truth is written
down, so a judge would add cost and a second opinion nobody asked for.

| Measure | Target | Result |
|---|---|---|
| Classification | — | **14/14** |
| Action | ≥90% | **14/14** |
| Critical misses | 0 | **0** |
| Ungrounded suggested replies | 0 | **0** |
| Cost | cents | **$0.0009 / reply** |

`CRITICAL_IDS` marks the four where a mistake is a product failure rather than a scoring
quibble: a hostile reply must CLOSE, a referral must be recognised, an explicit meeting
request must book, and politeness inflation must not read as interest.

**Fixture discipline.** `acceptable` lists every defensible *action*, because a REFERRAL is
reasonably FOLLOW_REFERRAL or REPLY and marking the second wrong measures the fixture
author's taste. `alsoAcceptable` does the same for classifications and is documented as
settable **only from reasoning about the reply, never from what the agent answered**.

The first run scored 86%. Both misses were label problems: one fixture's own note, written
before the run, already conceded the ambiguity; the other's reply text contained a temporal
qualifier the expected answer did not account for, so the **reply was rewritten** rather than
the expectation widened. Pre-correction and post-correction numbers are both recorded in
[PHASE_SENDING.md §5](PHASE_SENDING.md).

### Loop correctness — `npm run check:outreach`

Real rows in the real database, then deleted. Requires migration 012; exits 2 with
instructions if it is missing.

| | |
|---|---|
| Persistence | state, evidence pool and grounding survive a round trip |
| Gate | an ungrounded edit drops an approved row back to `draft` |
| Idempotency | three concurrent `claimForSend` calls produce **exactly one** winner |
| Idempotency | a send against a sent row is a no-op; exactly one `emails` row exists |
| Reply sync | a synced inbound message moves the outreach to `replied`, and re-running changes nothing |
| Immutability | a sent row cannot be redrafted |

**It does not send email.** Idempotency is verified at the compare-and-swap that provides it.
Proving you do not send two emails to a stranger by sending two emails to a stranger is a
poor experimental design.

### Deterministic units — `npm run test:deterministic`

226 assertions. The Phase 9 additions cover the transition table (including *every* state's
inability to reach `sending`), quantity normalisation and its exclusions (calendar years,
meeting durations, clock times), both evidence pools, and funnel arithmetic — including that
a reply rate below 5 sends is withheld rather than reported.

---

## 13. Phase 11 — Career OS evals

Six suites under `evals/career/`, run by `scripts/career-eval-*.ts` (`npm run eval:career-*`).
They run the product's own code paths in **no-database mode**: the Evidence Bank is built in
memory from the real master résumé (`lib/career/evidence/memory-bank.ts`), jobs come from
fixtures or live public ATS boards, and documents go to `.career-out/` (gitignored — the results
carry résumé text and are never tracked). Every judge is independent of the agents it scores:
different framing, ids blinded (`blindForJudge`), batches shuffled so rank order never leaks.

### 13.1 Fit ranking — `eval:career-fit` · 24 fixture JDs (8 strong · 6 good/stretch · 10 negatives)

| Metric | Target | Result | n |
|---|---|---|---|
| employment_type accuracy | ≥ 90% | **100%** | 24 |
| season_relevance accuracy | ≥ 90% | **95.8%** | 24 |
| location_tier accuracy | ≥ 90% | **100%** (83.3% before the metro-suburb fix) | 24 |
| role_family accuracy (lenient) | ≥ 80% | **91.7%** | 24 |
| eligibility accuracy | ≥ 80% | **95.8%** | 24 |
| NOT_QUALIFIED given to a strong/good job | 0 | **0** | 14 |
| negatives ranked above any positive | 0 | **0** (13 before the gates) | 24 |
| strong jobs in the top 8 | ≥ 6 | **7** | 8 |
| judge P@10 (blind) | ≥ 80% | **100%** | 10 |
| senior full-time decoy (shares vocabulary with the positives) | below every strong | rank 23/24 | |
| Summer 2026 decoy | below every strong | rank 18/24 | |

Cost: ~$1.75 per paid run (24 cheap extractions + 24 standard fit judgments + 1 judge batch);
$0 on re-run. Four iterations; the fixes were all deterministic (see 13.3).

### 13.2 Discovery — `eval:career-discovery` · 22 keyless benchmark boards + one live scout run

| Metric | Target | Result | n |
|---|---|---|---|
| duplicate rate (post-constraint canonicals) | < 3% | **0.0%** (31.9% before the dedupe fix — every cluster was a false merge) | 84 |
| canonical URL on the board's ATS host | ≥ 95% | **100%** | 84 |
| stale shown as open (every ATS-listed job re-verified) | < 3% | **0.0%** | 84 |
| parsed city appears in `location_raw` | ≥ 95% | **100%** | 84 |
| tier agrees with the benchmark's HQ tier | ≥ 90% | **100%** | 57 |
| internship classification (extractor vs strict title regex) | report | 97.3% — the one disagreement was the extractor being right | 37 |
| fit evaluations failed | 0 | **0** | 86 |
| job-first canonical first-party | ≥ 95% | 100% / 88.9% / 100% across runs (the miss: an aggregator lead stored `UNVERIFIED` with no first-party URL — by design) | 4–63 |
| **P@20 (blind judge, GOOD_FIT ∪ STRETCH)** | ≥ 80% | **65%** — see below | 20 |

**The P@20 miss, diagnosed rather than hidden.** On 2026-08-27, 9 of the 22 benchmark boards
listed no internships at all; 80 of the 131 internship postings came from two boards (Zipline,
Palantir — software/aerospace/PM-heavy, each truncated at the per-board cap of 40); a single
bounded job-first run added between 4 and 63 jobs depending on the day. The union held roughly
13 openings the judge called relevant to a chemical-engineering Summer 2027 mission, so a top 20
cannot reach 16 relevant rows. The ranking itself behaves: the top 3 are GOOD_FIT/STRETCH in
every run, and of the 7 BAD_FIT rows in the last top 20, 5 already sit in the WEAK band. The
follow-up (13.4) widens the pool rather than the target.

Constraint rejections on the 131 board postings: `Not a different season` 34–38 (Spring/Winter
2027 and 2026 cohorts), `United States` 8, `Internships only` 1.

### 13.3 What the two suites changed in the product

All deterministic, all with the target unchanged:

| Failure | Root cause | Fix |
|---|---|---|
| `Newark, NJ (Greater New York City area)` → tier 3; `Woburn, MA` → tier 3 | normalization: metro aliases knew only downtowns | suburb aliases per metro + `metroHints()` for "Greater X area" |
| a Summer 2026 posting ranked 4th at 0.70 while `NOT_QUALIFIED` and `other_season` | ranking arithmetic never read the eligibility verdict or the mission's hard constraints | `fitGates`: NOT_QUALIFIED ×0.5, a failed hard constraint ×0.6 **capped at 0.30**, `role_fit` below 0.35 scales the mean proportionally — applied identically at evaluation, on re-sum and in the eval |
| 31.9% "duplicates" — Palantir SWE interns across four cities, Spring-vs-Summer twins, template bodies with different titles | dedupe: the body-shingle test stood alone | same board + different ATS id ⇒ distinct; different title seasons ⇒ distinct; body similarity now requires title similarity ≥ 0.5 and overlapping locations |
| `Computational Physics Intern (Spring 2027)` carried `summer_2027` | normalization: the extractor read a shared template body | a title naming only non-summer seasons of the target year overrules the extractor |
| `Budapest, Hungary` passed the `United States` constraint | normalization: Hungary was not in the country list | ~60 countries + non-US city hints |
| 25 live fit calls on an unchanged corpus | harness: cache key hashed random memory-bank ids | key on a content hash of the rendered evidence |

### 13.4 Résumé factuality — `eval:career-factuality` · 8 adversarial JDs on the real résumé

| Metric | Target | Result | n |
|---|---|---|---|
| unsupported claims reaching output (tempting-term phrase match on SUPPORTED changes) | 0 | **0** | 28 |
| unsupported claims reaching output (independent faithfulness judge) | 0 | **0** — n=0 judged: every supported change was a reorder or an emphasis-only reword | 0 |
| planted fabrications caught by pre-check ∪ verifier | 100% | **100%** (pre-check 13, verifier 16) | 16 |

Plants: appended tools, replaced numbers, "Led a team of 12 to build", swapped titles, merged
bullets across experiences, an invented funding event. The two verifier-only catches are the
invented event and the merged project — structure the deterministic gate cannot see.

### 13.5 Minimal edit — `eval:career-minimal-edit`

| Case | Distance | Non-reorder changes | Levels |
|---|---|---|---|
| A · matched (process engineering) | **0** (≤ 0.08) | 3 (≤ 3), all emphasis-only | L2 ×3 |
| B · mismatched (computational chemistry) | 0 (≤ 0.30), changedFraction 0 | 1 | L1, L2 |
| C · adversarial | **0** (≤ 0.02) | 0 | L1 ×5 |

The approved alternate bullet planted for case B was not used — the tailor is conservative to
the point of never swapping on this résumé (see the gap in [BUILD_LOG.md](BUILD_LOG.md)).

### 13.6 Cover letter — `eval:career-cover-letter` · 4 real companies with live postings + 2 fictional

| Metric | Target | Result | n |
|---|---|---|---|
| deterministic grounding ok (after ≤ 1 retry) | 100% | **100%** (66.7% → 83.3% → 100% across three fixes) | 6 |
| one page (Word render) | 100% | **100%**, 0 letters needed the one-page retry | 6 |
| words 278–298 (band 200–290 + slack) · banned phrases | band · 0 | pass · **0** | 6 |
| fictional companies: proper nouns beyond the company name | 0 | **0** | 2 |
| judge means — truthfulness · professionalism · filler-absence · non-repetition · growth narrative · company specificity | report | 0.87 · 0.88 · 0.85 · 0.71 · 0.66 · 0.49 | 6 |

Company specificity is 0.75–0.95 where research produced grounded facts, 0.05 where the
researcher returned no claims (Formlabs), and 0.10–0.35 for the fictional companies by
construction — the price of not inventing. Of four "suspect claims" the judge raised, one was
provably wrong against the bank (it did not know CDI *is* the Argonne experience) and three were
about the tone of the ask; none was a fabrication.

### 13.7 Documents — `eval:career-documents`

30 résumés (10 company names × short/medium/long) + 10 cover letters: valid DOCX **40/40**,
valid PDF **40/40**, one page **40/40** (20 of 30 résumé variants exercised the shrink loop),
correct filenames **40/40**. Word render latency median 1.4 s; first render in a fresh Word
instance 8–110 s, paid once per process.

### 13.8 Discovery P@20 follow-up

Widening the pool (internship-only listings 120 per board instead of 40 after the filter; every
extracted job ranked) took P@20 from 65% to **85%** (n=20, 8 GOOD_FIT · 9 STRETCH · 3 BAD_FIT,
102 ranked, P@10 100%). A concurrent second run measured **70%** (6 BAD_FIT, P@10 80%): two PM
roles the judge called STRETCH in one run and BAD_FIT in the other, plus WEAK-band hardware
roles at ranks 18–20. Pooled, 31/40 = 77.5% against the 80% target. The pool on 2026-08-27 is
the binding constraint; the ranking's head is right in both runs.

