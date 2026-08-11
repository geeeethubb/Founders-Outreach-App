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

## 5. Baseline results

*(Populated from `.eval-runs/baseline.json`.)*

---

## 6. Iteration log

*(Each entry: hypothesis, change, expected, measured, keep/revert.)*

---

## 7. Remaining failure modes and recommendation

*(Populated after iteration.)*
