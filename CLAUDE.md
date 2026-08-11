# CLAUDE.md

Conventions for Claude Code sessions in this repository. Read this first.

---

## What this product is

Outreach OS is an **autonomous opportunity discovery and relationship-building system**.
It is not an email automation tool.

The user states a goal ("find me a high-value winter internship"). The system determines where
to search, who to contact, why they should care, what to say, and how to improve from outcomes.

**North Star: meaningful conversations with relevant decision-makers.**
Not emails sent, not leads, not open rate, not personalization volume.

**A run producing 6 excellent prospects beats one producing 60 mediocre ones.** When a change
would increase volume at the cost of selectivity, it is the wrong change.

Full definition: [docs/PRODUCT.md](docs/PRODUCT.md)

---

## Read before making changes

| Doc | When |
|---|---|
| [docs/CURRENT_STATE.md](docs/CURRENT_STATE.md) | Before touching V1 code — it explains what exists and why |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Before any structural change. 12 ADRs with reasoning. |
| [docs/PIPELINE.md](docs/PIPELINE.md) | Before touching pipeline stages |
| [docs/AGENTS.md](docs/AGENTS.md) | Before touching agents or prompts |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | Before writing a migration |
| [docs/EVALS.md](docs/EVALS.md) | Before touching quality gates |
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | To know what phase we're in and what's next |
| [docs/BUILD_LOG.md](docs/BUILD_LOG.md) | Append after any meaningful change |

**Documentation is a deliverable, not an afterthought.** The founder must be able to
understand this system without reading implementation code. If you materially change the
architecture and do not update the docs, the change is incomplete.

---

## Stack

Next.js 14 App Router · React 18 · TypeScript `strict` · Tailwind 3 · Supabase (Postgres +
Auth + RLS) · OpenAI SDK (installed **4.104.0**) · Gmail API for send and reply sync.

Windows dev environment. Both PowerShell and Bash tools are available — each takes its own
syntax.

---

## Architectural principles

Violating one of these needs a documented reason in an ADR.

### 1. Deterministic code for deterministic work

API calls, pagination, dedupe, validation, DB access, status transitions, queues, retries,
rate limiting, **score arithmetic**, and email delivery are code.

Mission interpretation, search strategy, company/role interpretation, research synthesis, fit
reasoning, positioning, writing, and qualitative outcome interpretation are agents.

**A pagination loop written as an agent is slower, more expensive, and less reliable than a
`for` loop — and it fails in ways you cannot reproduce.**

### 2. The model judges, the code computes

Agents emit **component scores** with explanations and evidence. Weighted sums, thresholds,
and ranking are pure TypeScript reading `missions.scoring_weights`.

Never let an agent emit a final overall score. ([ADR-004](docs/ARCHITECTURE.md#adr-004))

### 3. Agents are pure functions

An agent never reads or writes the database and never calls another agent. The orchestrator
loads inputs and persists outputs.

The one exception is the Research Agent, which calls a `WebResearchProvider` — that is its
entire job.

### 4. Grounding over exhortation

Never fight hallucination with prompt instructions alone. Make it structurally impossible:

- `research_facts` has a DB constraint — `type='FACT'` requires a `source_url`
- Every claim in a draft must cite a `research_facts` row; a deterministic check resolves them
- An uncitable claim is a fabrication *by construction*

V1 spent 40% of its research prompt begging the model not to make things up. That approach is
unverifiable. Do not reintroduce it. ([ADR-006](docs/ARCHITECTURE.md#adr-006),
[ADR-011](docs/ARCHITECTURE.md#adr-011))

### 5. Never dump the résumé

The Talent Knowledge Base is retrieved from, never pasted wholesale. Retrieval produces a
shortlist of **summaries**; only selected items contribute full detail.

For every prospect, answer: *which 1–3 things about this user make them unusually interesting
to THIS person?* — and record the answer.

### 6. Structured output, validated at boundaries

Every agent declares a schema. Output is validated before use. Invalid output is a retryable
failure, never something downstream code works around.

### 7. Versioned prompts

Each agent owns `prompt.ts` exporting `{ version, build(input) }`. **Bump `version` on any
semantic change.** It is recorded in `agent_runs.prompt_version` and is what makes "why did it
write this?" answerable. ([ADR-009](docs/ARCHITECTURE.md#adr-009))

### 8. Provider abstraction

Business logic depends on interfaces (`CompanyProvider`, `PeopleProvider`,
`WebResearchProvider`), never on a concrete provider. Check `isAvailable()`; an unavailable
provider is skipped, not fatal.

**The app must work fully without PitchBook.**

### 9. Failures degrade, they don't halt

One failed person does not stop a run of twenty. Retry only what retrying can fix. **Surface
failures — never hide them.** V1's `syncReplies` returns diagnostics so "0 replies" is
explainable; keep that instinct everywhere.

### 10. Nothing cold sends without a human

`autonomy_level` defaults to `approval_required` **at the schema level**. Autonomous sending
is per-campaign and never global. Do not add a code path that bypasses approval.

### 11. Never silently discard

A draft failing evals after 2 revisions still reaches the approval queue, **flagged with its
failures shown**. A pipeline that hides failures trains its operator to trust it more than it
has earned. ([ADR-010](docs/ARCHITECTURE.md#adr-010))

### 12. Preserve provenance

Research facts carry source URLs. Companies and contacts carry `*_sources` rows. Scores carry
evidence and a snapshot of the weights that produced them.

---

## Code conventions

### Models

Never hardcode a model ID. Use `lib/ai/models.ts` roles: `fast`, `reasoning`, `writing`.
(V1 has `gpt-5.4` hardcoded in 10 places — that is the debt this replaces, not a pattern.)

### Migrations

Numbered SQL in `supabase/migrations/`, **applied by hand in the Supabase SQL editor**. There
is no migration runner.

Therefore: **every migration must be idempotent** — `if not exists`, `create or replace`.
Re-running a file is the normal operating condition, since nothing tracks what has been applied.

Additive only. Never break a V1 screen.

### RLS

Every new table gets RLS. Follow the existing pattern exactly:

```sql
alter table <t> enable row level security;
create policy "Users manage own <t>" on <t> for all using (user_id = auth.uid());
```

Child tables are policed through their parent. Do not invent a new pattern.

### Secrets

All credentials from env vars, server-side only. Never `NEXT_PUBLIC_*` for a provider key.
Never commit a key. Never log a token.

### Types

Shared types in `types/index.ts`. Zod at API and agent boundaries. `strict` stays on.

### Files

Split anything past ~400 lines. `app/dashboard/campaigns/[id]/page.tsx` is 962 lines — do not
add to it; extract instead.

---

## Do not touch

The email layer works and is the hardest-won code in the repo:

`lib/email/*` · `lib/google/oauth.ts` · `lib/crypto.ts` · `middleware.ts` · RLS policies

Narrow OAuth scopes, AES-256-GCM tokens at rest, correct MIME, working threading, idempotent
reply sync with backfill. **Do not rewrite. Do not "improve."**

The only sanctioned change is the Phase 9 rename: `resend.ts` → `send.ts` and
`resend_message_id` → `rfc822_message_id`. Both names are wrong — that file sends via Gmail,
and that column holds an RFC822 Message-ID this app generates.

---

## Known traps

| Trap | Reality |
|---|---|
| `lib/email/resend.ts` | Sends via **Gmail API**. Nothing uses Resend. |
| `emails.resend_message_id` | An RFC822 Message-ID this app generates. Never a Resend ID. |
| `app/api/webhooks/resend/` | **Dead.** Its verifier returns `false` unconditionally. Delete in Phase 10. |
| `email_events`, `template_performance`, `followups` | Never written to. Drop in Phase 10. |
| `nodemailer` | Used only as `MailComposer`, a MIME builder. No SMTP. |
| `react-hot-toast` | A dependency that is never imported. Feedback uses inline divs and `alert()`. |
| `tailwind.config.ts` `brand` colors | Defined, never used. Pages hardcode `indigo-600`. |
| `package.json` says `openai@^4.52.0` | **4.104.0** is installed, and it has the Responses API + `web_search`. |
| `/api/research/rerun` | **Deletes all research** with no server-side confirmation. |
| ⚠ `Apollo API.txt` | A credential-shaped string tracked in git. See [CURRENT_STATE.md §9](docs/CURRENT_STATE.md#9-configuration). |

---

## Working style

1. **Inspect before rewriting.** V1 has real, working functionality. Understand why code
   exists before replacing it.
2. **Small phases, working state.** The founder must be able to use the app throughout the
   migration. Never leave the repo broken between phases.
3. **Challenge unnecessary complexity.** If a simpler design works, say so. Several spec
   entities were deliberately collapsed — see [ADR-003](docs/ARCHITECTURE.md#adr-003) and
   [ADR-012](docs/ARCHITECTURE.md#adr-012).
4. **Do not build things because they sound agentic.** Seven agents map to seven judgment
   problems. Adding an eighth requires a judgment problem none of them owns.
5. **Explain product and architecture choices in plain English.** Implementation details with
   an obvious good answer — just make the call.
6. **Run `npx tsc --noEmit` after changes.** It passes today; keep it that way.
7. **Append to `docs/BUILD_LOG.md`** after any meaningful change.

---

## Runtime AI vs. Claude Code

Two different things. Do not blur them.

| | Runtime AI | Claude Code |
|---|---|---|
| Lives in | `lib/agents/` | `.claude/` |
| Runs | In production, for users | During development, for engineers |
| Defined by | TypeScript + versioned prompts | Markdown |
| Traced in | `agent_runs` | Session transcripts |

`.claude/agents/` may hold development-time helpers. It must **never** contain product agents.
The seven product agents are TypeScript modules, not Claude Code subagents.

---

## Current phase

**Phase 0 complete** — audit, architecture docs, and type-only scaffolding.

**Next: Phase 1** — missions and preferences. Phases 1, 2, and 3 are independent; any order
works. Everything from Phase 4 on is sequential.

See [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md).
