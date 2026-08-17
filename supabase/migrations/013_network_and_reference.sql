-- ═══════════════════════════════════════════════════════════════
-- Phase 10 — Internal network intelligence + campaign reference emails
--
-- Apply by hand in the Supabase SQL Editor (same as 001–012).
-- Idempotent: re-running is the normal operating condition, since nothing
-- tracks what has been applied.
--
-- ADDITIVE AND NON-BREAKING. No existing column changes type, no existing
-- check constraint narrows, and every V1/V2 screen keeps working untouched.
--
-- TWO THINGS THIS ADDS
--
--   1. contact_index — a normalized, searchable, classified representation of
--      every contact already in the database. The 897 people who are currently
--      unusable because nobody tagged them.
--
--   2. campaigns.reference_* — one real email per campaign that defines how
--      that campaign should sound. Style stops being an adjective in a prompt
--      and becomes an example the writer can imitate.
-- ═══════════════════════════════════════════════════════════════

-- ─── CONTACT INDEX ───────────────────────────────────────────────
-- One row per contact. Deliberately a SEPARATE table rather than columns on
-- `contacts`:
--
--   * it is derived data with its own refresh lifecycle and its own version
--     stamp — mixing it into `contacts` makes "is this stale?" unanswerable
--   * it can be dropped and rebuilt without risking the source of truth
--   * `contacts` is read by six V1 screens; widening it by 25 columns to serve
--     retrieval is how a hub table becomes unmaintainable
--
-- `source_hash` is the cost control. Classification is skipped entirely when
-- the underlying material and the classifier version are both unchanged, so
-- re-indexing 897 contacts after adding one costs one model call, not 897.

create table if not exists contact_index (
  contact_id        uuid primary key references contacts(id) on delete cascade,
  user_id           uuid references profiles(id) on delete cascade not null,

  -- ─── the searchable document, in three weighted parts ───
  headline          text,          -- name · title · company. Weight A.
  tags_text         text,          -- flattened classification tags. Weight B.
  body_text         text,          -- research, hooks, facts, company profile. Weight C.

  -- ─── deterministic normalization (no model, no cost) ───
  seniority_band    text,          -- founder|c_suite|vp|head|director|manager|senior|entry|unknown
  function_area     text,          -- engineering|operations|rnd|product|data|commercial|…
  geo_city          text,
  geo_state         text,
  geo_country       text,
  geo_region        text,          -- midwest|northeast|west|south|international|unknown
  company_name      text,
  company_norm      text,

  -- ─── classification (cheap batch model pass, cached by source_hash) ───
  industry          text,
  sub_industry      text,
  function          text,
  company_type      text,          -- startup|growth|corporate|consultancy|investor|academic|nonprofit|…
  company_stage     text,
  technical_domains text[] default '{}',
  business_domains  text[] default '{}',
  opportunity_types text[] default '{}',
  -- Open-ended, on purpose. A rigid taxonomy cannot hold "runs the plant-floor
  -- AI council" or "ex-P&G, same site"; a tag array can, and retrieval reads it
  -- the same way it reads the fixed columns.
  tags              text[] default '{}',
  -- Per-opportunity-kind relevance, 0-1: recruiting, mentorship, startup,
  -- investor, partnership, speaker. NOT a permanent verdict on the person —
  -- these are dispositions, and mission-specific scoring lives in
  -- network_matches where it belongs.
  relevance         jsonb  default '{}',
  classification_note text,

  -- ─── relationship history (deterministic, from emails/conversations) ───
  relationship_status text,        -- never_contacted|contacted_no_reply|replied_positive|
                                   -- replied_negative|in_conversation|met|referred
  relationship_note text,
  touches           int  default 0,
  replies           int  default 0,
  last_contacted_at timestamptz,
  last_reply_at     timestamptz,

  -- ─── provenance and freshness ───
  evidence_level    text,          -- rich|moderate|thin — how much we actually know
  source_hash       text,          -- identity of the material this was built from
  index_version     text,
  classifier_version text,
  classified_at     timestamptz,
  indexed_at        timestamptz default now()
);

-- The retrieval primitive. Weighted so a title match outranks a passing
-- mention buried in a research paragraph — without that, every contact whose
-- dossier says the word "manufacturing" once ranks alongside a plant manager.
--
-- ⚠ CHANGING THIS EXPRESSION LATER TAKES A DELIBERATE DROP.
-- `add column if not exists` matches on the column NAME only, so editing the
-- expression below and re-running this file is a silent no-op. That is the
-- right default — re-adding a stored generated column rewrites the whole table
-- on every run — but it means a future edit needs an explicit
-- `alter table contact_index drop column search_vector;` first, and then a
-- reindex. If search results ever stop reflecting the weights written here,
-- this is why.
alter table contact_index
  add column if not exists search_vector tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(headline, '')),  'A') ||
    setweight(to_tsvector('english', coalesce(tags_text, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(body_text, '')), 'C')
  ) stored;

create index if not exists contact_index_search_idx     on contact_index using gin (search_vector);
create index if not exists contact_index_user_idx       on contact_index (user_id);
create index if not exists contact_index_seniority_idx  on contact_index (user_id, seniority_band);
create index if not exists contact_index_function_idx   on contact_index (user_id, function_area);
create index if not exists contact_index_region_idx     on contact_index (user_id, geo_region);
create index if not exists contact_index_rel_idx        on contact_index (user_id, relationship_status);
create index if not exists contact_index_tags_idx       on contact_index using gin (tags);
create index if not exists contact_index_tech_idx       on contact_index using gin (technical_domains);
create index if not exists contact_index_opp_idx        on contact_index using gin (opportunity_types);

-- ─── THE SEARCH PRIMITIVE ────────────────────────────────────────
-- Ranked full-text search with structured filters, as one function.
--
-- It lives in SQL rather than in TypeScript because ts_rank cannot be expressed
-- through PostREST, and without ranking this is a keyword grep: every contact
-- whose research paragraph contains "manufacturing" would come back in
-- insertion order, and the retrieval agent would be reading noise.
--
-- The query text arrives already sanitized into websearch syntax by
-- lib/network/search.ts. websearch_to_tsquery never raises on arbitrary input,
-- which is what makes it safe to hand a model's output to.
--
-- ─── Why the drop block, and why it enumerates overloads ───
--
-- `create or replace function` CANNOT change a function's return type or its
-- parameter names — it fails with "cannot change return type of existing
-- function". This file is re-run by hand as its normal operating condition, so
-- the day someone adds a column to the RETURNS TABLE, a plain re-run would
-- fail with an error that says nothing about the edit that caused it.
--
-- Dropping by name rather than by a hardcoded signature means an OLD overload
-- with different argument types is also removed, instead of lingering forever
-- and being picked by overload resolution ahead of the new one.

do $$
declare
  fn record;
begin
  for fn in
    select oid::regprocedure as signature
    from pg_proc
    where proname = 'search_contact_index'
      and pronamespace = 'public'::regnamespace
  loop
    execute format('drop function if exists %s', fn.signature);
  end loop;
end $$;

create or replace function search_contact_index(
  p_user_id           uuid,
  p_query             text default null,
  p_seniority         text[] default null,
  p_functions         text[] default null,
  p_regions           text[] default null,
  p_states            text[] default null,
  p_company_types     text[] default null,
  p_opportunity_types text[] default null,
  p_relationship      text[] default null,
  p_exclude           uuid[] default null,
  p_limit             int default 30
)
returns table (
  contact_id          uuid,
  name                text,
  title               text,
  company             text,
  email               text,
  linkedin_url        text,
  location            text,
  seniority_band      text,
  function_area       text,
  geo_city            text,
  geo_state           text,
  geo_region          text,
  industry            text,
  sub_industry        text,
  company_type        text,
  technical_domains   text[],
  business_domains    text[],
  opportunity_types   text[],
  tags                text[],
  relevance           jsonb,
  relationship_status text,
  relationship_note   text,
  evidence_level      text,
  summary             text,
  rank                real,
  total_matches       bigint
)
language sql
stable
-- SECURITY INVOKER (the default), so RLS on contact_index and contacts applies to
-- whoever calls it: an authenticated user passing someone else's p_user_id gets
-- nothing back. The service-role client bypasses RLS, which is exactly why every
-- caller passes p_user_id explicitly and the body filters on it.
-- search_path is pinned because an unpinned one is a Supabase advisor warning and
-- costs nothing to close.
set search_path = public, pg_temp
as $$
  with q as (
    select case
             when p_query is null or btrim(p_query) = '' then null
             -- ⚠ nullif, not the bare call.
             --
             -- websearch_to_tsquery returns an EMPTY tsquery — not NULL — when
             -- every token is a stopword ('the or and', or '--', which survives
             -- the TypeScript sanitizer because it keeps '&' and '-'). An empty
             -- tsquery matches NOTHING rather than everything, so `@@` would
             -- reject every row and the function would report zero matches with
             -- no error: indistinguishable from a genuine miss, and worse when
             -- combined with filters, because it reads as a false negative about
             -- the filtered population rather than about the query.
             --
             -- Collapsing it to NULL here restores this function's own invariant
             -- — no usable text means filters only — for all three consumers
             -- below at once: the rank CASE, the `@@` predicate, and the
             -- relevance-floor bypass.
             else nullif(websearch_to_tsquery('english', p_query), ''::tsquery)
           end as tsq
  ),
  matched as (
    select
      ci.contact_id,
      c.name,
      c.role                as title,
      coalesce(ci.company_name, c.company) as company,
      c.email,
      c.linkedin_url,
      c.location,
      ci.seniority_band,
      ci.function_area,
      ci.geo_city,
      ci.geo_state,
      ci.geo_region,
      ci.industry,
      ci.sub_industry,
      ci.company_type,
      ci.technical_domains,
      ci.business_domains,
      ci.opportunity_types,
      ci.tags,
      ci.relevance,
      ci.relationship_status,
      ci.relationship_note,
      ci.evidence_level,
      coalesce(ci.classification_note, left(ci.body_text, 240)) as summary,
      case when (select tsq from q) is null then 0::real
           else ts_rank(ci.search_vector, (select tsq from q)) end as rank
    from contact_index ci
    join contacts c on c.id = ci.contact_id
    where ci.user_id = p_user_id
      and ((select tsq from q) is null or ci.search_vector @@ (select tsq from q))
      and (p_seniority         is null or ci.seniority_band      = any(p_seniority))
      and (p_functions         is null or ci.function_area       = any(p_functions))
      and (p_regions           is null or ci.geo_region          = any(p_regions))
      and (p_states            is null or lower(ci.geo_state)    = any(select lower(s) from unnest(p_states) s))
      and (p_company_types     is null or ci.company_type        = any(p_company_types))
      and (p_relationship      is null or ci.relationship_status = any(p_relationship))
      and (p_opportunity_types is null or ci.opportunity_types && p_opportunity_types)
      and (p_exclude           is null or ci.contact_id         <> all(p_exclude))
  ),
  -- ─── The relevance floor ───
  --
  -- Terms are OR-ed, so a bare `@@` match is nearly worthless: measured on the
  -- real database, an eight-term query matched 599 of 897 contacts, because
  -- almost every research paragraph contains one of them somewhere. A count
  -- like that tells the retrieval agent nothing — it cannot distinguish "my
  -- query was too broad" from "this network is full of these people", which is
  -- exactly the judgment it needs to make.
  --
  -- The floor is RELATIVE to the best match in the same query rather than
  -- absolute, because ts_rank values are not comparable across queries of
  -- different lengths. What survives is "matches roughly as well as the best
  -- thing here", which is stable whatever was asked.
  floored as (
    select m.*, max(m.rank) over () as top_rank
    from matched m
  )
  select
    f.contact_id, f.name, f.title, f.company, f.email, f.linkedin_url, f.location,
    f.seniority_band, f.function_area, f.geo_city, f.geo_state, f.geo_region,
    f.industry, f.sub_industry, f.company_type,
    f.technical_domains, f.business_domains, f.opportunity_types, f.tags, f.relevance,
    f.relationship_status, f.relationship_note, f.evidence_level, f.summary, f.rank,
    count(*) over () as total_matches
  from floored f
  where (select tsq from q) is null or f.rank >= 0.3 * f.top_rank
  -- Evidence breaks ties, richest first. An alphabetical sort on the label
  -- would put 'moderate' above 'rich', which is the opposite of the intent.
  order by f.rank desc,
           case f.evidence_level when 'rich' then 0 when 'moderate' then 1 else 2 end,
           f.name
  limit greatest(1, least(coalesce(p_limit, 30), 200));
$$;

-- ─── NETWORK MATCHES ─────────────────────────────────────────────
-- Mission-specific scores for internal candidates.
--
-- THE POINT OF THIS TABLE IS THAT IT IS PER-RUN. A person who is weak for
-- "winter industrial AI" may be strong for "summer consulting" or for
-- mentorship. Writing a score back onto the contact would destroy that, and
-- the first mission to run would poison every later one.

create table if not exists network_matches (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references profiles(id) on delete cascade not null,
  run_id        uuid references scouting_runs(id) on delete cascade,
  contact_id    uuid references contacts(id) on delete cascade not null,

  mission_goal  text,
  score         numeric,           -- 0-1, this mission only
  confidence    numeric,           -- how much evidence the score rests on
  reason        text,
  evidence      text[] default '{}',
  matched_by    text[] default '{}',  -- the retrieval queries that surfaced them
  stage         text not null default 'retrieved'
                check (stage in ('retrieved','shortlisted','rejected')),
  rank          int,
  created_at    timestamptz default now()
);

-- ⚠ NOT a partial index, and that is deliberate.
--
-- This was `where run_id is not null`, which reads more precise and is fatal in
-- practice: Postgres will only use a PARTIAL unique index as an ON CONFLICT
-- arbiter if the statement repeats the index predicate, and PostgREST/supabase-js
-- can only send a column list — `.upsert(rows, { onConflict: 'run_id,contact_id' })`
-- has nowhere to put a WHERE. Every internal-first run that reached
-- persistNetworkMatches would have raised
--   42P10: there is no unique or exclusion constraint matching the ON CONFLICT specification.
--
-- The predicate bought nothing anyway. Postgres treats NULLs as distinct in a
-- unique index by default, so rows with a null run_id never collide with each
-- other — which is exactly the behaviour the predicate was written to get.
--
-- Dropped explicitly first: `create ... if not exists` is a no-op against an
-- index of the same name with a DIFFERENT definition, so a database that already
-- has the partial version would silently keep it.
drop index if exists network_matches_run_contact_uniq;
create unique index if not exists network_matches_run_contact_uniq
  on network_matches (run_id, contact_id);
create index if not exists network_matches_user_idx    on network_matches (user_id, created_at desc);
create index if not exists network_matches_contact_idx on network_matches (contact_id);

-- ─── SCOUTING RUNS: the internal-first decision, made observable ─
-- The requirement is that "we did not call Apollo, and here is why" is
-- inspectable after the fact. A jsonb blob inside `stats` would satisfy the
-- letter of that and be unqueryable in practice.
alter table scouting_runs
  add column if not exists search_mode       text,
  add column if not exists internal_decision jsonb;

-- ─── CAMPAIGNS: the reference email ──────────────────────────────
-- One real email that shows how this campaign should sound. It is a STYLE,
-- STRUCTURE and INTENT example — never a fill-in-the-blank template, which is
-- why there is no `variables` column here and never will be.
alter table campaigns
  add column if not exists reference_subject      text,
  add column if not exists reference_body         text,
  add column if not exists reference_notes        text,
  add column if not exists target_audience        text,
  -- What the Style Analyst extracted. Cached per campaign so the analysis is
  -- paid for once, not once per prospect.
  add column if not exists reference_style        jsonb,
  add column if not exists reference_style_version text,
  add column if not exists reference_hash         text,
  add column if not exists reference_updated_at   timestamptz;

-- ─── OUTREACH: which campaign wrote it, and where the person came from ──
alter table outreach
  add column if not exists campaign_id     uuid references campaigns(id) on delete set null,
  -- 'existing'              already in the database before this run
  -- 'new'                   discovered externally this run
  -- 'existing_rediscovered' external discovery found someone we already had
  add column if not exists prospect_source text,
  add column if not exists draft_mode      text,   -- 'brief' | 'reference'
  add column if not exists style_check     jsonb;  -- placeholder + style findings

create index if not exists outreach_campaign_idx on outreach (campaign_id);

-- ─── OUTREACH EDITS ──────────────────────────────────────────────
-- Append-only record of (what the agent wrote) vs (what the user sent).
--
-- `outreach.body` / `body_edited` already hold the latest pair, but a redraft
-- overwrites them. This keeps the history, because the interesting question is
-- "what does the user CONSISTENTLY change?" and one sample cannot answer it.
--
-- Nothing reads this to change behavior yet, deliberately. Rewriting global
-- style rules from a single edit is exactly the overfitting the reference-email
-- design exists to avoid.
create table if not exists outreach_edits (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references profiles(id) on delete cascade not null,
  outreach_id       uuid references outreach(id) on delete cascade not null,
  campaign_id       uuid references campaigns(id) on delete set null,
  generated_subject text,
  generated_body    text,
  final_subject     text,
  final_body        text,
  draft_version     text,
  style_version     text,
  created_at        timestamptz default now()
);

create index if not exists outreach_edits_outreach_idx on outreach_edits (outreach_id, created_at desc);
create index if not exists outreach_edits_user_idx     on outreach_edits (user_id, created_at desc);

-- ─── ROW LEVEL SECURITY ──────────────────────────────────────────
-- Same pattern as every other table here. Child tables policed through parent.

alter table contact_index   enable row level security;
alter table network_matches enable row level security;
alter table outreach_edits  enable row level security;

drop policy if exists "Users manage own contact_index" on contact_index;
create policy "Users manage own contact_index" on contact_index for all
  using (user_id = auth.uid());

drop policy if exists "Users manage own network_matches" on network_matches;
create policy "Users manage own network_matches" on network_matches for all
  using (user_id = auth.uid());

drop policy if exists "Users manage own outreach_edits" on outreach_edits;
create policy "Users manage own outreach_edits" on outreach_edits for all
  using (user_id = auth.uid());
