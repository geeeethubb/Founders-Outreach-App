-- ═══════════════════════════════════════════════════════════════
-- Outreach OS — Initial Schema
-- Run this in your Supabase SQL Editor or via `supabase db push`
-- ═══════════════════════════════════════════════════════════════

-- ─── PROFILES ────────────────────────────────────────────────────
create table if not exists profiles (
  id          uuid primary key references auth.users on delete cascade,
  name        text,
  email       text,
  linkedin_url text,
  bio         text,
  company     text default 'Founders: Illinois Entrepreneurs',
  role        text,
  goals       text[] default array['recruit speakers', 'find mentors', 'connect members with jobs', 'facilitate investor intros'],
  created_at  timestamptz default now()
);

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1))
  );
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ─── CONTACTS ────────────────────────────────────────────────────
create table if not exists contacts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references profiles(id) on delete cascade not null,
  name            text not null,
  email           text,
  linkedin_url    text,
  twitter_handle  text,
  company         text,
  role            text,
  location        text,
  source          text default 'manual',
  status          text default 'new'
                  check (status in ('new','researching','researched','drafted','sent','replied','meeting','archived')),
  priority        int  default 0 check (priority between 0 and 5),
  tags            text[] default '{}',
  notes           text,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- Auto-update updated_at
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger contacts_updated_at
  before update on contacts
  for each row execute procedure update_updated_at();

-- ─── CONTACT RESEARCH ────────────────────────────────────────────
create table if not exists contact_research (
  id               uuid primary key default gen_random_uuid(),
  contact_id       uuid references contacts(id) on delete cascade unique,
  raw_linkedin     jsonb,
  raw_twitter      jsonb,
  raw_web          jsonb,
  summary          text,
  hooks            text[] default '{}',
  shared_context   text[] default '{}',
  relevance_score  float check (relevance_score between 0 and 1),
  category         text check (category in ('speaker','mentor','recruiter','investor','peer','partner')),
  suggested_ask    text,
  researched_at    timestamptz default now(),
  model_used       text
);

-- ─── CAMPAIGNS ───────────────────────────────────────────────────
create table if not exists campaigns (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references profiles(id) on delete cascade not null,
  name            text not null,
  goal            text,
  status          text default 'active' check (status in ('active','paused','completed')),
  total_contacts  int default 0,
  created_at      timestamptz default now()
);

create table if not exists campaign_contacts (
  campaign_id  uuid references campaigns(id) on delete cascade,
  contact_id   uuid references contacts(id) on delete cascade,
  added_at     timestamptz default now(),
  primary key (campaign_id, contact_id)
);

-- ─── TEMPLATES ───────────────────────────────────────────────────
create table if not exists templates (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid references profiles(id) on delete cascade not null,
  name             text,
  category         text check (category in ('speaker','mentor','recruiter','investor','peer','partner')),
  subject_template text,
  body_template    text,
  variables        text[] default '{}',
  is_active        boolean default true,
  created_at       timestamptz default now()
);

-- ─── EMAILS ──────────────────────────────────────────────────────
create table if not exists emails (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid references profiles(id) not null,
  contact_id           uuid references contacts(id) not null,
  campaign_id          uuid references campaigns(id),
  template_id          uuid references templates(id),
  subject              text,
  body                 text,
  variant_label        text check (variant_label in ('A','B','C')),
  status               text default 'draft' check (status in ('draft','scheduled','sent','failed')),
  scheduled_for        timestamptz,
  sent_at              timestamptz,
  resend_message_id    text,
  generation_metadata  jsonb,
  created_at           timestamptz default now()
);

-- ─── EMAIL EVENTS ────────────────────────────────────────────────
create table if not exists email_events (
  id           uuid primary key default gen_random_uuid(),
  email_id     uuid references emails(id) on delete cascade,
  event_type   text check (event_type in ('opened','clicked','replied','bounced','complained','delivered')),
  occurred_at  timestamptz default now(),
  metadata     jsonb
);

-- ─── CONVERSATIONS ───────────────────────────────────────────────
create table if not exists conversations (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid references profiles(id) on delete cascade not null,
  contact_id       uuid references contacts(id) not null,
  email_thread_id  text,
  status           text default 'open'
                   check (status in ('open','meeting_booked','closed_positive','closed_negative','ghosted')),
  outcome          text,
  last_message_at  timestamptz,
  meeting_at       timestamptz,
  created_at       timestamptz default now()
);

create table if not exists messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid references conversations(id) on delete cascade,
  direction        text check (direction in ('outbound','inbound')),
  subject          text,
  body             text,
  classification   text check (classification in ('positive','negative','neutral','auto_reply','bounce')),
  sent_at          timestamptz,
  created_at       timestamptz default now()
);

-- ─── FOLLOW-UPS ──────────────────────────────────────────────────
create table if not exists followups (
  id              uuid primary key default gen_random_uuid(),
  email_id        uuid references emails(id),
  contact_id      uuid references contacts(id) not null,
  scheduled_for   timestamptz,
  status          text default 'pending' check (status in ('pending','sent','skipped','cancelled')),
  body            text,
  created_at      timestamptz default now()
);

-- ─── TEMPLATE PERFORMANCE ────────────────────────────────────────
create table if not exists template_performance (
  id               uuid primary key default gen_random_uuid(),
  template_id      uuid references templates(id) on delete cascade unique,
  emails_sent      int default 0,
  opens            int default 0,
  replies          int default 0,
  positive_replies int default 0,
  meetings_booked  int default 0,
  updated_at       timestamptz default now()
);

-- ─── ROW LEVEL SECURITY ──────────────────────────────────────────
alter table profiles          enable row level security;
alter table contacts          enable row level security;
alter table contact_research  enable row level security;
alter table campaigns         enable row level security;
alter table campaign_contacts enable row level security;
alter table templates         enable row level security;
alter table emails            enable row level security;
alter table email_events      enable row level security;
alter table conversations     enable row level security;
alter table messages          enable row level security;
alter table followups         enable row level security;
alter table template_performance enable row level security;

-- Profiles
create policy "Users can view own profile" on profiles for select using (auth.uid() = id);
create policy "Users can update own profile" on profiles for update using (auth.uid() = id);

-- Contacts
create policy "Users manage own contacts" on contacts for all using (user_id = auth.uid());

-- Research (joined through contact)
create policy "Users view own research" on contact_research for select
  using (contact_id in (select id from contacts where user_id = auth.uid()));
create policy "Users insert own research" on contact_research for insert
  with check (contact_id in (select id from contacts where user_id = auth.uid()));
create policy "Users update own research" on contact_research for update
  using (contact_id in (select id from contacts where user_id = auth.uid()));

-- Campaigns
create policy "Users manage own campaigns" on campaigns for all using (user_id = auth.uid());
create policy "Users manage own campaign_contacts" on campaign_contacts for all
  using (campaign_id in (select id from campaigns where user_id = auth.uid()));

-- Templates
create policy "Users manage own templates" on templates for all using (user_id = auth.uid());

-- Emails
create policy "Users manage own emails" on emails for all using (user_id = auth.uid());

-- Email events (read through email)
create policy "Users view own email events" on email_events for select
  using (email_id in (select id from emails where user_id = auth.uid()));
create policy "Service role can insert email events" on email_events for insert
  with check (true); -- webhook inserts with service role

-- Conversations
create policy "Users manage own conversations" on conversations for all using (user_id = auth.uid());
create policy "Users manage own messages" on messages for all
  using (conversation_id in (select id from conversations where user_id = auth.uid()));

-- Followups
create policy "Users manage own followups" on followups for all
  using (contact_id in (select id from contacts where user_id = auth.uid()));

-- Template performance
create policy "Users view own template performance" on template_performance for all
  using (template_id in (select id from templates where user_id = auth.uid()));

-- ─── INDEXES ─────────────────────────────────────────────────────
create index if not exists contacts_user_id_idx on contacts (user_id);
create index if not exists contacts_status_idx on contacts (status);
create index if not exists emails_contact_id_idx on emails (contact_id);
create index if not exists emails_status_idx on emails (status);
create index if not exists email_events_email_id_idx on email_events (email_id);
create index if not exists conversations_contact_id_idx on conversations (contact_id);
