-- 016_scout_durability_and_company_intent.sql
--
-- Two changes, one idea: the user's choices are facts, the scout's are guesses.
--
-- 1. COMPANY INTENT vs COMPANY STATE. `watch_status` conflated "how much do I
--    want this" with "does it have an opening right now", and the planner wrote
--    every company it invented as `target` — so an AI guess became indis-
--    tinguishable from "I want to work here", and the next run prioritised it.
--    After this migration `watch_status` is INTENT ONLY:
--
--      target     the user said they want to work here      (user only)
--      watching   the user said keep an eye on this          (user only)
--      suggested  the scout thinks it may be worth a look    (planner/scout)
--      ignored    the user said no
--
--    Whether a company has openings right now lives in `open_roles_count` +
--    `last_careers_check_at`, which is state, not preference.
--
-- 2. DURABLE SCOUT RUNS. A browser scout used to be one long HTTP request.
--    `scouting_runs` gains a queue state, a heartbeat, a current stage and a
--    progress payload so a run survives a refresh, and `scouting_run_jobs`
--    records every job a run touched (not just the ones it inserted) so
--    "show me what this run found" is a query, not a guess.
--
-- Additive and idempotent; re-running is the normal operating condition.
-- Run `npm run check:sql -- 016` before applying.

-- ---------------------------------------------------------------------------
-- 1. Companies: intent, origin, and openings as state
-- ---------------------------------------------------------------------------

alter table companies add column if not exists open_roles_count   int not null default 0;
alter table companies add column if not exists watch_origin       text;   -- how it first entered the list
alter table companies add column if not exists watch_status_at    timestamptz;
-- Attributes the scout learns from (already present on most rows): company_type, industry_tags.

-- `watch_status` gains 'suggested'. 'opening_available' stays ACCEPTED so a
-- half-deployed old build cannot 500 on a write, but nothing writes it after
-- this migration and readers map it to 'watching' (lib/career/companies/intent.ts).
do $$
declare c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    where rel.relname = 'companies'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%watch_status%'
  loop
    execute format('alter table companies drop constraint %I', c.conname);
  end loop;
end $$;

alter table companies
  add constraint companies_watch_status_check
  check (watch_status is null or watch_status in ('target','watching','suggested','ignored','opening_available'));

do $$
begin
  if not exists (
    select 1 from pg_constraint con join pg_class rel on rel.oid = con.conrelid
    where rel.relname = 'companies' and con.conname = 'companies_watch_origin_check'
  ) then
    alter table companies
      add constraint companies_watch_origin_check
      check (watch_origin is null or watch_origin in ('user','planner','scout','outreach','import'));
  end if;
end $$;

-- Origin: how the row got here. `watch_source` is who last SET the status, and
-- the PATCH route stamps it 'user', so it is the only reliable marker of an
-- explicit user choice — which is exactly what the data migration below needs.
update companies
   set watch_origin = case
         when watch_source in ('planner','scout','user') then watch_source
         when watch_status is null then 'outreach'
         else 'user'
       end
 where watch_origin is null;

-- (a) An opening is state. Remember it, then free watch_status to mean intent.
update companies set open_roles_count = greatest(open_roles_count, 1)
 where watch_status = 'opening_available' and open_roles_count = 0;

-- (b) 'opening_available' hid whatever intent the row had. The user's own rows
--     fall back to 'watching' (they added it deliberately); the rest to 'suggested'.
update companies
   set watch_status = case when watch_source = 'user' then 'watching' else 'suggested' end,
       watch_status_at = coalesce(watch_status_at, now())
 where watch_status = 'opening_available';

-- (c) THE FIX: a company the planner or the scout invented was never a user
--     preference. Rows the user touched (watch_source = 'user') are untouched.
update companies
   set watch_status = 'suggested',
       watch_status_at = coalesce(watch_status_at, now())
 where watch_status = 'target'
   and watch_source in ('planner','scout');

update companies set watch_status_at = coalesce(watch_status_at, updated_at, now())
 where watch_status is not null and watch_status_at is null;

create index if not exists companies_watch_check_idx
  on companies (user_id, watch_status, last_careers_check_at nulls first);

-- ---------------------------------------------------------------------------
-- 2. Scouting runs: a queue state, a heartbeat, and progress
-- ---------------------------------------------------------------------------

alter table scouting_runs add column if not exists stage             text;
alter table scouting_runs add column if not exists progress          jsonb not null default '{}'::jsonb;
alter table scouting_runs add column if not exists heartbeat_at      timestamptz;
alter table scouting_runs add column if not exists params            jsonb not null default '{}'::jsonb;
alter table scouting_runs add column if not exists worker_started_at timestamptz;
alter table scouting_runs add column if not exists claim_token       text;

do $$
declare c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    where rel.relname = 'scouting_runs'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%status%'
  loop
    execute format('alter table scouting_runs drop constraint %I', c.conname);
  end loop;
end $$;

alter table scouting_runs
  add constraint scouting_runs_status_check
  check (status in ('queued','running','succeeded','partial','failed','cancelled'));

create index if not exists scouting_runs_active_idx
  on scouting_runs (user_id, status, started_at desc);

-- ---------------------------------------------------------------------------
-- 3. Which jobs a run touched — including ones it re-saw.
--    `job_opportunities.discovery_run_id` only ever named the run that INSERTED
--    a job, so "what did this run find?" could not be answered for a re-seen
--    posting. One row per (run, job).
-- ---------------------------------------------------------------------------

create table if not exists scouting_run_jobs (
  run_id      uuid references scouting_runs(id) on delete cascade not null,
  job_id      uuid references job_opportunities(id) on delete cascade not null,
  user_id     uuid references profiles(id) on delete cascade not null,
  /** true when this run is the one that first stored the job. */
  inserted    boolean not null default false,
  created_at  timestamptz default now(),
  primary key (run_id, job_id)
);

create index if not exists scouting_run_jobs_run_idx  on scouting_run_jobs (run_id);
create index if not exists scouting_run_jobs_user_idx on scouting_run_jobs (user_id, created_at desc);

insert into scouting_run_jobs (run_id, job_id, user_id, inserted, created_at)
select j.discovery_run_id, j.id, j.user_id, true, j.first_seen_at
  from job_opportunities j
  join scouting_runs r on r.id = j.discovery_run_id
 where j.discovery_run_id is not null
on conflict do nothing;

alter table scouting_run_jobs enable row level security;
drop policy if exists "Users manage own scouting_run_jobs" on scouting_run_jobs;
create policy "Users manage own scouting_run_jobs" on scouting_run_jobs for all using (user_id = auth.uid());
