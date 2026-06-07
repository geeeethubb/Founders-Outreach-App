-- Per-user Gmail sending via Google OAuth
-- Run this in the Supabase SQL Editor (same as migrations 002–005).

-- Stores each user's connected Gmail account so they can send from their own
-- address. The refresh_token is encrypted at rest (AES-256-GCM) by the app —
-- it is never stored in plaintext and never exposed to the browser.
create table if not exists email_accounts (
  user_id        uuid primary key references profiles(id) on delete cascade,
  email          text not null,            -- connected Gmail (the From address)
  refresh_token  text not null,            -- AES-256-GCM ciphertext
  scope          text,
  connected_at   timestamptz default now(),
  updated_at     timestamptz default now()
);

create trigger email_accounts_updated_at
  before update on email_accounts
  for each row execute procedure update_updated_at();

-- RLS is enabled with NO anon policies on purpose: only the server's
-- service-role client reads/writes this table, so tokens are never reachable
-- from the browser. (The service role bypasses RLS.)
alter table email_accounts enable row level security;
