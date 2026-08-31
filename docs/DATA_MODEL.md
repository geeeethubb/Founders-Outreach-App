# Data Model — Outreach OS V2

> Proposed database changes. Adapts the existing schema rather than duplicating it.
> Companion docs: [CURRENT_STATE.md §4](CURRENT_STATE.md#4-database) · [ARCHITECTURE.md](ARCHITECTURE.md)

---

## 1. Approach

**Additive and non-breaking.** Every V1 table survives. Every V1 screen keeps working while
V2 is built alongside it. There is no cutover moment.

Three principles govern the mapping from the spec's entity list to actual tables:

1. **Reuse before creating.** `contacts` is already the person entity, with RLS, a unique
   index, status transitions, and six screens on it. Adding a parallel `people` table would
   fork all of that for a naming preference. ([ADR-012](ARCHITECTURE.md#adr-012))
2. **Collapse entities that share a lifecycle and a retrieval path.** Nine talent kinds
   become one table, not nine. ([ADR-003](ARCHITECTURE.md#adr-003))
3. **Generalize where the spec repeats itself.** `company_scores` and `person_scores` have
   identical shapes; so do the research and evaluation tables. One polymorphic table each,
   with a `subject_type` discriminator.

---

## 2. Spec entity → actual table

| Spec entity | Becomes | Why |
|---|---|---|
| `missions` | **new** `missions` | Core new concept ([ADR-002](ARCHITECTURE.md#adr-002)) |
| `mission_preferences` | column on `missions` (jsonb) | Always read with the mission; never queried independently. A join table would buy nothing. |
| `companies` | **new** `companies` | First-class ([ADR-001](ARCHITECTURE.md#adr-001)) |
| `company_research` | `research_dossiers` (`subject_type='company'`) | Same shape as person research |
| `company_scores` | `scores` (`subject_type='company'`) | Same shape as person scores |
| `people` | **existing `contacts`**, extended | ADR-012 |
| `person_research` | `research_dossiers` (`subject_type='person'`) | |
| `person_scores` | `scores` (`subject_type='person'`) | |
| `experiences`, `projects`, `skills`, `proof_points` | **one** `talent_items` with `kind` | ADR-003 |
| `positioning_angles` | **new** `positioning_angles` | |
| `outreach_drafts` | **new** `outreach_drafts` | Pre-approval state, distinct from `emails` |
| `outreach_messages` | **existing `emails`** | Already is this. Do not duplicate. |
| `campaigns` | **existing `campaigns`**, extended with `mission_id` | |
| `interactions`, `responses` | **existing `messages`** | Already populated by Gmail sync |
| `meetings`, `referrals` | `outcomes` rows with a type | Both are outcomes; separate tables would fragment analytics |
| `agent_runs` | **new** `agent_runs` | |
| `evaluations` | **new** `evaluations` | |

**Net: 10 new tables, 4 extended, 3 dropped.**

---

## 3. New tables

### `missions`

```sql
create table missions (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid references profiles(id) on delete cascade not null,
  name                text not null,
  objective           text not null,            -- free text: "Find a winter internship..."
  hard_constraints    jsonb default '[]',       -- [{dimension, operator, value, label}]
  soft_preferences    jsonb default '[]',       -- [{dimension, value, weight, label}]
  scoring_weights     jsonb,                    -- null = system defaults
  timing_window       jsonb,                    -- {starts_at, ends_at, label}
  max_active_outreach int  default 20,          -- PRODUCT.md §3 — enforced in code
  min_score_threshold float default 0.55,
  autonomy_level      text default 'approval_required'
                      check (autonomy_level in ('approval_required','autonomous')),
  status              text default 'draft'
                      check (status in ('draft','active','paused','completed','archived')),
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);
```

`hard_constraints` and `soft_preferences` are **jsonb, not enum columns**, because the
dimension list must accept values nobody has thought of yet
([PRODUCT.md §4](PRODUCT.md#4-the-mission-system)). Structure is enforced by Zod at the
application boundary, which is the right place for a shape that will change often.

`autonomy_level` defaults to `approval_required` at the schema level so autonomous sending
cannot be enabled by omission.

---

### `mission_strategies`

```sql
create table mission_strategies (
  id                  uuid primary key default gen_random_uuid(),
  mission_id          uuid references missions(id) on delete cascade not null,
  run_id              uuid references pipeline_runs(id) on delete set null,
  version             int  not null default 1,
  target_industries   jsonb default '[]',
  company_archetypes  jsonb default '[]',
  target_roles        jsonb default '[]',
  geographic_strategy jsonb,
  search_hypotheses   jsonb default '[]',
  discovery_queries   jsonb default '[]',
  rationale           text,
  edited_by_user      boolean default false,
  agent_run_id        uuid references agent_runs(id),
  created_at          timestamptz default now()
);
```

Versioned rather than mutated, because a strategy edit changes what the pipeline searches for.
Comparing run 1's strategy against run 2's is how the user learns which framing found better
companies.

---

### `companies`

```sql
create table companies (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references profiles(id) on delete cascade not null,
  name              text not null,
  domain            text,                       -- normalized; primary dedupe key
  normalized_name   text,                       -- fallback dedupe key
  description       text,
  industry          text,
  sub_industries    text[] default '{}',
  employee_count    int,
  employee_range    text,
  stage             text,                       -- seed, series_a, growth, public, private
  founded_year      int,
  hq_location       text,
  country           text,
  website_url       text,
  linkedin_url      text,
  provider_data     jsonb default '{}',         -- raw payloads keyed by provider id
  status            text default 'discovered'
                    check (status in ('discovered','filtered_out','ranked','targeted','engaged','archived')),
  filtered_reason   text,                       -- which hard constraint eliminated it
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

create unique index companies_user_domain_uniq
  on companies (user_id, domain) where domain is not null;
create unique index companies_user_normname_uniq
  on companies (user_id, normalized_name) where domain is null;
```

Two partial unique indexes implement the dedupe rule from
[PIPELINE.md §5](PIPELINE.md#stage-2--company-discovery): domain when known, normalized name
otherwise. This mirrors V1's proven `contacts_user_linkedin_unique` pattern.

`filtered_reason` is populated on hard-constraint elimination. Without it, "why isn't Acme in
my list?" is unanswerable — and that question will be asked.

---

### `company_sources` / `contact_sources`

```sql
create table company_sources (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid references companies(id) on delete cascade not null,
  provider_id  text not null,                   -- 'apollo' | 'pitchbook' | 'web'
  external_id  text,
  query_ref    jsonb,                           -- the query that surfaced it
  raw          jsonb,
  discovered_at timestamptz default now(),
  unique (company_id, provider_id, external_id)
);
-- contact_sources: identical shape, contact_id instead of company_id
```

Provenance without duplication. Two providers returning the same company yield one
`companies` row and two source rows.

---

### `talent_items`

```sql
create table talent_items (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references profiles(id) on delete cascade not null,
  kind          text not null check (kind in (
                  'experience','project','skill','accomplishment','story',
                  'interest','domain_knowledge','proof_point','quantified_result')),
  title         text not null,
  summary       text,                            -- 1-2 sentences, used in retrieval shortlists
  detail        text,                            -- full narrative, used only when selected
  started_at    date,
  ended_at      date,
  metadata      jsonb default '{}',              -- kind-specific: org, url, metric, role...

  -- tagging dimensions (PRODUCT.md §7)
  industries        text[] default '{}',
  problem_types     text[] default '{}',
  technical_skills  text[] default '{}',
  business_skills   text[] default '{}',
  roles             text[] default '{}',
  audience_relevance text[] default '{}',
  company_stages    text[] default '{}',
  credibility_signal text,                       -- 'strong' | 'moderate' | 'supporting'

  is_active     boolean default true,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

create index talent_items_user_kind_idx on talent_items (user_id, kind) where is_active;
create index talent_items_industries_idx on talent_items using gin (industries);
create index talent_items_problem_types_idx on talent_items using gin (problem_types);
```

**Why `summary` and `detail` are separate columns.** Retrieval shortlists ~10–15 items into
the Positioning Agent's prompt. Sending full detail for all of them reproduces exactly the
context-bloat problem V1 has. Shortlists carry `summary`; only selected items contribute
`detail`. This is the concrete mechanism behind "never dump the résumé."

GIN indexes on the two highest-selectivity tag arrays support deterministic retrieval before
any semantic ranking. Embeddings can be added later via `pgvector` without schema disruption —
retrieval quality is not the bottleneck at this scale.

---

### `research_dossiers` and `research_facts`

```sql
create table research_dossiers (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references profiles(id) on delete cascade not null,
  subject_type  text not null check (subject_type in ('company','person')),
  subject_id    uuid not null,                   -- companies.id or contacts.id
  mission_id    uuid references missions(id) on delete set null,
  run_id        uuid references pipeline_runs(id) on delete set null,
  role_interpretation  text,
  likely_priorities    jsonb default '[]',
  relevant_initiatives jsonb default '[]',
  recent_developments  jsonb default '[]',
  conversation_hooks   jsonb default '[]',
  uncertainties        text[] default '{}',
  fact_count           int default 0,            -- denormalized; gates stage 7 cheaply
  agent_run_id  uuid references agent_runs(id),
  created_at    timestamptz default now()
);

create table research_facts (
  id            uuid primary key default gen_random_uuid(),
  dossier_id    uuid references research_dossiers(id) on delete cascade not null,
  claim         text not null,
  fact_type     text not null check (fact_type in ('FACT','INFERENCE','UNKNOWN')),
  source_url    text,
  source_title  text,
  confidence    float check (confidence between 0 and 1),
  relevance     text,
  created_at    timestamptz default now(),

  -- A FACT without a source is not a fact. Enforced by the database.
  constraint fact_requires_source
    check (fact_type <> 'FACT' or source_url is not null)
);
```

**`fact_requires_source` is the most important constraint in the schema.** It makes the
central research rule ([AGENTS.md §4](AGENTS.md#4-research-agent)) a database invariant rather
than a prompt instruction. A hallucinated fact cannot be persisted, so it can never reach
positioning or an email — regardless of how the agent behaves.

`fact_count` is denormalized so the "≥ 2 sourced facts" gate is a column read, not a
`COUNT(*)` per person per stage transition.

Polymorphic `subject_id` is intentionally **not** a foreign key — it points at two tables.
Referential integrity is enforced in the application layer. The alternative (two near-identical
table pairs) would double the query surface for every research read.

---

### `scores`

```sql
create table scores (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references profiles(id) on delete cascade not null,
  subject_type  text not null check (subject_type in ('company','person')),
  subject_id    uuid not null,
  mission_id    uuid references missions(id) on delete cascade not null,
  run_id        uuid references pipeline_runs(id) on delete set null,

  components    jsonb not null,   -- [{dimension, score, explanation, evidence[]}]
  weights_used  jsonb not null,   -- snapshot: what produced overall_score
  overall_score float not null check (overall_score between 0 and 1),
  confidence    float check (confidence between 0 and 1),
  summary       text,

  agent_run_id  uuid references agent_runs(id),
  computed_at   timestamptz default now(),
  unique (subject_type, subject_id, mission_id, run_id)
);
```

**`weights_used` is a snapshot, not a reference.** Weights on `missions` can change; a score
row must remain explainable as of when it was computed. Without this, re-weighting silently
rewrites the history of why something ranked where it did.

Because components are stored, re-ranking under new weights is a pure recomputation in
`lib/scoring/compute.ts` — no model calls ([ADR-004](ARCHITECTURE.md#adr-004)).

---

### `positioning_angles`

```sql
create table positioning_angles (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid references profiles(id) on delete cascade not null,
  contact_id          uuid references contacts(id) on delete cascade not null,
  mission_id          uuid references missions(id) on delete cascade not null,
  run_id              uuid references pipeline_runs(id) on delete set null,

  their_priorities    jsonb default '[]',
  intersection        text,
  thesis              jsonb not null,   -- {them, you, intersection, angle}
  selected_proof_points jsonb not null, -- [{talent_item_id, why_this_one, rank}]  1–3
  credibility_signals jsonb default '[]',
  what_not_to_mention jsonb default '[]',
  suggested_ask       jsonb,            -- {ask_type, phrasing_guidance, reasoning}
  confidence          float,

  agent_run_id        uuid references agent_runs(id),
  created_at          timestamptz default now()
);
```

`selected_proof_points` stores `talent_item_id` references, so the learning system can later
ask "which proof points actually produce conversations?" — one of the few analytics questions
that stays meaningful at low sample sizes, because it aggregates across prospects rather than
across outcomes.

---

### `outreach_drafts`

```sql
create table outreach_drafts (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references profiles(id) on delete cascade not null,
  contact_id     uuid references contacts(id) on delete cascade not null,
  mission_id     uuid references missions(id) on delete cascade not null,
  run_id         uuid references pipeline_runs(id) on delete set null,
  positioning_id uuid references positioning_angles(id) on delete set null,

  subject        text not null,
  body           text not null,
  cta_type       text,
  citations      jsonb default '[]',    -- [{claim_text, fact_id}]
  angle_used     text,
  word_count     int,
  revision_number int default 0,

  status         text default 'generated' check (status in (
                   'generated','evaluating','passed','flagged',
                   'approved','rejected','sent','superseded')),
  eval_summary   jsonb,
  rejection_reason text,
  user_edited    boolean default false,
  original_body  text,                  -- pre-edit text, kept when user_edited

  email_id       uuid references emails(id),   -- set on send
  agent_run_id   uuid references agent_runs(id),
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);
```

**Why this is separate from `emails`.** `emails` is the record of what was or will be sent, and
the entire Gmail send/sync path depends on its current shape. `outreach_drafts` is the
pre-approval workspace: revisions, eval results, citations, rejections. Merging them would
push V2 concepts into the one subsystem [ADR-007](ARCHITECTURE.md#adr-007) commits to leaving
alone. On approval, a draft **creates** an `emails` row and links to it.

`original_body` + `user_edited` capture the approval-stage edit diff — per
[PIPELINE.md §5](PIPELINE.md#stage-10--human-approval), the highest-signal learning data
available at these volumes.

> **⚠ As built (Phase 9): this table is called `outreach`, and it holds more.**
>
> The spec's reasoning above was right and is preserved verbatim. What changed is scope: the
> shipped table also carries the **relationship** — the send result, the reply, the
> classification, the follow-up state and the outcome — not only the pre-approval workspace
> ([ADR-022](ARCHITECTURE.md#adr-022)). "Replied", "meeting" and "referred" are facts about a
> person, not about a message, and putting them on a per-message row would need a second row
> for a follow-up carrying the same relationship state: two rows, one truth.
>
> Renamed and reshaped from the spec:
>
> | spec | as built |
> |---|---|
> | `status` (8 values) | `state` (11), a tested transition table in `lib/outreach/states.ts` |
> | `citations` | `allowed_claims` (the evidence pool) + `grounding` (the gate result) |
> | `original_body` / `user_edited` | `body` (agent) / `body_edited` (user) / `edited_at` |
> | `positioning_id` | `positioning` jsonb — a **snapshot**, so a prompt-version bump cannot rewrite history |
> | `mission_id` | `mission_goal` text — missions (Phase 1) do not exist yet |
> | — | `send_attempts`, `send_error`, `gmail_thread_id`, `rfc822_message_id` |
> | — | `reply_classification`, `reply_action`, `suggested_reply`, `conversation_id` |
> | — | `followup_count`, `followup_suggestion`, `followup_due_at` |
> | — | `outcome`, `outcome_at`, `outcome_note` |
> | — | `segment`, `company_type`, `recipient_role`, `score` — denormalised for the funnel |
>
> Constraints that carry weight: `unique (user_id, contact_id)` — one live outreach per
> person; `unique (email_id) where email_id is not null` — one outreach per message. A
> companion `outreach_events` table records every transition with its actor, so retries and
> reverts stay legible.
>
> `outcomes` / `outcome_events` below are **not built**; `outreach.outcome` collapses them
> while the volume is this small ([ADR-003](ARCHITECTURE.md#adr-003)).
>
> Migration: `supabase/migrations/012_outreach.sql`.

---

### `pipeline_runs` and `pipeline_tasks`

```sql
create table pipeline_runs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references profiles(id) on delete cascade not null,
  mission_id    uuid references missions(id) on delete cascade not null,
  status        text default 'queued' check (status in (
                  'draft','queued','running','awaiting_approval','awaiting_input',
                  'sending','active','paused','completed','failed')),
  current_stage text,
  stage_state   jsonb default '{}',     -- per-stage counters for the progress UI
  error         text,
  started_at    timestamptz,
  completed_at  timestamptz,
  created_at    timestamptz default now()
);

create table pipeline_tasks (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid references pipeline_runs(id) on delete cascade not null,
  stage         text not null,
  target_type   text,                   -- 'company' | 'person' | 'draft' | null
  target_id     uuid,
  status        text default 'pending' check (status in (
                  'pending','claimed','running','succeeded',
                  'failed_retryable','failed_permanent','skipped')),
  attempts      int default 0,
  max_attempts  int default 3,
  lease_until   timestamptz,            -- expiry returns the task to pending
  payload       jsonb default '{}',
  result        jsonb,
  error         text,
  skipped_reason text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

create index pipeline_tasks_claimable_idx
  on pipeline_tasks (run_id, stage, status) where status = 'pending';
```

Claiming uses `FOR UPDATE SKIP LOCKED` so concurrent ticks never collide
([ADR-005](ARCHITECTURE.md#adr-005)). `lease_until` is the crash-recovery mechanism: a worker
that dies mid-task leaves a lease that expires, and the task returns to `pending`
automatically. No supervisor process, no external queue.

---

### `agent_runs`

```sql
create table agent_runs (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references profiles(id) on delete cascade not null,
  run_id         uuid references pipeline_runs(id) on delete set null,
  task_id        uuid references pipeline_tasks(id) on delete set null,
  agent_id       text not null,
  prompt_version text not null,
  model          text not null,
  model_role     text,                  -- 'fast' | 'reasoning' | 'writing'
  input_refs     jsonb default '{}',    -- row ids, NOT payloads
  tools_called   jsonb default '[]',
  output         jsonb,
  tokens_in      int,
  tokens_out     int,
  latency_ms     int,
  cost_estimate  numeric(10,6),
  status         text check (status in ('succeeded','failed','invalid_output')),
  error          text,
  created_at     timestamptz default now()
);

create index agent_runs_run_idx on agent_runs (run_id, created_at);
create index agent_runs_agent_idx on agent_runs (user_id, agent_id, created_at desc);
```

`input_refs` stores ids rather than payloads: payloads would bloat the table and duplicate
data that already lives in its own rows. The tradeoff — a trace is fully reconstructible only
while its source rows exist — is acceptable, since those rows are the product's own data.

---

### `evaluations`

```sql
create table evaluations (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references profiles(id) on delete cascade not null,
  subject_type   text not null check (subject_type in ('draft','dossier','score','positioning')),
  subject_id     uuid not null,
  criterion      text not null,
  score          float check (score between 0 and 1),
  verdict        text check (verdict in ('pass','fail','warn')),
  justification  text,
  is_deterministic boolean default false,
  revision_number int default 0,
  agent_run_id   uuid references agent_runs(id),
  created_at     timestamptz default now()
);

create index evaluations_subject_idx on evaluations (subject_type, subject_id, revision_number);
```

Rows are **appended per revision, never overwritten**. "Failed specificity twice, passed on
the third" is a far more useful record than a final verdict, and it is the raw material for
improving the Outreach Agent's prompt ([EVALS.md §7](EVALS.md#7-implementation)).

---

### `outcomes` and `outcome_events`

```sql
create table outcomes (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references profiles(id) on delete cascade not null,
  contact_id     uuid references contacts(id) on delete cascade not null,
  mission_id     uuid references missions(id) on delete set null,
  conversation_id uuid references conversations(id) on delete set null,
  draft_id       uuid references outreach_drafts(id) on delete set null,
  outcome_type   text not null check (outcome_type in (
                   'no_response','positive_response','negative_response','referral',
                   'meeting_booked','resume_requested','opportunity_discussion',
                   'project_created','internship_created')),
  detail         text,
  occurred_at    timestamptz default now(),
  created_at     timestamptz default now()
);

create table outcome_events (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references profiles(id) on delete cascade not null,
  outcome_id     uuid references outcomes(id) on delete cascade,
  dimensions     jsonb not null,   -- flattened analysis dims, snapshotted
  created_at     timestamptz default now()
);
```

`outcome_events.dimensions` **snapshots** the analysis dimensions from
[PRODUCT.md §10](PRODUCT.md#10-outcomes-and-learning) — company type, industry, seniority,
title, angle, proof point, CTA, subject style, length, geography, source, timing — at the
moment of the outcome. Reconstructing them later by joining across ten tables that have since
changed would produce quietly wrong analytics.

`no_response` is written by a **timer**, not a message: after a silence window (default 21
days), a job records it. Without this, the most common outcome is invisible and the system
learns only from people who replied — a textbook survivorship bias that would systematically
overvalue whatever the responders had in common.

---

### `contact_index` and `network_matches` (Phase 10 — shipped)

Two tables, and the split between them is the whole design.

```sql
create table contact_index (
  contact_id  uuid primary key references contacts(id) on delete cascade,
  user_id     uuid not null,
  headline    text,      -- name · title · company        weight A
  tags_text   text,      -- flattened classification       weight B
  body_text   text,      -- research, hooks, facts         weight C
  search_vector tsvector generated always as (
    setweight(to_tsvector('english', coalesce(headline,  '')), 'A') ||
    setweight(to_tsvector('english', coalesce(tags_text, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(body_text, '')), 'C')
  ) stored,
  -- deterministic, free
  seniority_band, function_area, geo_city, geo_state, geo_country, geo_region, company_norm,
  -- classified once, cached by hash
  industry, sub_industry, function, company_type, company_stage,
  technical_domains text[], business_domains text[], opportunity_types text[], tags text[],
  relevance jsonb,          -- {recruiting: 0.9, mentorship: 0.4, …} — dispositions, not verdicts
  -- relationship, computed from emails/conversations/outreach
  relationship_status, touches, replies, last_contacted_at, last_reply_at,
  -- freshness
  evidence_level, source_hash, index_version, classifier_version, classified_at
);
```

**Why weighted bands rather than one blob.** Ranking over a single text column makes a plant
manager whose *title* says "manufacturing" indistinguishable from a marketer whose research
paragraph mentions it once. That is the difference between a retrieval layer and a grep.

**Why `source_hash`.** Classification is the only part of indexing that costs money, and the
hash covers exactly the material the classifier reads. Re-indexing after a scouting run
classifies the new people and nobody else. Measured: 897 contacts for **$1.59**, once.

**A search function, not a view** — `search_contact_index(...)` does ranked full-text search
with structured filters and a relevance floor, because `ts_rank` cannot be expressed through
PostgREST. See [ADR-025](ARCHITECTURE.md#adr-025).

**The GIN index is not used by that function, knowingly.** Its predicate is
`tsq is null or search_vector @@ tsq`, and Postgres indexes a disjunction only when every
branch is independently indexable — so the scan is sequential. Const-folding cannot help: a
`language sql` body is planned with `boundParams = NULL`, so `p_query` is never a constant.
The index stays because it costs little and serves any direct `@@` query, and the STORED
column it implies is what makes `ts_rank` cheap either way. Measured, the gap is ~8ms per call
at 33× the current corpus, in front of a multi-second model turn. If it ever matters, the fix
is `language plpgsql` with two separately-planned branches — not inlining
`websearch_to_tsquery` into the predicate, which re-parses the query about twice per row.

```sql
create table network_matches (
  id uuid primary key, user_id uuid not null,
  run_id uuid references scouting_runs(id) on delete cascade,
  contact_id uuid references contacts(id) on delete cascade,
  mission_goal text, score numeric, confidence numeric,
  reason text, evidence text[], matched_by text[],
  stage text check (stage in ('retrieved','shortlisted','rejected')), rank int,
  unique (run_id, contact_id)
);
```

**Scores live here and never on the contact.** A person weak for winter industrial AI may be
strong for summer consulting or for mentorship. Writing a "quality" number back onto
`contacts` would let the first mission that ran poison every later one — which is precisely
the thing this milestone exists to make impossible.

### `outreach_edits` (Phase 10 — shipped)

Append-only pairs of (what the agent wrote, what the user sent).

`outreach.body` / `body_edited` already hold the latest pair, but a redraft overwrites them,
and the interesting question — *what does this user consistently change?* — needs more than
one sample to answer.

**Nothing reads it yet, deliberately.** Rewriting global style rules from a single edit is
exactly the overfitting the campaign-reference design replaces.

---

### Career OS — `014_career_os.sql` (Phase 11 — shipped, needs founder action)

Twenty-three tables, three extended, one storage bucket. Column lists live in the migration;
the shape and the reasons are in [CAREER_OS.md §4](CAREER_OS.md#4-data-model).

```
career_missions            objective · season · preferences (jsonb) · hard_constraints · fit_weights
evidence_experiences       ─┬─ evidence_facts (statement · category · source · source_location · approved)
                            ├─ evidence_metrics · evidence_deliverables · evidence_stories
evidence_skills · evidence_preferences
resume_documents           ─── resume_bullets (paragraph_index · text with **bold** · evidence_fact_ids · is_on_master · approved)
companies (+ careers_url · ats_type · ats_identifier · watch_status · watch_priority · research_summary …)
scouting_runs (+ kind · career_mission_id)
job_opportunities          ─┬─ job_sources · job_snapshots
                            ├─ job_fit_evaluations (components · weights_used · overall · feedback_adjustment · eligibility)
                            ├─ job_evidence_maps · warm_paths · job_feedback
applications               ─┬─ application_events
                            └─ application_packages ─┬─ resume_patches ── resume_patch_changes
                                                      └─ cover_letters
storage.buckets 'career-docs' (private)
```

**Three decisions worth knowing when reading it.**

- **`approved` on every evidence row.** The tailor loads `approvedOnly`; imported material is
  invisible to it until a human approves. `resume_bullets` and `evidence_experiences` created
  from the master résumé land approved because they *are* the résumé; agent-derived facts do not
  (ADR-031).
- **`applications.locked` and `application_packages.status = 'locked'`.** Set when the state
  reaches `APPLIED`; the submitted document paths are copied onto the application; a later
  "Generate Package" creates a new version and can never overwrite them. `saveDocument` refuses
  to overwrite an existing object as a second line.
- **`job_opportunities.is_canonical` + `duplicate_cluster_id`.** One visible row per real
  posting; the other places it was seen are `job_sources` (ADR-035). Two partial unique
  indexes — `(user_id, ats_type, ats_job_id)` and `(user_id, canonical_url)` — make re-scouting
  an update rather than a duplicate.

RLS follows the V1 pattern on every table; child tables (`job_sources`, `job_snapshots`,
`application_events`, `resume_patch_changes`) are policed through their parent.

---

### Mission neutrality — `017_mission_neutrality.sql` (written, **not applied**)

Reasoning: [ADR-042](ARCHITECTURE.md#adr-042). Two new columns, one data migration, and a
rule about what a migration is allowed to touch.

```
career_missions + mission_migration_notes     jsonb array, DISMISSIBLE
                    [{ kind, migration, created_at, message, …extra }]
                    A migration that CHANGED, or DECLINED to change, a preference writes
                    one here; the Mission page renders each with a Dismiss button, which
                    PATCHes the shorter array. Never a filter, never read by an agent.

                + mission_migrations_applied   jsonb array, DURABLE, not null default '[]'
                    ["017:geography_review", "017:evidence_geography_review", …]
                    The ledger. Written ONLY by migration SQL; `sanitizeMissionPatch` does
                    not know the key exists, so no PATCH can clear it. Every note-writing
                    step guards on THIS, never on the note's own presence — otherwise a
                    dismissed suggestion would come back on the next re-run, and
                    re-running a hand-applied migration is the normal operating condition.

preferences (jsonb) gains:
  locations       { mode: 'anywhere' | 'prefer' | 'only', regions: string[] }
                  Read through missionLocations(); a pre-017 row has no such key and
                  its geo_tiers are read as 'prefer' — which is what tiers already meant.
  direction_mode  'boost' | 'exclusive'   (never stored as 'off' — see ADR-042)
  geo_tiers       kept, and now purely a RANKING table driven by `locations`.
                  Empty in the shipped default. Empty means NO tier is stamped at all.
```

**What it changes, and what it refuses to.** The pre-V2 geography was system-generated, so
the migration neutralises it — but only where the stored value is **byte-identical** to what
shipped: the exact tier arrays, the exact objective string, and in `evidence_preferences` the
exact `(value, weight, "tier N" note)` triples the seed wrote. `isShippedPreV2Geography()` and
the SQL `where` clause are the same predicate in two languages, and
`scripts/test-career-mission.ts` parses the literal out of the `.sql` file so they cannot
drift. Anything a person edited is left untouched and gets a note instead.

**It touches two tables.** `evidence_preferences` held the same geography a second time (six
coastal `location` rows plus `location` in `optimize_for`, seeded from the same defaults), and
`renderPreferences()` prints those rows into the same prompts `renderMission()` feeds. The
prompts no longer depend on this having run — `withoutPlacePreferences()` strips place lines
whatever the table holds — so the deletes are the database catching up with the contract.

---

### Scout durability and company intent — `016_scout_durability_and_company_intent.sql` (shipped)

Reasoning: [ADR-039](ARCHITECTURE.md#adr-039) and [ADR-040](ARCHITECTURE.md#adr-040).

```
companies  + open_roles_count   openings at the last check — STATE, not preference
           + watch_origin       user | planner | scout | outreach | import  (how it arrived)
           + watch_status_at    when the current intent was set
           watch_status is now INTENT ONLY:
             target     the user wants to work here      only a user writes this
             watching   the user asked to keep an eye on  only a user writes this
             suggested  the scout's hypothesis            the ONLY value an agent may write
             ignored    the user said no                  agents may never resurrect it
           ('opening_available' is still accepted so a half-deployed build cannot 500;
            readers map it to 'watching' and nothing writes it after 016.)

scouting_runs + stage · progress (jsonb: stage, detail, counts, last 40 events)
              + heartbeat_at · worker_started_at · claim_token (single use) · params
              status: queued | running | succeeded | partial | failed | cancelled

scouting_run_jobs (run_id, job_id) · user_id · inserted   one row per job a run TOUCHED
```

**Why `scouting_run_jobs` exists.** `job_opportunities.discovery_run_id` names only
the run that first inserted a job, so "what did this run find?" could not include a
posting the run re-saw. The join table answers it directly, and the migration
backfills it from `discovery_run_id`.

**The data migration.** Rows with `watch_status = 'target'` and
`watch_source in ('planner','scout')` become `suggested`; rows with
`watch_source = 'user'` are untouched, because the companies PATCH route stamps that
value and it is therefore the only reliable record of an explicit choice.
`opening_available` rows keep their opening in `open_roles_count` and fall back to
`watching` (user rows) or `suggested`. On the founder's database that reclassified
160 AI-invented "targets" and left zero user targets — which is the honest state.

---

### Evidence canonical layer — `015_evidence_canonical.sql` (shipped, applied 2026-08-28)

Eight tables and tombstone / canonical columns on the 014 evidence tables. Reasoning:
[ADR-038](ARCHITECTURE.md#adr-038).

```
evidence_organizations     canonical_name · normalized_name (unique per user) · aliases[] · kind · company_id
evidence_sources           kind (resume | linkedin_profile | linkedin_post | pasted_context | notes | profile_field | other)
                           · label · sha256 (unique per user) · content (raw text) · resume_document_id · metadata
evidence_fact_sources      fact_id ↔ source_id · location ("¶6", "L350") · quote · confidence (1.0 full, 0.5 event-only)
evidence_experience_sources experience_id ↔ source_id · title_as_written · dates_as_written
evidence_projects          experience_id · name · name_norm · fact_ids[] · approved · status · merged_into
evidence_merge_suggestions entity_type · keep_id · merge_id · confidence (HIGH | POSSIBLE | CONFLICT) · rule · signals
                           · why · data_preserved · risk · status (open | merged | kept_separate | stale)
evidence_conflicts         entity_type · entity_id · field · candidates [{value, source_id, source_label}] · status · resolution
evidence_snapshots         reason · counts · payload (the whole bank, taken before every apply)

evidence_experiences  + organization_id · organization_norm · title_norm · canonical_summary · summary_fact_ids[]
                      · merge_status (VERIFIED | CORROBORATED | CONFLICTING | NEEDS_REVIEW) · status (active | merged)
                      · merged_into · edited_by_user · source_count
evidence_facts        + status · merged_into · project_id · statement_norm · edited_by_user · support_count · fact_status
evidence_metrics      + status · merged_into · value_norm        evidence_deliverables + status · merged_into
```

**Reading rules.** `loadEvidenceBank` filters `status = 'merged'` in code (pre-015 rows have no
status and pass) and reports `canonical: false` when the 015 tables are absent — that is not
`migrationMissing`, which stays about 014. Every default reproduces pre-015 behaviour, so
applying the migration changes nothing until `npm run evidence:consolidate -- --apply` runs.

**Writing rules.** Imports create one `evidence_sources` row per import (hashed, so the same
text twice is one source) and provenance rows for inserted *and* reused facts. Merges are
tombstones + re-points, never deletes. `edited_by_user` rows are never rewritten by an import or
a merge; they win the keep side. The unique indexes on the provenance tables use
`coalesce(location, '')`, which PostgREST cannot target in `onConflict` — writers insert one row
at a time and treat `23505` as "already recorded".

---

## 4. Extended V1 tables

### `contacts` — becomes the person entity

```sql
alter table contacts
  add column if not exists company_id        uuid references companies(id) on delete set null,
  add column if not exists mission_id        uuid references missions(id) on delete set null,
  add column if not exists discovery_source  text,       -- 'apollo' | 'manual' | 'pitchbook'
  add column if not exists seniority         text,
  add column if not exists department        text,
  add column if not exists title_normalized  text,
  add column if not exists email_status      text,       -- 'verified'|'guessed'|'unavailable'
  add column if not exists last_contacted_at timestamptz;

create index if not exists contacts_company_id_idx on contacts (company_id);
create index if not exists contacts_mission_id_idx on contacts (mission_id);
```

The existing `company` **text** column stays and is kept in sync with `companies.name`.
Every V1 screen keeps working untouched ([ADR-001](ARCHITECTURE.md#adr-001)).

`last_contacted_at` enforces the one-person-per-company rule and prevents re-contacting
someone across missions.

The `status` check constraint gains `'discovered'` and `'ranked'` — V1's values are all
retained.

### `campaigns`

```sql
alter table campaigns
  add column if not exists mission_id     uuid references missions(id) on delete set null,
  add column if not exists autonomy_level text default 'approval_required'
    check (autonomy_level in ('approval_required','autonomous'));
```

Per-campaign autonomy is the flag from [PRODUCT.md §6](PRODUCT.md#6-human-approval). It
defaults to `approval_required` and is never set globally.

**Phase 10 — the reference email** (`013_network_and_reference.sql`, shipped):

```sql
alter table campaigns
  add column if not exists reference_subject       text,
  add column if not exists reference_body          text,
  add column if not exists reference_notes         text,
  add column if not exists target_audience         text,
  add column if not exists reference_style         jsonb,
  add column if not exists reference_style_version text,
  add column if not exists reference_hash          text,
  add column if not exists reference_updated_at    timestamptz;
```

One real email the user wrote, defining how this campaign should sound
([ADR-028](ARCHITECTURE.md#adr-028)). `reference_style` caches the Style Analyst's output;
`reference_hash` covers the reference plus the analyst's prompt version, so the analysis is
paid for once per campaign and recomputed exactly when the email changes.

**There is deliberately no `variables` column and there never will be.** This is a style,
structure and intent example, not a template. Placeholders are a blocking gate
([ADR-029](ARCHITECTURE.md#adr-029)), not a feature.

### `emails`

```sql
alter table emails
  add column if not exists rfc822_message_id text,
  add column if not exists draft_id          uuid references outreach_drafts(id),
  add column if not exists mission_id        uuid references missions(id) on delete set null;

-- Phase 9, after backfill: copy resend_message_id → rfc822_message_id, then drop the old column.
```

The rename corrects a name that never described its contents
([ADR-007](ARCHITECTURE.md#adr-007)). Done as add → backfill → switch reads → drop, so no
step breaks the send path.

### `profiles`

Unchanged. The free-text fields (`resume_text`, `linkedin_bio_text`, `personal_context`,
`target_roles`, `supplementary_materials`) are **retained as ingest sources** — Phase 2 parses
them into `talent_items` — and continue to serve V1's screens.

---

## 5. Dropped

| Table / column | Reason |
|---|---|
| `email_events` | Only the dead Resend webhook wrote to it. Open/click tracking is structurally unavailable on the Gmail send path, and [PRODUCT.md §2](PRODUCT.md#2-north-star) rejects open rate as a metric. |
| `template_performance` | Nothing ever wrote to it. Superseded by `outcome_events`. |
| `followups` | Superseded by `emails.reply_to_email_id`, which is what the shipped follow-up flow actually uses. |

Drop after confirming zero rows (migration 016, still pending). The dead route
`/api/webhooks/resend` was deleted on 2026-08-30.

---

## 6. RLS

Every new table follows the V1 pattern — no exceptions, no new patterns:

```sql
alter table <t> enable row level security;
create policy "Users manage own <t>" on <t> for all using (user_id = auth.uid());
```

Tables without a direct `user_id` (`research_facts`, `company_sources`, `contact_sources`,
`pipeline_tasks`) are policed through their parent, exactly as V1 does for `contact_research`:

```sql
create policy "Users manage own research_facts" on research_facts for all
  using (dossier_id in (select id from research_dossiers where user_id = auth.uid()));
```

Carrying `user_id` denormalized onto the main new tables — rather than joining up to `missions`
each time — keeps policies to a single index lookup. V1 established this pattern and it holds.

---

## 7. Migration sequence

Each migration is standalone and additive. None blocks V1 functionality.

**Planned** (from Phase 0; phases 1, 2, 4, 5 have not shipped, so several of these do not exist):

| # | File | Phase | Contents |
|---|---|---|---|
| 008 | `008_missions.sql` | 1 | `missions`, `mission_strategies` |
| 009 | `009_talent_kb.sql` | 2 | `talent_items` |
| 010 | `010_companies.sql` | 3–4 | `companies`, `company_sources`, `contact_sources`, `contacts` extensions |
| 011 | `011_pipeline.sql` | 4 | `pipeline_runs`, `pipeline_tasks`, `agent_runs` |
| 012 | `012_research_scoring.sql` | 5–6 | `research_dossiers`, `research_facts`, `scores` |
| 013 | `013_positioning_outreach.sql` | 7–8 | `positioning_angles`, `outreach_drafts`, `evaluations` |
| 014 | `014_outcomes.sql` | 10 | `outcomes`, `outcome_events`, `emails` extensions |
| 015 | `015_cleanup.sql` | 10 | Drop dead tables; complete the `rfc822_message_id` rename |

**As actually built.** The phases that shipped collapsed several of the above, so the file
numbering diverged from the plan. This is the real sequence on disk:

| # | File | Phase | Applied | Contents |
|---|---|---|---|---|
| 001–007 | V1 migrations | — | ✅ | The V1 schema |
| 010 | `010_companies_scouting.sql` | 3 | ✅ | `companies`, provenance tables, `contacts` extensions |
| 011 | `011_agent_runs.sql` | 7 | ✅ | `scouting_runs`, `agent_runs`, `research_facts` |
| 012 | `012_outreach.sql` | 9 | ✅ | `outreach`, `outreach_events` |
| 013 | `013_network_and_reference.sql` | 10 | ⛔ **needs founder action** | `contact_index`, `search_contact_index()`, `network_matches`, `outreach_edits`, campaign reference columns, `scouting_runs.search_mode` / `internal_decision`, `outreach.campaign_id` / `prospect_source` / `draft_mode` |
| 014 | `014_career_os.sql` | 11 | ⛔ **needs founder action** | Career OS: evidence bank, résumé documents/bullets, job opportunities + sources/snapshots/fit/evidence maps/warm paths/feedback, applications + packages + patches + cover letters, `companies` watchlist columns, `scouting_runs.kind`, storage bucket `career-docs` |

**Migrations are applied by hand in the Supabase SQL editor**, as V1's 001–007 were. There is
no migration runner in this project. Each file must therefore be idempotent
(`if not exists`, `create or replace`) so a re-run is safe — the actual operating condition,
since there is nothing tracking which files have been applied.

---

## 8. Final entity map

```
profiles ─┬─ missions ─┬─ mission_strategies
          │            ├─ pipeline_runs ── pipeline_tasks
          │            │        └─────────── agent_runs
          │            ├─ companies ─┬─ company_sources
          │            │             └─ (research_dossiers, scores)
          │            ├─ contacts ──┬─ contact_sources
          │            │             ├─ (research_dossiers ── research_facts)
          │            │             ├─ (scores)
          │            │             ├─ positioning_angles
          │            │             ├─ outreach_drafts ── (evaluations)
          │            │             ├─ emails ── conversations ── messages
          │            │             └─ outcomes ── outcome_events
          │            └─ campaigns ── campaign_contacts
          ├─ talent_items
          ├─ templates
          └─ email_accounts
```

Parenthesized tables are polymorphic — they attach to companies or contacts via
`(subject_type, subject_id)`.
