# Outreach OS — Setup Guide

> AI-powered relationship outreach for Founders: Illinois Entrepreneurs
> Personalized cold email at scale — for YC founders, SF operators, mentors, investors.

---

## Prerequisites

- Node.js 18+ (`node -v` to check)
- A Supabase account (free): https://supabase.com
- Your OpenAI API key: https://platform.openai.com/api-keys
- Your Resend account + API key: https://resend.com

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

5. Go to **SQL Editor** in Supabase, paste the entire contents of
   `supabase/migrations/001_initial.sql` and click **Run**

   This creates all tables, RLS policies, and indexes.

---

## Step 3 — Resend Setup

1. Go to https://resend.com and create an account
2. Add and verify a sending domain (even a subdomain works: `mail.yourdomain.com`)
   - If you don't have a domain yet, use Resend's test mode (emails only go to your own address)
3. Go to **API Keys** → Create key → copy it
4. (Optional) Go to **Webhooks** → Add endpoint:
   - URL: `https://your-app.vercel.app/api/webhooks/resend`
   - Events: `email.delivered`, `email.opened`, `email.bounced`
   - Copy the signing secret

---

## Step 4 — Environment Variables

```bash
cp .env.local.example .env.local
```

Edit `.env.local` and fill in all values:

```env
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...

OPENAI_API_KEY=sk-...

RESEND_API_KEY=re_...
FROM_EMAIL=outreach@yourdomain.com
FROM_NAME=Founders Illinois Entrepreneurs
RESEND_WEBHOOK_SECRET=whsec_...   # optional, for reply tracking

NEXT_PUBLIC_APP_URL=http://localhost:3000
```

---

## Step 5 — Run Locally

```bash
npm run dev
```

Open http://localhost:3000

1. Create an account (signup)
2. You'll land on the Dashboard
3. Click **Add Contact** → add a YC founder or SF operator
4. Open their contact page → click **Run AI Research**
5. Go to **Compose** → select them → pick a goal → **Generate AI Email Variants**
6. Pick a variant, edit it, hit **Send**

---

## Step 6 — Deploy to Vercel

```bash
npm install -g vercel
vercel
```

Or connect your GitHub repo at https://vercel.com/new

**Add environment variables** in Vercel dashboard:
- Settings → Environment Variables → paste all values from `.env.local`

Update `NEXT_PUBLIC_APP_URL` to your Vercel URL.

---

## How to Use — Workflow

### For YC Founder / Speaker Outreach
1. Add contact: name + company + LinkedIn URL
2. Research: click "Run AI Research" — GPT-4o uses its knowledge of the person
   - OR paste their LinkedIn "About" section for better results
3. Review research card: summary, talking points, shared context
4. Compose → Goal: "Speaker / Event" → Generate
5. Pick best variant, edit if needed, send
6. Track replies in Conversations tab

### For Mentor Program
Same flow, Goal: "Mentor / Advisor"

### For Internship Pipeline
Same flow, Goal: "Internship / Jobs"
Add custom note: "We have 3 senior engineers and 2 PMs to introduce"

### For Investor Introductions
Same flow, Goal: "Investor Intro"
Add custom note: describe the student startup briefly

---

## Key Features

| Feature | How to use |
|---------|-----------|
| AI Research | Contact page → "Run AI Research" |
| Paste LinkedIn bio | Research card → 📋 icon → paste text |
| Generate 3 email variants | Compose → select contact + goal → Generate |
| Edit before sending | Compose → click any variant → edit inline |
| Track emails | Conversations tab (once Resend webhook is set up) |
| Group by goal | Campaigns tab → create a campaign |

---

## Customizing Sender Context

The AI is pre-loaded with context about Illinois Entrepreneurs. To update this, edit:

```
lib/ai/research.ts  — CLUB_CONTEXT variable (lines 7–14)
lib/ai/personalize.ts — SYSTEM_PROMPT (update club details)
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 14 App Router |
| Database | Supabase (PostgreSQL + RLS) |
| Auth | Supabase Auth |
| AI Research | OpenAI GPT-4o |
| AI Generation | OpenAI GPT-4o |
| AI Classification | OpenAI GPT-4o-mini |
| Email Sending | Resend |
| Deployment | Vercel |

---

## Adding Features Later

- **Trigger.dev background jobs**: For automated follow-up scheduling
- **LinkedIn scraping**: Integrate Firecrawl (`npm install @mendable/firecrawl-js`) in `lib/ai/research.ts`
- **CRM sync**: Add Notion or HubSpot API calls in `app/api/send/route.ts`
- **Analytics dashboard**: Query `template_performance` and `email_events` tables
- **CSV import**: Build a file upload in `app/(dashboard)/contacts/import/page.tsx`
