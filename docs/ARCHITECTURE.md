# Architecture — Outreach OS V2

> Target architecture and the decisions behind it.
> Companion docs: [PIPELINE.md](PIPELINE.md) · [AGENTS.md](AGENTS.md) · [DATA_MODEL.md](DATA_MODEL.md)

---

## 1. Governing principle

> **Deterministic code for deterministic work. LLM agents only for judgment, synthesis,
> interpretation, strategy, and writing.**

This is not stylistic. It decides cost, latency, testability, and whether failures are
debuggable. A pagination loop written as an agent is slower, more expensive, and less
reliable than a `for` loop, and it fails in ways you cannot reproduce.

| Deterministic code owns | Agents own |
|---|---|
| Provider API calls, pagination, rate limiting | Mission interpretation |
| Deduplication, normalization | Search strategy generation |
| Hard-constraint filtering | Company and role interpretation |
| **Score arithmetic and ranking** | **Component score judgment** |
| Database access, transactions | Research synthesis |
| Status transitions, queues, retries | Fit reasoning |
| Email delivery, MIME, threading | Positioning |
| Reply polling, idempotency | Writing |
| Schema validation | Evaluation judgment |
| Analytics aggregation | Qualitative outcome interpretation |

Notice the split inside scoring and evaluation. The model supplies judgment; code supplies
arithmetic and thresholds. That boundary recurs throughout the system.

---

## 2. Layers

```
┌─────────────────────────────────────────────────────────────────┐
│  UI — Next.js App Router                                        │
│  Missions · Prospects · Approval Queue · Conversations · Talent │
└───────────────────────────┬─────────────────────────────────────┘
                            │ server actions / route handlers
┌───────────────────────────▼─────────────────────────────────────┐
│  ORCHESTRATION — lib/pipeline/                                  │
│  Run lifecycle · task claiming · stage gating · retries         │
│  ← the only layer that knows the pipeline is a sequence         │
└───────────────────────────┬─────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
┌───────────────┐  ┌─────────────────┐  ┌──────────────────┐
│ AGENTS        │  │ SCORING         │  │ EVALS            │
│ lib/agents/   │  │ lib/scoring/    │  │ lib/evals/       │
│ 7 agents      │  │ pure functions  │  │ det. + judge     │
│ versioned     │  │ config-driven   │  │                  │
│ prompts       │  │                 │  │                  │
└───────┬───────┘  └─────────────────┘  └──────────────────┘
        │
┌───────▼─────────────────────────────────────────────────────────┐
│  PROVIDERS — lib/providers/                                     │
│  CompanyProvider · PeopleProvider · WebResearchProvider         │
│  Apollo · PitchBook (flagged) · OpenAI web_search · Registry    │
└───────────────────────────┬─────────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────────┐
│  PERSISTENCE — Supabase Postgres, RLS on every table            │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  EMAIL — lib/email/  ← V1 code, preserved as-is                 │
│  Gmail OAuth send · MIME · threading · idempotent reply sync    │
└─────────────────────────────────────────────────────────────────┘
```

**Dependency rule:** layers depend downward only. Agents never touch Supabase directly —
the orchestrator loads their inputs and persists their outputs. This is what makes an agent
a pure, testable function of its input.

---

## 3. Directory layout

New directories are additive. Nothing in V1 moves in Phase 0.

```
lib/
  pipeline/
    runs.ts              Run lifecycle
    tasks.ts             Claim, lease, complete, retry
    tick.ts              The worker: claim a batch, execute, record
    stages.ts            Stage registry + gating rules
  agents/
    types.ts             AgentDefinition, AgentContext, AgentResult
    registry.ts          id → definition
    run.ts               Shared executor: validate, call, parse, trace
    mission-strategist/  { prompt.ts (versioned), schema.ts, index.ts }
    company-scout/
    people-scout/
    research/
    ranking/
    positioning/
    outreach/
  providers/
    types.ts             Provider interfaces
    registry.ts          Availability + feature flags
    apollo/              organizations.ts, people.ts, client.ts
    pitchbook/           Flagged, stubbed
    web/                 openai-search.ts (default)
  scoring/
    types.ts             Components, weights, results
    weights.ts           Defaults + per-mission resolution
    compute.ts           Pure arithmetic — no I/O, no model
  evals/
    types.ts
    deterministic.ts     Word count, banned phrases, citation resolution
    judge.ts             LLM rubric evaluation
    run.ts               Orchestrates both, applies thresholds
  talent/
    retrieve.ts          Select candidate proof points for a prospect
  ai/
    models.ts            Central model registry  ← replaces 10 hardcoded IDs
    (existing V1 modules stay until their phase migrates them)
  email/                 UNCHANGED (rename only, see ADR-007)
```

---

## Architecture Decisions

Each decision states the problem, the choice, and what it costs. Decisions that materially
change product behavior are marked ★.

---

### ADR-001 ★ — Company becomes a first-class entity

**Problem.** `contacts.company` is free text. The V2 pipeline is company-first: discover
companies, rank them, then find people inside the good ones. There is nowhere to attach
company research, company scores, or a dedupe key, and no way to enforce "one person per
company at a time."

**Decision.** Add a `companies` table. `contacts.company_id` references it. Dedupe on
normalized domain, falling back to normalized name + country. The V1 `contacts.company` text
column is **retained and kept in sync** so every existing screen keeps working untouched.

**Cost.** Denormalized duplication between `companies.name` and `contacts.company`. Accepted
deliberately: it makes the migration non-breaking, and Phase 4 backfills.

---

### ADR-002 ★ — Missions replace hardcoded goals

**Problem.** `outreach_goal` is a five-value enum (`speaker | mentor | jobs | investor_intro |
personal_career`) and "Founders: Illinois Entrepreneurs" is literal text in four system
prompts. Every new use case is a code change.

**Decision.** A `missions` table with a free-text objective, structured hard constraints and
soft preferences, per-mission scoring weights, and an autonomy level. The five V1 goals become
seed mission templates. Prompts receive mission context as **data**, never as hardcoded text.

**Cost.** V1's goal-specific `ask_guidance` copy is genuinely good and must be carried into
mission templates rather than lost.

---

### ADR-003 — One `talent_items` table, not four

**Problem.** The spec suggests `experiences`, `projects`, `skills`, and `proof_points` as
separate entities.

**Decision.** One `talent_items` table with a `kind` discriminator covering all nine item
types.

**Reasoning — this challenges the spec deliberately.** These entities share the same
lifecycle, the same tagging dimensions, and exactly one retrieval path: "given this prospect,
find the most relevant items." Four tables means four queries, four upsert paths, and a
`UNION` in the single place that matters, for no gain. They differ in *content*, not in
*structure*.

**Revisit when** a kind needs genuinely different columns — e.g. if `projects` later needs
repo URLs, collaborators, and deploy status. Splitting later is a mechanical migration;
merging later is not.

**Cost.** A slightly loose schema where `metadata` jsonb carries kind-specific fields.

---

### ADR-004 ★ — The model judges, the code computes

**Problem.** V1's `relevance_score` is a single float the model emits directly. It cannot be
re-weighted, explained per dimension, or recomputed without paying for another model call.

**Decision.** Agents emit **component scores only** (0–1 per dimension, each with an
explanation and evidence). The weighted sum, normalization, threshold application, and
ranking are pure TypeScript in `lib/scoring/compute.ts`, reading `missions.scoring_weights`.

**Why this matters more than it sounds.** It makes scoring configurable by the founder rather
than by a prompt edit; makes re-ranking instant and free; makes the arithmetic unit-testable
without mocking a model; and means a weight change never silently alters model behavior.
This is the single highest-leverage boundary in the system.

**Cost.** The agent must produce well-calibrated components. Mitigated by batching ~10
subjects per call so it calibrates relatively rather than absolutely.

---

### ADR-005 ★ — Runs are durable rows advanced by an idempotent worker

**Problem.** V1 runs long work inline in HTTP handlers with `maxDuration = 300` and sequential
model calls in a `for` loop. This already shipped as a bug (`f6e4bb7`, "prevent
campaign-generate timeout truncation"). V2 does strictly more work per run — a full mission
is hundreds of provider calls and dozens of model calls.

**Options considered.**

| Option | Verdict |
|---|---|
| Keep inline handlers | ✗ Already broken at current scale |
| Redis + BullMQ | ✗ New infrastructure, new failure modes, violates "avoid premature scaling infra" |
| Temporal / Inngest | ✗ Correct at scale, disproportionate for a single-user product |
| **Postgres task rows + idempotent tick** | **✓ Chosen** |

**Decision.** `pipeline_runs` and `pipeline_tasks` in Postgres. A single
`POST /api/pipeline/tick` claims a small batch of `pending` tasks with a lease, executes them
within the request budget, records results, and returns. Triggered by the UI while a run is
active, and by a Vercel Cron every minute as the backstop.

**Why it holds up.** State lives in Postgres, which is already the source of truth — a crashed
or timed-out worker loses nothing, because expired leases return tasks to `pending`. Zero new
infrastructure. Ticks are horizontally safe: claiming uses `FOR UPDATE SKIP LOCKED`, so two
concurrent ticks never collide.

**Cost.** Latency is quantized to the tick interval. Irrelevant here — a mission run is
expected to take minutes, and a human is not watching a progress bar.

**Scaling path.** If this ever outgrows Postgres, only the *trigger* changes. The task model
stays.

---

### ADR-006 ★ — Research must be grounded; introduce `WebResearchProvider`

**Problem.** V1 research is the model's parametric memory. Roughly 40% of its system prompt is
anti-hallucination instruction — a symptom of having no source of truth to check against.
V2 requires FACT / INFERENCE / UNKNOWN with provenance, which is impossible without retrieval.

**Audit finding.** No web search capability exists anywhere in the codebase. The installed
OpenAI SDK is **4.104.0** (despite `package.json` pinning `^4.52.0`) and **does** expose the
Responses API with the `web_search` tool.

**Decision.** Define a `WebResearchProvider` interface. Default implementation uses the OpenAI
Responses API `web_search` tool — no new vendor, no new key, and the SDK is already installed.
Tavily and Exa are documented alternates behind the same interface.

**Consequence when unavailable.** Research degrades to `INFERENCE`-only. The Phase 7 gate
("≥ 2 sourced facts", [PIPELINE.md §7](PIPELINE.md#7-minimum-quality-gates)) then blocks those
prospects from outreach. The system produces less, not worse. That is the correct failure mode.

**Cost.** Research becomes the slowest and most expensive stage. Accepted — it is the linchpin,
and it runs only on the small post-cut set.

---

### ADR-007 — Preserve the email layer; rename only

**Problem.** `lib/email/resend.ts` sends via Gmail, not Resend. `emails.resend_message_id`
stores an RFC822 Message-ID this app generates. Both names actively mislead.

**Decision.** Keep all email behavior **byte-for-byte**. Rename `resend.ts` → `send.ts` and
the column → `rfc822_message_id`. Delete the dead Resend webhook route and `email_events`.

**Reasoning.** This is the hardest-won code in the repo — narrow OAuth scopes, encrypted
tokens at rest, correct MIME composition, working threading, idempotent reply sync with
backfill. Rewriting it would be pure risk for zero product gain.

---

### ADR-008 — Central model registry

**Problem.** `gpt-5.4` is hardcoded in ten files. Changing model or trying a cheaper one for
classification is a ten-file edit.

**Decision.** `lib/ai/models.ts` maps **roles** to IDs, overridable by env:

| Role | Used by |
|---|---|
| `fast` | Reply classification, deterministic-adjacent checks |
| `reasoning` | Strategy, ranking, research, positioning, eval judging |
| `writing` | Outreach drafting, reply suggestion |

Agents request a role, never an ID. Actual model and token usage are recorded per
`agent_runs` row.

---

### ADR-009 — Prompts are versioned modules

**Problem.** Prompts are inline template literals. There is no version anywhere, so
`generation_metadata.prompt_version` — which V1 already records — is a hand-maintained lie
(hardcoded `'1.0'` / `'2.0'`).

**Decision.** Each agent owns `prompt.ts` exporting `{ version, build(input) }`. `version`
is bumped by hand on any semantic change. `agent_runs.prompt_version` records the real value.

**Payoff.** "Why did it write this email this way?" resolves to an exact prompt version, its
inputs, and its output. It also makes prompt A/B a data question instead of a memory exercise.

---

### ADR-010 ★ — Evals gate, but never silently discard

**Problem.** Nothing checks a draft today.

**Decision.** A two-part gate. Deterministic checks first (word count, banned phrases, CTA
present, **every claim resolves to a `research_facts` row**) — free and catches the common
failures. Then an LLM judge scores the eight criteria in [EVALS.md](EVALS.md).

Fail → revise with the specific critique → re-evaluate. **Maximum 2 revisions.** A draft that
still fails enters the approval queue **flagged, with its failures displayed**.

**The rule that matters:** the system never silently drops a draft. A pipeline that hides its
failures trains its operator to trust it more than it has earned. The human sees everything
and decides.

---

### ADR-011 — Claim citation is mechanical, not exhortative

**Problem.** V1 fights hallucination with prompt instructions. That is unverifiable — you can
only inspect the output and hope.

**Decision.** The Outreach Agent must emit a **citation map**: every factual claim about the
recipient linked to the `research_facts` row supporting it. A deterministic check resolves
every citation. An uncitable claim is a fabrication *by construction*.

**Why this is the strongest anti-hallucination measure in the design.** It converts a
prompt-discipline problem into a foreign-key problem. No amount of persuasive writing gets a
claim past a `NULL` lookup.

---

### ADR-012 — Contacts remain the person entity

**Problem.** The spec lists `people` as a new table. `contacts` already exists with RLS, a
unique index, status transitions, and six screens built on it.

**Decision.** `contacts` **is** the person entity. Extend it with `company_id`, `mission_id`,
and `discovery_source`. Do not create `people`.

**Reasoning.** Development principle 1 — inspect before rewriting. A parallel `people` table
would fork every existing query, screen, and RLS policy for a naming preference.

---

### ADR-013 ★ — Apollo discovery is people-first, not company-first

**Problem.** [PIPELINE.md](PIPELINE.md) describes discovery as company-first:
find companies, rank them, then find people inside the good ones. Phase 3
implemented that against Apollo and it failed.

**Evidence.** Apollo's `q_organization_keyword_tags` matches company **names and
descriptions lexically**, not semantically. A search for
`['artificial intelligence', 'manufacturing']` returned AI magazines,
certification bodies, conference organizers, staffing agencies and universities —
almost no operating companies. Nine queries produced **one** usable candidate.

**Decision.** For Apollo, invert the funnel. Query
`mixed_people/api_search` with `person_titles` + `person_seniorities` +
`q_organization_keyword_tags` + `organization_num_employees_ranges`, then enrich
via `people/bulk_match`, then derive companies from the enriched person records.

**Why it works.** The title filter anchors each query to a real operating
company. The same keyword that returned magazines under company-first returns
DuBois Chemicals and Sunburst Chemicals when paired with "Director of
Manufacturing". Apollo's person records also embed a **richer** org payload than
its company search returns, so company data arrives for free.

**Scope.** This is a **provider-level** strategy, not a change to the conceptual
pipeline. [PIPELINE.md](PIPELINE.md) stages 2–5 still describe what the system
does; ADR-013 records how the Apollo adapter achieves it. A provider with real
semantic company search (PitchBook, or an embedding-based index) can implement
company-first behind the same `CompanyProvider` interface without changing the
scouting pipeline.

**Cost.** Company discovery is bounded by which companies happen to employ
someone matching a title query. Genuinely relevant companies with no matching
title in Apollo are invisible. Accepted for now; a semantic company provider
would fix it.

**Corollary — enrichment is the budget.** Apollo search rows are obfuscated
(`last_name_obfuscated`, boolean `has_email`, no LinkedIn, no seniority), so
every usable prospect costs one `people/bulk_match` credit. Pool depth is bounded
by credit budget, not search recall. Deterministic filtering therefore runs
**before** enrichment wherever possible.

---

### ADR-014 ★ — Research runs before enrichment, not after

**Problem.** Phase 3 spent an Apollo lead credit on every candidate *before*
knowing whether their company was worth anything, then discovered at scoring time
that 40% of them were golf-club advisories, ERP implementers and MEP engineering
firms. Enrichment is the only hard-currency step in the pipeline, and the account
ran dry.

**Decision.** Reorder the funnel so cheap signal is spent first and credits last:

```
DISCOVER → CHEAP FILTER → COMPANY RESEARCH → PRELIMINARY RELEVANCE
  → SHORTLIST → APOLLO ENRICHMENT → PERSON RESEARCH → FINAL SCORE
```

Apollo search stubs are obfuscated but carry a **company name**, which is enough
to research the company by name before any credit is spent. Measured on the
consulting profile: 269 stubs → 246 after a free filter → 90 researched → **36
rejected** → 118 shortlisted. Those 36 companies' people are never enriched.

**Consequence.** The deterministic `requiredDomainTerms` substring filter from
Phase 3 is retired. A researched, sourced verdict on what a company actually does
is a strictly better instrument than substring matching on an Apollo keyword blob,
and it explains itself.

**Cost.** One web-grounded call per unique company. At ~$0.03 each this is far
cheaper than the enrichment credits it saves, and it is cached per company.

---

### ADR-015 — Provider caches must be keyed by entity, not by request

**Problem.** Phase 3 cached Apollo enrichment per *batch of ten people*, keyed on
the batch composition. The moment the pipeline changed which people it selected,
every batch was a miss — so 1,373 already-purchased records were unreachable and
would have been re-bought. This was silently wasting the scarcest resource in the
system from the day it was written.

**Decision.** Cache expensive per-entity results under a **stable entity key**
(`person_enriched/<apollo_id>`), independent of the request that produced them.
Request-level caching is still fine for cheap, idempotent calls like search.

**Corollary — never cache a failure.** A transient parse error or rate limit
written to cache is replayed forever and starts to look like a stable property of
the input. `cached()` now takes a `shouldCache` predicate, and research dossiers
opt out when `research_failed` is set.

**Generalizes to:** company dossiers, person dossiers, and any future provider
result that costs money per entity.

---

### ADR-016 ★ — Agents run a bounded tool loop; `submit_result` is the only way to answer

**Problem.** Phase 6 agents were single model calls returning JSON in prose. Two
failure modes followed. Output arrived *nearly* valid, got coerced by the parser,
and flowed downstream looking fine. And an agent that needed to look something up
could not — the orchestrator had to guess in advance what evidence it would want.

**Decision.** Every agent runs the same bounded loop (`lib/agents/runtime/loop.ts`).
The model is given Anthropic's server-side `web_search`, zero or more of our
client-side tools, and exactly one `submit_result` tool carrying that agent's
output schema. **Text outside that tool call is ignored.**

Making "finish" a typed action moves malformed output from *a parsing problem
later* to *a tool-call validation failure at the boundary*. Invalid output is
retried once with the rejection reason attached — discarding it outright threw
away a whole discovery round, including four paid web searches and six real
companies, over one misspelled enum value.

**Bounded autonomy.** Steps, web searches, output tokens, total model calls, and
Apollo calls are all capped. The agent decides *what* to do; the code decides
*how long it may keep deciding*. That split is the entire safety story.

**Consequence.** Agents are no longer pure functions of their input in the strict
sense — they call tools. They remain pure with respect to the **database**, and
they still never call each other. Those are the two properties that keep this a
pipeline rather than a swarm, and they are unchanged.

---

### ADR-017 ★ — The evidence pool comes from retrieved pages, not from cited text

**Problem.** `validateClaimsAgainstEvidence` downgrades a `FACT` whose
`source_url` the agent never actually retrieved. The first implementation built
that pool only from `citations` attached to the model's text blocks.

But an agent whose final answer arrives as a `submit_result` **tool call** emits
no cited *text at all*. The pool was empty on every real run, so the check
downgraded **every genuine FACT** to `INFERENCE`. The grounding mechanism was
inverted: instead of catching fabrication it was destroying real sourcing.
Measured: 0 of 9 FACTs kept their source.

**Decision.** Build the pool from **both** structural sources:

| Source | What it proves |
|---|---|
| `web_search_tool_result` blocks | the page was actually retrieved |
| `citations` on text blocks | the model tied a specific sentence to that page |

Prose is still never scanned for links. After the fix: 12 of 12 FACTs retained
their sources.

**The general lesson.** A grounding check that can silently fail *open* is bad; a
grounding check that silently fails *closed* looks like it is working — the
counts all read "100% sourced" because the numerator and denominator both
collapsed to zero. Assert on the absolute count, not only the ratio.

---

### ADR-018 — Search titles are derived per company, from research

**Problem.** The Mission Strategist emitted "job titles" that were really
descriptions: `Head of Product - Manufacturing/Process Industries`,
`Founder/CTO (early-stage industrial AI startup)`. Apollo's `person_titles` is a
phrase match against real titles, so every one returned **zero rows** — a smoke
run lost all three of its companies to this.

A single global title list is also wrong on its face. A founder is the right
target at a 12-person startup and the wrong one at a 90,000-person manufacturer,
where the reachable and empowered person is a director who owns the function.

**Decision.** Two layers, neither trusting the other:

1. **Company Validation emits `target_titles` per company**, chosen from the
   researched size and archetype. It already knows what the company is.
2. **`lib/scouting/titles.ts` normalizes them deterministically** — strips
   parentheticals and scope qualifiers, splits slash alternatives, drops anything
   longer than five words, and falls back to archetype defaults when fewer than
   three usable titles survive.

Prompt guidance alone would be unverifiable: the model complies for a while and
then drifts. The normalizer makes the guarantee structural, and its fourteen test
cases are all real strings that returned zero rows.

**This is the mechanical form of "appropriate seniority is not maximum
seniority."**

---

### ADR-019 — One upstream edge: `SEARCH_FOR_DIFFERENT_PERSON`

**Problem.** A company can be an excellent target while the person the pipeline
happened to surface is a poor entry point — too junior to sponsor anything, too
senior to read a cold message, or in a function that merely sounds related.
Discarding the company over that is unrecoverable.

**Decision.** Person Research may return `SEARCH_FOR_DIFFERENT_PERSON` with a
**searchable job title**, which goes back to People Scout for one bounded pass.
This is the only place a downstream agent feeds a hypothesis upstream, and it is
deliberately narrow:

- gated on a real, searchable title — a re-scout request without one is a
  rejection wearing a better label, and degrades to `REJECT`
- one request per company, since several people at one company produce the same
  suggestion and acting on each re-buys the same rows
- one extra pass, not a loop

**Why not a general feedback graph.** Every additional upstream edge multiplies
the states a run can be in and makes "why did this run cost that much?"
unanswerable. One narrow, well-justified edge is affordable; a mesh is not.

---

### ADR-020 — Killing a hypothesis is a successful outcome

**Problem.** An agent that can only refine its search will always spend its
entire budget on the worst segment, because refinement always *looks* like
progress.

**Decision.** Market Discovery runs as a bounded session, and its action space
includes `REJECT_HYPOTHESIS` and `REQUEST_NEW_HYPOTHESIS` alongside the seven
continuing actions. The Search Recovery eval scores abandoning a `LOW_SUPPLY`
segment **exactly as highly** as recovering one, and scores *grinding a diagnosed
segment through more rounds without recovering* as a **failure**.

The agent must also name what is wrong — `DOMAIN_DRIFT`,
`SEARCH_TERM_AMBIGUITY`, `LOW_SUPPLY`, `WRONG_COMPANY_ARCHETYPE`,
`GEOGRAPHIC_OVERCONSTRAINT`, `TITLE_MISMATCH`, or `HEALTHY` — before choosing.
Naming the failure is what makes the choice reviewable rather than a vibe, and
the diagnosis histogram is the fastest read on where a run's budget went.

---

### ADR-021 ★ — Intelligence tiers, and a triage gate before expensive research

**Problem.** A scouting run cost ~$18 and produced ~20 usable prospects. The
breakdown showed almost all of it in two places:

| Stage | Cost | Why |
|---|---|---|
| person research | ~$12 | ~60 people × ~$0.20, most later discarded |
| company validation | ~$4 | ~20 companies × ~$0.20 |

Both ran on the strongest model, and person research ran on **every enriched
candidate** — including people the pipeline dropped moments later. The system was
paying premium prices to research prospects it had already decided against.

**Decision — two changes.**

**1. Model routing by tier.** Roles describe *what a call is for*; tiers describe
*how much thinking it is worth paying for*, and cost lives on the second axis.

| Tier | Model | Used by |
|---|---|---|
| `cheap` | Haiku | company validation, person triage, ranking |
| `standard` | Sonnet | mission strategy, market discovery, person research |
| `premium` | Opus | reserved — nothing defaults to it |

Every agent declares a minimum tier and **the default is `cheap`**. Tier→model is
env-overridable, so swapping models is configuration, not an agent change. Spend
is recorded per tier and escalations are logged with a reason — an escalation
path nobody can see becomes the default within a month.

The assignments follow the measured work, not intuition. Validation and ranking
are *classification against evidence already gathered*; strategy and discovery
*set direction and judge whether a search space is productive*, which is the
genuinely hard reasoning in the pipeline.

**2. A triage gate before deep research.** A new `cheap` agent judges one
company's Apollo metadata against that company's already-researched profile and
names the two or three people worth researching. It sees the whole slate at once
— relative judgment across real alternatives is far easier than absolute judgment
one person at a time — and it needs no web search to do it.

**Measured on a 1-segment run:** triage was **1% of run cost** while cutting 12
enriched candidates to 5 researched. Person research fell from ~65% of spend to
49%, and total cost per prospect landed at **$0.46**.

**Why this does not cost quality.** Triage decides *who to research*, never who
to contact. Ranking still judges full evidence, and the deterministic filters
(geography, seniority, trainee titles, excluded functions) still run first at
zero model cost. If triage fails, the company falls back to the deterministic
title ordering People Scout already applied — the gate degrades, it does not drop.

**The generalizable rule:** spend the expensive model where the decision is hard
and *changes what happens next*. Everything downstream of a filter should be
cheaper than the filter's own error cost.

---

### ADR-022 ★ — `outreach` owns relationship state; `emails` stays the message

**Decision.** Phase 9 adds one table, `outreach`, holding one row per (user,
contact): the approval state machine, the positioning snapshot, the draft and
the user's edit, the send result, the reply, and the outcome. It **points at**
an `emails` row rather than replacing it.

**Why not widen `emails.status`.** The obvious move is to add `approved`,
`replied` and `skipped` to the existing check constraint. Three reasons not to:

1. V1 screens read `emails.status` and expect exactly `draft | scheduled | sent
   | failed`. Widening it silently changes what four working pages display.
2. `emails` is a *message*. "Replied", "meeting" and "referred" are facts about a
   **relationship**, and a follow-up would need a second message row carrying
   the same relationship state — two rows, one truth, guaranteed to diverge.
3. `lib/email/sync.ts` finds replies by re-listing the Gmail threads recorded on
   `emails`. That mechanism works and is explicitly not to be rewritten. Writing
   an `emails` row for every send keeps reply sync working *for free*.

**Consequence.** Reply tracking required no change to the email layer at all.
`lib/outreach/replies.ts` runs after `syncReplies` and joins on the Gmail thread
id both sides already record. Zero lines of the hardest-won code in the repo
were touched.

---

### ADR-023 ★ — The claim-safety gate is deterministic, and blocking

**Decision.** Before a draft can be approved or sent, `lib/outreach/grounding.ts`
resolves every quantity, proper noun, ranking word and recipient-responsibility
claim against stored evidence. Unresolved claims in those categories are
**blocking**, with no override. Ambiguous categories warn and never block.

**Why not an LLM judge.** Asking a model "is this email grounded?" measures
whether the text *reads* grounded. The failure being prevented is a plausible
sentence with an invented number in it — precisely the input a judge is worst at
and a regex is best at. This is ADR-006 and ADR-011 applied to the last mile.

**Why the gate needs a wider pool than the writer.** Two different questions:

| | asks | pool |
|---|---|---|
| writer | what may I **argue** from? | the ≤3 chosen proof points |
| gate | is this claim **true**? | the user's whole record |

Collapsing them fails both ways. Give the writer everything and the résumé is
re-dumped, destroying the selectivity positioning exists to enforce. Restrict the
gate to the chosen three and it blocks true statements: eight of ten measured
drafts said "P&G's largest global manufacturing site", which is on the user's
record — on a *different* item from the one being cited. So `buildEvidence`
feeds the writer and `buildVerificationPool` feeds the gate, the latter adding
identity lines only (title, org, period), which no model ever sees.

**Measured.** 9/10 real drafts clear; 8/8 fabrications blocked. The tenth block
was correct — "Operator Agent", a product name no research mentions.

---

### ADR-024 — Idempotency is a compare-and-swap, not a check

**Decision.** Sending claims the row with a single conditional UPDATE
(`state IN ('approved','failed') AND sent_at IS NULL → 'sending'`). Postgres
serialises row updates, so of N concurrent requests exactly one gets a row back.

**Why not check-then-send.** `if (state === 'approved') { send() }` has a window
between the read and the write, and a double-clicked button lands squarely in it.
Only the database can close it, because only the database serialises.

**Layered, because the cost of being wrong is a stranger's inbox:**

1. `sent_at IS NOT NULL` short-circuits to success before anything runs, so a
   client retry is indistinguishable from a single click
2. the compare-and-swap admits one caller
3. a unique index on `outreach.email_id` means only one row can record a result
4. `unique (user_id, contact_id)` means one live outreach per person

A failed send goes to `failed`, never to `sent` (ADR-010) — the approved draft is
preserved and retryable, and `failed` is reachable only from `sending`, which is
reachable only from `approved`. Retrying can never smuggle out unapproved text.

---

### ADR-025 ★ — The existing network is searched before anything is discovered

**Decision.** Every run begins by asking *who do we already have?*. External
discovery runs only when a deterministic check says the internal pool is not
enough. `missions.search_mode` (a run parameter today) selects between
`internal_first` (default), `internal_only`, `both`, and `external_only`.

**Why.** The database held 897 researched contacts, 635 of them bought from
Apollo, and no run had ever looked at one of them. Every mission started by
paying to discover strangers while people who had already been found, researched
and in 250 cases emailed sat unreachable — because nothing indexed them.

**Why the decision is deterministic and not an agent's.** The agent that would
decide "have I found enough?" is the same agent that benefits from searching
more. `lib/network/sufficiency.ts` counts candidates clearing both a score and a
confidence floor and compares that to the mission's target. Nothing about the
decision is a judgment call, and every decision carries its reasons into
`scouting_runs.internal_decision`, because "why did this run cost $14?" and "why
did this one cost nothing?" are the same question.

**Consequence.** A run can now legitimately end without an external call, and
the funnel must say so rather than looking broken.

---

### ADR-026 — Contact classification is a mission-independent index, cached by content hash

**Decision.** `contact_index` holds one row per contact: deterministic
normalization (seniority band, function, geography) plus a cheap model pass that
labels industry, function, domains, opportunity types and open tags. The row
carries `source_hash` over exactly the material the classifier reads, so an
unchanged contact is never re-classified.

**Why a separate table, not columns on `contacts`.** It is derived data with its
own refresh lifecycle and its own version stamp. Mixing it into `contacts` makes
"is this stale?" unanswerable, and `contacts` is read by six V1 screens that
should not grow twenty-five columns to serve retrieval.

**Why classification is mission-independent.** Person Triage answers "is this
person worth researching for THIS mission at THIS company", which must be
recomputed every run. This answers "what IS this person", whose answer changes
only when the underlying material does — which is what makes it cacheable across
every future mission. Measured: 897 contacts classified once for **$1.59**;
every subsequent run of the indexer costs nothing for those rows.

**Why mission scores are NOT written here.** A person weak for winter industrial
AI may be strong for summer consulting. Per-mission scores live in
`network_matches`, keyed by run. Writing a "quality" number onto the contact
would let the first mission poison every later one.

---

### ADR-027 — Reuse before purchase

**Decision.** Before enrichment, every Apollo search stub is checked against an
index of contacts this user already owns. A match is resolved from storage; only
the remainder is enriched.

**Why here specifically.** Apollo's search step is free and its enrichment step
costs a lead credit. Search rows are obfuscated, so `apollo_id` is the only
identifier available at that moment — and it is also the strongest one we have,
which makes it both the only possible check and the right one.

Matching order — Apollo id, normalized LinkedIn, email, normalized name+company —
is the same order used by `lib/scouting/persist.ts` and `lib/outreach/store.ts`.
Three copies of "who is this person" that disagree is how duplicate contacts
appear.

**Consequence.** External discovery finding someone already in the database is a
MERGE, labelled `existing_rediscovered`, never a second row.

---

### ADR-028 ★ — A campaign's reference email outranks the house style

**Decision.** A campaign may carry one real email the user wrote. When it does,
that email defines the voice of every draft in the campaign — its length, its
warmth, its directness, the shape of its ask — and it overrides the house style
in [PRODUCT.md §9](PRODUCT.md#9-outreach-voice), including the word band and the
one-ask rule.

**Why.** The house style is a set of adjectives, and adjectives compound.
"Confident" plus "concise" plus "high-signal" plus "founder-to-founder"
reliably produced drafts that were arrogant and over-compressed — a voice
belonging to nobody, which the user then rewrote by hand every time. A real
email is *evidence about a real person*. Evidence beats adjectives.

**Why a separate Style Analyst rather than pasting the reference into the
writer.** Three reasons, in order of weight:

1. **It is answerable.** "What did the system learn from my email?" has a stored,
   readable, correctable answer. Pasting the reference into the writer makes that
   unanswerable forever.
2. **It separates style from content** — in particular `recipient_specific`, the
   list of facts belonging to the reference's own recipient, which is what lets
   the writer be told *not to reuse them*. That is the whole difference between
   imitating a voice and copying a template.
3. It is paid for once per campaign rather than once per prospect.

**Explicitly not a template.** No variables, no brackets, no fill-in-the-blanks.
The writer receives the reference, the style analysis, the recipient's research,
the positioning brief and the mission, and writes a finished email.

---

### ADR-029 — Placeholders are a deterministic, blocking gate

**Decision.** `[First Name]`, `{{company}}`, `<Role>`, `XYZ Corp` and unreplaced
instruction tokens block approval and block send, inside the same gate that
checks claim grounding.

**Why not prompt instructions.** The writer's prompt says "no placeholders"
three times, and that is the weakest possible enforcement — the same reasoning as
ADR-006 and ADR-011. A placeholder reaching a recipient is unrecoverable in a way
almost nothing else is: it is not a quality problem, it is proof the sender did
not read their own email.

**Why in the grounding gate rather than beside it.** The gate is the one thing
that runs at approval *and again at send*. Pasting `[their team]` back in while
editing is exactly how a clean draft becomes an embarrassing one, and only a
re-check at send catches that.

---

### ADR-030 ★ — Career OS extends Outreach OS; it does not fork it

**Problem.** A job-search system needs discovery, research, ranking, grounding, document
generation and a tracker. Most of that machinery already existed for outreach, and building a
second pipeline beside it would mean two agent runtimes, two trace tables, two caches and two
grounding gates that drift apart.

**Decision.** Career OS is a set of modules under `lib/career/` and new agents under
`lib/agents/`, all running on the existing runtime: `runAgent` / `anthropicStructured`, model
tiers, the disk cache, `agent_runs`, `research_facts`, `companies`, `contact_index`, and the
claim-safety gate. `scouting_runs` gains a `kind` column so a job-scout or package run is traced
exactly like an outreach run. Nothing is duplicated; the email layer is untouched.

**Cost.** Some names now describe more than they used to (`scouting_runs` holds package runs).
Accepted — one observability surface is worth a slightly generic table name.

Full note: [CAREER_OS.md](CAREER_OS.md).

---

### ADR-031 ★ — The Personal Evidence Bank carries provenance and approval as columns

**Problem.** Outreach OS still reads a hand-written fixture for the user's background. A résumé
tailor that edits bullets needs a structured, auditable source of truth: *which facts exist, where
each came from, and whether a human has vouched for it.*

**Decision.** `evidence_experiences → evidence_facts` (+ metrics, deliverables, skills, stories),
`resume_documents → resume_bullets`. Every fact carries `source` and `source_location`
(`Zuyu_Resume.docx ¶6`); every bullet carries the fact ids it rests on; every row carries
`approved`. The Resume Importer agent proposes; **a deterministic number check** drops any
proposed fact whose numeric tokens do not appear in the cited paragraph before it is ever stored;
the human approves. The tailor reads approved rows only.

**Why columns and not convention.** The tailor's validator rejects a change whose fact ids do not
belong to that bullet's experience. That is a lookup, not a prompt instruction — the same move as
`fact_requires_source` (ADR-006).

---

### ADR-032 ★ — Résumé changes pass three independent gates, and uncertainty keeps the original

**Problem.** The absolute requirement is that no generated bullet contains an unsupported claim,
and that requirement outranks persuasive writing. A single "please be truthful" agent cannot
guarantee it.

**Decision.** Layered, none trusting the other:

1. **Schema boundary** — `validateTailorOutput` drops any change that cannot cite approved fact
   ids from its own experience, whose edit level does not match its type, or that names a bullet
   already changed in the patch.
2. **Deterministic pre-check** — `precheckChange` re-points `lib/outreach/grounding.ts` at the
   experience's evidence pool: every number, acronym, tool name and superlative in the proposed
   text must appear in the pool, and a token that appears in the job requirements but nowhere in
   the pool is **keyword stuffing** and blocks. Ownership-inflating verb pairs warn.
3. **Independent verifier** — the Resume Fact Verifier receives the original, the proposal and
   the evidence, and structurally *cannot* receive the tailor's reasoning or the job description.
   It judges atomic clauses; its overall verdict is recomputed in code from the clauses and a
   mismatch is rejected.

`UNCERTAIN`, `UNSUPPORTED` and a verifier error all keep the original text and surface why. A
human may edit a rejected change, and the edit goes back through gates 2 and 3 before it can be
approved. Measured on the adversarial probe: zero forbidden terms in any supported change.

---

### ADR-033 — The master DOCX is edited in place; nothing is reconstructed

**Decision.** `lib/career/documents/docx.ts` opens the master résumé with JSZip, tokenizes the
body into paragraphs with byte-identical gaps, and rewrites only the runs inside a bullet
paragraph it changes. Paragraph properties, numbering, fonts and sizes are inherited from the
paragraph itself; bold spans that survive an edit verbatim are re-bolded; inserted bullets clone a
sibling's properties and get a fresh `paraId`. QA asserts that the set of fonts, font sizes and
the section properties are unchanged — so "no tiny fonts, no unreasonable margins" is a check,
not a hope. A two-page result is fixed by *shrinking content* (restore shorter originals, drop the
lowest-confidence addition), never by touching layout.

**PDF.** Word via COM when installed (this machine), LibreOffice when present, otherwise the
DOCX ships alone and QA says so. A low-fidelity HTML-to-PDF fallback was rejected: a wrong-looking
PDF is worse than an honest "PDF unavailable here".

---

### ADR-034 — Job freshness is a status with a timestamp, not a boolean

**Decision.** `UNVERIFIED → VERIFIED_OPEN | LIKELY_OPEN | STALE | CLOSED | ERROR`, with
`last_verified_at` and the method. A posting listed by an ATS API this run is `VERIFIED_OPEN`; a
careers page that returns 200 with the title is `LIKELY_OPEN`; a 404 or explicit closed language
is `CLOSED`; an unconfirmable job older than the staleness window becomes `STALE`. Only a page
whose text is genuinely ambiguous reaches the cheap Job Verifier agent. Saved and tracked jobs are
re-checked by `npm run career:verify` and the daily cron route, and a tracked job that closes
before the user applied moves its application to `CLOSED` automatically — never one that was
already submitted.

---

### ADR-035 — Deduplication prefers the first-party record; aggregators are leads

**Decision.** Postings cluster on `(ats_type, ats_job_id)`, canonical URL, requisition id, or
same company + normalized title + overlapping location, or same company + description shingle
similarity ≥ 0.6. Exactly one row per cluster is canonical, preferring ATS > careers page >
manual > web search > aggregator; the rest become `job_sources` of the canonical. An aggregator
URL is followed to the first-party posting before storage; when that fails it is stored as an
`UNVERIFIED` lead, never as a verified job.

---

### ADR-036 — Explicit feedback adjusts ranking through a bounded, logged modifier

**Decision.** `LOVE / INTERESTED / MAYBE / NOT_INTERESTED` with reasons is stored per job. A pure
function derives an adjustment in `[−0.25, +0.12]`: direct feedback on the same job dominates;
otherwise an attribute (role family, industry, company, location tier) contributes only when at
least two negatives cite a matching reason category. Hard constraints and weights are never
altered by feedback, and every contribution is returned as a sentence. No model, no learning
loop, no weight auto-tuning — at tens of samples that would be fitting noise (see the Phase 11
reasoning in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)).

---

### ADR-037 — The watchlist lives on `companies`

**Decision.** "Target company", "watching for an opening" and "opening available" are values of
`companies.watch_status`, with `careers_url`, `ats_type`, `ats_identifier` and
`last_careers_check_at` beside them. Company-first discovery is then a deterministic loop over
that table: detect the ATS once (cached for a week, negatives only when the scan really reached a
page), list internships, raise the status. A user-set status is never downgraded by the planner
or the scout.

---

### ADR-038 — Knowledge is canonical; sources are records; merges are tombstones

**Context.** Importing the same role from a résumé and then from pasted LinkedIn text produced
two `evidence_experiences` rows and two wordings of one fact, each remembering a single
source. Downstream prompts doubled up; the outreach loop still read a hardcoded fixture.

**Decision.** Three separations, in migration `015_evidence_canonical.sql`:

1. **A source is not knowledge.** `evidence_sources` holds what the user gave us (résumé file,
   LinkedIn export, one post, a profile field) with its raw content and a content hash.
   Facts and experiences point at sources through `evidence_fact_sources` /
   `evidence_experience_sources` — one fact, many sources, each with the wording that source
   used and a confidence: `1.0` when the source carries the fact's numbers, `0.5` when it only
   restates the event. **Corroboration of an event is not support for its metric.**
2. **Identity is computed, never guessed.** Organizations resolve through a normalizer plus an
   editable alias table (`P&G` = `Procter & Gamble` = `Procter & Gamble, Tabler Station`);
   roles are head titles (`President; Formerly Head of Events` → `president`); dates are parsed
   months. The consolidation engine classes a pair **HIGH** only on the same organization key,
   the same head title (or seniority-qualifier containment), compatible dates and no
   distinguishing qualifier; **POSSIBLE** when a person is needed (same org + same period +
   different titles; a qualifier such as a lab name with no dates; both rows hand-edited);
   **CONFLICT** when the same claim carries different numbers. `Head of Events` ≠ `President`,
   `VP` ≠ `President`, two summers at one company stay two rows, two labs at one university stay
   two rows. Fuzzy similarity alone never merges anything.
3. **A merge deletes nothing.** The merged row keeps `status = 'merged'` and `merged_into`; every
   child (facts, metrics, deliverables, bullets, projects, provenance) is re-pointed to the
   survivor; disagreeing fields become `evidence_conflicts` rows with both values and their
   sources, and the résumé's value stays canonical until the user picks. A snapshot of the whole
   bank is written to `evidence_snapshots` before any apply. Re-running the pass is a no-op.

Agents read the bank through one retrieval service, `getRelevantPersonalEvidence`, which ranks
canonical rows for a mission and a target and returns a bounded slice with provenance and
confidence — never the whole bank, never a tombstone, never an unapproved row.

**Consequences.** More sources make the same rows more confident, not more numerous. The
Review tab shows every POSSIBLE / CONFLICT pair with why, what is preserved and what could go
wrong; "Merge all high-confidence" applies only what the engine would apply on its own. The
hardcoded `RESUME_ITEMS` fixture survives only as the empty-bank fallback for the outreach loop.
The importer now sees existing experiences and facts and files restatements against them
(prompt 1.2.0); the deterministic matcher remains the second check on every filing.

---

### ADR-039 — The user's choices are facts; the scout's are hypotheses

**Context.** The Job Mission Planner names 15–40 companies per run and
`seedWatchlistFromPlan` stored every one as `watch_status = 'target'` — the
status the Companies page defines as *"you want to work here — checked first,
every scout run."* Scout-discovered companies were written the same way. On the
founder's database that produced **160 targets, none of them chosen by the
founder**, and a loop that fed itself: the scout invented a company, the company
became a preference, the next run prioritised it over discovery, and the
"preference" hardened. A watchlist that was supposed to be memory had become the
search universe — for a user whose actual knowledge is *industries, role
families, company archetypes and what they liked last time*, not company names.

Two smaller faults sat inside the same column. `watch_status` also carried
`opening_available`, so a board check with an opening **overwrote** the user's
`target`; and `watch_priority` was read descending by the store and the scout
but ascending by the Companies page, so the UI ranked the least important
companies first.

**Decision.**

1. **`watch_status` is INTENT, and only a person writes the strong values.**
   `target` and `watching` require an explicit user action; agents may write
   exactly one value, `suggested` ("Explore"), and may never raise, lower or
   resurrect a row the user has touched — including `ignored`, which is
   permanent until the user says otherwise. The rule lives in one place,
   `lib/career/companies/intent.ts` (`resolveAgentIntent`, `AGENT_INTENT`), not
   in each writer.
2. **An opening is state, not intent.** `open_roles_count` and
   `last_careers_check_at` say whether a company is hiring now; a check never
   touches `watch_status` again. The Companies page's "Opening available"
   section is derived, so a target with an opening is still a target.
3. **Priority means one thing: higher is more important, 0–100** — enforced by
   `clampPriority`/`byCheckOrder` and asserted by tests, because a field whose
   UI and orchestrator disagree is worse than no field.
4. **Discovery is budgeted, not list-driven.** A run checks every Target, then
   Watching, then a *rotating, least-recently-checked sample* of Explore capped
   at a share of the budget (`selectCompaniesToCheck`), so a hundred accumulated
   guesses can never starve fresh market discovery — and the planner is handed
   the four groups separately (targets / watching / explore / ignored) plus the
   **characteristics** learned from them (`learnCompanyAttributes`: company
   types, industry tags and the companies behind the user's own promotions and
   job verdicts), so it can look for *more companies like these* instead of
   re-proposing the same names.

**Consequences.** Migration 016 demotes every planner- and scout-written target
to `suggested` while leaving rows whose `watch_source = 'user'` untouched — the
only reliable marker of an explicit choice, because the PATCH route stamps it.
"Target" becomes rare and meaningful. Scout output arrives as inspiration the
user can promote in one click, and promotion is what teaches the next run.

---

### ADR-040 — A scout run is a durable record, not an HTTP request

**Context.** `POST /api/career/scout` executed the whole scout inside one
request: plan, ATS checks, web search, extraction, verification, ranking, and
only then a single write. Vercel's 300-second ceiling forced a 270-second
internal deadline, so the browser run was structurally shallower than
`npm run career:scout`, a refresh lost the run, and a run that died lost every
posting it had already paid to extract. The panel narrated fake progress on a
25-second timer and, when the request timed out, told the user their jobs were
"already in the list" — where the inbox's default filters (`freshness=likely`,
`disposition=new,saved`, `sort=fit`) then hid the unverified and unranked ones.

**Decision.** The run row is the unit of work.

- `POST /api/career/scout` **enqueues**: it creates the `scouting_runs` row
  (`status='queued'`, the run parameters, a single-use claim token), dispatches
  a worker request, and answers in about a second with the `runId`.
- `POST /api/career/scout/worker` claims the run by token (so a duplicate
  dispatch cannot execute the same work twice), runs the *same* orchestrator the
  CLI runs, and writes `stage`, `heartbeat_at` and a bounded `progress` payload
  as it goes. Its deadline comes from the environment: Vercel's ceiling when
  deployed, the CLI's when not.
- `GET /api/career/scout/runs/[id]` is the only progress source — so the UI
  survives a refresh, a closed tab and a navigation, because status lives in
  Postgres, not React. It also reaps runs whose heartbeat died (→ `partial` when
  jobs were stored, `failed` otherwise) and re-dispatches a queued run whose
  worker never arrived.
- The orchestrator **persists incrementally**: after company-first and after
  each strategy it extracts, clusters, verifies and stores that batch, and
  records every job it touched in `scouting_run_jobs` — including ones it
  re-saw, which `discovery_run_id` could never express. A run that dies keeps
  everything it had already found.
- `/dashboard/jobs?run=<id>` shows exactly that run's jobs **without the inbox
  defaults**, beside the curated inbox rather than replacing it.

**Consequences.** "Scout says it added 14 things — where are they?" is now a
link. A partial run is an honest state with a number attached rather than a
vague sentence. The browser and the CLI share one engine, one run vocabulary and
one results view. The limitation that remains: a single worker invocation still
cannot exceed its platform's function ceiling, so a deployed deep run finishes
`partial` and the CLI (or a re-run) continues — resuming a partial run *inside*
the same run row is left undone deliberately, and documented rather than faked.

---

### ADR-041 — A run is a mode, a ceiling and a cursor

**Context.** Discovery was parameterised by four sliders — Strategies, Rounds,
Companies, Extract — and the numbers they carried were the product's real
ceiling. `targetCount: 12` per strategy and twelve jobs given a fit evaluation
meant a $4 run returned twelve jobs however much supply existed
(`docs/JOB_DISCOVERY_V2_AUDIT.md` §3). Nothing bounded what a run could spend,
nothing stopped a run for any reason except the clock, and nothing let a run
that hit a platform deadline continue rather than start again.

**Decision.** Three declarative pieces, and nothing else decides how big a run
is.

- **A mode** (`lib/career/discovery/modes.ts`) — QUICK · BROAD · EXHAUSTIVE — is
  a plain object holding every number a stage may know about the run's size.
  Pure, no I/O, so "how big is this run" is one value that is logged, persisted
  on the row, asserted in a test and shown in the UI. A caller that names no
  mode gets `LEGACY_BUDGET`: today's numbers and **no ceiling**, because a
  ceiling nobody asked for could truncate the founder's CLI run. Its counts stay
  at 12/12 for the same reason — the raise arrives with a mode, under a ceiling.
- **A spend ledger** (`lib/career/discovery/budget.ts`) that is asked *before*
  each paid stage starts and follows the run's own trace afterwards, so what a
  run reports spending is what it spent and only what it DARES to start uses an
  estimate. At the ceiling nothing new starts; the run finishes cleanly, reports
  `stopped: 'budget'`, and the row records **partial** — a run that stopped for
  money must never look like one that swept the market (principle 11).
- **A stopping rule that is not a counter.** `saturated(history, policy)` reads
  the *marginal unique yield* of the last few attempts: a productive strategy is
  never cut off however many came before it, and one that adds almost nothing
  new twice in a row ends the loop. Saturation is a run's **good ending** — it
  is terminal, not partial, and its cursor is marked done so nobody is sold a
  second pass over an exhausted market.
- **A task cursor** persisted in the run row's `params` (and mirrored into
  `progress`), carrying the stages, strategies and companies already done, the
  plan already paid for, and the dollars and milliseconds already used. A worker
  killed at its platform deadline leaves it behind; `POST /api/career/scout
  { continueRun }` reads it from the row — never from the request — and the next
  pass skips the plan, the sweep and the finished strategies. This is what
  ADR-040 deliberately left undone.

**Consequences.** The mode's `maxRuntimeMs` is the whole run's clock across
invocations, so "up to an hour" is enforced rather than promised. Every executor
maps the stored row through one function (`toJobScoutParams`): listing the
fields by hand is how `mode`, `maxSpendUsd` and `cursor` once failed to reach
the worker, which made the UI's spend limit decorative. Company-first shrinks as
the run widens (`exploreShare` 40 % → 15 % → 10 %), and the run reports the
share of discovery that came from broad market search, so "the market, not your
watchlist" is a measured number rather than an intention.

---

### ADR-042 — Geography is a dial with three named behaviours, and the product ships none of them

**Context.** The shipped default mission put "San Francisco / Bay Area" and
"New York City" in geography tier 1 and four coastal cities in tier 2, said the
same thing again in prose in the objective, listed `location` in `optimize_for`,
and seeded all of it a third time into `evidence_preferences` as six weighted
`location` rows. Every one of those reached the model: `renderMission()` printed
the tiers, `renderPreferences()` printed the rows into the same user message,
`fallbackStrategies()` appended a tier-1 city to deterministic queries, and
`locationTier()` stamped a tier on every posting so ranking could score it.

Nobody asked for any of it. The founder's own stated direction read *"I don't
care about location or which company"*. A preference the **product** invented was
outranking the one the **user** stated.

**Decision.** Geography becomes a dial the user sets, with three behaviours that
are named in the type and never conflated (`lib/career/missions/preferences.ts`):

| `locations.mode` | What it does |
|---|---|
| `anywhere` *(default)* | No place preference at all. No query carries a city, no posting is scored on where it is, and no tier is stamped. |
| `prefer` | A **ranking** signal only. In-region postings rank higher; everywhere else is still discovered, stored and shown. |
| `only` | A **hard filter** — and a real one: `locationOnlyConstraint()` writes it onto the mission's `hard_constraints`, where `applyHardConstraints()` rejects postings and reports the label that did it. |

Four rules hold the three apart:

1. **Read the dial, never the row.** `missionLocations()`, `rankingGeoTiers()`
   and `locationHardFilter()` are the only sanctioned readers. `prefer` returns
   `null` from `locationHardFilter()` *by construction*, so a preference cannot
   become a filter by accident, and `rankingGeoTiers()` returns nothing under
   `anywhere` however many stale tiers the row still holds.
2. **Never claim a filter you have not built.** "Only these places" is stated in
   the UI, in the rendered mission and in the fit prompt — so it exists as a hard
   constraint, applied in code before fit is ever scored. The prompt is allowed
   to say "already applied" because it is.
3. **No tier table means no tier.** `locationTier()` returns `null` on empty
   tiers. It used to fall through and stamp every US posting tier 3, which
   reached ranking as a penalty and the fit prompt as "(mission geography tier
   3)" — geography reasserting itself under a mission that had just said it had
   no opinion.
4. **Place is stated exactly once**, on the mission's `LOCATIONS` line.
   `withoutPlacePreferences()` strips `location` rows (and `optimize_for:
   location`) out of the Evidence Bank block before either prompt sees it, so the
   two halves of one user message cannot contradict each other whatever the
   `evidence_preferences` table still holds. A `[HARD]` place row a *person*
   typed is left in — removing that silently would be the same sin reversed.

Direction gets the same treatment. `direction_mode` is `boost` (search hardest
there, and still ingest strong adjacent postings) or `exclusive` (restrict
discovery and ranking to it), derived as `boost` whenever a direction is set and
`off` whenever it is empty — never *stored* as `off`, because a stored `off`
survives every `{ ...defaults, direction }` spread and would let the Jobs page
save a direction that then did nothing at all. No direction renders as *"explore
broadly from the evidence"* — a **wider** search, not a smaller one.

**Migrating what shipped, and only what shipped.** The old geography was
system-generated, so migration 017 replaces it. A mission somebody **edited** is
a preference a person expressed and is never overwritten — not one city of it.
The whole test is **byte identity** with the shipped pre-V2 value:
`isShippedPreV2Geography()` in TypeScript and the `where … = '[…]'::jsonb`
predicate in SQL are the same test written twice, and
`scripts/test-career-mission.ts` parses the literal *out of the SQL file* and
feeds it to the TypeScript predicate so the twins cannot drift. The same rule
governs the `evidence_preferences` rows: removed only when value, weight and the
`tier N` note all match what the seed wrote.

Anything that differs gets a **suggestion, not an edit** — an entry in
`career_missions.mission_migration_notes` that the Mission page surfaces with a
Dismiss button. Because that array is dismissible it can never be the "have I run
this yet?" guard; a second column, `mission_migrations_applied`, is the durable
ledger, written only by migration SQL and unknown to `sanitizeMissionPatch`.
Re-running the file is then a genuine no-op, which is the normal operating
condition for hand-applied migrations.

**Consequences.** Discovery biases to recall and ranking to precision. The costs
are real and accepted: a `prefer` user's mission must carry its regions
explicitly, and the tier bonuses in `lib/career/jobs/relevance.ts` simply never
fire for an `anywhere` mission. What is **not** done here: the seven call sites
that pass `mission.preferences.geo_tiers` into `buildNormalizedJob()` still read
the raw field rather than `rankingGeoTiers()`. The write path
(`sanitizePreferences`) clears the tiers under `anywhere` and rule 3 makes an
empty table inert, so the invariant holds today — but a row written outside the
API could still hold both, and switching those readers is the honest completion
of this ADR.

---

## 4. Providers

```ts
interface CompanyProvider {
  readonly id: string
  isAvailable(): boolean
  searchOrganizations(q: OrgSearchQuery): Promise<ProviderResult<CompanyCandidate>>
}

interface PeopleProvider {
  readonly id: string
  isAvailable(): boolean
  searchPeople(q: PeopleSearchQuery): Promise<ProviderResult<PersonCandidate>>
  enrichPerson(ref: PersonRef): Promise<ProviderResult<PersonCandidate>>
}

interface WebResearchProvider {
  readonly id: string
  isAvailable(): boolean
  research(q: WebResearchQuery): Promise<ProviderResult<WebFinding>>  // findings carry source URLs
}
```

| Provider | Implements | Availability |
|---|---|---|
| **Apollo** | `PeopleProvider`, `CompanyProvider` | `APOLLO_API_KEY`. Primary for people. V1 already uses `people/match`; V2 adds `organizations/search` and `people/search`. |
| **PitchBook** | `CompanyProvider` | `PITCHBOOK_ENABLED` + credentials. **Optional — the app must work fully without it.** Interface + stub only until entitlement is confirmed. |
| **OpenAI web_search** | `WebResearchProvider` | `OPENAI_API_KEY`. Default. |

**Rules.**
1. Business logic depends on the **interface**, never a concrete provider.
2. `isAvailable()` is checked before use; unavailable providers are skipped, not fatal.
3. Every result carries provenance into `company_sources` / `contact_sources`.
4. All credentials come from environment variables. **Never committed.**

**LinkedIn** is treated as an identity URL attached to a prospect when a provider legitimately
supplies one. No LinkedIn API dependency is designed into the architecture.

---

## 5. Observability

Every agent invocation writes an `agent_runs` row:

| Field | Purpose |
|---|---|
| `agent_id`, `prompt_version` | Which agent, which prompt |
| `run_id`, `task_id` | Pipeline context |
| `input_refs` (jsonb) | **References**, not payloads — ids of the rows fed in |
| `tools_called` (jsonb) | Provider and tool calls with arguments |
| `output` (jsonb) | Validated structured output |
| `model`, `tokens_in`, `tokens_out`, `latency_ms`, `cost_estimate` | Economics |
| `status`, `error` | Outcome |

Two questions must be answerable from these rows alone:

> **"Why did Outreach OS recommend this person?"**
> → score components with explanations and evidence → research facts with sources → the
> ranking agent run that produced them.

> **"Why did it write this email this way?"**
> → positioning angle with selected proof points and reasoning → citation map → prompt
> version → eval results including any revisions.

`input_refs` stores ids rather than payloads deliberately: full payloads would bloat the table
and duplicate data that already exists in its own rows. The tradeoff is that a trace is only
fully reconstructible while its source rows live — acceptable, since those rows are the
product's own data.

---

## 6. Failure philosophy

1. **Degrade, don't halt.** One failed person does not stop a run of twenty.
2. **Retry only what retrying can fix.** 429s and timeouts, yes. Schema-invalid output after
   retries, no.
3. **Surface failures; never hide them.** V1 already got this right in `syncReplies`, which
   returns diagnostics so "0 replies" is explainable. Keep that instinct everywhere.
4. **Every stage is resumable.** State is in Postgres, not in a call stack.
5. **Absent capability degrades output volume, not output quality.** No PitchBook → fewer
   private companies. No web research → fewer prospects clear the facts gate. The system never
   compensates by lowering its bar.

---

## 7. Cost and latency

The funnel shape *is* the cost model. Expensive stages run only on survivors.

| Stage | Unit | Volume | Cost driver |
|---|---|---|---|
| Strategy | 1 call | 1 | Negligible |
| Company discovery | Provider | 150–400 companies | Apollo credits |
| Company ranking | Batched ~10/call | ~15 calls | Moderate |
| People discovery | Provider | 60–120 people | Apollo credits |
| People ranking | Batched ~10/call | ~10 calls | Moderate |
| **Research** | 1 call + web searches / person | **10–20** | **Dominant** |
| Positioning | 1 call / person | 10–20 | Moderate |
| Outreach | 1 call / person | 10–20 | Moderate |
| Evals | 1 call / draft (+ ≤2 revisions) | 10–40 | Moderate |

**Research dominates.** Every cut before it exists to shrink its input set. Moving research
earlier in the pipeline — an easy mistake, since better research would improve ranking —
would multiply cost by roughly 10× for a marginal ranking gain. If ranking quality proves
insufficient, add a *cheap shallow* enrichment pass before ranking rather than moving the deep
dossier stage.

---

## 8. Security

Carried forward from V1 unchanged, all of it already correct:

- RLS on every table; `email_accounts` has RLS enabled with **no policies by design** —
  service-role only, so tokens are unreachable from the browser.
- Gmail refresh tokens AES-256-GCM encrypted at rest (`lib/crypto.ts`).
- Narrow OAuth scopes: `gmail.send` + `gmail.readonly`, never full mailbox.
- All secrets from environment variables; `.gitignore` covers `.env*`.

**New in V2:** provider keys (`APOLLO_API_KEY`, PitchBook) are server-only and must never
reach a client component or a `NEXT_PUBLIC_*` variable.

**Outstanding, needs founder action:** `Apollo API.txt` is a credential-shaped string tracked
in git. See [CURRENT_STATE.md §9](CURRENT_STATE.md#9-configuration) for the recommended
remediation.

---

## 9. Claude Code vs. the product's runtime AI

These are different things and the repository must not blur them.

| | Runtime AI | Claude Code |
|---|---|---|
| Lives in | `lib/agents/` | `.claude/` |
| Runs | In production, for users | During development, for engineers |
| Defined by | TypeScript + versioned prompts | Markdown agent/skill definitions |
| Observability | `agent_runs` table | Session transcripts |

`.claude/agents/` may hold development-time helpers (a migration reviewer, a prompt-eval
runner). It must **never** contain product agents. The seven product agents are TypeScript
modules and are not implemented as Claude Code subagents.
