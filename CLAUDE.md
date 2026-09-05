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
| [docs/PHASE_NETWORK_AND_REFERENCE.md](docs/PHASE_NETWORK_AND_REFERENCE.md) | Before touching internal retrieval or the campaign reference flow |
| [docs/CAREER_OS.md](docs/CAREER_OS.md) | Before touching anything under `lib/career/`, the Career OS agents, `app/dashboard/{jobs,applications,companies,evidence}` or `app/api/career/` |
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

**Run `npm run check:sql` before handing a migration to the founder.** Because migrations are
applied by hand, the first thing that ever parses one is otherwise their production database,
and the feedback loop for a missing comma is a person pasting SQL and reading an error code.
This parses every file with PostgreSQL's own parser (libpg-query, compiled to wasm).

It parses **function bodies separately**, and that is the part that matters. To the outer
parser a `$$ … $$` body is just a string literal, so the outer parse of a broken function
passes — while Postgres, which validates bodies at `CREATE` time, rejects it. Migration 013
shipped a missing comma between two CTEs *inside* a function body for exactly that reason.

It is syntax only. A clean run means "Postgres will parse this", not "Postgres will accept
this" — it knows nothing about whether a table exists, a type matches, or a function is
`IMMUTABLE` enough for a generated column.

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
| `email_events`, `template_performance`, `followups` | Never written to. Drop in Phase 10. |
| `nodemailer` | Used only as `MailComposer`, a MIME builder. No SMTP. |
| `tailwind.config.ts` `brand` colors | Defined, never used. Pages hardcode `indigo-600`. |
| `package.json` says `openai@^4.52.0` | **4.104.0** is installed, and it has the Responses API + `web_search`. |
| `/api/research/rerun` | **Deletes all research** with no server-side confirmation. |
| A truncated stem before `\b` in a regex | `\bmanufactur\b` cannot match "Manufacturing" — the `i` is a word character. This silently sent every inflected title to `unknown` in `lib/network/normalize.ts`. Write `manufactur\w*`. |
| A scouting run that "hangs" | Read its row: `status`, `error_code`, `error_detail`, `invocation_count`, `lease_expires_at`, the last `progress.events`. Every read of a run (`GET /api/scout/runs/[id]`, `/api/career/scout/runs/[id]`) reaps a lapsed lease and dispatches a handed-back leg, so "open the page" IS the recovery. Never edit the row by hand. |
| `platformWaitUntil()` in `lib/career/scout/background.ts` | An optimisation, not a guarantee. The worker executes INSIDE its POST and never depends on it; only a best-effort late dispatch write does. Do not build a code path that needs it. |
| A worker write without `workerId` | Fenced writes (`recordProgress`, `touchScoutRun`, `recordRunCursor/Checkpoint/Result`, `finishScoutRun`) take the leg's `workerId`. Without it the guard is status-only, and a leg the platform froze can write over the leg that replaced it. The CLI's own runs may omit it; a worker leg never. |
| `handoffScoutRun` and `queued_at` | The handoff re-stamps `queued_at`, `attempt_count` and `heartbeat_at` in the same statement as the checkpoint. The watchdog judges a queued leg from `queued_at`; a handoff that forgot it would be failed as "unstarted" by the very next poll. |
| `startScoutingRun` without `kind` | The column default is `'outreach'`, so an inline package or verify row inserted without its kind is, for a moment, a running People Scout. Pass `kind` in the INSERT (`startCareerRun` does). |
| `result` / `checkpoint` on `scouting_runs` | Tens of kilobytes. `getRun(..., { full: true })` selects them; the poll and `listRuns` never do. Keep them out of `COLUMNS` in `run-store-db.ts` — and never decide anything from `row.result` on a listed row (the reaper once closed a People Scout with prospects as `failed` that way; it re-reads the candidate in full). |
| An agent failure that was really the clock | `AgentResult.errorCode` says RUN_DEADLINE / CANCELLED when the run, not the model, stopped a call. A stage that records such a failure as "this item is broken" completes with the item silently missing (live run 1 did: 14 of 16 scored, status `succeeded`). Use `isClockOutcome(run)` from `lib/runs/errors.ts`, leave the item for the next leg, and stop the leg as `deadline`. Never match the sentence. |
| A Job Scout lane that started and was cut | `pastDeadline` only knows a stage it refused to START. A lane that ran and stopped on its share of the clock (sweep, company-first, extraction) reports `deadlineHit` itself and the orchestrator's `leftOpen` list makes the run a deadline hit; without that, the live BROAD run was closed `succeeded` with 298 companies unswept and never got its second pass. A new lane must report the same. |
| A chained leg's age | A handed-back leg that a sweep has dispatched is aged from `last_dispatch_at`, not `queued_at` (the handoff instant, which can be minutes old if the previous worker died before its self-dispatch). Judged from `queued_at`, the next sweep would fail the leg as `no_worker` while its dispatch was still landing. `queueVerdict` in `queue-health.ts` owns this. |
| The Anthropic / Apollo deadline | There is no module-level deadline slot any more. Provider clients size each attempt from the ambient run context (`lib/runs/context.ts`); code that runs outside `withRunContext` gets the provider ceiling and the process-wide usage object. Wrap a new orchestrator in a context; do not add a global. |
| "after 2 attempts over 181s" on a failed run | A pre-021 sentence: the fail-fast branch used a synthetic clock and dropped the dispatch's real error. Rows written now carry `error_code` and the worker's actual answer in `last_error` / `error_detail`. |
| A third Vercel cron | The Hobby plan allows two. The scout watchdog runs inside the existing daily `sweep` and `verify` crons and on every read; do not add a schedule. |
| SQL inside `$$ … $$` | Invisible to a parser reading the outer file, and validated by Postgres at `CREATE` time. `npm run check:sql` parses bodies separately for this reason. |
| An agent that "hangs" | Usually `stop_reason: max_tokens` on `submit_result`. The output is truncated mid-JSON, validation fails, and the loop used to escalate a tier — which writes *more* and truncates again, at 5× the price. `runtime/loop.ts` now handles truncation separately. Check `onStep` before assuming a hang. |
| `resume_bullets.text` | Markdown with `**bold**` markers. The document engine renders them as bold runs; the verifier and QA see them stripped. Store nothing else in it. |
| A pending résumé change | Is NOT in the document. Only `review_status` approved/edited changes reach `applyResumePatch`; a `SUPPORTED` verdict alone does nothing. |
| `evidence_fact_ids` on a change | May contain **metric** ids as well as fact ids (a bold-the-number change cites the metric). Resolve against both tables. |
| A `VERIFIED_OPEN` job | Was listed by an ATS API *at `last_verified_at`*. It is a timestamped status, not a promise; `npm run career:verify` and the cron re-check it. |
| PDF rendering | Word via COM on this machine, LibreOffice when installed, otherwise DOCX only with QA saying so. There is no HTML-to-PDF fallback, deliberately (ADR-033). |
| `applications.locked` | Set on APPLIED. Submitted documents are never overwritten; a new package is a new version under a new storage path. |
| `evals/phase3/user-profile.ts` `RESUME_ITEMS` | A **fallback fixture**, used by the outreach loop only when the Evidence Bank is empty. Scout, positioning and the reply routes read the bank through `lib/outreach/background.ts`. Do not add to it. |
| `loadEvidenceBank(...).canonical` | `true` = migration 015 tables exist. It is not `migrationMissing` (which is about 014). A 014-only database returns `canonical: false` and empty 015 arrays, never an error. |
| A `status = 'merged'` evidence row | A tombstone, kept so provenance and snapshots resolve. The loader filters them; a raw query must too. Never delete one — restore from `evidence_snapshots` instead. |
| A fact with a source at confidence 0.5 | That source restated the *event* without the numbers. It corroborates the claim, not the metric; `support_count` ignores it. |
| A CLI without `--user` | The founder's database has **two** profiles. `scripts/lib/cli-user.ts` uses `--user`, then `CAREER_USER_ID`, then the only profile, else it lists the profiles and stops. It used to take `profiles … limit(1)` — the first row in arbitrary order — and once ran a job scout under the other account. |
| Bash heredocs on this machine | Unescape backslashes (`\\b` in a heredoc lands as a backspace byte). Write files with the Write/Edit tools; keep heredocs for short backslash-free scripts. |

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

**Reliability pass (2026-09-04):** both scouts run as durable rows executed in fenced legs
under one clock (ADR-043, ADR-044). `POST /api/scout` and `POST /api/career/scout` enqueue and
answer in seconds; `POST /api/scout/worker` executes a leg; `GET /api/scout/readiness` gates a
paid run; `npm run check:deploy` gates a build; `npm run test:scout-reliability` is the fault
matrix. Migration 021 adds the columns and the one-active-run index; until it is pasted, the
run store keeps those fields inside `params.__reliability` and readiness says so as a warning.
The People Scout page and the Jobs panel poll persisted state and never simulate progress.
From a terminal, as the founder: `scripts/scout-acceptance.ts` starts and watches a run through
the real routes, `npm run scout:watch -- --kind people|jobs --run <id>` watches one, and
`npm run scout:cancel -- --kind people|jobs --run <id>` asks one to stop.

**Phase 11 — Career OS** is built on top of the Phase 10 loop. The outreach loop is unchanged:

```
MISSION → STRATEGY → EXISTING NETWORK → [enough?] → discovery → RESEARCH → RANK
        → POSITION → DRAFT (in the campaign's voice) → APPROVE → SEND → TRACK → OUTCOME
```

and beside it, sharing the runtime, the traces, the research facts and the contact index:

```
JOB MISSION → PLAN → DISCOVER (company-first ATS + job-first scout) → NORMALIZE → EXTRACT
           → DEDUPE → VERIFY → FIT → RESEARCH → MATCH EVIDENCE → WARM PATHS
           → [Generate Package] → TAILOR → FACT-VERIFY → REVIEW DIFF → DOCX/PDF + QA
           → COVER LETTER → READY FOR REVIEW → READY TO APPLY → (you apply) → APPLIED → OUTCOME
```

Architecture note: [docs/CAREER_OS.md](docs/CAREER_OS.md). ADR-030–037 in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Twelve Career OS agents in
[docs/AGENTS.md](docs/AGENTS.md), each argued against the same test — three candidates were
rejected for failing it.

**Knowledge base consolidated (2026-08-28):** migration 015 applied; `npm run evidence:audit`
(read-only) and `npm run evidence:consolidate -- --dry-run | --apply` exist; the live bank was
consolidated once (3 HIGH merges, 0 deletes, snapshot first) and the Evidence page has Canonical
and Review tabs. Agents read the bank only through `getRelevantPersonalEvidence`
(ADR-038, [docs/KNOWLEDGE_BASE_DEDUP_PLAN.md](docs/KNOWLEDGE_BASE_DEDUP_PLAN.md)).

**Founder actions done (2026-08-28):** migration 014 applied, `npm run career:seed -- --approve`
run (Evidence Bank seeded, master résumé stored), one live scout and one live package verified
end to end. To refresh: `npm run career:scout` (deep run, 1200 s default) or **Scout now** on
`/dashboard/jobs`; `npm run career:verify` re-checks saved postings.

**Offline checks:** `npm run test:career` (10 suites, no keys). **Evals:** `npm run eval:career`
and the per-suite `eval:career-*` scripts — they cost money and cache by content.

**Not built yet:** autonomous submission (never), outreach auto-send from a warm path (never —
it hands off to the existing approval queue), an ML ranking model (deliberately — feedback is a
bounded modifier, ADR-036). Still outstanding from Phase 10: the `no_response` timer, send
pacing, and the `followup_due_at` scheduler.

See [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md).
