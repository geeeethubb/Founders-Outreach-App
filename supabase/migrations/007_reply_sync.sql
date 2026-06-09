-- Gmail reply sync
-- Track replies by reading the user's Gmail (gmail.readonly) and folding inbound
-- messages into conversations. Run in the Supabase SQL Editor (same as 002–006).

-- The Gmail-assigned thread id for each sent email. We list this thread later to
-- discover replies the contact sent back into the same conversation.
alter table emails
  add column if not exists gmail_thread_id text;

create index if not exists emails_gmail_thread_id_idx on emails (gmail_thread_id);

-- The provider's (Gmail) immutable message id for an imported message, so the
-- sync is idempotent — re-running never inserts the same reply twice.
alter table messages
  add column if not exists provider_message_id text;

create unique index if not exists messages_provider_message_id_key
  on messages (provider_message_id)
  where provider_message_id is not null;
