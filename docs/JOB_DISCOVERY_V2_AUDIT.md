# Job Discovery V2 — audit of what exists, and why it is narrow

> Written before implementation, from the code on `main` and a measured live run
> on the founder's own database (2026-08-31). Every number here is observed, not
> estimated. Companion: [JOB_SOURCE_MATRIX.md](JOB_SOURCE_MATRIX.md).

## 0. The measurement that frames everything

A live inventory after a full watchlist sweep **and** a $4.02 scout run:

| | |
|---|---|
| Canonical postings | **284** |
| **Unique companies** | **34** |
| **Largest single company's share** | **GE Vernova — 107 postings (38 %)** |
| Extracted (structured fields read) | 37 |
| Fully ranked (fit evaluated) | 27 |
| Top states | CA 23 · NY 13 · CO 6 · TX 3 |
| Role families | 46 (mostly free-text, unnormalised) |

The founder's stated direction at the time was *"…typical Chemical Engineering
internships… **I don't care about location or which company**"*, while the
active mission still declared:

```
geo_tiers: [ { tier 1: "San Francisco / Bay Area", "New York City" },
             { tier 2: "Boston", "Seattle", "Los Angeles", "Washington DC",
               description: "other large, vibrant East or West Coast cities" } ]
```

That is the audit in one image: **the system's built-in assumptions outrank the
user's stated intent**, and 38 % of the inventory comes from one employer.

## 1. Current discovery architecture

```
runJobScout(params)                       lib/career/scout/orchestrator.ts
  ├── (a) mission + Evidence Bank load
  ├── (b) SWEEP           lib/career/jobs/sweep.ts        ← free, added 2026-08-31
  │        every watchlist company with a resolvable board → list → normalize → store
  ├── (c) PLAN            lib/agents/job-mission-planner  ← ONE model call
  │        role families + 4–8 search strategies + 15–40 seed companies
  ├── (d) COMPANY-FIRST   lib/career/scout/company-first.ts
  │        selectCompaniesToCheck() → detect ATS → list internships
  ├── (e) JOB-FIRST       lib/agents/job-scout (session)  ← per strategy, ≤2 rounds
  │        web queries → postings → resolve to canonical → fetch
  ├── (f) EXTRACT         lib/career/scout/extract.ts     ← one model call per posting
  ├── (g) CLUSTER/DEDUPE  lib/career/jobs/dedupe.ts
  ├── (h) VERIFY          lib/career/jobs/verify.ts
  ├── (i) PERSIST         lib/career/jobs/store.ts (incremental, per batch)
  └── (j) RANK            lib/career/intelligence (fit evaluator) — top 12 only
```

Durable-run machinery (enqueue → token-claimed worker → heartbeat → partial)
already exists (ADR-040) and is reused by V2.

## 2. Every job source implemented today

| Source | Kind | Notes |
|---|---|---|
| Greenhouse | first-party ATS JSON | `lib/career/sources/greenhouse.ts` |
| Lever | first-party ATS JSON | |
| Ashby | first-party ATS JSON | |
| SmartRecruiters | first-party ATS JSON | |
| Workable | first-party ATS JSON | |
| **Workday** | first-party ATS JSON (`cxs`) | added 2026-08-31; 18 of 91 boards in a live sweep |
| Careers-page scan | HTML heuristic | `sources/careers.ts` — yielded Intel 21, Abbott 39, Medtronic 47 |
| Web search | model-driven queries | via the job-scout agent session |

**Recognised but NOT listable** (registry knows the URL shape, no adapter):
iCIMS, Taleo, SuccessFactors. In a live sweep **102 of 188 companies produced no
readable board** — including Merck, J&J, DuPont, Corning, Conagra, Illumina.

**Not searched at all, directly or indirectly:** LinkedIn, Indeed, Glassdoor,
ZipRecruiter, Built In, Handshake, Google Jobs, and every internship aggregator.
There is no paid-provider integration of any kind.

## 3. Every cap in the discovery path

| Constant | Value | File |
|---|---|---|
| `maxStrategies` (web route / CLI) | 2 / 3 | `run-dispatch.ts`, orchestrator |
| `maxRoundsPerStrategy` | 2 | orchestrator |
| `targetCount` per strategy session | **12** | `stages.ts:183` |
| `maxCompaniesFirst` | 20 (web) / 25 | orchestrator |
| `MAX_SCOUT_COMPANY_CHECKS` | 10 | `stages.ts:39` |
| `maxExtract` | 30 (web) / 40 | orchestrator |
| **`MAX_RANK_JOBS`** | **12** | `orchestrator.ts:91` |
| `maxWebSearches` | 5–6 | `runs.ts` |
| `LOOKUP_POSTING_LIMIT` | 40 | `tools.ts` |
| `INTERNSHIP_LOOKUP_LIMIT` | 120 | `tools.ts` |
| `SWEEP_LIST_LIMIT` / companies | 300 / 1000 | `sweep.ts` |
| Worker deadline | 280 s Vercel / 1200 s local | `run-dispatch.ts` |

**The binding constraints are `targetCount: 12` per strategy and
`MAX_RANK_JOBS: 12`.** A scout session stops at twelve postings per strategy
however much supply exists, and only twelve jobs per run ever receive a fit
score. That is why a $4 run returns "a small number of jobs".

## 4. Where geography enters discovery

1. **`DEFAULT_MISSION_PREFERENCES.geo_tiers`** (`lib/career/missions/store.ts`)
   — SF/NYC tier 1, four coastal cities tier 2, hard-coded at seed time. This is
   the origin of the bias and it is **system-generated**, not user-authored.
2. **`renderMission()`** prints the tiers into the planner and fit prompts, so
   the model is told coastal cities are the goal.
3. **`fallbackStrategies()`** appends `geo[0]` (i.e. "San Francisco / Bay Area")
   to deterministic queries.
4. **`location_tier`** is computed at normalize time (`jobs/location.ts`) and is
   a **ranking input** (`rankCandidatePriority`, fit weights) — legitimate as a
   soft signal, but today it is fed by a biased tier table.
5. Hard constraints (`hard_constraints`) legitimately filter on country (US).

Geography is therefore both a filter-ish discovery input *and* a ranking signal,
with no distinction between **preference**, **direction** and **hard filter**.

## 5. Where company lists enter discovery

- `seedWatchlistFromPlan()` writes 15–40 planner-invented companies per run
  (now as `suggested`, after ADR-039).
- `selectCompaniesToCheck()` gives every Target and Watching company a slot,
  then a rotating Explore sample.
- The sweep reads *every* company with a board.
- The job-scout session's `companiesToCheck` adds up to `MAX_SCOUT_COMPANY_CHECKS`.

Net effect: the company list **is** the discovery universe. Broad market search
is a minority lane — measured below.

## 6. Why the same companies repeat

1. A company with a big board dominates: **GE Vernova contributed 107 of 284
   postings** because the sweep lists a whole board and stores everything on it.
2. The planner is shown the existing watchlist and re-proposes neighbours of it.
3. Job-first strategies stop at `targetCount: 12`, so a single productive board
   fills the quota before other surfaces are tried.
4. There is no diversity measurement anywhere, so nothing notices.

## 7. Direct ATS integrations

**Six** (Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Workday) plus a
generic careers-page scanner. Against a watchlist of 188 companies that resolved
**86 readable boards**, i.e. ~46 % coverage of the *watchlist*, and a far smaller
share of the market.

## 8. Major job markets not searched

LinkedIn · Indeed · Glassdoor · ZipRecruiter · Built In · Handshake · Google
Jobs · Simplify/Pitt-CSC Summer 2027 list · university boards · industry boards
(AIChE, ACS, SWE) · every commercial job-data API. **Zero paid providers.**

## 9. What a normal UI scout can realistically reach today

Per run: ≤2 strategies × ≤2 rounds × ≤12 postings ≈ **≤48 web-discovered
postings**, of which ≤30 are extracted and **≤12 ranked**, plus whatever the
company sweep lists. Measured live: a full scout produced **25 new postings** and
ranked 12, for $4.02 and 17 minutes.

## 10. Proposed V2 architecture

```
                    EVIDENCE BANK ──► SEARCH ONTOLOGY (inspectable, editable)
                                        role families · title variants
                                        industries · adjacents · skills
                                                │
DIRECTION (off | boost | exclusive) ────────────┤
                                                ▼
                      ┌──────────── QUERY PLANNER (deterministic, coverage-oriented)
                      │
   ┌──────────────────┴───────────────────────────────────────────┐
   │  SOURCE REGISTRY — JobDiscoverySource[]                      │
   │  pull feeds: Simplify · ATS boards (7+) · public feeds        │
   │  search sources: SERP/Google-Jobs · job APIs · web search     │
   │  company-first: Targets + Watching only  (SECONDARY lane)     │
   └──────────────────┬───────────────────────────────────────────┘
                      ▼
     RAW POSTINGS ──► NORMALIZE ──► DEDUPE (cross-source, provenance kept)
                      ▼
     STAGE A  cheap reject   (full-time / new-grad / wrong season / closed / non-US)
     STAGE B  cheap relevance score (ontology + lexical + optional embedding)
     STAGE C  full Fit Evaluator — only above threshold, or on demand
                      ▼
     JOBS INBOX (DB-side pagination, sorted by fit → relevance → freshness)
```

Every stage is a **resumable task** against the existing durable run row, so a
run may span many worker invocations and take an hour without a live browser
request. Stopping is **saturation-based** (marginal unique yield below a
threshold, budget hit, or source exhausted) rather than a fixed count.

## 11. Paid provider candidates

Researched separately and recorded in
[JOB_SOURCE_MATRIX.md](JOB_SOURCE_MATRIX.md) with current 2026 pricing, terms,
pagination and coverage. Selection principle: **a portfolio of independent
sources**, each behind an env var and optional, so the app runs with none of them
and improves with each one added. No provider is adopted whose terms forbid
programmatic access or storage.

## 12. Migration risks

- **The default mission's geography is system-generated** and must be migrated to
  a neutral US-wide default — but a mission the founder edited by hand must not
  be overwritten. `watch_status_at`-style provenance does not exist for missions,
  so migration keys on the preferences being byte-identical to the shipped
  default; anything else is left alone and surfaced as a suggestion.
- Existing jobs, applications, packages, evidence, companies and feedback must
  survive: all V2 schema work is additive.
- Raising recall raises inventory into the hundreds/thousands, so the inbox must
  paginate in the database before the ingestion is switched on.
- A paid provider with no credential must degrade to "configured: false" and
  never fail a run.
