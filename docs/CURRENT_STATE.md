# Current State — Outreach OS V1

> Audit date: 2026-08-10 · Commit: `e1269f5` · Status: working, deployed-shaped, typechecks clean

This document describes how Outreach OS works **today**, before the V2 agentic redesign.
It is a factual audit, not a proposal. For where we're going, see [PRODUCT.md](PRODUCT.md)
and [ARCHITECTURE.md](ARCHITECTURE.md).

---

## 1. What V1 actually is

A **single-user, manual-input cold email tool** for a university entrepreneurship club.

The operating loop is:

```
Human finds a person  →  pastes their LinkedIn URL
   →  Apollo enriches name/title/company/email
   →  GPT writes a research summary from memory
   →  GPT writes 3 email variants (or fills a template)
   →  Human reviews in a drafts queue
   →  Sends from the user's own Gmail
   →  Gmail polling pulls replies back into Conversations
```

Every step after "human finds a person" is automated. **Finding the person is not.**
That is the defining limitation of V1 and the reason for the V2 redesign.

---

## 2. Technology stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | Next.js 14.2.35, App Router | React 18, TypeScript `strict: true` |
| Styling | Tailwind 3.4 | No component library — see §8 |
| Database | Supabase Postgres | 12 tables, RLS on all of them |
| Auth | Supabase Auth (email + password) | Guarded in `middleware.ts` |
| AI | OpenAI SDK (installed **4.104.0**) | `chat.completions` + JSON mode only |
| Outbound mail | **Gmail API**, per-user OAuth2 | `users.messages.send` |
| Inbound mail | **Gmail API polling**, `gmail.readonly` | Not a webhook |
| MIME | `nodemailer`'s `MailComposer` | Used as a builder only — no SMTP |
| Contact data | Apollo `v1/people/match` | Enrichment only, no search |
| PDF | `pdfjs-dist` | Client-side résumé text extraction |
| Tests | **None** | No test runner, no test files |
| Deploy | Vercel-shaped | `maxDuration` used; no `vercel.json`, no cron |

**Important naming trap:** `lib/email/resend.ts` does **not** use Resend. It sends via the
Gmail API. The name is a leftover. Likewise `emails.resend_message_id` stores an
**RFC822 Message-ID** that this app generates itself — never a Resend ID.

---

## 3. Directory structure

```
app/
  (auth)/login/           Combined sign-in / sign-up
  api/                    18 route handlers (see §5)
  dashboard/              8 screens (see §8)
components/
  contacts/               AddContactModal, EditContactButton, AddToCampaignButton, ResearchCard
  editor/                 RichTextEditor — the only genuinely shared primitive
  layout/                 Sidebar
  settings/               GmailConnection
lib/
  ai/                     6 prompt modules — research, personalize, fill-template,
                          classify, suggest-reply, campaign-feedback
  email/                  resend.ts (Gmail send), sync.ts (reply poll), gmail.ts (parsing),
                          conversation.ts, format.ts, accounts.ts
  google/oauth.ts         OAuth flow, token minting, revoke
  supabase/               server.ts (SSR + service-role clients), queries.ts, client.ts
  crypto.ts               AES-256-GCM for refresh tokens at rest
  utils.ts                cn(), time formatting, status/category color maps
supabase/migrations/      001–007, applied manually via the Supabase SQL editor
types/index.ts            All shared types + the EMAIL_STYLES catalog
```

---

## 4. Database

Twelve tables, all with RLS enabled. `contacts` is the hub — nearly everything hangs off it.

```
profiles ──┬── contacts ──┬── contact_research   (1:1)
           │              ├── emails ──── email_events
           │              ├── conversations ──── messages
           │              ├── campaign_contacts
           │              └── followups
           ├── campaigns
           ├── templates ──── template_performance
           └── email_accounts
```

### Live tables

- **`profiles`** — one row per user, auto-created by an `on_auth_user_created` trigger.
  Carries the user's identity *and* their entire self-description as free text:
  `bio`, `linkedin_bio_text`, `resume_text`, `personal_context`, `target_roles`,
  `supplementary_materials`, `portfolio_url`, `major`, `graduation_year`.
- **`contacts`** — the person. `company` and `role` are **plain text**, not references.
  Unique index on `(user_id, linkedin_url)` prevents duplicate imports.
  Status enum: `new → researching → researched → drafted → sent → replied → meeting → archived`.
- **`contact_research`** — 1:1 with contact. Holds `summary`, `hooks[]`, `shared_context[]`,
  a single `relevance_score` float (0–1), a one-sentence `fit_reason`, a `category`
  (`speaker|mentor|recruiter|investor|peer|partner`), and `suggested_ask`.
- **`emails`** — drafts and sent mail. `generation_metadata` jsonb is the only AI trace.
  `reply_to_email_id` self-reference enables threaded follow-ups.
  `gmail_thread_id` links a send to its Gmail thread for reply polling.
- **`campaigns`** + **`campaign_contacts`** — a named grouping of contacts with a goal string.
- **`templates`** — user-authored email skeletons with `[bracket instructions]` that the AI fills.
  `type` is `initial` or `followup`.
- **`conversations`** + **`messages`** — reply threads, populated by the Gmail sync.
- **`email_accounts`** — the connected Gmail. `refresh_token` is AES-256-GCM encrypted.
  RLS is enabled with **no policies on purpose**: only the service-role client touches it.

### Dead or unused tables

- **`email_events`** — only the Resend webhook writes here. That webhook is dead (§6).
  Open/click tracking does not work with the Gmail send path.
- **`template_performance`** — nothing writes to it. Zero rows in practice.
- **`followups`** — table exists; the shipped follow-up flow uses `emails.reply_to_email_id`
  instead. Effectively unused.

---

## 5. API surface

| Route | Purpose | Notes |
|---|---|---|
| `POST /api/enrich` | Apollo `people/match` by LinkedIn URL | The **only** Apollo usage |
| `POST /api/research` | Research one contact | Writes `contact_research` |
| `POST /api/research/batch` | Research every `status='new'` contact | Sequential loop, `maxDuration=300` |
| `POST /api/research/rerun` | **Deletes all research**, resets statuses to `new` | Destructive, no confirmation server-side |
| `POST /api/generate` | 3 variants, or fill a template, for one contact | |
| `POST /api/generate-multi` | Same, for a list of contacts | Sequential loop |
| `POST /api/campaigns/[id]/generate` | Same, scoped to campaign members | Sequential loop, `maxDuration=300` |
| `POST /api/campaigns/[id]/feedback` | LLM critique of a campaign's sent mail | |
| `POST /api/send` | Send one email via Gmail | 500/day cap |
| `POST /api/conversations/sync` | Poll Gmail for replies | |
| `GET /api/conversations/[id]/thread` | Live Gmail thread | |
| `POST /api/conversations/[id]/suggest` | AI-drafted reply | |
| `POST /api/conversations/[id]/reply` | Send a threaded reply | |
| `/api/google/{connect,callback,status,disconnect}` | Gmail OAuth lifecycle | |
| `/api/templates`, `/api/templates/[id]` | Template CRUD | |
| `/api/contacts/[id]` | Update / delete a contact | |
| `POST /api/webhooks/resend` | **Dead** | See §6 |

---

## 6. Email: what works and what doesn't

### Sending — solid, keep it

`lib/email/resend.ts` builds a full MIME message with `MailComposer`, base64url-encodes it,
and POSTs to `gmail.googleapis.com/.../messages/send` with the user's OAuth access token.
It deliberately avoids SMTP so it can use the narrow `gmail.send` scope rather than full
mailbox access. It sets its own `Message-ID` so follow-ups can thread via `In-Reply-To` /
`References`, and stores Gmail's returned `threadId`.

This is the most carefully built code in the repo. **V2 should not touch it.**

### Reply tracking — solid, keep it

`lib/email/sync.ts` polls. For every sent email it re-fetches the Gmail thread, filters to
messages not from the user, and imports new ones. Idempotency comes from a unique index on
`messages.provider_message_id`. It also backfills missing `gmail_thread_id` values via Gmail
search (`rfc822msgid:` first, then `to:<contact email>`). Each imported reply is classified
by an LLM, which then updates conversation and contact status.

### The Resend webhook — dead code

`app/api/webhooks/resend/route.ts` still exists and still parses Resend events, but:

- `RESEND_API_KEY` / `RESEND_WEBHOOK_SECRET` are **not** in `.env.local`.
- `verifyWebhookSignature()` is a stub that **returns `false` unconditionally** — so if a
  secret were ever configured, every request would be rejected as invalid.
- Nothing sends via Resend, so no Resend event can ever arrive.

It is unreachable in practice. Delete it in V2.

**Consequence:** open and click tracking do not exist. `email_events` never fills.
Any "open rate" in the product is structurally unavailable — which is fine, because the
V2 North Star deliberately rejects open rate as a metric.

---

## 7. AI layer

Six prompt modules, all using `chat.completions` with `response_format: json_object`.

| Module | Temp | Job |
|---|---|---|
| `research.ts` | 0.1 | Summary + hooks + relevance score + category + ask |
| `personalize.ts` | 0.8 | 3 email variants (accomplishment / shared-context / value-prop hooks) |
| `fill-template.ts` | 0.7 | Replace `[bracket instructions]` in a user template |
| `classify.ts` | 0.1 | Classify an inbound reply |
| `suggest-reply.ts` | 0.7 | Draft the next turn in a live thread |
| `campaign-feedback.ts` | 0.6 | Critique a campaign's sent mail against its reply rate |

### Findings

1. **Research is ungrounded.** `researchContact()` performs no retrieval. It asks the model
   what it remembers about a named person. The prompt compensates with a large
   "ANTI-HALLUCINATION RULES — NON-NEGOTIABLE" block. That block is a symptom: roughly 40%
   of the system prompt is spent telling the model not to make things up, because there is
   no source of truth to check against. There is **no `web_search` capability wired up
   anywhere in the codebase**, despite the installed SDK supporting it.

2. **The résumé is dumped wholesale.** `personalize.ts` and `fill-template.ts` both slice
   `resume_text` to 2000 chars and `linkedin_bio_text` to 1500 and paste them into every
   prompt, with an instruction to "pick the most relevant 1–2 facts." Selection is left to
   the model, inside the same call that also has to write the email. There is no retrieval
   step and no record of which facts were chosen or why.

3. **Scoring is one opaque number.** `relevance_score` is a single float the model emits
   directly, with tier definitions expressed in prose in the prompt. There are no component
   scores, no configurable weights, and no way to re-rank without re-running the model.

4. **Model ID is hardcoded in 10 places.** `gpt-5.4` appears in all six AI modules and in
   four route handlers. There is no central model configuration.

5. **No agent-run trace.** The only record is `emails.generation_metadata`, and it is
   partially fabricated — `campaigns/[id]/generate` writes `hook_type: 'accomplishment'`
   and `hooks_used: []` regardless of what actually happened. You cannot currently answer
   "why did it write this email this way?"

6. **No evals.** Nothing checks a draft before it reaches the human.

7. **Club identity is hardcoded in the prompts.** "Founders: Illinois Entrepreneurs" and
   UIUC appear in `research.ts`, `personalize.ts`, `suggest-reply.ts`, and
   `campaign-feedback.ts` as literal system-prompt text, plus in campaign presets, UI copy,
   and two of the ten email styles.

---

## 8. UI

Eight dashboard screens behind a fixed 240px sidebar: Dashboard, Contacts, Templates,
Compose, Draft Emails, Campaigns, My Profile, Conversations.

**Reusable today:**
- `RichTextEditor` — a textarea with a markdown-ish toolbar and a live preview that uses the
  *same* renderer as the send path (`lib/email/format.ts`). Genuinely good, reuse it.
- `AddContactModal` — 3 import modes (single LinkedIn, bulk LinkedIn paste, manual).
- `lib/utils.ts` — `cn()`, relative time, status/category color maps.
- **`/dashboard/drafts` is already an approval queue.** Expandable inline edit, per-item
  send/discard, multi-select, "Approve All". V2's approval stage should extend this screen
  rather than build a new one.

**Not reusable / debt:**
- **No design system.** No `components/ui/`. Card, modal shell, spinner, stat card, empty
  state, and status pill are copy-pasted across pages — the spinner SVG appears ~10 times,
  and the stat-card grid is duplicated verbatim between the dashboard and campaign detail.
- `tailwind.config.ts` defines a `brand` color scale that **nothing uses**; pages hardcode
  `indigo-600`.
- `react-hot-toast` is a dependency but is **never imported**. Feedback uses inline divs,
  native `alert()`, and `confirm()`.
- `app/dashboard/campaigns/[id]/page.tsx` is 962 lines — the largest file in the repo.
- `GOAL_OPTIONS` and `COMMON_TAGS` are each duplicated verbatim in two files;
  conversation `STATUS_COLORS` is duplicated in two more.

---

## 9. Configuration

`.env.local` currently holds: Supabase URL / anon key / service-role key, `OPENAI_API_KEY`,
`APOLLO_API_KEY`, the four Google OAuth values, `EMAIL_TOKEN_ENCRYPTION_KEY`,
`NEXT_PUBLIC_APP_URL`, plus two dead leftovers (`GMAIL_USER`, `GMAIL_APP_PASSWORD` from the
pre-OAuth SMTP era).

`.env.local.example` is **out of date**: it still documents `RESEND_API_KEY`, `FROM_EMAIL`,
and `RESEND_WEBHOOK_SECRET`, none of which are used, and omits `APOLLO_API_KEY`, which is.

### ⚠ Security finding — committed credential

`Apollo API.txt` is a 22-byte file, **tracked in git**, containing a single bare token string.
It does not match the `APOLLO_API_KEY` currently in `.env.local`, so it is most likely a
superseded key — but a credential-shaped secret is in the repository history either way.

**Recommended action (needs your decision, not done automatically):**
1. Rotate that key in the Apollo dashboard, regardless of whether it is still live.
2. `git rm --cached "Apollo API.txt"` and add it to `.gitignore`.
3. Removing it from *history* requires a rewrite (`git filter-repo`) and a force-push.
   If this repo has ever been pushed to a remote or shared, do the rewrite. If it has only
   ever been local and private, rotating the key is sufficient.

`.gitignore` correctly covers `.env*` files. This is an isolated slip, not a pattern.

---

## 10. Technical debt relevant to the V2 redesign

Ordered by how much it blocks the new architecture.

| # | Debt | Why it blocks V2 |
|---|---|---|
| 1 | **No company entity** — `contacts.company` is text | V2's pipeline is company-first: discover companies → rank → find people inside them. There is nowhere to attach company research, company scores, or a dedupe key. |
| 2 | **No discovery** — contacts arrive one LinkedIn URL at a time | The entire top half of the V2 pipeline does not exist. Apollo is integrated for *enrichment* only; `organizations/search` and `people/search` are unused. |
| 3 | **Long work runs inline in HTTP handlers** | `maxDuration = 300` plus sequential OpenAI loops. This already caused a shipped bug (`f6e4bb7` "prevent campaign-generate timeout truncation"). V2 does strictly more work per run. |
| 4 | **Research is ungrounded and sourceless** | V2 requires FACT / INFERENCE / UNKNOWN with provenance. Nothing today can produce that. |
| 5 | **Talent context is 6 free-text blobs on `profiles`** | V2 requires selective retrieval of 1–3 proof points, and a record of which were used. |
| 6 | **Scoring is one opaque float** | V2 requires component scores, per-mission weights, evidence, and confidence. |
| 7 | **No agent-run observability** | "Why this person? Why this email?" is unanswerable today. |
| 8 | **Goals are a 5-value enum; club identity is hardcoded in prompts** | V2 needs a generalized Mission system. |
| 9 | **Dead Resend surface** — route, `email_events`, stub verifier that returns `false` | Confusing; the misleading `resend.ts` / `resend_message_id` names actively mislead readers. |
| 10 | **No tests, no eval harness** | V2 gates outbound mail on evaluation. Needs a runner. |
| 11 | **No design system**; 962-line page; duplicated constants | Slows every new screen. Not blocking, but compounding. |

---

## 11. What V1 got right — preserve these

Not everything needs replacing. These are load-bearing and well built:

1. **Gmail OAuth send path** — narrow scopes, encrypted refresh tokens, correct MIME,
   working threading. Do not rewrite.
2. **Reply sync** — idempotent, with thoughtful backfill for historical mail.
3. **Secret handling** — AES-256-GCM at rest, service-role-only access, no policies on
   `email_accounts` by design.
4. **RLS everywhere** — the multi-tenant story is already correct.
5. **The drafts approval queue** — the human-in-the-loop UX already exists and works.
6. **Anti-hallucination instincts** — the prompts already try hard to avoid fabrication.
   V2 replaces prompt-based defense with grounding, but the instinct was right.
7. **Structured AI output** — every call already uses JSON mode with a defined shape.
8. **Clean typecheck** — `tsc --noEmit` passes with `strict: true`.

---

## 12. Baseline verification

```
npx tsc --noEmit     → exit 0, no errors
git status           → 1 modified file (middleware.ts, uncommitted improvement)
```

The uncommitted `middleware.ts` change excludes `/api` from the auth matcher and adds a 5s
timeout race on `getUser()`. It is an improvement; leave it.
