-- ═══════════════════════════════════════════════════════════════
-- Career OS — Personal Evidence Bank, job opportunities, applications, packages
-- See docs/CAREER_OS.md.
--
-- Apply by hand in the Supabase SQL Editor (same as 001–013).
-- Idempotent: re-running is the normal operating condition.
-- Run `npm run check:sql` before handing this to the founder.
--
-- ADDITIVE AND NON-BREAKING. No existing column changes type, no existing check
-- constraint narrows. Every V1/V2 screen keeps working untouched.
-- ═══════════════════════════════════════════════════════════════

-- ─── CAREER MISSIONS ─────────────────────────────────────────────
-- The unit of intent for a job search. Preferences are jsonb because the set
-- of preference dimensions must accept values nobody has thought of yet;
-- structure is enforced by validators at the application boundary.

create table if not exists career_missions (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references profiles(id) on delete cascade not null,
  name              text not null,
  objective         text not null,
  season            text not null default 'summer_2027',
  -- {geo_tiers:[{tier,locations[]}], company_types[], role_families[], industries[],
  --  optimize_for[], work_modes[], notes}
  preferences       jsonb not null default '{}',
  -- [{dimension, operator, value, label}] — eliminate, never penalize
  hard_constraints  jsonb not null default '[]',
  -- partial override of lib/career/fit/dimensions.ts DEFAULT_FIT_WEIGHTS
  fit_weights       jsonb,
  status            text not null default 'active'
                    check (status in ('draft','active','paused','archived')),
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

create index if not exists career_missions_user_idx on career_missions (user_id, status);

drop trigger if exists career_missions_updated_at on career_missions;
create trigger career_missions_updated_at
  before update on career_missions
  for each row execute procedure update_updated_at();

-- ─── PERSONAL EVIDENCE BANK ──────────────────────────────────────
-- Canonical structured truth about the user. PROVENANCE IS MANDATORY: every
-- fact carries where it came from. APPROVAL IS A COLUMN: nothing a model
-- imported is usable by the résumé tailor until a human approves it.

create table if not exists evidence_experiences (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references profiles(id) on delete cascade not null,
  kind          text not null default 'experience'
                check (kind in ('experience','project','leadership','research','education','award','other')),
  organization  text not null,
  title         text not null,
  start_date    text,                       -- as written on the résumé, e.g. "5/2026"
  end_date      text,                       -- "Present" allowed
  location      text,
  description   text,
  display_order int  default 0,
  source        text not null default 'master_resume',
  approved      boolean not null default false,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

create index if not exists evidence_experiences_user_idx on evidence_experiences (user_id, display_order);

drop trigger if exists evidence_experiences_updated_at on evidence_experiences;
create trigger evidence_experiences_updated_at
  before update on evidence_experiences
  for each row execute procedure update_updated_at();

create table if not exists evidence_facts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references profiles(id) on delete cascade not null,
  experience_id   uuid references evidence_experiences(id) on delete cascade,
  statement       text not null,
  category        text not null default 'achievement'
                  check (category in ('responsibility','achievement','metric','skill','tool',
                                      'context','award','education','scope','other')),
  source          text not null default 'master_resume'
                  check (source in ('master_resume','alternate_resume','linkedin','profile',
                                    'outreach','project_notes','story','manual')),
  source_location text,                     -- e.g. "Zuyu_Resume.docx ¶6", "profile.personal_context"
  confidence      numeric(3,2) default 1.0,
  approved        boolean not null default false,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create index if not exists evidence_facts_user_idx       on evidence_facts (user_id);
create index if not exists evidence_facts_experience_idx on evidence_facts (experience_id);
create index if not exists evidence_facts_approved_idx   on evidence_facts (user_id, approved);

drop trigger if exists evidence_facts_updated_at on evidence_facts;
create trigger evidence_facts_updated_at
  before update on evidence_facts
  for each row execute procedure update_updated_at();

create table if not exists evidence_metrics (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references profiles(id) on delete cascade not null,
  experience_id uuid references evidence_experiences(id) on delete cascade,
  value         text not null,               -- "$4M+", "30%", "1,600+"
  unit          text,                        -- "USD projected savings", "percent", "hours"
  context       text,
  fact_ids      uuid[] default '{}',
  source        text not null default 'master_resume',
  approved      boolean not null default false,
  created_at    timestamptz default now()
);

create index if not exists evidence_metrics_user_idx on evidence_metrics (user_id);

create table if not exists evidence_deliverables (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references profiles(id) on delete cascade not null,
  experience_id uuid references evidence_experiences(id) on delete cascade,
  description   text not null,
  fact_ids      uuid[] default '{}',
  approved      boolean not null default false,
  created_at    timestamptz default now()
);

create index if not exists evidence_deliverables_user_idx on evidence_deliverables (user_id);

create table if not exists evidence_skills (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references profiles(id) on delete cascade not null,
  name              text not null,
  category          text default 'technical'
                    check (category in ('technical','tool','domain','business','language','other')),
  evidence_fact_ids uuid[] default '{}',
  approved          boolean not null default false,
  created_at        timestamptz default now()
);

create index if not exists evidence_skills_user_idx on evidence_skills (user_id);
create unique index if not exists evidence_skills_user_name_uniq on evidence_skills (user_id, lower(name));

create table if not exists evidence_stories (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references profiles(id) on delete cascade not null,
  experience_id     uuid references evidence_experiences(id) on delete set null,
  title             text not null,
  situation         text,
  task              text,
  actions           text,
  result            text,
  learning          text,
  evidence_fact_ids uuid[] default '{}',
  approved          boolean not null default false,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

create index if not exists evidence_stories_user_idx on evidence_stories (user_id);

drop trigger if exists evidence_stories_updated_at on evidence_stories;
create trigger evidence_stories_updated_at
  before update on evidence_stories
  for each row execute procedure update_updated_at();

create table if not exists evidence_preferences (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references profiles(id) on delete cascade not null,
  category        text not null,            -- location, industry, company_type, role, work_mode, values…
  value           text not null,
  weight          numeric(4,3) default 0.5,  -- 0-1
  hard_constraint boolean not null default false,
  note            text,
  created_at      timestamptz default now()
);

create index if not exists evidence_preferences_user_idx on evidence_preferences (user_id, category);

-- ─── RÉSUMÉ DOCUMENTS AND BULLETS ────────────────────────────────
-- The master DOCX is the canonical formatting template. It is stored as a
-- file (Supabase Storage, bucket career-docs) and described here. A bullet row
-- is the unit the tailor edits; it points at its paragraph in the document and
-- at the facts that support it.

create table if not exists resume_documents (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references profiles(id) on delete cascade not null,
  label          text not null default 'master',
  is_master      boolean not null default false,
  filename       text not null,
  storage_path   text,                      -- career-docs/<user>/resumes/<id>.docx
  sha256         text not null,
  byte_size      int,
  -- [{index, kind:'name'|'contact'|'headline'|'section'|'exp_title'|'exp_org'|'bullet'|'text',
  --   text, experience_key, bullet_id}]
  paragraph_map  jsonb not null default '[]',
  page_count     int,
  uploaded_at    timestamptz default now()
);

create index if not exists resume_documents_user_idx on resume_documents (user_id, is_master);

create table if not exists resume_bullets (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid references profiles(id) on delete cascade not null,
  resume_document_id uuid references resume_documents(id) on delete cascade,
  experience_id      uuid references evidence_experiences(id) on delete set null,
  paragraph_index    int,                    -- position in the source DOCX body
  display_order      int default 0,
  text               text not null,          -- plain text; **bold** marks emphasis spans
  evidence_fact_ids  uuid[] default '{}',
  source_resume      text default 'master',
  -- alternate approved phrasings the tailor may swap to (Level 3). A bullet
  -- not on the master résumé is a candidate, not a live line.
  is_on_master       boolean not null default true,
  approved           boolean not null default false,
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);

create index if not exists resume_bullets_user_idx       on resume_bullets (user_id);
create index if not exists resume_bullets_document_idx   on resume_bullets (resume_document_id, paragraph_index);
create index if not exists resume_bullets_experience_idx on resume_bullets (experience_id);

drop trigger if exists resume_bullets_updated_at on resume_bullets;
create trigger resume_bullets_updated_at
  before update on resume_bullets
  for each row execute procedure update_updated_at();

-- ─── COMPANIES: careers identity and the watchlist ───────────────
-- Extends the existing entity rather than creating "target companies".
-- watch_status: target (worth watching) | watching (no opening yet, re-check)
--               | opening_available | ignored | null (not on the watchlist)

alter table companies
  add column if not exists careers_url            text,
  add column if not exists ats_type               text,
  add column if not exists ats_identifier         text,
  add column if not exists watch_status           text
    check (watch_status is null or watch_status in ('target','watching','opening_available','ignored')),
  add column if not exists watch_priority         int,
  add column if not exists watch_note             text,
  add column if not exists watch_source           text,     -- 'planner' | 'user' | 'scout'
  add column if not exists last_careers_check_at  timestamptz,
  add column if not exists careers_check_note     text,
  add column if not exists company_type           text,     -- startup | growth | corporate | …
  add column if not exists industry_tags          text[] default '{}',
  add column if not exists research_summary       text,
  add column if not exists research_version       text,
  add column if not exists researched_at          timestamptz;

create index if not exists companies_watch_idx on companies (user_id, watch_status);

-- ─── SCOUTING RUNS: which product ran ────────────────────────────
-- Job-scout and package runs reuse scouting_runs so agent_runs attaches to
-- them exactly as it does for outreach runs (migration 011).

alter table scouting_runs
  add column if not exists kind               text not null default 'outreach'
    check (kind in ('outreach','job_scout','job_verify','package','evidence_import')),
  add column if not exists career_mission_id  uuid references career_missions(id) on delete set null;

create index if not exists scouting_runs_kind_idx on scouting_runs (user_id, kind, started_at desc);

-- ─── JOB OPPORTUNITIES ───────────────────────────────────────────

create table if not exists job_opportunities (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid references profiles(id) on delete cascade not null,
  company_id                uuid references companies(id) on delete set null,
  company_name              text not null,
  mission_id                uuid references career_missions(id) on delete set null,

  title                     text not null,
  role_family               text,                     -- normalized, open vocabulary
  description_text          text,
  description_html          text,

  location_raw              text,
  location_city             text,
  location_state            text,
  location_country          text,
  location_tier             int,                      -- 1 | 2 | 3 | null, from mission preferences
  work_mode                 text default 'unknown'
                            check (work_mode in ('remote','hybrid','onsite','unknown')),
  employment_type           text default 'unknown'
                            check (employment_type in ('internship','co_op','full_time','part_time','contract','other','unknown')),
  season_relevance          text default 'unknown'
                            check (season_relevance in ('summer_2027','other_season','unspecified','unknown')),

  posted_at                 timestamptz,
  source_updated_at         timestamptz,
  deadline                  timestamptz,

  canonical_url             text,
  apply_url                 text,
  ats_type                  text,
  ats_job_id                text,
  requisition_id            text,

  compensation              text,
  min_qualifications        text[] default '{}',
  preferred_qualifications  text[] default '{}',
  graduation_eligibility    text,
  work_authorization        text,
  skills                    text[] default '{}',
  responsibilities          text[] default '{}',
  industry                  text,
  company_size_stage        text,
  extraction_version        text,
  extraction_confidence     numeric(3,2),

  verification_status       text not null default 'UNVERIFIED'
                            check (verification_status in ('UNVERIFIED','VERIFIED_OPEN','LIKELY_OPEN','STALE','CLOSED','ERROR')),
  last_verified_at          timestamptz,
  verification_note         text,
  verification_method       text,

  confidence                numeric(3,2),
  duplicate_cluster_id      uuid,
  is_canonical              boolean not null default true,

  -- denormalized from job_fit_evaluations for sorting and filtering
  fit_overall               numeric(5,4),
  fit_eligibility           text,
  fit_computed_at           timestamptz,

  disposition               text not null default 'new'
                            check (disposition in ('new','saved','dismissed')),
  first_seen_at             timestamptz default now(),
  last_seen_at              timestamptz default now(),
  discovery_run_id          uuid references scouting_runs(id) on delete set null,
  created_at                timestamptz default now(),
  updated_at                timestamptz default now()
);

create index if not exists job_opportunities_user_idx       on job_opportunities (user_id, is_canonical, fit_overall desc);
create index if not exists job_opportunities_company_idx    on job_opportunities (company_id);
create index if not exists job_opportunities_cluster_idx    on job_opportunities (duplicate_cluster_id);
create index if not exists job_opportunities_status_idx     on job_opportunities (user_id, verification_status);
create index if not exists job_opportunities_disposition_idx on job_opportunities (user_id, disposition);
create unique index if not exists job_opportunities_ats_uniq
  on job_opportunities (user_id, ats_type, ats_job_id) where ats_type is not null and ats_job_id is not null;
create unique index if not exists job_opportunities_url_uniq
  on job_opportunities (user_id, canonical_url) where canonical_url is not null;

drop trigger if exists job_opportunities_updated_at on job_opportunities;
create trigger job_opportunities_updated_at
  before update on job_opportunities
  for each row execute procedure update_updated_at();

create table if not exists job_sources (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid references job_opportunities(id) on delete cascade not null,
  source_type   text not null,               -- greenhouse | lever | ashby | smartrecruiters | workable | careers_page | web_search | manual | aggregator
  source_url    text,
  external_id   text,
  raw           jsonb,
  run_id        uuid references scouting_runs(id) on delete set null,
  discovered_at timestamptz default now()
);

create index if not exists job_sources_job_idx on job_sources (job_id);
create unique index if not exists job_sources_uniq on job_sources (job_id, source_type, coalesce(source_url, ''));

-- The description as it was. An application points at one of these forever,
-- so what was applied to survives the posting disappearing.
create table if not exists job_snapshots (
  id               uuid primary key default gen_random_uuid(),
  job_id           uuid references job_opportunities(id) on delete cascade not null,
  captured_at      timestamptz default now(),
  title            text,
  company_name     text,
  location_raw     text,
  canonical_url    text,
  description_text text,
  structured       jsonb,                    -- the extracted fields at capture time
  sha256           text
);

create index if not exists job_snapshots_job_idx on job_snapshots (job_id, captured_at desc);

create table if not exists job_fit_evaluations (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid references profiles(id) on delete cascade not null,
  job_id                 uuid references job_opportunities(id) on delete cascade not null,
  mission_id             uuid references career_missions(id) on delete cascade,
  components             jsonb not null,       -- [{dimension, score, explanation, evidence[]}]
  weights_used           jsonb not null,
  overall                numeric(5,4) not null,
  feedback_adjustment    numeric(5,4) default 0,
  eligibility            text not null check (eligibility in ('QUALIFIED','STRETCH','NOT_QUALIFIED','UNKNOWN')),
  eligibility_reasoning  text,
  explanation            text,
  uncertainties          text[] default '{}',
  red_flags              text[] default '{}',
  missing_qualifications text[] default '{}',
  confidence             numeric(3,2),
  prompt_version         text,
  agent_run_id           uuid references agent_runs(id) on delete set null,
  computed_at            timestamptz default now()
);

create unique index if not exists job_fit_evaluations_uniq on job_fit_evaluations (job_id, coalesce(mission_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists job_fit_evaluations_user_idx on job_fit_evaluations (user_id, overall desc);

create table if not exists job_evidence_maps (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid references profiles(id) on delete cascade not null,
  job_id              uuid references job_opportunities(id) on delete cascade not null,
  why_i_fit           text,
  top_experience_ids  uuid[] default '{}',
  fact_ids            uuid[] default '{}',
  metric_ids          uuid[] default '{}',
  skill_ids           uuid[] default '{}',
  story_ids           uuid[] default '{}',
  gaps                text[] default '{}',
  best_differentiator text,
  emphasize           text[] default '{}',
  do_not_claim        text[] default '{}',
  prompt_version      text,
  agent_run_id        uuid references agent_runs(id) on delete set null,
  created_at          timestamptz default now()
);

create unique index if not exists job_evidence_maps_job_uniq on job_evidence_maps (job_id);

create table if not exists warm_paths (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid references profiles(id) on delete cascade not null,
  job_id           uuid references job_opportunities(id) on delete cascade,
  company_id       uuid references companies(id) on delete cascade,
  contact_id       uuid references contacts(id) on delete cascade not null,
  relationship     text not null,             -- current_employee | former_employee | alumni | founder | investor | mentor | prior_outreach | second_degree | other
  strength         numeric(3,2) not null,     -- 0-1
  why_relevant     text,
  existing_history text,
  suggested_action text,
  retrieval_basis  text[] default '{}',       -- how the candidate was found: company_match, index_search, …
  agent_run_id     uuid references agent_runs(id) on delete set null,
  created_at       timestamptz default now()
);

create index if not exists warm_paths_job_idx     on warm_paths (job_id, strength desc);
create index if not exists warm_paths_company_idx on warm_paths (company_id);
create unique index if not exists warm_paths_uniq on warm_paths (job_id, contact_id);

create table if not exists job_feedback (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references profiles(id) on delete cascade not null,
  job_id      uuid references job_opportunities(id) on delete cascade not null,
  verdict     text not null check (verdict in ('LOVE','INTERESTED','MAYBE','NOT_INTERESTED')),
  reasons     text[] default '{}',
  note        text,
  created_at  timestamptz default now()
);

create index if not exists job_feedback_user_idx on job_feedback (user_id, created_at desc);
create index if not exists job_feedback_job_idx  on job_feedback (job_id, created_at desc);

-- ─── APPLICATIONS ────────────────────────────────────────────────

create table if not exists applications (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid references profiles(id) on delete cascade not null,
  job_id                    uuid references job_opportunities(id) on delete cascade not null,
  company_id                uuid references companies(id) on delete set null,
  state                     text not null default 'SAVED'
                            check (state in ('DISCOVERED','SAVED','RESEARCHED','PREPARING','READY_FOR_REVIEW',
                                             'READY_TO_APPLY','APPLIED','OA','INTERVIEW','FINAL_ROUND','OFFER',
                                             'REJECTED','WITHDRAWN','CLOSED')),
  job_snapshot_id           uuid references job_snapshots(id) on delete set null,
  current_package_id        uuid,                       -- application_packages.id (no FK: created later)
  submitted_package_id      uuid,
  applied_at                timestamptz,
  submitted_resume_path     text,
  submitted_cover_letter_path text,
  contacts_used             uuid[] default '{}',
  notes                     text,
  interviews                jsonb default '[]',         -- [{stage, at, notes}]
  outcome                   text,
  outcome_at                timestamptz,
  outcome_note              text,
  locked                    boolean not null default false,
  created_at                timestamptz default now(),
  updated_at                timestamptz default now()
);

create unique index if not exists applications_job_uniq on applications (user_id, job_id);
create index if not exists applications_user_state_idx on applications (user_id, state);

drop trigger if exists applications_updated_at on applications;
create trigger applications_updated_at
  before update on applications
  for each row execute procedure update_updated_at();

create table if not exists application_events (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid references applications(id) on delete cascade not null,
  from_state     text,
  to_state       text not null,
  actor          text not null default 'user' check (actor in ('user','system','agent')),
  detail         jsonb,
  created_at     timestamptz default now()
);

create index if not exists application_events_app_idx on application_events (application_id, created_at desc);

create table if not exists application_packages (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid references profiles(id) on delete cascade not null,
  job_id                    uuid references job_opportunities(id) on delete cascade not null,
  application_id            uuid references applications(id) on delete cascade,
  version                   int not null default 1,
  status                    text not null default 'generating'
                            check (status in ('generating','resume_review','ready_for_review','ready_to_apply','failed','superseded','locked')),
  stage                     text,                       -- last completed stage, for the progress UI
  run_id                    uuid references scouting_runs(id) on delete set null,
  resume_patch_id           uuid,
  cover_letter_id           uuid,
  resume_docx_path          text,
  resume_pdf_path           text,
  cover_docx_path           text,
  cover_pdf_path            text,
  resume_filename           text,
  cover_filename            text,
  qa                        jsonb,                      -- lib/career/documents/qa.ts result
  company_research_snapshot jsonb,
  fit_snapshot              jsonb,
  evidence_map_snapshot     jsonb,
  warm_paths_snapshot       jsonb,
  job_snapshot_id           uuid references job_snapshots(id) on delete set null,
  cost_usd                  numeric(12,6) default 0,
  error                     text,
  approved_at               timestamptz,
  created_at                timestamptz default now(),
  updated_at                timestamptz default now()
);

create index if not exists application_packages_job_idx on application_packages (job_id, version desc);
create unique index if not exists application_packages_version_uniq on application_packages (job_id, version);

drop trigger if exists application_packages_updated_at on application_packages;
create trigger application_packages_updated_at
  before update on application_packages
  for each row execute procedure update_updated_at();

-- ─── RÉSUMÉ PATCHES ──────────────────────────────────────────────
-- One patch per package; one row per proposed change. The verifier's verdict
-- is stored per change, clause by clause.

create table if not exists resume_patches (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid references profiles(id) on delete cascade not null,
  job_id                  uuid references job_opportunities(id) on delete cascade not null,
  package_id              uuid references application_packages(id) on delete cascade,
  base_resume_document_id uuid references resume_documents(id) on delete set null,
  status                  text not null default 'proposed'
                          check (status in ('proposed','reviewed','applied','superseded')),
  no_change_reason        text,                         -- set when the tailor proposed nothing
  summary                 text,
  edit_distance           numeric(6,4),                 -- 0 = identical to master
  tailor_version          text,
  verifier_version        text,
  agent_run_id            uuid references agent_runs(id) on delete set null,
  created_at              timestamptz default now(),
  updated_at              timestamptz default now()
);

create index if not exists resume_patches_package_idx on resume_patches (package_id);

drop trigger if exists resume_patches_updated_at on resume_patches;
create trigger resume_patches_updated_at
  before update on resume_patches
  for each row execute procedure update_updated_at();

create table if not exists resume_patch_changes (
  id                   uuid primary key default gen_random_uuid(),
  patch_id             uuid references resume_patches(id) on delete cascade not null,
  bullet_id            uuid references resume_bullets(id) on delete set null,
  experience_id        uuid references evidence_experiences(id) on delete set null,
  change_type          text not null
                       check (change_type in ('keep','reorder','reword','swap','new','remove')),
  edit_level           int not null check (edit_level between 0 and 4),
  original_text        text,
  proposed_text        text,
  source_bullet_id     uuid references resume_bullets(id) on delete set null,   -- Level 3: the approved alternate
  position             int,                                                      -- proposed order within the experience
  reason               text,
  job_requirement      text,
  evidence_fact_ids    uuid[] default '{}',
  confidence           numeric(3,2),
  verification_result  text not null default 'NOT_CHECKED'
                       check (verification_result in ('SUPPORTED','UNSUPPORTED','UNCERTAIN','NOT_CHECKED','SKIPPED')),
  verification_notes   text,
  verification_clauses jsonb,                 -- [{clause, verdict, fact_ids[], note}]
  precheck_findings    jsonb,                 -- deterministic gate output
  review_status        text not null default 'pending'
                       check (review_status in ('pending','approved','rejected','edited','auto_rejected')),
  final_text           text,                  -- what the document will carry after review
  created_at           timestamptz default now(),
  updated_at           timestamptz default now()
);

create index if not exists resume_patch_changes_patch_idx on resume_patch_changes (patch_id, position);

drop trigger if exists resume_patch_changes_updated_at on resume_patch_changes;
create trigger resume_patch_changes_updated_at
  before update on resume_patch_changes
  for each row execute procedure update_updated_at();

-- ─── COVER LETTERS ───────────────────────────────────────────────

create table if not exists cover_letters (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references profiles(id) on delete cascade not null,
  job_id          uuid references job_opportunities(id) on delete cascade not null,
  package_id      uuid references application_packages(id) on delete cascade,
  version         int not null default 1,
  greeting        text,
  paragraphs      jsonb not null default '[]',   -- string[]
  closing         text,
  full_text       text,
  edited_text     text,
  word_count      int,
  -- [{claim_text, kind:'company'|'personal', research_fact_id|evidence_fact_id}]
  claims          jsonb default '[]',
  grounding       jsonb,                          -- deterministic gate result
  review_status   text not null default 'pending'
                  check (review_status in ('pending','approved','rejected','edited')),
  prompt_version  text,
  agent_run_id    uuid references agent_runs(id) on delete set null,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create index if not exists cover_letters_package_idx on cover_letters (package_id);

drop trigger if exists cover_letters_updated_at on cover_letters;
create trigger cover_letters_updated_at
  before update on cover_letters
  for each row execute procedure update_updated_at();

-- ─── STORAGE ─────────────────────────────────────────────────────
-- Private bucket for résumés, cover letters and generated packages. Files are
-- written and read through the service-role client in route handlers; the
-- browser never gets a bucket URL. Wrapped so the migration still applies on
-- a database where the storage schema is unavailable.

do $$
begin
  insert into storage.buckets (id, name, public)
  values ('career-docs', 'career-docs', false)
  on conflict (id) do nothing;
exception when others then
  raise notice 'storage bucket career-docs not created: %', sqlerrm;
end $$;

-- ─── ROW LEVEL SECURITY ──────────────────────────────────────────
-- Same pattern as every other table. Child tables policed through parent.

alter table career_missions        enable row level security;
alter table evidence_experiences   enable row level security;
alter table evidence_facts         enable row level security;
alter table evidence_metrics       enable row level security;
alter table evidence_deliverables  enable row level security;
alter table evidence_skills        enable row level security;
alter table evidence_stories       enable row level security;
alter table evidence_preferences   enable row level security;
alter table resume_documents       enable row level security;
alter table resume_bullets         enable row level security;
alter table job_opportunities      enable row level security;
alter table job_sources            enable row level security;
alter table job_snapshots          enable row level security;
alter table job_fit_evaluations    enable row level security;
alter table job_evidence_maps      enable row level security;
alter table warm_paths             enable row level security;
alter table job_feedback           enable row level security;
alter table applications           enable row level security;
alter table application_events     enable row level security;
alter table application_packages   enable row level security;
alter table resume_patches         enable row level security;
alter table resume_patch_changes   enable row level security;
alter table cover_letters          enable row level security;

drop policy if exists "Users manage own career_missions" on career_missions;
create policy "Users manage own career_missions" on career_missions for all using (user_id = auth.uid());

drop policy if exists "Users manage own evidence_experiences" on evidence_experiences;
create policy "Users manage own evidence_experiences" on evidence_experiences for all using (user_id = auth.uid());

drop policy if exists "Users manage own evidence_facts" on evidence_facts;
create policy "Users manage own evidence_facts" on evidence_facts for all using (user_id = auth.uid());

drop policy if exists "Users manage own evidence_metrics" on evidence_metrics;
create policy "Users manage own evidence_metrics" on evidence_metrics for all using (user_id = auth.uid());

drop policy if exists "Users manage own evidence_deliverables" on evidence_deliverables;
create policy "Users manage own evidence_deliverables" on evidence_deliverables for all using (user_id = auth.uid());

drop policy if exists "Users manage own evidence_skills" on evidence_skills;
create policy "Users manage own evidence_skills" on evidence_skills for all using (user_id = auth.uid());

drop policy if exists "Users manage own evidence_stories" on evidence_stories;
create policy "Users manage own evidence_stories" on evidence_stories for all using (user_id = auth.uid());

drop policy if exists "Users manage own evidence_preferences" on evidence_preferences;
create policy "Users manage own evidence_preferences" on evidence_preferences for all using (user_id = auth.uid());

drop policy if exists "Users manage own resume_documents" on resume_documents;
create policy "Users manage own resume_documents" on resume_documents for all using (user_id = auth.uid());

drop policy if exists "Users manage own resume_bullets" on resume_bullets;
create policy "Users manage own resume_bullets" on resume_bullets for all using (user_id = auth.uid());

drop policy if exists "Users manage own job_opportunities" on job_opportunities;
create policy "Users manage own job_opportunities" on job_opportunities for all using (user_id = auth.uid());

drop policy if exists "Users manage own job_sources" on job_sources;
create policy "Users manage own job_sources" on job_sources for all
  using (job_id in (select id from job_opportunities where user_id = auth.uid()));

drop policy if exists "Users manage own job_snapshots" on job_snapshots;
create policy "Users manage own job_snapshots" on job_snapshots for all
  using (job_id in (select id from job_opportunities where user_id = auth.uid()));

drop policy if exists "Users manage own job_fit_evaluations" on job_fit_evaluations;
create policy "Users manage own job_fit_evaluations" on job_fit_evaluations for all using (user_id = auth.uid());

drop policy if exists "Users manage own job_evidence_maps" on job_evidence_maps;
create policy "Users manage own job_evidence_maps" on job_evidence_maps for all using (user_id = auth.uid());

drop policy if exists "Users manage own warm_paths" on warm_paths;
create policy "Users manage own warm_paths" on warm_paths for all using (user_id = auth.uid());

drop policy if exists "Users manage own job_feedback" on job_feedback;
create policy "Users manage own job_feedback" on job_feedback for all using (user_id = auth.uid());

drop policy if exists "Users manage own applications" on applications;
create policy "Users manage own applications" on applications for all using (user_id = auth.uid());

drop policy if exists "Users manage own application_events" on application_events;
create policy "Users manage own application_events" on application_events for all
  using (application_id in (select id from applications where user_id = auth.uid()));

drop policy if exists "Users manage own application_packages" on application_packages;
create policy "Users manage own application_packages" on application_packages for all using (user_id = auth.uid());

drop policy if exists "Users manage own resume_patches" on resume_patches;
create policy "Users manage own resume_patches" on resume_patches for all using (user_id = auth.uid());

drop policy if exists "Users manage own resume_patch_changes" on resume_patch_changes;
create policy "Users manage own resume_patch_changes" on resume_patch_changes for all
  using (patch_id in (select id from resume_patches where user_id = auth.uid()));

drop policy if exists "Users manage own cover_letters" on cover_letters;
create policy "Users manage own cover_letters" on cover_letters for all using (user_id = auth.uid());
