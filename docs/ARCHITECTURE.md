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
