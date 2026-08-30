# Outreach OS — Setup Guide

> Finds the right people and the right internships, researches, drafts and tracks; you approve.
> Nothing is sent or submitted without you. How to use it day to day:
> [docs/HOW_TO_USE_OUTREACH_OS.md](docs/HOW_TO_USE_OUTREACH_OS.md).

---

## Prerequisites

- Node.js 18+ (`node -v` to check)
- A Supabase account (free): https://supabase.com
- An OpenAI API key: https://platform.openai.com/api-keys
- An Anthropic API key (Career OS agents): https://console.anthropic.com
- A Google Cloud OAuth client (Gmail sending and reply sync — Step 3)
- An Apollo API key (contact enrichment): https://app.apollo.io

---

## Step 1 — Clone & Install

```bash
cd outreach-os
npm install
```

---

## Step 2 — Supabase Setup (5 minutes)

1. Go to https://supabase.com and create a new project
2. Name it `outreach-os`, pick a strong password, choose a region (US East is fine)
3. Wait ~2 min for it to spin up
4. Go to **Settings → API** and copy:
   - `Project URL` → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon public` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY`

5. Go to **SQL Editor** and run every file in `supabase/migrations/` in numeric order
   (`001_initial.sql` through `015_evidence_canonical.sql`). Each file is idempotent, so
   re-running one is harmless. Run `npm run check:sql` first if you have edited a migration.

   This creates all tables, RLS policies, indexes and the private `career-docs` storage bucket.

---

## Step 3 — Google OAuth (Gmail)

The app sends from **your own Gmail** and reads replies from it. There is no third-party mail
service.

1. At https://console.cloud.google.com/apis/credentials create an OAuth 2.0 **Web application**
   client. Enable the Gmail API for the project.
2. Consent screen scopes: `openid`, `email`, `gmail.send`, `gmail.readonly`. Add yourself as a
   test user (Testing mode is fine for personal use).
3. Authorized redirect URIs: `http://localhost:3000/api/google/callback` and, later, your
   production URL with the same path.
4. Copy the client ID and secret into `.env.local` (Step 4). After the app is running, open
   **Profile & Settings** and click **Connect Gmail**.

---

## Step 4 — Environment Variables

```bash
cp .env.local.example .env.local
```

Edit `.env.local` and fill in the values (`.env.local.example` explains each one):

```env
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...

OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
APOLLO_API_KEY=...

GOOGLE_CLIENT_ID=....apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://localhost:3000/api/google/callback
EMAIL_TOKEN_ENCRYPTION_KEY=...   # base64 32-byte key; see .env.local.example

NEXT_PUBLIC_APP_URL=http://localhost:3000

CAREER_MASTER_RESUME_PATH=./Zuyu_Resume.docx
CAREER_OUTPUT_DIR=./.career-out
CRON_SECRET=change-me
# CAREER_USER_ID=   optional; only needed with more than one profile in the database
```

---

## Step 5 — Run Locally

```bash
npm run dev
```

Open http://localhost:3000

1. Create an account (signup)
2. Open **Profile & Settings** → **Connect Gmail**
3. Go to **Scout**, describe who you want to reach, and run it
4. Review the drafts on **Outreach**; approve and send the ones you like
5. Replies arrive on **Conversations** (sync from Gmail)

---

## Step 6 — Deploy to Vercel

```bash
npm install -g vercel
vercel
```

Or connect your GitHub repo at https://vercel.com/new

**Add environment variables** in Vercel dashboard:
- Settings → Environment Variables → paste all values from `.env.local`

Update `NEXT_PUBLIC_APP_URL` and `GOOGLE_REDIRECT_URI` to your Vercel URL, and add that
redirect URI to the Google OAuth client.

---

## Step 7 — Career OS (Summer 2027 job search)

1. Migrations 014 and 015 are part of Step 2. If you skipped them, run them now.
2. Put your master résumé at `./Zuyu_Resume.docx` (untracked — it is gitignored). Set
   `ANTHROPIC_API_KEY`; optionally `CAREER_MASTER_RESUME_PATH`, `CAREER_OUTPUT_DIR`, `CRON_SECRET`
   (see `.env.local.example`).
3. `npm run career:seed -- --approve` — stores the master, builds the Evidence Bank from it, seeds
   preferences and the default mission. Open `/dashboard/evidence` to inspect and edit.
4. `/dashboard/jobs` → **Scout now** (bounded to the 300 s web ceiling), or `npm run career:scout`
   for a deeper run from the terminal. `/dashboard/jobs/mission` edits tiers, company types and
   fit weights; weight edits re-rank instantly.
5. Open a job → **Generate Package** → review the résumé diff (every change shows its evidence and
   verifier verdict; rejected changes keep the original) → approve → download
   `Zuyu_Liu_<Company>_Resume.pdf` and `Zuyu_Liu_<Company>_Cover_Letter.pdf` → apply through the
   posting → **I applied**. PDF rendering uses Microsoft Word on Windows (or LibreOffice); without
   either you get the DOCX and QA says so.
6. `npm run career:verify` (or the daily cron at `/api/career/cron/verify` with `CRON_SECRET`)
   re-checks saved and tracked postings and closes ones that disappeared before you applied.

The full command list is in [README.md](README.md#founder-commands).

---

## Key Features

| Feature | How to use |
|---------|-----------|
| Find people for a goal | Scout → describe the goal → ranked prospects with why-them / why-me |
| Send Scout's drafts | Outreach → edit, approve, send (one click each; nothing auto-sends) |
| Track replies | Conversations (pulled from Gmail; sync also updates Outreach) |
| Email someone you already have | Contacts → Compose → template fill or three AI variants |
| Make Scout sound like you | Campaigns → paste a reference email → pick it on Scout |
| Find internships | Jobs → Scout now |
| Build a résumé + cover letter | Job → Package tab → Generate package |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 14 App Router |
| Database | Supabase (PostgreSQL + RLS) |
| Auth | Supabase Auth |
| Outreach agents | OpenAI (roles in `lib/ai/models.ts`) |
| Career OS agents | Anthropic |
| Contact enrichment | Apollo |
| Email sending and reply sync | Gmail API, per-user OAuth2 |
| Deployment | Vercel |
