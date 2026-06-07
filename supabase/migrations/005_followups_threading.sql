-- Follow-up templates + threaded replies
-- Run this in the Supabase SQL Editor (same as migrations 002–004).

-- Distinguish initial outreach templates from follow-up templates.
alter table templates
  add column if not exists type text default 'initial'
  check (type in ('initial','followup'));

-- Link a follow-up email to the email it replies to, so we can thread it
-- (Re: subject + In-Reply-To / References headers) into the original Gmail thread.
alter table emails
  add column if not exists reply_to_email_id uuid references emails(id);

create index if not exists emails_reply_to_email_id_idx on emails (reply_to_email_id);
