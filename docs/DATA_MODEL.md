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

Drop in Phase 10, after confirming zero rows. Route deletion (`/api/webhooks/resend`) happens
alongside.

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
