-- ═══════════════════════════════════════════════════════════════
-- Phase 7 — Agent observability, scouting run state, and grounded facts
-- See docs/ARCHITECTURE.md ADR-006 (grounding) and ADR-016 (Anthropic agents).
--
-- Apply by hand in the Supabase SQL Editor (same as 001–010).
-- Idempotent: safe to re-run.
--
-- ADDITIVE AND NON-BREAKING. Nothing here is referenced by a V1 screen.
-- ═══════════════════════════════════════════════════════════════

-- ─── SCOUTING RUNS ───────────────────────────────────────────────
-- One row per end-to-end discovery run. This is the unit a founder points at
-- when asking "why did this run produce these people?".

create table if not exists scouting_runs (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references profiles(id) on delete cascade not null,
  label           text,
  mission         jsonb not null,             -- the mission as given
  strategy        jsonb,                      -- Mission Strategist output
  status          text default 'running'
                  check (status in ('running','succeeded','failed','cancelled')),
  budget          jsonb default '{}',         -- caps this run was allowed
  stats           jsonb default '{}',         -- funnel counts + usage/cost rollup
  error           text,
  started_at      timestamptz default now(),
  completed_at    timestamptz
);

create index if not exists scouting_runs_user_id_idx on scouting_runs (user_id);
create index if not exists scouting_runs_status_idx on scouting_runs (status);

-- ─── AGENT RUNS ──────────────────────────────────────────────────
-- Every agent invocation, traced. `prompt_version` is what makes
-- "why did it say this?" answerable months later (ADR-009).
--
-- input_refs holds ROW IDS, not payloads — the trace must stay small enough to
-- always write, and payloads live in the rows they reference.

create table if not exists agent_runs (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references profiles(id) on delete cascade not null,
  run_id          uuid references scouting_runs(id) on delete cascade,
  agent_id        text not null,
  prompt_version  text not null,
  model           text not null,
  model_role      text check (model_role in ('fast','reasoning','writing')),
  provider_id     text,                       -- 'anthropic' | 'openai'
  status          text not null
                  check (status in ('succeeded','failed','invalid_output')),
  input_refs      jsonb default '{}',
  output          jsonb,
  tools_called    jsonb default '[]',
  tokens_in       int,
  tokens_out      int,
  cost_usd        numeric(12,6),
  latency_ms      int,
  error           text,
  created_at      timestamptz default now()
);

create index if not exists agent_runs_user_id_idx  on agent_runs (user_id);
create index if not exists agent_runs_run_id_idx   on agent_runs (run_id);
create index if not exists agent_runs_agent_id_idx on agent_runs (agent_id);
create index if not exists agent_runs_created_idx  on agent_runs (created_at desc);

-- ─── RESEARCH FACTS ──────────────────────────────────────────────
-- ADR-006 made structural: a FACT without a source URL cannot be stored.
-- Grounding is a database constraint, not a prompt instruction.

create table if not exists research_facts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references profiles(id) on delete cascade not null,
  run_id        uuid references scouting_runs(id) on delete cascade,
  company_id    uuid references companies(id) on delete cascade,
  contact_id    uuid references contacts(id) on delete cascade,
  subject_label text,                          -- human-readable, for orphan facts
  claim         text not null,
  type          text not null check (type in ('FACT','INFERENCE','UNKNOWN')),
  source_url    text,
  source_title  text,
  confidence    numeric(3,2),
  relevance     text,
  agent_run_id  uuid references agent_runs(id) on delete set null,
  created_at    timestamptz default now(),

  -- The whole point. An uncitable FACT is a fabrication by construction.
  constraint fact_requires_source
    check (type <> 'FACT' or (source_url is not null and source_url <> ''))
);

create index if not exists research_facts_run_id_idx     on research_facts (run_id);
create index if not exists research_facts_company_id_idx on research_facts (company_id);
create index if not exists research_facts_contact_id_idx on research_facts (contact_id);
create index if not exists research_facts_type_idx       on research_facts (type);

-- ─── ROW LEVEL SECURITY ──────────────────────────────────────────
-- Same pattern as V1 and migration 010.

alter table scouting_runs  enable row level security;
alter table agent_runs     enable row level security;
alter table research_facts enable row level security;

drop policy if exists "Users manage own scouting_runs" on scouting_runs;
create policy "Users manage own scouting_runs" on scouting_runs for all
  using (user_id = auth.uid());

drop policy if exists "Users manage own agent_runs" on agent_runs;
create policy "Users manage own agent_runs" on agent_runs for all
  using (user_id = auth.uid());

drop policy if exists "Users manage own research_facts" on research_facts;
create policy "Users manage own research_facts" on research_facts for all
  using (user_id = auth.uid());
