# Implementation Plan — V1 → V2

> Phased migration. Each phase leaves the repository in a working, shippable state.
> Companion docs: [ARCHITECTURE.md](ARCHITECTURE.md) · [DATA_MODEL.md](DATA_MODEL.md) · [BUILD_LOG.md](BUILD_LOG.md)

---

## Disposition of existing code

Decided during the Phase 0 audit. This is the answer to "what gets reused, refactored,
replaced, and newly built."

### Reuse as-is — do not touch

| Code | Why |
|---|---|
| `lib/email/*` (send, sync, gmail, format, accounts, conversation) | The hardest-won code in the repo: narrow OAuth scopes, encrypted tokens, correct MIME, working threading, idempotent sync with backfill. [ADR-007](ARCHITECTURE.md#adr-007) |
| `lib/google/oauth.ts` | Correct OAuth lifecycle |
| `lib/crypto.ts` | AES-256-GCM at rest |
| `lib/supabase/server.ts` | SSR + service-role clients |
| `middleware.ts` | Auth gate (keep the uncommitted improvement) |
| All RLS policies | The multi-tenant story is already right |
| `components/editor/RichTextEditor.tsx` | Preview shares the send renderer. Genuinely good. |
| `lib/ai/suggest-reply.ts` | Reply drafting ≠ cold outreach. Works. |
| `lib/ai/fill-template.ts` | Manual template path stays valid alongside missions |

### Refactor — keep behavior, change shape

| Code | Change | Phase |
|---|---|---|
| `lib/email/resend.ts` | Rename → `send.ts`. Zero behavior change. | 9 |
| `emails.resend_message_id` | Rename → `rfc822_message_id` (add → backfill → switch → drop) | 9 |
| Model IDs (10 sites) | Central `lib/ai/models.ts` registry | 1 |
| `lib/ai/classify.ts` | Extend to the richer outcome vocabulary | 10 |
| `/dashboard/drafts` | Extend into the V2 approval queue — reasoning, citations, evals | 9 |
| `lib/supabase/queries.ts` | Split by domain as it grows past ~400 lines | ongoing |
| `lib/ai/campaign-feedback.ts` | Ground in `outcome_events` instead of one-shot critique | 11 |

### Replace — V2 supersedes

| Code | Replaced by | Phase |
|---|---|---|
| `lib/ai/research.ts` | Research Agent with web grounding | 6 |
| `lib/ai/personalize.ts` | Positioning Agent + Outreach Agent | 7–8 |
| `contact_research.relevance_score` | `scores` with components | 5 |
| `profiles.resume_text` et al. as prompt input | `talent_items` + retrieval | 2 |
| `GenerateRequest.outreach_goal` enum | `missions` | 1 |

### Delete

| Code | Phase |
|---|---|
| `app/api/webhooks/resend/route.ts` | 10 |
| `verifyWebhookSignature()` (returns `false` unconditionally) | 10 |
| `email_events`, `template_performance`, `followups` tables | 10 |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` env leftovers | 1 |
| `Apollo API.txt` | **Immediately** — see below |

### Build new

`lib/pipeline/` · `lib/agents/` · `lib/providers/` · `lib/scoring/` · `lib/evals/` ·
`lib/talent/` · migrations 008–015 · Missions UI · Talent KB UI · Prospects UI ·
run-inspection UI

---

## Phase dependencies

```
Phase 0  Audit + docs + scaffolding  ✅
   │
   ├──────────────┬──────────────┐
   ▼              ▼              ▼
Phase 1        Phase 2        Phase 3
Missions      Talent KB      Providers
   │              │              │
   └──────┬───────┴──────────────┘
          ▼
      Phase 4  Company discovery + ranking   (needs 1, 3; pipeline runner lands here)
          │
          ▼
      Phase 5  People discovery + ranking    (needs 4)
          │
          ▼
      Phase 6  Research dossiers             (needs 5 + WebResearchProvider)
          │
          ▼
      Phase 7  Positioning                   (needs 2, 6)
          │
          ▼
      Phase 8  Outreach + evals              (needs 7)
          │
          ▼
      Phase 9  Approval queue + send         (needs 8; reuses V1 email)
          │
          ▼
      Phase 10 Outcome tracking              (needs 9; reuses V1 sync)
          │
          ▼
      Phase 11 Analytics                     (needs 10)
```

**Phases 1, 2, and 3 are independent and can be done in any order.** Everything after Phase 4
is strictly sequential — each stage consumes the previous stage's output.

**Phase 6 is the linchpin.** Ranking, positioning, and writing are all functions of research
quality. If research is weak, the rest is a more elaborate version of what V1 already does.
Budget accordingly and do not compress it.

---

## Phase 0 — Audit and architecture ✅ complete

**Delivered:** the eight documents in `/docs`, `CLAUDE.md`, `README.md`, and type-only
scaffolding under `lib/providers/`, `lib/agents/`, `lib/pipeline/`, `lib/scoring/`.

**Constraint honored:** scaffolding is interfaces and types only. No behavior changed, no
existing file modified, `tsc --noEmit` still clean.

---

## Phase 1 — Missions and preferences

**Goal:** replace the hardcoded goal enum with a real Mission system.

1. Migration `008_missions.sql` — `missions`, `mission_strategies`
2. Zod schemas for `hard_constraints` / `soft_preferences`
3. `lib/ai/models.ts` — central registry; migrate all 10 hardcoded `gpt-5.4` sites
4. Mission CRUD UI: objective, constraint builder (hard vs soft), weight editor, caps
5. Seed the "Winter Internship / Project" mission
6. Port V1's five `outreach_goal` values into mission templates — **carry the `ask_guidance`
   copy over; it is good and would otherwise be lost**
7. Remove `GMAIL_USER` / `GMAIL_APP_PASSWORD`; correct `.env.local.example`

**Done when:** a mission can be created, edited, and read back with hard/soft constraints
distinguished; no `gpt-5.4` literal remains outside `models.ts`; V1 flows still work.

**Risk:** the constraint builder is the first place the product feels different. Ship a plain
form before anything clever — a dimension/operator/value row list is enough.

---

## Phase 2 — Talent Knowledge Base

**Goal:** structured, retrievable user knowledge replacing six free-text blobs.

1. Migration `009_talent_kb.sql`
2. **Importer**: parse existing `resume_text` / `linkedin_bio_text` / `personal_context` into
   candidate `talent_items` via an LLM, presented for user confirmation — never auto-committed
3. Talent KB UI: list by kind, add/edit, tag editor
4. `lib/talent/retrieve.ts` — deterministic tag-overlap retrieval returning a ranked shortlist
5. Unit tests for retrieval ranking

**Done when:** ≥ 20 talent items exist and `retrieve.ts` returns a sensible 10–15 item
shortlist for a given industry/problem-type/stage query.

**Note:** `profiles` free-text fields stay. They are the ingest source and still feed V1's
screens.

**Risk:** the import step is where the user's patience is spent. Make review fast — bulk
accept, inline edit, skip — or the KB stays empty and Phase 7 has nothing to select from.

---

## Phase 3 — Provider abstraction and Apollo

**Goal:** provider interfaces with a real Apollo implementation behind them.

1. Implement `lib/providers/types.ts` + `registry.ts` (scaffolded in Phase 0)
2. Apollo client: auth, rate limiting, retry with backoff, pagination
3. `apollo/organizations.ts` — `organizations/search` (**new capability**)
4. `apollo/people.ts` — `people/search` (**new**) + migrate V1's `people/match` enrichment
5. `providers/web/openai-search.ts` — `WebResearchProvider` via the Responses API
   `web_search` tool
6. PitchBook: interface + stub + `PITCHBOOK_ENABLED` flag. **No implementation** until
   entitlement is confirmed.
7. Provider integration tests behind an env flag (they cost credits)

**Done when:** an org search and a people search return normalized, deduped results with
provenance; the app runs correctly with PitchBook disabled.

**Risk:** Apollo credit consumption. Add a per-run provider call budget from day one, not
after the first surprise bill.

---

## Phase 4 — Company discovery and ranking

**Goal:** first working slice of the pipeline. **The pipeline runner lands here.**

1. Migrations `010_companies.sql`, `011_pipeline.sql`
2. `lib/pipeline/` — runs, tasks, `FOR UPDATE SKIP LOCKED` claiming, leases, retry
3. `POST /api/pipeline/tick` + Vercel Cron (1 min)
4. Mission Strategist agent (stage 1)
5. Deterministic company discovery (stage 2): execute queries, paginate, dedupe,
   apply hard constraints, record `filtered_reason`
6. Company Scout agent (interpretation)
7. `lib/scoring/compute.ts` + Fit & Ranking agent (stage 3)
8. Run-progress UI + company list with score breakdowns

**Done when:** a mission produces a ranked company list end-to-end, a killed worker resumes
cleanly, and every score shows its components with explanations.

**Risk — the big one.** This phase carries the most new machinery. **Build the pipeline runner
first and test it with a trivial no-op stage before wiring real agents into it.** Debugging
task leasing and agent prompts simultaneously is how this phase goes wrong.

---

## Phase 5 — People discovery and ranking

1. Deterministic people discovery per top company (stage 4)
2. Dedupe against existing contacts; never re-surface prior contacts
3. People Scout agent (interpretation)
4. Fit & Ranking for people (stage 5)
5. Enforce one-person-per-company and `max_active_outreach` **in code**
6. Prospect list UI with score breakdowns and "why this person"

**Done when:** ranked prospects appear with defensible reasoning, and a Director who owns the
relevant initiative can outrank a CEO who does not.

**Risk:** email availability. Apollo does not always have one. Record `email_status` and let
prospects without a reachable address surface as LinkedIn-only rather than silently vanishing.

---

## Phase 6 — Research dossiers ⭐ the linchpin

1. Migration `012_research_scoring.sql` — including the `fact_requires_source` constraint
2. Research Agent with `WebResearchProvider` tool use
3. Fact typing (FACT / INFERENCE / UNKNOWN) with source persistence
4. Research evals ([EVALS.md §4](EVALS.md#4-research-evals))
5. Enforce the "≥ 2 sourced facts" gate
6. Dossier UI with sources visible per claim

**Done when:** dossiers contain sourced, mission-relevant facts; the DB rejects any `FACT`
without a source; thinly-documented people honestly produce `UNKNOWN` items.

**Risk:** cost and latency. Multiple web searches per person. Cap searches per dossier and
measure real cost on 10 people before running 20.

**Do not shortcut this phase.** Everything downstream is a function of it.

---

## Phase 7 — Positioning engine

1. Migration `013_positioning_outreach.sql`
2. Talent retrieval → shortlist (summaries only, never full detail)
3. Positioning Agent
4. Positioning evals
5. Positioning UI: thesis, selected proof points and why, what-not-to-mention

**Done when:** for a given prospect the system names 1–3 specific user proof points and
articulates a non-generic intersection.

**Risk:** vague intersections. This is the failure that surfaces later as specificity eval
failures at stage 9 and gets misdiagnosed as a writing problem. Test the thesis quality
directly, here, before building the writer.

---

## Phase 8 — Outreach generation and evals

1. Outreach Agent with the citation map
2. `lib/evals/` — deterministic checks + judge + the eight rubrics
3. Revision loop (max 2), flagged-but-queued on exhaustion
4. Persist every revision's evaluations

**Done when:** drafts pass evals with resolvable citations, and a deliberately fabricated
claim is caught by the deterministic check before any judge runs.

**Risk:** an over-strict gate that fails everything, or an over-lenient one that passes
mediocrity. Calibrate against ~20 hand-judged drafts before trusting the thresholds.

---

## Phase 9 — Approval queue and sending

1. Extend `/dashboard/drafts`: reasoning panel, citations with sources, eval results,
   flagged state
2. Approve / edit / reject with reason; capture `original_body` on edit
3. Approval → create `emails` row → **V1 send path, unchanged**
4. Rate limiting, pacing, per-mission cap enforcement
5. `resend.ts` → `send.ts` rename; `resend_message_id` → `rfc822_message_id`
6. Per-campaign `autonomy_level` — **plumbed but off**

**Done when:** approving a draft sends via the existing Gmail path with no regression, and
autonomous sending is impossible without explicitly setting the flag.

---

## Phase 10 — Outcome tracking

1. Migration `014_outcomes.sql`
2. Extend `classify.ts` to the nine outcome types
3. Map synced replies → `outcomes`
4. `no_response` timer job (21-day default) — **without this, analytics learn only from
   responders**
5. Migration `015_cleanup.sql` + delete the Resend route
6. Outcome UI on conversations

**Done when:** every sent message eventually resolves to an outcome, including silence.

---

## Phase 11 — Analytics and learning

1. `outcome_events` dimension snapshotting
2. Analytics UI — **every figure displays its `n`**
3. Patterns below a sample threshold render as "insufficient data," not as findings
4. Rebuild campaign feedback on real outcome data

**Explicitly out of scope:** weight auto-tuning, ML models, automated prompt optimization.
See [PRODUCT.md §10](PRODUCT.md#10-outcomes-and-learning). At tens of sends there is no signal;
a model fit to that noise would be confidently wrong and would erode trust in everything else.

---

## Phase 10 as built — internal network + campaign references ✅ complete

The plan's Phase 10 was "outcome tracking". Phase 9 absorbed most of that
(`outreach.outcome`, `outreach_events`, reply linking), and the slot was spent
instead on the two problems that had become the binding constraints in practice:

**1. ~900 researched contacts were unusable.** Every run started by paying to
discover strangers while people already found, already researched, and in 250
cases already emailed sat unreachable, because nothing indexed them. Fixed by
`contact_index`, a retrieval agent that searches it, and a deterministic
decision about whether external discovery needs to run at all
([ADR-025](ARCHITECTURE.md#adr-025)–[ADR-027](ARCHITECTURE.md#adr-027)).

**2. The emails did not sound like the founder.** The house voice was a stack of
adjectives, and it reliably produced drafts that were arrogant and
over-compressed. Fixed by letting a campaign carry one real email whose voice
overrides the house style ([ADR-028](ARCHITECTURE.md#adr-028)).

Full write-up: [PHASE_NETWORK_AND_REFERENCE.md](PHASE_NETWORK_AND_REFERENCE.md).

**Still outstanding from the original Phase 10 scope:** the `no_response` timer,
send pacing, `max_active_outreach`, and one-person-per-company at the send gate.

---

## Phase 11 — Career OS ✅ built (founder action pending)

The product became a Career OS: Summer 2027 internship discovery, verification, fit, company
research, evidence matching, warm paths, conservative résumé tailoring with an independent fact
verifier, DOCX/PDF generation from the master template, cover letters, an application tracker
with immutable submitted documents, feedback that adjusts ranking through a bounded modifier,
and six eval suites.

Built as three waves of parallel workstreams, each independently reviewed:

| Wave | Workstreams |
|---|---|
| A | evidence bank + importer · ATS adapters + job core · document engine · discovery agents · intelligence agents · tailoring agents · eval fixtures/judges |
| B1 | scout orchestration + jobs/companies/cron API · intelligence + package orchestration + API |
| B2 | Jobs/Companies/Mission/Runs UI · discovery + fit evals · factuality + minimal-edit + cover-letter evals and hardening |

What it deliberately does not do: submit applications, send outreach from a warm path, or learn
weights from outcomes. Full note: [CAREER_OS.md](CAREER_OS.md); measurements in
[EVALS.md](EVALS.md) and [BUILD_LOG.md](BUILD_LOG.md).

**Founder action:** apply `014_career_os.sql`, then `npm run career:seed -- --approve`.

---

## Checkpoints

Each phase ends with: `tsc --noEmit` clean · V1 functionality verified working ·
docs updated · `BUILD_LOG.md` entry · a commit.

**Never leave the repo broken between phases.** The founder must be able to use V1 throughout
the migration.

---

## Testing

There is **no test infrastructure today**. Introduce it in Phase 1 — Vitest, since it needs no
build config for this stack.

Priority order, highest value first:

1. **`lib/scoring/compute.ts`** — pure functions, high blast radius, trivial to test
2. **`lib/evals/deterministic.ts`** — pure, and it is the anti-hallucination gate
3. **`lib/talent/retrieve.ts`** — ranking correctness
4. **Pipeline task claiming** — leases, retries, concurrent-tick safety
5. **Provider normalization** — with recorded fixtures, not live calls

Agent prompts are covered by evals, not unit tests. Testing an LLM's exact output is
brittle and measures the wrong thing.

---

## Immediate action, outside the phases

**`Apollo API.txt`** — a 22-byte credential-shaped string tracked in git.

1. Rotate the key in Apollo, whether or not it is still live
2. `git rm --cached "Apollo API.txt"`, add to `.gitignore`
3. If this repo has ever been pushed anywhere, rewrite history (`git filter-repo`) and
   force-push. If it has only ever been local, rotation is sufficient.

**Not done automatically** — history rewriting is destructive and is the founder's call.
Details in [CURRENT_STATE.md §9](CURRENT_STATE.md#9-configuration).

---

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Research quality is weak | Whole system degrades to V1-with-extra-steps | Phase 6 is the linchpin; gate on ≥ 2 sourced facts; do not compress it |
| Apollo credits burn fast | Runs fail mid-pipeline | Per-run provider budget from Phase 3 |
| Pipeline runner bugs | Stuck or duplicated runs | Build and test it with a no-op stage before real agents (Phase 4) |
| Evals mis-calibrated | Everything fails, or mediocrity passes | Calibrate on ~20 hand-judged drafts |
| Talent KB stays empty | Positioning has nothing to select | Make Phase 2 import fast and low-friction |
| Volume creep | Violates the North Star | `max_active_outreach` enforced in code, not in UI copy |
| Scope creep across phases | Nothing ships | One phase at a time; working state at every checkpoint |

The two that actually kill this project are **weak research** and **volume creep**. The first
makes the output indefensible; the second makes it indistinguishable from the mass outreach
this product exists to replace.
