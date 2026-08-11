# Pipeline — Mission to Outcome

> The end-to-end state machine. Every stage has explicit persisted state.
> Companion docs: [ARCHITECTURE.md](ARCHITECTURE.md) · [AGENTS.md](AGENTS.md) · [DATA_MODEL.md](DATA_MODEL.md)

---

## 1. Shape of the pipeline

```
                    ┌──────────────────────────────────────────┐
                    │ MISSION                        (human)   │
                    └────────────────┬─────────────────────────┘
                                     ▼
                    ┌──────────────────────────────────────────┐
                    │ 1. OPPORTUNITY STRATEGY        (agent)   │
                    └────────────────┬─────────────────────────┘
                                     ▼
                    ┌──────────────────────────────────────────┐
                    │ 2. COMPANY DISCOVERY      (deterministic)│
                    └────────────────┬─────────────────────────┘
                                     ▼
                    ┌──────────────────────────────────────────┐
                    │ 3. COMPANY RANKING       (agent + code)  │
                    └────────────────┬─────────────────────────┘
                                     ▼  top N companies
                    ┌──────────────────────────────────────────┐
                    │ 4. PEOPLE DISCOVERY       (deterministic)│
                    └────────────────┬─────────────────────────┘
                                     ▼
                    ┌──────────────────────────────────────────┐
                    │ 5. PEOPLE RANKING        (agent + code)  │
                    └────────────────┬─────────────────────────┘
                                     ▼  top M people
                    ┌──────────────────────────────────────────┐
                    │ 6. RESEARCH                    (agent)   │
                    └────────────────┬─────────────────────────┘
                                     ▼
                    ┌──────────────────────────────────────────┐
                    │ 7. POSITIONING                 (agent)   │
                    └────────────────┬─────────────────────────┘
                                     ▼
                    ┌──────────────────────────────────────────┐
                    │ 8. OUTREACH                    (agent)   │
                    └────────────────┬─────────────────────────┘
                                     ▼
                    ┌──────────────────────────────────────────┐
                    │ 9. QUALITY CONTROL             (agent)   │◄──┐
                    └────────────────┬─────────────────────────┘   │ revise
                                     ▼                             │ (max 2)
                              pass? ──no────────────────────────────┘
                                     │ yes
                                     ▼
                    ┌──────────────────────────────────────────┐
                    │ 10. HUMAN APPROVAL             (human)   │
                    └────────────────┬─────────────────────────┘
                                     ▼
                    ┌──────────────────────────────────────────┐
                    │ 11. SEND                  (deterministic)│
                    └────────────────┬─────────────────────────┘
                                     ▼
                    ┌──────────────────────────────────────────┐
                    │ 12. RESPONSE TRACKING     (deterministic)│
                    └────────────────┬─────────────────────────┘
                                     ▼
                    ┌──────────────────────────────────────────┐
                    │ 13. LEARNING             (code + agent)  │
                    └──────────────────────────────────────────┘
```

**The funnel is meant to narrow hard.** A representative run:

| Stage | Count |
|---|---|
| Companies discovered | 150–400 |
| Survive hard constraints | 60–150 |
| Companies ranked, top slice kept | 20–30 |
| People discovered | 60–120 |
| People ranked, top slice kept | 10–20 |
| Fully researched | 10–20 |
| Drafts reaching the queue | 10–20 |
| **Approved and sent** | **capped by `max_active_outreach`, default 20** |

The expensive stages (research, positioning, writing) run on a small, already-filtered set.
That ordering is the entire cost model — see [ARCHITECTURE.md](ARCHITECTURE.md#7-cost-and-latency).

---

## 2. Execution model

Stages do not run as one long function call. Each unit of work is a **task row** in Postgres,
claimed and executed by an idempotent worker tick. See
[ARCHITECTURE.md ADR-005](ARCHITECTURE.md#adr-005) for why.

- **`pipeline_runs`** — one row per mission execution. Holds the current stage and run-level status.
- **`pipeline_tasks`** — one row per unit of work: `(run_id, stage, target_type, target_id)`.

A run advances to stage N+1 only when every non-optional task in stage N is `succeeded`,
`failed_permanent`, or `skipped`. Stages 6–9 are per-person and run concurrently across
people; stages 1–5 are ordered.

---

## 3. Run status

```
draft ──► queued ──► running ──► awaiting_approval ──► sending ──► active ──► completed
                        │                                             ▲
                        ├──► paused ─────────────────────────────────┘
                        └──► failed
```

| Status | Meaning |
|---|---|
| `draft` | Mission being defined; nothing executed. |
| `queued` | Accepted, waiting for a worker tick. |
| `running` | Stages 1–9 in progress. |
| `awaiting_approval` | Drafts are in the queue. **The system stops here by default.** |
| `sending` | Approved drafts being delivered, rate-limited. |
| `active` | Everything sent; watching for replies. |
| `completed` | Closed by the user, or every thread resolved. |
| `paused` | User-initiated halt. Resumable — task state is preserved. |
| `failed` | Unrecoverable. Diagnostics preserved on the run row. |

---

## 4. Task status

```
pending ──► claimed ──► running ──┬──► succeeded
                                  ├──► failed_retryable ──► pending  (backoff, max 3)
                                  ├──► failed_permanent
                                  └──► skipped
```

- `claimed` carries a lease timestamp. A task whose lease expires returns to `pending` —
  this is how the system survives a crashed or timed-out worker.
- `failed_retryable` covers transient faults: provider 429/5xx, network, model timeout.
  Backoff is exponential with jitter.
- `failed_permanent` covers faults retrying cannot fix: schema-invalid output after retries,
  a hard constraint violation discovered late, a missing prerequisite.
- `skipped` is a **success** — the pipeline deliberately declined this target
  (e.g. an eval-failed draft, a person with no reachable email).

**A permanently failed task never stalls the run.** Its target drops out; the run continues
with the rest. A run with 18 of 20 people researched still produces good outreach for 18.

---

## 5. Stage reference

### Stage 1 — Opportunity Strategy

| | |
|---|---|
| **Type** | Agent — [Mission Strategist](AGENTS.md#1-mission-strategist) |
| **Input** | Mission objective, hard constraints, soft preferences |
| **Output** | Target industries, company archetypes, target roles, seniority bands, geographic strategy, search hypotheses, concrete discovery queries, rationale |
| **Persists** | `mission_strategies` |
| **Advance when** | Strategy row written and schema-valid |
| **Failure** | `failed` — nothing downstream can proceed without a strategy |

The one stage where the LLM is allowed to be genuinely creative. Its output is a **plan**,
not an action: a set of concrete provider queries the deterministic layer will execute.
Reviewable and editable by the user before discovery spends any API budget.

---

### Stage 2 — Company Discovery

| | |
|---|---|
| **Type** | Deterministic — provider calls, pagination, dedupe |
| **Input** | Discovery queries from stage 1 |
| **Providers** | Apollo `organizations/search` · PitchBook (if enabled) · Web research |
| **Output** | Candidate companies with provenance |
| **Persists** | `companies`, `company_sources` |
| **Advance when** | All queries executed or exhausted |
| **Failure** | Per-query retryable. Zero results across all queries → `awaiting_input` |

No LLM in this stage. Pagination, rate limiting, retries, and dedupe are solved problems and
belong in code.

**Dedupe key:** normalized domain, falling back to normalized name + country. Two providers
returning the same company produce one row with two `company_sources` entries — provenance
is preserved without duplication.

**Hard constraints are applied here**, before ranking. Eliminating a candidate that violates
an absolute requirement costs a boolean check; scoring it costs a model call.

---

### Stage 3 — Company Ranking

| | |
|---|---|
| **Type** | Agent for judgment + deterministic arithmetic |
| **Input** | Surviving companies, mission, strategy |
| **Output** | Component scores, explanations, evidence, overall, confidence |
| **Persists** | `scores` (`subject_type='company'`) |
| **Advance when** | Every surviving company scored |
| **Failure** | Per-company retryable → `skipped`. Company drops out. |

The agent emits **component** scores only. The weighted sum is computed in TypeScript from
`missions.scoring_weights`. Re-weighting re-ranks with zero model spend.

Companies are batched (~10 per call) — enough context to calibrate relatively, small enough
to stay accurate.

**Output of this stage is a cut:** top N companies by score, subject to a confidence floor.
Everything else stops here.

---

### ⚠ Stages 2–6 reorder in the Apollo adapter (Phase 6)

The conceptual sequence below is unchanged, but the **Apollo implementation**
interleaves research earlier, because enrichment is the only step that costs hard
currency. See [ARCHITECTURE.md ADR-014](ARCHITECTURE.md#adr-014).

```
DISCOVER (stubs, free) → CHEAP FILTER (free) → COMPANY RESEARCH (stage 6, early)
  → PRELIMINARY RELEVANCE → SHORTLIST → ENRICHMENT (credits) → PERSON RESEARCH
  → RANKING (stages 3+5)
```

Company research moves *before* people discovery completes, so no credit is spent
on a person whose company has already been shown to be off-mission. Measured
effect on the consulting profile: 40% of companies rejected pre-enrichment.

---

### ⚠ Stages 1–5 become agentic (Phase 7)

The stage *sequence* above still holds. What changed is that stages 1–6 are no
longer single model calls arranged by the orchestrator — they are agents that
search, judge their own results, and decide what to do next, inside caps the
code enforces. See [AGENT_RUNTIME.md](AGENT_RUNTIME.md) and
[ADR-016](ARCHITECTURE.md#adr-016).

```
MISSION
  → MISSION STRATEGIST      generates market hypotheses
  → MARKET DISCOVERY        per hypothesis, a bounded SESSION:
                              search → inspect → diagnose → choose next action
                              (accept / refine / narrow / broaden / synonyms /
                               adjacent / follow company / kill hypothesis)
  → COMPANY VALIDATION      grounded research → KEEP | MAYBE | REJECT
                              + the real job titles to search for at THIS company
  → PEOPLE SCOUT            deterministic Apollo resolution (no judgment left here)
  → PERSON RESEARCH         KEEP | MAYBE | REJECT | SEARCH_FOR_DIFFERENT_PERSON
                              └─ re-scout ──> PEOPLE SCOUT (one bounded pass)
  → RANKING                 component judgments only; code computes the total
  → PERSISTENCE             companies, contacts, research_facts, agent_runs
```

**Three things about this diagram matter more than the boxes.**

**Apollo stopped being a discovery tool.** It resolves *people* inside companies
that web research already validated. Which titles to ask for is decided per
company from its researched size and archetype — a founder at a 12-person
startup, a director who owns the function at a 90,000-person manufacturer
([ADR-018](ARCHITECTURE.md#adr-018)).

**There is exactly one upstream edge.** `SEARCH_FOR_DIFFERENT_PERSON` sends a
role hypothesis back to People Scout, once, and only when the agent can name a
searchable job title. Every additional feedback edge multiplies the states a run
can be in and makes cost unattributable ([ADR-019](ARCHITECTURE.md#adr-019)).

**Rejection is a first-class outcome at three stages.** Discovery may kill its
own hypothesis, validation may REJECT a company before any credit is spent, and
research may REJECT a person before ranking sees them. Ranking orders qualified
prospects; it is not there to rescue bad discovery.

---

### Stage 4 — People Discovery

| | |
|---|---|
| **Type** | Deterministic — Apollo `people/search` scoped per company |
| **Input** | Top-N companies, target roles and seniority from stage 1 |
| **Output** | Candidate people with title, seniority, LinkedIn URL, email availability |
| **Persists** | `contacts` (with `company_id`), `contact_sources` |
| **Advance when** | Every top company searched |
| **Failure** | Per-company retryable → `skipped`. A company with no reachable people drops out. |

Title and seniority filters come from the strategy, not from hardcoded lists.
Dedupe against existing contacts by `(user_id, linkedin_url)` — the V1 unique index — then by
`(user_id, email)`. **A person already contacted in a previous mission is not re-surfaced**
unless the user explicitly allows it.

---

### Stage 5 — People Ranking

| | |
|---|---|
| **Type** | Agent for judgment + deterministic arithmetic |
| **Input** | Candidate people, their company, mission, strategy |
| **Output** | Component scores, explanations, evidence, overall, confidence |
| **Persists** | `scores` (`subject_type='person'`) |
| **Advance when** | Every candidate scored |
| **Failure** | Per-person retryable → `skipped` |

Ranked on the intersection of **can help** and **plausible reason to care** — explicitly not
on seniority. See [PRODUCT.md §5](PRODUCT.md#5-scoring).

**Output is the second cut**, and the one that governs cost: only people who survive here get
research, positioning, and writing. The "one person per company at a time" rule from
[PRODUCT.md §3](PRODUCT.md#3-design-consequences-of-the-north-star) is enforced at this cut,
in code.

---

### Stage 6 — Research

| | |
|---|---|
| **Type** | Agent — [Research Agent](AGENTS.md#4-research-agent) with web tools |
| **Input** | A person and their company |
| **Output** | Facts with sources, developments, role interpretation, likely priorities, hooks, uncertainties |
| **Persists** | `research_dossiers`, `research_facts` |
| **Advance when** | Dossier written for every surviving person |
| **Failure** | Retryable → `skipped`. Person continues **only if** a minimum dossier exists (§7). |

**The linchpin stage.** Everything downstream is a function of research quality. A brilliant
positioning agent reasoning over hallucinated facts produces a confidently wrong email.

Every claim is typed:

| Type | Meaning | May appear in an email? |
|---|---|---|
| `FACT` | Verified, source URL attached | **Yes** |
| `INFERENCE` | Reasoned from facts, labeled as such | Only as hedged framing, never as assertion |
| `UNKNOWN` | Explicitly identified gap | No — but it steers what to ask |

`UNKNOWN` is a first-class output, not an absence. "I could not determine who owns AI
initiatives here" is useful: it tells positioning what not to assume and can itself become an
honest question in the email.

---

### Stage 7 — Positioning

| | |
|---|---|
| **Type** | Agent — [Positioning Agent](AGENTS.md#6-positioning-agent) |
| **Input** | Mission, company dossier, person dossier, **retrieved** talent items |
| **Output** | Their priorities, user's relevant evidence, intersection, thesis, what NOT to mention, suggested ask |
| **Persists** | `positioning_angles` |
| **Advance when** | Angle written for every researched person |
| **Failure** | Retryable → `skipped`. No angle means no email. |

The most important agent in the system. It answers:

> **Why should this exact person care about this exact user?**

Talent items are **retrieved and ranked first** by a separate deterministic + agent step, not
dumped. The prompt receives a shortlist of candidate proof points; the agent selects 1–3 and
records which and why. See [PRODUCT.md §7](PRODUCT.md#7-the-talent-knowledge-base).

**`what_not_to_mention` is deliberately part of the output.** Knowing that a user's crypto
project will land badly at a regulated industrial firm is as valuable as knowing which
project to lead with, and nothing else in the pipeline captures that.

---

### Stage 8 — Outreach

| | |
|---|---|
| **Type** | Agent — [Outreach Agent](AGENTS.md#7-outreach-agent) |
| **Input** | Mission, person, company, research, positioning |
| **Output** | Subject, body, CTA type, claim→fact citations |
| **Persists** | `outreach_drafts` (status `generated`) |
| **Advance when** | Draft written for every positioned person |
| **Failure** | Retryable → `skipped` |

The agent must emit a **citation map**: every factual claim about the recipient linked to the
`research_facts` row supporting it. Stage 9 verifies against this. An uncitable claim is a
fabrication by definition, and this makes that mechanically checkable rather than a matter of
prompt discipline.

---

### Stage 9 — Quality Control

| | |
|---|---|
| **Type** | Deterministic checks + agent judge |
| **Input** | Draft, positioning, research facts, mission |
| **Output** | Per-criterion scores and verdicts |
| **Persists** | `evaluations` |
| **Advance when** | Every draft has passed, or exhausted its revision budget |
| **Failure** | → `flagged`, still queued for the human |

Deterministic first (word count, banned phrases, CTA present, citations resolve) because it is
free and catches the common failures. Then the agent judges the eight criteria from
[EVALS.md](EVALS.md).

**Revision loop:** fail → revise with specific critique → re-evaluate. **Maximum 2 revisions.**

If a draft still fails, it enters the approval queue **flagged with its failures shown**.
It is never silently discarded — the human decides. A system that hides its failures teaches
its operator to trust it more than it deserves.

---

### Stage 10 — Human Approval

| | |
|---|---|
| **Type** | Human |
| **Surface** | `/dashboard/drafts`, extended from V1's existing approval queue |
| **Persists** | `outreach_drafts.status` → `approved` \| `rejected` \| `edited` |

The user sees the draft **and its reasoning**: positioning thesis, proof points chosen and
why, each claim with its source, and eval results.

Edits are captured as a diff against the generated text. That diff is one of the most valuable
learning signals in the system — it is the user directly demonstrating the gap between what the
model wrote and what they were willing to send. Far higher signal than a reply rate at these
volumes.

Rejection asks for a one-click reason. That is the other high-value signal.

The run parks in `awaiting_approval` indefinitely. There is no timeout on a human.

---

### Stage 11 — Send

| | |
|---|---|
| **Type** | Deterministic — **V1's existing Gmail path, unchanged** |
| **Input** | Approved drafts |
| **Persists** | `emails` (existing table), `outreach_drafts.status` → `sent` |
| **Guards** | Daily cap · per-mission `max_active_outreach` · one-per-company · pacing |

Reuses `lib/email/send.ts` (V1's `resend.ts`) as-is. It works, it handles MIME and threading
correctly, and it is the most carefully built code in the repo.

Sends are **paced, not blasted** — a natural interval between messages. Twenty identical-timestamp
emails is a spam signal and, more importantly, is not how a person sends mail.

---

### Stage 12 — Response Tracking

| | |
|---|---|
| **Type** | Deterministic — **V1's existing Gmail sync, unchanged** |
| **Input** | Gmail threads for sent messages |
| **Persists** | `messages`, `conversations`, `outcomes` |

`lib/email/sync.ts` already does this idempotently, with backfill. V2 adds one thing: mapping
a classified reply to a richer **outcome** vocabulary.

V1 classifications (`positive` / `negative` / `neutral` / `auto_reply` / `bounce`) are retained
and extended:

`no_response` · `positive_response` · `negative_response` · `referral` · `meeting_booked` ·
`resume_requested` · `opportunity_discussion` · `project_created` · `internship_created`

`no_response` is materialized by a **timer**, not a message — after a configurable silence
window (default 21 days) a thread is recorded as `no_response`. Without this, the most common
outcome would be invisible to analytics, and the system would learn only from people who replied.

---

### ⚠ Stages 10–12 as built (Phase 9)

The design above survived contact intact; three details are worth recording because they
differ from what the plan assumed.

**The surface is `/dashboard/outreach`, not `/dashboard/drafts`.** V1's drafts queue is
template-driven and campaign-shaped. Scouted outreach carries a positioning brief, an
evidence pool and a grounding result that queue has no concept of, so it got its own page.
V1's stays untouched and working.

**State lives on `outreach`, not on `outreach_drafts.status`.** One table, one row per
(user, contact), holding the relationship rather than the message
([ADR-022](ARCHITECTURE.md#adr-022)). It points at an `emails` row, which is what keeps
Stage 12 working with no change to `lib/email/sync.ts` at all.

**Stage 9 (Quality Control) is now partly deterministic and blocking.** The plan had evals
gating the draft; what shipped is a regex-and-set-arithmetic claim gate that runs at approval
*and again at send*, because editing is how an unsupported claim gets back into a draft that
already passed. Unresolved quantities, proper nouns, ranking words and
recipient-responsibility claims block with no override
([ADR-023](ARCHITECTURE.md#adr-023)).

**Not yet built, from the stages above:** send pacing (drafts are sent one at a time, by
hand, so there is nothing to pace yet), `max_active_outreach`, one-per-company, and the
`no_response` timer. The last one matters most — until it exists, the most common outcome is
recorded only when the user selects it by hand.

Sequence as built:

```
draft ──▶ ready_for_review ──▶ approved ──▶ sending ──▶ sent ──▶ replied ──▶ meeting
  │              │                │            │                    │        referred
  └──▶ skipped ◀─┘                └──▶ failed ─┘                    └──▶ closed
```

Full write-up: [PHASE_SENDING.md](PHASE_SENDING.md).

---

### Stage 13 — Learning

| | |
|---|---|
| **Type** | Deterministic aggregation now; agent synthesis later |
| **Input** | `outcomes` joined to scores, positioning, drafts, evals |
| **Output** | Descriptive analytics with sample sizes attached |
| **Persists** | `outcome_events` |

Dimensions: company type, industry, seniority, title, angle, proof point, CTA, subject style,
length, geography, source, timing.

**Phase 11 is logging and descriptive analytics only.** No weight auto-tuning. At tens of
sends there is no signal to learn from, and a model fit to that noise will be confidently
wrong. Every displayed pattern carries its `n`, and patterns below a threshold are shown as
"insufficient data" rather than as findings.

The loop closes through the human: the system surfaces the pattern, the user adjusts the
mission. That is a real learning loop — it just has a person in it, which at this sample size
is a feature.

---

## 6. Where a run can stop

| Stop | Trigger | Recovery |
|---|---|---|
| `awaiting_approval` | Drafts ready — **the normal, intended stop** | User approves |
| `awaiting_input` | Discovery returned nothing usable | User loosens constraints |
| `paused` | User halted it | Resume; task state preserved |
| `failed` | Stage 1 failed, or a provider is unreachable | Fix config, retry |

---

## 7. Minimum-quality gates

A target must clear these to advance. They prevent the pipeline from spending expensive
stages on inputs that cannot produce good outreach.

| Gate | Rule |
|---|---|
| Company → ranking | Passes all hard constraints |
| Company → people discovery | Overall score ≥ mission floor (default 0.55) |
| Person → research | Overall score ≥ mission floor **and** company not already engaged |
| Person → positioning | Dossier has ≥ 2 `FACT`-typed items with sources |
| Person → outreach | Positioning has ≥ 1 selected proof point and a thesis |
| Draft → approval queue | Evals complete (pass, or fail-with-flag after 2 revisions) |
| Draft → send | Human approval **always** |

The "≥ 2 sourced facts" gate is the one that most directly protects the North Star. Below
that threshold there is nothing true and specific to say, and the email collapses into
exactly the generic networking language [PRODUCT.md §9](PRODUCT.md#9-outreach-voice) forbids.
Better to drop the prospect than to send a weak email under the user's name.
