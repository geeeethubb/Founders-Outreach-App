-- 015_evidence_canonical.sql
--
-- Knowledge-base consolidation: canonical organizations, source records,
-- many-to-many provenance, projects, merge suggestions, conflicts, snapshots,
-- and tombstone columns so a merge never deletes a row.
--
-- Additive and idempotent. Re-running this file is the normal operating
-- condition (docs/DATA_MODEL.md, CLAUDE.md "Migrations"). Nothing here
-- changes what V1 or the Phase 11 screens read: every new column has a
-- default that reproduces today's behaviour (status = 'active',
-- merge_status = 'VERIFIED', support_count = 1).
--
-- Run `npm run check:sql -- 015` before applying.

-- updated_at trigger function: update_updated_at() from 001, as in 014.

-- ---------------------------------------------------------------------------
-- 1. Canonical organizations. One row per organization the user has worked
--    with; `aliases` holds every surface form seen in a source so "P&G",
--    "Procter & Gamble" and "Procter & Gamble, Tabler Station" resolve here.
-- ---------------------------------------------------------------------------
create table if not exists evidence_organizations (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid references profiles(id) on delete cascade not null,
  canonical_name   text not null,
  normalized_name  text not null,               -- lib/career/evidence/normalize.ts normalizeOrg()
  aliases          text[] not null default '{}',
  kind             text not null default 'other'
                   check (kind in ('company','university','lab','student_org','program','other')),
  company_id       uuid references companies(id) on delete set null,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

create unique index if not exists evidence_organizations_user_norm_uniq
  on evidence_organizations (user_id, normalized_name);

drop trigger if exists evidence_organizations_updated_at on evidence_organizations;
create trigger evidence_organizations_updated_at
  before update on evidence_organizations
  for each row execute procedure update_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Sources. A source is a thing the user gave us (a résumé file, a pasted
--    LinkedIn export, one post, a profile field). It is NOT knowledge; facts
--    point at it through evidence_fact_sources. `content` keeps the raw text
--    so provenance can be re-read later; `sha256` makes re-imports a no-op.
-- ---------------------------------------------------------------------------
create table if not exists evidence_sources (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid references profiles(id) on delete cascade not null,
  kind                text not null default 'other'
                      check (kind in ('resume','linkedin_profile','linkedin_post','pasted_context',
                                      'notes','profile_field','other')),
  label               text not null,            -- "Zuyu_Resume.docx", "LinkedIn export 2026-08-28"
  sha256              text,
  content             text,                     -- raw text as imported (null when not retained)
  storage_path        text,                     -- for binary sources kept in the career-docs bucket
  resume_document_id  uuid references resume_documents(id) on delete set null,
  metadata            jsonb not null default '{}'::jsonb,
  imported_at         timestamptz default now()
);

create index if not exists evidence_sources_user_idx on evidence_sources (user_id, imported_at desc);
create unique index if not exists evidence_sources_user_sha_uniq
  on evidence_sources (user_id, sha256) where sha256 is not null;

-- ---------------------------------------------------------------------------
-- 3. Provenance: one fact ↔ many sources, one experience ↔ many sources.
--    `quote` is the wording that source used, so a merged fact keeps every
--    original phrasing even after the statement is normalized to the safest
--    mutually-supported wording.
-- ---------------------------------------------------------------------------
create table if not exists evidence_fact_sources (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references profiles(id) on delete cascade not null,
  fact_id     uuid references evidence_facts(id) on delete cascade not null,
  source_id   uuid references evidence_sources(id) on delete cascade not null,
  location    text,                             -- "¶6", "L350"
  quote       text,
  confidence  numeric(3,2) default 1.0,
  created_at  timestamptz default now()
);

create index if not exists evidence_fact_sources_fact_idx on evidence_fact_sources (fact_id);
create index if not exists evidence_fact_sources_user_idx on evidence_fact_sources (user_id);
create unique index if not exists evidence_fact_sources_uniq
  on evidence_fact_sources (fact_id, source_id, coalesce(location, ''));

create table if not exists evidence_experience_sources (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references profiles(id) on delete cascade not null,
  experience_id  uuid references evidence_experiences(id) on delete cascade not null,
  source_id      uuid references evidence_sources(id) on delete cascade not null,
  location       text,
  title_as_written text,                        -- the role title this source used
  dates_as_written text,                        -- "May 2026 – Present"
  created_at     timestamptz default now()
);

create index if not exists evidence_experience_sources_exp_idx on evidence_experience_sources (experience_id);
create index if not exists evidence_experience_sources_user_idx on evidence_experience_sources (user_id);
create unique index if not exists evidence_experience_sources_uniq
  on evidence_experience_sources (experience_id, source_id, coalesce(location, ''));

-- ---------------------------------------------------------------------------
-- 4. Projects: named work under an experience (Forge 2026, Keywords, CoLini).
--    Populated by the importer only when the source text names the project;
--    never by guessing.
-- ---------------------------------------------------------------------------
create table if not exists evidence_projects (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid references profiles(id) on delete cascade not null,
  experience_id    uuid references evidence_experiences(id) on delete set null,
  organization_id  uuid references evidence_organizations(id) on delete set null,
  name             text not null,
  name_norm        text not null,
  description      text,
  fact_ids         uuid[] not null default '{}',
  approved         boolean not null default false,
  status           text not null default 'active' check (status in ('active','merged')),
  merged_into      uuid,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

create index if not exists evidence_projects_user_idx on evidence_projects (user_id);
create index if not exists evidence_projects_experience_idx on evidence_projects (experience_id);

drop trigger if exists evidence_projects_updated_at on evidence_projects;
create trigger evidence_projects_updated_at
  before update on evidence_projects
  for each row execute procedure update_updated_at();

-- ---------------------------------------------------------------------------
-- 5. Merge suggestions. The consolidation engine writes one row per pair it
--    is not allowed to merge on its own (POSSIBLE, CONFLICT) and one per pair
--    it did merge (HIGH, status = 'merged') so the review tab and the audit
--    log are the same table.
-- ---------------------------------------------------------------------------
create table if not exists evidence_merge_suggestions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references profiles(id) on delete cascade not null,
  entity_type     text not null check (entity_type in ('experience','fact','metric','project')),
  keep_id         uuid not null,
  merge_id        uuid not null,
  confidence      text not null check (confidence in ('HIGH','POSSIBLE','CONFLICT')),
  rule            text,                          -- which matcher rule fired
  signals         jsonb not null default '{}'::jsonb,
  why             text,
  data_preserved  text,
  risk            text,
  status          text not null default 'open'
                  check (status in ('open','merged','kept_separate','stale')),
  created_at      timestamptz default now(),
  resolved_at     timestamptz
);

create unique index if not exists evidence_merge_suggestions_pair_uniq
  on evidence_merge_suggestions (user_id, entity_type, keep_id, merge_id);
create index if not exists evidence_merge_suggestions_open_idx
  on evidence_merge_suggestions (user_id, status);

-- ---------------------------------------------------------------------------
-- 6. Conflicts: the same field with different values in different sources
--    (title, dates). Both values are kept; the canonical row shows the
--    résumé's value until the user resolves it.
-- ---------------------------------------------------------------------------
create table if not exists evidence_conflicts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references profiles(id) on delete cascade not null,
  entity_type  text not null check (entity_type in ('experience','fact','metric')),
  entity_id    uuid not null,
  field        text not null,                    -- "title", "start_date", "end_date", "value"
  candidates   jsonb not null default '[]'::jsonb,  -- [{value, source_id, source_label}]
  status       text not null default 'open' check (status in ('open','resolved')),
  resolution   text,                             -- the value the user chose, or "keep_both"
  created_at   timestamptz default now(),
  resolved_at  timestamptz
);

create unique index if not exists evidence_conflicts_field_uniq
  on evidence_conflicts (user_id, entity_type, entity_id, field);

-- ---------------------------------------------------------------------------
-- 7. Snapshots: a full JSON copy of the bank, written before any run that
--    mutates rows. Restoring is `payload` → rows; nothing is ever deleted.
-- ---------------------------------------------------------------------------
create table if not exists evidence_snapshots (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references profiles(id) on delete cascade not null,
  reason      text not null,
  counts      jsonb not null default '{}'::jsonb,
  payload     jsonb not null,
  created_at  timestamptz default now()
);

create index if not exists evidence_snapshots_user_idx on evidence_snapshots (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 8. Canonical columns on existing tables. Tombstones, not deletes: a merged
--    row keeps status = 'merged' and merged_into = the survivor. Readers
--    filter status = 'active'.
-- ---------------------------------------------------------------------------
alter table evidence_experiences add column if not exists organization_id   uuid references evidence_organizations(id) on delete set null;
alter table evidence_experiences add column if not exists organization_norm text;
alter table evidence_experiences add column if not exists title_norm        text;
alter table evidence_experiences add column if not exists canonical_summary text;
alter table evidence_experiences add column if not exists summary_fact_ids  uuid[] not null default '{}';
alter table evidence_experiences add column if not exists merge_status      text not null default 'VERIFIED'
  check (merge_status in ('VERIFIED','CORROBORATED','CONFLICTING','NEEDS_REVIEW'));
alter table evidence_experiences add column if not exists status            text not null default 'active'
  check (status in ('active','merged'));
alter table evidence_experiences add column if not exists merged_into       uuid;
alter table evidence_experiences add column if not exists edited_by_user    boolean not null default false;
alter table evidence_experiences add column if not exists source_count      int not null default 1;

create index if not exists evidence_experiences_status_idx on evidence_experiences (user_id, status);
create index if not exists evidence_experiences_org_norm_idx on evidence_experiences (user_id, organization_norm);

alter table evidence_facts add column if not exists status          text not null default 'active'
  check (status in ('active','merged'));
alter table evidence_facts add column if not exists merged_into     uuid;
alter table evidence_facts add column if not exists project_id      uuid references evidence_projects(id) on delete set null;
alter table evidence_facts add column if not exists statement_norm  text;
alter table evidence_facts add column if not exists edited_by_user  boolean not null default false;
alter table evidence_facts add column if not exists support_count   int not null default 1;
alter table evidence_facts add column if not exists fact_status     text not null default 'VERIFIED'
  check (fact_status in ('VERIFIED','CORROBORATED','CONFLICTING','NEEDS_REVIEW'));

create index if not exists evidence_facts_status_idx on evidence_facts (user_id, status);

alter table evidence_metrics add column if not exists status       text not null default 'active'
  check (status in ('active','merged'));
alter table evidence_metrics add column if not exists merged_into  uuid;
alter table evidence_metrics add column if not exists value_norm   text;

alter table evidence_deliverables add column if not exists status      text not null default 'active'
  check (status in ('active','merged'));
alter table evidence_deliverables add column if not exists merged_into uuid;

-- ---------------------------------------------------------------------------
-- 9. RLS — the existing pattern, exactly.
-- ---------------------------------------------------------------------------
alter table evidence_organizations       enable row level security;
alter table evidence_sources             enable row level security;
alter table evidence_fact_sources        enable row level security;
alter table evidence_experience_sources  enable row level security;
alter table evidence_projects            enable row level security;
alter table evidence_merge_suggestions   enable row level security;
alter table evidence_conflicts           enable row level security;
alter table evidence_snapshots           enable row level security;

drop policy if exists "Users manage own evidence_organizations" on evidence_organizations;
create policy "Users manage own evidence_organizations" on evidence_organizations for all using (user_id = auth.uid());

drop policy if exists "Users manage own evidence_sources" on evidence_sources;
create policy "Users manage own evidence_sources" on evidence_sources for all using (user_id = auth.uid());

drop policy if exists "Users manage own evidence_fact_sources" on evidence_fact_sources;
create policy "Users manage own evidence_fact_sources" on evidence_fact_sources for all using (user_id = auth.uid());

drop policy if exists "Users manage own evidence_experience_sources" on evidence_experience_sources;
create policy "Users manage own evidence_experience_sources" on evidence_experience_sources for all using (user_id = auth.uid());

drop policy if exists "Users manage own evidence_projects" on evidence_projects;
create policy "Users manage own evidence_projects" on evidence_projects for all using (user_id = auth.uid());

drop policy if exists "Users manage own evidence_merge_suggestions" on evidence_merge_suggestions;
create policy "Users manage own evidence_merge_suggestions" on evidence_merge_suggestions for all using (user_id = auth.uid());

drop policy if exists "Users manage own evidence_conflicts" on evidence_conflicts;
create policy "Users manage own evidence_conflicts" on evidence_conflicts for all using (user_id = auth.uid());

drop policy if exists "Users manage own evidence_snapshots" on evidence_snapshots;
create policy "Users manage own evidence_snapshots" on evidence_snapshots for all using (user_id = auth.uid());
