-- Phase 9 — approval, send, response tracking.
--
-- Run this in the Supabase SQL Editor (same as 002-011). Idempotent: re-running
-- is the normal operating condition since nothing tracks what has been applied.
--
-- WHAT THIS DOES NOT DO, deliberately:
--   * it does not touch `emails`, `conversations` or `messages`. That layer works
--     and is the hardest-won code in the repo (CLAUDE.md "Do not touch").
--   * it does not widen `emails.status`. V1 screens read that check constraint.
--
-- Instead `outreach` owns the RELATIONSHIP state and points at the `emails` row
-- that carries the actual outbound message. One row per (user, contact): a
-- person you are pursuing, in one state, with one live draft.

-- ─── OUTREACH ────────────────────────────────────────────────────────────────
create table if not exists outreach (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid references profiles(id) on delete cascade not null,
  contact_id          uuid references contacts(id) on delete cascade not null,
  company_id          uuid references companies(id) on delete set null,
  run_id              uuid references scouting_runs(id) on delete set null,

  mission_goal        text,

  -- 'sending' and 'failed' are internal to the send path: 'sending' is the
  -- compare-and-swap lock that makes repeated clicks idempotent, 'failed'
  -- preserves an approved draft whose send errored so it can be retried.
  state               text not null default 'draft'
                      check (state in ('draft','ready_for_review','approved','skipped',
                                       'sending','sent','failed','replied','meeting',
                                       'referred','closed')),

  -- ─── positioning snapshot ───
  -- Stored, not re-derived. The brief that produced this draft must survive a
  -- prompt-version bump, otherwise "why did it write this?" is unanswerable.
  positioning         jsonb,
  positioning_version text,
  proof_point_ids     text[] default '{}',
  angle               text,           -- the thesis, denormalized for analytics

  -- ─── draft ───
  subject             text,
  body                text,           -- what the agent wrote
  body_edited         text,           -- what the user changed it to; null if untouched
  edited_at           timestamptz,
  word_count          int,
  cta                 text,
  draft_version       text,
  allowed_claims      jsonb,          -- the evidence pool the grounding gate checks against
  grounding           jsonb,          -- last gate result: {ok, blocking[], warnings[]}

  -- ─── send ───
  email_id            uuid references emails(id) on delete set null,
  sent_at             timestamptz,
  send_error          text,
  send_attempts       int default 0,
  gmail_thread_id     text,
  rfc822_message_id   text,

  -- ─── response ───
  conversation_id     uuid references conversations(id) on delete set null,
  replied_at          timestamptz,
  reply_classification text
                      check (reply_classification is null or reply_classification in
                        ('POSITIVE','NEUTRAL','NEGATIVE','REFERRAL','MEETING_REQUEST',
                         'QUESTION','NOT_NOW','NO_FIT','OTHER')),
  reply_action        text
                      check (reply_action is null or reply_action in
                        ('REPLY','BOOK_MEETING','FOLLOW_REFERRAL','FOLLOW_UP_LATER','CLOSE')),
  reply_summary       text,
  suggested_reply     jsonb,          -- the Conversation Agent's draft, awaiting approval

  -- ─── follow-up ───
  -- Hard cap of one automatic suggested follow-up per cold outreach. The count
  -- is a column rather than a query so the cap is enforceable in one statement.
  followup_count      int default 0,
  followup_suggestion jsonb,
  followup_due_at     timestamptz,

  -- ─── outcome ───
  outcome             text
                      check (outcome is null or outcome in
                        ('NO_RESPONSE','REPLIED','CALL_BOOKED','REFERRED','RESUME_REQUESTED',
                         'PROJECT_DISCUSSION','INTERNSHIP_DISCUSSION','OPPORTUNITY_CREATED',
                         'NOT_INTERESTED')),
  outcome_at          timestamptz,
  outcome_note        text,

  -- ─── analytics dimensions ───
  -- Denormalized at write time so the funnel is arithmetic over one table.
  -- No ML here; just clean structured data for the later Learning Agent.
  segment             text,
  company_type        text,
  recipient_role      text,
  score               numeric,

  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

-- One live outreach per person. Also the first line of duplicate-send defence:
-- you cannot end up with two approved drafts to the same human.
create unique index if not exists outreach_user_contact_uniq
  on outreach (user_id, contact_id);

create index if not exists outreach_user_state_idx  on outreach (user_id, state);
create index if not exists outreach_thread_idx      on outreach (gmail_thread_id);
create index if not exists outreach_run_idx         on outreach (run_id);
create index if not exists outreach_created_idx     on outreach (created_at desc);

-- An `emails` row belongs to at most one outreach. Belt to the compare-and-swap
-- braces: even if two requests somehow both reached the send call, only one can
-- record its result here.
create unique index if not exists outreach_email_id_uniq
  on outreach (email_id) where email_id is not null;

drop trigger if exists outreach_updated_at on outreach;
create trigger outreach_updated_at
  before update on outreach
  for each row execute procedure update_updated_at();

-- ─── OUTREACH EVENTS ─────────────────────────────────────────────────────────
-- Append-only state history. The funnel counts current state; this answers
-- "when did it change, and who changed it" — including reverts and retries.
create table if not exists outreach_events (
  id           uuid primary key default gen_random_uuid(),
  outreach_id  uuid references outreach(id) on delete cascade not null,
  from_state   text,
  to_state     text not null,
  actor        text not null default 'user' check (actor in ('user','system','agent')),
  detail       jsonb,
  created_at   timestamptz default now()
);

create index if not exists outreach_events_outreach_idx
  on outreach_events (outreach_id, created_at desc);

-- ─── ROW LEVEL SECURITY ──────────────────────────────────────────────────────
alter table outreach        enable row level security;
alter table outreach_events enable row level security;

drop policy if exists "Users manage own outreach" on outreach;
create policy "Users manage own outreach" on outreach
  for all using (user_id = auth.uid());

-- Child table policed through its parent, matching every other child here.
drop policy if exists "Users manage own outreach_events" on outreach_events;
create policy "Users manage own outreach_events" on outreach_events
  for all using (
    exists (select 1 from outreach o where o.id = outreach_id and o.user_id = auth.uid())
  );
