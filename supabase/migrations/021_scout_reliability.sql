-- 021 — every scouting run has an identity, a budget, a checkpoint and a verdict.
--
-- THE INCIDENTS. Five `kind='outreach'` (People Scout) rows sat at
-- status='running' with no heartbeat and no completed_at: three from August,
-- two from the same afternoon in September. The People Scout ran inside one
-- HTTP request, wrote 'running' at the top of the request, and only ever wrote
-- a terminal status on its own normal return — a throw, a 504, or a closed
-- laptop left the row open for ever, and the reaper skipped that kind. Two
-- `kind='job_scout'` rows the same afternoon failed with "nothing was
-- available to run it after 2 attempts over 181s" and `attempt_count = 0`: the
-- dispatch outcome was never written to the row, so the founder saw a sentence
-- and not a cause.
--
-- These columns make both scouts the same kind of thing: a row a worker claims,
-- advances in bounded invocations, checkpoints between them, and closes with a
-- stable error code that the UI can turn into a remedy. Every column is
-- nullable or defaulted, so a row written before this file reads unchanged.
--
-- Additive and idempotent; re-running is the normal operating condition.
-- Run `npm run check:sql -- 021` before applying.

-- ─── The verdict, as a code and not only as a sentence ───────────────────────

alter table scouting_runs
  add column if not exists error_code text;

comment on column scouting_runs.error_code is
  'Stable machine-readable cause of a failed or partial run (CONFIGURATION, DISPATCH, PROVIDER_TIMEOUT, RUN_DEADLINE, …). `error` stays the sentence; this is what the UI keys a remedy on.';

alter table scouting_runs
  add column if not exists error_detail jsonb;

comment on column scouting_runs.error_detail is
  'Structured detail behind error_code: stage, provider, http status, attempt, remedy. Never a token, never a key.';

-- ─── One run, several invocations ────────────────────────────────────────────
--
-- A hosted worker lives 300 seconds. A deep scout does not fit in one, so a run
-- is executed as a CHAIN of invocations under one row: each one checkpoints
-- where it got to and hands the row back to the queue with a fresh claim token.
-- The row needs to know how many legs it has had and when the whole run must be
-- over, or "resumable" quietly becomes "immortal".

alter table scouting_runs
  add column if not exists invocation_count integer not null default 0;

comment on column scouting_runs.invocation_count is
  'How many worker invocations have executed this run. Distinct from attempt_count, which counts dispatch attempts for the CURRENT leg and resets when a leg hands the run back to the queue.';

alter table scouting_runs
  add column if not exists run_deadline_at timestamptz;

comment on column scouting_runs.run_deadline_at is
  'The absolute instant the WHOLE run must be terminal by, set at enqueue. A worker never starts a new leg past it; the watchdog closes anything still open after it.';

-- ─── Where the run got to ────────────────────────────────────────────────────
--
-- The Job Scout already carries its cursor inside `params`. The People Scout's
-- resume state is larger (the research dossiers it has already paid for) and
-- is read by nobody but the next invocation, so it gets its own column rather
-- than bloating `params` or the `progress` payload the browser polls.

alter table scouting_runs
  add column if not exists checkpoint jsonb;

comment on column scouting_runs.checkpoint is
  'Stage checkpoints for a People Scout run: what is finished, and the outputs a continuation must not pay for again. Bounded by the orchestrator; never returned to the browser.';

-- ─── What the run produced ───────────────────────────────────────────────────
--
-- A Job Scout's results are rows in job_opportunities + scouting_run_jobs. A
-- People Scout's ranked prospects were only ever the body of one HTTP response,
-- which is why a refresh lost them. They live here now, written progressively,
-- so a run that stops short still shows what it found.

alter table scouting_runs
  add column if not exists result jsonb;

comment on column scouting_runs.result is
  'The People Scout result payload the page renders (prospects, funnel, usage, the internal-first decision). Written after the internal phase and again after ranking, so a partial or failed run still has its prospects.';

-- ─── Finding the runs that must be closed ────────────────────────────────────

create index if not exists scouting_runs_run_deadline_idx
  on scouting_runs (run_deadline_at)
  where status in ('queued', 'running');

-- ─── Closing the runs that were never going to close ─────────────────────────
--
-- The five orphans: a scout run with no heartbeat that has been 'running' for
-- over an hour was executed inside an HTTP request that died. Nothing will ever
-- write to it again, and this is the honest status. Rows WITH a heartbeat —
-- including a queued durable run that was never claimed — are deliberately left
-- alone here: they belong to the queue watchdog and the reaper, which judge
-- them on their own lease and deadline the next time anything reads them.

update scouting_runs
   set status       = 'failed',
       completed_at = coalesce(completed_at, now()),
       error        = coalesce(error, 'this run was executed inside a request that ended before the run did (closed by migration 021)'),
       error_code   = coalesce(error_code, 'RUN_DEADLINE'),
       claim_token  = null
 where status in ('queued', 'running')
   and kind in ('outreach', 'job_scout')
   and heartbeat_at is null
   and started_at < now() - interval '1 hour';

-- ─── One active QUEUED run per scout kind per user ──────────────────────────
--
-- "A scout run is already going" used to be a read followed by an insert, two
-- statements apart — which is a race. The database is the only thing that can
-- make it atomic. Scoped to rows the queue owns (`queued_at is not null`):
-- a manual job add, a company check, a cron sweep and a CLI People Scout all
-- write short-lived inline `job_scout` / `outreach` rows with no queue
-- timestamp, and those must never collide with — or block — a queued run.
-- Kind-scoped too, because a package run (019) is allowed beside a scout. A
-- violation is answered as 409 with the active run's id, never as a second
-- paid row.

create unique index if not exists scouting_runs_one_active_per_kind_idx
  on scouting_runs (user_id, kind)
  where status in ('queued', 'running') and queued_at is not null and kind in ('outreach', 'job_scout');
