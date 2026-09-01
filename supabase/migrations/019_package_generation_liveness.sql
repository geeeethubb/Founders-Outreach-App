-- 019 — a generating package must be able to prove it is still alive.
--
-- THE INCIDENT. A Rondo Energy package sat at status='generating',
-- stage='intelligence', cost_usd=$0 for over a day. Nothing was looping. The
-- process that owned the row died, and no other part of the system had any
-- opinion about that, because:
--
--   * application_packages had no heartbeat, no deadline and no attempt count,
--     so "still working" and "died an hour ago" are the same row;
--   * the only reaper that exists (run-reaper.ts) skips any run whose kind is
--     not 'job_scout' — a package run was structurally invisible to it;
--   * status='generating' was only ever changed by the same in-process
--     function that set it.
--
-- These columns make the difference observable. A row that carries a deadline
-- and a heartbeat can be judged dead by anyone who reads it — the UI, a cron,
-- or the next request — instead of only by the process that is no longer there.
--
-- Additive and idempotent like every migration here. Every column is nullable
-- or defaulted, so a package written before this migration still reads fine and
-- simply has no liveness data; `generation_deadline_at IS NULL` is treated by
-- the code as "legacy row, judge it on updated_at".

-- ─── When it started, when it must be finished by ────────────────────────────

alter table application_packages
  add column if not exists generation_started_at timestamptz;

comment on column application_packages.generation_started_at is
  'When this generation attempt began. Set every attempt, not only the first.';

alter table application_packages
  add column if not exists generation_deadline_at timestamptz;

comment on column application_packages.generation_deadline_at is
  'The hard end-to-end SLA for this attempt (start + 5 minutes). Past this instant the row is stale no matter what it says, and anyone reading it may finalise it.';

alter table application_packages
  add column if not exists generation_finished_at timestamptz;

-- ─── Is it still alive? ──────────────────────────────────────────────────────

alter table application_packages
  add column if not exists last_heartbeat_at timestamptz;

comment on column application_packages.last_heartbeat_at is
  'Stamped by the running generation between stages and during long ones. Silence past the deadline is what tells a reader the worker is gone. NULL means the attempt predates 019 or died before its first stage.';

alter table application_packages
  add column if not exists stage_started_at timestamptz;

comment on column application_packages.stage_started_at is
  'When the CURRENT stage began — so a slow stage can be named, not just a slow package.';

alter table application_packages
  add column if not exists generation_attempt integer not null default 1;

comment on column application_packages.generation_attempt is
  'Retries of the same package. A retry reuses checkpointed work; it does not start from nothing.';

-- ─── What happened ───────────────────────────────────────────────────────────

alter table application_packages
  add column if not exists last_error text;

comment on column application_packages.last_error is
  'The most recent failure, kept even after a later attempt succeeds. `error` is the CURRENT state''s message; this is the history.';

alter table application_packages
  add column if not exists generation_metrics jsonb not null default '{}'::jsonb;

comment on column application_packages.generation_metrics is
  'Per-stage timings, LLM call count, research query count, elapsed ms. Enough to answer "why did this take 4m18s?" without guessing.';

-- ─── Checkpoints ─────────────────────────────────────────────────────────────
--
-- Research is the expensive, hang-prone stage. Storing its result the moment it
-- lands means a retry does not pay for it twice, and a crash after research
-- does not throw it away.

alter table application_packages
  add column if not exists stages_completed jsonb not null default '[]'::jsonb;

comment on column application_packages.stages_completed is
  'Stage names finished and persisted on this package. A retry skips what is already here rather than re-running it.';

-- ─── Finding the stuck ones ──────────────────────────────────────────────────
--
-- The query the reaper and the UI both run: non-terminal rows past their
-- deadline. Partial so the index stays small — the interesting rows are always
-- a handful, and the terminal ones are the overwhelming majority.

create index if not exists application_packages_generating_idx
  on application_packages (user_id, generation_deadline_at)
  where status in ('generating', 'resume_review');

-- ─── Same problem, the run table ─────────────────────────────────────────────
--
-- scouting_runs already has heartbeat_at (migration 016) but only job_scout runs
-- ever wrote to it. Package runs will now heartbeat too; nothing to add, but the
-- index that finds live runs should not be scout-only.

create index if not exists scouting_runs_active_kind_idx
  on scouting_runs (user_id, kind, status)
  where status in ('queued', 'running');
