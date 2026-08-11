# Build Log

Concise summaries of meaningful implementation changes, newest first.
One entry per phase or per significant change. Not a commit log — a record of what changed
architecturally and why.

---

## 2026-08-10 — Phase 3: Provider abstraction + Apollo integration (eval-driven)

**Type:** implementation + eval harness · **Behavior change:** additive; V1 untouched

Full report: [PHASE_3_EVAL.md](PHASE_3_EVAL.md)

### What shipped

- `lib/providers/` — `CompanyProvider` / `PeopleProvider` / `WebResearchProvider`
  interfaces, an Apollo client (retry, rate limiting, call budget, credit
  accounting), and a content-addressed disk cache.
- `lib/scouting/` — deterministic discovery, dedupe, size-aware seniority
  calibration, junk filtering, and a relevance scorer where **the LLM emits
  components and code computes the total** (ADR-004 in practice).
- `lib/ai/models.ts` — the central model registry from ADR-008.
- `supabase/migrations/010_companies_scouting.sql` — companies as a first-class
  entity (ADR-001), provenance tables, `contacts` extensions (ADR-012).
- `evals/phase3/` — 5 search profiles, 4 deterministic checks, an independent
  LLM judge, Precision@20.
- `scripts/test-deterministic.ts` — 68 assertions over the deterministic core.

### Architecture finding: Apollo discovery must be people-first

Company-first discovery failed. Apollo's `q_organization_keyword_tags` matches
company **names** lexically, so searching "artificial intelligence + manufacturing"
returned AI magazines, certification bodies, conference organizers and
universities — and 9 queries yielded 1 usable candidate.

Applying the same keywords at the **people** search layer works, because the
title filter anchors each query to a real operating company. Recorded as
[ADR-013](ARCHITECTURE.md#adr-013).

### Entitlement finding: search rows are obfuscated

`mixed_people/api_search` returns `last_name_obfuscated`, boolean `has_email`
flags, no LinkedIn, no seniority. Search rows are identifiers only; full records
need `people/bulk_match`, which costs credits. Modeled as a distinct `PersonStub`
type so obfuscated rows can never be mistaken for prospect data.

Also: `mixed_people/search` is deprecated (422), and company descriptions are
absent from person records entirely — **0 of 140** — requiring a separate
`organizations/enrich` call.

### Eval results — 6 iterations, stopped by a real blocker

| Iteration | Change | Avg P@20 | Min P@20 |
|---|---|---|---|
| 1 | People-first inversion | 65%¹ | 65%¹ |
| 2 | + description hydration, scorer v4 | 75%¹ | 75%¹ |
| 3 | Full 5-profile baseline | 47% | 30% |
| 4 | + search rebalance, cross-profile dedupe | **44%** | **15%** |
| 5 | + priority-weighted budget, domain filter | 31%² | 0%² |
| 6 | + one person per company | aborted² | |

¹ single profile · ² invalidated by Apollo credit exhaustion

**Final status (iteration 4, the last valid full run):** all four deterministic
checks pass — data completeness 99%, duplicate rate **0.0%**, seniority
calibration 99%, resume grounding 100%. **Precision@20 does not pass**: 44%
average against a 75% threshold.

⛔ **Blocker: Apollo lead credits exhausted.** Search rows are obfuscated, so
every usable prospect costs one enrichment credit; ~700 per full run drained the
account. Iterations 5–6 are not valid measurements and iteration 6 was aborted
rather than allowed to report meaningless numbers. **Thresholds were not
weakened.**

Failure modes found and fixed: search (keyword name-matching), data (no company
descriptions — 0/140), scoring (compression from batching in discovery order),
profile match (adjacent-but-off-mission verticals), company (wrong end of each
size band), dedupe (cross-profile collisions, 6% → 0%), budget (enrichment spent
on the first queries only — and the over-correction that regressed profile 1
from 65% to 35%), product-rule violation (7% of top-20 slots on a second person
at the same company).

Diagnosis of the residual gap: 25% of non-GOOD verdicts cite thin company
information; the larger share is domain drift in Apollo's noisy consulting
keyword space. The first is what Phase 6 fixes.

### Bugs the tests caught

- `normalizeLinkedIn` stripped the trailing slash **before** the query string, so
  one profile produced two dedupe keys — a silent threat to the duplicate threshold.
- "Technical Recruiter" survived the irrelevant-function filter because the
  override term `technical` rescued it. Split into hard- and soft-excluded functions.
- A cache-key bug: `JSON.stringify(payload, sortedKeys)` uses the array argument
  as a recursive property **allowlist**, not a key sort, collapsing all nine
  search queries onto one cache entry.

### Security

`Apollo API.txt` — a committed credential-shaped string — untracked and
gitignored. **The key still needs rotating**, and history still contains it.

### Not done

Migration 010 is **not applied** (migrations are manual per CLAUDE.md).
`lib/scouting/persist.ts` degrades gracefully until it is.

---

## 2026-08-10 — Phase 0: Repository audit and V2 architecture

**Type:** documentation + type-only scaffolding · **Behavior change:** none

### What happened

Audited the V1 codebase and designed the V2 agentic architecture. No existing file was
modified; no runtime behavior changed. `tsc --noEmit` clean before and after.

### Audit findings that shaped the design

1. **No company entity.** `contacts.company` is free text. The V2 pipeline is company-first,
   so this was the single largest structural gap. → [ADR-001](ARCHITECTURE.md#adr-001)
2. **Research is ungrounded.** `lib/ai/research.ts` queries the model's parametric memory;
   ~40% of its system prompt is anti-hallucination instruction, with no source of truth to
   check against. No web-search capability existed anywhere in the codebase.
   → [ADR-006](ARCHITECTURE.md#adr-006)
3. **The installed OpenAI SDK is 4.104.0**, not the `^4.52.0` in `package.json`, and it
   exposes the Responses API with the `web_search` tool. This settled the web-research
   provider question with no new vendor.
4. **Long work runs inline in HTTP handlers** with `maxDuration = 300` and sequential model
   calls. This already shipped as a bug (`f6e4bb7`). → [ADR-005](ARCHITECTURE.md#adr-005)
5. **The résumé is dumped wholesale** into every generation prompt, sliced to 2000 chars,
   with selection left to the same call that writes the email. → Talent KB + retrieval
6. **Scoring is one opaque float** with no components and no configurable weights.
   → [ADR-004](ARCHITECTURE.md#adr-004)
7. **The email layer is excellent** — narrow OAuth scopes, encrypted tokens, correct MIME,
   working threading, idempotent reply sync with backfill. Preserved unchanged.
   → [ADR-007](ARCHITECTURE.md#adr-007)
8. **The Resend surface is dead** — the webhook is unreachable, and its signature verifier
   returns `false` unconditionally. `lib/email/resend.ts` actually sends via Gmail.
9. **`/dashboard/drafts` is already an approval queue** with edit, multi-select, and
   approve-all. V2 extends it rather than replacing it.
10. **⚠ `Apollo API.txt`** — a 22-byte credential-shaped string tracked in git. Flagged for
    founder action; not remediated automatically because history rewriting is destructive.

### Decisions recorded

Twelve ADRs in [ARCHITECTURE.md](ARCHITECTURE.md). The ones that materially change the
product:

- **ADR-001** — companies become first-class
- **ADR-002** — missions replace the hardcoded goal enum
- **ADR-004** — the model judges component scores; code computes the weighted sum
- **ADR-005** — durable Postgres task rows advanced by an idempotent worker tick, rather
  than a queue service or long HTTP handlers
- **ADR-006** — grounded research via a `WebResearchProvider`
- **ADR-010** — evals gate outbound mail but never silently discard a draft
- **ADR-011** — claim citation makes hallucination a foreign-key problem

### Where the spec was deliberately not followed

- **One `talent_items` table, not four** (`experiences` / `projects` / `skills` /
  `proof_points`). They share a lifecycle, tagging dimensions, and exactly one retrieval
  path. Four tables would mean four queries and a `UNION` for no gain.
  → [ADR-003](ARCHITECTURE.md#adr-003)
- **No `people` table.** `contacts` already is the person entity, with RLS, a unique index,
  and six screens on it. → [ADR-012](ARCHITECTURE.md#adr-012)
- **`meetings` and `referrals` are outcome types, not tables.** Separate tables would
  fragment the analytics they exist to serve.
- **`mission_preferences` is a column, not a table.** Always read with its mission; never
  queried independently.

### Delivered

```
docs/CURRENT_STATE.md          How V1 works today
docs/PRODUCT.md                V2 product definition and North Star
docs/ARCHITECTURE.md           Target architecture + 12 ADRs
docs/PIPELINE.md               13-stage state machine
docs/AGENTS.md                 7 agents: inputs, outputs, boundaries
docs/DATA_MODEL.md             10 new tables, 4 extended, 3 dropped
docs/EVALS.md                  Gate evals for outreach, research, ranking, positioning
docs/IMPLEMENTATION_PLAN.md    11 phases with dependencies and risks
docs/BUILD_LOG.md              This file
CLAUDE.md                      Conventions for future sessions
README.md                      Orientation

lib/providers/types.ts         Provider interfaces (types only)
lib/providers/registry.ts      Availability + feature flags
lib/agents/types.ts            Agent contracts (types only)
lib/pipeline/types.ts          Run and task state (types only)
lib/scoring/types.ts           Scoring contracts
lib/scoring/weights.ts         Default weights + per-mission resolution
lib/scoring/compute.ts         Pure weighted-sum arithmetic — first real V2 code
```

`lib/scoring/compute.ts` is implemented rather than stubbed because it is pure arithmetic
with no dependencies — the cheapest possible demonstration of the ADR-004 boundary.

### Next

Phase 1 — missions and preferences. Independent of Phases 2 and 3; any order works.
