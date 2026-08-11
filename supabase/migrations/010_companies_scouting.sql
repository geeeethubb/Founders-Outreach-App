-- ═══════════════════════════════════════════════════════════════
-- Phase 3 — Companies as a first-class entity + scouting provenance
-- See docs/DATA_MODEL.md and docs/ARCHITECTURE.md ADR-001.
--
-- Apply by hand in the Supabase SQL Editor (same as 001–007).
-- Idempotent: safe to re-run.
--
-- ADDITIVE AND NON-BREAKING. contacts.company (text) is retained and kept in
-- sync, so every existing V1 screen keeps working untouched.
-- ═══════════════════════════════════════════════════════════════

-- ─── COMPANIES ───────────────────────────────────────────────────
create table if not exists companies (
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
  stage             text,
  founded_year      int,
  hq_location       text,
  country           text,
  website_url       text,
  linkedin_url      text,
  provider_data     jsonb default '{}',         -- raw payloads keyed by provider id
  status            text default 'discovered'
                    check (status in ('discovered','filtered_out','ranked','targeted','engaged','archived')),
  filtered_reason   text,                       -- which rule eliminated it, for "why isn't X here?"
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

-- Dedupe: domain when known, normalized name otherwise. Mirrors the pattern
-- proven by contacts_user_linkedin_unique in migration 003.
create unique index if not exists companies_user_domain_uniq
  on companies (user_id, domain) where domain is not null;
create unique index if not exists companies_user_normname_uniq
  on companies (user_id, normalized_name) where domain is null;

create index if not exists companies_user_id_idx on companies (user_id);
create index if not exists companies_status_idx on companies (status);

drop trigger if exists companies_updated_at on companies;
create trigger companies_updated_at
  before update on companies
  for each row execute procedure update_updated_at();

-- ─── PROVENANCE ──────────────────────────────────────────────────
-- Two providers returning the same company yields ONE companies row and two
-- source rows. Provenance without duplication.

create table if not exists company_sources (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid references companies(id) on delete cascade not null,
  provider_id   text not null,                  -- 'apollo' | 'pitchbook' | 'web'
  external_id   text,
  query_ref     jsonb,
  raw           jsonb,
  discovered_at timestamptz default now(),
  unique (company_id, provider_id, external_id)
);

create table if not exists contact_sources (
  id            uuid primary key default gen_random_uuid(),
  contact_id    uuid references contacts(id) on delete cascade not null,
  provider_id   text not null,
  external_id   text,
  query_ref     jsonb,
  raw           jsonb,
  discovered_at timestamptz default now(),
  unique (contact_id, provider_id, external_id)
);

create index if not exists company_sources_company_id_idx on company_sources (company_id);
create index if not exists contact_sources_contact_id_idx on contact_sources (contact_id);

-- ─── CONTACTS: become the person entity ──────────────────────────
-- docs/ARCHITECTURE.md ADR-012 — extend rather than create a `people` table.

alter table contacts
  add column if not exists company_id        uuid references companies(id) on delete set null,
  add column if not exists discovery_source  text,       -- 'apollo' | 'manual' | 'pitchbook'
  add column if not exists seniority         text,
  add column if not exists department        text,
  add column if not exists title_normalized  text,
  add column if not exists email_status      text        -- 'verified'|'guessed'|'unavailable'
    check (email_status is null or email_status in ('verified','guessed','unavailable')),
  add column if not exists apollo_id         text,
  add column if not exists last_contacted_at timestamptz;

create index if not exists contacts_company_id_idx on contacts (company_id);

-- Apollo's person id is authoritative — the primary person dedupe key.
create unique index if not exists contacts_user_apollo_uniq
  on contacts (user_id, apollo_id) where apollo_id is not null;

-- V1's status check constraint predates discovery. Widen it so scouted people
-- can exist before they are researched, without breaking existing rows.
do $$
begin
  alter table contacts drop constraint if exists contacts_status_check;
  alter table contacts add constraint contacts_status_check
    check (status in ('discovered','ranked','new','researching','researched',
                      'drafted','sent','replied','meeting','archived'));
exception when others then
  raise notice 'contacts status constraint unchanged: %', sqlerrm;
end $$;

-- ─── ROW LEVEL SECURITY ──────────────────────────────────────────
-- Same pattern as V1. Child tables policed through their parent.

alter table companies       enable row level security;
alter table company_sources enable row level security;
alter table contact_sources enable row level security;

drop policy if exists "Users manage own companies" on companies;
create policy "Users manage own companies" on companies for all
  using (user_id = auth.uid());

drop policy if exists "Users manage own company_sources" on company_sources;
create policy "Users manage own company_sources" on company_sources for all
  using (company_id in (select id from companies where user_id = auth.uid()));

drop policy if exists "Users manage own contact_sources" on contact_sources;
create policy "Users manage own contact_sources" on contact_sources for all
  using (contact_id in (select id from contacts where user_id = auth.uid()));
