-- 020 — a queued scouting run must be able to give up.
--
-- THE INCIDENT. A run sat at status='queued' for 328 minutes. Its row already
-- said what had happened: `claim_token` set and `heartbeat_at` stamped at the
-- ENQUEUE instant, `worker_started_at` NULL. Something asked a worker to start
-- and no worker ever did.
--
-- Nothing could recover it, because 'queued' was an absorbing state:
--
--   * run-reaper.ts selects listRuns(userId, ['running']) — a queued run was
--     never even fetched;
--   * isRunStale() opens with `if (row.status !== 'running') return false`;
--   * the only retry lived in the run-detail API route and fired when a browser
--     POLLED it, while the UI told the founder they could close the tab;
--   * and vercel.json schedules the crons DAILY, so the nearest sweep that did
--     exist could be 24 hours away — and would not have looked at it anyway.
--
-- These columns let the watchdog count attempts and stop. Without an attempt
-- count a watchdog can only ever retry, which is the same bug wearing a hat.
--
-- Additive and idempotent. Every column is defaulted or nullable: the watchdog
-- is written to work WITHOUT this migration too — judging a run on `started_at`
-- and treating a missing `attempt_count` as zero — because the rows stuck today
-- are on the pre-020 schema and must recover before this file is ever pasted in.

-- ─── How long has it waited, and how often have we asked? ────────────────────

alter table scouting_runs
  add column if not exists queued_at timestamptz;

comment on column scouting_runs.queued_at is
  'When the run entered the queue. Distinct from started_at, which is the row''s creation and is reused as a fallback for pre-020 rows.';

alter table scouting_runs
  add column if not exists attempt_count integer not null default 0;

comment on column scouting_runs.attempt_count is
  'How many times a worker has been ASKED to start this run. Counted before the dispatch, not after: a dispatch that hangs must not be retried for ever by a watchdog that only counts successes.';

alter table scouting_runs
  add column if not exists last_dispatch_at timestamptz;

alter table scouting_runs
  add column if not exists claimed_at timestamptz;

comment on column scouting_runs.claimed_at is
  'When a worker won the claim. worker_started_at records the same moment from the worker''s side; this one is written by the claim guard.';

-- ─── Who is holding it, and until when ───────────────────────────────────────

alter table scouting_runs
  add column if not exists worker_id text;

comment on column scouting_runs.worker_id is
  'Identifies the process holding the lease, so a log line can name it. Not a lock — the lease is.';

alter table scouting_runs
  add column if not exists lease_expires_at timestamptz;

comment on column scouting_runs.lease_expires_at is
  'A LEASE, not a lock: the worker renews it by heartbeat, and once it lapses another worker may reclaim the run. A permanent lock would need manual cleanup, which is the failure mode this whole migration exists to remove.';

-- ─── Stopping on purpose ─────────────────────────────────────────────────────

alter table scouting_runs
  add column if not exists cancel_requested boolean not null default false;

comment on column scouting_runs.cancel_requested is
  'Set by the user. The worker checks it between expensive stages and stops; the watchdog finalises a queued run that was cancelled before anything picked it up.';

-- ─── What went wrong, kept across attempts ───────────────────────────────────

alter table scouting_runs
  add column if not exists last_error text;

comment on column scouting_runs.last_error is
  '`error` is the current state''s message; this survives a later retry so a run that failed twice for different reasons can still be diagnosed.';

-- ─── Finding the stuck ones ──────────────────────────────────────────────────
--
-- The query the watchdog runs on every read. Partial, because the interesting
-- rows are always a handful and the terminal ones are almost all of them.

create index if not exists scouting_runs_queued_idx
  on scouting_runs (user_id, queued_at)
  where status = 'queued';

create index if not exists scouting_runs_lease_idx
  on scouting_runs (lease_expires_at)
  where status = 'running';
