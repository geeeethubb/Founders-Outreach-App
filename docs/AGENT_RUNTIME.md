# Agent Runtime

How the runtime agents actually execute. Read this before changing anything in
`lib/agents/`.

This describes the **product's runtime agents** — TypeScript modules that run in
production for users. It is not about Claude Code subagents. See
[ARCHITECTURE.md §9](ARCHITECTURE.md).

---

## 1. What an agent is here

An agent is a **judgment problem with a schema**. Seven agents exist because
seven judgment problems exist. Adding an eighth requires a judgment problem none
of the others owns.

An agent:

- is **pure with respect to the database** — it never reads or writes Postgres
- **never calls another agent** — the orchestrator sequences them
- **may call tools**, because gathering evidence is the job
- **declares a schema** and is invalid if it does not satisfy it
- **owns a versioned prompt** in its own `prompt.ts`

The last three are what changed in Phase 7. Agents used to be single
model calls; now they run a bounded tool loop. The first two properties are
unchanged and are what keep this a pipeline rather than a swarm.

---

## 2. The loop

`lib/agents/runtime/loop.ts` is one shape serving every agent.

```
build prompt
  → model turn
      ├── server-side web_search   (Anthropic executes it, results return inline)
      ├── client-side tools        (we execute, results go back as tool_result)
      └── submit_result            (validated → done)
  → repeat until submit_result, or the step cap
```

### `submit_result` is the only way to answer

Every agent gets a `submit_result` tool whose `input_schema` is that agent's
output schema. Text outside that tool call is ignored.

This matters more than it looks. The alternative — asking for JSON in prose and
parsing it — fails in a specific way: the model returns *nearly* valid output,
the parser coerces it, and a subtly wrong object flows downstream looking fine.
Making "finish" a typed action means malformed output is a **tool-call
validation failure at the boundary**, not a parsing problem later.

### Invalid output is retried, not discarded

A rejected `submit_result` is handed back to the model with the reason, and it
gets one correction attempt.

This was not the original behavior, and the original behavior was wrong: a
discovery round that had run four web searches and found six real companies was
thrown away in full because one enum value was misspelled. The evidence was
fine; the envelope was not. Retrying costs one cheap turn and preserves work
already paid for.

### Bounded autonomy

Every loop is capped on **steps**, **web searches**, and **output tokens**, and
the whole run is capped on **total model calls** (`ANTHROPIC_MAX_CALLS_PER_RUN`)
and **Apollo calls** (`APOLLO_MAX_CALLS_PER_RUN`).

The agent chooses *what* to do. The code decides *how long it may keep choosing*.
That split is the entire safety story for autonomous search.

---

## 3. Evidence and grounding

### The evidence pool

Every source URL an agent may cite is harvested from two structural places:

| Source | What it is |
|---|---|
| `web_search_tool_result` blocks | the search results themselves — pages actually retrieved |
| `citations` on text blocks | the model tying a specific sentence to a specific page |

**Prose is never scanned for links.** A URL the model merely typed does not enter
the pool.

> **A bug worth remembering.** The first implementation harvested only from
> `citations`. But an agent whose final answer arrives as a `submit_result` tool
> call emits no cited *text* at all — so the pool was empty on every real run,
> and `validateClaimsAgainstEvidence` dutifully downgraded **every genuine FACT**
> to INFERENCE. The grounding mechanism was inverted: instead of catching
> fabrication it was destroying real sourcing. Measured before: 0/9 FACTs kept
> their source. After adding `web_search_tool_result`: 12/12.

### Three-way claim typing

| Type | Meaning | Enforcement |
|---|---|---|
| `FACT` | read in a retrieved page | **must** carry a `source_url` from the evidence pool |
| `INFERENCE` | reasoned, not read | labelled honestly |
| `UNKNOWN` | tried to establish, could not | a first-class output |

Enforcement is layered so no single layer has to be trusted:

1. `validateClaims` — a FACT without a resolvable `http(s)` URL is **downgraded**
   to INFERENCE, not dropped. The observation may still be useful; it simply is
   not verified.
2. `validateClaimsAgainstEvidence` — a FACT citing a URL the agent never
   *retrieved* is downgraded too. This kills the entire class of invented links.
3. `research_facts.fact_requires_source` — a database CHECK constraint. An
   unsourceable FACT cannot be stored at all.

Grounding is a schema property, not a prompt instruction. See
[ADR-006](ARCHITECTURE.md#adr-006) and [ADR-011](ARCHITECTURE.md#adr-011).

---

## 4. Caching

Agent results are content-addressed on:

```
(agent_id, prompt_version, model, input)
```

Two consequences, both deliberate:

- **Iteration does not re-pay** for unchanged research, Apollo lookups, or
  dossiers.
- **Bumping a prompt version invalidates everything derived from it**, so "reuse
  unchanged work" cannot silently become "reuse stale work."

Two rules the cache must never break:

- **Only successes are cached** ([ADR-015](ARCHITECTURE.md#adr-015)). A cached
  failure is a permanent failure. A `422 insufficient credits` was once written
  to disk and kept failing from cache long after the account was topped up, with
  nothing in the logs explaining why.
- **Replayed results report zero cost.** Otherwise every cost-per-prospect figure
  inflates on re-run and the efficiency metrics become fiction.

---

## 5. Usage and cost accounting

`lib/providers/anthropic/client.ts` tracks calls, tokens, cache reads/writes,
web searches, and estimated USD, all rolled into `agent_runs`.

Web search is billed **per request, separately from tokens**, and happens inside
the model's turn — so nothing but the loop can count it.

> **A bug worth remembering.** Per-agent cost was originally measured as a delta
> against the global usage counter. Agents run concurrently, so the deltas
> overlapped: `agent_runs` summed to **$1.33** on a run whose true cost was
> **$0.92**. Cost is now accumulated per call inside each loop. The smoke test
> asserts the two figures reconcile exactly, which is the only reason the error
> was visible at all.

---

## 6. The agents

| Agent | Judgment it owns | Searches | Feeds |
|---|---|---|---|
| **Mission Strategist** | where should we even look? | yes (≤3) | market hypotheses |
| **Market Discovery** | which real companies exist here, and is this search space productive? | yes (≤4/round) | company candidates |
| **Company Validation** | is this real, correctly identified, and worth a credit? | yes (≤4) | KEEP/MAYBE/REJECT + target titles |
| **Person Research** | what do they own, and would they care? | yes (≤3) | KEEP/MAYBE/REJECT/RE-SCOUT |
| **Ranking** | how promising is this prospect, per dimension? | **no** | component scores |

**People Scout is not an agent.** Finding people inside a known company is API
calls, pagination, filtering and dedupe — no judgment problem. The judgment
already happened upstream: Company Validation chose the titles.

### Why Ranking cannot search

If ranking could gather more evidence, a thin prospect could research its way to
a better score, and the score would stop measuring what discovery actually
produced. Ranking judges the evidence it was handed. Its low scores on
thin-evidence prospects are a *signal about discovery*, and that signal must not
be launderable.

---

## 7. The discovery session

Market Discovery is the one agent that runs as a **multi-round session**
(`runDiscoverySession`). Each round it searches, inspects, diagnoses, and acts.

**Diagnoses** — what is wrong with this search space:

`HEALTHY` · `DOMAIN_DRIFT` · `SEARCH_TERM_AMBIGUITY` · `LOW_SUPPLY` ·
`WRONG_COMPANY_ARCHETYPE` · `GEOGRAPHIC_OVERCONSTRAINT` · `TITLE_MISMATCH`

**Actions** — what to do about it:

`ACCEPT` · `REFINE` · `NARROW` · `BROADEN` · `SYNONYMS` · `ADJACENT_CATEGORY` ·
`FOLLOW_COMPANY` · `REJECT_HYPOTHESIS` · `REQUEST_NEW_HYPOTHESIS`

The loop does not second-guess the chosen action. Its only jobs are to enforce
the round cap, carry the claimed-name set forward so rounds cannot re-find the
same companies, and stop when a continuing action arrives with no query to
continue on.

**Killing a hypothesis counts as success.** The Search Recovery eval scores
`REJECT_HYPOTHESIS` on a `LOW_SUPPLY` diagnosis exactly as highly as a recovery,
and scores *grinding a dead hypothesis through more rounds* as a failure. A
system that cannot abandon a bad search space will always spend its budget on
the worst segment.

---

## 8. The one upstream edge

Person Research may return `SEARCH_FOR_DIFFERENT_PERSON` with a **searchable job
title**, which goes back to People Scout for one bounded extra pass.

This is the only place a downstream agent feeds a hypothesis upstream, and it is
deliberately narrow:

- gated on a **real, searchable title** — a re-scout request without one is a
  rejection wearing a better label, and degrades to `REJECT`
- **one request per company** — several people at one company usually produce the
  same suggestion, and acting on each would re-buy the same rows
- **one extra pass**, not a loop

It exists because a company can be an excellent target while the person we
happened to surface is a poor entry point. Losing the company to that is
unrecoverable; asking once for the right role is cheap.

---

## 9. Failure handling

Failures **degrade, they never halt**, and they are **always surfaced**:

- a failed agent returns `error` on its result; the orchestrator records it and
  continues with the rest of the run
- a failed tool returns `is_error` to the model, which can proceed or conclude
  `UNKNOWN`
- a failed Apollo batch returns a **reason**, because credit exhaustion and a
  network fault look identical from the outside and the difference decides
  whether retrying is even sensible
- `people filter rejected all N stubs` is surfaced with the rejection histogram,
  because "0 enriched" with no explanation is exactly the diagnostic hole
  [ARCHITECTURE §9](ARCHITECTURE.md) forbids

---

## 10. Adding an agent

1. Write `prompt.ts` exporting `{ version, build(input) }`.
2. Write `index.ts` with the output schema, a `validate` that **rejects** rather
   than repairs, and a `runX` wrapper calling `runAgent`.
3. Add `cacheKeyParts` covering every input that changes the answer.
4. Decide whether it may search. Default to no.
5. Have the orchestrator call it and persist the trace.
6. Bump `version` on every semantic prompt change, forever.
